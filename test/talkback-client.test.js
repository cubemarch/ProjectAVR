import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveConnection } from '../src/live/connection.js';
import { FRAME_TYPE, MAX_UPSTREAM_BYTES, TALKBACK, TRACK, decodeFrame, encodeFrame } from '../src/live/protocol.js';

/**
 * The browser's half of talkback, in the two places it can be reached from Node.
 *
 * The audio worklet is plain JavaScript against two globals, so it runs here
 * exactly as it runs on the audio thread - which matters, because it is the
 * piece that decides what a packet *is*, and a browser is a bad place to find
 * out that the answer was wrong by half a sample.
 *
 * `Talkback` itself is not tested here: it is `getUserMedia`, `AudioContext`
 * and an `?url` import from end to end, and a mock deep enough to run it would
 * be testing the mock. What it puts on the wire is covered on the other side,
 * in `talkback.test.js`, against the real relay.
 */

/* ---------------------------------------------------------------- worklet -- */

/**
 * The two globals an AudioWorklet module is loaded into.
 *
 * `port` belongs to the base class in the real API, so the fake provides it and
 * records what was posted through it. Registration is captured rather than
 * stubbed away: `registerProcessor` running with the expected name is part of
 * what is being checked.
 */
async function loadWorklet() {
    const registered = new Map();

    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = {
                messages: [],
                transfers: [],
                postMessage(message, transfer) {
                    this.messages.push(message);
                    this.transfers.push(transfer);
                }
            };
        }
    };
    globalThis.registerProcessor = (name, Processor) => registered.set(name, Processor);
    globalThis.sampleRate = TALKBACK.sampleRate;

    // Cache-busted so each test gets its own registration rather than whichever
    // one happened to import first.
    await import(`../src/live/talkback-worklet.js?t=${registered.size}-${Math.random()}`);

    return registered;
}

/** One 128-sample quantum, the only size a browser ever hands a worklet. */
function quantum(fill) {
    const block = new Float32Array(128);
    for (let i = 0; i < block.length; i += 1) block[i] = typeof fill === 'function' ? fill(i) : fill;
    return block;
}

test('the worklet registers under the name the page asks for', async () => {
    const registered = await loadWorklet();

    assert.ok(registered.has('talkback'), 'registerProcessor was called with "talkback"');
});

test('samples are gathered into whole packets and nothing is posted early', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({
        processorOptions: { frameSamples: TALKBACK.frameSamples }
    });

    // 640 samples is five quanta. Four of them must produce nothing at all: a
    // short packet would be a shorter moment of speech arriving as a click.
    for (let i = 0; i < 4; i += 1) {
        assert.equal(processor.process([[quantum(0.5)]]), true, 'the node stays alive');
    }
    assert.equal(processor.port.messages.length, 0, 'nothing posted with 512 samples in hand');

    processor.process([[quantum(0.5)]]);
    assert.equal(processor.port.messages.length, 1, 'the fifth quantum completes a packet');

    const packet = processor.port.messages[0];
    assert.ok(packet instanceof Int16Array);
    assert.equal(packet.length, TALKBACK.frameSamples);
    assert.equal(packet.byteLength, 1280, '40 ms of 16 kHz mono s16');
});

test('a packet is transferred, not copied', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({ processorOptions: { frameSamples: 256 } });

    processor.process([[quantum(0.1)]]);
    processor.process([[quantum(0.1)]]);

    assert.deepEqual(processor.port.transfers[0], [processor.port.messages[0].buffer]);
});

test('a run of quanta produces back-to-back packets with no samples lost', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({ processorOptions: { frameSamples: 640 } });

    // A counting ramp, so a dropped or duplicated sample shows up as a break in
    // the sequence rather than as silence that looks like silence.
    let n = 0;
    for (let i = 0; i < 25; i += 1) processor.process([[quantum(() => (n++ % 1000) / 4000)]]);

    assert.equal(processor.port.messages.length, 5, '3200 samples is five packets');

    const flat = processor.port.messages.flatMap((packet) => Array.from(packet));
    assert.equal(flat.length, 3200);

    for (let i = 0; i < flat.length; i += 1) {
        const expected = Math.trunc(((i % 1000) / 4000) * 0x7fff);
        assert.ok(Math.abs(flat[i] - expected) <= 1, `sample ${i} is where it was put`);
    }
});

