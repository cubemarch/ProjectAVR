import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { censor, isConfigured as censorConfigured, PLACEHOLDER } from '../media/censor.js';
import { verifyMediaUrl } from '../media/proxy.js';

/**
 * Partner artwork, with anything explicit covered.
 *
 * The general case of `/api/cams/thumb/:username`. That route covers one
 * partner's live thumbnails and is safe from request forgery because it takes
 * a room name rather than a URL; this one takes a URL and a signature over it,
 * for the reason written up in [`server/media/proxy.js`](../media/proxy.js) —
 * a paged catalogue of 164,595 scenes has no short stable list to index into.
 *
 * ## It serves one thing and never the other
 *
 * Every answer from this route is either a covered image or the placeholder.
 * There is no branch that returns the partner's original bytes, and there is
 * no parameter that asks for them: a verified visitor is given the partner URL
 * directly in the JSON and never comes here at all. That is what keeps this
 * route uninteresting to attack — passing the gate is not something it can
 * grant, because it has nothing ungated to hand out.
 *
 * ## It is not itself gated
 *
 * Same reasoning as the cam thumbnail route. Everything it can emit is already
 * covered, so there is nothing here for a gate to protect, and gating it would
 * make a visitor who *passed* the gate the only one who gets refused.
 */
export function mountMedia(app) {
    const router = express.Router();

    /**
     * Budgeted against a page, not a reader.
     *
     * A catalogue page is 24 cards and a scene panel adds 8 contact-sheet
     * frames, so a visitor browsing quickly is a few hundred images a minute
     * against a mostly-warm cache. Higher than the cam shelf's because the
     * cam shelf refreshes five visible tiles on a timer and this fires a burst
     * per page and then stops.
     */
    router.get('/', rateLimit({ windowMs: 60_000, max: 900 }), async (req, res) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');

        const url = verifyMediaUrl(req.query.u, req.query.s);

        // Unsigned, re-signed, tampered with, or pointing somewhere this proxy
        // will not fetch. One answer for all four, and it is the same answer a
        // dead inference service gets: there is nothing to be learned here
        // about which of them it was.
        const covered = url && censorConfigured() ? await censor(url).catch(() => null) : null;

        if (!covered) {
            res.set('Content-Type', 'image/svg+xml');
            res.set('Cache-Control', 'public, max-age=5');
            res.send(PLACEHOLDER);
            return;
        }

        // Public and long. Unlike a cam thumbnail this image does not change —
        // a boxcover is the same boxcover tomorrow — so the covered version is
        // byte-identical for every visitor for as long as the artwork lives,
        // and the signature in the URL is a perfectly good cache key. This is
        // what makes covering a whole catalogue affordable: the inference runs
        // once per image ever, not once per viewer.
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400, immutable');
        res.send(covered);
    });

    app.use('/api/media', router);
}
