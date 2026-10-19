import crypto from 'node:crypto';
import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { deriveKey } from '../auth/tokens.js';
import { ageGate } from './age.js';
import { ATTESTATION_VERSION, jurisdictionFor, publicPolicy } from './jurisdiction.js';
import {
    AGE_CONSENT_TEXT,
    AGE_CONSENT_VERSION,
    SELFIE_CONSENT_TEXT,
    SELFIE_CONSENT_VERSION,
    getProvider,
    identityGaps
} from './providers.js';
import { IDENTITY_RETURN_PATH } from './return-page.js';
import { offersSelfie, runSelfieEstimate, selfieBody, selfieCheckGaps } from './selfie.js';

/**
 * The age gate for somebody who has not signed in.
 *
 * `server/identity/age.js` already answers "may this *account* see adult
 * material here", and it is the right answer for everything behind a login.
 * It cannot answer for the front page, because the front page has no account:
 * `AFFILIATES_ONLY` turned this site into a directory whose partner rows —
 * and now a shelf of live cam thumbnails — are shown to signed-out visitors.
 * That artwork is exactly what the twenty-seven statutes in
 * [`docs/STATE-AGE-LAWS.md`](../../docs/STATE-AGE-LAWS.md) legislate about, so
 * it needs a gate that works without one.
 *
 * This is that gate, and it is deliberately the smallest thing that satisfies
 * each state's own minimum rather than one rule applied everywhere:
 *
 *   - **Everywhere outside the twenty-seven.** No statute requires anything,
 *     so the gate is one click on the attestation wording the rest of the site
 *     already uses. Making it more than that would impose a document check in
 *     states that did not ask for one, which is a privacy cost nobody
 *     legislated for.
 *   - **The twenty-seven.** A statute that requires commercially reasonable
 *     verification is not satisfied by a button, so this endpoint will not
 *     issue a pass for one. It runs the real check instead — the same provider
 *     and the same document flow an account gets, started and finished without
 *     one.
 *
 * ## No account, in either tier
 *
 * The verified tier used to hand the visitor to the sign-in modal, because the
 * document flow lived on `/api/identity/age`, which carries `requireAuth`.
 * That was this file importing a constraint it does not have. **No statute in
 * the table asks for an account**; every one of them asks for a reasonable
 * check that the person is an adult, and an email address and a password
 * establish nothing about that. Requiring registration to satisfy an age law
 * would collect more identity than the law asks for, from more people, and
 * leave it sitting in a database — the opposite of what these statutes are
 * for. So `/verify` below runs the check for a visitor who has no account and
 * is never asked for one.
 *
 * ## The pass is bound to where it was earned
 *
 * The cookie carries the jurisdiction it was issued in and is rejected
 * anywhere else. Without that, a visitor could click through in Oregon, fly to
 * Texas, and carry an Oregon-grade pass into a state that requires a document
 * — which is the same mistake as caching the gate on a user row, and `age.js`
 * declines to do that for the same reason. It holds for a verified pass too,
 * not only an attested one: the states differ in which methods they accept and
 * in how long a session may last, so a check that satisfied one of them is not
 * automatically the check another one asked for.
 *
 * ## What is kept
 *
 * Nothing, server-side. The attestation pass is a signed cookie; the verified
 * pass is a signed cookie saying a provider said yes, and the in-flight check
 * is a signed cookie holding the provider's own reference to it. There is no
 * row anywhere tying a document to a visitor, which is what the no-retention
 * states ask for and is strictly less than this site keeps for an account.
 */

const COOKIE = 'avr_age';

/** The check in flight: the provider's reference, held by the browser, briefly. */
const PENDING_COOKIE = 'avr_age_chk';

/** Long enough not to nag, short enough that a stale pass expires on its own. */
const TTL_DAYS = 30;

/** A document flow abandoned halfway is not something to remember for long. */
const PENDING_MINUTES = 30;

