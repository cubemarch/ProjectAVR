import crypto from 'node:crypto';

import { portalUnlocks, newToken } from '../db/index.js';
import { PORTAL_UNLOCK_SECONDS } from './providers.js';

/**
 * The creator portal's face gate.
 *
 * The password says an account was signed into. It does not say who is sitting
 * in front of the screen now, and the creator page is where a broadcast
 * destination is handed out - so a stolen session is a stolen airtime slot. A
 * face check against the enrolled identity is what closes that, and it runs
 * when the portal is opened rather than when the destination is requested,
 * because that is the moment the creator is already waiting for a page to load.
 *
 * Once passed, the result is a token held in the browser's `sessionStorage`.
 * That choice is what makes this a *browser session* rather than an
 * account-wide flag: it dies with the tab, a second browser gets its own check,
 * and signing out revokes it server-side regardless of what the tab still
 * holds. {@link PORTAL_UNLOCK_SECONDS} is the ceiling on a tab left open.
 *
 * Stored as a SHA-256 hash for the same reason as refresh tokens and stream
 * keys: a database read should not yield a working credential.
 */

export const PORTAL_UNLOCK_HEADER = 'x-avr-portal-unlock';

const hashUnlock = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * @param {string} userId
 * @param {string|null} challengeId
 * @returns {{token: string, expiresAt: string}}
 */
export function mintPortalUnlock(userId, challengeId = null) {
    const token = newToken(32);

    portalUnlocks.create({
        userId,
        tokenHash: hashUnlock(token),
        challengeId,
        ttlSeconds: PORTAL_UNLOCK_SECONDS
    });

    return { token, expiresAt: new Date(Date.now() + PORTAL_UNLOCK_SECONDS * 1000).toISOString() };
}

/**
 * Resolve a presented unlock, or null.
 *
 * The row's owner is checked against the session's user rather than trusted:
 * an unlock is a statement about a face, and a face that passed for one account
 * says nothing about another.
 *
 * @param {import('express').Request} req
 * @param {string} userId
 */
export function readPortalUnlock(req, userId) {
    const presented = req.get(PORTAL_UNLOCK_HEADER);
    if (!presented) return null;

    const row = portalUnlocks.byHash(hashUnlock(presented));
    if (!row || row.user_id !== userId) return null;

    return row;
}

/** Sign-out closes the portal everywhere, whatever the tabs still believe. */
export function revokePortalUnlocks(userId) {
    return portalUnlocks.revokeAllForUser(userId);
}

/**
 * Gate for the creator portal itself.
 *
 * Answers 401 rather than 403 on a missing unlock, because the client's correct
 * response is to run the check - not to give up. The body names the reason so
 * the portal can tell "verify your face" apart from "your session expired",
 * which look identical from a bare status code.
 */
export function requirePortalUnlock(req, res, next) {
    const row = readPortalUnlock(req, req.user.id);

    if (!row) {
        res.status(401).json({ error: 'portal_unlock_required' });
        return;
    }

    req.portalUnlock = row;
    next();
}
