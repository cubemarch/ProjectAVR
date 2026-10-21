import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { TtlCache } from '../cache.js';
import { signedMediaUrl } from '../media/proxy.js';
import { viewFor } from '../media/view.js';

/**
 * Bang's affiliate catalogue, proxied.
 *
 * A paid referral deal like the AEBN rows in `src/catalog/affiliates.js`, but
 * reached through this file rather than from the browser, and the reason is
 * the credential. AEBN's feeds are public JSON and the only thing in the URL
 * is a referral id, which is not a secret — it identifies who gets paid and
 * nothing else. Bang authenticate with an API key that is the account, so the
 * browser can never be given it: in front-end code it is in view-source, and
 * from there it reads this catalogue, enumerates the account's whitelabel
 * sites and edits its callback URLs. It lives in `AVR_BANG_API_KEY` and does
 * not leave this process.
 *
 * The other three reasons `routes/cams.js` gives apply unchanged — ad blockers
 * list partner API hosts, one upstream fetch serves every visitor, and the
 * shape of the response is ours rather than theirs.
 *
 * **Nothing is configured by default.** With no key every route answers
 * `{configured: false}` with an empty body and the rows draw nothing, which is
 * the same posture as the cam shelf and the ad modules. A front page without a
 * Bang deal is not a broken front page.
 *
 * ## What can and cannot be served from here
 *
 * The brief was to serve the content from the API so the visitor stays on this
 * site. Measured against the live API on 2026-10-20, that line falls in a
 * specific place:
 *
 *   - **Artwork can.** `i.bang.com` serves covers, screenshots and performer
 *     portraits over HTTPS with no hotlink protection and no referer check, so
 *     a card, a contact sheet and a cast list all render here.
 *   - **Metadata can.** Title, runtime, studio, series, release date, cast and
 *     genres all come back in the search response.
 *   - **The video cannot.** `files[].url` looks like a direct MP4 and is not:
 *     every one answers **403**, anonymously and with the affiliate key. They
 *     are member assets and the affiliate tier is not entitled to them. So
 *     there is no version of this that plays a Bang scene on this domain, and
 *     the conversion click has to leave. That is also the click that pays.
 *
 * ## Attribution
 *
 * `AVR_BANG_AFF` is the tracking code appended to every outbound link. Unset,
 * the links still work and simply pay nobody; see {@link watchUrl}.
 *
 * It is reachable from the API, but only if you already know the numeric
 * affiliate account id, which nothing the key can read reports — it is on the
 * dashboard, and for this account it is **15293**. With it:
 *
 * ```sh
 * curl -s -H "Authorization: affiliate $AVR_BANG_API_KEY" \
 *   https://api.bang.com/affiliate/15293/sites/options
 * ```
 *
 * `links[]` comes back with one entry **per payment program**, each with its
 * own `aff`, and choosing between them is choosing how this site is paid:
 *
 * | `link_id` | `aff` | programme |
 * | --- | --- | --- |
 * | 33067 | `eyJ3IjoxNTI5MywibCI6MzMwNjd9` | Pay Per Signup |
 * | 33068 | `eyJ3IjoxNTI5MywibCI6MzMwNjh9` | 60% Revshare |
 *
 * The code is base64 of `{"w":15293,"l":<link_id>}` — the account and the
 * link, in plain sight. It is **not** a credential: it is in the query string
 * of every outbound link on the page and is public by construction, unlike
 * the API key above. It lives in `.env` so a deployment can change programme
 * without a rebuild, not because it needs hiding.
 *
 * Worth knowing before debugging a commission report: a deep link to a scene
 * answers `302 → /tour/sfw`, their age wall, for a visitor it does not
 * recognise — **and the redirect keeps `aff`**. So the sale tracks and the
 * destination does not, which is precisely the AEBN behaviour already written
 * up in `src/catalog/affiliates.js`. It is the strongest argument for the
 * detail panel on this side: if the click lands on a generic tour page either
 * way, the screenshots and the cast are worth more here than there.
 *
 * ## On search
 *
 * Same posture as the cam row, for the same reason — a catalogue thousands of
 * affiliates serve verbatim is scaled content abuse if it is given URLs:
 *
 *   - these routes are `noindex` and under `/api/`, which `robots.txt` disallows;
 *   - no scene gets a URL of its own — the detail panel opens in-page;
 *   - nothing here reaches the sitemap, the `<noscript>` or the JSON-LD;
 *   - outbound links carry `sponsored nofollow noopener noreferrer`, applied
 *     by the shelf from `AFFILIATE_LINK_REL`.
 *
 * @see docs/SEARCH.md for the rest of the search posture.
 */

