import workletUrl from './talkback-worklet.js?url';
import { FLAG, FRAME_TYPE, TALKBACK, TRACK, encodeFrame, encodeJsonFrame } from './protocol.js';

/**
 * The viewer's microphone, pointed back up the pipeline.
 *
 * Only ever used inside a 1:1: the relay will not carry talkback from anybody
 * but the person an open room belongs to, so this class is never the thing
 * deciding who may be heard. What it is responsible for is the honest part of
 * that - when the microphone is off it is *off*, released, with the browser's
 * recording indicator out. There is no muted-but-listening state here, because
 * a page that holds a live microphone stream and merely declines to send it is
 * asking to be trusted about something the person can check.
 *
 * The format is fixed by {@link TALKBACK} and is not negotiated. If the browser
 * will not give us a 16 kHz context this refuses to start rather than sending
 * audio at a rate the far end has been told is something else - the camera
 * plays these samples straight out, so a wrong rate is not a degraded call, it
 * is a chipmunk.
 */

/** Emitted state, in the order a working session passes through it. */
export const TALKBACK_STATE = {
    OFF: 'off',
    STARTING: 'starting',
    LIVE: 'live',
    FAILED: 'failed'
};

const MICROSECONDS = 1_000_000;

export class Talkback extends EventTarget {
    /**
     * @param {object} opts
     * @param {(bytes: Uint8Array) => boolean} opts.send - Puts one encoded
     *   frame on the wire, or returns false having dropped it. Injected rather
     *   than taking a {@link LiveConnection} so the microphone path has no
     *   opinion about sockets, and so a reconnect can swap the destination
     *   without restarting the audio graph.
     */
    constructor({ send }) {
        super();

        this._send = send;
        this.state = TALKBACK_STATE.OFF;
        this.error = null;

        /** Peak of the last packet, 0..1. For a meter; nothing depends on it. */
        this.level = 0;

        /** Packets the socket refused. Visible so the UI can say "breaking up". */
        this.dropped = 0;
        this.sent = 0;

        this._stream = null;
        this._context = null;
        this._node = null;
        this._source = null;
        this._sink = null;
        this._samples = 0;
        this._sequence = 0;
    }

    get live() {
        return this.state === TALKBACK_STATE.LIVE;
    }

    /** Whether this browser has the pieces at all. Checked before offering the control. */
    static get supported() {
        return (
            typeof window !== 'undefined' &&
            typeof window.AudioWorkletNode === 'function' &&
            typeof navigator !== 'undefined' &&
            typeof navigator.mediaDevices?.getUserMedia === 'function'
        );
    }

