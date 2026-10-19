import express from 'express';

import { verifications, ageAssurances, ageAttestations, challenges, identityEvents, users } from '../db/index.js';
import { requireAuth, requireRole, loadFullUser, rateLimit } from '../auth/middleware.js';
import { notify } from '../mail/index.js';
import {
    getProvider,
    identityEnforced,
    identityGaps,
    CONSENT_VERSION,
    CONSENT_TEXT,
    AGE_CONSENT_VERSION,
    AGE_CONSENT_TEXT,
    SELFIE_CONSENT_VERSION,
    SELFIE_CONSENT_TEXT,
    AGE_ASSURANCE_DAYS,
    CHALLENGE_TTL_SECONDS,
    VERIFICATION_DAYS
} from './providers.js';
import { pullAgeVerdict, adultConfirmed, ageGate } from './age.js';
import { offersSelfie, runSelfieEstimate, selfieBody, selfieCheckGaps } from './selfie.js';
import {
    jurisdictionFor,
    publicPolicy,
    ATTESTATION_VERSION,
    ATTESTATION_DAYS
} from './jurisdiction.js';
import { IDENTITY_RETURN_PATH } from './return-page.js';
import { mintPortalUnlock, readPortalUnlock, revokePortalUnlocks } from './portal.js';
import { buildPairingUrl, destinationName } from '../live/pairing.js';
import { rooms } from '../live/rooms.js';
import {
    newChallengeCode,
    codeMatches,
    mintBroadcastGrant,
    revokeBroadcastGrants,
    requireVerifiedCreator,
    challengeView,
    expiredNow
} from './broadcast.js';

/**
 * Identity verification endpoints.
 *
 * Two audiences, one router.
 *
 * The **browser** enrols (document + selfie) and, later, answers face checks.
 * It runs the camera because it already holds a session this server issued.
 *
 * **The iOS capture app is not one of the audiences.** It has no account on this
 * server, never authenticates to it, and never calls anything in this file. A
 * creator verifies in the browser, receives one destination link carrying a
 * single-use grant (`POST /broadcast/destination`), and scans it off the screen
 * with the app's camera. The app is a general-purpose broadcasting tool that
 * sends video to an address; everything about *who may broadcast* lives here, on
 * this side of the boundary. See `server/live/pairing.js`.
 *
 * That boundary is also why choosing a waiting viewer is a parameter of this
 * endpoint and not of the link. The creator names the person they are
 * broadcasting to; the room that creates is attached to the grant on this side,
 * and the link the phone scans is byte-for-byte the one it would have got
 * anyway. The capture app has no concept of a viewer and does not acquire one.
 * See `server/live/rooms.js`.
 *
 * The second audience is **some other device** holding a creator session - not
 * the iOS app, and nothing that ships today. The `/broadcast/challenge` pair
 * below serves it: the device raises a challenge, displays a four-character
 * code, and polls while the browser approves it against that code. It is kept
 * because authorising a second device is a real need and the mechanism is
 * sound, but nothing currently calls it.
 *
 * Polling rather than SSE throughout: one request every couple of seconds for
 * the length of one sign-in is not worth a second transport and a second set of
 * reconnection semantics to avoid.
 */

/**
 * Where the provider should send the browser when it has finished with it.
 *
 * The client proposes the origin, because in development it is the only party
 * that knows it: the page is served by Vite on another port over https while
 * this server sees a proxied plain-http request, so deriving the origin from
 * the request would aim the popup somewhere it cannot reach.
 *
 * What the client does not get to propose is where on that origin. This value
 * is handed to the identity provider as the address to navigate to once the
 * document has been photographed, so an unchecked one is an open redirect that
 * arrives from the provider's own domain - which is the ideal place to put a
 * page asking somebody to re-enter their password. The host therefore has to
 * be the host that asked, the path is ours, and the flow name is the route's
 * own rather than anything that came in with the request.
 *
 * An unusable proposal is dropped rather than refused. No callback means the
 * provider leaves the popup on its own completion screen - worse, but it is
 * what happened before this page existed and not worth failing a check over.
 *
 * @param {import('express').Request} req
 * @param {'age'|'enrol'} flow
 * @returns {string|null}
 */
function returnUrlFor(req, flow) {
    const proposed = req.body?.redirectUrl;
    if (typeof proposed !== 'string') return null;

    let url;
    try {
        url = new URL(proposed);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.host !== req.get('host') && url.host !== publicHost()) return null;

    return `${url.origin}${IDENTITY_RETURN_PATH}?flow=${flow}`;
}

/** The host `AVR_PUBLIC_URL` names, for deployments behind a proxy that rewrites Host. */
function publicHost() {
    try {
        return new URL(process.env.AVR_PUBLIC_URL).host;
    } catch {
        return null;
    }
}

/**
 * Which verification route the viewer picked, or null if they still have to.
 *
 * Only Florida makes this a real question. Its statute requires that both a
 * standard and an anonymous route be *available to the viewer's choosing*, so
 * there is no defensible default there: picking one on their behalf is exactly
 * the thing the provision prohibits. Everywhere else one method is offered,
 * nobody is being denied a choice they were promised, and an absent `method`
 * means the one on offer.
 *
 * A method the state does not permit is rejected rather than coerced to the
 * default. It can only arrive from a client that is out of date or lying, and
 * silently substituting a different check would record a `method` the viewer
 * never chose.
 *
 * @param {import('express').Request} req
 * @param {import('./jurisdiction.js').Policy} policy
 * @returns {string|null}
 */
function chosenMethod(req, policy) {
    const asked = typeof req.body?.method === 'string' ? req.body.method : null;

    if (asked) return policy.methods.includes(asked) ? asked : null;
    if (policy.requiresChoice) return null;

    // The attest tier lists only `attestation`, which is not something the
    // document flow can run; a viewer who asks for the stronger check there
    // gets the ordinary one.
    return policy.methods.find((m) => m !== 'attestation') ?? 'government_id';
}

