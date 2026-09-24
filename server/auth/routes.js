import express from 'express';

import { users, sessions, verifications, ageAssurances, agreements, profiles } from '../db/index.js';
import {
    agreementsView,
    isCurrentTerms,
    isCurrentCreatorTerms,
    TERMS_VERSION,
    CREATOR_TERMS_VERSION
} from './agreements.js';
import { adultConfirmed } from '../identity/age.js';
import { hashPassword, verifyPassword, needsRehash, getDummyHash } from './passwords.js';
import { issueAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, accessTokenTtlSeconds, refreshTtlDays } from './tokens.js';
import { requireAuth, loadFullUser, rateLimit } from './middleware.js';
import { revokeBroadcastGrants } from '../identity/broadcast.js';
import { revokePortalUnlocks } from '../identity/portal.js';
import { readiness } from '../live/readiness.js';
import { getDb } from '../db/index.js';

/**
 * Authentication endpoints.
 *
 * Refresh tokens live in an httpOnly cookie so page JavaScript cannot read
 * them; access tokens are returned in the response body for the client to hold
 * in memory only. That split means an XSS bug cannot walk away with a
 * long-lived credential, and a CSRF attempt cannot mint one because refreshing
 * requires a same-site cookie AND returns the access token in a body the
 * attacker's page cannot read cross-origin.
 */

const REFRESH_COOKIE = 'avr_refresh';

/**
 * Readable companion to the refresh cookie.
 *
 * The refresh cookie is httpOnly, so page JavaScript cannot tell whether a
 * session exists and would have to try refreshing on every load - a wasted
 * round trip for every anonymous visitor, which at scale is a lot of requests
 * that can only ever 401. This flag carries no authority and no identity; it
 * exists purely so the client can skip that call.
 */
const SESSION_HINT_COOKIE = 'avr_session';

function refreshCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/api/auth',
        maxAge: refreshTtlDays * 86_400_000
    };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateRegistration(body) {
    const errors = [];

    const email = String(body?.email ?? '').trim();
    const password = String(body?.password ?? '');
    const displayName = String(body?.displayName ?? '').trim();
    const wantsCreator = body?.role === 'creator';

    // The initial profile, which is part of the same form. Both are optional
    // for a viewer; a creator needs the tagline, because it is the line under
    // their name on the home page and an empty card is worse than a slow signup.
    const tagline = String(body?.tagline ?? '').trim();
    const bio = String(body?.bio ?? '').trim();

    if (!EMAIL_RE.test(email) || email.length > 254) errors.push('A valid email address is required.');
    if (password.length < 10) errors.push('Password must be at least 10 characters.');
    if (password.length > 256) errors.push('Password must be at most 256 characters.');
    if (displayName.length < 2 || displayName.length > 60) errors.push('Display name must be 2-60 characters.');
    if (tagline.length > 120) errors.push('Tagline must be at most 120 characters.');
    if (bio.length > 2000) errors.push('Bio must be at most 2000 characters.');
    if (wantsCreator && tagline.length < 2) errors.push('A creator account needs a short tagline.');

    // Acceptance is a version string, not a checkbox. A client that sends
    // `true` has told us nothing about which wording it showed.
    if (!isCurrentTerms(body?.acceptedTerms)) errors.push('The terms of use must be accepted.');
    if (wantsCreator && !isCurrentCreatorTerms(body?.acceptedCreatorTerms)) {
        errors.push('The creator agreement must be accepted.');
    }

    return { errors, email, password, displayName, wantsCreator, tagline, bio };
}

/**
 * @param {import('express').Express} app
 */