/** `a` — self-declared. `v` — a provider read a document and said yes. */
const ATTESTED = 'a';
const VERIFIED = 'v';

const KEY = () => deriveKey('visitor-age-gate');
const PENDING_KEY = () => deriveKey('visitor-age-check');

/* ------------------------------------------------------------------ cookie -- */

/**
 * Where a request is, as one comparable string.
 *
 * `US-TX`, or `GB`, or `US-` for a US address whose state the edge could not
 * resolve. The last of those never gets an attested pass anyway — an
 * unresolvable region fails closed into the verified tier — but it is still
 * written rather than dropped, so two different unknowns can never compare
 * equal to each other.
 */
function placeKey(policy) {
    return `${policy.country ?? ''}-${policy.region ?? ''}`;
}

function sign(payload) {
    return crypto.createHmac('sha256', KEY()).update(payload).digest('base64url');
}

/**
 * How long a pass earned right now should last here.
 *
 * Tennessee caps a verified session at an hour, and the table carries that as
 * `sessionMinutes`. Where a state has said a number, the cookie expires on the
 * number rather than on our default, so the cap is enforced by the pass going
 * stale rather than by anything having to remember to revoke it.
 */
function ttlMs(policy) {
    const ours = TTL_DAYS * 86_400_000;
    const theirs = policy.sessionMinutes ? policy.sessionMinutes * 60_000 : null;

    return theirs ? Math.min(ours, theirs) : ours;
}

function issue(policy, grade = ATTESTED) {
    const expires = Date.now() + ttlMs(policy);
    const payload = `2.${grade}.${placeKey(policy)}.${expires}`;

    return `${payload}.${sign(payload)}`;
}

/** Constant-time, and length-checked first because `timingSafeEqual` throws. */
function signatureHolds(payload, signature, signer) {
    const expected = Buffer.from(signer(payload));
    const given = Buffer.from(String(signature));

    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
}

/**
 * Whether this cookie is a pass for *this* request.
 *
 * Four things have to hold, and the signature is only the first: it has to be
 * unexpired, it has to have been issued in the jurisdiction asking now, and
 * the grade has to be one that jurisdiction accepts. A verified pass is good
 * in both tiers, because a document check is strictly more than a button; an
 * attested one is good only where a button is the law, so a state moving into
 * the twenty-seven invalidates every attested pass held in it without anything
 * being revoked.
 */
function accepts(raw, policy) {
    if (typeof raw !== 'string') return false;

    const parts = raw.split('.');
    if (parts.length !== 5) return false;

    const [version, grade, place, expires, signature] = parts;
    if (version !== '2') return false;
    if (grade !== ATTESTED && grade !== VERIFIED) return false;

    if (!signatureHolds(`${version}.${grade}.${place}.${expires}`, signature, sign)) return false;

    if (!(Number(expires) > Date.now())) return false;
    if (place !== placeKey(policy)) return false;

    return grade === VERIFIED || policy.tier === 'attest';
}

function cookieOptions(maxAge) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge
    };
}

/* -------------------------------------------------- the check while it runs -- */

/**
 * The in-flight check, as a cookie rather than a row.
 *
 * It holds the provider's inquiry id, which is what `/verify/complete` needs
 * in order to ask for a verdict. Keeping it here rather than in a table is the
 * whole reason a signed-out document check leaves no trace: there is nothing
 * to join a verdict back to, because the only copy of the reference is on the
 * visitor's own machine and it expires in half an hour.
 *
 * It is signed, so a visitor cannot substitute somebody else's inquiry id and
 * collect their pass.
 */
function issuePending(inquiryId, policy) {
    const expires = Date.now() + PENDING_MINUTES * 60_000;
    const payload = `1.${inquiryId}.${placeKey(policy)}.${expires}`;

    return `${payload}.${crypto.createHmac('sha256', PENDING_KEY()).update(payload).digest('base64url')}`;
}

