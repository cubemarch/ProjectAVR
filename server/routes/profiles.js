import express from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { profiles, creatorSettings, users } from '../db/index.js';
import { requireAuth, requireRole, rateLimit } from '../auth/middleware.js';
import { getStorage } from '../storage/index.js';
import { readiness } from '../live/readiness.js';
import { sessions } from '../live/sessions.js';
import { rooms } from '../live/rooms.js';
import { accountView } from '../credits/index.js';

/**
 * Profile pages, for both roles.
 *
 * A viewer's profile is a picture, a line of text and a credit balance. A
 * creator's is all of that plus what they charge and what they are willing to
 * send. They share a router because they are the same page with a second panel,
 * and splitting them would mean two places to remember when the shared half
 * changes.
 *
 * Pricing lives here rather than on the portal-gated creator router on purpose.
 * The portal gate is a face check before going on air; making a creator prove
 * their face to edit a sentence about themselves is friction with no threat
 * behind it. Changing a price cannot move money - only a broadcast can, and
 * that is gated.
 */

/** Avatars are small and shown at 96px; anything larger is a mistake. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const AVATAR_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
};

/**
 * What the bytes actually are, ignoring what the request said they were.
 *
 * A `Content-Type` header is written by the client, so trusting it is how an
 * "image" ends up being an HTML document served back from the same origin.
 */
function sniffImage(buffer) {
    if (buffer.length < 12) return null;

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }

    return null;
}

/** Prices are credits per minute: whole, non-negative, and not absurd. */
const MAX_PER_MIN = 10_000; // $100.00 a minute.

function sanitisePricing(body) {
    const errors = [];
    const patch = {};

    const price = (key) => {
        if (body[key] === undefined) return;

        const value = Math.trunc(Number(body[key]));
        if (!Number.isFinite(value) || value < 0 || value > MAX_PER_MIN) {
            errors.push(`${key} must be between 0 and ${MAX_PER_MIN} credits per minute`);
            return;
        }
        patch[key] = value;
    };

    price('public2dPerMin');
    price('public3dPerMin');
    price('private2dPerMin');
    price('private3dPerMin');

    for (const key of ['public3dEnabled', 'private3dEnabled']) {
        if (body[key] === undefined) continue;
        patch[key] = body[key] === true || body[key] === 'true' || body[key] === 1;
    }

    if (body.recordingPolicy !== undefined) {
        if (!['ask', 'always', 'never'].includes(body.recordingPolicy)) {
            errors.push('recordingPolicy must be ask, always or never');
        } else {
            patch.recordingPolicy = body.recordingPolicy;
        }
    }

    return { patch, errors };
}

function settingsView(row) {
    return {
        ...creatorSettings.publicView(row),
        recordingPolicy: row?.recording_policy ?? 'ask'
    };
}

/** The avatar as a URL the browser can use, or null. */
export function avatarUrl(profileRow) {
    return profileRow?.avatar_key ? getStorage().deliveryUrl(profileRow.avatar_key) : null;
}

/** The shape every profile is returned in, self or otherwise. */
export function profileView(user, profileRow) {
    return {
        id: user.id,
        name: user.display_name ?? user.name ?? null,
        role: user.role,
        tagline: profileRow?.tagline ?? null,
        bio: profileRow?.bio ?? null,
        avatarUrl: avatarUrl(profileRow)
    };
}

/**
 * @param {import('express').Express} app
 */
