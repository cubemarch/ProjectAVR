import express from 'express';

import { rateLimit } from '../auth/middleware.js';
import { TtlCache } from '../cache.js';
import { resolveRegion } from '../identity/jurisdiction.js';
import { visitorGate } from '../identity/visitor-gate.js';
import { censor, isConfigured as censorConfigured, PLACEHOLDER } from '../media/censor.js';

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
 * The intention was that the selection would not be duplicated either: this
 * site is about VR, the ordering here is VR-first, and the row was presented
 * as a VR cam shelf rather than as a mirror of somebody's front page.
 *
 * **That differentiation does not currently exist**, and the measurement is
 * in the note on {@link VR_TAGS}: the partner has no VR rooms, no VR tag and
 * no VR field, so a VR-first sort over this feed is a sort with nothing to
 * put first. What ships is the feed in the partner's own order, searchable.
 * The search is real and is ours — it runs over every room online rather than
 * over one page of them — but it is a feature, not a selection, and it is
 * thinner ground than the above claimed. Closing this properly needs either a
 * cam partner that actually carries headset rooms or a row that stops
 * implying one; it is the same open question as the catalogue-relevance
 * mismatch in `docs/SEARCH.md` §2.
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

/** Longest `?q=` we will look at, and the most words we will take from it. */
const QUERY_MAX = 64;
const QUERY_TERMS = 6;

/**
 * How much of the tag vocabulary the suggestion list is given.
 *
 * Measured against the live feed: five hundred rooms carry 2,172 tag
 * instances over 235 distinct tags, and a hundred of those distinct tags
 * belong to exactly one room. The whole vocabulary would be 3.2 KB.
 *
 * The floor is the interesting one. A tag held by a single room is a
 * suggestion the row can barely honour, and this list turns over every forty
 * five seconds, so by the time it is clicked that one room is often gone.
 * Requiring two leaves 135 tags covering 95% of instances for about 2 KB, and
 * the ceiling is only there so an upstream that starts emitting tags per room
 * cannot quietly turn this field into the largest thing in the response.
 */
const TAG_MIN_ROOMS = 2;
const TAG_MAX = 150;

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
 * dozen usernames, and the nearest real tag — `3dxchat`, ten rooms, a flat
 * game played on a monitor — is exactly the kind of thing a substring match
 * would promote to a headset stream. So it is enumerated.
 *
 * **Nothing in this list currently matches anything.** On 2026-10-19 every
 * room online was swept through `offset` — 5,990 of them, carrying 801
 * distinct tags — and not one carried any of these nineteen. The partner's own
 * tag index agrees: `?tag=` returns a count of zero for all nineteen, against
 * 600 for a control like `teen`. The room object has no VR field to read
 * instead; `is_hd` is the closest thing it exposes.
 *
 * The list stays, and `rank` still sorts on it, because it costs one `Set`
 * lookup per room and it is what makes the day a broadcaster does tag a
 * headset stream a no-op here rather than a change. What it does not do is
 * justify a control: the shelf draws no VR filter, because a filter whose
 * answer is always "none" promises a feed that does not exist.
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

/**
 * A room as this visitor is allowed to receive it.
 *
 * Uncovered, this is the identity function and the row is what it has always
 * been. Covered, two fields change and both have to:
 *
 *   - **`thumb`** points at our proxy instead of the partner's CDN, so the
 *     browser never holds a URL for the original. Nothing else about the card
 *     changes — `_swapFrame` in `src/ui/cams.js` reads whatever is in `src`,
 *     appends its frame counter and swaps on decode, so a proxy that is
 *     slower than a CDN simply means the card holds its previous frame a
 *     moment longer. The client needs no change at all.
 *   - **`embed` is removed.** This is the one that would quietly undo
 *     everything else. `embed` is the white label player: a real, live,
 *     entirely uncovered broadcast playing inside our page. Pixelating the
 *     thumbnail of a card that opens an uncensored stream on click is not a
 *     gate, it is a decoration.
 *
 * `href` stays. It leaves for the partner's own site, which runs its own age
 * check and is where the revshare is earned — withholding it would cost the
 * row its only purpose without protecting anything we control.
 */
