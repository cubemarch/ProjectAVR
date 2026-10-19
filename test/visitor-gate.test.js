import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The age gate for somebody who has not signed in.
 *
 * `test/jurisdiction.test.js` covers the account-based gate exhaustively, and
 * this is the half that has no account: the front page is a directory of
 * partner artwork shown to signed-out visitors, which is exactly what the
 * twenty-seven statutes legislate about.
 *
 * The properties worth asserting here are the ones that span layers:
 *
 *   - a Texan cannot self-declare, and is not offered a button to try;
 *   - a Texan **can** get all the way through on their own, with no account
 *     anywhere in the flow, because no statute in the table asks for one;
 *   - a pass earned in Oregon is not a pass in Texas;
 *   - a forged, tampered or expired cookie is not a pass anywhere;
 *   - the verdict comes from the provider, so a client cannot assert one;
 *   - Florida's choice of method reaches the provider rather than being
 *     accepted and discarded.
 *
 * Regions are set per request with `x-geo-*` headers rather than by
 * reassigning `AVR_GEO_DEFAULT_REGION`, so nothing here depends on test
 * ordering.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-visitor-gate-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';
process.env.AVR_GEO_DEFAULT_REGION = '';
process.env.AVR_GEO_FALLBACK = '';
process.env.AVR_AGE_NON_US = '';

const { app } = await import('../server/index.js');
const { mockControls } = await import('../server/identity/mock.js');
const { ATTESTATION_VERSION } = await import('../server/identity/jurisdiction.js');
const { AGE_CONSENT_VERSION, SELFIE_CONSENT_VERSION } = await import('../server/identity/providers.js');
const { _internals, visitorGate } = await import('../server/identity/visitor-gate.js');

const { COOKIE, PENDING_COOKIE, issue, ttlMs } = _internals;

const mock = mockControls();

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- visitors -- */

/**
 * A browser: a place, and a cookie jar.
 *
 * The jar is the point. Every property this file cares about is a property of
 * what the cookie says versus where it is being presented, and a helper that
 * threw the cookies away would test none of them.
 */
function visitor(country = 'US', region = 'OR') {
    return {
        where: { country, region },
        jar: new Map(),

        travelTo(nextCountry, nextRegion = null) {
            this.where = { country: nextCountry, region: nextRegion };
            return this;
        },

        /** Forge or corrupt what the browser is holding. */
        setCookie(name, value) {
            this.jar.set(name, value);
            return this;
        },

        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
            if (this.where.country) headers['x-geo-country'] = this.where.country;
            if (this.where.region) headers['x-geo-region'] = this.where.region;

            if (this.jar.size) {
                headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
            }

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });

            for (const line of res.headers.getSetCookie?.() ?? []) {
                const [pair] = line.split(';');
                const eq = pair.indexOf('=');
                const name = pair.slice(0, eq).trim();
                const value = pair.slice(eq + 1).trim();

                // An empty value with an expiry in the past is a clear, which
                // a jar that only ever writes would quietly turn into a pass.
                if (value === '') this.jar.delete(name);
                else this.jar.set(name, value);
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

            return { status: res.status, body, headers: res.headers };
        },

        gate() {
            return this.fetch('/api/identity/gate');
        },

        attest(version = ATTESTATION_VERSION) {
            return this.fetch('/api/identity/gate/attest', {
                method: 'POST',
                body: JSON.stringify({ confirmed: true, version })
            });
        },

        startCheck(body = {}) {
            return this.fetch('/api/identity/gate/verify', {
                method: 'POST',
                body: JSON.stringify({ consent: true, consentVersion: AGE_CONSENT_VERSION, ...body })
            });
        },

        finishCheck() {
            return this.fetch('/api/identity/gate/verify/complete', { method: 'POST' });
        },

        /**
         * Florida's anonymous route: a photograph as the whole request body.
         *
         * The bytes are nonsense because the mock does not look at them, and
         * what is being asserted is the envelope — the content type, the
         * consent header, and what comes back.
         */
        selfie({ image = PHOTO, type = 'image/jpeg', consentVersion = SELFIE_CONSENT_VERSION } = {}) {
            return this.fetch('/api/identity/gate/verify/selfie', {
                method: 'POST',
                headers: {
                    'Content-Type': type,
                    ...(consentVersion === null ? {} : { 'x-avr-consent-version': consentVersion })
                },
                body: image
            });
        }
    };
}

