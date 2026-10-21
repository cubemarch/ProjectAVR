import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { TtlCache } from '../cache.js';
import { visitorGate } from '../identity/visitor-gate.js';
import { signedMediaUrl } from '../media/proxy.js';
import { AFFILIATE_PROGRAMS } from '../../src/catalog/affiliates.js';

/**
 * AEBN's three public feeds, proxied so their artwork can be covered.
 *
 * These were read straight from the browser until 2026-10-20, and the reason
 * they moved is narrow: there is no credential here to protect — AEBN's feeds
 * are public JSON and the only id in the URL says who gets paid — but a feed
 * the browser fetches is a feed this server never sees, and artwork this server
 * never sees is artwork it cannot cover. Covering is the whole point. Bang's
 * rows moved for the opposite reason (`routes/bang.js` holds a key that is the
 * account) and arrive at the same place.
 *
 * ## The payload shape is deliberately not touched
 *
 * Each feed is handed back exactly as the partner sent it, minus the covering
 * rewrite. The three adapters in `src/catalog/affiliates.js` already know these
 * shapes — a bare array for the chart feeds, `{slides: […]}` for the pitch
 * slider — and re-shaping here would mean writing that knowledge down twice and
 * keeping the copies in step. The browser cannot tell this route from the
 * partner except by the image URLs, which is the only difference there is.
 *
 * Attribution is still applied in the browser for the same reason. AEBN's
 * `contentUrl` and `vodUrl` are site-relative paths resolved against
 * `linkOrigin`, so applying `query` here would mean emitting absolute URLs and
 * changing the shape to do it. The params are public, they are already in every
 * outbound link on the page, and `toCard` puts them on. Bang is the one that
 * attributes server-side, because for Bang the href is built server-side too.
 */

/** How long one upstream read is shared. Charts that change a few times a month. */
const TTL_MS = 5 * 60 * 1000;

const TIMEOUT_MS = 8000;

/**
 * The feeds this route will read, keyed by the path segment that selects them.
 *
 * Derived from the program registry rather than listed again here, so that the
 * URL the browser asks for and the URL this server fetches cannot drift apart:
 * a program whose `api` is `/api/aebn/stars` is by construction the one this
 * answers `stars` with. A program with no `upstream` is browser-direct and does
 * not belong to this route.
 */
function feeds() {
    const map = new Map();

    for (const program of AFFILIATE_PROGRAMS) {
        if (!program.upstream || !program.api.startsWith('/api/aebn/')) continue;
        map.set(program.api.slice('/api/aebn/'.length), program.upstream);
    }

    return map;
}

const cache = new TtlCache(TTL_MS);

/**
 * Every partner image in a payload, replaced with a covered one.
 *
 * Walks the whole structure rather than naming the fields that hold images,
 * and that is the point of it: a list of field names is a list that goes out of
 * date the first time a partner adds a size, and the failure is silent and in
 * the wrong direction — one uncovered picture on a page that is supposed to
 * have none. Three feeds with three different shapes go through this one
 * function and none of their shapes is written down.
 *
 * The cost of walking rather than selecting is that fields nothing renders get
 * signed too — AEBN's star feed carries five sizes and the row draws one. That
 * is four unused HMACs per star, about 7KB on a ten-star payload, and no
 * inference at all: signing is arithmetic, and covering only happens when
 * something actually fetches the URL.
 *
 * **A partner image we cannot sign is dropped, not passed through.** That is
 * the fail-closed half, and it is the half that matters if AEBN ever serves
 * artwork from a host that is not in `HOSTS`: the row renders with a gap rather
 * than with an uncovered picture. Strings that are not images — titles, sell
 * lines, the site-relative `contentUrl` paths — are left exactly as they are.
 */
function coverDeep(value) {
    if (typeof value === 'string') {
        if (!looksLikeImage(value)) return value;
        return signedMediaUrl(value) ?? null;
    }

    if (Array.isArray(value)) return value.map(coverDeep);

    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coverDeep(v)]));
    }

    return value;
}

const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif|bmp|svg)$/i;

/**
 * Whether a string is an absolute http(s) URL pointing at an image file.
 *
 * The trigger for the fail-closed branch above, so it errs towards saying yes:
 * a string this wrongly accepts becomes a covered image or a gap, and a string
 * it wrongly rejects is an uncovered picture. `allowedImage` in
 * [`server/media/proxy.js`](../media/proxy.js) is what actually decides which
 * URLs get fetched; this only decides which ones get asked about.
 */
function looksLikeImage(raw) {
    if (!/^https?:\/\//i.test(raw)) return false;

    try {
        return IMAGE_PATH.test(new URL(raw).pathname);
    } catch {
        return false;
    }
}

/** One upstream read, shared by every visitor regardless of their gate. */
async function read(feed, url) {
    return cache.get(feed, async () => {
        let res;

        try {
            res = await fetch(url, {
                headers: { Accept: 'application/json' },
                referrerPolicy: 'no-referrer',
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`upstream unreachable: ${err.message}`);
        }

        if (!res.ok) throw new Error(`upstream answered ${res.status}`);

        return res.json();
    });
}

export function mountAebn(app) {
    const router = express.Router();

    /**
     * Sized against a page load rather than a reader: the front page reads all
     * three of these once and then stops, and every visitor shares one cached
     * upstream call, so the budget is for something looping.
     */
    router.get('/:feed', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');

        const upstream = feeds().get(req.params.feed);

        if (!upstream) {
            res.set('Cache-Control', 'no-store');
            res.status(404).json({ error: 'no such feed', code: 'unknown_feed' });
            return;
        }

        let payload;
        try {
            payload = await read(req.params.feed, upstream);
        } catch {
            // The partner is down or slow. An empty row beats a broken one, and
            // `fetchAffiliates` drops a program that returns nothing — so this
            // renders as the row not being there rather than as an error.
            res.set('Cache-Control', 'no-store');
            res.status(502).json({ error: 'partner unavailable', code: 'upstream_failed' });
            return;
        }

        const covered = !visitorGate(req).ok;

        // Visitor-specific in exactly one way, so the header follows the gate.
        // Same rule and same reasoning as `viewFor` in `routes/bang.js`:
        // `no-store` rather than a short TTL, so that passing the gate redraws
        // the page uncovered at once instead of a few minutes later.
        res.set('Cache-Control', covered ? 'private, no-store' : 'public, max-age=300');
        res.json(covered ? coverDeep(payload) : payload);
    });

    app.use('/api/aebn', router);
}

/** Test seam: drop the upstream cache between cases. */
export function _resetAebnCache() {
    cache.invalidate();
}

export const _internals = { coverDeep, looksLikeImage, feeds };
