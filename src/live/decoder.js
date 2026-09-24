import { TRACK, FLAG, trackName } from './protocol.js';

/**
 * WebCodecs decode for a live stereo pair.
 *
 * Two hardware decoders run independently, one per eye, and the pipeline's job
 * is to hand the renderer *matched* pairs. That matters more than it sounds:
 * showing the left eye from one instant next to the right eye from another is
 * not a cosmetic glitch, it is a vertical/temporal disparity that the visual
 * system reads as depth that is not there, and it is genuinely unpleasant to
 * look at in a headset. Freezing is better than mismatching, so that is the
 * default, with a bounded fallback for a track that has stalled outright.
 *
 * `VideoFrame` is a handle on GPU or shared memory and is *not* garbage
 * collected on any useful timescale. Every frame produced here is closed
 * exactly once - on presentation, on eviction, or on teardown. Leaking them
 * stalls the decoder within a second or two, because WebCodecs refuses to
 * produce output while too many frames are outstanding.
 */

/**
 * Decoded frames held per eye before the oldest is dropped. Deep enough to
 * absorb the two decoders finishing out of step, shallow enough that catching
 * up never means showing a second-old frame.
 */
const MAX_QUEUE_DEPTH = 6;

/**
 * How far one eye may lag before we stop waiting for its partner and present
 * whatever each eye has. Roughly eight frames at 30 fps.
 */
const PAIRING_TIMEOUT_US = 250_000;

/** Timestamps are matched with a tolerance, in case a clock is ever rounded. */
const PAIRING_TOLERANCE_US = 1500;

/**
 * One decoder, one track.
 */
class TrackDecoder {
    /**
     * @param {number} track - {@link TRACK}
     * @param {(err: Error) => void} onError
     */
    constructor(track, onError) {
        this.track = track;
        this.name = trackName(track);
        this.onError = onError;

        /** @type {VideoDecoder|null} */
        this.decoder = null;
        this.config = null;

        /** @type {VideoFrame[]} Oldest first. */
        this.queue = [];

        this.decoded = 0;
        this.dropped = 0;
        this.errors = 0;

        /** Gate: nothing is fed to the decoder before its first keyframe. */
        this._sawKeyframe = false;
    }

    get configured() {
        return this.decoder?.state === 'configured';
    }

    /**
     * (Re)configure for a codec.
     *
     * @param {{codec: string, codedWidth: number, codedHeight: number}} config
     */
    async configure(config) {
        this.close();

        const decoderConfig = {
            codec: config.codec,
            codedWidth: config.codedWidth,
            codedHeight: config.codedHeight,
            // Tells the implementation to prefer a shallow reorder buffer. The
            // encoder already emits no B-frames, so there is nothing to gain
            // from the throughput-oriented path and a frame or two to lose.
            optimizeForLatency: true,
            hardwareAcceleration: 'prefer-hardware'
        };

        // Annex B is signalled by the *absence* of `description`. The phone
        // prepends parameter sets to every keyframe for exactly this reason,
        // so a viewer joining mid-broadcast is self-sufficient.
        const support = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => ({ supported: false }));

        if (!support.supported) {
            this.onError(
                new Error(
                    `this browser cannot decode ${config.codec} (${this.name} eye). ` +
                        `Try H.264 in the capture app - Safari and Chrome both decode it in hardware.`
                )
            );
            return;
        }

        this.decoder = new VideoDecoder({
            output: (frame) => this._onFrame(frame),
            error: (err) => {
                this.errors += 1;
                this.onError(new Error(`${this.name} decoder: ${err.message}`));
            }
        });

        this.decoder.configure(decoderConfig);
        this.config = config;
        this._sawKeyframe = false;
    }

    /**
     * Feed one encoded access unit.
     *
     * @param {{payload: Uint8Array, timestamp: number, flags: number}} frame
     */
    decode(frame) {
        if (!this.configured) return;

        const key = (frame.flags & FLAG.KEYFRAME) !== 0;

        // A delta frame before the first keyframe references pictures we never
        // received. The relay gates on this too; this is the belt to its braces.
        if (!this._sawKeyframe) {
            if (!key) return;
            this._sawKeyframe = true;
        }

        try {
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: key ? 'key' : 'delta',
                    timestamp: frame.timestamp,
                    data: frame.payload
                })
            );
        } catch (err) {
            // A decode throw means the decoder has already errored out; wait
            // for the next keyframe rather than hammering it.
            this.errors += 1;
            this._sawKeyframe = false;
        }
    }

    /** @param {VideoFrame} frame */
    _onFrame(frame) {
        this.decoded += 1;
        this.queue.push(frame);

        while (this.queue.length > MAX_QUEUE_DEPTH) {
            this.queue.shift().close();
            this.dropped += 1;
        }
    }

    /** Oldest queued timestamp, or null. */
    get headTimestamp() {
        return this.queue.length ? this.queue[0].timestamp : null;
    }

    /** Newest queued timestamp, or null. */
    get tailTimestamp() {
        return this.queue.length ? this.queue[this.queue.length - 1].timestamp : null;
    }

    /**
     * Remove and return the queued frame at a timestamp, closing everything
     * older. Ownership passes to the caller.
     *
     * @param {number} timestamp
     * @returns {VideoFrame|null}
     */
    take(timestamp) {
        const index = this.queue.findIndex((f) => Math.abs(f.timestamp - timestamp) <= PAIRING_TOLERANCE_US);
        if (index === -1) return null;

        for (let i = 0; i < index; i += 1) {
            this.queue[i].close();
            this.dropped += 1;
        }

        const [frame] = this.queue.splice(0, index + 1).slice(-1);
        return frame;
    }

    /** Remove and return the newest frame, closing the rest. */
    takeLatest() {
        if (!this.queue.length) return null;

        const frame = this.queue.pop();
        while (this.queue.length) {
            this.queue.shift().close();
            this.dropped += 1;
        }
        return frame;
    }

    close() {
        for (const frame of this.queue) frame.close();
        this.queue.length = 0;

        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                /* already torn down */
            }
        }
        this.decoder = null;
    }

    stats() {
        return {
            decoded: this.decoded,
            dropped: this.dropped,
            errors: this.errors,
            queued: this.queue.length,
            codec: this.config?.codec ?? null,
            width: this.config?.codedWidth ?? 0,
            height: this.config?.codedHeight ?? 0
        };
    }
}

