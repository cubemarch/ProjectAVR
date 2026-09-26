import test from 'node:test';
import assert from 'node:assert/strict';

import { ViewerRecorder, defaultFilename, withExtension } from '../src/live/recorder.js';

/**
 * The viewer's own recording of a 1:1, in the parts that are promises rather
 * than plumbing.
 *
 * `MediaRecorder`, `AudioContext` and `captureStream` are faked here, which
 * would be pointless if the thing under test were the encoding. It is not. What
 * is being checked is the handful of claims the product makes to the two people
 * in the conversation: that nothing is uploaded, that the microphone already
 * open is reused rather than a second one taken, that only the microphone this
 * class opened is stopped when it is done, and that a viewer with the sound
 * muted is told their file will not have the other voice in it.
 */

/* ------------------------------------------------------------------ fakes -- */

function track(kind) {
    return { kind, stopped: false, stop() { this.stopped = true; } };
}

class FakeMediaStream {
    constructor(tracks = []) {
        this._tracks = tracks;
    }
    getTracks() {
        return this._tracks;
    }
    getVideoTracks() {
        return this._tracks.filter((t) => t.kind === 'video');
    }
    getAudioTracks() {
        return this._tracks.filter((t) => t.kind === 'audio');
    }
}

class FakeMediaRecorder {
    static supported = ['video/webm;codecs=vp9,opus'];
    static isTypeSupported(type) {
        return FakeMediaRecorder.supported.includes(type);
    }

    constructor(stream, options = {}) {
        this.stream = stream;
        this.mimeType = options.mimeType ?? 'video/webm';
        this.state = 'inactive';
        FakeMediaRecorder.last = this;
    }

    start() {
        this.state = 'recording';
    }

    stop() {
        this.state = 'inactive';
        // One chunk, the way a real recorder hands over whatever it has left.
        this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
        this.onstop?.();
    }
}

class FakeAudioContext {
    constructor() {
        this.sources = [];
        this.closed = false;
    }
    createMediaStreamDestination() {
        return { stream: new FakeMediaStream([track('audio')]) };
    }
    createMediaStreamSource(stream) {
        this.sources.push(stream);
        return { connect() {} };
    }
    close() {
        this.closed = true;
        return Promise.resolve();
    }
}

/** Stands in for `AudioPlayer`: the far end's voice, and whether it is audible. */
function farEnd({ muted = false, stream = new FakeMediaStream([track('audio')]) } = {}) {
    return {
        muted,
        untapped: false,
        tap() {
            return stream;
        },
        untap() {
            this.untapped = true;
        }
    };
}

/**
 * Everything the browser would provide, and nothing else.
 *
 * `fetch` is replaced with a throw rather than omitted: "nothing is uploaded"
 * is the load-bearing claim in this file, and a test that would pass because
 * the global happens to be missing is not testing it.
 */
function browser({ getUserMedia } = {}) {
    const saved = [];
    const opened = [];

    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        navigator: globalThis.navigator,
        fetch: globalThis.fetch,
        MediaRecorder: globalThis.MediaRecorder,
        MediaStream: globalThis.MediaStream,
        AudioContext: globalThis.AudioContext,
        HTMLCanvasElement: globalThis.HTMLCanvasElement,
        URL: globalThis.URL.createObjectURL
    };

    class FakeCanvasElement {}
    FakeCanvasElement.prototype.captureStream = function captureStream() {};

    globalThis.MediaRecorder = FakeMediaRecorder;
    globalThis.MediaStream = FakeMediaStream;
    globalThis.AudioContext = FakeAudioContext;
    globalThis.HTMLCanvasElement = FakeCanvasElement;
    globalThis.window = { MediaRecorder: FakeMediaRecorder };
    globalThis.fetch = () => {
        throw new Error('the viewer’s recording reached the network');
    };

    globalThis.URL.createObjectURL = () => 'blob:fake';
    globalThis.URL.revokeObjectURL = () => {};

    globalThis.document = {
        body: { append() {} },
        createElement: () => {
            const link = { click() {}, remove() {} };
            saved.push(link);
            return link;
        }
    };

    // Node defines `navigator` as a getter-only accessor on the global, so it
    // is redefined rather than assigned.
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
            mediaDevices: {
                getUserMedia:
                    getUserMedia ??
                    (async () => {
                        const stream = new FakeMediaStream([track('audio')]);
                        opened.push(stream);
                        return stream;
                    })
            }
        }
    });

    return {
        saved,
        opened,
        restore() {
            globalThis.window = previous.window;
            globalThis.document = previous.document;
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                writable: true,
                value: previous.navigator
            });
            globalThis.fetch = previous.fetch;
            globalThis.MediaRecorder = previous.MediaRecorder;
            globalThis.MediaStream = previous.MediaStream;
            globalThis.AudioContext = previous.AudioContext;
            globalThis.HTMLCanvasElement = previous.HTMLCanvasElement;
            globalThis.URL.createObjectURL = previous.URL;
        }
    };
}

