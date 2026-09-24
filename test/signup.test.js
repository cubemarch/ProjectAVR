import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Signing up, in both roles.
 *
 * The form is one form with a toggle on it, and the two sides of that toggle
 * are genuinely different accounts: a viewer promises less, is asked less, and
 * is not permitted to broadcast. What is worth testing is the seam between
 * them - that the server does not take the client's word for which side was
 * shown, that a creator cannot be created without the creator agreement, and
 * that an account which becomes a creator later is asked at that moment rather
 * than deemed to have answered at signup.
 *
 * The agreements are version strings rather than checkboxes throughout. A
 * client that posts `true` has told us nothing about which wording it showed.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-signup-'));

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
const { getDb } = await import('../server/db/index.js');
const { mockControls } = await import('../server/identity/mock.js');

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

        /** Post the signup form. Everything is overridable so the failures can be aimed. */
        async register(overrides = {}) {
            accountSeq += 1;
            this.email = `signup${accountSeq}@example.test`;

            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: this.email,
                    password: 'correcthorsebattery',
                    displayName: `Person ${accountSeq}`,
                    role: 'viewer',
                    acceptedTerms: TERMS_VERSION,
                    ...overrides
                })
            });

            if (res.status === 201) {
                this.token = res.body.accessToken;
                this.id = res.body.user.id;
            }
            return res;
        }
    };
}

/**
 * The very first account on a fresh install is promoted to admin so the box is
 * usable without a seeding step, which would make whichever test ran first
 * behave differently from the rest. Burn it here.
 */
await makeAgent().register({ displayName: 'Bootstrap admin' });

function agreementRow(userId, kind) {
    return getDb().prepare('SELECT * FROM account_agreements WHERE user_id = ? AND kind = ?').get(userId, kind);
}

test.beforeEach(() => mock.reset());

/* ------------------------------------------------------------ the wording -- */

test('the signup form is served the wording it has to show, with its version', async () => {
    const res = await makeAgent().fetch('/api/auth/agreements');

    assert.equal(res.status, 200);
    assert.equal(res.body.terms.version, TERMS_VERSION);
    assert.equal(res.body.creator.version, CREATOR_TERMS_VERSION);
    assert.ok(res.body.terms.clauses.length >= 3);

    // The creator agreement has to say the two things the account is actually
    // being held to, in the text the account sees rather than only in a doc.
    const creator = res.body.creator.clauses.join(' ');
    assert.match(creator, /government-issued document/);
    assert.match(creator, /18 or over/);
});

/* --------------------------------------------------------------- refusals -- */

test('an account cannot be created without accepting the terms', async () => {
    const missing = await makeAgent().register({ acceptedTerms: undefined });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /terms of use/);

    // A boolean is not an acceptance. It records nothing about which wording
    // was on screen, which is the whole point of storing a version.
    const boolish = await makeAgent().register({ acceptedTerms: true });
    assert.equal(boolish.status, 400);
});

test('a version that is no longer on offer is refused rather than upgraded', async () => {
    const stale = await makeAgent().register({ acceptedTerms: '2019-01-01' });

    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /terms of use/);
});

test('a creator account cannot be created without the creator agreement', async () => {
    const res = await makeAgent().register({ role: 'creator', tagline: 'On air nightly' });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.ok(
        res.body.errors.some((e) => /creator agreement/.test(e)),
        JSON.stringify(res.body.errors)
    );
});

test('a creator needs the one profile field their card is built from', async () => {
    const res = await makeAgent().register({
        role: 'creator',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION
    });

    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => /tagline/i.test(e)), JSON.stringify(res.body.errors));

    // The same field is optional on the other side of the toggle.
    const viewer = await makeAgent().register();
    assert.equal(viewer.status, 201, JSON.stringify(viewer.body));
});

test('the profile fields are bounded', async () => {
    const res = await makeAgent().register({ tagline: 'x'.repeat(121), bio: 'y'.repeat(2001) });

    assert.equal(res.status, 400);
    assert.equal(res.body.errors.length, 2, JSON.stringify(res.body.errors));
});

/* ------------------------------------------------------------- both sides -- */

