import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { censorBytes, PLACEHOLDER } from '../media/censor.js';
import { HOUSE_ADS } from '../../src/ads/house.js';

/**
 * House banners, covered.
 *
 * The files live in `server/house-ads/` rather than `public/`, because
 * anything in `public/` is served as shipped to anybody who asks for it by
 * name, and the whole point of this route is that nothing is. It answers the
 * way `/api/media` does: the covered copy, or the placeholder, and no branch
 * that returns the file itself. See `src/ads/house.js` for why a banner we
 * were told is SFW is covered anyway.
 *
 * Read once, at mount. They are a few tens of kilobytes, they change only on
 * a deploy, and a file that is missing is an id this route answers with the
 * placeholder rather than an error.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'house-ads');

export function mountHouseAds(app) {
    const bytes = new Map();
    for (const [id, ad] of Object.entries(HOUSE_ADS)) {
        try {
            bytes.set(id, fs.readFileSync(path.join(DIR, ad.file)));
        } catch (err) {
            console.warn(`[house-ads] ${id}: ${err.message}`);
        }
    }

    const router = express.Router();

    router.get('/:id', rateLimit({ windowMs: 60_000, max: 300 }), async (req, res) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');

        // `Object.hasOwn`, so `__proto__` and friends are unknown ids rather
        // than lookups that happen to succeed.
        const id = Object.hasOwn(HOUSE_ADS, req.params.id) ? req.params.id : null;
        const covered = id ? await censorBytes(id, bytes.get(id)).catch(() => null) : null;

        if (!covered) {
            res.set('Content-Type', 'image/svg+xml');
            res.set('Cache-Control', 'public, max-age=5');
            res.send(PLACEHOLDER);
            return;
        }

        // Public, and an hour rather than a day: the covered copy is the same
        // for every visitor, but a banner can be replaced under the same id.
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(covered);
    });

    app.use('/api/house', router);
}
