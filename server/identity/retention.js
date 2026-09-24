import { verifications, challenges, grants } from '../db/index.js';
import { CHALLENGE_RETENTION_DAYS } from './providers.js';

/**
 * Identity housekeeping.
 *
 * Retention is a requirement here rather than tidiness. Keeping a record of
 * every sign-in attempt forever is not defensible under any of the regimes that
 * permit this processing at all, and none of these rows have a use once the
 * dispute window has passed - the summary in `identity_events` is what a
 * support case or a regulator actually needs.
 *
 * Idempotent, so every node can run it on a timer without coordination.
 */
export function runIdentitySweep() {
    return {
        verificationsExpired: verifications.expireLapsed(),
        challengesExpired: challenges.expireStale(),
        challengesPruned: challenges.prune(CHALLENGE_RETENTION_DAYS),
        // Expired grants. Most of what this deletes is minutes old and was
        // already unusable; the sweep is about not keeping the row.
        grantsPruned: grants.pruneExpired()
    };
}
