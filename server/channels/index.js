/**
 * Channels: the policy around who may hold which names.
 *
 * `slug.js` answers "is this string a legal name". The database answers "is it
 * free". This module is the third question, which neither of those can see:
 * *who is asking*. One creator, one name. A superuser, as many as they like,
 * including names nobody else may have.
 *
 * It is a separate file from the routes so the rules are testable without an
 * HTTP server, and a separate file from `db/index.js` so the storage layer
 * stays a storage layer - it enforces that a name has one owner, and nothing
 * about who deserves one.
 */

import { channelSlugs, reservedSlugs, users } from '../db/index.js';
import { suggestSlug, validateSlug } from './slug.js';
import { atLeast } from '../../src/auth/roles.js';

/**
 * How many names one account may hold.
 *
 * One, for everybody who is not running the place. The limit is not about
 * storage - it is that the root namespace is finite and shared, and a creator
 * who can take ten names can take ten names somebody else wanted. A rename
 * still keeps the old name working, because renaming replaces the primary and
 * leaves the previous one as an alias; that is one name's worth of churn, not
 * an invitation to collect.
 *
 * The superuser holds as many as they need because the platform's own channels
 * are the ones that legitimately answer to several: a launch name, a campaign
 * name, and the brand itself all pointing at one feed.
 */
const NAME_LIMIT = { viewer: 1, creator: 1, admin: 1, superuser: Infinity };

/** Reserving names out from under everybody is a platform act, not a moderation one. */
export function mayReserveNames(role) {
    return atLeast(role, 'superuser');
}

/** Only the platform may stand at an address the platform refuses to everybody else. */
export function mayClaimReserved(role) {
    return atLeast(role, 'superuser');
}

/** @returns {number} */
export function nameLimitFor(role) {
    return NAME_LIMIT[role] ?? 1;
}

/**
 * Everything a settings page needs to render the names section for one account.
 */
export function namesFor(user) {
    const held = channelSlugs.forUser(user.id);
    const limit = nameLimitFor(user.role);

    return {
        names: held,
        primary: held.find((n) => n.isPrimary)?.slug ?? null,
        // `null` rather than `Infinity`, which JSON has no way to carry and
        // would silently become `null` on the wire anyway. Said deliberately
        // here so the client can read it as "no ceiling" rather than "unknown".
        limit: Number.isFinite(limit) ? limit : null,
        canAddMore: held.length < limit,
        canReserve: mayReserveNames(user.role),
        suggestion: held.length ? null : suggestSlug(user.display_name)
    };
}

/**
 * Take a name for a channel.
 *
 * The one place a name is created. Every caller - the settings form, the
 * superuser console, the first-name-on-becoming-a-creator path - comes through
 * here, so the limit, the reserved list and the shape rules cannot be applied
 * in three slightly different ways.
 *
 * @param {object} opts
 * @param {{id: string, role: string}} opts.user
 * @param {unknown} opts.slug - Raw, as typed.
 * @param {boolean} [opts.primary] - Make this the canonical name. Defaults to
 *   true for an account's first name, because a channel with names but no
 *   primary has no address at all.
 * @returns {{ok: true, slug: string, primary: boolean}|{ok: false, code: string, error: string}}
 */
export function claimName({ user, slug, primary }) {
    const held = channelSlugs.forUser(user.id);
    const first = held.length === 0;
    const wantPrimary = primary ?? first;

    const check = validateSlug(slug, {
        extraReserved: reservedSlugs.all(),
        allowReserved: mayClaimReserved(user.role)
    });

    if (!check.ok) return check;

    // Re-claiming a name you already hold is a no-op rather than an error, so a
    // double-submitted form does not report a collision with yourself.
    const mine = held.find((n) => n.slug === check.slug);
    if (mine) {
        if (wantPrimary && !mine.isPrimary) {
            channelSlugs.setPrimary({ userId: user.id, slug: check.slug });
            return { ok: true, slug: check.slug, primary: true };
        }
        return { ok: true, slug: check.slug, primary: mine.isPrimary };
    }

    if (held.length >= nameLimitFor(user.role)) {
        return {
            ok: false,
            code: 'name_limit',
            error:
                nameLimitFor(user.role) === 1
                    ? 'You already have a channel name. Change it instead of adding another.'
                    : `You can hold ${nameLimitFor(user.role)} channel names.`
        };
    }

    if (!channelSlugs.claim({ userId: user.id, slug: check.slug, primary: wantPrimary })) {
        return { ok: false, code: 'slug_taken', error: 'That name is already taken.' };
    }

    return { ok: true, slug: check.slug, primary: wantPrimary };
}

