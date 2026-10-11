import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creator identity verification, end to end against a real server.
 *
 * The properties under test are the ones an attacker would go for rather than
 * the ones a happy path exercises: that a stolen password alone cannot put
 * somebody on air, that the confirmation code is load-bearing, that a key
 * spends exactly once, and that no face ever reaches this side of the wire.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-identity-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { IDENTITY_RETURN_PATH } = await import('../server/identity/return-page.js');
const { mockControls } = await import('../server/identity/mock.js');
const { getDb } = await import('../server/db/index.js');
const { validateHello } = await import('../server/live/ingest.js');
const { sessions } = await import('../server/live/sessions.js');
const { rooms } = await import('../server/live/rooms.js');
const { newChallengeCode, codeMatches } = await import('../server/identity/broadcast.js');
const { resetProvider } = await import('../server/identity/providers.js');
const { verifyPersonaSignature } = await import('../server/identity/persona.js');
const { runIdentitySweep } = await import('../server/identity/retention.js');
const { PROTOCOL_NAME, PROTOCOL_VERSION } = await import('../src/live/protocol.js');

const mock = mockControls();

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

        async register(role = 'creator') {
            accountSeq += 1;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: `creator${accountSeq}@example.test`,
                    password: 'correcthorsebattery',
                    displayName: `Creator ${accountSeq}`,
                    role,
                    tagline: 'On air nightly',
                    acceptedTerms: TERMS_VERSION,
                    acceptedCreatorTerms: CREATOR_TERMS_VERSION
                })
            });
            this.token = res.body?.accessToken ?? null;
            this.id = res.body?.user?.id ?? null;
            this.email = `creator${accountSeq}@example.test`;
            return res;
        },

        /** Sign the same account back in, for the tests that sign out first. */
        async login() {
            const res = await this.fetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: this.email, password: 'correcthorsebattery' })
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            this.token = res.body.accessToken;
            return res;
        }
    };
}

/** The consent version the server is currently asking for. */
const { body: consent } = await makeAgent().fetch('/api/identity/consent');

/** Register, enrol, and come back verified. */
async function verifiedCreator() {
    const agent = makeAgent();
    await agent.register('creator');

    const started = await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const done = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.equal(done.body.verification.status, 'verified', JSON.stringify(done.body));

    return agent;
}

/** Phone raises a challenge; browser approves it with a face check. */
async function approvedChallenge(agent) {
    const created = await agent.fetch('/api/identity/broadcast/challenge', {
        method: 'POST',
        body: JSON.stringify({ device: 'iPhone 15 Pro' })
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const { id, code } = created.body.challenge;

    const face = await agent.fetch(`/api/identity/challenges/${id}/face-check`, {
        method: 'POST',
        body: JSON.stringify({ code })
    });
    assert.equal(face.status, 200, JSON.stringify(face.body));

    const complete = await agent.fetch(`/api/identity/challenges/${id}/complete`, { method: 'POST' });
    assert.equal(complete.body.status, 'approved', JSON.stringify(complete.body));

    return { id, code };
}

test.beforeEach(() => mock.reset());

/* ------------------------------------------------------------- enrolment -- */

test('the disclosure is served by the server, with a version', () => {
    assert.match(consent.version, /^\d{4}-\d{2}-\d{2}/);
    assert.match(consent.text, /government-issued document/);
    // The creator has to be told where their biometric actually goes.
    assert.match(consent.text, /provider/i);
});

test('enrolment refuses to start without consent to the current disclosure', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    for (const body of [{}, { consent: true }, { consent: true, consentVersion: '1999-01-01' }, { consent: false, consentVersion: consent.version }]) {
        const res = await agent.fetch('/api/identity/enrol', { method: 'POST', body: JSON.stringify(body) });
        assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
});

test('consent is recorded against the row before the provider is called', async () => {
    const agent = await verifiedCreator();

    const row = getDb().prepare('SELECT * FROM creator_verifications WHERE user_id = ?').get(agent.id);
    assert.equal(row.consent_version, consent.version);
    assert.ok(row.consent_at);
});

test('a viewer cannot enrol as a creator', async () => {
    const agent = makeAgent();
    await agent.register('viewer');

    const res = await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });
    assert.equal(res.status, 403);
});

test('a declined document leaves the creator unverified and off air', async () => {
    mock.setEnrolment({ status: 'rejected', declineReason: 'the document could not be read', adultConfirmed: false });

    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });

    const done = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.equal(done.body.verification.status, 'rejected');

    const challenge = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    assert.equal(challenge.status, 403);
});

test('an unverified creator cannot raise a broadcast challenge', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const res = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    assert.equal(res.body.verification.status, 'unstarted');
});

test('a lapsed verification stops working without waiting for a sweep', async () => {
    const agent = await verifiedCreator();

    getDb()
        .prepare('UPDATE creator_verifications SET expires_at = ? WHERE user_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), agent.id);

    const res = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403, 'an expired verification still authorised a broadcast');

    // And the status the portal shows says so, rather than still reading 'verified'.
    const status = await agent.fetch('/api/identity/status');
    assert.equal(status.body.verification.status, 'expired');

    assert.ok(runIdentitySweep().verificationsExpired >= 1);
});

/* ------------------------------------------------------------- challenges -- */

test('the browser sees the pending challenge, with the code the phone is showing', async () => {
    const agent = await verifiedCreator();

    const created = await agent.fetch('/api/identity/broadcast/challenge', {
        method: 'POST',
        body: JSON.stringify({ device: 'iPhone 15 Pro' })
    });

    const status = await agent.fetch('/api/identity/status');
    assert.equal(status.body.challenge.id, created.body.challenge.id);
    assert.equal(status.body.challenge.code, created.body.challenge.code);
    assert.equal(status.body.challenge.deviceLabel, 'iPhone 15 Pro');
});

test('a wrong code refuses the sign-in outright rather than offering another go', async () => {
    const agent = await verifiedCreator();

    const created = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const { id, code } = created.body.challenge;

    const wrong = code === 'AAAA' ? 'CCCC' : 'AAAA';
    const res = await agent.fetch(`/api/identity/challenges/${id}/face-check`, {
        method: 'POST',
        body: JSON.stringify({ code: wrong })
    });
    assert.equal(res.status, 400);

    // Not merely rejected - the challenge is dead, so a guessing loop has to
    // start a new one on the phone each time.
    const poll = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(poll.body.status, 'denied');

    const retry = await agent.fetch(`/api/identity/challenges/${id}/face-check`, {
        method: 'POST',
        body: JSON.stringify({ code })
    });
    assert.equal(retry.status, 409);
});