const UPSTREAM = 'https://api.bang.com';

/** Where their artwork is served from. Pinned, because it goes in `<img src>`. */
const IMAGE_HOST = 'i.bang.com';

/** Where a click is allowed to go. Pinned, because it goes in an `href`. */
const WATCH_ORIGIN = 'https://www.bang.com';

/**
 * A catalogue of 164,595 scenes that changes a few times a day.
 *
 * Nothing like the cam feed's forty-five seconds — a scene released this
 * morning being an hour late to a shelf costs nothing, and the sorts these
 * rows use are lifetime aggregates that do not move perceptibly within a day.
 */
const TTL_MS = Number(process.env.AVR_BANG_TTL_MS) || 15 * 60_000;

const TIMEOUT_MS = Number(process.env.AVR_BANG_TIMEOUT_MS) || 8_000;

/** Most we will ask upstream for, and most we will hand the browser, per page. */
const PAGE_MAX = 60;

/** Longest `?q=` we will forward. */
const QUERY_MAX = 64;

/**
 * The orderings the API actually has, and the whole of the whitelist.
 *
 * **There is no "top selling" sort.** `GET /content/search/params/videos`
 * answers `{"by":{"views":[daily,weekly,monthly,allTime],
 * "rating":[daily,weekly,monthly,allTime],"releaseDate":[desc,asc]}}` and that
 * is the entire vocabulary — revenue is not a dimension the affiliate API
 * exposes, so a row called "Top Selling" would be a number we cannot see. What
 * is here is what the sorts honestly are.
 *
 * It is a whitelist and not a passthrough because a `by` the index cannot sort
 * on comes back as **HTTP 200** with an Elasticsearch `query_shard_exception`
 * in the body, naming the index and its UUID. Forwarding visitor input into
 * that parameter would turn a typo into an upstream error disclosure.
 */
const SORTS = new Map([
    ['most-watched', 'views.allTime'],
    ['trending', 'views.monthly'],
    ['top-rated', 'rating.allTime'],
    ['newest', 'releaseDate.desc']
]);

/**
 * The rows the front page draws, in order.
 *
 * `title` is what the shelf heading says, and each one is the sort described
 * plainly. "Most Watched" rather than "Top Selling" is the whole of the note
 * on {@link SORTS} applied to the copy: this domain is appealing a Safe
 * Browsing listing and is in no position to print a claim its own data cannot
 * support.
 */
const SHELVES = new Map([
    ['most-watched', 'Most Watched'],
    ['trending', 'Trending This Month'],
    ['top-rated', 'Top Rated']
]);

const cache = new TtlCache(TTL_MS);

/* ------------------------------------------------------------- normalising -- */

/**
 * An image URL we are willing to put in a `src`: HTTPS, and theirs.
 *
 * Pinned to the host rather than to the scheme alone — unlike the cam
 * thumbnails, which come off a CDN whose hostname is not stable. Every image
 * in this catalogue is on `i.bang.com`, so there is no reason to accept
 * anything looser, and a payload that started pointing somewhere else is a
 * thing to notice rather than to render.
 */
function imageUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;

    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') return null;
    if (url.hostname !== IMAGE_HOST && !url.hostname.endsWith(`.${IMAGE_HOST}`)) return null;

    return url.toString();
}

