import express from 'express';

import { getProvider, identityGaps, SELFIE_CONSENT_VERSION } from './providers.js';
import { publicPolicy } from './jurisdiction.js';

/**
 * The anonymous age check, shared by the two surfaces that offer it.
 *
 * Florida's § 501.1737 requires that a viewer be offered a route that proves
 * adulthood without handing over a document, and that whoever runs it keeps
 * nothing. That is a promise about what is *not* written down, which makes it
 * the one check in this codebase where a second implementation drifting from
 * the first is a broken statutory claim rather than an inconsistency. So the
 * whole of it - the preconditions, the provider call, the shape of a decline -
 * lives here, and the two routes differ only in what they do with a pass: the
 * signed-out gate sets a place-bound cookie, the signed-in one writes a row.
 *
 * Nothing in this file logs a verdict, passes a correlation handle to the
 * provider, or keeps the image past the end of the request.
 */

/**
 * What the camera may send, and how much of it.
 *
 * An allow-list rather than "anything image/*", because the list is the
 * provider's and not ours - a format they will not decode comes back as
 * NO_FACE_DETECTED, which reads to the visitor as "your face was not visible"
 * when the truth is that nothing was ever looked at. Refusing it here says the
 * right thing.
 *
 * Two megabytes is well past what the captures in `src/ui/` produce (both
 * downscale to 960px first) and well under Didit's own five. The gap is for a
 * browser whose canvas encoder is unusually generous, not for a full-resolution
 * phone photo, which would be a slow upload of detail the model discards.
 */
export const SELFIE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_SELFIE_BYTES = 2 * 1024 * 1024;

/**
 * The consent version, as a header, because the body is a photograph.
 *
 * It doubles as the CSRF defence. A custom header cannot be set by a form post
 * or an `<img>`, so a cross-origin page cannot reach either route without a
 * preflight it will not get - and without that, any site on the internet could
 * quietly mint an age pass in a visitor's browser by posting a picture of an
 * adult.
 */
export const CONSENT_HEADER = 'x-avr-consent-version';

/**
 * Declines the viewer can do something about by trying again.
 *
 * `age_below_minimum` is deliberately absent: a second photograph of the same
 * face returns the same estimate, and inviting a retake would be inviting
 * somebody to keep paying for the same answer. That one goes to the document
 * route, which is the whole reason the floor can afford to be twenty-five.
 * `liveness_face_attack` is absent too - it means a screen or a printed photo
 * was held up, and the answer to that is not a better screen.
 */
export const RETRYABLE_DECLINES = new Set([
    'no_face_detected',
    'low_liveness_score',
    'age_not_detected',
    'more_than_one_face'
]);

/**
 * Body parser for a selfie route.
 *
 * Mounted per route rather than on a router so that the 2 MB ceiling applies
 * to the one endpoint that carries an image and every neighbouring JSON route
 * keeps its much smaller limit. `express.json` only parses a matching
 * Content-Type, so a raw `image/jpeg` body passes through it untouched and
 * arrives here still a Buffer.
 */
export function selfieBody() {
    return express.raw({ type: SELFIE_TYPES, limit: MAX_SELFIE_BYTES });
}

/**
 * Whether this deployment can run a selfie estimate at all.
 *
 * Three ways it cannot, and all three mean the route is not offered rather
 * than offered and broken: the provider has no such endpoint (Persona), the
 * provider is the mock in production (it would approve a photograph of a
 * wall), or the key is missing. The first is a capability and the other two
 * are configuration, but the viewer experiences them identically, so they are
 * answered together.
 *
 * @returns {string[]} reasons, empty if the estimate can really run
 */
export function selfieCheckGaps() {
    let provider;
    try {
        provider = getProvider();
    } catch {
        return ['AVR_IDENTITY_PROVIDER'];
    }

    if (typeof provider.estimateAge !== 'function') return ['provider_has_no_age_estimation'];
    if (process.env.NODE_ENV === 'production' && provider.isMock) return ['AVR_IDENTITY_PROVIDER'];

    return identityGaps('selfie');
}

