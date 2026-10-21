/**
 * Affiliate programs: other operators' catalogues, shown on our own front page.
 *
 * Each entry is a paid referral deal. We show the partner's artwork, and a
 * click that ends in a sale pays us. Two consequences are structural rather
 * than per-program details, so they live here rather than in the UI.
 *
 * **The partner's drop-in widgets are deliberately not used.** AEBN ships
 * three — the movie row, Top Stars and the pitch slider — and all three are
 * the same artefact: a remote stylesheet, a remote script, and a div to paste
 * into the page. Four things rule them out here, and they apply to all three
 * because all three are built the same way.
 *
 *   - Their stylesheets are written for their site and fight ours, which
 *     defeats the entire point of putting the rows on this page.
 *   - Their scripts hang off `window.onload`, replacing rather than adding to
 *     any handler already there, and fire once — before this SPA has rendered
 *     anything for them to find.
 *   - Markup inserted through `innerHTML` never runs its `<script>` tags, and
 *     `innerHTML` is how every shelf on this page is built.
 *   - They open results with `window.open(url, '_blank')`, which hands the
 *     opened tab a live reference back to ours.
 *
 * What the widgets actually do is read a public JSON file and lay the results
 * out. So this file reads the same three files and the UI lays them out as our
 * own cards. The referral, theatre and sales-tool ids ride in the outbound URL
 * exactly where the widgets put them, so attribution is unchanged.
 *
 * **These rows are shown to every visitor, age gate or not** (David, 2026-10-18).
 * That is a deliberate exception rather than an oversight: `/api/catalog`
 * withholds our own library from the same visitor under `AVR_IDENTITY_ENFORCE`,
 * and boxcover artwork is the material the twenty-seven states in
 * `docs/STATE-AGE-LAWS.md` legislate about. Whoever revisits that decision
 * changes `refreshAffiliates` in `src/ui/browse.js`, not this file — nothing
 * here fetches on import, so the caller still decides when, or whether, a
 * partner is contacted at all.
 */

/**
 * @typedef {object} AffiliateProgram
 * @property {string} id       stable key; also prefixes every card id
 * @property {'vod'|'cams'|'stars'|'pitch'} kind  what the row is, and so how it draws
 * @property {string} title    the row heading
 * @property {string} partner  who receives the click, named on every card
 * @property {string} api      JSON endpoint
 * @property {string} [linkOrigin]  where this program's links are allowed to
 *   point, if that is not the API's own origin. AEBN serves these three feeds
 *   from a CloudFront bucket but sends the clicks to their theatre host, so
 *   the two are genuinely different and the bound has to be stated rather
 *   than inferred. Omitted means "same origin as the API", which is the
 *   stricter default and the right one for a new partner.
 * @property {string} [list]   the property holding the array, when the payload
 *   is an object wrapping one. AEBN's two chart feeds are bare arrays and the
 *   pitch feed is `{slides, intervalSeconds, …}`, so this cannot be assumed
 *   either way. Omitted means the payload must itself be an array.
 * @property {object} query    partner params copied onto every outbound URL
 * @property {string} adapter  which normaliser in `ADAPTERS` reads the payload
 * @property {boolean} [proxied]  this program is read through our own server
 *   rather than from the partner, so `api` is a same-origin path and `query`
 *   is empty because the attribution was already applied upstream of here.
 *   See the note on {@link AFFILIATE_PROGRAMS} below. It has to be declared
 *   rather than inferred from the shape, so that a browser-direct program
 *   cannot lose its tracking parameters and quietly look like a proxied one.
 */

/**
 * Why `refid` here and `refId` twice below.
 *
 * Not a typo either way. AEBN's movie API reads the lowercase spelling and
 * their two sales-tool feeds read the capitalised one; their own widgets emit
 * exactly this inconsistency. Normalising it would be tidier and would stop
 * paying us, so each program carries the spelling its own endpoint answers to
 * and nothing downstream touches the casing.
 */

