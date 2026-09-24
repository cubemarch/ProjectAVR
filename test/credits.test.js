import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Credits: the ledger, buying them, and the profile settings that spend them.
 *
 * The properties worth holding are accounting ones, and they are the kind that
 * only ever fail in production: that credits cannot be created except by a
 * purchase, that a retried request creates them once, that a transfer moves the
 * same number out of one account as it moves into another, and that the sum of
 * every row in the ledger equals everything ever bought. The last one is
 * asserted at the end against everything the whole file did.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-credits-'));

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
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { credits, creatorSettings, profiles, users } = await import('../server/db/index.js');
const { readiness } = await import('../server/live/readiness.js');
const { sessions } = await import('../server/live/sessions.js');
const { TRACK, FLAG } = await import('../src/live/protocol.js');
const { validateAmount, CREDIT_TIERS, CUSTOM_MIN_CENTS } = await import('../server/credits/providers.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let accountSeq = 0;

function makeAgent() {
    const jar = new Map();

    return {
        token: null,
        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });

            for (const raw of res.headers.getSetCookie?.() ?? []) {
                const [pair] = raw.split(';');
                const idx = pair.indexOf('=');
                jar.set(pair.slice(0, idx), pair.slice(idx + 1));
            }

            const text = await res.text();
            let body = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }

            return { status: res.status, body };
        },

        async register(role = 'viewer') {
            accountSeq += 1;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: `credits${accountSeq}@example.test`,
                    password: 'correcthorsebattery',
                    displayName: `Person ${accountSeq}`,
                    role,
                    tagline: 'On air nightly',
                    acceptedTerms: TERMS_VERSION,
                    acceptedCreatorTerms: CREATOR_TERMS_VERSION
                })
            });
            this.token = res.body?.accessToken ?? null;
            this.id = res.body?.user?.id ?? null;
            return res;
        }
    };
}

/**
 * A broadcast, as far as the setup checks are concerned.
 *
 * They now refuse a confirmation with nothing running, and the 3D one refuses
 * unless two eyes have actually produced frames - so every test that passes a
 * check needs a camera to be pretending to be connected.
 */
function goLive(creatorId, { stereo = false } = {}) {
    const session = sessions.create({
        userId: creatorId,
        name: 'Test broadcast',
        mode: 'separate',
        stereo: stereo ? 'sbs' : 'mono'
    });

    const eye = (track) => {
        session.setConfig(track, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
        session.publish(
            { track, payload: new Uint8Array(8), flags: FLAG.KEYFRAME, timestamp: 0 },
            new Uint8Array(0)
        );
    };

    eye(TRACK.LEFT);
    if (stereo) eye(TRACK.RIGHT);

    return session;
}

/** An account that exists, for the repository-level tests. */
function makeUser(role = 'viewer') {
    accountSeq += 1;
    return users.create({
        email: `direct${accountSeq}@example.test`,
        passwordHash: 'x',
        displayName: `Direct ${accountSeq}`,
        role
    });
}

/* ------------------------------------------------------------- the ledger -- */

test('a new account has nothing and owes nothing', () => {
    const user = makeUser();
    const account = credits.account(user.id);

    assert.equal(account.balance, 0);
    assert.equal(account.purchased, 0);
    assert.equal(account.earned, 0);
    assert.equal(account.spent, 0);
});

test('posting moves the balance and records what the balance became', () => {
    const user = makeUser();

    credits.post({ userId: user.id, delta: 2500, reason: 'purchase' });

    // An adjustment rather than a watch: watching pays a creator, so it goes
    // through `transfer` and is tested below. This is the one-sided case.
    const spend = credits.post({ userId: user.id, delta: -400, reason: 'adjustment' });

    assert.equal(spend.balance, 2100);
    assert.equal(credits.balance(user.id), 2100);

    const [latest] = credits.history(user.id);
    assert.equal(latest.delta, -400);
    assert.equal(latest.balance_after, 2100);

    const account = credits.account(user.id);
    assert.equal(account.purchased, 2500);
    assert.equal(account.spent, 400);
    assert.equal(account.earned, 0, 'a purchase is not earnings');
});

test('an account cannot be spent below zero', () => {
    const user = makeUser();
    credits.post({ userId: user.id, delta: 100, reason: 'purchase' });

    assert.throws(
        () => credits.post({ userId: user.id, delta: -101, reason: 'adjustment' }),
        (err) => err.code === 'insufficient_credits'
    );

    // The failed attempt left nothing behind - not a row, not a changed balance.
    assert.equal(credits.balance(user.id), 100);
    assert.equal(credits.history(user.id).length, 1);
});

test('the same idempotency key applies once however many times it arrives', () => {
    const user = makeUser();

    const first = credits.post({ userId: user.id, delta: 1000, reason: 'purchase', idemKey: 'k1' });
    const second = credits.post({ userId: user.id, delta: 1000, reason: 'purchase', idemKey: 'k1' });

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(second.balance, first.balance, 'the replay reports the balance the first one produced');
    assert.equal(credits.balance(user.id), 1000);
    assert.equal(credits.history(user.id).length, 1);
});

test('a zero or fractional entry is refused rather than rounded', () => {
    const user = makeUser();

    for (const delta of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
            () => credits.post({ userId: user.id, delta, reason: 'adjustment' }),
            (err) => err.code === 'invalid_amount',
            `delta ${delta}`
        );
    }
});