const PHOTO = Buffer.alloc(4096, 7);

/* -------------------------------------------------------- what each is owed -- */

test('an Oregon visitor is owed a button, and one press is enough', async () => {
    const them = visitor('US', 'OR');

    const before = await them.gate();
    assert.equal(before.body.ok, false);
    assert.equal(before.body.owes, 'attestation');
    assert.equal(before.body.jurisdiction.tier, 'attest');
    assert.equal(before.body.jurisdiction.attestation.version, ATTESTATION_VERSION);

    const pressed = await them.attest();
    assert.equal(pressed.status, 200);
    assert.ok(them.jar.has(COOKIE), 'no pass was issued');

    const after = await them.gate();
    assert.equal(after.body.ok, true);
    assert.equal(after.body.via, 'attestation');
});

test('a Texan is owed a document, and is not handed a button to press instead', async () => {
    const them = visitor('US', 'TX');

    const asked = await them.gate();
    assert.equal(asked.body.ok, false);
    assert.equal(asked.body.owes, 'verification');
    assert.equal(asked.body.jurisdiction.tier, 'verified');
    assert.equal(asked.body.jurisdiction.attestation, null, 'a covered state was handed a button');
    assert.equal(asked.body.jurisdiction.state, 'Texas');

    const pressed = await them.attest();
    assert.equal(pressed.status, 403);
    assert.equal(pressed.body.error, 'age_verification_required');
    assert.equal(them.jar.has(COOKIE), false, 'a self-declaration minted a pass in Texas');
});

