import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { WebSocket } from 'ws';

/**
 * The room that comes with a broadcast.
 *
 * Two things are being checked here and they are not the same thing. The
 * registry tests cover the rules of the room - who may speak, how fast, and
 * what a message is allowed to contain. The relay tests cover the fact that
 * chat is the first thing a viewer has ever been allowed to *send*, which means
 * the fan-out socket now has a parser on it and the parser is the new attack
 * surface: it must ignore everything that is not a chat line and must never
 * take a name from the payload.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-chat-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.AVR_LIVE = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';

const { users } = await import('../server/db/index.js');
const { ChatRegistry, MAX_TEXT } = await import('../server/live/chat.js');
const { BillingRegistry } = await import('../server/live/billing.js');
const { PrivateTurns } = await import('../server/live/private.js');
const { SessionRegistry } = await import('../server/live/sessions.js');
const { RoomRegistry } = await import('../server/live/rooms.js');
const { LiveRelay } = await import('../server/live/relay.js');
const { issueAccessToken } = await import('../server/auth/tokens.js');
const { FRAME_TYPE, encodeJsonFrame, encodeFrame, decodeFrame, decodeJson } =
    await import('../src/live/protocol.js');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;

function makeUser(role = 'viewer', name = null) {
    seq += 1;
    return users.create({
        email: `chat${seq}@example.test`,
        passwordHash: 'x',
        displayName: name ?? `Person ${seq}`,
        role
    });
}

/** A participant that records what it was told. */
function listener() {
    const heard = [];
    return { heard, notify: (message) => heard.push(message) };
}

/* ------------------------------------------------------------- the room -- */

test('joining a broadcast joins its room, with what has been said so far', () => {
    const chat = new ChatRegistry();

    const first = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: first.notify });
    chat.post('ABC123', alice, 'is this thing on');

    // Somebody arriving into a conversation already in progress.
    const second = listener();
    chat.join('ABC123', { userId: 'u2', name: 'Bob', role: 'viewer', notify: second.notify });

    assert.equal(second.heard.length, 1);
    assert.equal(second.heard[0].text, 'is this thing on');
    assert.equal(second.heard[0].history, true, 'and marked as backlog rather than as news');
});

test('a message carries the name on the socket, not one supplied with it', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    const posted = chat.post('ABC123', alice, 'hello');

    assert.equal(posted.ok, true);
    assert.equal(posted.message.name, 'Alice');
    assert.equal(posted.message.role, 'viewer');
});

test('the creator is marked as the host of their own room', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const host = chat.join('ABC123', {
        userId: 'creator-1',
        name: 'Ada',
        role: 'creator',
        host: true,
        notify: heard.notify
    });

    assert.equal(chat.post('ABC123', host, 'evening').message.host, true);
});

test('everyone in the room hears it, once', () => {
    const chat = new ChatRegistry();
    const a = listener();
    const b = listener();

    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: a.notify });
    chat.join('ABC123', { userId: 'u2', name: 'Bob', role: 'viewer', notify: b.notify });

    chat.post('ABC123', alice, 'hello');

    assert.equal(a.heard.length, 1, 'including the person who said it');
    assert.equal(b.heard.length, 1);
    assert.equal(b.heard[0].text, 'hello');
});

test('a room for one broadcast is not a room for another', () => {
    const chat = new ChatRegistry();
    const a = listener();
    const b = listener();

    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: a.notify });
    chat.join('ZZZ999', { userId: 'u2', name: 'Bob', role: 'viewer', notify: b.notify });

    chat.post('ABC123', alice, 'hello');

    assert.equal(b.heard.length, 0);
});

test('whitespace is not a message', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    assert.equal(chat.post('ABC123', alice, '   \n\n  ').reason, 'empty');
    assert.equal(heard.heard.length, 0);
});

test('a wall of newlines is collapsed rather than delivered', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    // Forty blank lines is a way of pushing everybody else's messages off the
    // screen, which is a moderation problem solved cheaply in the parser.
    chat.post('ABC123', alice, 'hi\n\n\n\n\n\n\n\n\n\nthere');

    assert.equal(heard.heard[0].text, 'hi there');
});

test('a message longer than the limit is refused whole', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    const refused = chat.post('ABC123', alice, 'x'.repeat(MAX_TEXT + 1));

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'too_long');
    assert.equal(heard.heard.length, 0, 'not truncated and sent - a half message is a misquote');
});

test('a burst is allowed, a flood is not', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    for (let i = 0; i < 5; i += 1) {
        assert.equal(chat.post('ABC123', alice, `line ${i}`).ok, true, `message ${i} is within the burst`);
    }

    const refused = chat.post('ABC123', alice, 'one too many');

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'rate_limited');
    assert.equal(heard.heard.length, 5);
});

test('somebody who has left the room cannot speak into it', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    chat.leave('ABC123', alice);

    assert.equal(chat.post('ABC123', alice, 'still here').reason, 'not_in_room');
});

