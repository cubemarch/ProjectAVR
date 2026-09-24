import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { WebSocket } from 'ws';

/**
 * Going one to one.
 *
 * The properties that matter are about who is in the room and who is paying:
 * that a broadcast becomes private to exactly one account, that everybody else
 * is disconnected with a code that means stop rather than retry, that the
 * accepted viewer is the only person who can come back and comes back onto the
 * private rate, and that when it ends the broadcast is a public broadcast again
 * with nothing left over.
 *
 * The routes and the sockets are both driven against one server, because half
 * of the behaviour here is an HTTP call causing a WebSocket to close.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-private-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.AVR_LIVE = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';
process.env.AVR_PAYMENTS_PROVIDER = 'stub';

const { app } = await import('../server/index.js');
const { credits, creatorSettings, users } = await import('../server/db/index.js');
const { sessions } = await import('../server/live/sessions.js');
const { rooms } = await import('../server/live/rooms.js');
const { chat } = await import('../server/live/chat.js');
const { billing } = await import('../server/live/billing.js');
const { privateTurns } = await import('../server/live/private.js');
const { LiveRelay } = await import('../server/live/relay.js');
const { issueAccessToken } = await import('../server/auth/tokens.js');
const { FRAME_TYPE, CLOSE_WENT_PRIVATE, CLOSE_PRIVATE_ENDED, decodeFrame, decodeJson } =
    await import('../src/live/protocol.js');

const server = app.listen(0);
await once(server, 'listening');

// The same registries the routes are holding, so an accept over HTTP is felt
// by a socket opened here.
const relay = new LiveRelay({ registry: sessions, rooms, billing, chat, turns: privateTurns });
relay.attach(server);

const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => {
    relay.detach();
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;

function makeUser({ role = 'viewer', balance = 0, name = null } = {}) {
    seq += 1;
    const user = users.create({
        email: `private${seq}@example.test`,
        passwordHash: 'x',
        displayName: name ?? `Person ${seq}`,
        role
    });
    if (balance) credits.post({ userId: user.id, delta: balance, reason: 'purchase' });
    return user;
}

function makeCreator({ public2d = 250, private2d = 900, private3d = 0 } = {}) {
    const user = makeUser({ role: 'creator', name: `Creator ${seq + 1}` });

    creatorSettings.update(user.id, {
        public2dPerMin: public2d,
        public3dPerMin: 0,
        private2dPerMin: private2d,
        private3dPerMin: private3d,
        public3dEnabled: false,
        private3dEnabled: private3d > 0
    });

    return user;
}

function broadcast(creator) {
    return sessions.create({
        name: 'Test broadcast',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        userId: creator?.id ?? null
    });
}

/** An authenticated HTTP caller. */
function as(user) {
    return {
        async fetch(url, options = {}) {
            const token = await issueAccessToken(user);
            const headers = { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) };
            if (options.body) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${url}`, { ...options, headers });
            const text = await res.text();

            return { status: res.status, body: text ? JSON.parse(text) : null };
        },
        post(url, body) {
            return this.fetch(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
        },
        get(url) {
            return this.fetch(url);
        }
    };
}

/** A viewer socket that records what it was sent and how it ended. */
async function watch(sessionId, { user = null, admit = null } = {}) {
    const query = new URLSearchParams();
    if (user) query.set('access_token', await issueAccessToken(user));
    if (admit) query.set('admit', admit);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live/ws/${sessionId}?${query}`);
    ws.binaryType = 'arraybuffer';

    const billed = [];
    const signals = [];

    ws.on('message', (data) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FRAME_TYPE.BILLING) billed.push(decodeJson(frame));
        if (frame.type === FRAME_TYPE.PRIVATE) signals.push(decodeJson(frame));
    });

    const ended = once(ws, 'close');
    const refused = new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));

    const opened = await Promise.race([
        once(ws, 'open').then(() => true),
        refused.then(() => false),
        once(ws, 'error').then(() => false)
    ]);

    return { ws, billed, signals, opened, refused, ended };
}

/** Everything in flight has landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

/** Put the singletons back, since every test in this file shares them. */
function reset(session) {
    session?.close('test over');
    privateTurns.clear();
    billing.clear();
    chat.clear();
}

/* --------------------------------------------------------------- the ask -- */

test('a creator who has not priced a 1:1 is not offering one', async (t) => {
    const creator = makeCreator({ private2d: 0 });
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);

    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, 'private_unavailable');

    // And the player is told before it draws a button nobody can press.
    const quote = await as(viewer).get(`/api/live/watch/${session.id}`);
    assert.equal(quote.body.oneToOne.offered, false);
});

