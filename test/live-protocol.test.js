import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    FRAME_TYPE,
    TRACK,
    FLAG,
    HEADER_BYTES,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    FrameReader,
    encodeFrame,
    encodeJsonFrame,
    decodeFrame,
    decodeJson,
    isKeyframe,
    trackName
} from '../src/live/protocol.js';

import { validateHello, getStreamKey } from '../server/live/ingest.js';
import { certificatePin } from '../server/live/tls.js';

/**
 * The wire format is the contract between a Swift encoder callback and a
 * browser's `VideoDecoder`, and neither end can be stepped through from here.
 * These tests pin the byte layout so a change on one side that would silently
 * desynchronise the other fails at `npm test` instead of on a phone.
 */

test('a frame round-trips through encode and decode', () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84]);

    const bytes = encodeFrame({
        type: FRAME_TYPE.VIDEO,
        track: TRACK.RIGHT,
        flags: FLAG.KEYFRAME,
        timestamp: 1_234_567_890,
        sequence: 42,
        payload
    });

    const frame = decodeFrame(bytes);

    assert.equal(frame.type, FRAME_TYPE.VIDEO);
    assert.equal(frame.track, TRACK.RIGHT);
    assert.equal(frame.timestamp, 1_234_567_890);
    assert.equal(frame.sequence, 42);
    assert.ok(isKeyframe(frame));
    assert.deepEqual([...frame.payload], [...payload]);
});

test('the header is exactly 20 bytes and length covers everything after it', () => {
    const bytes = encodeFrame({ type: FRAME_TYPE.VIDEO, payload: new Uint8Array(100) });

    assert.equal(bytes.length, HEADER_BYTES + 100);

    // `length` counts the 16 header bytes that follow it, plus the payload.
    const declared = new DataView(bytes.buffer).getUint32(0, true);
    assert.equal(declared, 16 + 100);
});

test('timestamps survive beyond 32 bits', () => {
    // Microseconds since boot overflows a u32 in 71 minutes, so the field is
    // a u64 and this is the case that would have caught using a u32.
    const timestamp = 7_000_000_000;
    const frame = decodeFrame(encodeFrame({ type: FRAME_TYPE.VIDEO, timestamp }));

    assert.equal(frame.timestamp, timestamp);
});

test('FrameReader reassembles a frame split across chunks', () => {
    const reader = new FrameReader();
    const payload = new Uint8Array(5000).fill(7);
    const bytes = encodeFrame({ type: FRAME_TYPE.VIDEO, track: TRACK.LEFT, payload });

    // A 5 KB keyframe always spans several TCP segments in practice.
    assert.deepEqual(reader.push(bytes.subarray(0, 3)), [], 'partial header yields nothing');
    assert.deepEqual(reader.push(bytes.subarray(3, 1400)), [], 'partial payload yields nothing');
    assert.deepEqual(reader.push(bytes.subarray(1400, 4000)), [], 'still partial');

    const frames = reader.push(bytes.subarray(4000));

    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.length, 5000);
    assert.equal(frames[0].payload[4999], 7);
    assert.equal(reader.pending, 0);
});

test('FrameReader returns every frame in a coalesced chunk, in order', () => {
    const reader = new FrameReader();

    const combined = Buffer.concat([
        encodeFrame({ type: FRAME_TYPE.VIDEO, track: TRACK.LEFT, sequence: 1, payload: new Uint8Array(10) }),
        encodeFrame({ type: FRAME_TYPE.VIDEO, track: TRACK.RIGHT, sequence: 2, payload: new Uint8Array(20) }),
        encodeFrame({ type: FRAME_TYPE.VIDEO, track: TRACK.LEFT, sequence: 3, payload: new Uint8Array(30) })
    ]);

    const frames = reader.push(new Uint8Array(combined));

    assert.deepEqual(
        frames.map((f) => f.sequence),
        [1, 2, 3]
    );
    assert.deepEqual(
        frames.map((f) => f.track),
        [TRACK.LEFT, TRACK.RIGHT, TRACK.LEFT]
    );
});