test('the gate answers without an account and is never cached', async () => {
    const res = await visitor('US', 'TX').gate();

    assert.equal(res.status, 200, 'the gate asked a signed-out visitor to sign in');
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

/* -------------------------------------------------- the check, with no account -- */

test('a Texan with no account can verify and get in', async () => {
    mock.reset();

    const them = visitor('US', 'TX');

    const started = await them.startCheck();
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.status, 'pending');
    assert.match(started.body.clientUrl, /^https:\/\//);
    assert.ok(them.jar.has(PENDING_COOKIE), 'the check in flight was not remembered');

    // Deliberate: the client is never told the provider's reference, so it
    // cannot put one in a URL or hand one to an analytics beacon.
    assert.equal(started.body.inquiryId, undefined);

    const finished = await them.finishCheck();
    assert.equal(finished.status, 200);
    assert.equal(finished.body.status, 'verified');
    assert.equal(them.jar.has(PENDING_COOKIE), false, 'the in-flight cookie outlived the check');

    const after = await them.gate();
    assert.equal(after.body.ok, true);
    assert.equal(after.body.via, 'verified');
});

test('nothing in the signed-out flow ever answers 401', async () => {
    mock.reset();

    const them = visitor('US', 'TX');
    const codes = [
        (await them.gate()).status,
        (await them.startCheck()).status,
        (await them.finishCheck()).status,
        (await them.fetch('/api/identity/gate/clear', { method: 'POST' })).status
    ];

    assert.deepEqual(
        codes.filter((c) => c === 401 || c === 403),
        [],
        'the age gate is asking somebody to sign in'
    );
});

test('the disclosure travels with the verdict, and only where a document is owed', async () => {
    const texan = await visitor('US', 'TX').gate();
    assert.equal(texan.body.consent.version, AGE_CONSENT_VERSION);
    assert.ok(texan.body.consent.text.length > 100);
    assert.equal(texan.body.provider.name, 'mock');

    const oregonian = await visitor('US', 'OR').gate();
    assert.equal(oregonian.body.consent, null, 'a disclosure was shown where no check runs');
});

test('the check will not start without consent to the current wording', async () => {
    const them = visitor('US', 'TX');

    const none = await them.fetch('/api/identity/gate/verify', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(none.status, 400);
    assert.equal(none.body.consentVersion, AGE_CONSENT_VERSION);

    const stale = await them.startCheck({ consentVersion: '1999-01-01.1' });
    assert.equal(stale.status, 400);

    assert.equal(them.jar.has(PENDING_COOKIE), false);
});

test('a document check is refused where no statute asks for one', async () => {
    const them = visitor('US', 'OR');

    const res = await them.startCheck();
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_verification_required');
    assert.equal(res.body.owes, 'attestation');
});

test('a declined document is not a pass', async () => {
    mock.reset();
    mock.setAgeCheck({ status: 'rejected', adultConfirmed: false, declineReason: 'under 18' });

    const them = visitor('US', 'TX');
    await them.startCheck();

    const finished = await them.finishCheck();
    assert.equal(finished.body.status, 'rejected');
    assert.equal(them.jar.has(COOKIE), false, 'a declined document let somebody in');

    const after = await them.gate();
    assert.equal(after.body.ok, false);

    mock.reset();
});

test('a document still being read is not a pass yet, and the check survives the wait', async () => {
    mock.reset();
    mock.setAgeCheck({ status: 'pending', adultConfirmed: false });

    const them = visitor('US', 'TX');
    await them.startCheck();

    const first = await them.finishCheck();
    assert.equal(first.body.status, 'pending');
    assert.equal(them.jar.has(COOKIE), false);
    assert.ok(them.jar.has(PENDING_COOKIE), 'a pending verdict threw the check away');

    mock.setAgeCheck({ status: 'verified', adultConfirmed: true });

    const second = await them.finishCheck();
    assert.equal(second.body.status, 'verified');

    mock.reset();
});

test('a verdict cannot be collected without a check behind it', async () => {
    const res = await visitor('US', 'TX').finishCheck();

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'no age check is in progress');
});

test('an inquiry id nobody signed is not collectable', async () => {
    mock.reset();

    // Not a claim that a stolen cookie fails. It would not: a cookie is a
    // bearer token and copying one whole, signature and all, is copying the
    // session. What this asserts is the thing that would actually be a hole -
    // that an id *guessed* at, or lifted out of a log, cannot be redeemed,
    // because the signature is over the inquiry id itself.
    const started = await visitor('US', 'TX').startCheck();
    assert.equal(started.status, 201);

    const forger = visitor('US', 'TX').setCookie(PENDING_COOKIE, '1.mock_age_1.US-TX.99999999999999.deadbeef');

    const res = await forger.finishCheck();
    assert.equal(res.status, 409, 'an unsigned inquiry id was accepted');

    // And an id signed for somewhere else is not redeemable here, so a check
    // begun in a state that allows one cannot be finished in one that does
    // not.
    const traveller = visitor('US', 'TX');
    await traveller.startCheck();
    traveller.travelTo('US', 'UT');

    assert.equal((await traveller.finishCheck()).status, 409, 'a check crossed a state line mid-flow');
});

/* ------------------------------------------------------------ Florida's choice -- */

test("Florida's choice is required, and the anonymous one is not the document flow", async () => {
    mock.reset();

    const them = visitor('US', 'FL');

    const asked = await them.gate();
    assert.equal(asked.body.jurisdiction.requiresChoice, true);
    assert.ok(asked.body.jurisdiction.methods.some((m) => m.id === 'anonymous'));

    // Both disclosures arrive with the gate, because the viewer picks between
    // the two routes on one screen and cannot read a text that comes after.
    // Distinct texts, because they describe materially different checks — one
    // reads a document, the other photographs a face.
    assert.equal(asked.body.consent.version, AGE_CONSENT_VERSION);
    assert.equal(asked.body.selfieConsent.version, SELFIE_CONSENT_VERSION);
    assert.notEqual(asked.body.consent.text, asked.body.selfieConsent.text);
    assert.equal(asked.body.provider.selfieReady, true);

    const undecided = await them.startCheck();
    assert.equal(undecided.status, 400);
    assert.equal(undecided.body.error, 'choose_verification_method');

    const invented = await them.startCheck({ method: 'vibes' });
    assert.equal(invented.status, 400, 'an unknown method was run as something else');

    // This is the regression the selfie route exists to prevent. The document
    // endpoint used to accept `anonymous` and run the ordinary workflow,
    // opening a session at the provider under a disclosure promising that
    // nothing would be kept.
    const anonymous = await them.startCheck({ method: 'anonymous' });
    assert.equal(anonymous.status, 400);
    assert.equal(anonymous.body.error, 'use_selfie_route');
    assert.equal(mock.lastHandoff('age'), null, 'the anonymous choice opened a document session');

    const standard = await them.startCheck({ method: 'government_id' });
    assert.equal(standard.status, 201);
    assert.ok(mock.lastHandoff('age'), 'the standard choice still opens a document session');
});

/* ------------------------------------------------------- the anonymous route -- */

test('a selfie earns a verified pass, with no session and nothing to erase', async () => {
    mock.reset();

    const them = visitor('US', 'FL');

    const sent = await them.selfie();
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, 'verified');
    assert.equal(sent.body.via, 'verified');

    // The image reached the provider, and only the image: no inquiry was
    // opened, so there is no reference anywhere that could be joined back to
    // this visitor, and consequently nothing for `forget` to be called about.
    assert.deepEqual(mock.selfies(), [{ bytes: PHOTO.length, mimeType: 'image/jpeg' }]);
    assert.equal(mock.lastHandoff('age'), null);
    assert.deepEqual(mock.forgotten(), []);

    // No half-finished check is remembered either. The document flow needs a
    // pending cookie because it hands off to a popup; this one is answered in
    // the same response and leaves the browser holding only the pass.
    assert.equal(them.jar.has(PENDING_COOKIE), false);
    assert.ok(them.jar.get(COOKIE)?.startsWith('2.v.'), 'the pass was not graded as verified');

    assert.equal((await them.gate()).body.ok, true);

    // And it is still bound to where it was earned, like every other pass.
    them.travelTo('US', 'TX');
    assert.equal((await them.gate()).body.ok, false);
});

test('the selfie route is offered only where the statute names it', async () => {
    mock.reset();

    // Texas lists document and records checks; an age estimate is not among
    // them, and substituting one would be our judgement for the legislature's.
    const texan = await visitor('US', 'TX').selfie();
    assert.equal(texan.status, 400);
    assert.equal(texan.body.error, 'anonymous_verification_not_offered');

    // Oregon requires nothing at all, so there is nothing for a photograph to
    // establish that the button has not.
    const oregonian = await visitor('US', 'OR').selfie();
    assert.equal(oregonian.status, 400);
    assert.equal(oregonian.body.error, 'no_verification_required');

    assert.deepEqual(mock.selfies(), [], 'a photograph was sent to the provider anyway');

    // Nor is the disclosure offered where the route is not.
    const gate = await visitor('US', 'TX').gate();
    assert.equal(gate.body.selfieConsent, null);
});

test('a photograph is not accepted without consent to the wording that describes it', async () => {
    mock.reset();

    const them = visitor('US', 'FL');

    for (const consentVersion of [null, '', 'never-shown-to-anybody', AGE_CONSENT_VERSION]) {
        const res = await them.selfie({ consentVersion });

        assert.equal(res.status, 400, `consent ${JSON.stringify(consentVersion)} was accepted`);
        assert.equal(res.body.consentVersion, SELFIE_CONSENT_VERSION);
    }

    // The document disclosure is explicitly among those refused above: it
    // promises a government document and says a viewer is never asked for a
    // photo of their face, so agreeing to it is not agreeing to this.
    assert.deepEqual(mock.selfies(), []);
});

test('the body has to be an image, in a format the provider can read', async () => {
    mock.reset();

    const them = visitor('US', 'FL');

    // A type `express.raw` was not told to parse leaves `req.body` an object,
    // which must read as "send a photograph" rather than as an empty one.
    const json = await them.selfie({ type: 'application/json', image: '{}' });
    assert.equal(json.status, 415);
    assert.ok(json.body.accepts.includes('image/jpeg'));

    const gif = await them.selfie({ type: 'image/gif' });
    assert.equal(gif.status, 415, 'a format the provider cannot decode was forwarded anyway');

    const empty = await them.selfie({ image: Buffer.alloc(0) });
    assert.equal(empty.status, 415);

    assert.deepEqual(mock.selfies(), []);
});

test('a declined estimate says whether another photograph would help', async () => {
    mock.reset();

    const them = visitor('US', 'FL');

    // Lighting, framing, a second person in shot: all answerable with a
    // retake, and the gate says so.
    mock.setEstimate({ status: 'rejected', adultConfirmed: false, declineReason: 'no_face_detected' });

    const retry = await them.selfie();
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'rejected');
    assert.equal(retry.body.canRetry, true);
    assert.equal(them.jar.has(COOKIE), false, 'a declined estimate issued a pass');

    // Reading young is not answerable with a retake — the same face returns
    // the same estimate — so the gate must not invite one. The floor sits
    // above eighteen on purpose and the document route is what that buys.
    mock.setEstimate({ status: 'rejected', adultConfirmed: false, declineReason: 'age_below_minimum' });

    const final = await them.selfie();
    assert.equal(final.body.status, 'rejected');
    assert.equal(final.body.canRetry, false);

    // An approval the provider did not actually grant is still a decline: the
    // two fields have to agree before a pass is minted.
    mock.setEstimate({ status: 'verified', adultConfirmed: false, declineReason: null });

    const half = await them.selfie();
    assert.equal(half.body.status, 'rejected');
    assert.equal(them.jar.has(COOKIE), false);

    mock.reset();
});

