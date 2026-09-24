import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { WebSocket } from 'ws';

/**
 * Per-minute billing.
 *
 * The properties here are the ones that decide whether a viewer trusts the
 * number on their statement: a minute is charged once and only once, a
 * reconnect inside a minute already paid for is free, two tabs are one bill,
 * the money that leaves a viewer arrives at a creator, and a viewer who runs
 * out is disconnected rather than allowed to run up a debt nobody can collect.
 *
 * The last test in the file re-asserts the ledger invariant from
 * `credits.test.js` against everything this file did: forty minutes of
 * transfers must still sum to exactly what was purchased.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-billing-'));

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

const { credits, creatorSettings, users } = await import('../server/db/index.js');
const { BillingRegistry, ratesFor } = await import('../server/live/billing.js');
const { SessionRegistry } = await import('../server/live/sessions.js');
const { RoomRegistry } = await import('../server/live/rooms.js');
const { LiveRelay } = await import('../server/live/relay.js');
const { issueAccessToken } = await import('../server/auth/tokens.js');
const { CLOSE_OUT_OF_CREDITS, FRAME_TYPE, decodeFrame, decodeJson } =
    await import('../src/live/protocol.js');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;

function makeUser(role = 'viewer') {
    seq += 1;
    return users.create({
        email: `billing${seq}@example.test`,
        passwordHash: 'x',
        displayName: `Person ${seq}`,
        role
    });
}

/** A viewer with money in the account. */
function makeViewer(balance = 10_000) {
    const user = makeUser('viewer');
    if (balance) credits.post({ userId: user.id, delta: balance, reason: 'purchase' });
    return user;
}

/** A creator charging the given rates, in credits per minute. */
function makeCreator({ public2d = 250, public3d = 500, private2d = 0, private3d = 0, enable3d = true } = {}) {
    const user = makeUser('creator');

    creatorSettings.update(user.id, {
        public2dPerMin: public2d,
        public3dPerMin: public3d,
        private2dPerMin: private2d,
        private3dPerMin: private3d,
        public3dEnabled: enable3d,
        private3dEnabled: enable3d
    });

    return user;
}

/** A broadcast as the ingest path would create it, minus the socket. */
function broadcast(sessions, { creatorId = null, stereo = 'sbs' } = {}) {
    return sessions.create({
        name: 'Test broadcast',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo,
        userId: creatorId
    });
}

/** What the relay gives a meter: somewhere to send statements and a way to close. */
function handle() {
    return {
        sent: [],
        closed: null,
        notify(payload) {
            this.sent.push(payload);
        },
        close(code, reason) {
            this.closed = { code, reason };
        }
    };
}

/** A registry with a very short minute, so a test is not an hour long. */
function stack(minuteMs = 10_000) {
    return { sessions: new SessionRegistry(), billing: new BillingRegistry({ minuteMs }) };
}

const lastOf = (h) => h.sent.at(-1);

/* ------------------------------------------------------------ what is free -- */

test('a broadcast with no creator behind it is free', () => {
    const { sessions, billing } = stack();
    const session = broadcast(sessions);

    assert.equal(billing.isFree(session, { viewerId: makeViewer().id }), true);
});

test('a creator watching their own broadcast is not charged for looking at themselves', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator();
    const session = broadcast(sessions, { creatorId: creator.id });

    assert.equal(billing.isFree(session, { viewerId: creator.id }), true);
});

test('a creator who has set no price is giving it away', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 0, public3d: 0, enable3d: false });
    const session = broadcast(sessions, { creatorId: creator.id });

    assert.equal(billing.isFree(session, { viewerId: makeViewer().id }), true);
});

/* ----------------------------------------------------------------- rates -- */

test('the rate depends on the side of the product and the mode', () => {
    const { sessions } = stack();
    const creator = makeCreator({ public2d: 100, public3d: 200, private2d: 800, private3d: 1600 });
    const session = broadcast(sessions, { creatorId: creator.id });

    const open = ratesFor(session, { isPrivate: false });
    assert.equal(open['2d'].perMin, 100);
    assert.equal(open['3d'].perMin, 200);

    const oneToOne = ratesFor(session, { isPrivate: true });
    assert.equal(oneToOne['2d'].perMin, 800);
    assert.equal(oneToOne['3d'].perMin, 1600);
});