function readPending(raw, policy) {
    if (typeof raw !== 'string') return null;

    const parts = raw.split('.');
    if (parts.length !== 5) return null;

    const [version, inquiryId, place, expires, signature] = parts;
    if (version !== '1') return null;

    const signer = (p) => crypto.createHmac('sha256', PENDING_KEY()).update(p).digest('base64url');
    if (!signatureHolds(`${version}.${inquiryId}.${place}.${expires}`, signature, signer)) return null;

    if (!(Number(expires) > Date.now())) return null;

    // A check started in one state does not finish in another. Moving mid-flow
    // is rare enough that restarting is the honest answer, and the alternative
    // is a Texas pass minted from an Oregon check.
    if (place !== placeKey(policy)) return null;

    return { inquiryId };
}

/**
 * Whether this deployment can actually check a document, as opposed to
 * reporting that it did.
 *
 * The mock approves every document it is shown. Behind a login that is merely
 * a test fixture; in front of the twenty-seven it is a lie told to a visitor —
 * the gate would say "an independent verification provider confirmed your
 * age", a cookie would be issued saying a document was read, and nothing would
 * have happened. A state that asked for a commercially reasonable method got a
 * `return true`.
 *
 * So in production the mock counts as no provider at all, and the gate says
 * there is no way through rather than inventing one. `assertIdentityConfigured`
 * already takes exactly this position for `AVR_IDENTITY_ENFORCE`; this is the
 * same rule reaching the one flow that had not been written when it was
 * introduced. Development keeps the mock, because otherwise the flow cannot be
 * exercised at all.
 *
 * @returns {string[]} reasons, empty if the check can really run
 */
function ageCheckGaps() {
    const gaps = identityGaps('age');

    if (process.env.NODE_ENV === 'production' && getProvider().isMock) {
        return [...gaps, 'AVR_IDENTITY_PROVIDER'];
    }

    return gaps;
}

/**
 * The reference the provider is given for a visitor with no account.
 *
 * Random per check and stored nowhere, so it identifies the attempt and
 * nothing else. The account flow passes a real user id here; there isn't one,
 * and inventing a stable pseudonymous id would create exactly the durable
 * handle this flow is built to avoid.
 */
function anonymousSubject() {
    return `anon_${crypto.randomBytes(16).toString('hex')}`;
}

/* ------------------------------------------------------------------- gate -- */

/**
 * The gate's verdict for a request, account and cookie together.
 *
 * Exported because anything that serves adult artwork to a signed-out visitor
 * has to be able to ask. A signed-in account that already satisfies
 * {@link ageGate} is through without a cookie — a document check is more than
 * any of this asks for, and making a verified Texan click a button as well
 * would be theatre.
 *
 * @param {import('express').Request} req
 */
export function visitorGate(req) {
    const account = ageGate(req);
    if (account.ok) return { ok: true, via: 'account', policy: account.policy };

    const policy = account.policy;
    const raw = req.cookies?.[COOKIE];

    if (accepts(raw, policy)) {
        return { ok: true, via: raw.startsWith(`2.${VERIFIED}.`) ? 'verified' : 'attestation', policy };
    }

    return {
        ok: false,
        via: null,
        owes: policy.tier === 'attest' ? 'attestation' : 'verification',
        policy
    };
}

/* ------------------------------------------------------------------ routes -- */