/**
 * Whether this policy offers the anonymous route at all.
 *
 * Offered only where the statute names it, which today is Florida alone.
 * Everywhere else in the twenty-seven the legislature listed the methods it
 * considers reasonable and an age estimate is not among them, so running one
 * there would be substituting our judgement for theirs. In a no-statute state
 * it is not offered either - unlike the document check, which a willing viewer
 * may take anywhere because it is strictly stronger than the button, an
 * estimate is strictly weaker, and there is nobody it would benefit.
 *
 * @param {import('./jurisdiction.js').Policy} policy
 */
export function offersSelfie(policy) {
    return policy.tier === 'verified' && policy.methods.includes('anonymous');
}

/**
 * Run the estimate, or answer the request saying why it could not be run.
 *
 * Every refusal the two routes share is here, in the order that leaks least:
 * the jurisdiction questions are settled before the consent header is read,
 * and the consent header before the body is touched, so a request that was
 * never going to be allowed is turned away without the image being looked at.
 *
 * What this deliberately does not do:
 *
 *   - **No pending record of any kind.** The document flow needs one because
 *     it hands off to a popup and comes back later; this call answers in the
 *     same response, and a reference that never exists cannot be correlated
 *     with anything.
 *   - **No `vendor_data`.** The provider is sent the photograph and nothing
 *     else. Passing even a random per-attempt id would create a correlation
 *     handle, and there would then be something to erase - when the entire
 *     point is that there is not.
 *   - **No log of the outcome.** Provider *errors* are logged because somebody
 *     has to be able to fix them; verdicts are not, because a line saying a
 *     check from this address was declined is exactly the record the
 *     disclosure promises nobody keeps.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('./jurisdiction.js').Policy} policy
 * @returns {Promise<import('./providers.js').EstimateVerdict|null>} the verdict
 *   on a pass, or null when `res` has already been answered
 */
export async function runSelfieEstimate(req, res, policy) {
    if (policy.tier !== 'verified') {
        res.status(400).json({
            error: 'no_verification_required',
            owes: 'attestation',
            jurisdiction: publicPolicy(policy)
        });
        return null;
    }

    if (!offersSelfie(policy)) {
        res.status(400).json({
            error: 'anonymous_verification_not_offered',
            jurisdiction: publicPolicy(policy)
        });
        return null;
    }

    if (req.get(CONSENT_HEADER) !== SELFIE_CONSENT_VERSION) {
        res.status(400).json({
            error: 'consent to the current disclosure is required before the age check can start',
            consentVersion: SELFIE_CONSENT_VERSION
        });
        return null;
    }

    if (selfieCheckGaps().length) {
        res.status(503).json({
            error: 'anonymous verification is not set up on this server yet',
            code: 'identity_not_configured',
            retryable: false
        });
        return null;
    }

    // Reachable when the Content-Type was not one `express.raw` was told to
    // parse, in which case `req.body` is still the `{}` that never got
    // replaced.
    const image = Buffer.isBuffer(req.body) ? req.body : null;
    if (!image?.length) {
        res.status(415).json({ error: 'send one photograph as the request body', accepts: SELFIE_TYPES });
        return null;
    }

    let verdict;
    try {
        verdict = await getProvider().estimateAge({ image, mimeType: req.get('content-type') });
    } catch (err) {
        // The message, never the image, and never anything derived from it.
        console.error('[identity] selfie age estimate failed:', err.message);
        res.status(502).json({ error: 'the age check could not be completed', retryable: true });
        return null;
    }

    if (verdict.status !== 'verified' || !verdict.adultConfirmed) {
        const reason = verdict.declineReason ?? 'declined';
        res.json({ status: 'rejected', reason, canRetry: RETRYABLE_DECLINES.has(reason) });
        return null;
    }

    return verdict;
}
