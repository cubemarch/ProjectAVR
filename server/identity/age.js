import { ageAssurances, identityEvents, verifications } from '../db/index.js';
import { getProvider, identityEnforced, AGE_ASSURANCE_DAYS } from './providers.js';

/**
 * Age assurance for every account, not just creators.
 *
 * An adult platform has to know that the person watching is an adult, and the
 * only answer that survives contact with a regulator is a document check. This
 * is the weaker of the two identity flows on purpose - it reads a birthdate off
 * a document and keeps a boolean. No selfie is captured, nothing is enrolled,
 * and a viewer is never asked to confirm their face. Creators pass through this
 * *and* the enrolment in `verifications`, because the two answer different
 * questions and collapsing them would mean face-binding every viewer.
 */

/** Verdicts come from the provider; a client saying "I passed" means nothing. */
export async function pullAgeVerdict(userId, row) {
    const verdict = await getProvider().fetchAgeCheck(row.provider_inquiry_id);

    if (verdict.status === 'pending') return ageAssurances.byUser(userId);

    const expiresAt =
        verdict.status === 'verified' && verdict.adultConfirmed
            ? new Date(Date.now() + AGE_ASSURANCE_DAYS * 86_400_000).toISOString()
            : null;

    const updated = ageAssurances.resolve(userId, { ...verdict, expiresAt });

    identityEvents.record({
        userId,
        kind: 'age_result',
        outcome: ageAssurances.isCurrent(updated) ? 'ok' : 'failed',
        providerRef: row.provider_inquiry_id,
        detail: verdict.declineReason
    });

    return updated;
}

/**
 * Whether this account has had an adult birthdate read off a document.
 *
 * Two flows can establish that, and either is enough. The age check reads a
 * birthdate and keeps a boolean. The creator enrolment reads the same
 * birthdate off the same kind of document and additionally matches a live face
 * to it - `fetchEnrolment` refuses outright unless the document says adult, so
 * a current verification is strictly stronger evidence than a current age
 * assurance, not weaker.
 *
 * The alternative - writing an `age_assurances` row when a creator enrols -
 * was rejected. That row carries a consent version, an ip and a timestamp for
 * the age disclosure, and a creator who went through enrolment never saw that
 * disclosure. Recording it would be fabricating a consent. Deriving the answer
 * from the two rows that do exist costs one extra lookup and claims nothing
 * that did not happen.
 *
 * @param {{id: string, role?: string}} user
 */
export function adultConfirmed(user) {
    if (!user) return false;
    if (ageAssurances.isCurrent(ageAssurances.byUser(user.id))) return true;

    if (user.role === 'viewer') return false;

    const verification = verifications.byUser(user.id);
    return verifications.isCurrent(verification) && Boolean(verification.adult_confirmed);
}

/**
 * Gate for anything that shows the catalogue.
 *
 * Unlike {@link import('./broadcast.js').requireVerifiedCreator}, this one
 * respects `AVR_IDENTITY_ENFORCE`. The difference is not an inconsistency: that
 * gate refuses to hand an unverified account the ability to broadcast under any
 * configuration, whereas this one would lock every existing account and every
 * test fixture out of a fresh checkout backed by the mock - which approves
 * everyone anyway, so enforcing it there would prove nothing and cost a lot.
 *
 * `assertIdentityConfigured()` is what makes that safe: enforcement cannot be
 * switched on while the mock is the provider.
 */
export function requireAgeAssurance(req, res, next) {
    if (!identityEnforced()) {
        next();
        return;
    }

    // An admin who cannot see the catalogue cannot moderate it, and an admin
    // account is created deliberately rather than signed up for.
    if (req.user?.role === 'admin') {
        next();
        return;
    }

    if (!adultConfirmed(req.user)) {
        res.status(403).json({
            error: 'age_assurance_required',
            ageAssurance: ageAssurances.publicView(ageAssurances.byUser(req.user.id))
        });
        return;
    }

    next();
}