/**
 * Refuse a check the server is not configured to run, before calling anybody.
 *
 * Separated from the 502 below because the two failures need opposite things
 * from the person reading them. A provider outage is temporary and retrying is
 * the right response; a missing workflow id is permanent until somebody edits
 * the configuration, and "temporarily unavailable, try again" sends an operator
 * looking for a fault at the provider that is not there.
 *
 * The variable names stay server-side. They are an operator's problem, and the
 * startup banner and the log already name them.
 *
 * @returns {boolean} true if the request has been answered
 */
function refuseIfNotConfigured(res, check) {
    if (!identityGaps(check).length) return false;

    notConfigured(res);
    return true;
}

function notConfigured(res) {
    res.status(503).json({
        error: 'identity checks are not set up on this server yet',
        code: 'identity_not_configured',
        retryable: false
    });
}

/**
 * Answer a provider call that failed, as the failure it actually was.
 *
 * A 401 or 403 from the provider is this deployment's credentials being wrong
 * or under-permissioned - an API key missing a scope, or an account with
 * server-side inquiry creation switched off. None of that improves by waiting,
 * so it gets the configuration gate rather than "temporarily unavailable",
 * which is reserved for the transport and provider faults that do.
 *
 * Only the operator is told which: the log above every call site carries the
 * provider's own wording.
 *
 * @param {string} [userId] present when the failure could be this creator's
 *   enrolment rather than the service
 */
function failedToStart(res, err, what, userId) {
    if (err.status === 401 || err.status === 403) {
        notConfigured(res);
        return;
    }

    if (err.code === 'no_reference_face' && userId) {
        reenrolmentRequired(res, userId);
        return;
    }

    res.status(502).json({ error: `${what} is temporarily unavailable`, retryable: true });
}

/**
 * The provider has no enrolled face for a creator this server believes is
 * verified.
 *
 * Our row says they enrolled; the provider says there is nothing to compare a
 * selfie against. Whatever the cause - an erasure request honoured on their
 * side, a retention window elapsed, an enrolment that resolved verified without
 * a usable capture - the row is now a claim nobody can check, so it stops
 * standing here rather than being left to authorise broadcasts on the strength
 * of a face that no longer exists.
 *
 * Expiring it is also the only exit. A creator in this state can never pass a
 * face check, so leaving the verification in place would park them in front of
 * a gate with no key; expired is the one status the portal answers by offering
 * enrolment again.
 */
function reenrolmentRequired(res, userId) {
    verifications.resolve(userId, { status: 'expired', declineReason: 'no enrolled face on file with the provider' });
    revokeBroadcastGrants(userId);
    revokePortalUnlocks(userId);
    identityEvents.record({ userId, kind: 'verification_expired', outcome: 'failed', providerRef: null });

    res.status(409).json({
        error: 'your enrolled identity is no longer on file - please verify your identity again',
        code: 'reenrolment_required',
        retryable: false
    });
}

/**
 * Hold the waiting viewer the creator picked, if they picked one.
 *
 * Returns null when no `viewerId` was sent, which is the ordinary case and the
 * one that produces the public broadcast this endpoint has always produced. A
 * viewer that is gone or already in somebody's room throws, and the caller turns
 * that into a 409 - the creator is choosing a person, and a person who left has
 * to be reported rather than substituted.
 *
 * @param {import('express').Request} req
 * @param {string|null} challengeId - how `/complete` finds the room again
 */
function reserveRoom(req, challengeId) {
    const viewerId = req.body?.viewerId;
    if (!viewerId) return null;

    return rooms.reserve({ creatorId: req.user.id, viewerId: String(viewerId), challengeId });
}

/** Verdicts are always fetched from the provider; a client saying "I passed" means nothing. */
async function pullEnrolmentVerdict(userId, row) {
    const provider = getProvider();
    const verdict = await provider.fetchEnrolment(row.provider_inquiry_id);

    if (verdict.status === 'pending') return verifications.byUser(userId);

    const expiresAt =
        verdict.status === 'verified'
            ? new Date(Date.now() + VERIFICATION_DAYS * 86_400_000).toISOString()
            : null;

    const updated = verifications.resolve(userId, { ...verdict, expiresAt });
    const passed = verdict.status === 'verified';

    identityEvents.record({
        userId,
        kind: 'enrolment_result',
        outcome: passed ? 'ok' : 'failed',
        providerRef: row.provider_inquiry_id,
        detail: verdict.declineReason
    });

    notify(
        passed ? 'identity-verified' : 'identity-declined',
        users.byId(userId),
        passed ? { expiresAt } : { reason: verdict.declineReason ?? null }
    );

    return updated;
}

/**
 * @param {import('express').Express} app
 */
