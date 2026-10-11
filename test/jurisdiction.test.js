import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which age gate a viewer gets, and whether what they have done satisfies it.
 *
 * Two halves. The first is pure: {@link policyFor} over every state, both
 * fallback directions, and the satisfaction rules - no server, no database, so
 * the twenty-seven can be asserted exhaustively rather than sampled. The second
 * drives the real routes, because the properties that matter most are the ones
 * that span layers: that a Texan cannot self-declare, that an Oregon button
 * press does not travel to Texas, and that Florida's choice actually reaches
 * the provider rather than being accepted and discarded.
 *
 * Regions are set per request with `x-geo-*` headers rather than by reassigning
 * `AVR_GEO_DEFAULT_REGION`, so that nothing here depends on test ordering.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-jurisdiction-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';

// Explicit rather than assumed: a pinned region would override every header
// below and quietly turn the whole file into one state's tests.
process.env.AVR_GEO_DEFAULT_REGION = '';
process.env.AVR_GEO_FALLBACK = '';
process.env.AVR_AGE_NON_US = '';

const { app } = await import('../server/index.js');
const { TERMS_VERSION } = await import('../server/auth/agreements.js');
const { mockControls } = await import('../server/identity/mock.js');
const { getDb } = await import('../server/db/index.js');
const { METHODS, STATE_LAWS, US_REGIONS } = await import('../server/identity/state-laws.js');
const {
    ATTESTATION_VERSION,
    assuranceSatisfies,
    attestationSatisfies,
    policyFor,
    publicPolicy,
    resolveRegion
} = await import('../server/identity/jurisdiction.js');

const mock = mockControls();

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/* -------------------------------------------------------------- the states -- */

test('every state in the table requires a real check', () => {
    assert.equal(Object.keys(STATE_LAWS).length, 27);

    for (const [code, law] of Object.entries(STATE_LAWS)) {
        const policy = policyFor({ country: 'US', region: code });

        assert.equal(policy.tier, 'verified', `${code} should require verification`);
        assert.equal(policy.reason, 'statute', code);
        assert.equal(policy.stateName, law.name, code);
        assert.ok(policy.methods.length > 0, `${code} offers no method`);
    }
});

test('every offered method is one the client can render', () => {
    for (const [code, law] of Object.entries(STATE_LAWS)) {
        for (const id of law.methods) {
            assert.ok(METHODS[id], `${code} offers unknown method "${id}"`);
        }
    }
});