/**
 * Both eyes, paired.
 */
export class StereoPipeline {
    /**
     * @param {(err: Error) => void} onError
     */
    constructor(onError = () => {}) {
        this.onError = onError;

        this.tracks = new Map([
            [TRACK.LEFT, new TrackDecoder(TRACK.LEFT, onError)],
            [TRACK.RIGHT, new TrackDecoder(TRACK.RIGHT, onError)],
            [TRACK.PACKED, new TrackDecoder(TRACK.PACKED, onError)]
        ]);

        /** Set once a PACKED config arrives; the pair comes from one frame. */
        this.packed = false;

        this.pairsPresented = 0;
        this.unpairedPresented = 0;
    }

    /** @returns {boolean} True when at least one track is decoding. */
    get active() {
        return [...this.tracks.values()].some((t) => t.configured);
    }

    /**
     * @param {number} track
     * @param {object} config
     */
    async configure(track, config) {
        const decoder = this.tracks.get(track);
        if (!decoder) return;

        if (track === TRACK.PACKED) this.packed = true;

        await decoder.configure(config);
    }

    /** @param {{track: number}} frame */
    decode(frame) {
        this.tracks.get(frame.track)?.decode(frame);
    }

    /**
     * Take the newest presentable pair, if there is one.
     *
     * Ownership of the returned frames passes to the caller, which must close
     * them once they are uploaded to the GPU.
     *
     * @returns {{left: VideoFrame|null, right: VideoFrame|null, packed: VideoFrame|null, matched: boolean}|null}
     */
    takePair() {
        if (this.packed) {
            const frame = this.tracks.get(TRACK.PACKED).takeLatest();
            if (!frame) return null;

            this.pairsPresented += 1;
            return { left: null, right: null, packed: frame, matched: true };
        }

        const left = this.tracks.get(TRACK.LEFT);
        const right = this.tracks.get(TRACK.RIGHT);

        // Only one eye is configured at all - a mono broadcast, or a device
        // without multi-camera support. Present it as both eyes.
        if (left.configured !== right.configured) {
            const only = left.configured ? left : right;
            const frame = only.takeLatest();
            if (!frame) return null;

            this.pairsPresented += 1;
            return { left: frame, right: null, packed: null, matched: true };
        }

        // The newest timestamp both eyes hold. Walking the left queue newest
        // first means a viewer that has fallen behind catches up rather than
        // playing out a backlog in slow motion.
        for (let i = left.queue.length - 1; i >= 0; i -= 1) {
            const timestamp = left.queue[i].timestamp;
            const hasPartner = right.queue.some((f) => Math.abs(f.timestamp - timestamp) <= PAIRING_TOLERANCE_US);
            if (!hasPartner) continue;

            const leftFrame = left.take(timestamp);
            const rightFrame = right.take(timestamp);

            if (leftFrame && rightFrame) {
                this.pairsPresented += 1;
                return { left: leftFrame, right: rightFrame, packed: null, matched: true };
            }

            leftFrame?.close();
            rightFrame?.close();
            break;
        }

        // No match. If one eye has stalled far enough that waiting means
        // freezing, show the most recent of each and flag it so the UI can say
        // the pair is not trustworthy.
        const leftTail = left.tailTimestamp;
        const rightTail = right.tailTimestamp;

        if (leftTail !== null && rightTail !== null && Math.abs(leftTail - rightTail) > PAIRING_TIMEOUT_US) {
            this.unpairedPresented += 1;
            return { left: left.takeLatest(), right: right.takeLatest(), packed: null, matched: false };
        }

        return null;
    }

    stats() {
        return {
            left: this.tracks.get(TRACK.LEFT).stats(),
            right: this.tracks.get(TRACK.RIGHT).stats(),
            packed: this.tracks.get(TRACK.PACKED).stats(),
            pairsPresented: this.pairsPresented,
            unpairedPresented: this.unpairedPresented
        };
    }

    close() {
        for (const decoder of this.tracks.values()) decoder.close();
    }
}

/** True when this browser can decode at all. */
export function webCodecsAvailable() {
    return webCodecsSupport().ok;
}

/**
 * Why decoding is or is not possible here.
 *
 * WebCodecs is gated on a *secure context*, not just on browser version, so
 * `window.VideoDecoder` is simply undefined over plain http:// on anything but
 * localhost. That is the common failure - the startup banner prints a LAN
 * address, and opening it from a headset or a second laptop lands on
 * `http://192.168.x.x:8080/live`, where no browser exposes the API. Reporting
 * that as "your browser is too old" sends people off to install Chrome, which
 * does not help. The two cases are distinguished here so the message can name
 * the real one.
 */
export function webCodecsSupport() {
    if (typeof window === 'undefined') return { ok: false, reason: 'no-window' };

    const hasApi = 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
    if (hasApi) return { ok: true, reason: 'ok' };

    // isSecureContext is itself ancient and universally supported, so a false
    // here is trustworthy rather than another feature gap.
    if (window.isSecureContext === false) return { ok: false, reason: 'insecure-context' };

    return { ok: false, reason: 'unsupported-browser' };
}