test('a viewer signup records the terms and nothing else', async () => {
    const agent = makeAgent();
    const res = await agent.register({ bio: 'Here for the stereo.' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'viewer');

    const terms = agreementRow(agent.id, 'terms');
    assert.equal(terms.version, TERMS_VERSION);
    assert.ok(terms.accepted_at);

    assert.equal(agreementRow(agent.id, 'creator'), undefined, 'a viewer was recorded as accepting publisher terms');

    // The initial profile is part of the same form, so it is written with the
    // account rather than left for a second trip through a settings page.
    const me = await agent.fetch('/api/profile');
    assert.equal(me.body.profile.bio, 'Here for the stereo.');
});

test('a creator signup records both agreements and the initial profile', async () => {
    const agent = makeAgent();
    const res = await agent.register({
        role: 'creator',
        tagline: 'Nightly, from a rooftop',
        bio: 'Two cameras and a lot of rain.',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'creator');

    assert.equal(agreementRow(agent.id, 'terms').version, TERMS_VERSION);
    assert.equal(agreementRow(agent.id, 'creator').version, CREATOR_TERMS_VERSION);

    const me = await agent.fetch('/api/profile');
    assert.equal(me.body.profile.tagline, 'Nightly, from a rooftop');
    assert.equal(me.body.profile.bio, 'Two cameras and a lot of rain.');
});

test('a fresh account is told where it stands rather than finding out from a 403', async () => {
    const res = await makeAgent().register({
        role: 'creator',
        tagline: 'Nightly',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION
    });

    // Signed in, and able to see nothing. The response says so in the same
    // breath, so the client can go straight to the check that is owed.
    assert.equal(res.body.adultConfirmed, false);
    assert.notEqual(res.body.verification?.status, 'verified');
});

/* ------------------------------------------------------ becoming a creator -- */

test('becoming a creator asks the creator question at that moment', async () => {
    const agent = makeAgent();
    await agent.register();

    const unasked = await agent.fetch('/api/auth/become-creator', { method: 'POST', body: '{}' });
    assert.equal(unasked.status, 400);
    assert.equal(unasked.body.error, 'creator_terms_required');
    // Refusing is only useful if it also hands back the text to show.
    assert.equal(unasked.body.creatorTerms.version, CREATOR_TERMS_VERSION);

    // And it refused for real: the role did not move.
    const before = await agent.fetch('/api/auth/me');
    assert.equal(before.body.user.role, 'viewer');

    const done = await agent.fetch('/api/auth/become-creator', {
        method: 'POST',
        body: JSON.stringify({ acceptedCreatorTerms: CREATOR_TERMS_VERSION })
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.role, 'creator');
    assert.equal(agreementRow(agent.id, 'creator').version, CREATOR_TERMS_VERSION);
});

test('what an account has accepted is readable back to it', async () => {
    const agent = makeAgent();
    await agent.register();

    const me = await agent.fetch('/api/auth/me');
    assert.equal(me.status, 200);

    assert.equal(me.body.agreements.terms.version, TERMS_VERSION);
    assert.ok(me.body.agreements.terms.acceptedAt);
    assert.equal(me.body.agreements.creator, undefined);
});

/* -------------------------------------------------- age, without asking twice -- */

/**
 * A creator establishes their age through the enrolment.
 *
 * The document check that puts them on air already proved a date of birth, and
 * sending them for a second document scan a minute later asks for the same
 * evidence twice. What must *not* happen is the shortcut being taken by writing
 * an age-assurance row off the back of it: that would fabricate a consent
 * version, timestamp and IP for a disclosure the creator never saw. The answer
 * is derived from the two rows that do exist. See `adultConfirmed`.
 */
test('an enrolled creator is adult-confirmed without a second document scan', async () => {
    const agent = makeAgent();
    await agent.register({
        role: 'creator',
        tagline: 'Nightly',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION
    });

    const { body: consent } = await agent.fetch('/api/identity/consent');
    await agent.fetch('/api/identity/enrol', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.version })
    });
    const done = await agent.fetch('/api/identity/enrol/complete', { method: 'POST' });
    assert.equal(done.body.verification.status, 'verified', JSON.stringify(done.body));

    const status = await agent.fetch('/api/identity/status');
    assert.equal(status.body.adultConfirmed, true);

    // Derived, not fabricated: there is no age-assurance row behind it.
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM age_assurances WHERE user_id = ?').get(agent.id);
    assert.equal(row.n, 0, 'an age assurance was invented from an enrolment');
});

test('a viewer gets no such shortcut', async () => {
    const agent = makeAgent();
    await agent.register();

    const status = await agent.fetch('/api/identity/status');
    assert.equal(status.body.adultConfirmed, false);
});