test('a viewer who cannot afford a minute of it cannot ask for it', async (t) => {
    const creator = makeCreator({ private2d: 900 });
    const viewer = makeUser({ balance: 500 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);

    assert.equal(asked.status, 402);
    assert.equal(asked.body.error, 'insufficient_credits');
    assert.equal(privateTurns.pending(session.id).length, 0);
});

test('asking twice is asking once', async (t) => {
    const creator = makeCreator();
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const first = await as(viewer).post(`/api/live/watch/${session.id}/private`);
    const again = await as(viewer).post(`/api/live/watch/${session.id}/private`);

    assert.equal(again.status, 200);
    assert.equal(again.body.request.id, first.body.request.id);
    assert.equal(privateTurns.pending(session.id).length, 1, 'and the creator sees one row, not two');
});

test('the creator sees who is asking, and what it would pay', async (t) => {
    const creator = makeCreator({ private2d: 900 });
    const viewer = makeUser({ balance: 10_000, name: 'Alice' });
    const session = broadcast(creator);
    t.after(() => reset(session));

    await as(viewer).post(`/api/live/watch/${session.id}/private`);
    const list = await as(creator).get(`/api/live/broadcasts/${session.id}/requests`);

    assert.equal(list.status, 200);
    assert.equal(list.body.requests.length, 1);
    assert.equal(list.body.requests[0].name, 'Alice');
    assert.equal(list.body.requests[0].ratePerMin, 900);
    assert.ok(list.body.requests[0].id, 'a handle to answer it with');
    assert.equal(list.body.requests[0].userId, undefined, 'but no account id');
});

test("another creator cannot read or answer somebody else's requests", async (t) => {
    const creator = makeCreator();
    const other = makeCreator();
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);

    assert.equal((await as(other).get(`/api/live/broadcasts/${session.id}/requests`)).status, 404);

    const stolen = await as(other).post(`/api/live/private/${asked.body.request.id}/accept`);
    assert.equal(stolen.status, 404);
    assert.equal(rooms.isPrivate(session), false);
});

/* ------------------------------------------------------------ the answer -- */

test('accepting makes the broadcast private and hands the asker a way back in', async (t) => {
    const creator = makeCreator();
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);
    const taken = await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    assert.equal(taken.status, 200);
    assert.equal(rooms.isPrivate(session), true);
    assert.equal(taken.body.admit, undefined, 'the secret goes to the person it admits, not to the creator');

    const mine = await as(viewer).get(`/api/live/watch/${session.id}/private`);
    assert.equal(mine.body.oneToOne.request.state, 'accepted');
    assert.ok(mine.body.oneToOne.request.admit, 'and they can collect it even if the frame was missed');

    // Gone from the public list, like every other private broadcast.
    const listed = await fetch(`${base}/api/live/sessions`).then((r) => r.json());
    assert.equal(listed.sessions.some((s) => s.sessionId === session.id), false);
});

test('everyone else who was asking is told why not', async (t) => {
    const creator = makeCreator();
    const chosen = makeUser({ balance: 10_000 });
    const other = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const mine = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    const theirs = await as(other).post(`/api/live/watch/${session.id}/private`);

    await as(creator).post(`/api/live/private/${mine.body.request.id}/accept`);

    assert.equal(privateTurns.byId(theirs.body.request.id).state, 'declined');
    assert.equal(privateTurns.byId(theirs.body.request.id).reason, 'someone_else');
    assert.equal(privateTurns.pending(session.id).length, 0);
});