test('the code is typed by a human, so case and whitespace do not matter', async () => {
    const agent = await verifiedCreator();

    const created = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const { id, code } = created.body.challenge;

    const res = await agent.fetch(`/api/identity/challenges/${id}/face-check`, {
        method: 'POST',
        body: JSON.stringify({ code: ` ${code.toLowerCase()} ` })
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('a face that does not match denies the sign-in and issues nothing', async () => {
    const agent = await verifiedCreator();
    mock.setFaceCheck({ status: 'failed', reason: 'no match' });

    const created = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const { id, code } = created.body.challenge;

    await agent.fetch(`/api/identity/challenges/${id}/face-check`, { method: 'POST', body: JSON.stringify({ code }) });
    const complete = await agent.fetch(`/api/identity/challenges/${id}/complete`, { method: 'POST' });
    assert.equal(complete.body.status, 'denied');

    const poll = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(poll.body.status, 'denied');
    assert.equal(poll.body.grant, undefined);
});

test('a face check still running does not resolve the challenge', async () => {
    const agent = await verifiedCreator();
    mock.setFaceCheck({ status: 'pending' });

    const created = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const { id, code } = created.body.challenge;

    await agent.fetch(`/api/identity/challenges/${id}/face-check`, { method: 'POST', body: JSON.stringify({ code }) });
    const complete = await agent.fetch(`/api/identity/challenges/${id}/complete`, { method: 'POST' });
    assert.equal(complete.body.status, 'pending');
    assert.equal((await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body.status, 'pending');
});

test('one creator cannot see or approve another creator\'s sign-in', async () => {
    const victim = await verifiedCreator();
    const attacker = await verifiedCreator();

    const created = await victim.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const { id, code } = created.body.challenge;

    // Even holding the code - which is displayed on the victim's phone, not
    // secret from someone in the room - the challenge belongs to an account
    // the attacker is not signed in as.
    for (const url of [
        `/api/identity/broadcast/challenge/${id}`,
        `/api/identity/challenges/${id}/face-check`,
        `/api/identity/challenges/${id}/complete`,
        `/api/identity/challenges/${id}/deny`
    ]) {
        const res = await attacker.fetch(url, {
            method: url.endsWith(`/${id}`) ? 'GET' : 'POST',
            body: url.endsWith(`/${id}`) ? undefined : JSON.stringify({ code })
        });
        assert.equal(res.status, 404, `${url} leaked another account's challenge`);
    }
});

test('only one sign-in is ever pending, so two prompts cannot be confused', async () => {
    const agent = await verifiedCreator();

    const first = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    const second = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });

    assert.notEqual(first.body.challenge.id, second.body.challenge.id);
    assert.equal((await agent.fetch('/api/identity/status')).body.challenge.id, second.body.challenge.id);
    assert.equal((await agent.fetch(`/api/identity/broadcast/challenge/${first.body.challenge.id}`)).body.status, 'expired');
});

/* ----------------------------------------------------------------- grants -- */

test('an approved sign-in yields a grant to the phone, exactly once', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);

    const first = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(first.body.status, 'approved');
    assert.ok(first.body.grant, 'no grant was issued');

    const second = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(second.body.status, 'consumed');
    assert.equal(second.body.grant, undefined, 'the same challenge minted a second grant');
});

test('a grant admits one broadcast and attributes it to the creator', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    const hello = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'Test', mode: 'mono' };

    const first = validateHello({ ...hello });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.meta.userId, agent.id, 'the session was not attributed to the creator');

    // Spent on connection, not on disconnection: a grant retired only on a
    // clean close is replayable by anyone who can make the first attempt fail.
    //
    // It stays presentable for a short window after that first use, because a
    // grant is consumed before the session exists and a live broadcast
    // reconnects - without the window, one dropped frame ends a broadcast the
    // creator verified their face to start. The window is bounded by the
    // grant's own expiry, so it does not lengthen the period a stolen grant is
    // dangerous; it only means first use no longer shortens it.
    const resumed = validateHello({ ...hello });
    assert.equal(resumed.ok, true, 'a reconnection inside the window was refused');
    assert.equal(resumed.meta.userId, agent.id);
});

test('a grant stops resuming once the window has passed', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    const hello = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'Test', mode: 'mono' };

    assert.equal(validateHello({ ...hello }).ok, true);

    // Age the first use past the resume window. The window is measured from
    // consumption and never refreshed, so this is what a grant looks like after
    // the phone has given up reconnecting.
    getDb()
        .prepare("UPDATE broadcast_grants SET consumed_at = datetime('now', '-1 hour') WHERE consumed_at IS NOT NULL")
        .run();

    assert.equal(validateHello({ ...hello }).ok, false, 'a stale grant was still accepted');
});

test('a grant expires on its own clock even if it is never used', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    // Never presented, just old. This is the property a durable key does not
    // have, and the reason this design was kept: an unused credential stops
    // being one without anybody having to notice it exists.
    getDb()
        .prepare("UPDATE broadcast_grants SET expires_at = datetime('now', '-1 second') WHERE user_id = ?")
        .run(agent.id);

    const check = validateHello({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'T', mode: 'mono' });
    assert.equal(check.ok, false, 'an expired grant was accepted');
});

test('a grant is not a second creator\'s grant', async () => {
    const victim = await verifiedCreator();
    const attacker = await verifiedCreator();

    const { id } = await approvedChallenge(victim);
    const { grant } = (await victim.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    // The attacker's own sign-in must not be authorised by somebody else's
    // grant, and the grant must attribute the session to its real owner.
    const check = validateHello({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'T', mode: 'mono' });
    assert.equal(check.ok, true, check.error);
    assert.equal(check.meta.userId, victim.id);
    assert.notEqual(check.meta.userId, attacker.id);
});

test('the shared stream key still works, and is attributed to nobody', async () => {
    const { getStreamKey } = await import('../server/live/ingest.js');

    const check = validateHello({
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        key: getStreamKey(),
        name: 'Test',
        mode: 'mono'
    });

    assert.equal(check.ok, true, check.error);
    assert.equal(check.meta.userId, null);
});

test('an approval nobody collected lapses instead of waiting indefinitely', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);

    getDb()
        .prepare('UPDATE broadcast_challenges SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), id);

    const poll = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(poll.body.status, 'expired');
    assert.equal(poll.body.grant, undefined, 'a lapsed approval still minted a grant');
});

test('a sign-in stays revocable until the phone actually collects it', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);

    assert.equal((await agent.fetch(`/api/identity/challenges/${id}/deny`, { method: 'POST' })).status, 204);

    const poll = await agent.fetch(`/api/identity/broadcast/challenge/${id}`);
    assert.equal(poll.body.status, 'denied');
    assert.equal(poll.body.grant, undefined);
});

