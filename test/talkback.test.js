import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { WebSocket } from 'ws';

/**
 * Talkback: the one thing that travels up the pipeline.
 *
 * Everything else on this server moves outwards from a camera. This moves the
 * other way - a viewer's microphone, through the relay, onto the contribution
 * socket - so it is the one path where a stranger's bytes are handed to the
 * capture app, and the tests are written about exactly that.
 *
 * Three properties carry the whole thing:
 *
 *   Only the person the broadcast is private to may send. Not a public viewer,
 *   not somebody who was in the room a minute ago.
 *
 *   What reaches the camera has a header this server wrote. A viewer cannot put
 *   a frame type or a track of their choosing in front of the phone's parser.
 *
 *   It is dropped rather than queued when the camera's socket is behind. The
 *   picture is what that socket is for.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-talkback-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.AVR_LIVE = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_IDENTITY_PROVIDER = 'mock';

const { users } = await import('../server/db/index.js');
const { ChatRegistry } = await import('../server/live/chat.js');
const { BillingRegistry } = await import('../server/live/billing.js');
const { PrivateTurns } = await import('../server/live/private.js');
const { SessionRegistry } = await import('../server/live/sessions.js');
const { RoomRegistry } = await import('../server/live/rooms.js');
const { LiveRelay } = await import('../server/live/relay.js');
const { issueAccessToken } = await import('../server/auth/tokens.js');
const { FLAG, FRAME_TYPE, TALKBACK, TRACK, decodeFrame, decodeJson, encodeFrame, encodeJsonFrame } =
    await import('../src/live/protocol.js');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;

function makeUser(role = 'viewer') {
    seq += 1;
    return users.create({
        email: `talkback${seq}@example.test`,
        passwordHash: 'x',
        displayName: `Person ${seq}`,
        role
    });
}

async function relayStack() {
    const registry = new SessionRegistry();
    const rooms = new RoomRegistry({ sessions: registry });
    const billing = new BillingRegistry();
    const chat = new ChatRegistry();
    const turns = new PrivateTurns({ sessions: registry, rooms, chat, billing });

    const httpServer = http.createServer((req, res) => res.end('ok'));
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const relay = new LiveRelay({ registry, rooms, billing, chat, turns });
    relay.attach(httpServer);

    return {
        registry,
        rooms,
        turns,
        port: httpServer.address().port,
        async stop() {
            billing.clear();
            chat.clear();
            turns.clear();
            registry.closeAll('test over');
            rooms.detach();
            relay.detach();
            httpServer.close();
            await once(httpServer, 'close').catch(() => {});
        }
    };
}

/** An unpriced broadcast, so admission is the only variable. */
function broadcast(sessions, { creatorId = null } = {}) {
    return sessions.create({
        name: 'Test broadcast',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        userId: creatorId
    });
}

/** Stand in for the phone's TCP socket, and remember what it was sent. */
function camera(session, { backlog = 0 } = {}) {
    const written = [];

    session.setUplink({
        write: (bytes) => written.push(decodeFrame(new Uint8Array(bytes))),
        get backlog() {
            return backlog;
        }
    });

    return written;
}