test('a transfer is two rows, one reference, and no credits created', () => {
    const viewer = makeUser();
    const creator = makeUser('creator');

    credits.post({ userId: viewer.id, delta: 5000, reason: 'purchase' });
    const moved = credits.transfer({
        fromUserId: viewer.id,
        toUserId: creator.id,
        amount: 250,
        reason: 'watch',
        refType: 'session',
        refId: 'sess-1',
        idemKey: 'minute:sess-1:1'
    });

    assert.equal(moved.balance, 4750);
    assert.equal(credits.balance(creator.id), 250);
    assert.equal(credits.account(creator.id).earned, 250);
    assert.equal(credits.account(viewer.id).spent, 250);

    const debit = credits.history(viewer.id)[0];
    const credit = credits.history(creator.id)[0];
    assert.equal(debit.ref_id, credit.ref_id, 'the two halves are joinable');
    assert.equal(debit.delta + credit.delta, 0, 'a transfer is conservative');
});

test('a replayed transfer does not pay the creator twice', () => {
    const viewer = makeUser();
    const creator = makeUser('creator');
    credits.post({ userId: viewer.id, delta: 1000, reason: 'purchase' });

    const key = 'minute:sess-2:1';
    const args = {
        fromUserId: viewer.id,
        toUserId: creator.id,
        amount: 300,
        reason: 'watch',
        refType: 'session',
        refId: 'sess-2',
        idemKey: key
    };

    credits.transfer(args);
    const again = credits.transfer(args);

    assert.equal(again.applied, false);
    assert.equal(credits.balance(viewer.id), 700);
    assert.equal(credits.balance(creator.id), 300);
});

test('a transfer a viewer cannot afford moves nothing at either end', () => {
    const viewer = makeUser();
    const creator = makeUser('creator');
    credits.post({ userId: viewer.id, delta: 100, reason: 'purchase' });

    assert.throws(
        () =>
            credits.transfer({
                fromUserId: viewer.id,
                toUserId: creator.id,
                amount: 500,
                reason: 'watch'
            }),
        (err) => err.code === 'insufficient_credits'
    );

    assert.equal(credits.balance(viewer.id), 100);
    assert.equal(credits.balance(creator.id), 0);
    assert.equal(credits.history(creator.id).length, 0);
});

/* ------------------------------------------------------------- the amounts -- */

test('the offered tiers are the ones the product asked for', () => {
    assert.deepEqual(CREDIT_TIERS, [1000, 2500, 5000, 10000]);
});

test('a custom amount is bounded at both ends', () => {
    assert.equal(validateAmount(CUSTOM_MIN_CENTS).ok, true);
    assert.equal(validateAmount(CUSTOM_MIN_CENTS - 1).ok, false);
    assert.equal(validateAmount(50_001).ok, false);
    assert.equal(validateAmount(0).ok, false);
    assert.equal(validateAmount(-1000).ok, false);
    assert.equal(validateAmount('nonsense').ok, false);

    // A tier is always acceptable even if it fell outside the custom range.
    for (const tier of CREDIT_TIERS) assert.equal(validateAmount(tier).ok, true, String(tier));
});

/* ------------------------------------------------------------ buying them -- */

test('buying credits grants exactly what was paid for and says who took the money', async () => {
    const agent = makeAgent();
    await agent.register();

    const before = await agent.fetch('/api/credits');
    assert.equal(before.body.account.balance, 0);
    assert.equal(before.body.provider.isStub, true, 'the browser is told no money is being taken');
    assert.deepEqual(before.body.tiers, CREDIT_TIERS);

    const bought = await agent.fetch('/api/credits/purchases', {
        method: 'POST',
        body: JSON.stringify({ amountCents: 2500 })
    });

    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    assert.equal(bought.body.account.balance, 2500);
    assert.equal(bought.body.purchase.status, 'paid');
    assert.equal(bought.body.purchase.provider, 'stub', 'a stub purchase stays identifiable');

    const ledger = await agent.fetch('/api/credits/ledger');
    assert.equal(ledger.body.entries.length, 1);
    assert.equal(ledger.body.entries[0].reason, 'purchase');
    assert.equal(ledger.body.entries[0].refType, 'purchase');
});