test('under enforcement the shared key stops working and only grants do', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    const { getStreamKey } = await import('../server/live/ingest.js');
    const hello = (k) => ({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: k, name: 'T', mode: 'mono' });

    process.env.AVR_IDENTITY_ENFORCE = '1';
    try {
        const shared = validateHello(hello(getStreamKey()));
        assert.equal(shared.ok, false, 'the shared key still authorised a broadcast under enforcement');
        assert.match(shared.error, /grant/);

        const mine = validateHello(hello(grant));
        assert.equal(mine.ok, true, mine.error);
        assert.equal(mine.meta.userId, agent.id);
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

test('signing out everywhere takes outstanding grants with it', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    // A grant already expires in minutes on its own, so this is a backstop
    // rather than the main control - but the grant a lost phone is holding is
    // exactly the one those few minutes still matter for.
    assert.equal((await agent.fetch('/api/auth/logout-all', { method: 'POST' })).status, 204);

    const check = validateHello({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'T', mode: 'mono' });
    assert.equal(check.ok, false, 'a grant survived a sign-out-everywhere');
});

test('becoming a creator grants the role and withholds the ability to broadcast', async () => {
    const agent = makeAgent();
    await agent.register('viewer');

    // A viewer was never shown the publisher agreement, so becoming a creator
    // has to ask for it rather than inherit one from signup.
    const unasked = await agent.fetch('/api/auth/become-creator', { method: 'POST', body: '{}' });
    assert.equal(unasked.status, 400);
    assert.equal(unasked.body.error, 'creator_terms_required');

    const res = await agent.fetch('/api/auth/become-creator', {
        method: 'POST',
        body: JSON.stringify({ acceptedCreatorTerms: CREATOR_TERMS_VERSION })
    });
    assert.equal(res.body.user.role, 'creator');
    assert.equal(res.body.verification.status, 'unstarted');

    agent.token = res.body.accessToken;
    assert.equal((await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' })).status, 403);
});

test('a denied sign-in cuts grants that are already outstanding', async () => {
    const agent = await verifiedCreator();

    const approved = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${approved.id}`)).body;

    const next = await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' });
    await agent.fetch(`/api/identity/challenges/${next.body.challenge.id}/deny`, { method: 'POST' });

    // "I did not start this" is a report that somebody else has the password,
    // so every grant already out there dies with the challenge rather than
    // running out its own few minutes.
    const check = validateHello({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'Test', mode: 'mono' });
    assert.equal(check.ok, false);
});

/* ------------------------------------------------------------ withdrawal -- */

test('withdrawing consent deletes our row and tells the provider to redact', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    const res = await agent.fetch('/api/identity/me', { method: 'DELETE' });
    assert.equal(res.status, 204);

    assert.equal(getDb().prepare('SELECT * FROM creator_verifications WHERE user_id = ?').get(agent.id), undefined);
    assert.ok(mock.forgotten().includes(`mock_subject_${agent.id}`), 'the provider was never asked to delete the biometric');

    assert.equal(validateHello({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'T', mode: 'mono' }).ok, false);
    assert.equal((await agent.fetch('/api/identity/broadcast/challenge', { method: 'POST', body: '{}' })).status, 403);
});

/* ------------------------------------------------- what is and is not stored -- */

test('no biometric identifier is stored anywhere in the schema', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();

    // Column names, not the schema text: the schema text is full of comments
    // explaining precisely why none of this is stored.
    const columns = tables.flatMap((table) =>
        db.prepare(`PRAGMA table_info(${table.name})`).all().map((column) => `${table.name}.${column.name}`.toLowerCase())
    );

    // Not a style rule. A column that holds a face - under any name - moves
    // this platform inside BIPA and GDPR Article 9, so it fails the build.
    for (const forbidden of ['selfie', 'face', 'template', 'embedding', 'biometric', 'image', 'photo', 'birthdate', 'birth_date', 'dob']) {
        const offender = columns.find((column) => column.split('.')[1].includes(forbidden));
        assert.equal(offender, undefined, `column suggests stored biometric data: ${offender}`);
    }
});

test('the audit trail records decisions, not evidence', async () => {
    const agent = await verifiedCreator();
    await approvedChallenge(agent);

    const { events } = (await agent.fetch('/api/identity/events')).body;
    const kinds = events.map((e) => e.kind);

    for (const expected of ['consent', 'enrolment_started', 'enrolment_result', 'challenge_created', 'challenge_result']) {
        assert.ok(kinds.includes(expected), `missing ${expected} in ${kinds.join(', ')}`);
    }
});

/* ------------------------------------------------------------- primitives -- */

test('challenge codes avoid characters that are misread off a phone screen', () => {
    for (let i = 0; i < 200; i += 1) {
        const code = newChallengeCode();
        assert.equal(code.length, 4);
        assert.match(code, /^[ACDEFGHJKLMNPQRTUVWXY34679]{4}$/, `ambiguous character in ${code}`);
    }
});

test('code comparison is case-insensitive but not loose', () => {
    assert.equal(codeMatches('ab7k', 'AB7K'), true);
    assert.equal(codeMatches('AB7K', 'AB7J'), false);
    assert.equal(codeMatches('', 'AB7K'), false);
    assert.equal(codeMatches(null, 'AB7K'), false);
    assert.equal(codeMatches('AB7K', null), false);
});

test('persona webhook signatures are verified, and replays are refused', async () => {
    const crypto = await import('node:crypto');
    const secret = 'whsec-test';
    const body = '{"data":{"id":"inq_1"}}';

    const sign = (t) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyPersonaSignature(`t=${now},v1=${sign(now)}`, body, secret), true);

    // Wrong secret, tampered body, and a signature old enough to be a replay.
    assert.equal(verifyPersonaSignature(`t=${now},v1=${sign(now)}`, body, 'other'), false);
    assert.equal(verifyPersonaSignature(`t=${now},v1=${sign(now)}`, '{"data":{"id":"inq_2"}}', secret), false);

    const old = now - 3600;
    assert.equal(verifyPersonaSignature(`t=${old},v1=${sign(old)}`, body, secret), false);

    assert.equal(verifyPersonaSignature(undefined, body, secret), false);
    assert.equal(verifyPersonaSignature('garbage', body, secret), false);
});

/* ------------------------------------------- browser-only broadcast destination -- */

/**
 * The boundary between the two products.
 *
 * What matters here is not that the happy path works but that the capture app
 * is nowhere in it: no account, no sign-in, no call to this server. The creator
 * verifies in a browser and carries one URL across by hand.
 */

/** Verify a face in the browser and collect the pasteable destination. */
async function browserDestination(agent, body = {}) {
    const started = await agent.fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify(body)
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const done = await agent.fetch(`/api/identity/broadcast/destination/${started.body.id}/complete`, {
        method: 'POST'
    });

    return { started, done };
}

test('a verified creator gets a pasteable destination carrying a stream key', async () => {
    const agent = await verifiedCreator();
    const { started, done } = await browserDestination(agent);

    // No challenge code: there is no second screen to compare one against, and
    // a value with no purpose is one somebody finds a purpose for later.
    assert.equal(started.body.code, undefined, 'a confirmation code leaked into the browser flow');

    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'approved');

    const { destination } = done.body;
    assert.ok(destination.url.startsWith('avr://pair?'), destination.url);
    assert.ok(destination.key.length >= 32, 'the stream key is too short to be one');
    assert.equal(destination.port, Number(process.env.AVR_LIVE_PORT || 8081));

    // The URL is the whole handover: everything the app needs is in it.
    const parsed = new URL(destination.url);
    assert.equal(parsed.searchParams.get('host'), destination.host);
    assert.equal(parsed.searchParams.get('key'), destination.key);

    // And it is a real key, not a decoration.
    const hello = {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        key: destination.key,
        name: 'Test',
        mode: 'mono'
    };
    const check = validateHello(hello);
    assert.equal(check.ok, true, check.error);
    assert.equal(check.meta.userId, agent.id);
});

test('an unverified creator cannot get a destination at all', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    const res = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('a failed face check yields no destination', async () => {
    const agent = await verifiedCreator();
    mock.setFaceCheck({ status: 'failed', reason: 'no match' });

    const started = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST', body: '{}' });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const done = await agent.fetch(`/api/identity/broadcast/destination/${started.body.id}/complete`, {
        method: 'POST'
    });

    assert.equal(done.status, 403, JSON.stringify(done.body));
    assert.equal(done.body.status, 'denied');
    assert.equal(done.body.destination, undefined, 'a denied face check still handed out a destination');

    // And nothing was minted behind it. A key that survives a failed check is
    // worse than it was when keys expired on their own: nothing sweeps it up.
    const outstanding = getDb()
        .prepare('SELECT COUNT(*) AS n FROM broadcast_grants WHERE user_id = ?')
        .get(agent.id);
    assert.equal(outstanding.n, 0, 'a stream key exists for a creator who failed the face check');
});

test('each destination request supersedes the last, so one face check is outstanding', async () => {
    const agent = await verifiedCreator();

    const first = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST', body: '{}' });
    const second = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST', body: '{}' });

    assert.equal(second.status, 201);

    // The superseded one is dead; completing it must not mint anything.
    const stale = await agent.fetch(`/api/identity/broadcast/destination/${first.body.id}/complete`, {
        method: 'POST'
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
});

test('the destination carries a name, because the capture app requires one', async () => {
    const agent = await verifiedCreator();

    // What the creator typed wins.
    const named = await browserDestination(agent, { name: '  Studio B  ' });
    assert.equal(named.done.body.destination.name, 'Studio B');
    assert.equal(new URL(named.done.body.destination.url).searchParams.get('name'), 'Studio B');

    // Blank falls back to the account's display name, not to a constant. This
    // is the regression: both call sites read `req.user.displayName` off a raw
    // database row whose column is `display_name`, so every destination this
    // server issued was called "ProjectAVR Live".
    const unnamed = await browserDestination(agent, {});
    assert.match(unnamed.done.body.destination.name, /^Creator \d+$/, unnamed.done.body.destination.name);
});

test('a destination name cannot carry control characters or run past the app\'s limit', async () => {
    const agent = await verifiedCreator();

    // A bidi override lets one row in the app's destination list impersonate
    // another, and the app caps a name at 60 characters - a longer one would be
    // rejected on import after the creator had already copied the link.
    const { done } = await browserDestination(agent, { name: `Studio\u202E B\n${'x'.repeat(200)}` });

    const { name } = done.body.destination;
    assert.ok(name.length <= 60, `name is ${name.length} characters`);
    assert.ok(!/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(name), JSON.stringify(name));
});

/* --------------------------------------------------------- age assurance -- */

/**
 * The check every account passes, viewers included.
 *
 * Separate from enrolment on purpose. A viewer proves an age with a document
 * and is never seen again; a creator does that *and* leaves a face to be
 * matched later. Collapsing the two would mean enrolling a biometric for
 * millions of people who will never be checked against it, which is collection
 * without a purpose and the thing Article 9 is about.
 */

/** Register and come back age-verified. */
async function ageVerified(role = 'viewer') {
    const agent = makeAgent();
    await agent.register(role);

    const started = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const done = await agent.fetch('/api/identity/age/complete', { method: 'POST' });
    assert.equal(done.body.ageAssurance.status, 'verified', JSON.stringify(done.body));

    return agent;
}

test('the age disclosure is its own document, versioned separately', () => {
    assert.match(consent.age.version, /^\d{4}-\d{2}-\d{2}/);

    // It must not promise a selfie, because the age check does not take one.
    assert.doesNotMatch(consent.age.text, /selfie/i);
    assert.match(consent.age.text, /document/i);
});

test('the age check refuses to start without consent to the current wording', async () => {
    const agent = makeAgent();
    await agent.register('viewer');

    const bodies = [
        {},
        { consent: true },
        { consent: true, consentVersion: '1999-01-01' },
        { consent: false, consentVersion: consent.age.version }
    ];

    for (const body of bodies) {
        const res = await agent.fetch('/api/identity/age', { method: 'POST', body: JSON.stringify(body) });
        assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
});

test('a viewer passes the age check without being a creator or enrolling a face', async () => {
    const agent = await ageVerified('viewer');

    const row = getDb().prepare('SELECT * FROM age_assurances WHERE user_id = ?').get(agent.id);
    assert.equal(row.status, 'verified');
    assert.equal(row.adult_confirmed, 1);
    assert.equal(row.consent_version, consent.age.version);

    // No creator enrolment was created as a side effect.
    const enrolment = getDb().prepare('SELECT COUNT(*) AS n FROM creator_verifications WHERE user_id = ?').get(agent.id);
    assert.equal(enrolment.n, 0, 'the age check enrolled a face for a viewer');
});

test('"verified" without an adult decision is not a pass', async () => {
    // The provider completing its inquiry says nothing about the answer. This
    // is the failure mode that matters: a status field read without the field
    // that carries the actual verdict.
    mock.setAgeCheck({ status: 'verified', adultConfirmed: false });

    const agent = makeAgent();
    await agent.register('viewer');
    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });

    const done = await agent.fetch('/api/identity/age/complete', { method: 'POST' });
    assert.equal(done.body.ageAssurance.status, 'rejected', JSON.stringify(done.body));
    assert.match(done.body.ageAssurance.declineReason, /18/);
});

test('a declined document leaves the account un-aged', async () => {
    mock.setAgeCheck({ status: 'rejected', adultConfirmed: false, declineReason: 'the document could not be read' });

    const agent = makeAgent();
    await agent.register('viewer');
    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });

    const done = await agent.fetch('/api/identity/age/complete', { method: 'POST' });
    assert.equal(done.body.ageAssurance.status, 'rejected');
    assert.equal(done.body.ageAssurance.adultConfirmed, false);
});

test('signing in reports the age assurance, so the client never has to assume', async () => {
    const agent = await ageVerified('viewer');

    const me = await agent.fetch('/api/auth/me');
    assert.equal(me.body.ageAssurance.status, 'verified', JSON.stringify(me.body));

    // And a brand new account says "unstarted" rather than saying nothing, so
    // a client reading this cannot mistake absence for a pass.
    const fresh = makeAgent();
    const registered = await fresh.register('viewer');
    assert.equal(registered.body.ageAssurance.status, 'unstarted');
    assert.equal(registered.body.ageAssurance.adultConfirmed, false);
});

test('the age row keeps a decision and a country, not a document', () => {
    const columns = getDb().prepare('PRAGMA table_info(age_assurances)').all().map((c) => c.name);

    assert.ok(columns.includes('adult_confirmed'));
    for (const forbidden of ['document_number', 'document_image', 'given_name', 'family_name', 'address']) {
        assert.ok(!columns.includes(forbidden), `age_assurances stores ${forbidden}`);
    }
});

test('under enforcement the catalogue is closed until the age check passes', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const anonymous = await makeAgent().fetch('/api/catalog');
        assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

        const unchecked = makeAgent();
        await unchecked.register('viewer');
        const refused = await unchecked.fetch('/api/catalog');
        assert.equal(refused.status, 403, JSON.stringify(refused.body));
        assert.equal(refused.body.error, 'age_assurance_required');

        const adult = await ageVerified('viewer');
        const allowed = await adult.fetch('/api/catalog');
        assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

test('the catalogue is never shared-cached once it is behind an age gate', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const adult = await ageVerified('viewer');
        const res = await fetch(`${base}/api/catalog`, { headers: { Authorization: `Bearer ${adult.token}` } });

        assert.equal(res.status, 200);
        // A proxy that caches this hands one adult's pass to everyone behind it.
        assert.match(res.headers.get('cache-control') ?? '', /private/);
        assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

/* ---------------------------------------------------------- portal unlock -- */

/**
 * The face check on the way into the creator portal.
 *
 * Once per browser session, which is what the token being returned exactly
 * once and living in `sessionStorage` buys. The properties worth testing are
 * that it cannot be obtained without passing, that it is bound to one account,
 * and that signing out ends it.
 */

/** Pass the portal face check and return the raw unlock token. */
async function portalUnlock(agent) {
    const started = await agent.fetch('/api/identity/portal/unlock', { method: 'POST', body: '{}' });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const done = await agent.fetch(`/api/identity/portal/unlock/${started.body.id}/complete`, { method: 'POST' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'approved');

    return done.body.unlockToken;
}

/** The same agent, with the portal unlock header attached to every request. */
function unlocked(agent, token) {
    return {
        id: agent.id,
        token: agent.token,
        fetch: (url, options = {}) =>
            agent.fetch(url, {
                ...options,
                headers: { ...(options.headers ?? {}), 'X-AVR-Portal-Unlock': token }
            })
    };
}

/**
 * Where the face check sits.
 *
 * Opening Studio is not the event worth binding a face to - reading your own
 * figures is not an act anyone impersonates a creator to perform - so the check
 * moved to the one thing it is actually about: going on air. A password
 * protects what Studio shows; a face protects what Studio does.
 */
test('Studio opens without a face check and going on air does not', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const agent = await verifiedCreator();

        const studio = await agent.fetch('/api/creator/overview');
        assert.equal(studio.status, 200, JSON.stringify(studio.body));

        const onAir = await agent.fetch('/api/identity/broadcast/destination', {
            method: 'POST',
            body: '{}'
        });
        assert.equal(onAir.status, 201, JSON.stringify(onAir.body));
        assert.equal(onAir.body.status, 'face_check', 'a destination was issued without a face check');
        assert.equal(onAir.body.destination, undefined);

        const token = await portalUnlock(agent);
        const checked = await unlocked(agent, token).fetch('/api/identity/broadcast/destination', {
            method: 'POST',
            body: '{}'
        });
        assert.equal(checked.status, 201, JSON.stringify(checked.body));
        assert.equal(checked.body.status, 'approved');
        assert.ok(checked.body.destination);
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

/**
 * Enrolment is itself a face check - the adapter only reports `verified` when
 * the provider's liveness and face-match features passed against the document
 * - so clearing it opens the portal. Sending the creator to a second selfie
 * seconds later asks for weaker evidence than the one just collected.
 */
test('a completed enrolment opens the portal without a second face check', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const agent = makeAgent();
        await agent.register('creator');
        await agent.fetch('/api/identity/enrol', {
            method: 'POST',
            body: JSON.stringify({ consent: true, consentVersion: consent.version })
        });

        const done = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
        assert.equal(done.body.verification.status, 'verified', JSON.stringify(done.body));
        assert.ok(done.body.unlockToken, 'enrolment cleared but handed back no unlock');

        // The face check the mock would have served is left armed: if the
        // portal still needed one, this token could not have opened anything.
        const open = await unlocked(agent, done.body.unlockToken).fetch('/api/creator/overview');
        assert.equal(open.status, 200, JSON.stringify(open.body));

        const status = await unlocked(agent, done.body.unlockToken).fetch('/api/identity/status');
        assert.equal(status.body.portalUnlocked, true);
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

/**
 * Only the call that resolves the verdict mints one. Otherwise anyone holding
 * the session cookie could replay this route for a fresh unlock whenever the
 * old one expired, and the per-session face check would never be asked for
 * again.
 */
test('replaying enrolment completion does not mint a second unlock', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });

    const first = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.ok(first.body.unlockToken);

    const again = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.equal(again.body.verification.status, 'verified');
    assert.equal(again.body.unlockToken, undefined, 'a replay minted another unlock');

    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM creator_portal_unlocks WHERE user_id = ?').get(agent.id);
    assert.equal(rows.n, 1);
});

test('a declined enrolment opens nothing', async () => {
    mock.setEnrolment({ status: 'rejected', declineReason: 'the document could not be read', adultConfirmed: false });

    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });

    const done = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.equal(done.body.verification.status, 'rejected');
    assert.equal(done.body.unlockToken, undefined, 'a rejected document handed out an unlock');

    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM creator_portal_unlocks WHERE user_id = ?').get(agent.id);
    assert.equal(rows.n, 0);
});

test('a face that does not match unlocks nothing', async () => {
    const agent = await verifiedCreator();
    mock.setFaceCheck({ status: 'failed', reason: 'no match' });

    const started = await agent.fetch('/api/identity/portal/unlock', { method: 'POST', body: '{}' });
    const done = await agent.fetch(`/api/identity/portal/unlock/${started.body.id}/complete`, { method: 'POST' });

    assert.equal(done.status, 403, JSON.stringify(done.body));
    assert.equal(done.body.unlockToken, undefined, 'a failed face check still handed out an unlock');

    // Counted by challenge, because enrolment legitimately left one behind:
    // the question here is only whether a *failed face check* opened anything.
    const rows = getDb()
        .prepare('SELECT COUNT(*) AS n FROM creator_portal_unlocks WHERE user_id = ? AND challenge_id IS NOT NULL')
        .get(agent.id);
    assert.equal(rows.n, 0);
});

test('an unlock is bound to the account that earned it', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const first = await verifiedCreator();
        const token = await portalUnlock(first);

        const second = await verifiedCreator();
        const res = await unlocked(second, token).fetch('/api/identity/broadcast/destination', {
            method: 'POST',
            body: '{}'
        });

        // Sent for their own selfie, rather than handed a live broadcast key on
        // the strength of somebody else's face.
        assert.equal(res.body.status, 'face_check', "one creator's face check put another creator on air");
        assert.equal(res.body.destination, undefined);
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

test('the unlock token is stored hashed, like every other credential here', async () => {
    const agent = await verifiedCreator();
    const token = await portalUnlock(agent);

    const row = getDb().prepare('SELECT * FROM creator_portal_unlocks WHERE user_id = ?').get(agent.id);
    assert.ok(row, 'no unlock row');
    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash.length, 64);
});

test('signing out ends the browser session, unlock included', async () => {
    process.env.AVR_IDENTITY_ENFORCE = '1';

    try {
        const agent = await verifiedCreator();
        const token = await portalUnlock(agent);

        await agent.fetch('/api/auth/logout', { method: 'POST' });

        // Revoked server-side rather than merely forgotten by a browser that
        // may not have been the one that signed out.
        const row = getDb()
            .prepare('SELECT * FROM creator_portal_unlocks WHERE user_id = ? AND revoked_at IS NULL')
            .get(agent.id);
        assert.equal(row, undefined, 'the unlock survived signing out');

        // And signing back in does not resurrect it: the next broadcast asks
        // for a face, even though the old token is still in hand.
        await agent.login();
        const res = await unlocked(agent, token).fetch('/api/identity/broadcast/destination', {
            method: 'POST',
            body: '{}'
        });
        assert.equal(res.body.status, 'face_check', 'a revoked unlock still put this creator on air');
    } finally {
        delete process.env.AVR_IDENTITY_ENFORCE;
    }
});

test('an unlocked session gets its destination without a second selfie', async () => {
    const agent = await verifiedCreator();
    const token = await portalUnlock(agent);

    const res = await unlocked(agent, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: '{}'
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'approved', 'an unlocked session was asked to verify again');

    const { destination } = res.body;
    assert.ok(destination.url.startsWith('avr://pair?'), destination.url);

    // One round trip, and the key in it is a real stream key.
    const check = validateHello({
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        key: destination.key,
        name: 'Test',
        mode: 'mono'
    });
    assert.equal(check.ok, true, check.error);
    assert.equal(check.meta.userId, agent.id);
});

test('a session with no unlock still has to show a face for a destination', async () => {
    const agent = await verifiedCreator();

    const res = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST', body: '{}' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'face_check');
    assert.equal(res.body.destination, undefined, 'a destination arrived without a face check');
});

test('withdrawing consent takes the age assurance and the unlock with it', async () => {
    const agent = await verifiedCreator();
    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    await agent.fetch('/api/identity/age/complete', { method: 'POST' });
    await portalUnlock(agent);

    const res = await agent.fetch('/api/identity/me', { method: 'DELETE' });
    assert.equal(res.status, 204, JSON.stringify(res.body));

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM age_assurances WHERE user_id = ?').get(agent.id).n, 0);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM creator_portal_unlocks WHERE user_id = ? AND revoked_at IS NULL').get(agent.id).n,
        0
    );
});

/* ------------------------------------------------------- provider identity -- */

test('a provider name the server does not know is fatal, not a fall back to the stub', async () => {
    const { getProvider } = await import('../server/identity/providers.js');

    const previous = process.env.AVR_IDENTITY_PROVIDER;
    process.env.AVR_IDENTITY_PROVIDER = 'didt';
    resetProvider();

    try {
        // A typo in one environment variable would otherwise approve every
        // document and every face, report itself as working, and give no
        // indication anywhere that the name was not understood. There is no
        // convenience worth that default.
        assert.throws(() => getProvider(), /didt is not a provider/);
    } finally {
        if (previous) process.env.AVR_IDENTITY_PROVIDER = previous;
        resetProvider();
    }
});

test('two provider keys at once is refused rather than guessed at', async () => {
    const { getProvider } = await import('../server/identity/providers.js');

    const previous = process.env.AVR_IDENTITY_PROVIDER;
    delete process.env.AVR_IDENTITY_PROVIDER;
    process.env.AVR_DIDIT_API_KEY = 'didit-key';
    process.env.AVR_PERSONA_API_KEY = 'persona-key';
    resetProvider();

    try {
        assert.throws(() => getProvider(), /Set AVR_IDENTITY_PROVIDER/);
    } finally {
        delete process.env.AVR_DIDIT_API_KEY;
        delete process.env.AVR_PERSONA_API_KEY;
        if (previous) process.env.AVR_IDENTITY_PROVIDER = previous;
        resetProvider();
    }
});

test('a verification issued by another provider does not count', async () => {
    const agent = await verifiedCreator();

    // Exactly the state a deployment is in the moment it stops using the stub
    // and configures Persona: a row that says "verified", written by something
    // that verified nobody.
    getDb().prepare("UPDATE creator_verifications SET provider = 'persona' WHERE user_id = ?").run(agent.id);

    const me = await agent.fetch('/api/identity/status');
    assert.equal(me.body.verification.status, 'expired', JSON.stringify(me.body));

    const destination = await agent.fetch('/api/identity/broadcast/destination', { method: 'POST' });
    assert.equal(destination.status, 403, JSON.stringify(destination.body));
    assert.match(destination.body.error, /verification/);
});

test('an age assurance issued by another provider does not count', async () => {
    const agent = await verifiedCreator();
    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    await agent.fetch('/api/identity/age/complete', { method: 'POST' });

    getDb().prepare("UPDATE age_assurances SET provider = 'persona' WHERE user_id = ?").run(agent.id);

    const me = await agent.fetch('/api/identity/status');
    assert.equal(me.body.ageAssurance.status, 'expired', JSON.stringify(me.body));
});

test('a grant is refused once the verification behind it stops standing', async () => {
    const agent = await verifiedCreator();
    const { id } = await approvedChallenge(agent);
    const { grant } = (await agent.fetch(`/api/identity/broadcast/challenge/${id}`)).body;

    const hello = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, key: grant, name: 'Test', mode: 'mono' };

    // Minted while the verification stood, and still inside its few minutes.
    // A bearer token must not outlive the thing it attests to, so the check is
    // at redemption rather than only at mint: the window is short, but it is
    // not zero, and re-enrolment elsewhere happens inside it.
    getDb().prepare("UPDATE creator_verifications SET provider = 'persona' WHERE user_id = ?").run(agent.id);

    const refused = validateHello({ ...hello });
    assert.equal(refused.ok, false, 'a grant behind a withdrawn verification was accepted');

    // And the rest of that creator's grants go with it, so a second one held
    // back for the purpose is not still waiting.
    assert.equal(
        getDb().prepare('SELECT COUNT(*) AS n FROM broadcast_grants WHERE user_id = ? AND revoked_at IS NULL').get(agent.id).n,
        0
    );
});

test('a check the server cannot run is refused as configuration, not as a provider outage', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    // Persona selected with no templates: the state a deployment lands in the
    // moment an API key is set and nothing else. Distinguishable from a 502 so
    // the portal can stop offering a retry that cannot succeed.
    const previous = process.env.AVR_IDENTITY_PROVIDER;
    process.env.AVR_IDENTITY_PROVIDER = 'persona';
    process.env.AVR_PERSONA_API_KEY = 'persona_sandbox_not_a_real_key';
    resetProvider();

    try {
        const res = await agent.fetch('/api/identity/enrol', {
            method: 'POST',
            body: JSON.stringify({ consent: true, consentVersion: consent.version })
        });

        assert.equal(res.status, 503, JSON.stringify(res.body));
        assert.equal(res.body.code, 'identity_not_configured');
        assert.equal(res.body.retryable, false);

        // The env var names are an operator's business. Naming them to an
        // unauthenticated-ish client hands out deployment detail for nothing.
        assert.doesNotMatch(JSON.stringify(res.body), /AVR_PERSONA/);

        // Nothing was written: a refused start must not leave a half-open
        // enrolment that /enrol/complete will later try to resolve.
        assert.equal(
            getDb().prepare('SELECT COUNT(*) AS n FROM creator_verifications WHERE user_id = ?').get(agent.id).n,
            0
        );
    } finally {
        delete process.env.AVR_PERSONA_API_KEY;
        if (previous) process.env.AVR_IDENTITY_PROVIDER = previous;
        resetProvider();
    }
});

/* ------------------------------------------------------- the waiting room -- */

/**
 * Rooms: a broadcast a creator opened for one person who was waiting.
 *
 * The property worth defending here is the one that keeps the capture app out
 * of it. The creator picks a viewer in the browser, and the only thing that
 * crosses to the phone is the same `avr://pair` link it has always been handed.
 * Nothing about "who is watching" is in the QR code, so nothing about it is in
 * the iOS binary.
 */

/** A signed-in browser sitting on the live page, waiting to be chosen. */
async function waitingViewer(name = 'Viewer') {
    const agent = makeAgent();
    await agent.register('viewer');

    const res = await agent.fetch('/api/live/waiting', { method: 'POST', body: '{}' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    return { agent, ...res.body, name };
}

/** Stand in for the phone: spend the key, and register the session it opens. */
function connectPhone(destination) {
    const check = validateHello({
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        key: destination.key,
        name: destination.name,
        mode: 'mono'
    });
    assert.equal(check.ok, true, check.error);

    return sessions.create(check.meta);
}

test('the waiting list is signed-in only, because a creator picks a person', async () => {
    const anonymous = makeAgent();
    const res = await anonymous.fetch('/api/live/waiting', { method: 'POST', body: '{}' });

    assert.equal(res.status, 401, JSON.stringify(res.body));
});

test('a creator sees names and screens, not accounts', async () => {
    const creator = await verifiedCreator();
    const viewer = await waitingViewer();

    const res = await creator.fetch('/api/live/waiting');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = res.body.viewers.find((v) => v.id === viewer.viewerId);
    assert.ok(row, 'the viewer did not reach the list');
    assert.ok(row.name.length, 'a row with no name is not pickable');
    assert.equal(typeof row.device, 'string');

    // Everything a creator does not need in order to choose somebody.
    assert.equal(row.token, undefined);
    assert.equal(row.userId, undefined);
    assert.equal(row.email, undefined);
    assert.equal(row.ip, undefined);
    assert.equal(row.userAgent, undefined);

    await viewer.agent.fetch(`/api/live/waiting/${viewer.viewerId}/leave`, {
        method: 'POST',
        body: JSON.stringify({ admitToken: viewer.admitToken })
    });
});

test('only a creator can read the waiting list', async () => {
    const viewer = await waitingViewer();
    const res = await viewer.agent.fetch('/api/live/waiting');

    assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('choosing a viewer opens a room and leaves the link alone', async () => {
    const creator = await verifiedCreator();
    const token = await portalUnlock(creator);
    const viewer = await waitingViewer();

    const res = await unlocked(creator, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId })
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.room?.id, 'no room came back');

    // The whole design in one assertion: the destination the phone scans is
    // byte-for-byte the shape it was before rooms existed. No room id, no
    // viewer id, nothing for the capture app to have an opinion about.
    const { destination, room } = res.body;
    assert.ok(destination.url.startsWith('avr://pair?'), destination.url);
    assert.doesNotMatch(destination.url, new RegExp(room.id, 'i'));
    assert.doesNotMatch(destination.url, new RegExp(viewer.viewerId, 'i'));

    // And the viewer's own page learns it has been chosen, without asking for
    // anything the creator was shown.
    const status = await viewer.agent.fetch(`/api/live/waiting/${viewer.viewerId}`, {
        method: 'POST',
        body: JSON.stringify({ admitToken: viewer.admitToken })
    });
    assert.equal(status.body.status, 'admitted');
    assert.equal(status.body.room.id, room.id);
    assert.equal(status.body.sessionId, null, 'admitted before the camera connected');
});

test('a broadcast opened for one viewer is not in the public list', async () => {
    const creator = await verifiedCreator();
    const token = await portalUnlock(creator);
    const viewer = await waitingViewer();

    const res = await unlocked(creator, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId })
    });

    const session = connectPhone(res.body.destination);

    try {
        assert.equal(rooms.isPrivate(session), true);

        const list = await makeAgent().fetch('/api/live/sessions');
        assert.equal(
            list.body.sessions.some((s) => s.sessionId === session.id),
            false,
            'a private broadcast advertised itself'
        );

        // 404 rather than 403: the admitted viewer reaches it through the room,
        // so there is no caller this costs and no existence to confirm.
        const direct = await makeAgent().fetch(`/api/live/sessions/${session.id}`);
        assert.equal(direct.status, 404);

        // The viewer's page, meanwhile, is told exactly which broadcast to join.
        const status = await viewer.agent.fetch(`/api/live/waiting/${viewer.viewerId}`, {
            method: 'POST',
            body: JSON.stringify({ admitToken: viewer.admitToken })
        });
        assert.equal(status.body.status, 'live');
        assert.equal(status.body.sessionId, session.id);
    } finally {
        session.close('test over');
    }
});

test('a broadcast nobody was chosen for is listed exactly as before', async () => {
    const creator = await verifiedCreator();
    const token = await portalUnlock(creator);

    const res = await unlocked(creator, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: '{}'
    });

    assert.equal(res.body.room, null, 'an open broadcast should not have a room');

    const session = connectPhone(res.body.destination);

    try {
        assert.equal(rooms.isPrivate(session), false);

        const list = await makeAgent().fetch('/api/live/sessions');
        assert.equal(
            list.body.sessions.some((s) => s.sessionId === session.id),
            true,
            'an open broadcast went missing'
        );
    } finally {
        session.close('test over');
    }
});

test('a viewer who closed the page cannot be chosen', async () => {
    const creator = await verifiedCreator();
    const token = await portalUnlock(creator);
    const viewer = await waitingViewer();

    await viewer.agent.fetch(`/api/live/waiting/${viewer.viewerId}/leave`, {
        method: 'POST',
        body: JSON.stringify({ admitToken: viewer.admitToken })
    });

    const res = await unlocked(creator, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId })
    });

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'viewer_gone');
});

