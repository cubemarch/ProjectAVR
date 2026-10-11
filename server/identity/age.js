import { ageAssurances, ageAttestations, identityEvents, users, verifications } from '../db/index.js';
import { notify } from '../mail/index.js';
import { getProvider, identityEnforced, AGE_ASSURANCE_DAYS } from './providers.js';
import { atLeast } from '../../src/auth/roles.js';
import { assuranceSatisfies, attestationSatisfies, jurisdictionFor, publicPolicy } from './jurisdiction.js';

/**
 * Age assurance for every account, not just creators.
 *
 * An adult platform has to know that the person watching is an adult. In
 * twenty-seven states the only answer that survives contact with a regulator is
 * a document check, so that is what those viewers get: the weaker of the two
 * identity flows, which reads a birthdate off a document and keeps a boolean.
 * No selfie is captured, nothing is enrolled, and a viewer is never asked to
 * confirm their face. Creators pass through this *and* the enrolment in
 * `verifications`, because the two answer different questions and collapsing
 * them would mean face-binding every viewer.
 *
 * Everywhere else a viewer gets a button, because no statute asks for more and
 * demanding a government document from somebody no law requires us to check is
 * a privacy cost we would be imposing on our own initiative. Which of the two
 * a given request owes is {@link import('./jurisdiction.js')}'s decision, not
 * this file's.
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
    const passed = ageAssurances.isCurrent(updated);

    identityEvents.record({
        userId,
        kind: 'age_result',
        outcome: passed ? 'ok' : 'failed',
        providerRef: row.provider_inquiry_id,
        detail: verdict.declineReason
    });

    // Both outcomes are worth an email. A pass is the thing they were waiting
    // for; a decline is the one they will otherwise sit staring at a spinner
    // over, because the browser that started the check may be long closed by
    // the time the provider makes up its mind.
    notify(
        passed ? 'age-verified' : 'age-declined',
        users.byId(userId),
        passed ? { expiresAt } : { reason: verdict.declineReason ?? null }
    );

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
 * What this request owes before it may see anything, and why.
 *
 * The region is resolved per request rather than read off the account, and
 * that is deliberate: people travel. An account that attested in Oregon and
 * then opens the site from Dallas is a Texas request, and Texas wants a
 * document. Caching the answer on the user row would be one database column
 * and a standing compliance hole.
 *
 * @param {import('express').Request} req
 * @returns {{ok: boolean, owes: 'verification'|'attestation'|null, reason: string|null,
 *            policy: import('./jurisdiction.js').Policy, sessionExpiresAt: string|null}}
 */
export function ageGate(req) {
    const policy = jurisdictionFor(req);
    const user = req.user ?? null;

    if (policy.tier === 'attest') {
        // A document check is strictly more than this state asked for, so a
        // viewer who has one is through. The reverse never holds; see
        // `attestationSatisfies`.
        if (adultConfirmed(user)) return { ok: true, owes: null, reason: null, policy, sessionExpiresAt: null };

        const attested = attestationSatisfies(policy, user ? ageAttestations.byUser(user.id) : null);

        return attested.ok
            ? { ok: true, owes: null, reason: null, policy, sessionExpiresAt: null }
            : { ok: false, owes: 'attestation', reason: attested.reason, policy, sessionExpiresAt: null };
    }

    if (!adultConfirmed(user)) {
        return { ok: false, owes: 'verification', reason: 'no_assurance', policy, sessionExpiresAt: null };
    }

    // Tennessee is the only state that makes this more than a formality: the
    // verified session may not outlive sixty minutes, so a check that was good
    // an hour ago is not good now. Everywhere else `sessionMinutes` is null and
    // this returns ok without looking at the clock.
    const session = assuranceSatisfies(policy, ageAssurances.byUser(user.id));

    return session.ok
        ? { ok: true, owes: null, reason: null, policy, sessionExpiresAt: session.expiresAt }
        : { ok: false, owes: 'verification', reason: session.reason, policy, sessionExpiresAt: session.expiresAt };
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
 *
 * The 403 carries the whole policy rather than a bare error code, because the
 * client has to render a different gate for each tier and a second round trip
 * to find out which one would be a round trip in front of every refused
 * request.
 */
export function requireAgeAssurance(req, res, next) {
    if (!identityEnforced()) {
        next();
        return;
    }

    // An admin who cannot see the catalogue cannot moderate it, and an admin
    // account is created deliberately rather than signed up for.
    if (atLeast(req.user?.role, 'admin')) {
        next();
        return;
    }

    const gate = ageGate(req);
    if (gate.ok) {
        next();
        return;
    }

    res.status(403).json({
        // Two codes rather than one, because they want opposite things from
        // the client: a document flow, or a button. A client that treated them
        // the same would send a Californian to a provider.
        error: gate.owes === 'attestation' ? 'age_attestation_required' : 'age_assurance_required',
        reason: gate.reason,
        jurisdiction: publicPolicy(gate.policy),
        ageAssurance: ageAssurances.publicView(ageAssurances.byUser(req.user.id))
    });
}