test('FrameReader hands back a payload that is a view into its own frame copy', () => {
    // The relay forwards `raw` untouched rather than re-serialising, so the
    // two must describe the same bytes or viewers get a corrupted stream.
    const reader = new FrameReader();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const [frame] = reader.push(encodeFrame({ type: FRAME_TYPE.VIDEO, payload }));

    assert.deepEqual([...frame.payload], [1, 2, 3, 4]);
    assert.equal(frame.raw.length, HEADER_BYTES + 4);
    assert.deepEqual([...decodeFrame(frame.raw).payload], [1, 2, 3, 4]);
});

test('FrameReader survives a stream of frames without unbounded growth', () => {
    const reader = new FrameReader();
    const frame = encodeFrame({ type: FRAME_TYPE.VIDEO, payload: new Uint8Array(1024) });

    for (let i = 0; i < 500; i += 1) {
        const frames = reader.push(frame);
        assert.equal(frames.length, 1);
    }

    assert.equal(reader.pending, 0);
});

test('FrameReader rejects an implausible length rather than allocating for it', () => {
    const reader = new FrameReader();
    const bogus = new Uint8Array(20);
    new DataView(bogus.buffer).setUint32(0, 0xffffffff, true);

    assert.throws(() => reader.push(bogus), /desynchronised/);
});

test('json frames round-trip', () => {
    const frame = decodeFrame(encodeJsonFrame(FRAME_TYPE.HELLO, { name: 'Rooftop', fps: 30 }));

    assert.equal(frame.type, FRAME_TYPE.HELLO);
    assert.deepEqual(decodeJson(frame), { name: 'Rooftop', fps: 30 });
});

test('track names match the keys the monitor and API use', () => {
    assert.equal(trackName(TRACK.LEFT), 'left');
    assert.equal(trackName(TRACK.RIGHT), 'right');
    assert.equal(trackName(TRACK.PACKED), 'packed');
});

/* ------------------------------------------------------------ handshake -- */

function hello(overrides = {}) {
    return {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        key: getStreamKey(),
        name: 'Rooftop',
        device: 'iPhone 15 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        baselineMm: 19.2,
        hfovDeg: 71,
        ...overrides
    };
}

test('a well-formed hello is accepted and normalised', () => {
    const result = validateHello(hello());

    assert.ok(result.ok);
    assert.equal(result.meta.projection, 'dome180');
    assert.equal(result.meta.stereo, 'sbs');
    assert.equal(result.meta.baselineMm, 19.2);
});

test('hello is rejected without the stream key', () => {
    assert.equal(validateHello(hello({ key: 'wrong' })).ok, false);
    assert.equal(validateHello(hello({ key: undefined })).ok, false);

    // A wrong key of a different length must fail the same way, not throw -
    // timingSafeEqual rejects mismatched lengths, so both sides are hashed.
    assert.equal(validateHello(hello({ key: 'x' })).ok, false);
    assert.equal(validateHello(hello({ key: 'x'.repeat(500) })).ok, false);
});

test('hello is rejected on a protocol or version mismatch', () => {
    assert.match(validateHello(hello({ protocol: 'rtmp' })).error, /unrecognised protocol/);
    assert.match(validateHello(hello({ version: 99 })).error, /protocol version/);
});

test('rejections that reconnecting cannot fix say so', () => {
    // The phone backs off and retries six times over about a minute on an
    // ordinary failure. A credential is single-use and short-lived, so retrying
    // one spends that minute being told the same thing while the shot is off
    // air - the code is what lets the client stop instead.
    assert.equal(validateHello(hello({ key: 'wrong' })).code, 'credential_rejected');
    assert.equal(validateHello(hello({ key: undefined })).code, 'credential_rejected');

    // One code for both, so the client never has to match on prose that reads
    // differently depending on whether identity enforcement is on.
    assert.equal(validateHello(hello({ protocol: 'rtmp' })).code, 'protocol_rejected');
    assert.equal(validateHello(hello({ version: 99 })).code, 'protocol_rejected');
});