export function mountVisitorGate(app) {
    const router = express.Router();

    router.use(express.json({ limit: '16kb' }));

    /**
     * What this visitor owes before anything adult is drawn.
     *
     * Unauthenticated, and `no-store` for the same reason `/jurisdiction` is:
     * the answer is a function of the viewer's address and their cookie, and
     * one copy of it in a shared cache is how a Texan gets Oregon's gate.
     *
     * The disclosure travels with the verdict rather than behind a second
     * request, because a visitor in the twenty-seven cannot be shown the
     * consent text and the check in one screen if the text arrives after it.
     */
    router.get('/', (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Robots-Tag', 'noindex, nofollow');

        const gate = visitorGate(req);
        const needsDocument = !gate.ok && gate.owes === 'verification';
        const selfie = needsDocument && offersSelfie(gate.policy);

        res.json({
            ok: gate.ok,
            via: gate.via ?? null,
            owes: gate.owes ?? null,
            jurisdiction: publicPolicy(gate.policy),
            consent: needsDocument ? { version: AGE_CONSENT_VERSION, text: AGE_CONSENT_TEXT } : null,
            // Both disclosures travel together where both routes are on offer,
            // for the reason above: a Florida viewer picks between them on one
            // screen, so they have to be able to read both before picking.
            selfieConsent: selfie ? { version: SELFIE_CONSENT_VERSION, text: SELFIE_CONSENT_TEXT } : null,
            provider: needsDocument ? providerSummary() : null
        });
    });

    /**
     * "I am 18 or older", from somebody with no account.
     *
     * Refused outright in the twenty-seven rather than recorded and ignored.
     * A stored row saying a Texan self-declared is not evidence of anything
     * except that we were asked to break the law, and the only safe thing to
     * do with that request is to not let it succeed — the same position
     * `/attest` takes for signed-in accounts.
     *
     * The wording version is required in the body. A visitor cannot confirm
     * text they were not shown, and pinning the version is what stops a later
     * rewrite silently inheriting consent to the old one.
     */
    router.post('/attest', rateLimit({ windowMs: 3_600_000, max: 30 }), (req, res) => {
        res.set('Cache-Control', 'no-store');

        const policy = jurisdictionFor(req);

        if (policy.tier !== 'attest') {
            res.status(403).json({
                error: 'age_verification_required',
                owes: 'verification',
                jurisdiction: publicPolicy(policy)
            });
            return;
        }

        if (req.body?.confirmed !== true || req.body?.version !== ATTESTATION_VERSION) {
            res.status(400).json({
                error: 'confirmation of the current wording is required',
                version: ATTESTATION_VERSION
            });
            return;
        }

        res.cookie(COOKIE, issue(policy, ATTESTED), cookieOptions(ttlMs(policy)));
        res.json({ ok: true, via: 'attestation', jurisdiction: publicPolicy(policy) });
    });

    /**
     * Start the real check, for a visitor with no account and no prospect of
     * being asked for one.
     *
     * Everything `/api/identity/age` does, minus the user row: the same
     * provider, the same document workflow, the same Florida choice between a
     * standard and an anonymous route, the same consent version pinned in the
     * body. What it does not do is write an `age_assurances` row, because
     * there is no account to hang one off and because a verdict with no name
     * attached to it is worth keeping less than it is worth not keeping.
     */
    router.post('/verify', rateLimit({ windowMs: 3_600_000, max: 10 }), async (req, res) => {
        res.set('Cache-Control', 'no-store');

        const policy = jurisdictionFor(req);

        // Not an error in the attest tier so much as a category mistake: there
        // is nothing for a document to establish there that the button has not
        // already established, and running one anyway would collect a document
        // from somebody no law asked us to check.
        if (policy.tier !== 'verified') {
            res.status(400).json({
                error: 'no_verification_required',
                owes: 'attestation',
                jurisdiction: publicPolicy(policy)
            });
            return;
        }

        if (req.body?.consent !== true || req.body?.consentVersion !== AGE_CONSENT_VERSION) {
            res.status(400).json({
                error: 'consent to the current disclosure is required before the age check can start',
                consentVersion: AGE_CONSENT_VERSION
            });
            return;
        }

        const method = chosenMethod(req, policy);

        // Florida requires that a standard *and* an anonymous route are both
        // offered and that the viewer picks. Defaulting one for them would
        // satisfy the letter of "we offered two" and none of its purpose, so
        // the request is refused until a choice arrives.
        if (!method) {
            res.status(400).json({
                error: 'choose_verification_method',
                jurisdiction: publicPolicy(policy)
            });
            return;
        }

        // The anonymous route is not this endpoint's to run. It used to be —
        // with a second Didit workflow that was never configured, so a Florida
        // viewer who picked "nothing is kept" silently got the ordinary
        // document check and a session on file. Rather than make the fallback
        // louder, the route moved to `/verify/selfie`, where nothing is kept
        // is true of the mechanism. Refused here so that it cannot quietly
        // come back.
        if (method === 'anonymous') {
            res.status(400).json({
                error: 'use_selfie_route',
                consentVersion: SELFIE_CONSENT_VERSION,
                jurisdiction: publicPolicy(policy)
            });
            return;
        }

        if (ageCheckGaps().length) {
            res.status(503).json({
                error: 'identity checks are not set up on this server yet',
                code: 'identity_not_configured',
                retryable: false
            });
            return;
        }

        let handoff;
        try {
            handoff = await getProvider().startAgeCheck({
                userId: anonymousSubject(),
                redirectUrl: returnUrl(req),
                anonymous: method === 'anonymous'
            });
        } catch (err) {
            console.error('[identity] visitor age check could not be started:', err.message);
            res.status(502).json({ error: 'the age check could not be started', retryable: true });
            return;
        }

        res.cookie(PENDING_COOKIE, issuePending(handoff.inquiryId, policy), cookieOptions(PENDING_MINUTES * 60_000));

        // The inquiry id is deliberately not in the body. The client has no use
        // for it — `/verify/complete` reads it off the cookie — and a reference
        // the page never sees is one it cannot leak into a URL or an analytics
        // beacon.
        res.status(201).json({
            status: 'pending',
            clientUrl: handoff.clientUrl,
            clientToken: handoff.clientToken
        });
    });

    /**
     * Ask the provider how the check went.
     *
     * The verdict comes from them, never from the client: the browser saying
     * "I passed" is the one thing this endpoint must not believe. Polled by
     * the gate while the popup is open, and once more when the return page
     * nudges it.
     */
    router.post('/verify/complete', rateLimit({ windowMs: 3_600_000, max: 120 }), async (req, res) => {
        res.set('Cache-Control', 'no-store');

        const policy = jurisdictionFor(req);
        const pending = readPending(req.cookies?.[PENDING_COOKIE], policy);

        if (!pending) {
            res.status(409).json({ error: 'no age check is in progress' });
            return;
        }

        let verdict;
        try {
            verdict = await getProvider().fetchAgeCheck(pending.inquiryId);
        } catch (err) {
            console.error('[identity] visitor age verdict unavailable:', err.message);
            res.status(502).json({ error: 'the age check result is not available yet', retryable: true });
            return;
        }

        if (verdict.status === 'pending') {
            res.json({ status: 'pending' });
            return;
        }

        res.clearCookie(PENDING_COOKIE, { path: '/' });

        if (verdict.status !== 'verified' || !verdict.adultConfirmed) {
            // The reason is the provider's, and it is theirs to explain. Ours
            // is a no, which is the only part of it we are entitled to act on.
            res.json({ status: 'rejected', reason: verdict.declineReason ?? null });
            return;
        }

        res.cookie(COOKIE, issue(policy, VERIFIED), cookieOptions(ttlMs(policy)));
        res.json({ status: 'verified', via: 'verified', jurisdiction: publicPolicy(policy) });
    });

    /**
     * Florida's anonymous route: one photograph, an estimate, and no record.
     *
     * § 501.1737 asks for verification by an independent third party that
     * retains nothing, offered beside the standard route and chosen by the
     * viewer. The three routes above cannot be that — every one of them opens
     * a session at the provider, and a session is a thing that exists
     * afterwards. This one calls a standalone endpoint with
     * `save_api_request: false`, which is not "deleted promptly" but "never
     * written": no stored image, no face template, no session to go looking
     * for. That is the difference between a promise about a retention schedule
     * and a promise about a mechanism, and it is why this route exists rather
     * than a second workflow with a shorter schedule.
     *
     * The check itself, and the list of things it pointedly does not record,
     * are in [`selfie.js`](./selfie.js), shared with the signed-in route. What
     * is particular to this one is the absence of a pending cookie: the
     * document flow needs `avr_age_chk` because it hands off to a popup, and
     * an estimate answers in the same response, so there is no half-finished
     * check to remember and no reference that could later be correlated with
     * anything.
     *
     * The body is the image, raw, which is why the parser is mounted on this
     * route rather than the router: a 2 MB ceiling applies here and the other
     * four keep their 16 kB JSON one.
     */
    router.post(
        '/verify/selfie',
        rateLimit({ windowMs: 3_600_000, max: 8 }),
        selfieBody(),
        async (req, res) => {
            res.set('Cache-Control', 'no-store');

            const policy = jurisdictionFor(req);
            const verdict = await runSelfieEstimate(req, res, policy);
            if (!verdict) return;

            // The pass is a cookie and nothing else. It is bound to this
            // place, so a Florida estimate does not become a Texas one by
            // flying there; and because it is the only thing that outlasts
            // the request, clearing cookies really is the whole of the
            // deletion the disclosure describes.
            res.cookie(COOKIE, issue(policy, VERIFIED), cookieOptions(ttlMs(policy)));
            res.json({ status: 'verified', via: 'verified', jurisdiction: publicPolicy(policy) });
        }
    );

    /** For testing the gate, and for a shared machine. */
    router.post('/clear', (req, res) => {
        res.clearCookie(COOKIE, { path: '/' });
        res.clearCookie(PENDING_COOKIE, { path: '/' });
        res.json({ ok: true });
    });

    app.use('/api/identity/gate', router);
}