async function watch(port, sessionId, { user = null, admit = null } = {}) {
    const query = new URLSearchParams();
    if (user) query.set('access_token', await issueAccessToken(user));
    if (admit) query.set('admit', admit);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live/ws/${sessionId}?${query}`);
    ws.binaryType = 'arraybuffer';
    await once(ws, 'open');

    return ws;
}

/** 40 ms of something, as whole 16-bit samples. */
function speech(samples = TALKBACK.frameSamples, value = 1234) {
    const pcm = new Int16Array(samples).fill(value);
    return new Uint8Array(pcm.buffer);
}

function talk(ws, payload, opts = {}) {
    ws.send(
        encodeFrame({
            type: FRAME_TYPE.AUDIO,
            track: TRACK.TALKBACK,
            timestamp: 1000,
            payload,
            ...opts
        })
    );
}

/** Everything in flight has landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/* ---------------------------------------------------------- who may talk -- */

test('the viewer a broadcast is private to is heard by the camera', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    talk(ws, speech());
    await settle();

    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, FRAME_TYPE.AUDIO);
    assert.equal(heard[0].track, TRACK.TALKBACK);
    assert.equal(heard[0].payload.length, TALKBACK.frameSamples * 2);

    ws.close();
});

test('a viewer on a public broadcast is not', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const ws = await watch(stack.port, session.id, { user: viewer });

    talk(ws, speech());
    await settle();

    // No room, so nobody has the floor. In silence, as with everything else a
    // viewer is not allowed to send.
    assert.equal(heard.length, 0);
    assert.equal(ws.readyState, WebSocket.OPEN);

    ws.close();
});

test('an anonymous socket is not, even on a broadcast with no price', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const heard = camera(session);

    const ws = await watch(stack.port, session.id);

    talk(ws, speech());
    await settle();

    assert.equal(heard.length, 0);

    ws.close();
});

test('the creator watching their own private broadcast is not', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: creator });

    // They are the camera. Talkback from the creator's browser into the
    // creator's own phone is a feedback loop, not a feature.
    talk(ws, speech());
    await settle();

    assert.equal(heard.length, 0);

    ws.close();
});

test('the floor is lost the moment the turn ends', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    talk(ws, speech());
    await settle();
    assert.equal(heard.length, 1);

    // The room closes but the socket has not noticed yet - which is exactly the
    // window this check exists for, because the room is read per packet.
    stack.rooms.close(room, 'the private turn ended');

    talk(ws, speech());
    await settle();

    assert.equal(heard.length, 1, 'nothing more reaches the camera');

    ws.close();
});

/* ------------------------------------------------------ what gets through -- */

test('the header the camera sees is the server’s, not the viewer’s', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    const payload = speech(8, 4242);
    talk(ws, payload, { flags: 0 });
    await settle();

    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, FRAME_TYPE.AUDIO, 'never the type the viewer asked for');
    assert.equal(heard[0].track, TRACK.TALKBACK);
    assert.ok(heard[0].flags & FLAG.KEYFRAME, 'every PCM packet stands alone, so it says so');
    assert.deepEqual([...heard[0].payload], [...payload], 'the samples themselves are untouched');

    ws.close();
});

test('a video frame dressed up as talkback does not reach the camera', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    ws.send(encodeFrame({ type: FRAME_TYPE.VIDEO, track: TRACK.TALKBACK, payload: speech() }));
    ws.send(encodeFrame({ type: FRAME_TYPE.HELLO, track: TRACK.TALKBACK, payload: speech() }));
    ws.send(encodeFrame({ type: FRAME_TYPE.BYE, track: TRACK.TALKBACK, payload: speech() }));
    await settle();

    assert.equal(heard.length, 0);

    ws.close();
});

test('half a sample is not a sample', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    talk(ws, new Uint8Array(0));
    talk(ws, new Uint8Array(7));
    await settle();

    assert.equal(heard.length, 0);

    ws.close();
});

test('the camera is told the one format there is, in the server’s words', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    // A viewer claiming a sample rate nobody agreed to.
    ws.send(
        encodeJsonFrame(
            FRAME_TYPE.CONFIG,
            { codec: TALKBACK.codec, sampleRate: 96_000, numberOfChannels: 8 },
            { track: TRACK.TALKBACK }
        )
    );
    await settle();

    assert.equal(heard.length, 1);
    assert.equal(heard[0].type, FRAME_TYPE.CONFIG);

    const config = decodeJson(heard[0]);
    assert.deepEqual(config, {
        codec: TALKBACK.codec,
        sampleRate: TALKBACK.sampleRate,
        numberOfChannels: TALKBACK.numberOfChannels
    });

    ws.close();
});

test('a format the protocol does not have is refused rather than forwarded', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    ws.send(encodeJsonFrame(FRAME_TYPE.CONFIG, { codec: 'opus' }, { track: TRACK.TALKBACK }));
    ws.send(encodeFrame({ type: FRAME_TYPE.CONFIG, track: TRACK.TALKBACK, payload: speech() }));
    await settle();

    assert.equal(heard.length, 0);

    ws.close();
});

/* -------------------------------------------------------------- pressure -- */

test('talkback is dropped rather than queued behind the picture', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });

    // The contribution socket is already a long way behind.
    const heard = camera(session, { backlog: 512 * 1024 });

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    for (let i = 0; i < 10; i += 1) talk(ws, speech());
    await settle();

    assert.equal(heard.length, 0, 'the broadcast keeps the socket');

    ws.close();
});

test('a page sending as fast as it can loop runs out of allowance', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const heard = camera(session);

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    // 400 packets is half a minute of speech sent at once: sixteen seconds of
    // allowance in, and the rest on the floor.
    for (let i = 0; i < 400; i += 1) talk(ws, speech());
    await settle();

    assert.ok(heard.length > 0, 'speech still gets through');
    assert.ok(heard.length < 400, `a flood is not relayed whole (${heard.length} of 400)`);
    assert.equal(ws.readyState, WebSocket.OPEN, 'and the socket is left alone');

    ws.close();
});

test('a broadcast with no camera behind it says so rather than swallowing speech', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeUser('creator');
    const viewer = makeUser();
    const session = broadcast(stack.registry, { creatorId: creator.id });

    assert.equal(session.talkbackAvailable, false);
    assert.equal(session.describe().talkback, false, 'and the page is told before it offers a microphone');

    const room = stack.rooms.takeOver(session, { creatorId: creator.id, userId: viewer.id });
    const ws = await watch(stack.port, session.id, { user: viewer, admit: room.admitToken });

    talk(ws, speech());
    await settle();

    assert.equal(ws.readyState, WebSocket.OPEN);

    camera(session);
    assert.equal(session.describe().talkback, true);

    ws.close();
});
