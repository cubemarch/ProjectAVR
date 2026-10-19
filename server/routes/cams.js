import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { TtlCache } from '../cache.js';
import { resolveRegion } from '../identity/jurisdiction.js';
import { visitorGate } from '../identity/visitor-gate.js';

/**
 * The live cam row: Chaturbate's affiliate feed, normalised.
 *
 * Chaturbate publish an "online rooms" endpoint to affiliates that returns
 * every public room currently broadcasting, each with a thumbnail, a revshare
 * link and an embeddable player. The embed is the interesting one — it is the
 * white label: a real live room playing inside our page, on our domain, that
 * still pays.
 *
 * The endpoint is CORS-open (`access-control-allow-origin: *`), so the browser
 * could call it directly and this file need not exist. Four reasons it does:
 *
 *   - **The affiliate code would be in the bundle.** `wm` is the only thing
 *     tying a conversion to this site. In front-end code it is in view-source
 *     on a public page, and swapping it for somebody else's is a one-line
 *     user script. Here it never leaves the process. `AVR_CHATURBATE_WM`
 *     belongs in `.env` and nowhere else.
 *   - **Ad blockers.** `chaturbate.com/api/...` is on EasyPrivacy and in
 *     uBlock's default lists. A browser-direct row is an empty row for a
 *     large fraction of exactly the audience that visits a site like this.
 *   - **One upstream fetch serves everybody.** The list is identical for all
 *     visitors, so it is cached for {@link TTL_MS} and a hundred concurrent
 *     page loads cost one request rather than a hundred.
 *   - **We do our own geo filtering**, below, which a cached browser-direct
 *     response could not.
 *
 * **Nothing is configured by default.** With no `AVR_CHATURBATE_WM` the route
 * answers `{configured: false, rooms: []}` and the row draws nothing — the
 * same posture as the ad modules. An invalid code is worse than no code and
 * indistinguishable from the outside: Chaturbate answer `{"results":[]}` to a
 * wrong `wm` rather than an error, so a typo looks exactly like a quiet night.
 *
 * ## On search
 *
 * A white label cam feed is the textbook case of everything Google's spam
 * policy names. Thousands of affiliates serve a byte-identical room list;
 * generating a page per room would be scaled content abuse; the rooms are gone
 * in an hour, so anything indexed 404s by the time it is clicked. So:
 *
 *   - this route is `noindex` and under `/api/`, which `robots.txt` disallows;
 *   - no room ever gets a URL of its own — the player opens in-page;
 *   - nothing here reaches the sitemap, the `<noscript>` or the JSON-LD;
 *   - outbound links carry `sponsored nofollow noopener noreferrer`.
 *
 * What is *not* duplicated is the selection. This site is about VR, so the
 * ordering here is VR-first, and the row is presented as a VR cam shelf rather
 * than as a mirror of somebody's front page. That is the only part of this
 * feature that is ours, and it is the part that justifies publishing it.
 *
 * @see docs/SEARCH.md for the rest of the search posture.
 */

const UPSTREAM = 'https://chaturbate.com/api/public/affiliates/onlinerooms/';

/** Rooms go on and off air constantly; a minute stale is a dead thumbnail. */
const TTL_MS = Number(process.env.AVR_CHATURBATE_TTL_MS) || 45_000;

const TIMEOUT_MS = Number(process.env.AVR_CHATURBATE_TIMEOUT_MS) || 8_000;

/** Upstream caps this well below what it accepts; 500 is what it actually gives. */
const UPSTREAM_LIMIT = 500;

/** What we will hand the browser in one response. */
const PAGE_MAX = 60;

const cache = new TtlCache(TTL_MS);

/**
 * The last list that parsed, kept past its TTL.
 *
 * An upstream blip would otherwise empty the row for every visitor until it
 * cleared. A two-minute-old thumbnail of a room that has since gone offline is
 * a worse click than a fresh one and a much better page than nothing, and the
 * player handles an offline room on its own.
 */
let lastGood = null;

/* ------------------------------------------------------------- normalising -- */

/**
 * Tags that mean this room is shot for a headset.
 *
 * Deliberately a closed list rather than a substring match. `3d` as a
 * substring hits nothing useful and `vr` hits `servername`, `vrchat` and a
 * dozen usernames; the row's entire claim to being curated rather than
 * mirrored rests on this being right, so it is enumerated.
 */
const VR_TAGS = new Set([
    'vr',
    'vr180',
    '180vr',
    'vr360',
    '360vr',
    'vrporn',
    'vrcam',
    'virtualreality',
    'virtual_reality',
    'oculus',
    'quest',
    'questpro',
    'metaquest',
    'htcvive',
    'vive',
    'psvr',
    'psvr2',
    '3d',
    'stereoscopic'
]);

