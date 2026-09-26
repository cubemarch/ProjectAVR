/**
 * The viewer's own recording of a 1:1.
 *
 * This is the other half of a pair, and the halves are deliberately unalike.
 * The creator's recording is made on the server by an FFmpeg attached to the
 * live session, so it contains what the camera sent and nothing else - talkback
 * travels the other way and is structurally out of its reach. That file is the
 * one that can be sold, because the customer is not in it.
 *
 * This one is made here, in the browser, out of the canvas the viewer is
 * watching and the two voices in the conversation, and it is written to their
 * own disk. It is never uploaded. There is no route that would accept it. A
 * file with a paying customer's voice in it is not a thing this service should
 * hold, and the cheapest way to be sure of that is for it never to arrive.
 *
 * What it still needs is the creator's permission, which is asked over the API
 * before this class is started - see `ViewerRecordingConsent` on the server.
 * The permission is real: nothing here starts without an answer, and the
 * browser's own recording indicator is lit for the whole time the microphone
 * is open.
 *
 * Two honest limitations, both surfaced rather than hidden:
 *
 * * **A muted viewer records silence from the far end.** The tap is taken off
 *   the same gain node that feeds the speakers, so the file contains what the
 *   person actually heard. `start()` reports it as a warning.
 * * **The picture is the canvas as laid out on this page**, at its current
 *   size, in whatever 2D or 3D mode is selected. It is a recording of the
 *   monitor, not a second master.
 */

/** Emitted state, in the order a recording passes through it. */
export const RECORDER_STATE = {
    IDLE: 'idle',
    STARTING: 'starting',
    RECORDING: 'recording',
    SAVING: 'saving',
    FAILED: 'failed'
};

/**
 * In preference order. VP9 is worth asking for on a screen recording of flat
 * video; the last entry is there for Safari, which records MP4 and nothing
 * else. If none of them is supported the browser gets to choose, which is the
 * only remaining option that is not "refuse".
 */
const MIME_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
];

/**
 * How often MediaRecorder hands over a chunk. Short enough that a crash loses
 * seconds rather than the conversation, long enough not to fragment the file.
 */
const CHUNK_MS = 2000;

export class ViewerRecorder extends EventTarget {
    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.canvas - What is being watched.
     * @param {import('./audio.js').AudioPlayer} opts.audio - The far end's voice.
     * @param {() => MediaStream|null} [opts.microphone] - An already-open
     *   microphone to reuse, normally talkback's. Injected rather than reached
     *   for so that this class never opens a second capture of the same device
     *   when one is already live, and so the page keeps one place that owns the
     *   microphone.
     * @param {number} [opts.frameRate]
     */
    constructor({ canvas, audio, microphone = () => null, frameRate = 30 }) {
        super();

        this.canvas = canvas;
        this.audio = audio;
        this.frameRate = frameRate;
        this._microphone = microphone;

        this.state = RECORDER_STATE.IDLE;
        this.error = null;

        /** Set when the far end was muted at the moment recording started. */
        this.warning = null;

        this.bytes = 0;
        this.startedAt = 0;

        /** @type {MediaRecorder|null} */
        this._recorder = null;
        /** @type {Blob[]} */
        this._chunks = [];
        this._filename = '';

        /** @type {MediaStream|null} */
        this._canvasStream = null;
        /** @type {MediaStream|null} */
        this._ownMic = null;
        /** @type {AudioContext|null} */
        this._mix = null;
    }

    get recording() {
        return this.state === RECORDER_STATE.RECORDING;
    }

    get busy() {
        return this.state === RECORDER_STATE.STARTING || this.state === RECORDER_STATE.SAVING;
    }

    /** Whether this browser has the pieces at all. Checked before offering the control. */
    static get supported() {
        return (
            typeof window !== 'undefined' &&
            typeof window.MediaRecorder === 'function' &&
            typeof HTMLCanvasElement !== 'undefined' &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        );
    }