export function mountProfiles(app) {
    const router = express.Router();

    /* ------------------------------------------------------------- my own -- */

    router.get('/', requireAuth, express.json({ limit: '8kb' }), (req, res) => {
        const user = users.byId(req.auth.sub);

        if (!user) {
            res.status(404).json({ error: 'no such account' });
            return;
        }

        const body = {
            profile: profileView(user, profiles.ensure(user.id)),
            credits: accountView(user.id)
        };

        if (user.role === 'creator' || user.role === 'admin') {
            body.creator = settingsView(creatorSettings.ensure(user.id));
            body.streamChecks = readiness.stateOf(user.id);
        }

        res.set('Cache-Control', 'no-store');
        res.json(body);
    });

    router.patch('/', requireAuth, express.json({ limit: '8kb' }), (req, res) => {
        const patch = {};
        const errors = [];

        for (const [key, max] of [
            ['tagline', 120],
            ['bio', 2000]
        ]) {
            if (req.body?.[key] === undefined) continue;

            const value = String(req.body[key]).trim();
            if (value.length > max) errors.push(`${key} must be at most ${max} characters`);
            else patch[key] = value || null;
        }

        if (errors.length) {
            res.status(400).json({ error: errors.join(' ') });
            return;
        }

        const row = profiles.update(req.auth.sub, patch);
        res.json({ profile: profileView(users.byId(req.auth.sub), row) });
    });

    /* ------------------------------------------------------------ avatars -- */

    router.put(
        '/avatar',
        requireAuth,
        rateLimit({ windowMs: 60_000, max: 6 }),
        express.raw({ type: Object.keys(AVATAR_TYPES), limit: MAX_AVATAR_BYTES }),
        async (req, res, next) => {
            const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const actual = sniffImage(body);

            if (!actual) {
                res.status(400).json({ error: 'send a JPEG, PNG or WebP image' });
                return;
            }

            const storage = getStorage();
            const previous = profiles.ensure(req.auth.sub).avatar_key;

            // A fresh key every time rather than overwriting, so a cached or
            // CDN-held copy of the old picture can never be served as the new one.
            const key = `avatar/${req.auth.sub}/${crypto.randomBytes(8).toString('hex')}${AVATAR_TYPES[actual]}`;

            try {
                await storage.putStream(key, Readable.from(body));
                const row = profiles.update(req.auth.sub, { avatarKey: key });

                // Only after the new one is recorded. Losing the old picture is
                // recoverable; a row pointing at a key that is gone is not.
                if (previous) await storage.remove(previous).catch(() => {});

                res.json({ profile: profileView(users.byId(req.auth.sub), row) });
            } catch (err) {
                next(err);
            }
        }
    );

    router.delete('/avatar', requireAuth, async (req, res) => {
        const previous = profiles.ensure(req.auth.sub).avatar_key;
        const row = profiles.update(req.auth.sub, { avatarKey: null });

        if (previous) await getStorage().remove(previous).catch(() => {});

        res.json({ profile: profileView(users.byId(req.auth.sub), row) });
    });

    /* ----------------------------------------------------- creator pricing -- */

    router.patch(
        '/creator',
        requireAuth,
        requireRole('creator'),
        express.json({ limit: '8kb' }),
        (req, res) => {
            const { patch, errors } = sanitisePricing(req.body ?? {});

            if (errors.length) {
                res.status(400).json({ error: errors.join(' ') });
                return;
            }

            // Turning 3D on is the one setting that asserts something about the
            // equipment rather than about the creator's preferences, so it is
            // the one setting the server refuses to take their word for. The
            // client is told which check to run rather than just being refused.
            const wants3d = patch.public3dEnabled === true || patch.private3dEnabled === true;

            if (wants3d && !readiness.maySendSpatial(req.auth.sub)) {
                res.status(409).json({
                    error: '3D has to be confirmed before it can be offered',
                    code: 'spatial_check_required',
                    streamChecks: readiness.stateOf(req.auth.sub)
                });
                return;
            }

            const row = creatorSettings.update(req.auth.sub, patch);
            res.json({ creator: settingsView(row), streamChecks: readiness.stateOf(req.auth.sub) });
        }
    );

    app.use('/api/profile', router);

    /* ----------------------------------------------------- somebody else's -- */

    /**
     * Who is on air, and who is about to be.
     *
     * Two states, and the home page shows both: `live` is a broadcast running
     * right now, `ready` is a creator signed in and set up but not yet on air.
     * Keeping them apart matters because clicking one starts costing credits a
     * minute and clicking the other does not.
     *
     * Presence comes from the stream check rather than from a separate online
     * registry. A creator who has confirmed their stream this session is
     * exactly the set of people who could be on air in the next few seconds,
     * which is what "ready" is supposed to mean.
     *
     * Declared before `/api/creators/:id` so that `:id` cannot swallow it.
     */
    app.get('/api/creators/live', (req, res) => {
        const byCreator = new Map();

        for (const session of sessions.list()) {
            // A broadcast opened for one chosen viewer is nobody's business,
            // including the home page's. Same rule as `/api/live/sessions`.
            if (!session.creatorId || rooms.isPrivate(session)) continue;

            const existing = byCreator.get(session.creatorId);
            if (!existing || session.startedAt < existing.startedAt) byCreator.set(session.creatorId, session);
        }

        for (const userId of readiness.readyCreators()) {
            if (!byCreator.has(userId)) byCreator.set(userId, null);
        }

        const ids = [...byCreator.keys()];
        const profileRows = profiles.forUsers(ids);
        const settingRows = creatorSettings.forUsers(ids);

        const creators = ids
            .map((id) => {
                const user = users.byId(id);
                if (!user) return null;

                const session = byCreator.get(id);
                const pricing = creatorSettings.publicView(settingRows.get(id));

                return {
                    ...profileView(user, profileRows.get(id)),
                    pricing,
                    status: session ? 'live' : 'ready',
                    live: session
                        ? {
                              sessionId: session.id,
                              startedAt: new Date(session.startedAt).toISOString(),
                              projection: session.projection,
                              stereo: session.stereo,
                              // Switchable in the player, so this is only
                              // whether there is a second eye to switch to and
                              // whether the creator is offering it.
                              supports3d: session.stereo !== 'mono' && pricing.public3dEnabled
                          }
                        : null
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
                return String(a.name ?? '').localeCompare(String(b.name ?? ''));
            });

        res.set('Cache-Control', 'no-store');
        res.json({ creators });
    });

    /**
     * A creator's public page.
     *
     * Deliberately not `/api/profile/:id`: a viewer's profile is not a public
     * document, and a route that serves "any account by id" is one refactor
     * away from being one.
     */
    app.get('/api/creators/:id', (req, res) => {
        const user = users.byId(req.params.id);

        if (!user || (user.role !== 'creator' && user.role !== 'admin')) {
            res.status(404).json({ error: 'no such creator' });
            return;
        }

        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            profile: profileView(user, profiles.byId(user.id)),
            pricing: creatorSettings.publicView(creatorSettings.byId(user.id))
        });
    });
}