test('every state is a region the resolver recognises, and carries a source', () => {
    for (const [code, law] of Object.entries(STATE_LAWS)) {
        assert.ok(US_REGIONS.has(code), `${code} is not in US_REGIONS`);
        assert.match(law.source, /^https:\/\//, `${code} has no usable source URL`);
    }
});

test('a citation is absent rather than guessed', () => {
    // Deliberate: a wrong citation in a compliance file reads as having been
    // checked. If one of these is later confirmed, this list shortens.
    const missing = Object.entries(STATE_LAWS)
        .filter(([, law]) => !law.citation)
        .map(([code]) => code)
        .sort();

    assert.deepEqual(missing, ['KY', 'MT']);
});

test('a state with no statute gets the button', () => {
    for (const code of ['CA', 'NY', 'OR', 'WA', 'CO', 'DC']) {
        const policy = policyFor({ country: 'US', region: code });

        assert.equal(policy.tier, 'attest', code);
        assert.equal(policy.reason, 'no-statute', code);
        assert.deepEqual(policy.methods, ['attestation'], code);
    }
});

test('the load-bearing special cases survive the table', () => {
    const fl = policyFor({ country: 'US', region: 'FL' });
    assert.equal(fl.requiresChoice, true);
    assert.ok(fl.methods.includes('anonymous'), 'Florida must offer an anonymous route');
    assert.ok(fl.methods.length > 1, 'Florida must offer more than one route');

    const tn = policyFor({ country: 'US', region: 'TN' });
    assert.equal(tn.sessionMinutes, 60);

    const az = policyFor({ country: 'US', region: 'AZ' });
    assert.equal(az.noRetention, true);

    for (const code of ['AR', 'GA']) {
        assert.equal(policyFor({ country: 'US', region: code }).assuranceLevel, 'ial2', code);
    }

    // Nowhere else claims any of these, or the operator obligations in
    // docs/STATE-AGE-LAWS.md are understated.
    const choosers = Object.keys(STATE_LAWS).filter((c) => STATE_LAWS[c].requiresChoice);
    const timed = Object.keys(STATE_LAWS).filter((c) => STATE_LAWS[c].sessionMinutes);
    assert.deepEqual(choosers, ['FL']);
    assert.deepEqual(timed, ['TN']);
});

/* ------------------------------------------------------------- the fallback -- */

test('an unresolved viewer is treated as covered', () => {
    const nowhere = policyFor({ country: null, region: null });
    assert.equal(nowhere.tier, 'verified');
    assert.equal(nowhere.reason, 'region-unresolved');

    const somewhereInTheUS = policyFor({ country: 'US', region: null });
    assert.equal(somewhereInTheUS.tier, 'verified');
    assert.equal(somewhereInTheUS.reason, 'us-state-unresolved');

    // A two-letter code that is not a state. `ZZ` passes the header shape
    // check, so this is the last thing standing between junk and a policy.
    const junk = policyFor({ country: 'US', region: 'ZZ' });
    assert.equal(junk.tier, 'verified');
    assert.equal(junk.reason, 'us-state-unresolved');
    assert.equal(junk.region, null, 'an unrecognised region must not be echoed back');
});

test('AVR_GEO_FALLBACK=attest opens the fallback, and only the fallback', () => {
    process.env.AVR_GEO_FALLBACK = 'attest';

    try {
        assert.equal(policyFor({ country: null, region: null }).tier, 'attest');
        assert.equal(policyFor({ country: 'US', region: null }).tier, 'attest');

        // The states are unaffected. The setting says what to do when we do
        // not know, not what to do when we do.
        assert.equal(policyFor({ country: 'US', region: 'TX' }).tier, 'verified');
    } finally {
        process.env.AVR_GEO_FALLBACK = '';
    }
});

test('a territory resolves to a known region with no statute, not to the fallback', () => {
    for (const code of ['PR', 'GU', 'VI', 'AS', 'MP']) {
        const policy = policyFor({ country: 'US', region: code });
        assert.equal(policy.tier, 'attest', code);
        assert.equal(policy.reason, 'no-statute', code);
    }
});

test('outside the United States gets the button unless told otherwise', () => {
    const gb = policyFor({ country: 'GB', region: null });
    assert.equal(gb.tier, 'attest');
    assert.equal(gb.reason, 'outside-us');

    process.env.AVR_AGE_NON_US = 'verify';
    try {
        const strict = policyFor({ country: 'GB', region: null });
        assert.equal(strict.tier, 'verified');
        assert.equal(strict.reason, 'outside-us');
    } finally {
        process.env.AVR_AGE_NON_US = '';
    }
});

/* ------------------------------------------------------------- the resolver -- */

test('the region comes from the edge, in priority order', () => {
    const cf = resolveRegion({ headers: { 'cf-ipcountry': 'us', 'cf-region-code': 'tx', 'x-geo-country': 'GB' } });
    assert.deepEqual(cf, { country: 'US', region: 'TX', source: 'cloudflare' });

    const vercel = resolveRegion({ headers: { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'FL' } });
    assert.deepEqual(vercel, { country: 'US', region: 'FL', source: 'vercel' });

    const cloudfront = resolveRegion({
        headers: { 'cloudfront-viewer-country': 'US', 'cloudfront-viewer-country-region': 'TN' }
    });
    assert.deepEqual(cloudfront, { country: 'US', region: 'TN', source: 'cloudfront' });

    const nothing = resolveRegion({ headers: {} });
    assert.deepEqual(nothing, { country: null, region: null, source: 'unknown' });
});

test('country without region is a real outcome, not an error', () => {
    // Cloudflare does not send a region unless a Transform Rule adds one, so
    // this is what an under-configured deployment actually looks like.
    const cf = resolveRegion({ headers: { 'cf-ipcountry': 'US' } });
    assert.deepEqual(cf, { country: 'US', region: null, source: 'cloudflare' });
    assert.equal(policyFor(cf).tier, 'verified');
});

test('"unknown" codes are not treated as places', () => {
    for (const code of ['XX', 'T1', 'xx', 't1']) {
        assert.equal(resolveRegion({ headers: { 'cf-ipcountry': code } }).country, null, code);
    }

    for (const junk of ['USA', '', '  ', 'U', '12', null, undefined, {}]) {
        assert.equal(resolveRegion({ headers: { 'cf-ipcountry': junk } }).country, null, String(junk));
    }

    // A repeated header arrives as an array; the first value wins.
    assert.equal(resolveRegion({ headers: { 'cf-ipcountry': ['US', 'GB'] } }).country, 'US');
});

test('a pinned region overrides the edge entirely', () => {
    process.env.AVR_GEO_DEFAULT_REGION = 'us-fl';

    try {
        const where = resolveRegion({ headers: { 'cf-ipcountry': 'US', 'cf-region-code': 'TX' } });
        assert.deepEqual(where, { country: 'US', region: 'FL', source: 'configured' });
        assert.equal(policyFor(where).requiresChoice, true);
    } finally {
        process.env.AVR_GEO_DEFAULT_REGION = '';
    }
});

/* ---------------------------------------------------------- satisfaction -- */

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

test('a document check satisfies a policy with no session limit', () => {
    const tx = policyFor({ country: 'US', region: 'TX' });

    assert.deepEqual(assuranceSatisfies(tx, null), { ok: false, reason: 'no_assurance', expiresAt: null });
    assert.equal(assuranceSatisfies(tx, { verified_at: minutesAgo(60 * 24 * 300) }).ok, true);
});

test("Tennessee's verified session ends after an hour", () => {
    const tn = policyFor({ country: 'US', region: 'TN' });

    const fresh = assuranceSatisfies(tn, { verified_at: minutesAgo(10) });
    assert.equal(fresh.ok, true);
    assert.ok(Date.parse(fresh.expiresAt) > Date.now(), 'a live session should report a future end');

    const stale = assuranceSatisfies(tn, { verified_at: minutesAgo(61) });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'session_expired');

    // The same assurance is still fine anywhere without the rule, which is
    // what makes this a per-request answer rather than an account-level one.
    assert.equal(assuranceSatisfies(policyFor({ country: 'US', region: 'TX' }), { verified_at: minutesAgo(61) }).ok, true);
});

