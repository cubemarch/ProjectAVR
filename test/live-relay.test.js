import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import {
    FRAME_TYPE,
    TRACK,
    FLAG,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    FrameReader,
    encodeFrame,
    encodeJsonFrame,
    decodeFrame,
    decodeJson
} from '../src/live/protocol.js';
import { SessionRegistry } from '../server/live/sessions.js';
import { RoomRegistry } from '../server/live/rooms.js';
import { IngestServer, getStreamKey } from '../server/live/ingest.js';
import { LiveRelay } from '../server/live/relay.js';

/**
 * End-to-end through the real sockets: a fake phone pushes frames into the TCP
 * ingest, and a real WebSocket viewer reads them back out of the relay.
 *
 * Worth doing over the sockets rather than against the registry directly,
 * because the two properties that actually matter in live video - that a late
 * joiner is gated until a keyframe, and that bytes arrive unmodified - are
 * both properties of the path, not of any one object on it.
 */

/** Stand-in for the iPhone: speaks the protocol over a real TCP socket. */
class FakeBroadcaster {
    constructor(port) {
        this.port = port;
        this.socket = null;
        this.reader = new FrameReader();
        this.received = [];
        this._waiters = [];
    }

    async connect() {
        this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' });
        await once(this.socket, 'connect');

        this.socket.on('data', (chunk) => {
            for (const frame of this.reader.push(new Uint8Array(chunk))) {
                this.received.push(frame);
                for (const waiter of this._waiters.splice(0)) waiter();
            }
        });

        return this;
    }

    send(bytes) {
        this.socket.write(bytes);
    }

    hello(overrides = {}) {
        this.send(
            encodeJsonFrame(FRAME_TYPE.HELLO, {
                protocol: PROTOCOL_NAME,
                version: PROTOCOL_VERSION,
                key: getStreamKey(),
                name: 'Test broadcast',
                device: 'iPhone 15 Pro (simulated)',
                mode: 'separate',
                projection: 'dome180',
                stereo: 'sbs',
                baselineMm: 19.2,
                hfovDeg: 71,
                ...overrides
            })
        );
    }

    config(track, codec = 'avc1.640028') {
        this.send(encodeJsonFrame(FRAME_TYPE.CONFIG, { codec, codedWidth: 1920, codedHeight: 1080 }, { track }));
    }

    video(track, { key = false, timestamp = 0, sequence = 0, size = 64 } = {}) {
        this.send(
            encodeFrame({
                type: FRAME_TYPE.VIDEO,
                track,
                flags: key ? FLAG.KEYFRAME : 0,
                timestamp,
                sequence,
                payload: new Uint8Array(size).fill(key ? 0x65 : 0x41)
            })
        );
    }

    audioConfig({ codec = 'mp4a.40.2', sampleRate = 48_000, numberOfChannels = 2 } = {}) {
        this.send(
            encodeJsonFrame(
                FRAME_TYPE.CONFIG,
                { codec, sampleRate, numberOfChannels, description: 'EZA=' },
                { track: TRACK.AUDIO }
            )
        );
    }

    /**
     * One AAC-LC access unit. Always flagged as a keyframe, because it always
     * is one - see FLAG.KEYFRAME in src/live/protocol.js.
     */
    audio({ timestamp = 0, sequence = 0, size = 300 } = {}) {
        this.send(
            encodeFrame({
                type: FRAME_TYPE.AUDIO,
                track: TRACK.AUDIO,
                flags: FLAG.KEYFRAME,
                timestamp,
                sequence,
                payload: new Uint8Array(size).fill(0x21)
            })
        );
    }

    /** Resolve once a frame of `type` has arrived. */
    async waitFor(type, timeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const found = this.received.find((f) => f.type === type);
            if (found) return found;

            if (Date.now() > deadline) throw new Error(`timed out waiting for frame type ${type}`);
            await new Promise((resolve) => {
                this._waiters.push(resolve);
                setTimeout(resolve, 25);
            });
        }
    }

    close() {
        this.socket?.destroy();
    }
}