/**
 * The slug Bang's own URLs use for a scene.
 *
 * Taken out of a file URL rather than built from the title, because theirs is
 * authoritative and ours would be a guess: `files[].url` is
 * `/video/file/{id}/{slug}.{quality}.mp4`, so the slug is the basename with
 * the quality and the extension removed. A scene with no files falls back to
 * slugifying the name, which is what their slugs look like anyway.
 *
 * It matters because the bare `/video/{id}` form 404s — the slug is part of
 * the route, not decoration.
 */
function sceneSlug(video) {
    const files = Array.isArray(video.files) ? video.files : [];

    for (const file of files) {
        if (typeof file?.url !== 'string') continue;

        let last;
        try {
            last = new URL(file.url).pathname.split('/').pop() ?? '';
        } catch {
            continue;
        }

        // `name.1080p.mp4` -> `name`. Exactly the quality and the extension,
        // anchored, and no more: a slug may legitimately contain a dot —
        // "dr.-smith-scene-2" — and a greedy strip would mangle it into a
        // link that 404s.
        const slug = last.replace(/\.[^.]+\.[^.]+$/, '');

        // Dots are unreserved, so `encodeURIComponent` leaves them alone and
        // `..` would survive into the path. Rejected explicitly rather than
        // relying on the charset, because the charset has to admit the dot.
        if (!slug.includes('..') && /^[a-z0-9.-]{1,120}$/i.test(slug)) return slug;
    }

    return (
        String(video.name ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 120) || 'scene'
    );
}

/**
 * Where a card points, with attribution applied.
 *
 * Built here from an id and a slug rather than taken from the payload. Nothing
 * upstream sends is allowed to decide where a link on our page goes, and
 * `new URL` against a fixed origin plus the origin check below is what makes
 * that structural rather than a promise — this is the same bound
 * `toCard` enforces in `src/catalog/affiliates.js`, and it exists for the
 * reason that file gives: a link to somewhere else entirely, under our
 * heading and in our styling, is the exact shape of the thing this domain is
 * currently listed by Safe Browsing for.
 *
 * With no `AVR_BANG_AFF` the link is unattributed and still correct. That is
 * deliberate: a missing tracking code should cost a commission, not a working
 * page, and it is the normal state in development.
 */
function watchUrl(id, slug) {
    let url;
    try {
        url = new URL(`/video/${encodeURIComponent(id)}/${encodeURIComponent(slug)}`, WATCH_ORIGIN);
    } catch {
        return null;
    }

    if (url.origin !== WATCH_ORIGIN) return null;

    const aff = process.env.AVR_BANG_AFF;
    if (aff) url.searchParams.set('aff', aff);

    return url.toString();
}