/** @type {AffiliateProgram[]} */
export const AFFILIATE_PROGRAMS = [
    {
        id: 'aebn-pitch',
        kind: 'pitch',
        title: 'Featured',
        partner: 'AEBN',
        api: 'https://dd61z94w0iw42.cloudfront.net/aebnpitchslidesstraight.json',
        linkOrigin: 'https://theater.aebn.net',
        list: 'slides',
        query: { theaterId: '13992', refId: 'AEBN-119817' },
        adapter: 'aebnPitch'
    },
    {
        id: 'aebn-stars',
        kind: 'stars',
        title: 'Top Stars',
        partner: 'AEBN',
        api: 'https://dd61z94w0iw42.cloudfront.net/aebntopstarsstraight.json',
        linkOrigin: 'https://theater.aebn.net',
        query: { theaterId: '13992', refId: 'AEBN-119817' },
        adapter: 'aebnStars'
    },
    {
        id: 'aebn-newest',
        kind: 'vod',
        title: 'Newest On-Demand Movies',
        partner: 'AEBN',
        api: 'https://straight.aebn.com/straight/api/movies/newest',
        query: { salesToolId: '80', refid: 'AEBN-119817' },
        adapter: 'aebn'
    },

    /*
     * Bang, and the one structural difference in this list.
     *
     * The three above are read straight from the partner because there is
     * nothing in the request worth hiding — a referral id says who gets paid
     * and is in every outbound link on the page anyway. Bang authenticate with
     * an API key that *is* the account: it reads this catalogue, lists the
     * account's whitelabel sites and edits their callback URLs. A key in
     * front-end code is a key in view-source, so these two are read through
     * `server/routes/bang.js`, which holds `AVR_BANG_API_KEY` and never
     * discloses it.
     *
     * Everything else about them is an ordinary program. `api` is a path
     * rather than a URL because it is our own origin; `linkOrigin` is stated
     * for the same reason AEBN states it, and more strictly — it is the only
     * place a Bang card is allowed to point, and `toCard` enforces it below.
     * `query` is empty because the proxy has already applied the tracking
     * code, which is `AVR_BANG_AFF` and belongs in `.env` beside the key.
     *
     * ## Why these two rows are not called "Top Selling"
     *
     * Because the API has no such sort. `GET /content/search/params/videos`
     * reports its whole vocabulary as views, rating and release date — revenue
     * is not a dimension the affiliate tier can see. Views over all time is
     * the nearest honest substitute and is what "Most Watched" says.
     *
     * ## Why the second row is Trending and not Top Rated
     *
     * Measured against the live API on 2026-10-20, over the 24 titles each
     * sort returns:
     *
     * | | ∩ |
     * | --- | --- |
     * | `most-watched` ∩ `top-rated` | **19 of 24** |
     * | `most-watched` ∩ `trending` | 1 of 24 |
     * | `trending` ∩ `top-rated` | 1 of 24 |
     *
     * All-time views and all-time rating are very nearly the same ranking —
     * the scenes with the most views have had the most votes — so the two
     * shelves rendered as one shelf printed twice under different headings.
     * That is worse than having one row: it reads as a padded page.
     *
     * `views.monthly` is the axis that actually disagrees with the other two,
     * so it is the one that earns the second row. Top Rated is not lost; it is
     * a sort in the search box below, where it is combined with a term and
     * answers a different question than the shelf did.
     */
    {
        id: 'bang-most-watched',
        kind: 'vod',
        title: 'Most Watched',
        partner: 'Bang',
        api: '/api/bang/shelf/most-watched',
        linkOrigin: 'https://www.bang.com',
        list: 'items',
        query: {},
        proxied: true,
        adapter: 'bang'
    },
    {
        id: 'bang-trending',
        kind: 'vod',
        title: 'Trending This Month',
        partner: 'Bang',
        api: '/api/bang/shelf/trending',
        linkOrigin: 'https://www.bang.com',
        list: 'items',
        query: {},
        proxied: true,
        adapter: 'bang'
    }

    // Live cams go here when that program is signed: one more object of the
    // same shape, plus a normaliser in `ADAPTERS` for whatever their payload
    // looks like. Nothing else changes — the section groups by `kind` and
    // renders only the groups that have programs in them, so a `cams` entry
    // appearing here is the whole integration.
];

/**
 * The order groups appear in, and what each one is called on the page.
 *
 * Shelf kinds only. `pitch` is deliberately absent: it is a rotating banner
 * rather than a row of cards, so the UI pulls it out by kind and draws it
 * above all of this. A kind with no entry here renders nowhere by default,
 * which is the behaviour that makes that safe.
 */
export const AFFILIATE_GROUPS = [
    { kind: 'stars', label: 'Performers' },
    { kind: 'vod', label: 'On demand' },
    { kind: 'cams', label: 'Live cams' }
];

