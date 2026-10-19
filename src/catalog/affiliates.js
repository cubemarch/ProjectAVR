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
        href: href.href,
        image: image.href,
        partner: program.partner
    };
}

/**
 * Read one program's catalogue.
 *
 * @param {AffiliateProgram} program
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchAffiliateRow(program, opts = {}) {
    const doFetch = opts.fetchImpl ?? fetch;

    const res = await doFetch(program.api, {
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

    const payload = await res.json();
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