test('each check is its own reference, and the popup is sent home', async () => {
    mock.reset();

    const one = visitor('US', 'TX');
    const two = visitor('US', 'TX');

    await one.startCheck();
    await two.startCheck();

    // The provider is told where to send the popup, and it is our own return
    // page rather than the app - a 480x720 window loading the whole SPA is
    // what `server/identity/return-page.js` exists to stop.
    assert.match(mock.lastHandoff('age').redirectUrl, /\/identity\/return\?flow=age$/);

    // Two checks, two provider references: the pending cookies are signed over
    // the inquiry id, so different cookies mean different ids. A reference
    // that repeated across visitors would be the durable handle this flow
    // promises not to have.
    assert.notEqual(one.jar.get(PENDING_COOKIE), two.jar.get(PENDING_COOKIE));
});

/* --------------------------------------------------------- the pass travels -- */

test('an Oregon button press is not a pass in Texas', async () => {
    const them = visitor('US', 'OR');
    await them.attest();

    assert.equal((await them.gate()).body.ok, true);

    them.travelTo('US', 'TX');

    const abroad = await them.gate();
    assert.equal(abroad.body.ok, false, 'an Oregon self-declaration crossed into Texas');
    assert.equal(abroad.body.owes, 'verification');

    them.travelTo('US', 'OR');
    assert.equal((await them.gate()).body.ok, true, 'coming home should not have cost the pass');
});