test('a purchase the server will not take leaves no purchase row', async () => {
    const agent = makeAgent();
    await agent.register();

    const refused = await agent.fetch('/api/credits/purchases', {
        method: 'POST',
        body: JSON.stringify({ amountCents: 37 })
    });

    assert.equal(refused.status, 400);
    assert.equal((await agent.fetch('/api/credits/purchases')).body.purchases.length, 0);
    assert.equal((await agent.fetch('/api/credits')).body.account.balance, 0);
});

test('a balance is not readable, or buyable, without signing in', async () => {
    const anon = makeAgent();

    assert.equal((await anon.fetch('/api/credits')).status, 401);
    assert.equal(
        (
            await anon.fetch('/api/credits/purchases', {
                method: 'POST',
                body: JSON.stringify({ amountCents: 1000 })
            })
        ).status,
        401
    );
});

test('one account cannot read another account statement', async () => {
    const one = makeAgent();
    const two = makeAgent();
    await one.register();
    await two.register();

    await one.fetch('/api/credits/purchases', { method: 'POST', body: JSON.stringify({ amountCents: 1000 }) });

    // Not "403 on somebody else's id" - there is no id to pass. The statement
    // is whoever is asking, which is the shape that has no such bug.
    assert.equal((await two.fetch('/api/credits/ledger')).body.entries.length, 0);
    assert.equal((await two.fetch('/api/credits')).body.account.balance, 0);
});

/* --------------------------------------------------------------- profiles -- */

test('a profile page comes back for both roles, with credits on it', async () => {
    const viewer = makeAgent();
    await viewer.register('viewer');

    const mine = await viewer.fetch('/api/profile');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.profile.role, 'viewer');
    assert.equal(mine.body.credits.balance, 0);
    assert.equal(mine.body.creator, undefined, 'a viewer has no pricing panel');

    const creator = makeAgent();
    await creator.register('creator');

    const theirs = await creator.fetch('/api/profile');
    assert.equal(theirs.body.creator.recordingPolicy, 'ask', 'silence is not consent');
    assert.equal(theirs.body.streamChecks.standard, false);
    assert.equal(theirs.body.streamChecks.spatial, false);
});

test('editing a profile writes only what was sent', async () => {
    const agent = makeAgent();
    await agent.register();

    await agent.fetch('/api/profile', { method: 'PATCH', body: JSON.stringify({ tagline: 'Hello', bio: 'Longer' }) });
    const patched = await agent.fetch('/api/profile', { method: 'PATCH', body: JSON.stringify({ tagline: 'Hi' }) });

    assert.equal(patched.body.profile.tagline, 'Hi');
    assert.equal(patched.body.profile.bio, 'Longer', 'an omitted field is not a blanked one');
});

test('an over-long tagline is refused rather than truncated', async () => {
    const agent = makeAgent();
    await agent.register();

    const res = await agent.fetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ tagline: 'x'.repeat(200) })
    });

    assert.equal(res.status, 400);
});

/* ---------------------------------------------------------------- pricing -- */

test('a creator sets their own prices, and they are all separate', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const res = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({
            public2dPerMin: 120,
            public3dPerMin: 200,
            private2dPerMin: 500,
            private3dPerMin: 900
        })
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
        [
            res.body.creator.public2dPerMin,
            res.body.creator.public3dPerMin,
            res.body.creator.private2dPerMin,
            res.body.creator.private3dPerMin
        ],
        [120, 200, 500, 900]
    );
});

test('a viewer cannot set prices', async () => {
    const agent = makeAgent();
    await agent.register('viewer');

    const res = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({ public2dPerMin: 1 })
    });

    assert.equal(res.status, 403);
});

test('a price has to be a whole, sane number of credits', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    for (const value of [-1, 10_001, 'free']) {
        const res = await agent.fetch('/api/profile/creator', {
            method: 'PATCH',
            body: JSON.stringify({ public2dPerMin: value })
        });
        assert.equal(res.status, 400, `price ${value}`);
    }
});

/* ---------------------------------------------------------- the 3D gate -- */

test('3D cannot be offered until the 3D check has been done', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const refused = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({ public3dEnabled: true })
    });

    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'spatial_check_required');
    assert.equal(refused.body.streamChecks.spatial, false, 'the client is told which check to run');
    assert.equal(
        creatorSettings.publicView(creatorSettings.byId(agent.id)).public3dEnabled,
        false,
        'and nothing was written'
    );
});