test("SQLite's timestamps are read as UTC, not as local time", () => {
    const tn = policyFor({ country: 'US', region: 'TN' });

    // `datetime('now')` writes this form, with no zone marker. Read as local
    // time it is wrong by the server's offset in whichever direction that
    // runs, so a run in London and a run in Los Angeles would disagree.
    const sqliteStamp = (n) => new Date(Date.now() - n * 60_000).toISOString().replace('T', ' ').slice(0, 19);

    assert.equal(assuranceSatisfies(tn, { verified_at: sqliteStamp(10) }).ok, true, 'ten minutes ago is inside the hour');
    assert.equal(assuranceSatisfies(tn, { verified_at: sqliteStamp(61) }).ok, false, 'sixty-one minutes ago is outside it');

    assert.equal(assuranceSatisfies(tn, { verified_at: 'not a date' }).ok, false);
    assert.equal(assuranceSatisfies(tn, { verified_at: null }).ok, false);
});

test('a self-declaration never satisfies a state that requires a check', () => {
    const tx = policyFor({ country: 'US', region: 'TX' });
    const live = { expires_at: new Date(Date.now() + 86_400_000).toISOString() };

    assert.deepEqual(attestationSatisfies(tx, live), { ok: false, reason: 'verification_required' });
});

test('a self-declaration stands where one is enough, until it lapses', () => {
    const or = policyFor({ country: 'US', region: 'OR' });

    assert.equal(attestationSatisfies(or, null).reason, 'no_attestation');
    assert.equal(attestationSatisfies(or, { expires_at: new Date(Date.now() + 86_400_000).toISOString() }).ok, true);
    assert.equal(attestationSatisfies(or, { expires_at: new Date(Date.now() - 1000).toISOString() }).reason, 'attestation_expired');
});

/* ----------------------------------------------------------- the client view -- */

test('the client is given the wording only where it can be used', () => {
    const or = publicPolicy(policyFor({ country: 'US', region: 'OR' }));
    assert.equal(or.tier, 'attest');
    assert.equal(or.attestation.version, ATTESTATION_VERSION);
    assert.match(or.attestation.text, /18 or over/);

    const tx = publicPolicy(policyFor({ country: 'US', region: 'TX' }));
    assert.equal(tx.tier, 'verified');
    assert.equal(tx.attestation, null, 'a covered state must not be handed a button to press');
    assert.equal(tx.state, 'Texas');
    assert.match(tx.statuteUrl, /^https:\/\//);

    // Every method arrives renderable, so the browser never has to know what
    // a "digitized identification card" is called in each statute.
    for (const method of publicPolicy(policyFor({ country: 'US', region: 'FL' })).methods) {
        assert.ok(method.id && method.label && method.describe, JSON.stringify(method));
    }
});

/* ------------------------------------------------------------- the routes -- */

let accountSeq = 0;

function makeAgent(region = { country: 'US', region: 'OR' }) {
    return {
        token: null,
        where: region,

        /** Move this agent, which is the thing the gate is supposed to notice. */
        travelTo(country, state = null) {
            this.where = { country, region: state };
            return this;
        },

        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
            if (this.where?.country) headers['x-geo-country'] = this.where.country;
            if (this.where?.region) headers['x-geo-region'] = this.where.region;

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });
            const text = await res.text();

            let body = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }

            return { status: res.status, body, headers: res.headers };
        },

        async register() {
            accountSeq += 1;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: `viewer${accountSeq}@example.test`,
                    password: 'correcthorsebattery',
                    displayName: `Viewer ${accountSeq}`,
                    role: 'viewer',
                    acceptedTerms: TERMS_VERSION
                })
            });

            assert.equal(res.status, 201, JSON.stringify(res.body));
            this.token = res.body.accessToken;
            this.id = res.body.user.id;
            return res;
        }
    };
}