test('a broadcast already in a 1:1 cannot be taken into a second one', async (t) => {
    const creator = makeCreator();
    const first = makeUser({ balance: 10_000 });
    const second = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const a = await as(first).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${a.body.request.id}/accept`);

    // Asked after the broadcast went private, which the asker cannot see.
    const b = await as(second).post(`/api/live/watch/${session.id}/private`);

    assert.equal(b.status, 409);
    assert.equal(b.body.error, 'already_private');
});

test('the balance is checked again at the moment of acceptance', async (t) => {
    const creator = makeCreator({ private2d: 900 });
    const viewer = makeUser({ balance: 1000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);

    // Minutes pass, and they spend it on something else.
    credits.post({ userId: viewer.id, delta: -800, reason: 'adjustment' });

    const taken = await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'viewer_cannot_pay');
    assert.equal(rooms.isPrivate(session), false, 'and the broadcast is left alone');
    assert.equal(privateTurns.byId(asked.body.request.id).reason, 'insufficient_credits');
});

test('declining answers the asker and clears the list', async (t) => {
    const creator = makeCreator();
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);
    const no = await as(creator).post(`/api/live/private/${asked.body.request.id}/decline`);

    assert.equal(no.status, 200);
    assert.equal(privateTurns.byId(asked.body.request.id).state, 'declined');
    assert.equal(rooms.isPrivate(session), false);
});

test('the asker can withdraw the question', async (t) => {
    const creator = makeCreator();
    const viewer = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(viewer).post(`/api/live/watch/${session.id}/private`);
    await as(viewer).post(`/api/live/private/${asked.body.request.id}/cancel`);

    assert.equal(privateTurns.pending(session.id).length, 0);

    // And it cannot then be accepted out from under them.
    const late = await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);
    assert.equal(late.status, 404);
});

/* --------------------------------------------------------- over the wire -- */

test('acceptance empties the room, with a code that means stop rather than retry', async (t) => {
    const creator = makeCreator({ public2d: 250, private2d: 900 });
    const chosen = makeUser({ balance: 10_000 });
    const bystander = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const a = await watch(session.id, { user: chosen });
    const b = await watch(session.id, { user: bystander });

    assert.equal(a.opened, true);
    assert.equal(b.opened, true);

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    const [[codeA], [codeB]] = await Promise.all([a.ended, b.ended]);

    assert.equal(codeA, CLOSE_WENT_PRIVATE);
    assert.equal(codeB, CLOSE_WENT_PRIVATE);
    assert.equal(session.subscribers.size, 0);
    assert.equal(session.live, true, 'the camera is still rolling; only the audience changed');
});

test('the acceptance reaches the asker before their socket goes', async (t) => {
    const creator = makeCreator();
    const chosen = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const a = await watch(session.id, { user: chosen });

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);
    await a.ended;

    const accepted = a.signals.find((s) => s.event === 'accepted');

    assert.ok(accepted, 'told on the socket, not left to find out by polling');
    assert.ok(accepted.admit);
});

test('the creator is asked on the socket they are watching their own broadcast on', async (t) => {
    const creator = makeCreator();
    const viewer = makeUser({ balance: 10_000, name: 'Alice' });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const studio = await watch(session.id, { user: creator });
    assert.equal(studio.opened, true, 'and watching their own broadcast is free');

    await as(viewer).post(`/api/live/watch/${session.id}/private`);
    await settle();

    const asking = studio.signals.find((s) => s.event === 'requested');

    assert.ok(asking);
    assert.equal(asking.name, 'Alice');

    studio.ws.close();
});

test('only the admitted viewer can come back, and at the private rate', async (t) => {
    const creator = makeCreator({ public2d: 250, private2d: 900 });
    const chosen = makeUser({ balance: 10_000 });
    const bystander = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    const admit = (await as(chosen).get(`/api/live/watch/${session.id}/private`)).body.oneToOne.request.admit;

    const shut_out = await watch(session.id, { user: bystander });
    assert.equal(shut_out.opened, false);
    assert.equal(await shut_out.refused, 404, 'and a 404, so a guess is not confirmed');

    const before = credits.balance(chosen.id);
    const back = await watch(session.id, { user: chosen, admit });

    assert.equal(back.opened, true);
    await settle();

    assert.equal(back.billed[0].ratePerMin, 900);
    assert.equal(credits.balance(chosen.id), before - 900, 'the private minute, at the private price');

    back.ws.close();
});

test('a free public stream with a priced 1:1 still bills the private minute', async (t) => {
    // The give-away shape: watch for nothing, pay to be alone. Whether a socket
    // is free has to be asked about the side of the product it is on.
    const creator = makeCreator({ public2d: 0, private2d: 900 });
    const chosen = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const free = await watch(session.id, { user: chosen });
    assert.equal(free.opened, true);
    await settle();
    assert.equal(free.billed.length, 0, 'nothing charged for the public stream');

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);
    await free.ended;

    const admit = (await as(chosen).get(`/api/live/watch/${session.id}/private`)).body.oneToOne.request.admit;
    const before = credits.balance(chosen.id);
    const back = await watch(session.id, { user: chosen, admit });

    assert.equal(back.opened, true);
    await settle();

    assert.equal(back.billed[0]?.ratePerMin, 900);
    assert.equal(credits.balance(chosen.id), before - 900);

    back.ws.close();
});

test('the creator can watch their own private broadcast without holding the secret', async (t) => {
    const creator = makeCreator();
    const chosen = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    // They are the source of the picture. Shutting the broadcaster out of their
    // own broadcast protects nobody, and a 1:1 needs them in the room.
    const studio = await watch(session.id, { user: creator });

    assert.equal(studio.opened, true);
    studio.ws.close();
});

test('ending the turn puts the broadcast back the way it was', async (t) => {
    const creator = makeCreator();
    const chosen = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    const admit = (await as(chosen).get(`/api/live/watch/${session.id}/private`)).body.oneToOne.request.admit;
    const back = await watch(session.id, { user: chosen, admit });

    const ended = await as(chosen).post(`/api/live/watch/${session.id}/private/end`);

    assert.equal(ended.status, 200, 'either of them may end it');

    const [code] = await back.ended;
    assert.equal(code, CLOSE_PRIVATE_ENDED, 'and the page is told not to reconnect into a paid public stream');

    assert.equal(rooms.isPrivate(session), false);

    const listed = await fetch(`${base}/api/live/sessions`).then((r) => r.json());
    assert.equal(listed.sessions.some((s) => s.sessionId === session.id), true, 'public again');
});

test('a stranger cannot end somebody else\'s 1:1', async (t) => {
    const creator = makeCreator();
    const chosen = makeUser({ balance: 10_000 });
    const stranger = makeUser({ balance: 10_000 });
    const session = broadcast(creator);
    t.after(() => reset(session));

    const asked = await as(chosen).post(`/api/live/watch/${session.id}/private`);
    await as(creator).post(`/api/live/private/${asked.body.request.id}/accept`);

    const meddling = await as(stranger).post(`/api/live/watch/${session.id}/private/end`);

    assert.equal(meddling.status, 403);
    assert.equal(rooms.isPrivate(session), true);
});