    /**
     * Ask for the microphone and start sending.
     *
     * Must be called from a user gesture: both the permission prompt and
     * resuming a suspended audio context depend on it.
     *
     * @returns {Promise<boolean>} Whether it came up. The reason it did not is
     *   in `error`, and has already been announced as a state change.
     */
    async open() {
        if (this.state === TALKBACK_STATE.STARTING || this.live) return this.live;

        this.error = null;

        if (!Talkback.supported) {
            return this._fail('This browser cannot send talkback audio.');
        }

        this._setState(TALKBACK_STATE.STARTING);

        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // The far end is a loudspeaker in the same conversation, so
                    // the three processors that exist for exactly this case are
                    // all wanted. They are hints - a browser that ignores them
                    // still gives us usable speech.
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: TALKBACK.numberOfChannels,
                    sampleRate: TALKBACK.sampleRate
                },
                video: false
            });
        } catch (err) {
            // NotAllowedError is a person saying no, which is not a failure to
            // report as breakage; everything else is.
            const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
            return this._fail(
                denied
                    ? 'Microphone access was refused, so they will not be able to hear you.'
                    : `The microphone could not be opened: ${err?.message ?? err}`
            );
        }

        try {
            this._context = new AudioContext({ sampleRate: TALKBACK.sampleRate });

            // Some browsers quietly hand back a context at the hardware rate
            // instead of the one asked for. Resampling here is possible but
            // would put a second-rate resampler in the one place nobody would
            // think to look when a call sounds wrong, so this stops instead.
            if (this._context.sampleRate !== TALKBACK.sampleRate) {
                const actual = this._context.sampleRate;
                await this._teardown();
                return this._fail(
                    `This browser records at ${actual} Hz and talkback needs ${TALKBACK.sampleRate} Hz.`
                );
            }

            if (this._context.state === 'suspended') await this._context.resume();

            await this._context.audioWorklet.addModule(workletUrl);

            this._node = new AudioWorkletNode(this._context, 'talkback', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { frameSamples: TALKBACK.frameSamples }
            });
            this._node.port.onmessage = (event) => this._packet(event.data);

            this._source = this._context.createMediaStreamSource(this._stream);

            // Through a silent gain node to the speakers. The node produces no
            // output of its own, but several browsers will not run a worklet
            // that is not connected to the destination, and routing the
            // microphone to an audible output would be feedback.
            this._sink = this._context.createGain();
            this._sink.gain.value = 0;

            this._source.connect(this._node);
            this._node.connect(this._sink);
            this._sink.connect(this._context.destination);
        } catch (err) {
            await this._teardown();
            return this._fail(`Talkback could not start: ${err?.message ?? err}`);
        }

        // Unplugging a headset ends the track rather than erroring, so without
        // this the control would sit there saying "live" into a dead device.
        for (const track of this._stream.getAudioTracks()) {
            track.addEventListener('ended', () => {
                if (this.live) void this.close('The microphone was disconnected.');
            });
        }

        this._samples = 0;
        this._sequence = 0;
        this.dropped = 0;
        this.sent = 0;

        // Announces the format before any of it arrives. The server answers
        // with its own copy of these values rather than trusting these, which
        // is why it is safe for this to be the only thing we say about format.
        this._send(
            encodeJsonFrame(
                FRAME_TYPE.CONFIG,
                {
                    codec: TALKBACK.codec,
                    sampleRate: TALKBACK.sampleRate,
                    numberOfChannels: TALKBACK.numberOfChannels
                },
                { track: TRACK.TALKBACK }
            )
        );

        this._setState(TALKBACK_STATE.LIVE);
        return true;
    }

    /**
     * Stop, and give the microphone back.
     *
     * @param {string|null} [reason] - Shown to the person if the stop was not
     *   something they asked for.
     */
    async close(reason = null) {
        const wasLive = this.state !== TALKBACK_STATE.OFF;
        await this._teardown();

        this.level = 0;
        this.error = reason;
        this._setState(TALKBACK_STATE.OFF);

        if (wasLive && reason) this._emit('notice', { message: reason });
    }

    /** @param {Int16Array} pcm One packet, already integer, from the audio thread. */
    _packet(pcm) {
        if (!this.live) return;

        let peak = 0;
        for (let i = 0; i < pcm.length; i += 1) {
            const magnitude = Math.abs(pcm[i]);
            if (magnitude > peak) peak = magnitude;
        }
        this.level = peak / 0x8000;

        // Counted in samples rather than read off a clock: it is exactly the
        // presentation time of these samples, it cannot drift against the audio
        // the far end is playing, and it does not jump when the tab is
        // throttled. Microseconds, like every other timestamp on the wire.
        const timestamp = Math.round((this._samples / TALKBACK.sampleRate) * MICROSECONDS);
        this._samples += pcm.length;
        this._sequence += 1;

        const frame = encodeFrame({
            type: FRAME_TYPE.AUDIO,
            track: TRACK.TALKBACK,
            flags: FLAG.KEYFRAME,
            timestamp,
            sequence: this._sequence,
            payload: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        });

        if (this._send(frame)) this.sent += 1;
        else this.dropped += 1;

        this._emit('level', { level: this.level, dropped: this.dropped });
    }

    async _teardown() {
        try {
            if (this._node) this._node.port.onmessage = null;
            this._source?.disconnect();
            this._node?.disconnect();
            this._sink?.disconnect();
            for (const track of this._stream?.getTracks() ?? []) track.stop();
            await this._context?.close();
        } catch {
            // Tearing down is best-effort: the stream may already be dead, and
            // there is nothing useful to do about a failure to let go.
        }

        this._stream = null;
        this._context = null;
        this._node = null;
        this._source = null;
        this._sink = null;
    }

    _fail(message) {
        this.error = message;
        this._setState(TALKBACK_STATE.FAILED);
        return false;
    }

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this._emit('state', { state, error: this.error });
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