/**
 * Change the canonical name, keeping the old one alive.
 *
 * This is what "rename" means here, and it is why an ordinary creator's limit
 * of one name is not as tight as it sounds. The previous name stays in the
 * table as an alias, so every link, QR code and headset bookmark that points at
 * it keeps working - it simply redirects to the new one. The limit counts names
 * the creator *chose*; it does not count the trail behind them.
 *
 * @returns {{ok: true, slug: string}|{ok: false, code: string, error: string}}
 */
export function renameChannel({ user, slug }) {
    const check = validateSlug(slug, {
        extraReserved: reservedSlugs.all(),
        allowReserved: mayClaimReserved(user.role)
    });

    if (!check.ok) return check;

    const held = channelSlugs.forUser(user.id);

    if (held.some((n) => n.slug === check.slug)) {
        channelSlugs.setPrimary({ userId: user.id, slug: check.slug });
        return { ok: true, slug: check.slug };
    }

    const taken = channelSlugs.resolve(check.slug);
    if (taken) return { ok: false, code: 'slug_taken', error: 'That name is already taken.' };

    if (!channelSlugs.claim({ userId: user.id, slug: check.slug, primary: true })) {
        return { ok: false, code: 'slug_taken', error: 'That name is already taken.' };
    }

    return { ok: true, slug: check.slug };
}

/**
 * Give up a name.
 *
 * Note what this does *not* do: it does not put the name back into general
 * circulation with any ceremony. A released name is immediately claimable by
 * anybody, which is the expected behaviour for a namespace like this one and
 * also the reason the superuser can reserve a name they have just released.
 */
export function releaseName({ user, slug }) {
    const result = channelSlugs.release({ userId: user.id, slug: String(slug ?? '').toLowerCase() });

    if (result.ok) return { ok: true };

    return result.code === 'last_name'
        ? {
              ok: false,
              code: 'last_name',
              error: 'This is your only channel name. Rename the channel instead of removing it.'
          }
        : { ok: false, code: 'not_found', error: 'You do not hold that name.' };
}

/**
 * Who is at this address?
 *
 * Returns the canonical name alongside the owner so a caller that was given an
 * alias can redirect to the real one rather than serving the same channel at
 * two addresses - which costs nothing technically and costs a creator their
 * search ranking and their analytics.
 *
 * @returns {{user: object, slug: string, canonical: string}|null}
 */
export function resolveChannel(slug) {
    const found = channelSlugs.resolve(slug);
    if (!found) return null;

    const user = users.byId(found.userId);
    if (!user || user.disabled) return null;

    return {
        user,
        slug: found.slug,
        canonical: channelSlugs.primaryFor(found.userId) ?? found.slug
    };
}

/**
 * Reserve a name so nobody can take it. Superuser only.
 *
 * Shape-checked before it is stored, so the list cannot fill with strings that
 * no name could ever have matched anyway. Not reserved-checked, obviously - the
 * whole point is to add to that list - and not uniqueness-checked against
 * `channel_slugs`, because reserving a name somebody already holds is a
 * meaningful act: it stops the name being re-taken after they give it up.
 */
export function reserveName({ user, slug, reason }) {
    if (!mayReserveNames(user.role)) {
        return { ok: false, code: 'forbidden', error: 'Only a superuser can reserve names.' };
    }

    const check = validateSlug(slug, { allowReserved: true });
    if (!check.ok) return check;

    reservedSlugs.add({ slug: check.slug, reservedBy: user.id, reason });
    return { ok: true, slug: check.slug };
}

/** Release a runtime reservation. Cannot touch the built-in list. */
export function unreserveName({ user, slug }) {
    if (!mayReserveNames(user.role)) {
        return { ok: false, code: 'forbidden', error: 'Only a superuser can reserve names.' };
    }

    const name = String(slug ?? '').toLowerCase();

    if (!reservedSlugs.remove(name)) {
        return {
            ok: false,
            code: 'not_reserved',
            error: 'That name is not in the editable reserved list. Names built into the router cannot be released.'
        };
    }

    return { ok: true, slug: name };
}
