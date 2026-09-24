import crypto from 'node:crypto';

import { verifications, grants, identityEvents, newToken, dbIsOpen } from '../db/index.js';
import { identityEnforced, GRANT_TTL_SECONDS, GRANT_RESUME_SECONDS } from './providers.js';

/**
 * Per-creator broadcast authorisation.
 *
 * A grant is what the phone puts in its HELLO instead of the shared
 * `AVR_LIVE_KEY`. It is minted in the browser behind a face check, it authorises
 * **one** broadcast, and it expires in minutes whether or not it is used.
 *
 * That is deliberately inconvenient. The alternative - a durable API key, which
 * this briefly was - decouples the face check from the moment it matters: the
 * check happens once, at issuing time, and everything after that is a bearer
 * token that works until somebody notices it should not. For an ordinary
 * service that is the right trade. For one where the credential puts a
 * face-verified identity on air, the check belongs at the broadcast, not at the
 * enrolment, because the question is not "did this account verify once" but "is
 * the verified person the one about to go live".
 *
 * The cost is real and is paid by the creator: a browser has to be in reach
 * every time. Two things make that survivable. Scanning the QR code is faster
 * than the copy-paste it replaced, so the five-minute window is generous rather
 * than tight; and a grant stays presentable for a short window after first use,
 * so a dropped connection reconnects instead of sending the operator back to a
 * laptop mid-shoot.
 *
 * See docs/IDENTITY.md, "Broadcast grants".
 */

/**
 * Alphabet for the confirmation code.
 *
 * No O/0, I/1, S/5, B/8, Z/2. The code exists to be read off a phone screen and
 * typed into a browser by someone standing up with a camera rig in their hands;
 * a character pair that looks the same in two different fonts turns a security
 * control into a support ticket.
 */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';

const CODE_LENGTH = 4;

export function newChallengeCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/**
 * Do these two codes match?
 *
 * Constant-time, and case-insensitive because the creator is typing it.
 */
export function codeMatches(presented, expected) {
    const a = crypto.createHash('sha256').update(String(presented ?? '').trim().toUpperCase()).digest();
    const b = crypto.createHash('sha256').update(String(expected ?? '').trim().toUpperCase()).digest();
    return crypto.timingSafeEqual(a, b);
}

const hashKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Mint a grant.
 *
 * The raw token is returned once, to the browser that is about to display it as
 * a QR code, and never again - only its hash is stored, on the same reasoning as
 * refresh tokens. Losing it costs another face check, which at five minutes a
 * grant is not much of a loss.
 *
 * The clock starts here rather than at the face check, so the window is the one
 * the creator is actually looking at.
 *
 * @param {{userId: string, challengeId?: string|null}} input
 * @returns {{id: string, token: string, expiresAt: string, resumeSeconds: number}}
 */
export function mintBroadcastGrant({ userId, challengeId = null }) {
    const token = newToken(32);
    const row = grants.create({
        userId,
        tokenHash: hashKey(token),
        challengeId,
        ttlSeconds: GRANT_TTL_SECONDS
    });

    identityEvents.record({ userId, kind: 'grant_issued', outcome: 'ok', providerRef: row.id });

    return {
        id: row.id,
        token,
        expiresAt: row.expires_at,
        resumeSeconds: GRANT_RESUME_SECONDS
    };
}

/**
 * Authorise a HELLO against a grant.
 *
 * Called from the ingest path, which is synchronous and runs before a session
 * exists, so this must never throw: a deployment with no database configured at
 * all should fall through to the shared-key path rather than drop the
 * connection on an exception.
 *
 * Spent on connection, not on disconnection. A grant retired only on a clean
 * close is replayable by anyone who can make the first attempt fail, and
 * "arrange for the real broadcast to drop" is not a hard attack.
 *
 * @param {unknown} presented
 * @returns {{userId: string, grantId: string}|null}
 */
export function redeemBroadcastGrant(presented) {
    const raw = typeof presented === 'string' ? presented : '';
    if (!raw) return null;

    // Do not bring a database into existence just to reject a credential. A
    // protocol unit test, or a deployment that only ever pairs with the shared
    // key, should not find a SQLite file created behind it.
    if (!dbIsOpen() && !identityEnforced()) return null;

    try {
        const row = grants.byHash(hashKey(raw), GRANT_RESUME_SECONDS);
        if (!row) return null;

        // The grant says a check was passed; this says the check still stands.
        // Between minting and HELLO the verification can lapse, be withdrawn, or
        // turn out to have been issued by a provider the server no longer uses -
        // and an account verified by the stub must not keep broadcasting after
        // the deployment moves to a real provider.
        if (!verifications.isCurrent(verifications.byUser(row.user_id))) {
            grants.revokeAllForUser(row.user_id);
            identityEvents.record({
                userId: row.user_id,
                kind: 'grant_rejected',
                outcome: 'failed',
                providerRef: row.id
            });
            return null;
        }

        // Only the first HELLO records an event. A reconnection inside the
        // resume window is the same broadcast, and logging it as a second use
        // would make the audit trail claim a creator went live twice.
        if (grants.consume(row.id)) {
            identityEvents.record({
                userId: row.user_id,
                kind: 'grant_used',
                outcome: 'ok',
                providerRef: row.id
            });
        }

        return { userId: row.user_id, grantId: row.id };
    } catch (err) {
        console.warn('[identity] grant lookup failed:', err.message);
        return null;
    }
}

/**
 * Cut every grant a creator holds.
 *
 * Used where the account itself is in question - sign-out-everywhere, a denied
 * challenge, withdrawal of consent, a provider that no longer has the reference
 * face. Most grants die on their own within minutes; this is for the ones that
 * must die now.
 */
export function revokeBroadcastGrants(userId) {
    return grants.revokeAllForUser(userId);
}

/**
 * Gate for anything that leads to being on air.
 *
 * Deliberately independent of `AVR_IDENTITY_ENFORCE`: enforcement decides
 * whether the ingest still accepts the shared key, not whether these endpoints
 * will hand an unverified account a grant. They never will.
 */
export function requireVerifiedCreator(req, res, next) {
    const row = verifications.byUser(req.user.id);

    if (!verifications.isCurrent(row)) {
        res.status(403).json({
            error: 'identity verification required',
            verification: verifications.publicView(row)
        });
        return;
    }

    req.verification = row;
    next();
}

/**
 * The state of a challenge as the phone or the browser should see it.
 *
 * The code is included: both ends have to display it, because the comparison
 * the creator makes between the two screens is the only thing standing between
 * a stolen password and a face check that authorises somebody else's phone.
 */
export function challengeView(row) {
    if (!row) return null;

    return {
        id: row.id,
        code: row.code,
        status: expiredNow(row) ? 'expired' : row.status,
        deviceLabel: row.device_label,
        deviceIp: row.device_ip,
        declineReason: row.decline_reason,
        createdAt: row.created_at,
        expiresAt: row.expires_at
    };
}

/**
 * Expiry is decided from the clock, never from a status somebody forgot to sweep.
 *
 * Approved counts. An approval the phone never collected is not a standing
 * permission to broadcast an hour later - the window the creator agreed to was
 * the one they were looking at.
 */
export function expiredNow(row) {
    if (row.status !== 'pending' && row.status !== 'approved') return false;
    return new Date(row.expires_at).getTime() <= Date.now();
}