export function mountIdentity(app) {
    const router = express.Router();

    router.use(express.json({ limit: '16kb' }));

    /* --------------------------------------------------------------- consent -- */

    /**
     * The disclosure, served rather than duplicated in the client.
     *
     * Enrolment refuses any version but the one this returns, so a client
     * showing stale text cannot record consent to it.
     */
    router.get('/consent', (req, res) => {
        res.json({
            version: CONSENT_VERSION,
            text: CONSENT_TEXT,
            age: { version: AGE_CONSENT_VERSION, text: AGE_CONSENT_TEXT },
            // Served unconditionally rather than only where the anonymous
            // route is on offer: this endpoint is the record of what each
            // disclosure says, and a client has to be able to show the right
            // one beside the right check without a second round trip.
            selfie: { version: SELFIE_CONSENT_VERSION, text: SELFIE_CONSENT_TEXT },
            provider: getProvider().name
        });
    });

    /* ---------------------------------------------------------------- status -- */

    /**
     * Everything the portal needs on one poll: where this creator stands, and
     * whether a phone is waiting on them right now.
     */
    router.get('/status', requireAuth, loadFullUser, (req, res) => {
        const row = verifications.byUser(req.user.id);
        const age = ageAssurances.byUser(req.user.id);
        const pending = challenges.pendingForUser(req.user.id);
        const unlock = readPortalUnlock(req, req.user.id);

        const gate = ageGate(req);

        res.json({
            verification: verifications.publicView(row),
            ageAssurance: ageAssurances.publicView(age),
            adultConfirmed: adultConfirmed(req.user),
            attestation: ageAttestations.publicView(ageAttestations.byUser(req.user.id)),

            // What this account owes *from where it is asking*, which is the
            // only form of the question the portal can act on. `adultConfirmed`
            // above is the account-level fact and does not answer it: in
            // Tennessee it is true for fifty-nine minutes longer than the gate.
            jurisdiction: publicPolicy(gate.policy),
            ageGate: { ok: gate.ok, owes: gate.owes, reason: gate.reason, sessionExpiresAt: gate.sessionExpiresAt },

            challenge: challengeView(pending),
            portalUnlocked: Boolean(unlock),
            portalUnlockExpiresAt: unlock?.expires_at ?? null,
            consentVersion: CONSENT_VERSION,
            ageConsentVersion: AGE_CONSENT_VERSION,

            // Whether the anonymous route is both permitted here and runnable
            // on this deployment. Two separate facts, reported as one, because
            // the client does the same thing with either answer: do not draw
            // the camera option. Drawing it and failing at the end would be
            // worse than not offering it, since the viewer would have already
            // been photographed by then.
            selfieConsentVersion: SELFIE_CONSENT_VERSION,
            selfieOffered: offersSelfie(gate.policy) && selfieCheckGaps().length === 0,

            provider: getProvider().name,
            enforced: identityEnforced()
        });
    });

    /* ----------------------------------------------------------- jurisdiction -- */

    /**
     * Which gate this visitor gets, and the statute that says so.
     *
     * Unauthenticated on purpose. The client has to know whether to render a
     * button or a document flow *before* it knows who it is talking to - the
     * sign-up dialog needs it on the first paint - and the answer depends only
     * on where the request came from, which is not a secret from the person it
     * came from.
     *
     * Not cacheable by anything shared: the response is a function of the
     * viewer's address, and one cached copy served to the next viewer is how a
     * Texan gets California's gate.
     */
    router.get('/jurisdiction', (req, res) => {
        res.set('Cache-Control', 'private, no-store');

        const policy = jurisdictionFor(req);

        res.json({
            ...publicPolicy(policy),

            // A deployment fact rather than a statutory one, and the only
            // reason it rides along here: the dialog has to decide whether to
            // draw the camera option on its first paint, and offering a route
            // that would fail at the end is worse than not offering it, since
            // by then the viewer has already been photographed.
            selfieReady: offersSelfie(policy) && selfieCheckGaps().length === 0
        });
    });

    /**
     * "I am 18", in a state that asks for nothing more.
     *
     * Refused outright where a statute requires a real check, rather than
     * recorded-and-ignored. A row saying a Texan self-declared is not evidence
     * of anything except that we were asked to break the law and the only safe
     * thing to do with the request is to not have it succeed.
     */
    router.post('/attest', requireAuth, loadFullUser, rateLimit({ windowMs: 3600_000, max: 20 }), (req, res) => {
        const policy = jurisdictionFor(req);

        if (policy.tier !== 'attest') {
            res.status(403).json({
                error: 'age_assurance_required',
                reason: 'verification_required',
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

        const row = ageAttestations.record({
            userId: req.user.id,
            version: ATTESTATION_VERSION,
            region: policy.region,
            country: policy.country,
            resolvedBy: policy.resolvedBy,
            ip: req.ip,
            expiresAt: new Date(Date.now() + ATTESTATION_DAYS * 86_400_000).toISOString()
        });

        identityEvents.record({
            userId: req.user.id,
            kind: 'age_attested',
            outcome: 'ok',
            detail: `${policy.country ?? '??'}-${policy.region ?? '??'} via ${policy.resolvedBy}`
        });

        res.status(201).json({ attestation: ageAttestations.publicView(row) });
    });

    /* ----------------------------------------------------------- age assurance -- */

    /**
     * Prove you are old enough to be here.
     *
     * Open to any signed-in account, creator or not, and not gated on a role:
     * this is the check that has to happen before the catalogue is visible, and
     * a viewer is exactly who it is for.
     *
     * Open in a no-statute state too, even though nothing there requires it.
     * A document check is strictly stronger than the button, somebody who
     * crosses into Tennessee next week will need one anyway, and refusing to
     * let a willing viewer take the stronger option would be a rule with no
     * beneficiary.
     */
    router.post('/age', requireAuth, loadFullUser, rateLimit({ windowMs: 3600_000, max: 10 }), async (req, res) => {
        if (req.body?.consent !== true || req.body?.consentVersion !== AGE_CONSENT_VERSION) {
            res.status(400).json({
                error: 'consent to the current disclosure is required before the age check can start',
                consentVersion: AGE_CONSENT_VERSION
            });
            return;
        }

        const policy = jurisdictionFor(req);
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

        // The anonymous choice is not a variant of this flow. It used to be
        // routed here with an `anonymous: true` flag that the provider had no
        // way to honour, which meant a viewer who picked "keep nothing" got an
        // ordinary document session and a row saying they had chosen
        // otherwise. Refusing outright is the honest version: the route that
        // can keep that promise is `/age/selfie`, and a client that asks for
        // the old one is told where it went rather than quietly given the
        // other check.
        if (method === 'anonymous') {
            res.status(400).json({
                error: 'use_selfie_route',
                consentVersion: SELFIE_CONSENT_VERSION,
                jurisdiction: publicPolicy(policy)
            });
            return;
        }

        const existing = ageAssurances.byUser(req.user.id);

        // `ageGate` rather than `isCurrent`: in Tennessee a current assurance
        // whose hour has run out is not a reason to skip the check, it is the
        // reason to run it again.
        if (ageAssurances.isCurrent(existing) && ageGate(req).ok) {
            res.json({ status: 'verified', ageAssurance: ageAssurances.publicView(existing) });
            return;
        }

        if (refuseIfNotConfigured(res, 'age')) return;

        let handoff;
        try {
            handoff = await getProvider().startAgeCheck({
                userId: req.user.id,
                redirectUrl: returnUrlFor(req, 'age')
            });
        } catch (err) {
            console.error('[identity] age check could not be started:', err.message);
            identityEvents.record({ userId: req.user.id, kind: 'age_started', outcome: 'error', detail: err.message });
            failedToStart(res, err, 'the age check');
            return;
        }

        ageAssurances.start({
            userId: req.user.id,
            provider: getProvider().name,
            inquiryId: handoff.inquiryId,
            consentVersion: AGE_CONSENT_VERSION,
            consentIp: req.ip,
            method,
            jurisdiction: policy.region
        });

        identityEvents.record({ userId: req.user.id, kind: 'age_started', outcome: 'ok', providerRef: handoff.inquiryId });

        res.status(201).json({
            status: 'pending',
            inquiryId: handoff.inquiryId,
            clientUrl: handoff.clientUrl,
            clientToken: handoff.clientToken
        });
    });

    /**
     * The same anonymous route as the signed-out gate, for an account.
     *
     * A Florida viewer who happens to be signed in is still a Florida viewer,
     * and § 501.1737 does not make the anonymous option conditional on being a
     * stranger. Offering it only to signed-out visitors would mean the one
     * route that keeps nothing was unavailable to exactly the people who had
     * already given us a name - which is backwards.
     *
     * Everything about the check is shared with the gate, deliberately; see
     * [`selfie.js`](./selfie.js). The difference is the pass. A cookie is
     * bound to the place that issued it and simply stops meaning anything
     * elsewhere, whereas a row travels with the account, so the binding has to
     * be written down: the row records `method: 'anonymous'`, and
     * `assuranceSatisfies` refuses it in a state whose statute does not list
     * that method. A Florida estimate is a Florida pass, in both flows, by two
     * different mechanisms that have to agree.
     *
     * No `identityEvents` row is written for either outcome. Every other check
     * here logs one, and the departure is the point: an event saying this
     * account ran an age estimate at this time is a record of the check, and
     * the disclosure says there is not one. The row the pass produces is the
     * only trace, and it says a check passed rather than how it went.
     */
    router.post(
        '/age/selfie',
        requireAuth,
        loadFullUser,
        rateLimit({ windowMs: 3600_000, max: 8 }),
        selfieBody(),
        async (req, res) => {
            res.set('Cache-Control', 'no-store');

            const policy = jurisdictionFor(req);

            // A current pass is not a reason to photograph somebody again.
            // `ageGate` rather than `isCurrent`, for the same reason as the
            // document route above: in Tennessee an assurance whose hour has
            // run out is the reason to run the check, not to skip it.
            const existing = ageAssurances.byUser(req.user.id);
            if (ageAssurances.isCurrent(existing) && ageGate(req).ok) {
                res.json({ status: 'verified', ageAssurance: ageAssurances.publicView(existing) });
                return;
            }

            const verdict = await runSelfieEstimate(req, res, policy);
            if (!verdict) return;

            const row = ageAssurances.recordEstimate({
                userId: req.user.id,
                provider: getProvider().name,
                consentVersion: SELFIE_CONSENT_VERSION,
                // No ip, unlike the document route. There the address is part
                // of proving consent to a collection that really happened and
                // is held somewhere; here the account, the version and the
                // timestamp already prove it, and an address would be the one
                // piece of this row that records where somebody was rather
                // than that they passed.
                consentIp: null,
                method: 'anonymous',
                jurisdiction: policy.region,
                expiresAt: new Date(Date.now() + AGE_ASSURANCE_DAYS * 86_400_000).toISOString()
            });

            res.status(201).json({ status: 'verified', ageAssurance: ageAssurances.publicView(row) });
        }
    );

    /** As with enrolment: the inquiry id comes from our row, never the request. */
    router.post('/age/complete', requireAuth, loadFullUser, async (req, res) => {
        const row = ageAssurances.byUser(req.user.id);

        if (!row?.provider_inquiry_id) {
            res.status(409).json({ error: 'no age check is in progress' });
            return;
        }

        try {
            const updated = await pullAgeVerdict(req.user.id, row);
            res.json({ ageAssurance: ageAssurances.publicView(updated) });
        } catch (err) {
            console.error('[identity] age verdict unavailable:', err.message);
            res.status(502).json({ error: 'the age check result is not available yet' });
        }
    });

    /* -------------------------------------------------------------- enrolment -- */

    router.post(
        '/enrol',
        requireAuth,
        loadFullUser,
        requireRole('creator'),
        rateLimit({ windowMs: 3600_000, max: 10 }),
        async (req, res) => {
            // Consent is checked against the current version rather than merely
            // being truthy: agreeing to last year's disclosure is not agreeing
            // to this one, and the regimes that allow this processing treat
            // that distinction as the whole point.
            if (req.body?.consent !== true || req.body?.consentVersion !== CONSENT_VERSION) {
                res.status(400).json({
                    error: 'consent to the current disclosure is required before verification can start',
                    consentVersion: CONSENT_VERSION
                });
                return;
            }

            const existing = verifications.byUser(req.user.id);
            if (verifications.isCurrent(existing)) {
                res.json({ status: 'verified', verification: verifications.publicView(existing) });
                return;
            }

            if (refuseIfNotConfigured(res, 'enrol')) return;

            let handoff;
            try {
                handoff = await getProvider().startEnrolment({
                    userId: req.user.id,
                    redirectUrl: returnUrlFor(req, 'enrol')
                });
            } catch (err) {
                console.error('[identity] enrolment could not be started:', err.message);
                identityEvents.record({ userId: req.user.id, kind: 'enrolment_started', outcome: 'error', detail: err.message });
                failedToStart(res, err, 'verification');
                return;
            }

            verifications.startEnrolment({
                userId: req.user.id,
                provider: getProvider().name,
                inquiryId: handoff.inquiryId,
                consentVersion: CONSENT_VERSION,
                consentIp: req.ip
            });

            identityEvents.record({ userId: req.user.id, kind: 'consent', outcome: 'ok', detail: CONSENT_VERSION });
            identityEvents.record({
                userId: req.user.id,
                kind: 'enrolment_started',
                outcome: 'ok',
                providerRef: handoff.inquiryId
            });

            res.status(201).json({
                status: 'pending',
                inquiryId: handoff.inquiryId,
                clientUrl: handoff.clientUrl,
                clientToken: handoff.clientToken
            });
        }
    );

    /**
     * "I finished the flow" - which is a prompt to go and ask, not a result.
     *
     * The inquiry id comes from our own row, never from the request body: a
     * client that could name the inquiry to check could name somebody else's
     * successful one.
     *
     * An enrolment that resolves here also opens the portal, because enrolment
     * already is a face check: the adapter only reports `verified` when the
     * provider's liveness and face-match features both passed against the
     * document the creator just presented. Sending them straight on to a second
     * selfie would ask for weaker evidence thirty seconds after the stronger
     * kind, which is the same reasoning the broadcast challenge below is
     * written on.
     *
     * Only the call that resolves the verdict mints one. The row is re-read
     * before the poll, so a replay of this route finds it already verified and
     * gets nothing - otherwise anyone holding the session cookie could mint
     * unlocks forever and the per-session face check would be decoration.
     */
    router.post('/enrol/complete', requireAuth, loadFullUser, async (req, res) => {
        const row = verifications.byUser(req.user.id);

        if (!row?.provider_inquiry_id) {
            res.status(409).json({ error: 'no verification is in progress' });
            return;
        }

        const wasPending = row.status !== 'verified';

        try {
            const updated = await pullEnrolmentVerdict(req.user.id, row);
            const body = { verification: verifications.publicView(updated) };

            if (wasPending && verifications.isCurrent(updated)) {
                const unlock = mintPortalUnlock(req.user.id);
                body.unlockToken = unlock.token;
                body.unlockExpiresAt = unlock.expiresAt;
                identityEvents.record({
                    userId: req.user.id,
                    kind: 'portal_unlock_result',
                    outcome: 'ok',
                    providerRef: row.provider_inquiry_id,
                    detail: 'opened by enrolment'
                });
            }

            res.json(body);
        } catch (err) {
            console.error('[identity] enrolment verdict unavailable:', err.message);
            res.status(502).json({ error: 'the verification result is not available yet' });
        }
    });

    /* ------------------------------------------------------ phone: challenges -- */

    /**
     * The phone is signing in to broadcast.
     *
     * Creates the challenge and returns the code to display. No stream key is
     * issued here and none can be: the face check has not happened yet.
     */
    router.post(
        '/broadcast/challenge',
        requireAuth,
        loadFullUser,
        requireRole('creator'),
        requireVerifiedCreator,
        rateLimit({ windowMs: 60_000, max: 10 }),
        (req, res) => {
            challenges.expireStale();

            // One live prompt at a time. Two simultaneous approval dialogs are
            // indistinguishable to the person looking at them, which is exactly
            // the confusion the code is meant to prevent.
            const outstanding = challenges.pendingForUser(req.user.id);
            if (outstanding) challenges.resolve(outstanding.id, 'expired', { declineReason: 'superseded' });

            // Checked before the challenge is created and before the provider is
            // called, so a creator who picked somebody that has since closed
            // their tab is told so instead of being sent for a selfie first.
            if (req.body?.viewerId && !rooms.waiting().some((v) => v.id === req.body.viewerId)) {
                res.status(409).json({ error: 'that viewer is no longer waiting', code: 'viewer_gone' });
                return;
            }

            const row = challenges.create({
                userId: req.user.id,
                code: newChallengeCode(),
                deviceLabel: typeof req.body?.device === 'string' ? req.body.device : null,
                deviceIp: req.ip,
                ttlSeconds: CHALLENGE_TTL_SECONDS
            });

            identityEvents.record({ userId: req.user.id, kind: 'challenge_created', outcome: 'ok', providerRef: row.id });

            res.status(201).json({ challenge: challengeView(row), pollAfterMs: 2000 });
        }
    );

    /**
     * The device's poll, and where its stream key is handed over.
     *
     * Minted on read rather than at approval time so that a key only ever comes
     * into existence once there is a device holding it. An approval the device
     * never collected leaves nothing behind to revoke.
     */
    router.get('/broadcast/challenge/:id', requireAuth, loadFullUser, (req, res) => {
        const row = challenges.byId(req.params.id);

        // Same answer for "not a challenge" and "not yours", so challenge ids
        // cannot be probed for existence.
        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such challenge' });
            return;
        }

        if (expiredNow(row)) {
            challenges.resolve(row.id, 'expired');
            res.json({ status: 'expired', challenge: challengeView(challenges.byId(row.id)) });
            return;
        }

        if (row.status !== 'approved') {
            res.json({ status: row.status, challenge: challengeView(row), pollAfterMs: 2000 });
            return;
        }

        const minted = mintBroadcastGrant({ userId: req.user.id, challengeId: row.id });
        challenges.consume(row.id);

        res.json({
            status: 'approved',
            grant: minted.token,
            expiresAt: minted.expiresAt,
            resumeSeconds: minted.resumeSeconds
        });
    });

    /* ------------------------------------------------ browser: portal unlock -- */

    /**
     * Open the creator portal with a face check.
     *
     * The same mechanism as a broadcast face check - a selfie inquiry bound to
     * the enrolled account - applied one step earlier. A password proves an
     * account was signed into at some point; this proves who is looking at the
     * page that hands out broadcast destinations.
     */
    router.post(
        '/portal/unlock',
        requireAuth,
        loadFullUser,
        requireRole('creator'),
        requireVerifiedCreator,
        rateLimit({ windowMs: 60_000, max: 10 }),
        async (req, res) => {
            // Ahead of expireStale and the challenge row: a check that cannot
            // run must not supersede this creator's outstanding one or leave a
            // challenge behind that nothing will ever resolve.
            if (refuseIfNotConfigured(res, 'face')) return;

            challenges.expireStale();

            const outstanding = challenges.pendingForUser(req.user.id);
            if (outstanding) challenges.resolve(outstanding.id, 'expired', { declineReason: 'superseded' });

            // Checked before the challenge is created and before the provider is
            // called, so a creator who picked somebody that has since closed
            // their tab is told so instead of being sent for a selfie first.
            if (req.body?.viewerId && !rooms.waiting().some((v) => v.id === req.body.viewerId)) {
                res.status(409).json({ error: 'that viewer is no longer waiting', code: 'viewer_gone' });
                return;
            }

            const row = challenges.create({
                userId: req.user.id,
                code: newChallengeCode(),
                deviceLabel: 'portal',
                deviceIp: req.ip,
                ttlSeconds: CHALLENGE_TTL_SECONDS
            });

            let handoff;
            try {
                handoff = await getProvider().startFaceCheck({
                    userId: req.user.id,
                    subjectId: req.verification.provider_subject_id
                });
            } catch (err) {
                challenges.resolve(row.id, 'expired', { declineReason: 'face check unavailable' });
                console.error('[identity] portal face check could not be started:', err.message);
                failedToStart(res, err, 'the face check', req.user.id);
                return;
            }

            challenges.attachProviderRef(row.id, handoff.inquiryId);
            identityEvents.record({ userId: req.user.id, kind: 'portal_unlock_started', outcome: 'ok', providerRef: row.id });

            res.status(201).json({
                id: row.id,
                clientUrl: handoff.clientUrl,
                clientToken: handoff.clientToken,
                expiresAt: row.expires_at
            });
        }
    );

    /**
     * Collect the verdict and, if it passed, the unlock token.
     *
     * The raw token is returned exactly once. The browser puts it in
     * `sessionStorage`, which is what makes the user's "once per browser
     * session" hold: a new tab, a new browser or a sign-out all start again.
     */
    router.post('/portal/unlock/:id/complete', requireAuth, loadFullUser, async (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such verification' });
            return;
        }

        if (row.status !== 'pending' || expiredNow(row)) {
            res.status(409).json({ error: 'that verification is no longer waiting' });
            return;
        }

        if (!row.provider_ref) {
            res.status(409).json({ error: 'the face check has not been started' });
            return;
        }

        let verdict;
        try {
            verdict = await getProvider().fetchFaceCheck(row.provider_ref);
        } catch (err) {
            console.error('[identity] portal face verdict unavailable:', err.message);
            res.status(502).json({ error: 'the face check result is not available yet' });
            return;
        }

        if (verdict.status === 'pending') {
            res.json({ status: 'pending', pollAfterMs: 2000 });
            return;
        }

        const approved = verdict.status === 'passed';
        challenges.resolve(row.id, approved ? 'approved' : 'denied', {
            providerRef: row.provider_ref,
            declineReason: approved ? null : verdict.reason
        });

        identityEvents.record({
            userId: req.user.id,
            kind: 'portal_unlock_result',
            outcome: approved ? 'ok' : 'failed',
            providerRef: row.provider_ref,
            detail: verdict.reason
        });

        if (!approved) {
            res.status(403).json({ status: 'denied', reason: verdict.reason ?? null });
            return;
        }

        // Consumed so the same approval cannot also be redeemed as a stream
        // key by the challenge poll - one face check, one thing.
        const unlock = mintPortalUnlock(req.user.id, row.id);
        challenges.consume(row.id);

        res.json({ status: 'approved', unlockToken: unlock.token, expiresAt: unlock.expiresAt });
    });

    /* ------------------------------------------ browser: broadcast destination -- */

    /**
     * The path the capture app actually uses - by not being involved in it.
     *
     * The creator verifies their face here, in the browser, on an account this
     * server already knows. What comes back is one pasteable destination link
     * carrying a durable stream key. They type it into the capture app, which
     * has no account, no sign-in, and no idea that any of this happened.
     *
     * That separation is the point. The capture app is a general-purpose
     * broadcasting tool that sends video to an address; this endpoint is how
     * *this* platform decides who is allowed to be that address's source. A
     * different platform, or a creator running their own server, uses the same
     * app with a destination it issues however it likes.
     *
     * No challenge code is involved. The code exists to bind a browser's
     * approval to a particular *other* device, and here there is no other
     * device - the key is handed to the same session that passed the face
     * check, and the creator carries it by hand.
     *
     * Two shapes come back. A session that already passed the portal face check
     * gets `status: 'approved'` and the destination immediately - asking the
     * same person for a second selfie thirty seconds after the first one
     * teaches them that the check is noise. Any other session gets
     * `status: 'face_check'` and the hand-off, as before.
     *
     * Either way the grant inside the destination is good for one broadcast and
     * a few minutes, so this endpoint is called once per broadcast rather than
     * once per device.
     *
     * An optional `viewerId` names somebody off the waiting list. Supplying one
     * makes the broadcast private to that viewer's screen and nobody else's;
     * leaving it out produces exactly the link this endpoint has always
     * produced, for a broadcast anyone on the server can watch. The link itself
     * is identical either way - see `server/live/rooms.js` for why the room is
     * bound to the grant here rather than written into the QR code.
     */
    router.post(
        '/broadcast/destination',
        requireAuth,
        loadFullUser,
        requireRole('creator'),
        requireVerifiedCreator,
        rateLimit({ windowMs: 60_000, max: 10 }),
        async (req, res) => {
            challenges.expireStale();

            const unlock = readPortalUnlock(req, req.user.id);
            if (unlock) {
                const name = destinationName(req.body?.name, req.user);

                // Reserved before the grant is minted, so a viewer who left
                // between the click and this line costs a rejected request
                // rather than a live credential handed out for a room that
                // cannot be filled.
                // No challenge id on this one: the grant is bound in the next
                // two lines, so there is nothing to find the room by later, and
                // parking a consumed challenge's id on it would leave something
                // for `/complete` to match by accident.
                let room;
                try {
                    room = reserveRoom(req, null);
                } catch (err) {
                    res.status(409).json({ error: err.message, code: err.code ?? null });
                    return;
                }

                const minted = mintBroadcastGrant({
                    userId: req.user.id,
                    challengeId: unlock.challenge_id
                });
                rooms.bindGrant(room, minted.id);

                res.status(201).json({
                    status: 'approved',
                    destination: buildPairingUrl({ req, key: minted.token, name }),
                    expiresAt: minted.expiresAt,
                    resumeSeconds: minted.resumeSeconds,
                    room: room?.publicView() ?? null
                });
                return;
            }

            // After the unlock shortcut above, deliberately. That path mints a
            // grant from a face check that already ran and needs no provider
            // call, so a missing template must not retract an authorisation
            // this creator has genuinely earned.
            if (refuseIfNotConfigured(res, 'face')) return;

            const outstanding = challenges.pendingForUser(req.user.id);
            if (outstanding) challenges.resolve(outstanding.id, 'expired', { declineReason: 'superseded' });

            // Checked before the challenge is created and before the provider is
            // called, so a creator who picked somebody that has since closed
            // their tab is told so instead of being sent for a selfie first.
            if (req.body?.viewerId && !rooms.waiting().some((v) => v.id === req.body.viewerId)) {
                res.status(409).json({ error: 'that viewer is no longer waiting', code: 'viewer_gone' });
                return;
            }

            // The requested name is parked on the challenge so it survives to
            // `/complete`, which has no body of its own. `device_label` is
            // already a free-form label rather than a device identifier - the
            // phone path puts a model name in it - and this is the same kind of
            // thing: what the creator is about to call the destination.
            const row = challenges.create({
                userId: req.user.id,
                code: newChallengeCode(),
                deviceLabel: destinationName(req.body?.name, req.user),
                deviceIp: req.ip,
                ttlSeconds: CHALLENGE_TTL_SECONDS
            });

            let handoff;
            try {
                handoff = await getProvider().startFaceCheck({
                    userId: req.user.id,
                    subjectId: req.verification.provider_subject_id
                });
            } catch (err) {
                challenges.resolve(row.id, 'expired', { declineReason: 'face check unavailable' });
                console.error('[identity] face check could not be started:', err.message);
                failedToStart(res, err, 'the face check', req.user.id);
                return;
            }

            challenges.attachProviderRef(row.id, handoff.inquiryId);
            identityEvents.record({ userId: req.user.id, kind: 'challenge_created', outcome: 'ok', providerRef: row.id });

            // Parked against the challenge, the same way the destination name
            // is, and for the same reason: `/complete` has no body of its own
            // and the viewer the creator chose has to survive the face check.
            // A room reserved for a check that is abandoned expires on its own.
            let room = null;
            try {
                room = reserveRoom(req, row.id);
            } catch (err) {
                challenges.resolve(row.id, 'expired', { declineReason: err.message });
                res.status(409).json({ error: err.message, code: err.code ?? null });
                return;
            }

            // No `code` in this response: there is no second screen to compare
            // it against, and a value with no purpose is one somebody builds a
            // purpose for later.
            res.status(201).json({
                status: 'face_check',
                id: row.id,
                clientUrl: handoff.clientUrl,
                clientToken: handoff.clientToken,
                expiresAt: row.expires_at,
                room: room?.publicView() ?? null
            });
        }
    );

    /**
     * Collect the verdict and, if it passed, the destination.
     *
     * The key is minted here rather than at approval, so a creator who
     * abandons the browser window mid-check does not leave a live credential
     * behind them. It is the last step, and it is the only one that writes one.
     */
    router.post('/broadcast/destination/:id/complete', requireAuth, loadFullUser, async (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such verification' });
            return;
        }

        if (row.status !== 'pending' || expiredNow(row)) {
            res.status(409).json({ error: 'that verification is no longer waiting' });
            return;
        }

        if (!row.provider_ref) {
            res.status(409).json({ error: 'the face check has not been started' });
            return;
        }

        let verdict;
        try {
            verdict = await getProvider().fetchFaceCheck(row.provider_ref);
        } catch (err) {
            console.error('[identity] face verdict unavailable:', err.message);
            res.status(502).json({ error: 'the face check result is not available yet' });
            return;
        }

        if (verdict.status === 'pending') {
            res.json({ status: 'pending', pollAfterMs: 2000 });
            return;
        }

        const approved = verdict.status === 'passed';
        challenges.resolve(row.id, approved ? 'approved' : 'denied', {
            providerRef: row.provider_ref,
            declineReason: approved ? null : verdict.reason
        });

        identityEvents.record({
            userId: req.user.id,
            kind: 'challenge_result',
            outcome: approved ? 'ok' : 'failed',
            providerRef: row.provider_ref,
            detail: verdict.reason
        });

        if (!approved) {
            res.status(403).json({ status: 'denied', reason: verdict.reason ?? null });
            return;
        }

        // Both parked on the challenge when the destination was requested: the
        // name in a column, the chosen viewer in the room registry.
        const name = destinationName(row.device_label, req.user);
        const minted = mintBroadcastGrant({ userId: req.user.id, challengeId: row.id });
        const room = rooms.bindGrant(rooms.byChallenge(row.id), minted.id);
        challenges.consume(row.id);

        res.json({
            status: 'approved',
            destination: buildPairingUrl({ req, key: minted.token, name }),
            expiresAt: minted.expiresAt,
            resumeSeconds: minted.resumeSeconds,
            room: room?.publicView() ?? null
        });
    });

    /** The creator gave up, or the app was closed. */
    router.post('/broadcast/challenge/:id/cancel', requireAuth, loadFullUser, (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such challenge' });
            return;
        }

        challenges.resolve(row.id, 'denied', { declineReason: 'cancelled on the device' });

        // Releases whoever the creator had chosen back onto the waiting list
        // straight away, rather than leaving them reserved for a check that is
        // not going to finish.
        rooms.close(rooms.byChallenge(row.id), 'the creator cancelled');

        res.status(204).end();
    });

    /* ---------------------------------------------------- browser: face check -- */

    /**
     * Start the face check for a pending challenge.
     *
     * The code must match first. A mismatch does not offer another go: the only
     * innocent explanation is a typo, and the guilty one is that the prompt
     * belongs to somebody else's phone, so the safe reading of a wrong code is
     * to kill the challenge and make the real device start again.
     */
    router.post('/challenges/:id/face-check', requireAuth, loadFullUser, async (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such challenge' });
            return;
        }

        if (row.status !== 'pending' || expiredNow(row)) {
            res.status(409).json({ error: 'that sign-in is no longer waiting', challenge: challengeView(row) });
            return;
        }

        if (!codeMatches(req.body?.code, row.code)) {
            challenges.resolve(row.id, 'denied', { declineReason: 'the code did not match' });
            identityEvents.record({ userId: req.user.id, kind: 'challenge_result', outcome: 'failed', providerRef: row.id, detail: 'code mismatch' });
            res.status(400).json({ error: 'that code does not match the one on the device. The sign-in was refused.' });
            return;
        }

        const verification = verifications.byUser(req.user.id);
        if (!verifications.isCurrent(verification)) {
            res.status(403).json({ error: 'identity verification required', verification: verifications.publicView(verification) });
            return;
        }

        // The challenge is left pending rather than denied: nothing about it
        // failed, and the device waiting on it should keep waiting rather than
        // be told its sign-in was refused.
        if (refuseIfNotConfigured(res, 'face')) return;

        let handoff;
        try {
            handoff = await getProvider().startFaceCheck({
                userId: req.user.id,
                subjectId: verification.provider_subject_id
            });
        } catch (err) {
            console.error('[identity] face check could not be started:', err.message);
            failedToStart(res, err, 'the face check', req.user.id);
            return;
        }

        challenges.attachProviderRef(row.id, handoff.inquiryId);

        res.json({ inquiryId: handoff.inquiryId, clientUrl: handoff.clientUrl, clientToken: handoff.clientToken });
    });

    /** The browser finished the flow; go and ask the provider what happened. */
    router.post('/challenges/:id/complete', requireAuth, loadFullUser, async (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such challenge' });
            return;
        }

        if (row.status !== 'pending' || expiredNow(row)) {
            res.status(409).json({ error: 'that sign-in is no longer waiting', challenge: challengeView(row) });
            return;
        }

        if (!row.provider_ref) {
            res.status(409).json({ error: 'the face check has not been started' });
            return;
        }

        let verdict;
        try {
            verdict = await getProvider().fetchFaceCheck(row.provider_ref);
        } catch (err) {
            console.error('[identity] face verdict unavailable:', err.message);
            res.status(502).json({ error: 'the face check result is not available yet' });
            return;
        }

        if (verdict.status === 'pending') {
            res.json({ status: 'pending', challenge: challengeView(row) });
            return;
        }

        const approved = verdict.status === 'passed';
        const updated = challenges.resolve(row.id, approved ? 'approved' : 'denied', {
            providerRef: row.provider_ref,
            declineReason: approved ? null : verdict.reason
        });

        identityEvents.record({
            userId: req.user.id,
            kind: 'challenge_result',
            outcome: approved ? 'ok' : 'failed',
            providerRef: row.provider_ref,
            detail: verdict.reason
        });

        res.json({ status: approved ? 'approved' : 'denied', challenge: challengeView(updated) });
    });

    /** "That is not me." */
    router.post('/challenges/:id/deny', requireAuth, loadFullUser, (req, res) => {
        const row = challenges.byId(req.params.id);

        if (!row || row.user_id !== req.user.id) {
            res.status(404).json({ error: 'no such challenge' });
            return;
        }

        challenges.resolve(row.id, 'denied', { declineReason: 'refused in the browser' });

        // A creator saying "I did not start this" is a report that somebody
        // else has their password, so every stream key they hold goes too, and
        // so does every open portal. Keys do not expire on their own any more,
        // so this is the whole remedy rather than a way to hurry one along.
        revokeBroadcastGrants(req.user.id);
        revokePortalUnlocks(req.user.id);
        identityEvents.record({ userId: req.user.id, kind: 'challenge_result', outcome: 'failed', providerRef: row.id, detail: 'denied by the creator' });

        res.status(204).end();
    });

    /* ------------------------------------------------------------- withdrawal -- */

    /**
     * Withdraw consent.
     *
     * Deletes our reference, tells the provider to redact what they hold, and
     * cuts every live stream key. Ordered so that a provider failure leaves the row in
     * place: a stranded account is recoverable, a stranded biometric with no
     * remaining handle to it is not.
     */
    router.delete('/me', requireAuth, loadFullUser, async (req, res) => {
        const row = verifications.byUser(req.user.id);

        if (!row) {
            // No enrolment to redact, but an age check may still have left a
            // row behind - a viewer who never became a creator has one and
            // nothing else, and "delete what you hold" has to include it. So
            // does the attestation, which is the only row most viewers have.
            ageAssurances.forget(req.user.id);
            ageAttestations.forget(req.user.id);
            revokePortalUnlocks(req.user.id);
            notify('identity-forgotten', req.user);
            res.status(204).end();
            return;
        }

        if (row.provider_subject_id) {
            try {
                await getProvider().forget(row.provider_subject_id);
            } catch (err) {
                console.error('[identity] provider redaction failed:', err.message);
                identityEvents.record({ userId: req.user.id, kind: 'purged', outcome: 'error', detail: err.message });
                res.status(502).json({ error: 'the provider could not be reached; nothing was deleted' });
                return;
            }
        }

        verifications.forget(req.user.id);
        ageAssurances.forget(req.user.id);
        ageAttestations.forget(req.user.id);
        revokeBroadcastGrants(req.user.id);
        revokePortalUnlocks(req.user.id);
        identityEvents.record({ userId: req.user.id, kind: 'purged', outcome: 'ok' });

        // A deletion is one of the things somebody may later need to show was
        // asked for and acted on, and the acknowledgement is the evidence.
        notify('identity-forgotten', req.user);

        res.status(204).end();
    });

    /** The creator's own audit trail. They are entitled to it; it holds no biometric. */
    router.get('/events', requireAuth, loadFullUser, (req, res) => {
        res.json({
            events: identityEvents.forUser(req.user.id, 100).map((row) => ({
                kind: row.kind,
                outcome: row.outcome,
                detail: row.detail,
                at: row.created_at
            }))
        });
    });

    app.use('/api/identity', router);
}