test('samples outside the float range are clamped rather than wrapped', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({ processorOptions: { frameSamples: 128 } });

    processor.process([[quantum(4)]]);
    processor.process([[quantum(-4)]]);

    // Without the clamp, 4.0 scaled and truncated to 16 bits is not a loud
    // sample - it is a full-scale sample of the opposite sign, on every single
    // one of them, which is a square wave at full volume in somebody's ear.
    assert.equal(processor.port.messages[0][0], 0x7fff, 'over-range positive saturates');
    assert.equal(processor.port.messages[1][0], -0x8000, 'over-range negative saturates');
});

test('silence is silence, not a rounding offset', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({ processorOptions: { frameSamples: 128 } });

    processor.process([[quantum(0)]]);

    assert.ok(
        processor.port.messages[0].every((sample) => sample === 0),
        'a zero float is a zero integer'
    );
});

test('a disconnected input keeps the node alive and posts nothing', async () => {
    const registered = await loadWorklet();
    const processor = new (registered.get('talkback'))({ processorOptions: { frameSamples: 128 } });

    assert.equal(processor.process([[]]), true);
    assert.equal(processor.process([]), true);
    assert.equal(processor.port.messages.length, 0);
});

/* ------------------------------------------------------------- the socket -- */

/** A stand-in for the browser's WebSocket, open, with a settable backlog. */
function fakeSocket(bufferedAmount = 0) {
    return { readyState: 1, bufferedAmount, sent: [] , send(bytes) { this.sent.push(bytes); } };
}

test('a talkback packet fits inside what the relay will accept', () => {
    // The relay sets `MAX_UPSTREAM_BYTES` as the socket's `maxPayload`, so a
    // packet bigger than this is not dropped - the whole connection is closed.
    const packetBytes = TALKBACK.frameSamples * 2 + 20;

    assert.ok(packetBytes < MAX_UPSTREAM_BYTES, `${packetBytes} bytes of frame against a ${MAX_UPSTREAM_BYTES} cap`);
});

test('upstream frames go out while the socket is keeping up', () => {
    const connection = new LiveConnection('ABC123');
    const socket = fakeSocket(0);
    connection._ws = socket;

    const frame = new Uint8Array(1300);
    assert.equal(connection.sendUpstream(frame), true);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], frame, 'passed through untouched');
});

test('upstream frames are dropped rather than queued behind a backlog', () => {
    const connection = new LiveConnection('ABC123');
    const socket = fakeSocket(64 * 1024);
    connection._ws = socket;

    assert.equal(connection.sendUpstream(new Uint8Array(1300)), false);
    assert.equal(socket.sent.length, 0, 'nothing was added to a queue nobody is draining');

    // And it recovers by itself the moment the socket does.
    socket.bufferedAmount = 0;
    assert.equal(connection.sendUpstream(new Uint8Array(1300)), true);
});

test('nothing is sent upstream without a socket', () => {
    const connection = new LiveConnection('ABC123');

    assert.equal(connection.sendUpstream(new Uint8Array(8)), false);

    connection._ws = { readyState: 3, bufferedAmount: 0, send: () => assert.fail('sent on a closed socket') };
    assert.equal(connection.sendUpstream(new Uint8Array(8)), false);
});

test('chat and talkback are distinguishable on the wire', () => {
    const connection = new LiveConnection('ABC123');
    const socket = fakeSocket(0);
    connection._ws = socket;

    connection.say('hello');
    connection.sendUpstream(
        encodeFrame({ type: FRAME_TYPE.AUDIO, track: TRACK.TALKBACK, payload: new Uint8Array(1280) })
    );

    // The relay routes on the track alone, so the two things a viewer can send
    // have to be told apart by it and not by anything about their contents.
    const chat = decodeFrame(socket.sent[0]);
    const speech = decodeFrame(socket.sent[1]);

    assert.equal(chat.type, FRAME_TYPE.CHAT);
    assert.notEqual(chat.track, TRACK.TALKBACK);
    assert.equal(speech.track, TRACK.TALKBACK);
    assert.equal(speech.payload.length, 1280);
});