/**
 * The `rel` every outbound affiliate link carries.
 *
 * Policy rather than presentation, which is why it lives here and not in the
 * template that writes it. Each token is load-bearing:
 *
 *   - `sponsored` is what a paid link is required to declare. Leaving it off
 *     makes a page full of undisclosed paid links, which is both an FTC
 *     problem and a search-spam signal — and this domain is already carrying
 *     a Safe Browsing listing it is trying to appeal.
 *   - `nofollow` keeps our own ranking out of the arrangement.
 *   - `noopener` denies the opened tab a handle back to ours. This is the
 *     specific thing the partner's own widget gets wrong: `window.open(url,
 *     '_blank')` does not imply it the way `<a target="_blank">` now does.
 *   - `noreferrer` stops our URLs leaking to the partner. Safe only because
 *     AEBN attributes the sale from `refid` in the query string rather than
 *     from the referring page; if commissions ever stop tracking, suspect
 *     this token first.
 */
export const AFFILIATE_LINK_REL = 'sponsored nofollow noopener noreferrer';

/**
 * A partner's own storefront, as a destination rather than a feed.
 *
 * Everything above is a catalogue this page lays out itself. This is the other
 * half of the same deal: one attributed link to the partner's whole site, for
 * the visitor who wants more than the slice of it we chose to show.
 *
 * It is here, with the feeds, because the ids are the same ids. `refid` pays
 * us; `salesToolId` and `campaignId` are the partner's own reporting
 * dimensions, and keeping them in configuration next to the feeds is what
 * stops a second copy of `AEBN-119817` appearing in a template somewhere.
 *
 * ## Known: AEBN strips two of these three before the page loads
 *
 * As of 2026-10-19 every entry to `straight.aebn.com/straight/` answers
 * `302 → /avs/launch?refId=AEBN-119817` — their own age-verification wall —
 * and the redirect **keeps `refId` and drops `salesToolId` and `campaignId`**.
 * Verified from two regions, so it is not a state-specific gate.
 *
 * The practical effect is narrow but worth writing down rather than
 * rediscovering: commissions still track, because `refid` is what pays and it
 * survives. Campaign-level reporting in their dashboard does not, because the
 * dimensions that would populate it are gone by the time a page renders. That
 * is theirs to fix, not ours, and the params stay on the link so it starts
 * working the day they do.
 *
 * `base` and `query` are kept apart for the same reason the feeds do it: see
 * the `refid`/`refId` note above, which this inherits — their storefront reads
 * the lowercase spelling.
 *
 * @typedef {{id: string, partner: string, label: string, base: string,
 *            query: Record<string,string>}} AffiliateStorefront
 * @type {AffiliateStorefront[]}
 */
export const AFFILIATE_STOREFRONTS = [
    {
        id: 'aebn-theater',
        partner: 'AEBN',

        // Two strings because the masthead button shows one and says the
        // other. `label` is what is printed — short, because it is a primary
        // control at the top of the page and not a line of body copy, and a
        // long one wraps the row. `partner` is what the accessible name and the
        // tooltip carry, so the link is never anonymous: a screen reader
        // announces where it goes, and so does a hover. Printing "All movies
        // at AEBN" on the button instead would be clearer and uglier, and
        // the disclosure beside it already says the link is paid.
        label: 'All Movies',
        base: 'https://straight.aebn.com/straight/',
        query: { refid: 'AEBN-119817', salesToolId: '4', campaignId: '33970' }
    }
];

/**
 * One storefront's outbound URL, with its attribution applied.
 *
 * Built rather than stored whole so that the ids above remain the single
 * place any of them is written, and so a mistyped base cannot silently
 * produce a link that still looks plausible — `new URL` throws on one.
 *
 * @param {AffiliateStorefront} storefront
 * @returns {string}
 */