/**
 * Which flow the visitor asked for, if the state lets them choose.
 *
 * The same rule `/api/identity/age` applies, and deliberately the same shape:
 * an unknown method is a refusal rather than a silent substitution, because a
 * Florida viewer who asked for the anonymous route and got the standard one
 * has been told something untrue.
 */
function chosenMethod(req, policy) {
    const asked = typeof req.body?.method === 'string' ? req.body.method : null;

    if (asked) return policy.methods.includes(asked) ? asked : null;
    if (policy.requiresChoice) return null;

    return policy.methods.find((m) => m !== 'attestation') ?? 'government_id';
}

/**
 * Where the provider sends the popup when it is done.
 *
 * Built from this request rather than taken from the body — the signed-out
 * flow has no reason to accept a client-proposed redirect, and not accepting
 * one is shorter than validating it.
 */
function returnUrl(req) {
    const host = req.get('host');
    if (!host) return null;

    const proto = req.protocol === 'https' ? 'https' : 'http';
    return `${proto}://${host}${IDENTITY_RETURN_PATH}?flow=age`;
}

/**
 * Enough for the gate to name who is doing the checking, and no more.
 *
 * `ready` and `selfieReady` are separate because the two routes fail
 * independently: the document one needs a workflow id the selfie one does not
 * use, and the selfie one needs an endpoint Persona does not have. Reported
 * apart so the gate can offer the route that works instead of disabling both
 * because one of them is misconfigured.
 */
function providerSummary() {
    try {
        const provider = getProvider();
        return {
            name: provider.name,
            isMock: provider.isMock,
            ready: ageCheckGaps().length === 0,
            selfieReady: selfieCheckGaps().length === 0
        };
    } catch {
        return { name: null, isMock: false, ready: false, selfieReady: false };
    }
}

export const _internals = { COOKIE, PENDING_COOKIE, issue, issuePending, readPending, accepts, placeKey, ttlMs, ATTESTED, VERIFIED };