export function mountAuth(app) {
    const router = express.Router();

    router.use(express.json({ limit: '16kb' }));

    /* -------------------------------------------------------------- register -- */

    /** The wording the signup form has to show, and the version it must send back. */
    router.get('/agreements', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(agreementsView());
    });

    router.post('/register', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
        const { errors, email, password, displayName, wantsCreator, tagline, bio } = validateRegistration(req.body);

        if (errors.length) {
            res.status(400).json({ error: errors[0], errors });
            return;
        }

        if (users.byEmail(email)) {
            // Registration inherently reveals whether an email is taken; there
            // is no way around that without an email-verification flow. Keep
            // the message generic rather than pretending otherwise.
            res.status(409).json({ error: 'That email is already registered.' });
            return;
        }

        // The very first account becomes an admin so a fresh install is usable
        // without a seeding step.
        const role = users.count() === 0 ? 'admin' : wantsCreator ? 'creator' : 'viewer';

        let user;
        try {
            user = users.create({ email, passwordHash: await hashPassword(password), displayName, role });
        } catch (err) {
            // UNIQUE violation from a concurrent registration of the same email.
            if (String(err.message).includes('UNIQUE')) {
                res.status(409).json({ error: 'That email is already registered.' });
                return;
            }
            throw err;
        }

        agreements.accept({ userId: user.id, kind: 'terms', version: TERMS_VERSION, ip: req.ip });
        // On `wantsCreator`, not on the granted role: the first account on a
        // fresh install is made an admin whatever it asked for, and an admin
        // who ticked nothing has accepted nothing.
        if (wantsCreator) {
            agreements.accept({
                userId: user.id,
                kind: 'creator',
                version: CREATOR_TERMS_VERSION,
                ip: req.ip
            });
        }

        if (tagline || bio) profiles.update(user.id, { tagline: tagline || null, bio: bio || null });

        await establishSession(res, user, req.get('user-agent'));

        // The account exists and is signed in, and can see nothing. Saying so
        // in the registration response rather than letting the first catalogue
        // request 403 is the difference between a next step and a dead end.
        //
        // For a creator the next step is the enrolment, not the age check: the
        // document-and-face check they are about to run establishes their age
        // as a side effect, and asking for a second document scan a minute
        // later would be a worse flow for no extra assurance. See
        // {@link adultConfirmed}.
        res.status(201).json({
            user: users.publicView(user),
            verification: verificationFor(user),
            ageAssurance: ageFor(user),
            adultConfirmed: adultConfirmed(user),
            ...(await tokenPayload(user))
        });
    });

    /* ----------------------------------------------------------------- login -- */

    router.post('/login', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
        const email = String(req.body?.email ?? '').trim();
        const password = String(req.body?.password ?? '');

        const user = users.byEmail(email);

        // Verify against a dummy hash for unknown accounts so both branches
        // cost the same and timing cannot be used to enumerate emails.
        const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));

        if (!user || !ok || user.disabled) {
            res.status(401).json({ error: 'Incorrect email or password.' });
            return;
        }

        // Opportunistically upgrade hashes when cost parameters have risen.
        if (needsRehash(user.password_hash)) {
            getDb()
                .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
                .run(await hashPassword(password), user.id);
        }

        // A new sign-in owes its stream checks again. This is what makes the
        // check per-session rather than per-account: whatever the last session
        // confirmed, it confirmed on equipment this one may not be sitting at.
        readiness.reset(user.id);

        await establishSession(res, user, req.get('user-agent'));
        res.json({
            user: users.publicView(user),
            verification: verificationFor(user),
            ageAssurance: ageFor(user),
            adultConfirmed: adultConfirmed(user),
            ...(await tokenPayload(user))
        });
    });

    /* --------------------------------------------------------------- refresh -- */

    router.post('/refresh', async (req, res) => {
        const raw = req.cookies?.[REFRESH_COOKIE];
        const rotated = rotateRefreshToken(raw, req.get('user-agent'));

        if (!rotated) {
            clearSessionCookies(res);
            res.status(401).json({ error: 'session expired' });
            return;
        }

        const user = users.byId(rotated.userId);
        if (!user || user.disabled) {
            clearSessionCookies(res);
            res.status(401).json({ error: 'account unavailable' });
            return;
        }

        setSessionCookies(res, rotated.token);
        res.json({
            user: users.publicView(user),
            verification: verificationFor(user),
            ageAssurance: ageFor(user),
            adultConfirmed: adultConfirmed(user),
            ...(await tokenPayload(user))
        });
    });

    /* ---------------------------------------------------------------- logout -- */

    router.post('/logout', (req, res) => {
        const userId = revokeRefreshToken(req.cookies?.[REFRESH_COOKIE]);

        // The portal unlock lives in `sessionStorage`, so signing out in this
        // tab already loses it - but "already loses it" is a property of the
        // client, and the server should not be relying on a client to drop a
        // credential it could just as well keep.
        if (userId) {
            revokePortalUnlocks(userId);
            readiness.reset(userId);
        }

        clearSessionCookies(res);
        res.status(204).end();
    });

    /** Sign out everywhere - useful after a password change or a lost device. */
    router.post('/logout-all', requireAuth, loadFullUser, (req, res) => {
        sessions.revokeAllForUser(req.user.id);

        // "Sign out everywhere" has to mean everywhere. A grant is a credential
        // that puts a face-verified name on air; leaving one live after a
        // lost-device reset would be the one that mattered most, even for the
        // few minutes it has left.
        revokeBroadcastGrants(req.user.id);
        revokePortalUnlocks(req.user.id);
        readiness.reset(req.user.id);

        clearSessionCookies(res);
        res.status(204).end();
    });

    /* -------------------------------------------------------------------- me -- */

    router.get('/me', requireAuth, loadFullUser, (req, res) => {
        res.json({
            user: users.publicView(req.user),
            verification: verificationFor(req.user),
            ageAssurance: ageFor(req.user),
            adultConfirmed: adultConfirmed(req.user),
            agreements: agreements.forUser(req.user.id)
        });
    });

    /** Rotate the DeoVR/Play'a feed token, invalidating any shared URL. */
    router.post('/feed-token/rotate', requireAuth, loadFullUser, (req, res) => {
        res.json({ feedToken: users.rotateFeedToken(req.user.id) });
    });

    /**
     * Self-serve upgrade to a creator account.
     *
     * A real deployment would gate this behind review or payment; it is open
     * here so the portal can be tried without an admin round trip.
     *
     * The role is granted immediately and broadcasting is not: identity
     * verification is a separate gate, and the `verification` block is what
     * tells the portal to send them to it. See docs/IDENTITY.md.
     *
     * The creator agreement is asked for here and not inherited from signup,
     * because a viewer was never shown it. That is the whole reason the two
     * agreements are separate rows.
     */
    router.post('/become-creator', requireAuth, loadFullUser, async (req, res) => {
        if (req.user.role !== 'viewer') {
            res.json({
                user: users.publicView(req.user),
                verification: verificationFor(req.user),
                ageAssurance: ageFor(req.user),
                adultConfirmed: adultConfirmed(req.user)
            });
            return;
        }

        if (!isCurrentCreatorTerms(req.body?.acceptedCreatorTerms)) {
            res.status(400).json({
                error: 'creator_terms_required',
                message: 'The creator agreement must be accepted.',
                creatorTerms: agreementsView().creator
            });
            return;
        }

        const updated = users.setRole(req.user.id, 'creator');
        agreements.accept({
            userId: updated.id,
            kind: 'creator',
            version: CREATOR_TERMS_VERSION,
            ip: req.ip
        });

        res.json({
            user: users.publicView(updated),
            verification: verificationFor(updated),
            ageAssurance: ageFor(updated),
            adultConfirmed: adultConfirmed(updated),
            ...(await tokenPayload(updated))
        });
    });

    app.use('/api/auth', router);
}

/**
 * Identity state, for accounts it can apply to.
 *
 * A viewer can never broadcast, so asking the table about one is a lookup whose
 * answer is already known - and `/me` is called on every page load.
 */
function verificationFor(user) {
    if (user.role === 'viewer') return null;
    return verifications.publicView(verifications.byUser(user.id));
}

/**
 * Age state, for every account.
 *
 * Unlike {@link verificationFor} this one has no role shortcut, because a
 * viewer is precisely who it is about: it is the block that sends a brand new
 * account to the document check before it ever sees the catalogue.
 */
function ageFor(user) {
    return ageAssurances.publicView(ageAssurances.byUser(user.id));
}

async function establishSession(res, user, userAgent) {
    const { token } = issueRefreshToken(user.id, userAgent);
    setSessionCookies(res, token);
}

function setSessionCookies(res, refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
    res.cookie(SESSION_HINT_COOKIE, '1', {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: refreshTtlDays * 86_400_000
    });
}

function clearSessionCookies(res) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
}

async function tokenPayload(user) {
    return {
        accessToken: await issueAccessToken(user),
        expiresIn: accessTokenTtlSeconds
    };
}

export { REFRESH_COOKIE, SESSION_HINT_COOKIE };