/** Stand-in for the monitor page. */
class FakeViewer {
    constructor(url) {
        this.url = url;
        this.frames = [];
        this.ws = null;
    }

    async connect() {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.on('message', (data) => {
            this.frames.push(decodeFrame(new Uint8Array(data)));
        });

        await once(this.ws, 'open');
        return this;
    }

    of(type) {
        return this.frames.filter((f) => f.type === type);
    }

    close() {
        this.ws?.close();
    }
}

/** Spin up ingest + relay on ephemeral ports with an isolated registry. */
async function startStack() {
    const registry = new SessionRegistry();

    // Its own room registry, not the process singleton: these tests create real
    // sessions, and a leaked room would change what a later test is allowed to
    // watch.
    const rooms = new RoomRegistry({ sessions: registry });

    const httpServer = http.createServer((req, res) => res.end('ok'));
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const relay = new LiveRelay({ registry, rooms });
    relay.attach(httpServer);

    const ingest = new IngestServer({ port: 0, host: '127.0.0.1', registry });
    ingest.start();
    await once(ingest.server, 'listening');

    return {
        registry,
        rooms,
        ingestPort: ingest.server.address().port,
        httpPort: httpServer.address().port,
        async stop() {
            registry.closeAll('test over');
            rooms.detach();
            relay.detach();
            ingest.stop();
            httpServer.close();
            await once(httpServer, 'close').catch(() => {});
        }
    };
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------------ */

test('a broadcaster handshake creates a session and returns its id', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();

    const ready = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    assert.match(ready.sessionId, /^[0-9A-HJKMNP-TV-Z]{6}$/, 'id is short and unambiguous');
    assert.equal(ready.projection, 'dome180');
    assert.equal(ready.baselineMm, 19.2);
    assert.equal(stack.registry.size, 1);

    phone.close();
});

test('a bad stream key is refused and no session is created', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello({ key: 'not-the-key' });

    await settle(150);

    assert.equal(stack.registry.size, 0);
    phone.close();
});

test('frames reach a viewer byte-for-byte as the encoder produced them', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT);
    phone.config(TRACK.RIGHT);
    await settle();

    const viewer = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    phone.video(TRACK.LEFT, { key: true, timestamp: 1000, size: 512 });
    phone.video(TRACK.RIGHT, { key: true, timestamp: 1000, size: 512 });
    await settle();

    const video = viewer.of(FRAME_TYPE.VIDEO);

    assert.equal(video.length, 2);
    assert.deepEqual(
        video.map((f) => f.track),
        [TRACK.LEFT, TRACK.RIGHT]
    );
    assert.equal(video[0].payload.length, 512);
    assert.equal(video[0].payload[0], 0x65, 'payload survived the relay unmodified');
    assert.equal(video[0].timestamp, 1000, 'both eyes carry the same capture timestamp');
    assert.equal(video[1].timestamp, 1000);

    viewer.close();
    phone.close();
});

test('a late joiner gets the cached config and is gated until a keyframe', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    // The broadcast has been running a while before anyone tunes in.
    phone.config(TRACK.LEFT, 'avc1.42E01E');
    phone.video(TRACK.LEFT, { key: true, timestamp: 0 });
    phone.video(TRACK.LEFT, { timestamp: 33_000 });
    await settle();

    const viewer = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    const configs = viewer.of(FRAME_TYPE.CONFIG);
    assert.equal(configs.length, 1, 'the cached config is replayed on join');
    assert.equal(decodeJson(configs[0]).codec, 'avc1.42E01E');

    // Delta frames reference pictures this viewer never saw.
    phone.video(TRACK.LEFT, { timestamp: 66_000 });
    phone.video(TRACK.LEFT, { timestamp: 99_000 });
    await settle();

    assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 0, 'deltas before the first keyframe are withheld');

    phone.video(TRACK.LEFT, { key: true, timestamp: 132_000 });
    phone.video(TRACK.LEFT, { timestamp: 165_000 });
    await settle();

    const video = viewer.of(FRAME_TYPE.VIDEO);
    assert.equal(video.length, 2, 'decoding starts at the keyframe and continues');
    assert.ok(video[0].flags & FLAG.KEYFRAME);

    viewer.close();
    phone.close();
});