test('3D is unavailable on a broadcast sending one eye, whatever the creator switched on', () => {
    const { sessions } = stack();
    const creator = makeCreator({ enable3d: true });
    const flat = broadcast(sessions, { creatorId: creator.id, stereo: 'mono' });

    assert.equal(ratesFor(flat, { isPrivate: false })['3d'].available, false);
    assert.equal(ratesFor(flat, { isPrivate: false })['2d'].available, true);
});

test('3D is unavailable when the creator has not switched it on for this side', () => {
    const { sessions } = stack();
    const creator = makeCreator({ enable3d: false });
    const session = broadcast(sessions, { creatorId: creator.id });

    assert.equal(ratesFor(session, { isPrivate: false })['3d'].available, false);
});

/* --------------------------------------------------------- the first minute -- */

test('attaching charges the first minute before a frame is delivered', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const h = handle();
    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: h });

    assert.equal(ticket.ok, true);
    assert.equal(ticket.events[0].event, 'charged');
    assert.equal(ticket.events[0].minute, 1);
    assert.equal(ticket.events[0].ratePerMin, 250);
    assert.equal(credits.balance(viewer.id), 750);
    assert.equal(credits.balance(creator.id), 250);
});

test('the charge is a transfer: what the viewer lost the creator gained, on one reference', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 300 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });

    const [debit] = credits.history(viewer.id);
    const [earn] = credits.history(creator.id);

    assert.equal(debit.delta, -300);
    assert.equal(debit.reason, 'watch');
    assert.equal(earn.delta, 300);
    assert.equal(earn.reason, 'earn');
    assert.equal(debit.ref_id, earn.ref_id, 'the two halves name the same minute');
    assert.equal(debit.ref_type, 'live_minute');
});

test('a viewer who cannot afford the first minute is refused and nothing is written', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 500 });
    const viewer = makeViewer(100);
    const session = broadcast(sessions, { creatorId: creator.id });

    const refused = billing.attach({
        session,
        viewerId: viewer.id,
        isPrivate: false,
        mode: '2d',
        handle: handle()
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'insufficient_credits');
    assert.equal(credits.balance(viewer.id), 100, 'the refusal cost them nothing');
    assert.equal(credits.balance(creator.id), 0);
    assert.equal(billing.size, 0, 'and left no meter behind');
});

test('a free broadcast attaches with no meter and no ledger entry', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 0, public3d: 0, enable3d: false });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });

    assert.equal(ticket.ok, true);
    assert.equal(ticket.meter, null);
    assert.equal(credits.balance(viewer.id), 1000);
    assert.equal(credits.history(viewer.id).length, 1, 'only the purchase');
});

/* ------------------------------------------------------------ minutes after -- */

test('every started minute is charged, once', async () => {
    const { sessions, billing } = stack(40);
    const creator = makeCreator({ public2d: 100 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const h = handle();
    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: h });

    await new Promise((resolve) => setTimeout(resolve, 100));
    billing.detach(ticket.meter, h);

    const minutes = (1000 - credits.balance(viewer.id)) / 100;
    assert.ok(minutes >= 2, `expected at least two minutes, charged ${minutes}`);
    assert.equal(credits.balance(creator.id), minutes * 100, 'the creator was paid for each of them');

    // One debit per minute and no repeats: the ledger is the record, so the
    // count of rows has to match the count of minutes exactly.
    const debits = credits.history(viewer.id).filter((row) => row.reason === 'watch');
    assert.equal(debits.length, minutes);
    assert.equal(new Set(debits.map((row) => row.ref_id)).size, minutes);
});

test('a second tab joins the meter that already exists rather than starting a second one', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 200 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const first = handle();
    const second = handle();

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: first });
    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: second });

    assert.equal(credits.balance(viewer.id), 800, 'one person watching one stream is one bill');
    assert.equal(billing.size, 1);
});

test('the meter stops when the last socket goes, not the first', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 200 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const first = handle();
    const second = handle();

    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: first });
    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: second });

    billing.detach(ticket.meter, first);
    assert.equal(billing.size, 1, 'still watching on the other tab');

    billing.detach(ticket.meter, second);
    assert.equal(billing.size, 0);
});