    /**
     * Start recording.
     *
     * Must be called from a user gesture: opening a microphone this class does
     * not already have one of depends on it.
     *
     * @param {{filename?: string}} [opts]
     * @returns {Promise<boolean>} Whether it came up. The reason it did not is
     *   in `error`, and has already been announced as a state change.
     */
    async start({ filename = defaultFilename() } = {}) {
        if (this.recording || this.busy) return this.recording;

        if (!ViewerRecorder.supported) {
            return this._fail('This browser cannot record video.');
        }

        this.error = null;
        this.warning = null;
        this._setState(RECORDER_STATE.STARTING);

        try {
            const microphone = this._microphone() ?? (await this._openMicrophone());
            const far = this.audio?.tap() ?? null;

            if (this.audio?.muted) {
                this.warning = 'Sound is muted here, so their voice will not be in the recording.';
            } else if (!far) {
                this.warning = 'No sound has arrived yet, so only your microphone is being recorded.';
            }

            this._canvasStream = this.canvas.captureStream(this.frameRate);

            const tracks = [...this._canvasStream.getVideoTracks()];
            const mixed = this._mixAudio([far, microphone].filter(Boolean));
            if (mixed) tracks.push(...mixed.getAudioTracks());

            const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
            this._recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : undefined);
            this._filename = withExtension(filename, this._recorder.mimeType);
            this._chunks = [];
            this.bytes = 0;

            this._recorder.ondataavailable = (event) => {
                if (!event.data?.size) return;
                this._chunks.push(event.data);
                this.bytes += event.data.size;
                this.dispatchEvent(new CustomEvent('progress'));
            };

            // A recorder that has fallen over has not produced anything more,
            // so the honest thing is to stop and save what there is rather
            // than to leave a control that looks like it is still recording.
            this._recorder.onerror = (event) => {
                this.error = event?.error?.message ?? 'the recorder stopped unexpectedly';
                this.stop().catch(() => {});
            };

            this._recorder.start(CHUNK_MS);
            this.startedAt = Date.now();
            this._setState(RECORDER_STATE.RECORDING);

            return true;
        } catch (err) {
            this._release();
            const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
            return this._fail(
                denied
                    ? 'Microphone access was refused, so there is no recording to make.'
                    : `Recording could not be started: ${err?.message ?? err}`
            );
        }
    }

    /**
     * Stop, and save to the viewer's disk.
     *
     * @returns {Promise<{filename: string, sizeBytes: number, durationMs: number}|null>}
     */
    async stop() {
        if (!this._recorder || this.state === RECORDER_STATE.SAVING) return null;

        this._setState(RECORDER_STATE.SAVING);

        const recorder = this._recorder;
        const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;

        await new Promise((resolve) => {
            if (recorder.state === 'inactive') {
                resolve();
                return;
            }
            recorder.onstop = resolve;
            try {
                recorder.stop();
            } catch {
                resolve();
            }
        });

        const blob = new Blob(this._chunks, { type: recorder.mimeType || 'video/webm' });
        const filename = this._filename;

        this._chunks = [];
        this._recorder = null;
        this._release();

        if (!blob.size) {
            this._setState(RECORDER_STATE.IDLE);
            return null;
        }

        save(blob, filename);
        this._setState(this.error ? RECORDER_STATE.FAILED : RECORDER_STATE.IDLE);

        const saved = { filename, sizeBytes: blob.size, durationMs };
        this.dispatchEvent(new CustomEvent('saved', { detail: saved }));
        return saved;
    }

    /** Stop without saving. For leaving the page, not for the viewer. */
    discard() {
        try {
            this._recorder?.stop();
        } catch {
            /* already inactive */
        }

        this._recorder = null;
        this._chunks = [];
        this._release();
        this._setState(RECORDER_STATE.IDLE);
    }

    summary() {
        return {
            state: this.state,
            bytes: this.bytes,
            durationMs: this.startedAt && this.recording ? Date.now() - this.startedAt : 0,
            error: this.error,
            warning: this.warning
        };
    }

    /* ------------------------------------------------------------ internals -- */

    async _openMicrophone() {
        this._ownMic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });
        return this._ownMic;
    }

    /**
     * One audio track out of however many streams there are.
     *
     * The two sources live in different audio graphs - the far end is in the
     * player's context, the microphone is a device stream - so they are joined
     * through a third context rather than by connecting nodes that cannot be
     * connected.
     *
     * @param {MediaStream[]} streams
     * @returns {MediaStream|null}
     */
    _mixAudio(streams) {
        const withAudio = streams.filter((stream) => stream.getAudioTracks().length);
        if (!withAudio.length) return null;

        this._mix = new AudioContext();
        const destination = this._mix.createMediaStreamDestination();

        for (const stream of withAudio) {
            this._mix.createMediaStreamSource(stream).connect(destination);
        }

        return destination.stream;
    }

    /** Give back everything this recording was holding. */
    _release() {
        this._canvasStream?.getTracks().forEach((track) => track.stop());
        this._canvasStream = null;

        // Only ever the microphone this class opened. Talkback's own stream
        // belongs to talkback, and stopping it would cut the viewer off
        // mid-sentence.
        this._ownMic?.getTracks().forEach((track) => track.stop());
        this._ownMic = null;

        this.audio?.untap();

        this._mix?.close().catch(() => {});
        this._mix = null;
    }

    _fail(message) {
        this.error = message;
        this._setState(RECORDER_STATE.FAILED);
        return false;
    }

    _setState(state) {
        this.state = state;
        this.dispatchEvent(new CustomEvent('change', { detail: this.summary() }));
    }
}

/** `avr-1to1-2026-09-23-1412`, which sorts and does not collide within a minute. */
export function defaultFilename(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return [
        'avr-1to1-',
        now.getFullYear(),
        '-',
        pad(now.getMonth() + 1),
        '-',
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes())
    ].join('');
}

/** Match the extension to what the browser actually recorded. */
export function withExtension(name, mimeType = '') {
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    return name.endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/** Hand the file to the browser's download machinery and let go of it. */
function save(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();

    // Long enough for the download to have been handed off. Revoking
    // immediately cancels it in some browsers.
    const timer = setTimeout(() => URL.revokeObjectURL(url), 30_000);
    timer?.unref?.();
}