test('GET /jurisdiction answers from the request, and is never shared', async () => {
    const tx = await makeAgent().travelTo('US', 'TX').fetch('/api/identity/jurisdiction');
    assert.equal(tx.status, 200);
    assert.equal(tx.body.tier, 'verified');
    assert.equal(tx.body.state, 'Texas');

    // One cached copy served to the next viewer is how a Texan gets Oregon's
    // gate, so this header is as load-bearing as the body.
    assert.match(tx.headers.get('cache-control'), /no-store/);

    const or = await makeAgent().travelTo('US', 'OR').fetch('/api/identity/jurisdiction');
    assert.equal(or.body.tier, 'attest');
    assert.equal(or.body.attestation.version, ATTESTATION_VERSION);
});

test('the button works where no statute asks for more', async () => {
    const agent = makeAgent().travelTo('US', 'OR');
    await agent.register();

    const signedIn = await agent.fetch('/api/auth/me');
    assert.equal(signedIn.body.ageGate.owes, 'attestation', JSON.stringify(signedIn.body.ageGate));

    const attested = await agent.fetch('/api/identity/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: ATTESTATION_VERSION })
    });
    assert.equal(attested.status, 201, JSON.stringify(attested.body));
    assert.equal(attested.body.attestation.status, 'attested');

    const after = await agent.fetch('/api/identity/status');
    assert.equal(after.body.ageGate.ok, true, JSON.stringify(after.body.ageGate));
    assert.equal(after.body.ageGate.owes, null);

    // Still no document check. The two records are separate on purpose and a
    // button press must never read as one.
    assert.equal(after.body.ageAssurance.status, 'unstarted');
    assert.equal(after.body.user?.adultConfirmed ?? false, false);
});

test('an attestation does not travel to a state that requires a check', async () => {
    const agent = makeAgent().travelTo('US', 'OR');
    await agent.register();

    await agent.fetch('/api/identity/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: ATTESTATION_VERSION })
    });
    assert.equal((await agent.fetch('/api/identity/status')).body.ageGate.ok, true);

    agent.travelTo('US', 'TX');

    const inTexas = await agent.fetch('/api/identity/status');
    assert.equal(inTexas.body.ageGate.ok, false, 'last month in Oregon is not a Texas credential');
    assert.equal(inTexas.body.ageGate.owes, 'verification');
    assert.equal(inTexas.body.jurisdiction.state, 'Texas');
});

test('a state that requires a check will not accept a button press', async () => {
    const agent = makeAgent().travelTo('US', 'TX');
    await agent.register();

    const refused = await agent.fetch('/api/identity/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: ATTESTATION_VERSION })
    });

    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'age_assurance_required');
    assert.equal(refused.body.reason, 'verification_required');

    // Nothing recorded. A row saying a Texan self-declared is not evidence of
    // anything except that we were asked to break the law.
    const row = getDb().prepare('SELECT * FROM age_attestations WHERE user_id = ?').get(agent.id);
    assert.equal(row, undefined);
});

test('the button records agreement to the wording that was shown', async () => {
    const agent = makeAgent().travelTo('US', 'OR');
    await agent.register();

    for (const body of [{ confirmed: true, version: 'yesterdays-wording' }, { confirmed: false, version: ATTESTATION_VERSION }, {}]) {
        const res = await agent.fetch('/api/identity/attest', { method: 'POST', body: JSON.stringify(body) });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
});

test('Florida is asked to choose, and the choice reaches the provider', async () => {
    const agent = makeAgent().travelTo('US', 'FL');
    await agent.register();

    const { body: consent } = await agent.fetch('/api/identity/consent');

    const undecided = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    assert.equal(undecided.status, 400, JSON.stringify(undecided.body));
    assert.equal(undecided.body.error, 'choose_verification_method');
    assert.ok(
        undecided.body.jurisdiction.methods.some((m) => m.id === 'anonymous'),
        'the refusal has to carry the choice it is asking for'
    );

    const chosen = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version, method: 'anonymous' })
    });
    assert.equal(chosen.status, 201, JSON.stringify(chosen.body));

    // The thing the statute is actually about: that picking anonymous ran a
    // different check, rather than being accepted and then ignored.
    assert.equal(mock.lastHandoff('age').anonymous, true);
});