test('rejoining a minute already paid for does not pay for it twice', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const first = handle();
    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: first });
    billing.detach(ticket.meter, first);

    assert.equal(credits.balance(viewer.id), 750);

    // A dropped socket coming straight back. The idempotency key is the
    // session, the viewer and the minute number, so this finds minute one
    // already written.
    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });

    assert.equal(credits.balance(viewer.id), 750, 'a reconnect is not a second minute');
    assert.equal(credits.history(viewer.id).filter((r) => r.reason === 'watch').length, 1);
});

test('reconnecting after the paid minute has run out pays for the next one', async () => {
    const { sessions, billing } = stack(60);
    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(1000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const first = handle();
    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: first });
    billing.detach(ticket.meter, first);

    // Past the end of the minute that was bought. The minute a charge is keyed
    // on is read off the clock, not counted on the meter, so this is a minute
    // nobody has paid for rather than a replay of minute one. Counting would
    // have made a reconnect loop into free viewing.
    await new Promise((resolve) => setTimeout(resolve, 90));

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });

    assert.equal(credits.balance(viewer.id), 500);
    assert.equal(credits.history(viewer.id).filter((r) => r.reason === 'watch').length, 2);
});

test('a private turn is billed apart from the public minutes already paid for', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 250, private2d: 800 });
    const viewer = makeViewer(2000);
    const session = broadcast(sessions, { creatorId: creator.id });

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });
    assert.equal(credits.balance(viewer.id), 1750);

    // The same broadcast and the same viewer, so only the scope in the key
    // stands between the private rate and a minute that silently replays a
    // public one and costs nothing.
    const going = billing.attach({ session, viewerId: viewer.id, isPrivate: true, mode: '2d', handle: handle() });

    assert.equal(going.ok, true);
    assert.equal(credits.balance(viewer.id), 950, 'the private minute was charged at the private rate');
    assert.equal(going.meter.scope, 'private');
    assert.equal(billing.meterFor(session.id, viewer.id), going.meter, 'and the private meter is the live one');
});

/* ------------------------------------------------------------ running out -- */

test('running out disconnects the viewer and says why', async () => {
    const { sessions, billing } = stack(30);
    const creator = makeCreator({ public2d: 400 });
    const viewer = makeViewer(500);
    const session = broadcast(sessions, { creatorId: creator.id });

    const h = handle();
    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: h });

    // 500 buys the first minute and not the second.
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(h.closed?.code, CLOSE_OUT_OF_CREDITS);
    assert.ok(h.sent.some((m) => m.event === 'exhausted'));
    assert.equal(credits.balance(viewer.id), 100, 'the minute they could not afford was not charged');
    assert.equal(billing.size, 0);
});

test('the warning arrives a minute before the disconnection, not with it', async () => {
    const { sessions, billing } = stack(30);
    const creator = makeCreator({ public2d: 400 });
    const viewer = makeViewer(900);
    const session = broadcast(sessions, { creatorId: creator.id });

    const h = handle();
    const ticket = billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: h });

    // 900 buys two minutes. The first leaves 500, which covers another; the
    // second leaves 100, which does not, and that is the one that warns.
    assert.equal(
        ticket.events.some((m) => m.event === 'low_balance'),
        false,
        'no warning while there is still a minute in hand'
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const warned = h.sent.findIndex((m) => m.event === 'low_balance');
    const ended = h.sent.findIndex((m) => m.event === 'exhausted');

    assert.ok(warned >= 0, 'a viewer about to be cut off is told first');
    assert.ok(ended > warned, 'and the warning is a minute ahead of the disconnection');
});

test('a viewer who can only afford the first minute is warned on the way in', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 400 });
    const viewer = makeViewer(500);
    const session = broadcast(sessions, { creatorId: creator.id });

    const ticket = billing.attach({
        session,
        viewerId: viewer.id,
        isPrivate: false,
        mode: '2d',
        handle: handle()
    });

    assert.deepEqual(
        ticket.events.map((m) => m.event),
        ['charged', 'low_balance'],
        'sixty seconds of warning is all this design has to give, so it gives it immediately'
    );
});