/** `"AL,AK,AZ"` → `Set {'AL','AK','AZ'}`. Absent, empty and junk all mean none. */
function codeSet(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;

    const codes = raw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{2}$/.test(c));

    return codes.length ? new Set(codes) : null;
}

/**
 * The `src` of an embed snippet, if it is one we are willing to frame.
 *
 * Upstream hands us `iframe_embed_revshare` as a string of HTML. Putting that
 * in the page is handing a third party `innerHTML` on our origin — today it is
 * an iframe, and nothing about the contract says it stays one. So the URL is
 * extracted, parsed, and checked to be HTTPS on Chaturbate's own domain, and
 * the browser builds its own element around it with the attributes we chose.
 * Anything that fails the check is dropped rather than patched.
 */
function embedSrc(snippet) {
    if (typeof snippet !== 'string') return null;

    const match = snippet.match(/\bsrc=["']([^"']+)["']/i);
    if (!match) return null;

    return chaturbateUrl(match[1].replace(/&amp;/g, '&'));
}

/** A URL we will put in an `href` or a `src`: HTTPS, and theirs. */
function chaturbateUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;

    let url;
    try {
        url = new URL(raw, UPSTREAM);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'chaturbate.com' && !url.hostname.endsWith('.chaturbate.com')) return null;

    return url.toString();
}

/** A thumbnail URL. Theirs live on a CDN host, so only the scheme is pinned. */
function imageUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;

    try {
        return new URL(raw).protocol === 'https:' ? raw : null;
    } catch {
        return null;
    }
}

/**
 * One upstream room, reduced to what the row draws.
 *
 * Returns `null` for anything we will not show. The age check is redundant —
 * Chaturbate verify every broadcaster and the field is self-reported anyway —
 * but it costs one comparison and this is not the site to leave that one out
 * of on the grounds that somebody else already did it.
 */
function normalise(room) {
    if (!room || typeof room !== 'object') return null;

    const username = typeof room.username === 'string' ? room.username.trim() : '';
    if (!/^[\w.-]{1,64}$/.test(username)) return null;

    if (room.room_status !== 'public') return null;

    const age = Number(room.age);
    if (Number.isFinite(age) && age < 18) return null;

    const href = chaturbateUrl(room.chat_room_url_revshare);
    const embed = embedSrc(room.iframe_embed_revshare);
    const thumb = imageUrl(room.image_url_360x270) || imageUrl(room.image_url);

    // No link is no card: a thumbnail that cannot be clicked earns nothing and
    // is just somebody else's bandwidth on our page.
    if (!href || !thumb) return null;

    const tags = Array.isArray(room.tags)
        ? room.tags
              .filter((t) => typeof t === 'string')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 12)
        : [];

    return {
        username,
        name: String(room.display_name || room.username).trim().slice(0, 64),
        subject: String(room.room_subject || '').trim().slice(0, 160),
        thumb,
        href,
        embed,
        gender: typeof room.gender === 'string' ? room.gender : null,
        age: Number.isFinite(age) && age >= 18 ? age : null,
        viewers: Number.isFinite(Number(room.num_users)) ? Number(room.num_users) : 0,
        hd: room.is_hd === true,
        fresh: room.is_new === true,
        vr: tags.some((t) => VR_TAGS.has(t.replace(/[^a-z0-9_]/g, ''))),
        tags,
        languages: Array.isArray(room.spoken_languages)
            ? room.spoken_languages.filter((l) => typeof l === 'string').slice(0, 4)
            : [],
        blockedStates: codeSet(room.block_from_states),
        blockedCountries: codeSet(room.block_from_countries)
    };
}

/**
 * Whether this visitor may be shown this room.
 *
 * `block_from_states` and `block_from_countries` are the broadcaster's own
 * exclusions, and Chaturbate enforce them themselves on the click and in the
 * player, from the real address, which is the authoritative layer. Honouring
 * them here as well is not compliance theatre so much as not drawing a card
 * whose only possible outcome is a "not available in your region" page.
 *
 * An unknown region shows the room. The alternative — hiding every room with
 * any exclusion list, which is most of them — empties the row on any
 * deployment that is not behind an edge that sets geo headers, including
 * every local one. Chaturbate still enforce on the click either way.
 */
function visibleTo(room, { country, region }) {
    if (country && room.blockedCountries?.has(country)) return false;
    if (country === 'US' && region && room.blockedStates?.has(region)) return false;

    return true;
}

/** VR first, then the room most worth watching. Ours, not upstream's order. */
function rank(a, b) {
    if (a.vr !== b.vr) return a.vr ? -1 : 1;
    if (a.hd !== b.hd) return a.hd ? -1 : 1;

    return b.viewers - a.viewers;
}

/* ---------------------------------------------------------------- fetching -- */