test('an empty room is not kept', () => {
    const chat = new ChatRegistry();
    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: () => {} });

    assert.equal(chat.size, 1);
    chat.leave('ABC123', alice);
    assert.equal(chat.size, 0);
});

test('an announcement has no name on it, so a page can tell it apart from speech', () => {
    const chat = new ChatRegistry();
    const heard = listener();
    chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: heard.notify });

    chat.announce('ABC123', 'the broadcast has gone private');

    assert.equal(heard.heard[0].system, true);
    assert.equal(heard.heard[0].name, undefined);
});

test('a notice reaches one person and is not remembered', () => {
    const chat = new ChatRegistry();
    const a = listener();
    const b = listener();

    const alice = chat.join('ABC123', { userId: 'u1', name: 'Alice', role: 'viewer', notify: a.notify });
    chat.join('ABC123', { userId: 'u2', name: 'Bob', role: 'viewer', notify: b.notify });

    chat.notice(alice, 'slow down');

    assert.equal(a.heard.length, 1);
    assert.equal(b.heard.length, 0);

    // And it is not in the backlog the next arrival is given.
    const c = listener();
    chat.join('ABC123', { userId: 'u3', name: 'Cass', role: 'viewer', notify: c.notify });
    assert.equal(c.heard.length, 0);
});

/* -------------------------------------------------------- over the relay -- */

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
        chat,
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

/** An unattributed broadcast, so watching is free and chat is the only variable. */
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

/** Open a viewer socket and collect the chat lines it is sent. */
async function watch(port, sessionId, token = null) {
    const query = token ? `?access_token=${token}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live/ws/${sessionId}${query}`);
    ws.binaryType = 'arraybuffer';

    const said = [];
    ws.on('message', (data) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FRAME_TYPE.CHAT) said.push(decodeJson(frame));
    });

    await once(ws, 'open');

    return {
        ws,
        said,
        say(text) {
            ws.send(encodeJsonFrame(FRAME_TYPE.CHAT, { text }), { binary: true });
        },
        /** Let anything in flight arrive. */
        settle: () => new Promise((resolve) => setTimeout(resolve, 60))
    };
}

test('a line typed on one socket arrives on the other', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const alice = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Alice')));
    const bob = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Bob')));

    alice.say('evening');
    await bob.settle();

    assert.equal(bob.said.length, 1);
    assert.equal(bob.said[0].text, 'evening');
    assert.equal(bob.said[0].name, 'Alice');

    alice.ws.close();
    bob.ws.close();
});

test('an anonymous socket can watch what is free and still cannot speak', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const bob = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Bob')));
    const stranger = await watch(stack.port, session.id);

    stranger.say('hello');
    await bob.settle();

    assert.equal(bob.said.length, 0, 'there is no name to put on it');
    assert.equal(stranger.ws.readyState, 1, 'and trying is not grounds for a disconnection');

    bob.ws.close();
    stranger.ws.close();
});

test('the relay ignores every upstream frame that is not a chat line', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const alice = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Alice')));
    const bob = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Bob')));

    // A viewer pretending to be a camera. Nothing is published, nothing is
    // relayed, and the socket stays up: a probe learns nothing either way.
    alice.ws.send(encodeFrame({ type: FRAME_TYPE.VIDEO, track: 0, payload: new Uint8Array([1, 2, 3]) }), {
        binary: true
    });
    alice.ws.send(encodeJsonFrame(FRAME_TYPE.HELLO, { name: 'not a phone' }), { binary: true });
    alice.ws.send('{"text":"as plain text"}');
    alice.ws.send(new Uint8Array([9, 9]), { binary: true }); // Not a frame at all.

    await bob.settle();

    assert.equal(bob.said.length, 0);
    assert.equal(alice.ws.readyState, 1);
    assert.equal(session.stats.size, 0, 'and a viewer cannot inject a track into the broadcast');

    alice.ws.close();
    bob.ws.close();
});

test('going too fast is answered privately rather than in silence', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const alice = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Alice')));
    const bob = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Bob')));

    for (let i = 0; i < 8; i += 1) alice.say(`line ${i}`);
    await alice.settle();

    const notices = alice.said.filter((m) => m.system);

    assert.equal(alice.said.filter((m) => !m.system).length, 5, 'the burst got through and the rest did not');
    assert.ok(notices.length >= 1, 'and the sender was told why');
    assert.equal(bob.said.filter((m) => m.system).length, 0, 'while nobody else saw the telling off');

    alice.ws.close();
    bob.ws.close();
});

test('leaving the broadcast leaves the room', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const session = broadcast(stack.registry);
    const alice = await watch(stack.port, session.id, await issueAccessToken(makeUser('viewer', 'Alice')));

    assert.equal(stack.chat.roster(session.id).length, 1);

    alice.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(stack.chat.size, 0);
});