test('a Texas document check is not a pass in Nevada either', async () => {
    mock.reset();

    const them = visitor('US', 'TX');
    await them.startCheck();
    await them.finishCheck();

    assert.equal((await them.gate()).body.ok, true);

    // Nevada legislates nothing, so this costs one button press rather than a
    // second document — but it is still re-asked, because the states differ in
    // which methods they accept and a pass is bound to the one that issued it.
    them.travelTo('US', 'NV');
    const nevada = await them.gate();

    assert.equal(nevada.body.ok, false);
    assert.equal(nevada.body.owes, 'attestation');
});

test('a verified pass outranks a button where a button would do', async () => {
    // Not reachable through the routes - a state is in one tier or the other -
    // so it is asserted against the predicate directly: a `v` cookie has to be
    // good in an `attest` tier, or a traveller would be downgraded by arriving
    // somewhere with a weaker law.
    const attestTier = { country: 'US', region: 'NV', tier: 'attest', sessionMinutes: null };

    assert.equal(_internals.accepts(issue(attestTier, 'v'), attestTier), true);
    assert.equal(_internals.accepts(issue(attestTier, 'a'), attestTier), true);

    const verifiedTier = { country: 'US', region: 'NV', tier: 'verified', sessionMinutes: null };

    assert.equal(_internals.accepts(issue(verifiedTier, 'v'), verifiedTier), true);
    assert.equal(
        _internals.accepts(issue(verifiedTier, 'a'), verifiedTier),
        false,
        'a self-declaration satisfied a state that requires a document'
    );
});