test('a method the state does not permit is refused, not quietly substituted', async () => {
    const agent = makeAgent().travelTo('US', 'TX');
    await agent.register();

    const { body: consent } = await agent.fetch('/api/identity/consent');

    const res = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version, method: 'anonymous' })
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'choose_verification_method');
});

test('everywhere else runs one check and does not ask', async () => {
    const agent = makeAgent().travelTo('US', 'TX');
    await agent.register();

    const { body: consent } = await agent.fetch('/api/identity/consent');

    const started = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(mock.lastHandoff('age').anonymous, false);

    const done = await agent.fetch('/api/identity/age/complete', { method: 'POST' });
    assert.equal(done.body.ageAssurance.status, 'verified', JSON.stringify(done.body));

    const after = await agent.fetch('/api/identity/status');
    assert.equal(after.body.ageGate.ok, true);
    assert.equal(after.body.ageGate.sessionExpiresAt, null, 'Texas puts no ceiling on a verified session');
});

test("Tennessee re-opens the gate an hour after the check, and the check can be redone", async () => {
    const agent = makeAgent().travelTo('US', 'TN');
    await agent.register();

    const { body: consent } = await agent.fetch('/api/identity/consent');

    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    await agent.fetch('/api/identity/age/complete', { method: 'POST' });

    const fresh = await agent.fetch('/api/identity/status');
    assert.equal(fresh.body.ageGate.ok, true, JSON.stringify(fresh.body.ageGate));
    assert.ok(Date.parse(fresh.body.ageGate.sessionExpiresAt) > Date.now());

    // Age the row rather than the clock. The column is written by SQLite, so
    // it is written back in SQLite's format too.
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    getDb().prepare('UPDATE age_assurances SET verified_at = ? WHERE user_id = ?').run(twoHoursAgo, agent.id);

    const lapsed = await agent.fetch('/api/identity/status');
    assert.equal(lapsed.body.ageGate.ok, false, 'the hour has run out');
    assert.equal(lapsed.body.ageGate.reason, 'session_expired');
    assert.equal(lapsed.body.ageGate.owes, 'verification');

    // The very same row is still good anywhere without the rule: the hour is
    // Tennessee's, not the assurance's.
    agent.travelTo('US', 'TX');
    assert.equal((await agent.fetch('/api/identity/status')).body.ageGate.ok, true);

    // Back in Tennessee the check has to actually restart, rather than being
    // told "already verified" off the still-current two-year assurance.
    agent.travelTo('US', 'TN');
    const again = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
});

test('a verified account is not sent round again on every visit', async () => {
    const agent = makeAgent().travelTo('US', 'TX');
    await agent.register();

    const { body: consent } = await agent.fetch('/api/identity/consent');
    await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });
    await agent.fetch('/api/identity/age/complete', { method: 'POST' });

    const second = await agent.fetch('/api/identity/age', {
        method: 'POST',
        body: JSON.stringify({ consent: true, consentVersion: consent.age.version })
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'verified');
});

test('forgetting an account takes the button press with it', async () => {
    const agent = makeAgent().travelTo('US', 'OR');
    await agent.register();

    await agent.fetch('/api/identity/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: ATTESTATION_VERSION })
    });
    assert.ok(getDb().prepare('SELECT 1 FROM age_attestations WHERE user_id = ?').get(agent.id));

    const gone = await agent.fetch('/api/identity/me', { method: 'DELETE' });
    assert.ok(gone.status < 300, JSON.stringify(gone.body));

    assert.equal(getDb().prepare('SELECT 1 FROM age_attestations WHERE user_id = ?').get(agent.id), undefined);
});

test('signing in carries the jurisdiction with the session', async () => {
    const agent = makeAgent().travelTo('US', 'TN');
    const registered = await agent.register();

    assert.equal(registered.body.jurisdiction.state, 'Tennessee');
    assert.equal(registered.body.jurisdiction.sessionMinutes, 60);
    assert.equal(registered.body.ageGate.owes, 'verification');

    const loggedIn = await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: `viewer${accountSeq}@example.test`, password: 'correcthorsebattery' })
    });
    assert.equal(loggedIn.body.jurisdiction.state, 'Tennessee');
});