/* ----------------------------------------------------------- switching mode -- */

test('switching mode re-prices the next minute and not the one already paid for', async () => {
    const { sessions, billing } = stack(40);
    const creator = makeCreator({ public2d: 100, public3d: 300 });
    const viewer = makeViewer(5000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const h = handle();
    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: h });
    assert.equal(credits.balance(viewer.id), 4900);

    const changed = billing.setMode(session.id, viewer.id, '3d');
    assert.equal(changed.ok, true);
    assert.equal(changed.ratePerMin, 300);
    assert.equal(credits.balance(viewer.id), 4900, 'the minute in progress is not re-priced');

    await new Promise((resolve) => setTimeout(resolve, 60));

    const statement = lastOf(h);
    assert.equal(statement.mode, '3d');
    assert.equal(statement.ratePerMin, 300);
});

test('a viewer cannot switch to a mode the broadcast is not offering', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 100, public3d: 300, enable3d: false });
    const viewer = makeViewer(5000);
    const session = broadcast(sessions, { creatorId: creator.id });

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '2d', handle: handle() });

    const refused = billing.setMode(session.id, viewer.id, '3d');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'mode_unavailable');
});

test('joining in 3D is billed at the 3D rate from the first minute', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 100, public3d: 300 });
    const viewer = makeViewer(5000);
    const session = broadcast(sessions, { creatorId: creator.id });

    billing.attach({ session, viewerId: viewer.id, isPrivate: false, mode: '3d', handle: handle() });

    assert.equal(credits.balance(viewer.id), 4700);
});

test('somebody not watching cannot change a mode', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator();
    const session = broadcast(sessions, { creatorId: creator.id });

    const refused = billing.setMode(session.id, makeViewer().id, '3d');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not_watching');
});

/* ---------------------------------------------------------------- quoting -- */

test('the quote says what both modes cost before anything is charged', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 150, public3d: 450 });
    const viewer = makeViewer(2000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const quote = billing.quote(session, { viewerId: viewer.id, isPrivate: false });

    assert.equal(quote.free, false);
    assert.equal(quote.modes['2d'].perMin, 150);
    assert.equal(quote.modes['3d'].perMin, 450);
    assert.equal(quote.balance, 2000);
    assert.equal(quote.attached, false);
    assert.equal(credits.balance(viewer.id), 2000, 'asking the price does not cost anything');
});

test('a private broadcast quotes the private rate', () => {
    const { sessions, billing } = stack();
    const creator = makeCreator({ public2d: 150, private2d: 900 });
    const viewer = makeViewer(2000);
    const session = broadcast(sessions, { creatorId: creator.id });

    const quote = billing.quote(session, { viewerId: viewer.id, isPrivate: true });

    assert.equal(quote.private, true);
    assert.equal(quote.modes['2d'].perMin, 900);
});

/* ------------------------------------------------------- through the relay -- */

/**
 * The paying half of the relay, over a real WebSocket.
 *
 * Worth doing over the socket rather than against the registry, because the
 * rules being checked are properties of the upgrade: an anonymous socket cannot
 * open a priced broadcast, a broke one cannot either, and the one that can is
 * told what it is paying before the first frame.
 */
async function relayStack(minuteMs = 60_000) {
    const registry = new SessionRegistry();
    const rooms = new RoomRegistry({ sessions: registry });
    const billing = new BillingRegistry({ minuteMs });

    const httpServer = http.createServer((req, res) => res.end('ok'));
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const relay = new LiveRelay({ registry, rooms, billing });
    relay.attach(httpServer);

    return {
        registry,
        billing,
        port: httpServer.address().port,
        async stop() {
            billing.clear();
            registry.closeAll('test over');
            rooms.detach();
            relay.detach();
            httpServer.close();
            await once(httpServer, 'close').catch(() => {});
        }
    };
}