function present(room, covered) {
    if (!covered) return room;

    const { embed, ...rest } = room;

    return { ...rest, embed: null, thumb: `/api/cams/thumb/${encodeURIComponent(room.username)}` };
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

    // Upstream calls this `current_show`. It was `room_status` when this was
    // written, and the rename is the reason the shelf was empty in production
    // for a working affiliate code: the old name reads as `undefined`, which
    // is not `'public'`, so every one of the five hundred rooms was refused
    // and the row drew nothing. Nothing failed — not the fetch, not a test,
    // because the fixture had been written from the same documentation as the
    // code and carried the same stale name.
    //
    // Both are accepted, and the absence of both still refuses. A field we
    // cannot read is not evidence that a show is public, and the one thing
    // this check exists to prevent is putting a private or away room on the
    // page; `??` rather than `||` so that a legitimately empty string is
    // treated as an answer rather than falling through to the other name.
    const show = room.current_show ?? room.room_status;
    if (show !== 'public') return null;

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

    const name = String(room.display_name || room.username).trim().slice(0, 64);
    const subject = String(room.room_subject || '').trim().slice(0, 160);

    const languages = Array.isArray(room.spoken_languages)
        ? room.spoken_languages.filter((l) => typeof l === 'string').slice(0, 4)
        : [];

    return {
        username,
        name,
        subject,
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
        languages,

        // Everything `?q=` is allowed to match, flattened once here rather than
        // rebuilt per request: this runs five hundred times per cache fill and
        // a search runs five hundred times per keystroke, which is the wrong
        // way round to be joining strings.
        //
        // Name, handle, the subject line the broadcaster wrote, their tags and
        // the languages they speak — which is to say what is printed on the
        // card, plus what a visitor would reasonably expect to be searchable.
        // Not `href`, which would make a query for "chaturbate" match all five
        // hundred, and not the thumbnail URL, which carries a room's name in a
        // path segment and would match substrings that are not words.
        search: [name, username, subject].concat(tags, languages).join(' ').toLowerCase(),

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

/**
 * A `?q=` string, reduced to the terms a room has to carry all of.
 *
 * Caps on both length and count, because this is reached once per keystroke
 * and the work is linear in terms × rooms: six terms against five hundred
 * rooms is three thousand substring scans, which is nothing, and an uncapped
 * query pasted from a paragraph is not. Both caps truncate rather than reject
 * — a visitor who pastes something absurd gets the first few words searched,
 * which is a better answer than an error for an input they will retype.
 *
 * Plain {@link String.includes} downstream, never a constructed `RegExp`: a
 * query is visitor input and compiling it would hand a stranger the regex
 * engine, which is the whole of the ReDoS class for the sake of a wildcard
 * nobody asked for.
 */
function searchTerms(raw) {
    if (typeof raw !== 'string') return [];

    return raw
        .slice(0, QUERY_MAX)
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, QUERY_TERMS);
}

/**
 * Whether a room carries every term.
 *
 * AND, not OR, and substring, not word: "blonde girl" means both, and "span"
 * finds "spanish". Narrowing as you type is the behaviour a search box in a
 * row of sixty is judged by, and OR would widen on the second word.
 */
function matchesQuery(room, terms) {
    for (const term of terms) if (!room.search.includes(term)) return false;

    return true;
}

/**
 * Which tags are on offer, and roughly how many rooms each would return.
 *
 * Counted over the rooms a query is about to be run against rather than over
 * everything online, so the number beside a suggestion is scoped to what the
 * caller actually asked for. Under `?vr=1` a tag whose rooms are all flat does
 * not appear at all — which is the point: a suggestion that cannot be honoured
 * is worse than no suggestion, because the visitor reads the empty row as the
 * search being broken rather than as the tag being wrong.
 *
 * It is a floor and not an equality, and the gap is one-directional. This
 * counts rooms *tagged* `blonde`; picking the suggestion runs `?q=blonde`,
 * which also matches the word in a display name or a room subject. Measured
 * against the live feed: the suggestion reads 27 and the row comes back with
 * 30. Picking a tag can only ever return at least what the number promised,
 * never fewer, which is the direction that does not disappoint anybody — and
 * closing the gap would mean either a count that lies about the query or a
 * query that ignores two thirds of the card.
 *
 * Ties break alphabetically rather than by insertion order, so the list does
 * not reshuffle between two requests that saw the same rooms in a different
 * order from upstream.
 */
function tagFacet(rooms) {
    const counts = new Map();

    for (const room of rooms) {
        for (const tag of room.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }

    return [...counts]
        .filter(([, n]) => n >= TAG_MIN_ROOMS)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TAG_MAX)
        .map(([tag, count]) => ({ tag, count }));
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
     * is zero — this calls a free partner endpoint, and every filter below cuts
     * the one cached list rather than asking upstream again — so the limiter is
     * here for our own sake, against a client that has stopped debouncing.
     *
     * A hundred and twenty a minute is two a second sustained. The shelf waits
     * for a pause in typing before it asks, so a visitor typing a word costs
     * one or two; the budget is sized for the case where that debounce breaks
     * and every keystroke arrives, which at human typing speed is around the
     * limit. Nobody reaches it by searching. Something looping does.
     *
     * `?vr=1` restricts to headset rooms, `?gender=f|m|s|c|t` to one gender,
     * and `?q=` to rooms carrying every word of it — see {@link searchTerms}.
     *
     * The counts are deliberately not symmetrical with that. `total` and
     * `vrTotal` describe what this visitor could be shown, before any of the
     * three filters; `matched` describes what the filters left. Both numbers
     * are answers about the feed rather than about a request, which is what a
     * caller deciding whether a control is worth offering at all needs — a
     * figure that moved with the search box would make any such control
     * disable itself as you typed past it, and a visitor cannot get back to a
     * control that does that. `vrTotal` is zero against the live feed today;
     * see {@link VR_TAGS} and the note on it, and the shelf draws no VR
     * control as a result.
     *
     * `tags` is the vocabulary behind the suggestion list, which exists
     * because the browser holds sixty rooms and the query runs against five
     * hundred: the shelf cannot offer what it cannot see, so it is told.
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
        // twenty-seven statutes are about.
        //
        // ## Two answers, because the statutes ask two different things
        //
        // `visitor-gate.js` sets out why this file does not apply one rule
        // everywhere, and the same reasoning decides what an ungated visitor
        // gets here:
        //
        //   - **The twenty-seven.** Withheld, exactly as before. Those
        //     statutes judge material as a whole and by its appeal, not pixel
        //     by pixel; a live broadcast with the explicit parts covered is
        //     still a live broadcast, and nothing in the table says a mosaic
        //     satisfies it. So this row stays empty until the visitor has
        //     actually verified.
        //   - **Everywhere else.** Covered and shown. No statute requires
        //     anything here, the visitor owes a click rather than a document,
        //     and a blank row gives them no reason to make it. They see a real
        //     shelf of real rooms with the explicit regions pixelated, which
        //     is both what they are owed and the only version of this row that
        //     has ever persuaded anyone to pass the gate.
        //
        // See `server/media/censor.js` and `docs/CENSOR.md`.
        const gate = visitorGate(req);
        const covered = !gate.ok;

        // Fail-closed, and the most important branch in this file. If the
        // inference service is unset or unreachable there is no covered
        // version to serve, so the answer reverts to the old one — withheld.
        // Getting this backwards would show every unverified visitor the
        // uncensored row the moment the censor went down, which is the exact
        // failure the whole design is arranged to make impossible.
        if (covered && (gate.owes === 'verification' || !censorConfigured())) {
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
        const terms = searchTerms(req.query.q);

        // Geography only. This is the denominator `total` and `vrTotal` are
        // reported from, so it has to mean "everything this visitor is allowed
        // to see" and not "everything they are currently asking for".
        const here = rooms.filter((room) => visibleTo(room, where));

        // The parameters applied but not the box. Suggestions are counted over
        // this and the query is run against it, which is what keeps a
        // suggested tag's count a floor on the cards it produces — see
        // `tagFacet` — without the suggestions reshuffling on every keystroke.
        const pool = here.filter(
            (room) => (!wantsVr || room.vr) && (!gender || room.gender === gender)
        );

        const matched = terms.length ? pool.filter((room) => matchesQuery(room, terms)) : pool;

        // `private` and not `public`: the list is filtered by the viewer's
        // region, so a shared cache in front of this would hand one
        // jurisdiction's list to another. Thirty seconds in the browser is
        // what stops a filter click costing a round trip — and it is why
        // backspacing through a word is nearly free, since each shorter query
        // is one the browser asked a moment ago and still holds.
        // `no-store` while covered, rather than the usual thirty seconds: the
        // moment a visitor passes the gate the row has to become the real one,
        // and a cached covered copy would leave them looking at mosaics for
        // half a minute after doing what was asked of them.
        res.set('Cache-Control', covered ? 'private, no-store' : 'private, max-age=30');

        res.json({
            configured: true,
            total: here.length,
            vrTotal: here.filter((room) => room.vr).length,

            // How many the filters left, which is not `rooms.length` when more
            // than sixty match. The shelf says "Top 60 of 214" off this, so a
            // visitor is told their query was narrowed by the page rather than
            // being left to assume the partner has exactly sixty of anything.
            matched: matched.length,

            tags: tagFacet(pool),

            covered,

            rooms: matched
                .sort(rank)
                .slice(0, PAGE_MAX)
                .map(({ blockedStates, blockedCountries, search, ...room }) => present(room, covered))
        });
    });

    /**
     * One room's thumbnail, with anything explicit covered.
     *
     * ## It takes a username, not a URL
     *
     * The obvious shape for this route is `?url=` and it would be a server
     * side request forgery hole. `imageUrl` above pins the scheme and
     * deliberately not the host — their thumbnails move between CDN names —
     * so there is no allowlist here to lean on, and a proxy that fetches
     * whatever it is handed is one that will happily read a metadata endpoint
     * on the instance's behalf.
     *
     * Taking the room name instead means the only URLs this can ever fetch
     * are ones that arrived in the partner's own feed. The parameter is an
     * index into data we already have rather than an instruction.
     *
     * ## It is not gated, and does not need to be
     *
     * Everything this route can emit is already covered, so there is nothing
     * here for the gate to protect. Gating it would also mean a visitor who
     * has *passed* the gate gets the uncovered URL — which is exactly what
     * happens, from the feed, in the JSON above.
     */
    router.get('/thumb/:username', rateLimit({ windowMs: 60_000, max: 600 }), async (req, res) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');

        const room = (lastGood ?? []).find((r) => r.username === req.params.username);
        const covered = room ? await censor(room.thumb).catch(() => null) : null;

        if (!covered) {
            // Unknown room, dead service, timeout, unreadable image — one
            // answer for all of them, and it is never the original. Short
            // cache so a blip does not pin the placeholder onto a card.
            res.set('Content-Type', 'image/svg+xml');
            res.set('Cache-Control', 'public, max-age=5');
            res.send(PLACEHOLDER);
            return;
        }

        // Public: the covered image is identical for every viewer, which is
        // the whole reason this is affordable. The `?f=` the client appends
        // is what keeps it fresh.
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=6');
        res.send(covered);
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

export const _internals = {
    normalise,
    visibleTo,
    rank,
    embedSrc,
    chaturbateUrl,
    codeSet,
    present,
    VR_TAGS
};