export function storefrontUrl(storefront) {
    const url = new URL(storefront.base);
    for (const [key, value] of Object.entries(storefront.query)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

const ADAPTERS = {
    /**
     * AEBN's movie queue.
     *
     * Uses the `vodUrl` the API already returns rather than rebuilding the
     * path from `movieId` and the title, which is what their widget does.
     * Their slug is built with a non-global regex, so it replaces only the
     * first character that is not alphanumeric; the slug is decorative on
     * their side so the bug is invisible there, but there is no reason to
     * reproduce it.
     */
    aebn: (rows, program) =>
        rows.map((m) => ({
            id: `${program.id}:${m.movieId}`,
            title: String(m.movieTitle ?? '').trim() || 'Untitled',
            image: m.imageUrl,
            durationMs: Number(m.durationMs) || 0,
            path: m.vodUrl
        })),

    /**
     * AEBN's top-performer chart.
     *
     * `rankId` is the chart position and the feed arrives in it, so the order
     * is theirs and is not re-sorted here. `starId` is carried through as its
     * own field because it is the key the biography route validates against —
     * see `server/routes/stars.js`. It is a number in the payload and is kept
     * one here; the only place it becomes a string is a URL.
     *
     * Of the five image sizes offered, `headMedium` (135px) is the one that
     * suits a face in a circle. `bodyLarge` is a 533px full-length shot, which
     * is both the wrong crop for this row and a much heavier image for
     * something that renders ten times above the fold.
     */
    aebnStars: (rows, program) =>
        rows.map((s) => ({
            id: `${program.id}:${s.starId}`,
            starId: Number(s.starId) || 0,
            title: String(s.starName ?? '').trim() || 'Unknown',
            image: s.images?.headMedium || s.images?.headSmall,
            path: s.contentUrl
        })),

    /**
     * AEBN's promoted slides: a wide banner image and a line of copy.
     *
     * `altText` is the partner's own sell line ("Check out rising star…"), so
     * it is shown as a caption rather than used as alt text. Using it for both
     * would make a screen reader read the marketing twice, and the image is
     * decorative next to a caption that says the same thing.
     */
    /**
     * Bang scenes, by way of our own proxy.
     *
     * Nearly a passthrough, because `server/routes/bang.js` has already done
     * the work this layer does for the other partners: the href is built there
     * from a fixed origin and already carries `aff`, and every image URL has
     * already been pinned to their artwork host. That is not a reason to skip
     * `toCard` — a proxy is a trusted component right up until it is a
     * compromised one, and the origin check below costs nothing.
     *
     * `sceneId` is carried separately from the prefixed card `id` because it
     * is the key `/api/bang/scene/:ref` validates against, the same way
     * `starId` is for the biography route. It is their numeric `identifier`
     * and not the id in the link — the two are different keys and only this
     * one can be looked up; see the note in `server/routes/bang.js`.
     */
    bang: (rows, program) =>
        rows.map((v) => ({
            id: `${program.id}:${v.id}`,
            sceneId: Number(v.ref) || 0,
            title: v.title,
            image: v.image,
            durationMs: Number(v.durationMs) || 0,
            path: v.href
        })),

    aebnPitch: (rows, program) =>
        [...rows]
            .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
            .map((p) => ({
                id: `${program.id}:${p.pitchItemId}`,
                title: String(p.altText ?? '').trim(),
                image: p.imageUrl,
                path: p.contentUrl
            }))
};

/**
 * Turn one partner row into a link we are willing to put on our own page.
 *
 * Both the path and the image URL arrive from a third party, so neither is
 * trusted to stay inside that partner's own site. A payload that set `vodUrl`
 * to `https://somewhere.else/` would otherwise place a link to somewhere else
 * entirely under our heading and in our styling — which is the exact shape of
 * the thing this domain is currently listed by Safe Browsing for. Anything
 * that fails these checks is dropped rather than repaired: a partner sending
 * off-origin paths is a problem to notice, not to paper over.
 *
 * @returns {object|null} a card, or null if the row cannot be trusted
 */
function toCard(row, program) {
    const linkOrigin = program.linkOrigin ?? new URL(program.api).origin;

    let href;
    let image;
    try {
        href = new URL(row.path, linkOrigin);
        image = new URL(row.image, linkOrigin);
    } catch {
        return null;
    }

    if (href.origin !== linkOrigin) return null;
    if (image.protocol !== 'https:') return null;

    for (const [key, value] of Object.entries(program.query)) {
        href.searchParams.set(key, value);
    }

    return {
        id: row.id,
        title: row.title,
        durationMs: row.durationMs,
        starId: row.starId,
        sceneId: row.sceneId,
        href: href.href,
        image: image.href,
        partner: program.partner
    };
}

/**
 * One request to a partner, with the terms every request here is made on.
 *
 * Shared by the shelves and by the search so that those terms are written
 * once. They are not defaults and not style: a second call site that fetched
 * a partner feed on its own would be one that quietly dropped them.
 *
 * @param {AffiliateProgram} program
 * @param {string} api the URL to read, which may carry a query string
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 */
async function readProgram(program, api, opts = {}) {
    const doFetch = opts.fetchImpl ?? fetch;

    const res = await doFetch(api, {
        // Cross-origin by definition. Their endpoint answers with
        // `Access-Control-Allow-Credentials: true` and reflects back whatever
        // Origin it is given, so saying this explicitly is what keeps a LustXR
        // cookie from ever being offered to a partner — the default is already
        // `omit`, but the default is not the reason it has to stay that way.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: opts.signal ?? AbortSignal.timeout(8000)
    });

    if (!res.ok) throw new Error(`${program.partner} answered ${res.status}`);

    return res.json();
}

/**
 * Read one program's catalogue.
 *
 * @param {AffiliateProgram} program
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchAffiliateRow(program, opts = {}) {
    const payload = await readProgram(program, program.api, opts);
    const rows = program.list ? payload?.[program.list] : payload;

    if (!Array.isArray(rows)) {
        const where = program.list ? `${program.partner}.${program.list}` : program.partner;
        throw new Error(`${where} sent ${typeof rows}, expected a list`);
    }

    const adapter = ADAPTERS[program.adapter];
    if (!adapter) throw new Error(`no adapter named ${program.adapter}`);

    return adapter(rows, program)
        .map((row) => toCard(row, program))
        .filter(Boolean);
}

/**
 * Read every program, in parallel.
 *
 * One partner being down must not blank the section, so failures are isolated
 * and a program that returns nothing is dropped entirely rather than left as a
 * heading with no row under it.
 *
 * @param {AffiliateProgram[]} [programs]
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{program: AffiliateProgram, items: object[]}[]>}
 */
export async function fetchAffiliates(programs = AFFILIATE_PROGRAMS, opts = {}) {
    const settled = await Promise.allSettled(
        programs.map((program) => fetchAffiliateRow(program, opts))
    );

    return programs
        .map((program, i) => ({
            program,
            items: settled[i].status === 'fulfilled' ? settled[i].value : []
        }))
        .filter((row) => row.items.length > 0);
}

/* --------------------------------------------------- searching a partner -- */

/**
 * The one partner catalogue this site can search on its own pages.
 *
 * A program object of the same shape as the shelves above, deliberately: the
 * results run through the same adapter and the same {@link toCard}, so a
 * searched card is checked against `linkOrigin` exactly as a shelved one is.
 * A search that built its own cards would be a second place for a hostile
 * payload to put a link to somewhere else under our styling.
 *
 * `id` is what `_bindOutbound` reports and is distinct from either shelf, so
 * the question "do people search, and does searching convert" has an answer.
 *
 * Searching is only offered for a partner whose feed we proxy — the key is
 * ours, the rate limit is ours, and a query typed here reaches them from our
 * server rather than from the visitor's browser.
 */
export const SCENE_SEARCH = Object.freeze({
    program: Object.freeze({
        id: 'bang-search',
        kind: 'vod',
        title: 'Search results',
        partner: 'Bang',
        api: '/api/bang/search',
        linkOrigin: 'https://www.bang.com',
        list: 'items',
        query: {},
        proxied: true,
        adapter: 'bang'
    }),

    /**
     * The sorts the partner actually has, in the order they are offered.
     *
     * Not a free-text parameter: `server/routes/bang.js` keeps a whitelist and
     * falls back to the first of these, because an unknown `by` makes their
     * search answer **HTTP 200 with an Elasticsearch error body** naming the
     * index. These ids are that whitelist's keys.
     *
     * There is no "top selling" here because there is no such sort — revenue
     * is not a dimension the affiliate tier can see. See the note above the
     * two Bang shelves.
     */
    sorts: Object.freeze([
        Object.freeze({ id: 'most-watched', label: 'Most watched' }),
        Object.freeze({ id: 'trending', label: 'Trending' }),
        Object.freeze({ id: 'top-rated', label: 'Top rated' }),
        Object.freeze({ id: 'newest', label: 'Newest' })
    ])
});

/**
 * Search that partner's catalogue, as cards.
 *
 * `total` is reported rather than inferred from the page: it is what tells a
 * visitor whether narrowing the term is worth doing, and `pages` is clamped
 * server-side so a "more" control cannot be drawn past where the partner will
 * answer.
 *
 * @param {{term?: string, sort?: string, page?: number}} [query]
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{items: object[], total: number, page: number, pages: number}>}
 */
export async function searchScenes(query = {}, opts = {}) {
    const { program } = SCENE_SEARCH;
    const params = new URLSearchParams();

    if (query.term) params.set('q', query.term);
    if (query.sort) params.set('sort', query.sort);
    if (query.page > 1) params.set('page', String(query.page));

    const search = params.toString();
    const payload = await readProgram(program, search ? `${program.api}?${search}` : program.api, opts);

    if (!Array.isArray(payload?.items)) {
        throw new Error(`${program.partner}.items sent ${typeof payload?.items}, expected a list`);
    }

    return {
        items: ADAPTERS[program.adapter](payload.items, program)
            .map((row) => toCard(row, program))
            .filter(Boolean),

        total: Number(payload.total) || 0,
        page: Number(payload.page) || 1,
        pages: Number(payload.pages) || 1
    };
}