test('a room survives the round trip to the identity provider', async () => {
    const creator = await verifiedCreator();
    const viewer = await waitingViewer();

    // No portal unlock, so this is the face-check path: the room is reserved
    // against the challenge now and the grant is bound to it a request later.
    const started = await creator.fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId })
    });

    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.status, 'face_check');
    assert.ok(started.body.room?.id, 'the choice was lost before the face check');

    const done = await creator.fetch(`/api/identity/broadcast/destination/${started.body.id}/complete`, {
        method: 'POST'
    });

    assert.equal(done.body.status, 'approved', JSON.stringify(done.body));
    assert.equal(done.body.room.id, started.body.room.id, 'a different room came back');

    const session = connectPhone(done.body.destination);

    try {
        assert.equal(rooms.isPrivate(session), true);
        assert.equal(rooms.roomFor(session).id, started.body.room.id);
    } finally {
        session.close('test over');
    }
});

test('a room is not a thing another creator can read', async () => {
    const creator = await verifiedCreator();
    const token = await portalUnlock(creator);
    const viewer = await waitingViewer();

    const res = await unlocked(creator, token).fetch('/api/identity/broadcast/destination', {
        method: 'POST',
        body: JSON.stringify({ viewerId: viewer.viewerId })
    });

    const mine = await creator.fetch(`/api/live/rooms/${res.body.room.id}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.room.sessionId, null);

    const stranger = await verifiedCreator();
    const theirs = await stranger.fetch(`/api/live/rooms/${res.body.room.id}`);
    assert.equal(theirs.status, 404, 'a room id is somebody else\'s screen');
});

/* ----------------------------------------------- the popup's way back -- */

/**
 * The check runs in a window the page opened, and something has to happen to
 * that window when the provider has finished with it. Two things are worth
 * pinning down: that the page it lands on closes itself rather than being the
 * whole site in a 480x720 box, and that the address the provider is given is
 * ours - it is the one value in this flow a caller proposes and the provider
 * will navigate a browser to.
 */

test('the return page closes itself instead of loading the app', async () => {
    const res = await fetch(`${base}${IDENTITY_RETURN_PATH}`);
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    assert.match(html, /window\.close\(\)/);

    // No bundle, so no second copy of the site in the popup.
    assert.doesNotMatch(html, /<script[^>]+src=/i);

    // And a way out for the browsers that refuse to close a window they did
    // not open, and for the phones that turn the popup into a tab.
    assert.match(html, /close this window/i);
});

test('the return page reports no verdict, because anyone can ask for it', async () => {
    // No session, no query, any query: the same document either way. It is
    // reached by following a redirect, so nothing it could say would be
    // evidence of anything, and the server never reads it.
    const plain = await (await fetch(`${base}${IDENTITY_RETURN_PATH}`)).text();
    const claimed = await (
        await fetch(`${base}${IDENTITY_RETURN_PATH}?flow=age&status=verified&userId=someone`)
    ).text();

    assert.equal(plain, claimed);
    assert.doesNotMatch(plain, /verified|approved|passed/i);
});

test('the address the provider is given is our return page, on the host that asked', async () => {
    const agent = makeAgent();
    await agent.register('viewer');

    const started = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({
            consent: true,
            consentVersion: consent.age.version,
            redirectUrl: `${base}${IDENTITY_RETURN_PATH}?flow=age`
        })
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));

    assert.equal(mock.lastHandoff('age').redirectUrl, `${base}${IDENTITY_RETURN_PATH}?flow=age`);
});

test('the flow name comes from the route, not from whatever was asked for', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({
            consent: true,
            consentVersion: consent.version,
            // Anything else on the proposed URL is discarded, including a
            // path of its own choosing.
            redirectUrl: `${base}/somewhere/else?flow=age&next=/admin`
        })
    });

    assert.equal(mock.lastHandoff('enrolment').redirectUrl, `${base}${IDENTITY_RETURN_PATH}?flow=enrol`);
});

test('the provider is never given an address on somebody else’s host', async () => {
    const elsewhere = [
        'https://phish.example/identity/return',
        `https://phish.example${IDENTITY_RETURN_PATH}?flow=age`,
        'javascript:alert(1)',
        '//phish.example/identity/return',
        '/identity/return?flow=age',
        `https://127.0.0.1.phish.example${IDENTITY_RETURN_PATH}`
    ];

    for (const redirectUrl of elsewhere) {
        mock.reset();

        const agent = makeAgent();
        await agent.register('viewer');

        const started = await agent.fetch('/api/identity/age', {
            method: 'POST',
            body: JSON.stringify({ consent: true, consentVersion: consent.age.version, redirectUrl })
        });

        // The check still starts. A callback we will not honour is not a
        // reason to refuse somebody their age check.
        assert.equal(started.status, 201, JSON.stringify(started.body));
        assert.equal(
            mock.lastHandoff('age').redirectUrl,
            null,
            `${redirectUrl} was passed to the provider`
        );
    }
});