test('sound reaches a late joiner without waiting for anything', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT, 'avc1.42E01E');
    phone.audioConfig();
    phone.video(TRACK.LEFT, { key: true, timestamp: 0 });
    phone.audio({ timestamp: 0 });
    await settle();

    const viewer = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    const audioConfig = viewer
        .of(FRAME_TYPE.CONFIG)
        .find((f) => f.track === TRACK.AUDIO);
    assert.ok(audioConfig, 'the audio config is cached and replayed on join');
    assert.equal(decodeJson(audioConfig).codec, 'mp4a.40.2');
    assert.equal(decodeJson(audioConfig).sampleRate, 48_000);

    // The video track is still gated: this viewer has not seen an IDR yet.
    phone.video(TRACK.LEFT, { timestamp: 33_000 });
    phone.audio({ timestamp: 21_333, sequence: 1 });
    phone.audio({ timestamp: 42_666, sequence: 2 });
    await settle();

    assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 0, 'video still waits for a keyframe');

    const audio = viewer.of(FRAME_TYPE.AUDIO);
    assert.equal(audio.length, 2, 'every access unit decodes on its own, so none are held back');
    assert.equal(audio[0].track, TRACK.AUDIO);
    assert.equal(audio[0].timestamp, 21_333);
    assert.equal(audio[0].payload.length, 300);
    assert.equal(audio[0].payload[0], 0x21, 'payload survived the relay unmodified');

    viewer.close();
    phone.close();
});

test('sound is counted as its own track in the session statistics', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.audioConfig();
    for (let i = 0; i < 5; i += 1) phone.audio({ timestamp: i * 21_333, sequence: i });
    await settle();

    const session = stack.registry.get(sessionId);
    const stats = session.summary().stats.audio;

    assert.equal(stats.frames, 5);
    assert.equal(stats.bytes, 5 * 300);
    assert.equal(stats.keyframes, 5, 'every AAC access unit is one');
    assert.equal(stats.dropped, 0);
    assert.equal(session.describe().tracks.audio.codec, 'mp4a.40.2');

    phone.close();
});

test('a changed config resyncs every existing viewer', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT);
    await settle();

    const viewer = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    phone.video(TRACK.LEFT, { key: true, timestamp: 0 });
    await settle();
    assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 1);

    // The creator switched resolution mid-broadcast; the old decoder is dead.
    phone.config(TRACK.LEFT, 'avc1.640033');
    phone.video(TRACK.LEFT, { timestamp: 33_000 });
    await settle();

    assert.equal(viewer.of(FRAME_TYPE.CONFIG).length, 2, 'the new config is pushed out');
    assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 1, 'and deltas are withheld again until a keyframe');

    phone.video(TRACK.LEFT, { key: true, timestamp: 66_000 });
    await settle();
    assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 2);

    viewer.close();
    phone.close();
});

test('several viewers all receive the same broadcast', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT);
    phone.config(TRACK.RIGHT);
    await settle();

    const url = `ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`;
    const viewers = await Promise.all([
        new FakeViewer(url).connect(),
        new FakeViewer(url).connect(),
        new FakeViewer(url).connect()
    ]);
    await settle();

    for (let i = 0; i < 5; i += 1) {
        phone.video(TRACK.LEFT, { key: i === 0, timestamp: i * 33_000 });
        phone.video(TRACK.RIGHT, { key: i === 0, timestamp: i * 33_000 });
    }
    await settle(200);

    for (const viewer of viewers) {
        assert.equal(viewer.of(FRAME_TYPE.VIDEO).length, 10);
    }

    assert.equal(stack.registry.get(sessionId).summary().viewers, 3);

    for (const viewer of viewers) viewer.close();
    phone.close();
});

test('joining a broadcast that does not exist fails the upgrade', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const ws = new WebSocket(`ws://127.0.0.1:${stack.httpPort}/live/ws/ZZZZZZ`);
    const [err] = await once(ws, 'error');

    assert.match(err.message, /404/);
});

