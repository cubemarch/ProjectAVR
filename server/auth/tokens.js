import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT, jwtVerify } from 'jose';

import { sessions, newToken } from '../db/index.js';

/**
 * Token issuing and verification.
 *
 * Two token types, deliberately different in kind:
 *
 *   access   - a short-lived signed JWT. Stateless, so verifying one costs no
 *              database round trip. This is what makes the hot path scale: an
 *              app node can authorise a request knowing nothing and storing
 *              nothing.
 *   refresh  - a long-lived opaque random string, stored only as a SHA-256
 *              hash. Because it is looked up rather than merely verified, it
 *              can be revoked - which a stateless JWT cannot be.
 *
 * The signing secret must be shared across every node, or a token minted by
 * one will be rejected by the next. In production it comes from the
 * environment; in development a stable file-backed secret keeps logins alive
 * across restarts.
 */

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const ISSUER = 'projectavr';

/**
 * Resolve the signing secret now, so a misconfigured deployment fails at
 * startup instead of at the first login attempt.
 *
 * Called from the server's boot path. Without it the check below is lazy, and a
 * production node with no shared secret would come up healthy, pass its health
 * check, and only break when a real user tried to sign in.
 */
export function assertSigningKeyConfigured() {
    getSecret();
}

let cachedSecret = null;

function getSecret() {
    if (cachedSecret) return cachedSecret;

    const fromEnv = process.env.AVR_JWT_SECRET;

    if (fromEnv) {
        if (fromEnv.length < 32) {
            throw new Error('AVR_JWT_SECRET must be at least 32 characters');
        }
        cachedSecret = new TextEncoder().encode(fromEnv);
        return cachedSecret;
    }

    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'AVR_JWT_SECRET is required in production. Every app node must share the same value, ' +
                'or tokens issued by one node will be rejected by another.'
        );
    }

    // Development only: persist a generated secret so restarts do not log
    // everyone out. Never reached in production because of the check above.
    cachedSecret = new TextEncoder().encode(developmentSecret());
    return cachedSecret;
}

function developmentSecret() {
    const file = path.join(process.cwd(), 'data', '.dev-jwt-secret');

    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        const secret = crypto.randomBytes(48).toString('base64url');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, secret, { mode: 0o600 });
        return secret;
    }
}

/* ------------------------------------------------------------------ access -- */

/**
 * @param {object} user - User row.
 * @returns {Promise<string>}
 */
export async function issueAccessToken(user) {
    return new SignJWT({ role: user.role, name: user.display_name })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(ISSUER)
        .setAudience(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
        .sign(getSecret());
}

/**
 * @param {string} token
 * @returns {Promise<{sub: string, role: string, name: string}|null>}
 */
export async function verifyAccessToken(token) {
    try {
        const { payload } = await jwtVerify(token, getSecret(), {
            issuer: ISSUER,
            audience: ISSUER,
            // Pinning the algorithm is what prevents an attacker swapping in
            // `none` or an asymmetric alg the verifier would treat differently.
            algorithms: ['HS256']
        });

        return { sub: payload.sub, role: payload.role, name: payload.name };
    } catch {
        return null;
    }
}

export const accessTokenTtlSeconds = ACCESS_TTL_SECONDS;

/* ----------------------------------------------------------------- refresh -- */

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Mint a refresh token and record its hash.
 *
 * @param {string} userId
 * @param {string} [userAgent]
 * @returns {{token: string, expiresAt: Date}}
 */
export function issueRefreshToken(userId, userAgent) {
    const token = newToken(48);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

    sessions.create(userId, hashToken(token), expiresAt, userAgent);

    return { token, expiresAt };
}

/**
 * Exchange a refresh token for a new one, revoking the old.
 *
 * Rotating on every use means a stolen token is usable at most once, and the
 * legitimate holder's next refresh fails loudly instead of silently sharing a
 * session with an attacker.
 *
 * @param {string} rawToken
 * @param {string} [userAgent]
 * @returns {{userId: string, token: string, expiresAt: Date}|null}
 */
export function rotateRefreshToken(rawToken, userAgent) {
    if (typeof rawToken !== 'string' || !rawToken) return null;

    const record = sessions.byHash(hashToken(rawToken));
    if (!record) return null;

    sessions.revoke(record.id);
    const next = issueRefreshToken(record.user_id, userAgent);

    return { userId: record.user_id, ...next };
}

/** @param {string} rawToken */
export function revokeRefreshToken(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken) return null;

    const record = sessions.byHash(hashToken(rawToken));
    if (!record) return null;

    sessions.revoke(record.id);

    // Returned so the caller can tear down whatever else hangs off this
    // account's sign-in. `/logout` has no `requireAuth` - the cookie is the
    // only thing identifying the user - so this is the only handle it gets.
    return record.user_id;
}

export const refreshTtlDays = REFRESH_TTL_DAYS;
