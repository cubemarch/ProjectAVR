/**
 * WebCodecs decode and playback for the broadcast's sound track.
 *
 * Deliberately not synchronised to the picture. The obvious thing to build is
 * an A/V sync loop that presents each frame against the audio clock — but the
 * video path here is a *monitor*: it always shows the newest matched pair it
 * has, it never queues deeply, and it is already within a frame or two of the
 * camera. Holding pictures back to match the sound would add latency to the one
 * thing the operator is actually judging. Both tracks are stamped from the same
 * capture clock and both are played as soon as they arrive, which keeps them
 * within a few tens of milliseconds of each other without either waiting for
 * the other. If the audio falls behind it is resynchronised by dropping, never
 * by delaying the picture.
 *
 * Two browser behaviours shape everything else in here:
 *
 * * **An `AudioContext` starts suspended** unless the page has already had a
 *   user gesture. There is no way around it and no way to detect it in advance,
 *   so sound starts muted and the UI has to offer a control. Silence with a
 *   visible "unmute" is honest; silence with no explanation reads as a broken
 *   stream.
 * * **`AudioData` is a handle on real memory** and is not garbage collected on
 *   any useful timescale. Every one produced here is closed exactly once.
 */

/**
 * How far ahead of the audio clock to schedule. Enough to absorb the jitter of
 * frames arriving over a WebSocket and being decoded on the main thread;
 * short enough to stay well inside a single video frame's worth of skew.
 */
const LEAD_SECONDS = 0.08;

/**
 * How far behind the playhead may fall before it is reset rather than caught
 * up. A viewer that has been backgrounded comes back with a backlog, and
 * playing it out would put the sound permanently behind the picture.
 */
const MAX_LAG_SECONDS = 0.5;

/** The same, in the other direction: a buffer this far ahead is not played. */
const MAX_LEAD_SECONDS = 1.5;

export class AudioPlayer extends EventTarget {
    /**
     * @param {(err: Error) => void} onError
     */
    constructor(onError = () => {}) {
        super();

        this.onError = onError;

        /** @type {AudioDecoder|null} */
        this.decoder = null;
        /** @type {AudioContext|null} */
        this.context = null;
        /** @type {GainNode|null} */
        this.gain = null;
        /** @type {MediaStreamAudioDestinationNode|null} */
        this._tap = null;

        this.config = null;

        /**
         * Muted until the viewer says otherwise. Not a preference — see the
         * autoplay note above.
         */
        this.muted = true;

        this.decoded = 0;
        this.played = 0;
        this.dropped = 0;
        this.errors = 0;
        this.resets = 0;

        /** Next start time on the `AudioContext` clock. */
        this._playhead = 0;
    }

    get configured() {
        return this.decoder?.state === 'configured';
    }

    /** True once there is sound to unmute. */
    get available() {
        return this.config !== null;
    }

    /**
     * (Re)configure for the phone's announced format.
     *
     * @param {object} config - The audio CONFIG payload: `{codec, sampleRate,
     *   numberOfChannels, description}`, where `description` is the
     *   base64-encoded `AudioSpecificConfig`.
     */
    async configure(config) {
        this.close();

        const description = decodeBase64(config.description);

        if (!description) {
            this.onError(new Error('the broadcast described its sound in a way this page cannot read'));
            return;
        }

        const decoderConfig = {
            codec: config.codec,
            sampleRate: config.sampleRate,
            numberOfChannels: config.numberOfChannels,
            // AAC in a WebCodecs `AudioDecoder` is always configured from an
            // `AudioSpecificConfig`; there is no in-band equivalent of the
            // parameter sets the video path relies on.
            description
        };

        const support = await AudioDecoder.isConfigSupported(decoderConfig).catch(() => ({ supported: false }));

        if (!support.supported) {
            this.onError(new Error(`this browser cannot decode ${config.codec}, so the broadcast plays silent`));
            return;
        }

        this.context = new AudioContext({
            sampleRate: config.sampleRate,
            // Tells the implementation to minimise output buffering. The whole
            // point of this path is that it is a monitor.
            latencyHint: 'interactive'
        });

        this.gain = this.context.createGain();
        this.gain.gain.value = this.muted ? 0 : 1;
        this.gain.connect(this.context.destination);

        this.decoder = new AudioDecoder({
            output: (data) => this._onData(data),
            error: (err) => {
                this.errors += 1;
                this.onError(new Error(`sound decoder: ${err.message}`));
            }
        });

        this.decoder.configure(decoderConfig);
        this.config = config;
        this._playhead = 0;

        this.dispatchEvent(new CustomEvent('available'));
    }

