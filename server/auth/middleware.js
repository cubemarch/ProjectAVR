import { verifyAccessToken } from './tokens.js';
import { users } from '../db/index.js';
import { atLeast } from '../../src/auth/roles.js';

/**
 * Request authentication.
 *
 * `attachUser` runs on every request and is deliberately cheap: it verifies a
 * signature and reads claims, with no database access. The guards below build
 * on it. Only routes that genuinely need the full user record pay for a lookup,
 * via `loadFullUser`.
 */

function bearerFrom(req) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();

    // Headset browsers make it awkward to set headers on media elements, so a
    // query token is accepted for GETs only, where it cannot be used to forge a
    // state-changing request from a third-party page.
    if (req.method === 'GET' && typeof req.query?.access_token === 'string') {
        return req.query.access_token;
    }

    return null;
}

/** Populates `req.auth` when a valid access token is present. Never rejects. */
export async function attachUser(req, res, next) {
    const token = bearerFrom(req);
    req.auth = token ? await verifyAccessToken(token) : null;
    next();
}

/** 401 unless a valid access token was presented. */
export function requireAuth(req, res, next) {
    if (!req.auth) {
        res.status(401).json({ error: 'authentication required' });
        return;
    }
    next();
}

/**
 * Require a minimum role. Roles are ranked, so `requireRole('creator')` also
 * admits admins without every route having to list them.
 *
 * @param {'viewer'|'creator'|'admin'|'superuser'} minimum
 */
export function requireRole(minimum) {
    return (req, res, next) => {
        if (!req.auth) {
            res.status(401).json({ error: 'authentication required' });
            return;
        }

        if (!atLeast(req.auth.role, minimum)) {
            res.status(403).json({ error: `requires ${minimum} role` });
            return;
        }

        next();
    };
}

/**
 * Load the full user row onto `req.user`.
 *
 * Also catches accounts disabled after their access token was issued - the
 * token stays cryptographically valid until it expires, so this is the point
 * where a ban actually takes effect.
 */
export function loadFullUser(req, res, next) {
    if (!req.auth) {
        res.status(401).json({ error: 'authentication required' });
        return;
    }

    const user = users.byId(req.auth.sub);

    if (!user || user.disabled) {
        res.status(401).json({ error: 'account unavailable' });
        return;
    }

    req.user = user;
    next();
}

/**
 * Naive fixed-window rate limiter for auth endpoints.
 *
 * In-process state, which means each node enforces its own window - fine as a
 * brute-force speed bump, but it is NOT a distributed limit. A multi-node
 * deployment should put a shared limiter (Redis, or the load balancer's own)
 * in front; see the scaling notes in the README.
 *
 * @param {{windowMs?: number, max?: number}} [opts]
 */
export function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
    // Integration tests drive many accounts from one address; the limiter has
    // its own dedicated test rather than distorting every other one.
    if (process.env.AVR_DISABLE_RATE_LIMIT === '1') return (req, res, next) => next();

    const hits = new Map();

    // Sweep on an interval rather than per request, so a flood of unique IPs
    // cannot make every request pay for a full-map scan.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, entry] of hits) {
            if (entry.start < cutoff) hits.delete(key);
        }
    }, windowMs);
    sweep.unref();

    return (req, res, next) => {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const entry = hits.get(key);

        if (!entry || now - entry.start >= windowMs) {
            hits.set(key, { start: now, count: 1 });
            next();
            return;
        }

        entry.count += 1;

        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
            res.set('Retry-After', String(retryAfter)).status(429).json({
                error: 'too many requests',
                retryAfter
            });
            return;
        }

        next();
    };
}