/** Resolves to the close code if the upgrade is refused, or null if it opens. */
function tryWatch(port, sessionId, query = '') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live/ws/${sessionId}${query}`);
    ws.binaryType = 'arraybuffer';

    return new Promise((resolve) => {
        const frames = [];
        ws.on('message', (data) => frames.push(decodeFrame(new Uint8Array(data))));
        ws.on('open', () => setTimeout(() => resolve({ opened: true, frames, ws }), 60));
        ws.on('unexpected-response', (_req, res) => resolve({ opened: false, status: res.statusCode }));
        ws.on('error', () => resolve({ opened: false, status: null }));
    });
}

test('an anonymous socket cannot open a broadcast that charges', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeCreator({ public2d: 250 });
    const session = broadcast(stack.registry, { creatorId: creator.id });

    const attempt = await tryWatch(stack.port, session.id);

    assert.equal(attempt.opened, false);
    assert.equal(attempt.status, 401, 'anonymous viewing of a priced broadcast is refused, not given away');
    assert.equal(stack.billing.size, 0);
});

test('an anonymous socket can still open a free broadcast', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    // No creator account behind it: the shared stream key, which is every
    // deployment that has never charged for anything.
    const session = broadcast(stack.registry);
    const attempt = await tryWatch(stack.port, session.id);

    assert.equal(attempt.opened, true, 'nothing about billing changed what was already free');
    attempt.ws.close();
});

test('a viewer with no credits is refused with 402 and is not connected', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(0);
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const token = await issueAccessToken(viewer);

    const attempt = await tryWatch(stack.port, session.id, `?access_token=${token}`);

    assert.equal(attempt.opened, false);
    assert.equal(attempt.status, 402);
    assert.equal(session.subscribers.size, 0, 'and no frames were ever sent to them');
});

test('a paying viewer is told the rate before the first frame', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(1000);
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const token = await issueAccessToken(viewer);

    const attempt = await tryWatch(stack.port, session.id, `?access_token=${token}`);
    assert.equal(attempt.opened, true);

    const billed = attempt.frames.filter((f) => f.type === FRAME_TYPE.BILLING).map(decodeJson);

    assert.equal(billed.length, 1);
    assert.equal(billed[0].event, 'charged');
    assert.equal(billed[0].ratePerMin, 250);
    assert.equal(billed[0].balance, 750);
    assert.equal(credits.balance(viewer.id), 750);

    // And the BILLING frame arrived before the session's own READY, because it
    // is sent on the way in rather than by the session's subscriber machinery.
    assert.equal(attempt.frames[0].type, FRAME_TYPE.BILLING);

    attempt.ws.close();
});

test('leaving stops the meter', async (t) => {
    const stack = await relayStack();
    t.after(() => stack.stop());

    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(1000);
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const token = await issueAccessToken(viewer);

    const attempt = await tryWatch(stack.port, session.id, `?access_token=${token}`);
    assert.equal(stack.billing.size, 1);

    attempt.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(stack.billing.size, 0);
});

test('running out of credits mid-watch closes the socket with 4402', async (t) => {
    const stack = await relayStack(250); // A "minute" of 250ms.
    t.after(() => stack.stop());

    const creator = makeCreator({ public2d: 250 });
    const viewer = makeViewer(500); // Two minutes, and then nothing.
    const session = broadcast(stack.registry, { creatorId: creator.id });
    const token = await issueAccessToken(viewer);

    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/live/ws/${session.id}?access_token=${token}`);
    ws.binaryType = 'arraybuffer';

    const billed = [];
    ws.on('message', (data) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FRAME_TYPE.BILLING) billed.push(decodeJson(frame));
    });

    const [code] = await once(ws, 'close');

    assert.equal(code, CLOSE_OUT_OF_CREDITS);
    assert.equal(credits.balance(viewer.id), 0, 'both affordable minutes were taken, and no third');
    assert.deepEqual(
        billed.map((b) => b.event),
        ['charged', 'charged', 'low_balance', 'exhausted'],
        'and the viewer was warned before the picture stopped'
    );
});

/* ------------------------------------------------------------ the invariant -- */

test('after every minute billed here, the ledger still adds up', () => {
    const { ledgerSum, balanceSum, purchased, adjusted } = credits.audit();

    assert.equal(ledgerSum, purchased + adjusted, 'billing invented nothing');
    assert.equal(balanceSum, ledgerSum, 'the cached balances agree with the rows behind them');
});
