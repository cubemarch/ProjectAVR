import express from 'express';

import { progress, myList, analytics, titles } from '../db/index.js';
import { requireAuth, loadFullUser } from '../auth/middleware.js';
import { requireAgeAssurance } from '../identity/age.js';
import { identityEnforced } from '../identity/providers.js';
import { buildLibrary } from '../library.js';

/**
 * Viewer-facing state: resume position, My List, and view recording.
 *
 * All of it is keyed by user id in the database rather than kept in the browser,
 * so a viewer's place in a title follows them from a laptop to a headset. Before
 * sign-in the client still falls back to localStorage, which keeps the app fully
 * usable logged-out.
 */

/**
 * Run a middleware chain by hand, for a route whose gate depends on runtime
 * configuration rather than on how it was mounted.
 *
 * Any middleware that answers the response ends the chain, which is what makes
 * this safe: `done` runs only after every gate has called `next`.
 */
function runGate(chain, req, res, next, done) {
    let i = 0;

    const step = (err) => {
        if (err) return next(err);
        if (res.headersSent) return undefined;

        const middleware = chain[i];
        i += 1;

        if (!middleware) return done();
        return middleware(req, res, step);
    };

    return step();
}

/**
 * @param {import('express').Express} app
 */
export function mountViewer(app) {
    const router = express.Router();

    router.use(express.json({ limit: '16kb' }));

    /** Everything the client needs to personalise a freshly loaded catalog. */
    router.get('/state', requireAuth, (req, res) => {
        res.json({
            progress: progress.forUser(req.auth.sub),
            myList: myList.forUser(req.auth.sub)
        });
    });

    /**
     * Save a resume position.
     *
     * Called on a timer during playback, so it is deliberately the cheapest
     * write in the app: one upsert, no reads, no cache invalidation.
     */
    router.put('/progress/:titleId', requireAuth, (req, res) => {
        const position = Number(req.body?.position);

        if (!Number.isFinite(position) || position < 0) {
            res.status(400).json({ error: 'position must be a non-negative number' });
            return;
        }

        const title = titles.bySlug(req.params.titleId) ?? titles.byId(req.params.titleId);
        if (!title) {
            // Filesystem-sourced items have no database row; the client keeps
            // those locally and there is nothing to store.
            res.status(204).end();
            return;
        }

        progress.set(req.auth.sub, title.id, position, !!req.body?.completed);
        res.status(204).end();
    });

    router.put('/my-list/:titleId', requireAuth, (req, res) => {
        const title = titles.bySlug(req.params.titleId) ?? titles.byId(req.params.titleId);
        if (!title) {
            res.status(404).json({ error: 'unknown title' });
            return;
        }

        if (req.body?.member === false) myList.remove(req.auth.sub, title.id);
        else myList.add(req.auth.sub, title.id);

        res.status(204).end();
    });

    /**
     * Record a view.
     *
     * Fired once per playback session rather than continuously - the resume
     * endpoint above already carries the fine-grained signal, and one row per
     * viewing is enough for the creator dashboard.
     */
    router.post('/views/:titleId', async (req, res) => {
        const title = titles.bySlug(req.params.titleId) ?? titles.byId(req.params.titleId);
        if (!title) {
            res.status(204).end();
            return;
        }

        const seconds = Math.max(0, Number(req.body?.seconds) || 0);
        analytics.recordView(title.id, req.auth?.sub ?? null, seconds);

        res.status(204).end();
    });

    app.use('/api', router);

    /**
     * The catalog.
     *
     * Public, and shared-cacheable, until `AVR_IDENTITY_ENFORCE` is on - at
     * which point it becomes the first thing an age check stands in front of,
     * and the caching has to go with it. A `s-maxage` response that is only
     * meant for verified adults is one proxy away from being served to
     * everybody, so the enforced branch is `private, no-store` rather than a
     * shorter public window.
     *
     * The gate is evaluated per request rather than chosen at mount time, so a
     * deployment that turns enforcement on does not need a restart to mean it.
     *
     * This covers the catalog, not the bytes: `/media` and `/stream` are still
     * reachable by anyone holding a URL, exactly as they were before. Closing
     * that is signed delivery URLs, which is a different change - see
     * docs/IDENTITY.md.
     */
    app.get('/api/catalog', async (req, res, next) => {
        if (!identityEnforced()) {
            const library = await buildLibrary();
            res.set('Cache-Control', 'public, max-age=5, s-maxage=30, stale-while-revalidate=120');
            res.json(library);
            return;
        }

        runGate([requireAuth, loadFullUser, requireAgeAssurance], req, res, next, async () => {
            const library = await buildLibrary();
            res.set('Cache-Control', 'private, no-store');
            res.json(library);
        });
    });
}