/** A canvas that is only ever asked for its picture. */
function canvas() {
    return { captureStream: () => new FakeMediaStream([track('video')]) };
}

/* ------------------------------------------------------------------ tests -- */

test('a filename carries the extension of whatever the browser recorded', () => {
    assert.equal(withExtension('clip', 'video/webm;codecs=vp9,opus'), 'clip.webm');
    assert.equal(withExtension('clip', 'video/mp4'), 'clip.mp4');
    assert.equal(withExtension('clip.mp4', 'video/mp4'), 'clip.mp4', 'the extension is not doubled');
    assert.match(defaultFilename(new Date(2026, 8, 23, 14, 5)), /^avr-1to1-2026-09-23-1405$/);
});

test('the microphone already open for talkback is reused, not taken a second time', async (t) => {
    const env = browser();
    t.after(() => env.restore());

    const talkback = new FakeMediaStream([track('audio')]);
    const recorder = new ViewerRecorder({
        canvas: canvas(),
        audio: farEnd(),
        microphone: () => talkback
    });

    assert.equal(await recorder.start(), true);
    assert.equal(env.opened.length, 0, 'a second capture of the same microphone was opened');

    await recorder.stop();

    assert.equal(
        talkback.getAudioTracks()[0].stopped,
        false,
        'stopping the recording cut talkback off mid-sentence'
    );
});

test('a recording opens its own microphone when talkback is off, and gives it back', async (t) => {
    const env = browser();
    t.after(() => env.restore());

    const player = farEnd();
    const recorder = new ViewerRecorder({ canvas: canvas(), audio: player });

    assert.equal(await recorder.start(), true);
    assert.equal(env.opened.length, 1, 'no microphone was opened');

    const saved = await recorder.stop();

    assert.equal(env.opened[0].getAudioTracks()[0].stopped, true, 'the microphone was left open');
    assert.equal(player.untapped, true, 'the tap on the far end was left connected');
    assert.equal(recorder.state, 'idle');
    assert.match(saved.filename, /\.webm$/);
    assert.equal(saved.sizeBytes, 4096);
});

test('the file is saved to the viewer’s own disk and never sent anywhere', async (t) => {
    const env = browser();
    t.after(() => env.restore());

    const recorder = new ViewerRecorder({ canvas: canvas(), audio: farEnd() });

    await recorder.start({ filename: 'a-conversation' });
    const saved = await recorder.stop();

    // `fetch` throws in this environment, so reaching here at all is the
    // assertion; the download is the only thing that happened to the bytes.
    assert.equal(saved.filename, 'a-conversation.webm');
    assert.equal(env.saved.length, 1, 'the file was not handed to the browser to save');
});

test('a muted viewer is told their recording will not have the other voice in it', async (t) => {
    const env = browser();
    t.after(() => env.restore());

    const recorder = new ViewerRecorder({ canvas: canvas(), audio: farEnd({ muted: true }) });

    assert.equal(await recorder.start(), true);
    assert.match(recorder.warning, /muted/i);

    await recorder.stop();
});

test('a refused microphone is a refusal, not a silent recording', async (t) => {
    const env = browser({
        getUserMedia: async () => {
            const err = new Error('denied');
            err.name = 'NotAllowedError';
            throw err;
        }
    });
    t.after(() => env.restore());

    const recorder = new ViewerRecorder({ canvas: canvas(), audio: farEnd() });

    assert.equal(await recorder.start(), false);
    assert.equal(recorder.state, 'failed');
    assert.match(recorder.error, /Microphone access was refused/);
    assert.equal(recorder.recording, false);
});

test('both voices are mixed into one track: the far end and the microphone', async (t) => {
    const env = browser();
    t.after(() => env.restore());

    const far = new FakeMediaStream([track('audio')]);
    const mic = new FakeMediaStream([track('audio')]);
    const recorder = new ViewerRecorder({
        canvas: canvas(),
        audio: farEnd({ stream: far }),
        microphone: () => mic
    });

    await recorder.start();

    const mix = recorder._mix;
    assert.deepEqual(mix.sources, [far, mic], 'one of the two voices was left out of the mix');

    const recorded = FakeMediaRecorder.last.stream;
    assert.equal(recorded.getVideoTracks().length, 1, 'the picture was not recorded');
    assert.equal(recorded.getAudioTracks().length, 1, 'the two voices were not mixed to one track');

    await recorder.stop();
    assert.equal(mix.closed, true, 'the mixing context was left running');
});