/** Trim, collapse and clip a string from upstream. */
function text(raw, max) {
    return String(raw ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * One upstream scene, reduced to what a card draws.
 *
 * Returns `null` for anything we will not show. A card with no artwork and no
 * destination is somebody else's bandwidth on our page, so both are required
 * rather than defaulted.
 */
function normaliseVideo(video) {
    if (!video || typeof video !== 'object') return null;

    // Their ids are Mongo ObjectIds and the URL is built out of this one.
    // Anything else is either a schema change or an injection attempt, and the
    // two are handled the same way.
    const id = typeof video.id === 'string' ? video.id : '';
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;

    const title = text(video.name, 160);
    if (!title) return null;

    const href = watchUrl(id, sceneSlug(video));
    if (!href) return null;

    // Their two keys, and both are needed. `id` is the Mongo ObjectId their
    // own file URLs are built from, so it is what the watch link uses.
    // `identifier` is the numeric one, and it is the only one their search
    // will look a single scene up by — `?id=` answers with an error body, so
    // the detail panel has to ask by this. Carried as `ref` rather than
    // `identifier` because the card is ours, not theirs.
    const ref = Number(video.identifier);

    const screenshots = (Array.isArray(video.screenshots) ? video.screenshots : [])
        .map(imageUrl)
        .filter(Boolean)
        .slice(0, 8);

    // The cover is the card, because a boxcover is composed and a screenshot
    // is a frame; the first screenshot is only a fallback for a scene whose
    // DVD has no artwork.
    const image = imageUrl(video.dvd?.img) ?? screenshots[0] ?? null;
    if (!image) return null;

    const duration = Number(video.duration);

    return {
        id,
        ref: Number.isInteger(ref) && ref > 0 ? ref : null,
        title,
        href,
        image,
        screenshots,
        durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
        hd: video.hd === true,
        releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(video.release_date ?? '') ? video.release_date : null,
        studio: text(video.studio?.name, 64) || null,
        series: text(video.series?.name, 96) || null,

        actors: (Array.isArray(video.actors) ? video.actors : [])
            .map((a) => ({ name: text(a?.name, 64), image: imageUrl(a?.img) }))
            .filter((a) => a.name)
            .slice(0, 8),

        // `id: 0` for every one of them upstream, so the name is the only
        // thing here worth carrying and there is nothing to key a filter on.
        genres: (Array.isArray(video.genres) ? video.genres : [])
            .map((g) => text(g?.name, 32))
            .filter(Boolean)
            .slice(0, 10)
    };
}

/* ------------------------------------------------------------------ cover -- */

/**
 * Swap every artwork URL in a payload for its covered proxy.
 *
 * Applied per request and never to the cached list, because whether a visitor
 * gets covered artwork is the one thing about these rows that is not the same
 * for everybody. {@link search} caches the partner URLs; this runs on the way
 * out.
 *
 * ## This reverses a standing decision, on the record
 *
 * Until 2026-10-20 this route was ungated and the note on it said so: partner
 * rows were shown to every visitor because boxcover art is not a live
 * broadcast. That held while the age gate was a blocking interstitial — a
 * visitor who had not passed it never reached a page that asked for these
 * rows, so "ungated route" and "ungated artwork" were different statements.
 *
 * The gate is no longer blocking. The front page now renders for an
 * unverified visitor with the artwork covered, which is what makes the gate
 * worth passing — and the moment the page renders, an ungated route here is
 * uncovered adult artwork in front of somebody who has not verified. So the
 * rows are covered instead of withheld (David, 2026-10-20), everywhere rather
 * than only in the twenty-seven: see `docs/CENSOR.md`.
 *
 * ## Fail-closed falls out of the proxy
 *
 * There is no "is the censor up" branch here on purpose. A signed URL always
 * resolves through `/api/media`, and that route answers with the locked
 * placeholder when the inference service is unset, down or slow. An outage
 * costs the artwork, never uncovers it, and it costs it without this file
 * needing to know.
 *
 * @param {object[]} items
 * @returns {object[]} a copy; the cached originals are not touched
 */
function cover(items) {
    const one = (raw) => (raw ? signedMediaUrl(raw) : null);

    return items.map((item) => ({
        ...item,
        image: one(item.image),
        screenshots: item.screenshots.map(one).filter(Boolean),
        actors: item.actors.map((a) => ({ ...a, image: one(a.image) }))
    }));
}

/* ---------------------------------------------------------------- fetching -- */

/**
 * One upstream search, cached and shared by every visitor.
 *
 * `gay` is deliberately never sent, and that is not an oversight. The
 * parameter is documented as a boolean and behaves as present-or-absent:
 * `gay=true` and `gay=false` **both** return the same 9,888 gay-category
 * results, and `gay=0` is not even valid JSON back. Omitting it is the only
 * way to get the 164,595 straight ones, which is what the rows beside this
 * one carry — so the straight catalogue is the default here by the same
 * absence. Sending `gay=false` to ask for it would return the exact opposite.
 *
 * The key goes in the `Authorization` header rather than the `a-api-key` query
 * parameter the spec also accepts. Both authenticate; only one of them stays
 * out of access logs, proxy logs and error reports.
 */
async function search(kind, params) {
    const key = `${kind}:${JSON.stringify(params)}`;

    return cache.get(key, async () => {
        const url = new URL(`/content/search/${kind}`, UPSTREAM);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    Authorization: `affiliate ${process.env.AVR_BANG_API_KEY}`
                },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`upstream unreachable: ${err.message}`);
        }

        if (!res.ok) throw new Error(`upstream answered ${res.status}`);

        const payload = await res.json();

        // An upstream error arrives as 200 with `{error: "400 Bad Request: …"}`
        // carrying an Elasticsearch stack trace, so `res.ok` is not the check.
        // Treating a missing list as a failure rather than as an empty shelf is
        // what keeps that from rendering as "nothing here" — and keeps the
        // index name out of anything we might later log.
        if (!Array.isArray(payload?.results)) {
            throw new Error(`upstream sent no result list${payload?.error ? ' (error body)' : ''}`);
        }

        return {
            total: Number(payload.total) || 0,
            items: payload.results.map(normaliseVideo).filter(Boolean)
        };
    });
}