test('the standard check alone is not enough for 3D', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const session = goLive(agent.id);
    await agent.fetch('/api/live/checks/standard', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    session.close();

    const refused = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({ private3dEnabled: true })
    });

    assert.equal(refused.status, 409);
});

test('with both checks done, 3D can be turned on for each side separately', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const session = goLive(agent.id, { stereo: true });

    for (const kind of ['standard', 'spatial']) {
        const done = await agent.fetch(`/api/live/checks/${kind}`, {
            method: 'POST',
            body: JSON.stringify({ confirmed: true })
        });
        assert.equal(done.status, 200, JSON.stringify(done.body));
    }

    session.close();

    const res = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({ public3dEnabled: true, private3dEnabled: false })
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.creator.public3dEnabled, true);
    assert.equal(res.body.creator.private3dEnabled, false);
});

test('turning 3D off never needs a check', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const res = await agent.fetch('/api/profile/creator', {
        method: 'PATCH',
        body: JSON.stringify({ public3dEnabled: false })
    });

    assert.equal(res.status, 200);
});

test('a check is only passed by confirming it, and only exists in two kinds', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    assert.equal(
        (await agent.fetch('/api/live/checks/standard', { method: 'POST', body: JSON.stringify({}) })).status,
        400
    );
    assert.equal(
        (
            await agent.fetch('/api/live/checks/sideways', {
                method: 'POST',
                body: JSON.stringify({ confirmed: true })
            })
        ).status,
        404
    );
});

test('signing in again means doing the checks again', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    accountSeq += 1;

    const session = goLive(agent.id);
    await agent.fetch('/api/live/checks/standard', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    session.close();

    assert.equal((await agent.fetch('/api/live/checks')).body.checks.standard, true);

    const email = users.byId(agent.id).email;
    const again = await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correcthorsebattery' })
    });
    agent.token = again.body.accessToken;

    assert.equal((await agent.fetch('/api/live/checks')).body.checks.standard, false);
});

/* ------------------------------------------------------- the creator list -- */

test('a creator who has not set up is not on the live list', async () => {
    readiness.clear();

    const agent = makeAgent();
    await agent.register('creator');

    const { body } = await agent.fetch('/api/creators/live');
    assert.equal(body.creators.length, 0);
});

test('a creator who has set up is listed as ready, with their picture and prices', async () => {
    readiness.clear();

    const agent = makeAgent();
    await agent.register('creator');

    profiles.update(agent.id, { tagline: 'Rehearsal room' });
    creatorSettings.update(agent.id, { public2dPerMin: 150 });

    // The check needs a broadcast to confirm; "ready" is what is left once that
    // broadcast has ended, which is the state this test is about.
    const session = goLive(agent.id);
    await agent.fetch('/api/live/checks/standard', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    session.close();

    const { body } = await agent.fetch('/api/creators/live');
    const listed = body.creators.find((c) => c.id === agent.id);

    assert.ok(listed, JSON.stringify(body));
    assert.equal(listed.status, 'ready');
    assert.equal(listed.live, null);
    assert.equal(listed.tagline, 'Rehearsal room');
    assert.equal(listed.pricing.public2dPerMin, 150);
    assert.equal(listed.avatarUrl, null, 'no picture yet, and that is a null rather than a broken URL');
});

test("a creator's public page has their prices and none of their account", async () => {
    const agent = makeAgent();
    await agent.register('creator');
    creatorSettings.update(agent.id, { private2dPerMin: 400 });

    const anon = makeAgent();
    const { status, body } = await anon.fetch(`/api/creators/${agent.id}`);

    assert.equal(status, 200);
    assert.equal(body.pricing.private2dPerMin, 400);
    assert.equal(body.profile.email, undefined);
    assert.equal(body.profile.credits, undefined);
});

test('a viewer is not a creator page', async () => {
    const viewer = makeAgent();
    await viewer.register('viewer');

    const anon = makeAgent();
    assert.equal((await anon.fetch(`/api/creators/${viewer.id}`)).status, 404);
    assert.equal((await anon.fetch('/api/creators/made-up')).status, 404);
});

/* ------------------------------------------------------------ the invariant -- */

test('every credit in existence came from a purchase or an adjustment', () => {
    const { ledgerSum, balanceSum, purchased, adjusted } = credits.audit();

    // Asserted at the end, against everything every test above did. Transfers
    // net to zero, so anything else showing up here is a half-written one.
    assert.equal(ledgerSum, purchased + adjusted, 'the ledger created nothing a purchase did not');
    assert.equal(balanceSum, ledgerSum, 'the cached balances agree with the rows behind them');
});