/**
 * The whole online list, normalised, cached, shared by every visitor.
 *
 * `client_ip=request_ip` tells Chaturbate to use the address the request came
 * from, which is this server. That is deliberate and it is the reason one
 * cache entry can serve everybody: passing a visitor's address would make the
 * response specific to that visitor — and would send every visitor's IP to a
 * third party to get a list we then filter ourselves anyway. We take the
 * unfiltered list and apply {@link visibleTo} per request, which is strictly
 * more conservative than whatever upstream would have removed.
 */
async function onlineRooms(wm) {
    return cache.get('online', async () => {
        const url = new URL(UPSTREAM);
        url.searchParams.set('wm', wm);
        url.searchParams.set('client_ip', 'request_ip');
        url.searchParams.set('format', 'json');
        url.searchParams.set('limit', String(UPSTREAM_LIMIT));

        let res;
        try {
            res = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`upstream unreachable: ${err.message}`);
        }

        if (!res.ok) throw new Error(`upstream answered ${res.status}`);

        const payload = await res.json();
        const results = Array.isArray(payload?.results) ? payload.results : [];
        const rooms = results.map(normalise).filter(Boolean);

        lastGood = rooms;

        return rooms;
    });
}

/* ------------------------------------------------------------------ routes -- */

export function mountCams(app) {
    const router = express.Router();

    /**
     * The row.
     *
     * Public and unauthenticated, like the affiliate rows beside it. The spend
     * is zero — this calls a free partner endpoint — so the limiter is there
     * for the upstream's sake rather than ours, and it is generous enough that
     * a visitor flipping filters never meets it.
     *
     * `?vr=1` restricts to headset rooms, `?gender=f|m|s|c|t` to one gender.
     * Both filter the one cached list rather than asking upstream again.
     */
    router.get('/', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
        // Belt and braces with `robots.txt`, which already disallows `/api/`:
        // a disallow stops a crawl, a header is read by anything that got here
        // without consulting the file first.
        res.set('X-Robots-Tag', 'noindex, nofollow');

        // The age gate, enforced here and not only in the browser. The front
        // page draws its own interstitial, but a page that merely declines to
        // render what an open endpoint will hand out is not a gate — and a
        // thumbnail of a live adult broadcast is squarely the material the
        // twenty-seven statutes are about. Empty rather than 403: this is the
        // one row on the page the server can withhold, and it withholds it.
        const gate = visitorGate(req);

        if (!gate.ok) {
            res.set('Cache-Control', 'private, no-store');
            res.json({ configured: false, gated: true, owes: gate.owes, rooms: [], total: 0 });
            return;
        }

        const wm = process.env.AVR_CHATURBATE_WM;

        if (!wm) {
            // The normal state in development and on any deployment that has
            // not signed up. Not an error: the page is expected to render
            // without this row, so saying 503 would put a red line in the
            // console of a working site.
            res.set('Cache-Control', 'no-store');
            res.json({ configured: false, rooms: [], total: 0 });
            return;
        }

        let rooms;
        try {
            rooms = await onlineRooms(wm);
        } catch (err) {
            console.warn(`[cams] feed failed: ${err.message}`);

            if (!lastGood) {
                res.set('Cache-Control', 'no-store');
                res.status(502).json({ error: 'cam feed unavailable', code: 'upstream_failed' });
                return;
            }

            rooms = lastGood;
        }

        const where = resolveRegion(req);
        const wantsVr = req.query.vr === '1';
        const gender = typeof req.query.gender === 'string' ? req.query.gender.slice(0, 1) : '';

        const visible = rooms.filter(
            (room) =>
                visibleTo(room, where) &&
                (!wantsVr || room.vr) &&
                (!gender || room.gender === gender)
        );

        // `private` and not `public`: the list is filtered by the viewer's
        // region, so a shared cache in front of this would hand one
        // jurisdiction's list to another. Thirty seconds in the browser is
        // what stops a filter click costing a round trip.
        res.set('Cache-Control', 'private, max-age=30');

        res.json({
            configured: true,
            total: visible.length,
            vrTotal: visible.filter((room) => room.vr).length,
            rooms: visible
                .sort(rank)
                .slice(0, PAGE_MAX)
                .map(({ blockedStates, blockedCountries, ...room }) => room)
        });
    });

    app.use('/api/cams', router);
}

/** Test seam: drop the cached list so a case can control what the next read sees. */
export function _resetCamsCache() {
    cache.invalidate();
    lastGood = null;
}

/**
 * Test seam: age the cache out without forgetting the last good list.
 *
 * Which is the only way to reach the stale-serve path above, and that path is
 * worth reaching — it is the difference between an upstream blip costing the
 * row for a minute and costing it entirely.
 */
export function _expireCamsCache() {
    cache.invalidate();
}

export const _internals = { normalise, visibleTo, rank, embedSrc, chaturbateUrl, codeSet, VR_TAGS };