test('rejections that might not recur carry no terminal code', () => {
    // Anything the operator could fix without a new credential has to stay
    // retryable, or a transient fault becomes a broadcast that gives up.
    for (const overrides of [
        { projection: 'hyperbolic' },
        { stereo: 'quadroscopic' },
        { mode: 'holographic' }
    ]) {
        const result = validateHello(hello(overrides));
        assert.equal(result.ok, false);
        assert.equal(result.code, undefined, JSON.stringify(overrides));
    }

    assert.equal(validateHello(null).code, undefined);
});

test('hello cannot introduce a projection the renderer has no geometry for', () => {
    // This value reaches a mesh builder and a shader, so an unchecked string
    // would be a broken render rather than a rejected connection.
    assert.match(validateHello(hello({ projection: 'hyperbolic' })).error, /unknown projection/);
    assert.match(validateHello(hello({ stereo: 'quadroscopic' })).error, /unknown stereo/);
    assert.match(validateHello(hello({ mode: 'holographic' })).error, /unknown mode/);
});

test('hello field lengths are bounded', () => {
    const result = validateHello(hello({ name: 'x'.repeat(5000), device: 'y'.repeat(5000) }));

    assert.ok(result.ok);
    assert.equal(result.meta.name.length, 120);
    assert.equal(result.meta.device.length, 120);
});

test('out-of-range optical metadata is dropped rather than trusted', () => {
    const result = validateHello(hello({ baselineMm: -5, hfovDeg: 9000, fisheyeFov: 12 }));

    assert.ok(result.ok);
    assert.equal(result.meta.baselineMm, null);
    assert.equal(result.meta.hfovDeg, null);
    assert.equal(result.meta.fisheyeFov, null);
});

/* ----------------------------------------------------- contribution TLS -- */

/**
 * A throwaway self-signed certificate.
 *
 * Generated rather than checked in: a fixture certificate in a repository is a
 * private key in a repository, and the first person to reuse it for a real
 * server would publish theirs too. Node cannot sign one, so this shells out -
 * and returns null where `openssl` is missing, because a pin test that cannot
 * make a certificate should skip rather than fail and teach everyone to ignore
 * a red suite.
 */
function selfSignedPem() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-tls-'));

    try {
        const certPath = path.join(dir, 'cert.pem');
        execFileSync(
            'openssl',
            ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                '-nodes', '-days', '1', '-subj', '/CN=avr-test',
                '-keyout', path.join(dir, 'key.pem'), '-out', certPath],
            { stdio: 'ignore' }
        );
        return fs.readFileSync(certPath, 'utf8');
    } catch {
        return null;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a certificate pin is 32 bytes and does not depend on how the PEM was written', (t) => {
    const pem = selfSignedPem();
    if (!pem) return t.skip('openssl is not available');

    const pin = certificatePin(pem);

    // The phone rejects a pin that is not 32 base64 bytes before it will use
    // one, so a construction that produced anything else would fail every
    // connection with a certificate error that looks like a server fault.
    assert.equal(Buffer.from(pin, 'base64').length, 32);

    // Hashing the file rather than the parsed certificate would make the pin
    // change when someone opened it in an editor on Windows, and the phone
    // would then refuse a certificate that had not changed at all.
    assert.equal(certificatePin(`${pem}\n`), pin);
    assert.equal(certificatePin(pem.replace(/\n/g, '\r\n')), pin);

    // And two certificates are two pins, which is the only property that makes
    // it worth sending.
    const other = selfSignedPem();
    if (other) assert.notEqual(certificatePin(other), pin);
});