    /**
     * Feed one access unit.
     *
     * Every AAC frame is a key frame, so there is no gate here of the kind the
     * video path needs — see `FLAG.KEYFRAME` in `protocol.js`.
     *
     * @param {{payload: Uint8Array, timestamp: number}} frame
     */
    decode(frame) {
        if (!this.configured) return;

        // Decoding while muted keeps the decoder's clock and the page's memory
        // in a steady state, so unmuting starts playing immediately rather than
        // after a burst of catch-up. The output is simply not scheduled.
        try {
            this.decoder.decode(
                new EncodedAudioChunk({
                    type: 'key',
                    timestamp: frame.timestamp,
                    data: frame.payload
                })
            );
        } catch {
            this.errors += 1;
        }
    }

    /** @param {AudioData} data */
    _onData(data) {
        this.decoded += 1;

        try {
            if (this.muted || !this.context || this.context.state !== 'running') {
                this.dropped += 1;
                return;
            }

            this._schedule(data);
        } finally {
            data.close();
        }
    }

    /** @param {AudioData} data */
    _schedule(data) {
        const channels = data.numberOfChannels;
        const frames = data.numberOfFrames;
        if (!channels || !frames) return;

        const buffer = this.context.createBuffer(channels, frames, data.sampleRate);

        for (let channel = 0; channel < channels; channel += 1) {
            // `f32-planar` rather than whatever the decoder produced: the
            // conversion is the implementation's job and an `AudioBuffer` is
            // planar float either way.
            const plane = new Float32Array(frames);
            data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
            buffer.copyToChannel(plane, channel);
        }

        const now = this.context.currentTime;

        // Three cases: first buffer, the playhead has fallen behind real time
        // (a stall, or the tab was in the background), or it has run so far
        // ahead that something is wrong with the source clock. All three reset
        // rather than trying to play out what accumulated.
        if (
            this._playhead === 0 ||
            this._playhead < now - MAX_LAG_SECONDS ||
            this._playhead > now + MAX_LEAD_SECONDS
        ) {
            if (this._playhead !== 0) this.resets += 1;
            this._playhead = now + LEAD_SECONDS;
        }

        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        source.start(Math.max(this._playhead, now));

        this._playhead += buffer.duration;
        this.played += 1;
    }

    /**
     * Turn the sound on. Must be called from a user gesture the first time,
     * because that is the only thing that will resume a suspended context.
     */
    async unmute() {
        this.muted = false;

        if (this.gain) this.gain.gain.value = 1;

        if (this.context && this.context.state !== 'running') {
            try {
                await this.context.resume();
            } catch (err) {
                this.muted = true;
                if (this.gain) this.gain.gain.value = 0;
                this.onError(new Error(`could not start audio playback: ${err.message}`));
            }
        }

        // Whatever was decoded while muted is stale by now.
        this._playhead = 0;
        this.dispatchEvent(new CustomEvent('mutechange'));
    }

    mute() {
        this.muted = true;
        if (this.gain) this.gain.gain.value = 0;
        this._playhead = 0;
        this.dispatchEvent(new CustomEvent('mutechange'));
    }

    toggle() {
        return this.muted ? this.unmute() : Promise.resolve(this.mute());
    }

    /**
     * A `MediaStream` of what is being played, for the viewer's own recording
     * of a 1:1.
     *
     * Taken off the same gain node that feeds the speakers rather than off the
     * decoder, so what lands in the file is what the person actually heard.
     * That includes the mute: a muted viewer is not decoding into the graph at
     * all (see `_onData`), so they record silence from this side, and the
     * recorder says so rather than quietly producing a one-sided file.
     *
     * @returns {MediaStream|null} null when no sound track has arrived yet.
     */
    tap() {
        if (!this.context) return null;

        if (!this._tap) {
            this._tap = this.context.createMediaStreamDestination();
            this.gain.connect(this._tap);
        }

        return this._tap.stream;
    }

    /** Release the tap. Playback is unaffected. */
    untap() {
        if (!this._tap) return;

        try {
            this.gain?.disconnect(this._tap);
        } catch {
            /* the graph is already gone */
        }

        this._tap = null;
    }

    stats() {
        return {
            codec: this.config?.codec ?? null,
            sampleRate: this.config?.sampleRate ?? 0,
            channels: this.config?.numberOfChannels ?? 0,
            decoded: this.decoded,
            played: this.played,
            dropped: this.dropped,
            errors: this.errors,
            resets: this.resets,
            muted: this.muted
        };
    }

    close() {
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                /* already torn down */
            }
        }
        this.decoder = null;

        this._tap = null;
        this.context?.close().catch(() => {});
        this.context = null;
        this.gain = null;
        this.config = null;
        this._playhead = 0;
    }
}

/**
 * Base64 to bytes, without throwing at the caller.
 *
 * @param {string} value
 * @returns {Uint8Array|null}
 */
export function decodeBase64(value) {
    if (typeof value !== 'string' || value === '') return null;

    try {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.length ? bytes : null;
    } catch {
        return null;
    }
}

/** True when this browser can decode sound at all. */
export function audioCodecsAvailable() {
    return typeof window !== 'undefined' && 'AudioDecoder' in window && 'EncodedAudioChunk' in window;
}