/* ------------------------------------------------- broadcasts with a room -- */

/**
 * Put a waiting viewer in a room and hand back the secret their page would
 * hold. The grant id is the only thing that crosses to the broadcast side,
 * which is the point of the design: the phone carries a stream key and learns
 * nothing about who is watching.
 */
function admit(stack, grantId) {
    const viewer = stack.rooms.register({ userId: 'u1', name: 'Dana', device: 'Apple Vision Pro' });
    const room = stack.rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });
    stack.rooms.bindGrant(room, grantId);
    return { viewer, room };
}

/** A broadcast as the ingest path would create it, minus the socket. */
function privateBroadcast(stack, grantId) {
    return stack.registry.create({
        name: 'For Dana',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        grantId
    });
}

test('the admitted viewer can watch the broadcast opened for them', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const { viewer } = admit(stack, 'grant-1');
    const session = privateBroadcast(stack, 'grant-1');

    const url = `ws://127.0.0.1:${stack.httpPort}/live/ws/${session.id}?admit=${encodeURIComponent(viewer.token)}`;
    const watcher = await new FakeViewer(url).connect();
    await settle();

    assert.equal(session.subscribers.size, 1);
    watcher.close();
});

test('everybody else is refused a broadcast with a room, and told nothing', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const { viewer } = admit(stack, 'grant-1');
    const session = privateBroadcast(stack, 'grant-1');

    for (const query of ['', '?admit=', '?admit=guessed', `?admit=${viewer.id}`]) {
        const ws = new WebSocket(`ws://127.0.0.1:${stack.httpPort}/live/ws/${session.id}${query}`);
        const [err] = await once(ws, 'error');

        // 404, not 403: a wrong guess must not confirm that the id was right.
        assert.match(err.message, /404/, `refused for ${query || 'no secret'}`);
    }

    assert.equal(session.subscribers.size, 0);
});

test('a broadcast nobody was chosen for is still watchable by anyone', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    // A room exists on this server, just not for this broadcast.
    admit(stack, 'grant-1');

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    const watcher = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    assert.equal(stack.registry.get(sessionId).subscribers.size, 1);

    watcher.close();
    phone.close();
});

test('the phone disconnecting ends the session and disconnects viewers', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT);
    await settle();

    const viewer = await new FakeViewer(`ws://127.0.0.1:${stack.httpPort}/live/ws/${sessionId}`).connect();
    await settle();

    const closed = once(viewer.ws, 'close');
    phone.close();
    await closed;

    assert.equal(stack.registry.size, 0, 'the session is gone, not left as a stale entry');
    assert.equal(viewer.of(FRAME_TYPE.BYE).length, 1, 'viewers were told why');
});

test('session statistics reflect what actually went through', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();
    phone.hello();
    const { sessionId } = decodeJson(await phone.waitFor(FRAME_TYPE.READY));

    phone.config(TRACK.LEFT);
    phone.config(TRACK.RIGHT);

    for (let i = 0; i < 10; i += 1) {
        phone.video(TRACK.LEFT, { key: i === 0, timestamp: i * 33_000, size: 1000 });
        phone.video(TRACK.RIGHT, { key: i === 0, timestamp: i * 33_000, size: 1000 });
    }
    await settle(200);

    const summary = stack.registry.get(sessionId).summary();

    assert.equal(summary.stats.left.frames, 10);
    assert.equal(summary.stats.right.frames, 10);
    assert.equal(summary.stats.left.keyframes, 1);
    assert.equal(summary.stats.left.bytes, 10_000);
    assert.equal(summary.stats.left.width, 1920);
    assert.equal(summary.stats.left.codec, 'avc1.640028');
    assert.ok(summary.uptimeSeconds >= 0);

    phone.close();
});

test('a frame before the handshake is refused', async (t) => {
    const stack = await startStack();
    t.after(() => stack.stop());

    const phone = await new FakeBroadcaster(stack.ingestPort).connect();

    // No HELLO - straight to video.
    phone.video(TRACK.LEFT, { key: true });
    await settle(150);

    assert.equal(stack.registry.size, 0);
    phone.close();
});
