/**
 * The role ladder, in one place, for both tiers.
 *
 * Shared rather than duplicated because of what a new role at the top does to
 * a codebase that spells the ladder out by hand. Adding `superuser` above
 * `admin` silently excluded it from every `role === 'creator' || role ===
 * 'admin'` in the tree - each of which reads as a complete list of who counts,
 * and each of which was a complete list right up until it was not. A rank
 * cannot go stale that way: a role added at the top is admitted everywhere
 * that asked for "at least" something below it.
 *
 * Imported by `server/auth/middleware.js` as well as the browser. The server
 * already reaches into `src/` for the wire protocol and the format tables;
 * this is the same arrangement for the same reason, which is that a guard here
 * and a hidden button there must not be able to disagree.
 */

/** @type {Record<string, number>} */
export const ROLE_RANK = {
    viewer: 0,
    /** Publishes. Has a channel, can go on air, can be paid. */
    creator: 1,
    /** Moderates: can act on somebody else's title or account. */
    admin: 2,
    /** Runs the deployment. Set from the environment at boot and nowhere else. */
    superuser: 3
};

/**
 * Does this role reach that bar?
 *
 * An unknown role ranks below everything, so a token carrying a role this
 * build has never heard of is treated as the least privileged thing there is
 * rather than as something to guess about.
 *
 * @param {string|null|undefined} role
 * @param {keyof ROLE_RANK} minimum
 */
export function atLeast(role, minimum) {
    return (ROLE_RANK[role] ?? -1) >= ROLE_RANK[minimum];
}

/** Shorthand for the commonest question on both tiers: can they publish? */
export function isCreator(role) {
    return atLeast(role, 'creator');
}