/* ------------------------------------------------------------- bad cookies -- */

test('a cookie nobody signed is not a pass', async () => {
    const forged = visitor('US', 'OR').setCookie(COOKIE, `2.a.US-OR.${Date.now() + 86_400_000}.notasignature`);

    assert.equal((await forged.gate()).body.ok, false);
});

test('a signed cookie with the place edited afterwards is not a pass', async () => {
    const them = visitor('US', 'OR');
    await them.attest();

    const real = them.jar.get(COOKIE);
    const [version, grade, , expires, signature] = real.split('.');

    them.setCookie(COOKIE, [version, grade, 'US-TX', expires, signature].join('.')).travelTo('US', 'TX');

    assert.equal((await them.gate()).body.ok, false, 'the place was editable without breaking the signature');
});

test('a signed cookie with the grade upgraded afterwards is not a pass', async () => {
    const them = visitor('US', 'OR');
    await them.attest();

    const [version, , place, expires, signature] = them.jar.get(COOKIE).split('.');

    them.setCookie(COOKIE, [version, 'v', place, expires, signature].join('.'));

    assert.equal((await them.gate()).body.ok, false, 'a button press was promotable to a document check');
});

test('an expired pass is not a pass', async () => {
    const policy = { country: 'US', region: 'OR', tier: 'attest', sessionMinutes: null };
    const stale = issue(policy).split('.');

    // Re-signed at the earlier time rather than edited, so this is testing the
    // expiry and not the signature a second time.
    assert.equal(_internals.accepts(issue(policy), policy), true);

    stale[3] = String(Date.now() - 1000);
    assert.equal(_internals.accepts(stale.join('.'), policy), false, 'an edited expiry was accepted');
});

test('a pass from the previous cookie format is not honoured', async () => {
    const policy = { country: 'US', region: 'OR', tier: 'attest', sessionMinutes: null };

    assert.equal(_internals.accepts(`1.US-OR.${Date.now() + 86_400_000}.whatever`, policy), false);
});

test('clearing is clearing', async () => {
    const them = visitor('US', 'OR');
    await them.attest();

    assert.equal((await them.gate()).body.ok, true);

    await them.fetch('/api/identity/gate/clear', { method: 'POST' });

    assert.equal(them.jar.has(COOKIE), false, 'the clear did not reach the browser');
    assert.equal((await them.gate()).body.ok, false);
});

/* --------------------------------------------------------- statutory ceilings -- */

test("Tennessee's hour caps the pass rather than our thirty days", () => {
    const tn = { country: 'US', region: 'TN', tier: 'verified', sessionMinutes: 60 };
    const tx = { country: 'US', region: 'TX', tier: 'verified', sessionMinutes: null };

    assert.equal(ttlMs(tn), 3_600_000);
    assert.equal(ttlMs(tx), 30 * 86_400_000);
});

/* ------------------------------------------------------- the account shortcut -- */

test('a request with neither account nor cookie owes something, always', () => {
    const verdict = visitorGate({ cookies: {}, get: () => undefined, headers: {} });

    assert.equal(verdict.ok, false);
    assert.ok(verdict.owes === 'attestation' || verdict.owes === 'verification');
});

/* -------------------------------------------------- a provider that is not one -- */

test('a production deployment on the mock says there is no way through, rather than inventing one', async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
        const them = visitor('US', 'TX');

        const asked = await them.gate();
        assert.equal(
            asked.body.provider.ready,
            false,
            'the gate offered a document check that would have approved anybody'
        );

        const started = await them.startCheck();
        assert.equal(started.status, 503);
        assert.equal(started.body.code, 'identity_not_configured');
        assert.equal(them.jar.has(PENDING_COOKIE), false);

        // And nothing let them in by the back door.
        assert.equal((await them.gate()).body.ok, false);
    } finally {
        process.env.NODE_ENV = was;
    }
});

test('the mock still runs the flow outside production, or it could never be tested', async () => {
    mock.reset();

    const them = visitor('US', 'TX');

    assert.equal((await them.gate()).body.provider.ready, true);
    assert.equal((await them.startCheck()).status, 201);
});