/* ------------------------------------------------------------------ routes -- */

/** `?page=` and `?size=`, clamped to something this server will pay for. */
function paging(query) {
    const page = Math.min(Math.max(Number(query.page) || 1, 1), 100);
    const size = Math.min(Math.max(Number(query.size) || 24, 1), PAGE_MAX);

    return { page, size };
}

export function mountBang(app) {
    const router = express.Router();

    /**
     * Belt and braces with `robots.txt`, which already disallows `/api/`: a
     * disallow stops a crawl, a header is read by anything that got here
     * without consulting the file first.
     *
     * Age-gated as of 2026-10-20, which reverses the standing decision that
     * used to be recorded here. The rows are still shown to every visitor —
     * that part has not changed — but an unverified one gets the artwork
     * covered rather than the original. {@link cover} has the why; the short
     * version is that "ungated route" stopped meaning "ungated artwork" the
     * moment the age gate stopped blocking the page.
     */
    router.use((req, res, next) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');

        if (!process.env.AVR_BANG_API_KEY) {
            // The normal state in development and on any deployment without a
            // Bang deal. Not an error: the page is expected to render without
            // these rows, so a 503 would put a red line in the console of a
            // working site.
            res.set('Cache-Control', 'no-store');
            res.json({ configured: false, items: [], total: 0 });
            return;
        }

        next();
    });

    /**
     * One front-page row.
     *
     * Shaped for `fetchAffiliateRow` in `src/catalog/affiliates.js` rather than
     * for a caller of its own: `items` is the list that file reads, and every
     * `href` in it is already complete and already attributed, so the client's
     * `toCard` applies an empty `query` and only re-checks the origin. That is
     * what keeps `AVR_BANG_AFF` on this side of the wire along with the key —
     * the tracking code is not a secret, but there is no reason to publish a
     * second copy of it in the bundle when the server is building the link
     * anyway.
     *
     * Public and unauthenticated, like the affiliate rows beside it. The
     * limiter is for our own sake: every visitor shares one cached upstream
     * call, so the budget is sized against something looping rather than
     * against readers.
     */
    router.get('/shelf/:id', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
        const title = SHELVES.get(req.params.id);
        const by = SORTS.get(req.params.id);

        if (!title || !by) {
            res.set('Cache-Control', 'no-store');
            res.status(404).json({ error: 'no such shelf', code: 'unknown_shelf' });
            return;
        }

        try {
            const { items } = await search('videos', { by, size: 24, page: 1 });
            const view = viewFor(req);

            // Visitor-specific now, and only in one way: whether the artwork
            // is covered. That is enough to make an edge cache in front of
            // this wrong, so the header follows the gate rather than being
            // fixed - see `viewFor` in `server/media/view.js`.
            res.set('Cache-Control', view.cacheControl);
            res.json({
                configured: true,
                id: req.params.id,
                title,
                covered: view.covered,
                items: view.covered ? cover(items) : items
            });
        } catch (err) {
            console.warn(`[bang] shelf ${req.params.id} failed: ${err.message}`);

            // Empty rather than 502. `fetchAffiliates` drops a program that
            // returns nothing, so this renders as the row being absent, which
            // is the right outcome for one partner having a bad minute.
            res.set('Cache-Control', 'no-store');
            res.json({ configured: true, id: req.params.id, title, items: [] });
        }
    });

    /**
     * The catalogue, searched and paged, without leaving this site.
     *
     * This is the half of the brief that can actually be honoured. The scenes
     * themselves are member assets and 403 to us, but 164,595 of them are
     * searchable here, rendered as our own cards, and only the final
     * conversion click leaves.
     *
     * `q` is forwarded to their `term`; `sort` is resolved through
     * {@link SORTS} and never passed through. A tighter budget than the
     * shelves because each distinct query is a distinct upstream call: the
     * cache key includes the term, so a search box is the one thing here that
     * can miss the cache on every request.
     */
    router.get('/search', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
        const { page, size } = paging(req.query);
        const by = SORTS.get(String(req.query.sort ?? '')) ?? SORTS.get('most-watched');
        const term = typeof req.query.q === 'string' ? req.query.q.slice(0, QUERY_MAX).trim() : '';

        const params = { by, size, page };
        if (term) params.term = term;

        try {
            const { items, total } = await search('videos', params);
            const view = viewFor(req);

            res.set('Cache-Control', view.cacheControl);
            res.json({
                configured: true,
                total,
                page,
                size,
                covered: view.covered,

                // What the visitor can actually reach, which is not
                // `total / size`: `page` is clamped at 100 above, so saying
                // otherwise would draw pagination that 404s past the clamp.
                pages: Math.min(Math.ceil(total / size) || 1, 100),
                items: view.covered ? cover(items) : items
            });
        } catch (err) {
            console.warn(`[bang] search failed: ${err.message}`);

            res.set('Cache-Control', 'no-store');
            res.status(502).json({ error: 'catalogue unavailable', code: 'upstream_failed' });
        }
    });

    /**
     * One scene, in full, for the panel that opens in-page.
     *
     * The contact sheet and the cast are the whole point of this route and the
     * nearest thing to the brief that the licence allows: a visitor decides
     * whether they want it here, on our page, from eight screenshots and a
     * cast list, instead of being sent to a partner's age wall to find out.
     *
     * Looked up through the same search endpoint — there is no `/content/{id}`
     * in their API — so it costs one upstream call and shares the same cache.
     *
     * By `identifier`, the numeric key, and not by the Mongo `id` the link is
     * built from. `?id=` is in their spec and does not work: it answers 200
     * with an error body and no result list. See the note in
     * {@link normaliseVideo} on carrying both.
     */
    router.get('/scene/:ref', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
        const ref = String(req.params.ref);

        if (!/^\d{1,12}$/.test(ref)) {
            res.set('Cache-Control', 'no-store');
            res.status(400).json({ error: 'not an id', code: 'bad_id' });
            return;
        }

        try {
            const { items } = await search('videos', { identifier: ref, size: 1, page: 1 });

            // Their search answers a miss with an empty list rather than a
            // 404, so the distinction is drawn here.
            if (!items.length) {
                res.set('Cache-Control', 'no-store');
                res.status(404).json({ error: 'no such scene', code: 'not_found' });
                return;
            }

            const view = viewFor(req);

            res.set('Cache-Control', view.cacheControl);
            res.json({
                configured: true,
                covered: view.covered,
                scene: view.covered ? cover(items)[0] : items[0]
            });
        } catch (err) {
            console.warn(`[bang] scene ${ref} failed: ${err.message}`);

            res.set('Cache-Control', 'no-store');
            res.status(502).json({ error: 'catalogue unavailable', code: 'upstream_failed' });
        }
    });

    app.use('/api/bang', router);
}

/** Test seam: drop everything cached so a case can control what the next read sees. */
export function _resetBangCache() {
    cache.invalidate();
}

export const _internals = { normaliseVideo, imageUrl, watchUrl, sceneSlug, SORTS, SHELVES };
