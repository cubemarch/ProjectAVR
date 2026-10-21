import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    AFFILIATE_GROUPS,
    AFFILIATE_LINK_REL,
    AFFILIATE_PROGRAMS,
    AFFILIATE_STOREFRONTS,
    fetchAffiliateRow,
    fetchAffiliates,
    storefrontUrl
} from '../src/catalog/affiliates.js';

/**
 * The affiliate registry.
 *
 * Everything here injects `fetchImpl`, so no test reaches a partner's server:
 * the point of these is what we do with a payload, and a suite that depends on
 * somebody else's API being up fails for reasons that are not about this code.
 *
 * A shared abort signal is passed for the same reason the module defaults to
 * `AbortSignal.timeout` — without one, every call would leave an eight-second
 * timer behind and the runner would sit waiting on them.
 */

const PROGRAM = {
    id: 'test-vod',
    kind: 'vod',
    title: 'Newest',
    partner: 'Partner',
    api: 'https://partner.example/straight/api/movies/newest',
    query: { salesToolId: '80', refid: 'AEBN-119817' },
    adapter: 'aebn'
};

const MOVIE = {
    movieId: 329815,
    movieTitle: 'A Title',
    imageUrl: 'https://pics.example/a329815.jpg',
    durationMs: 2054792,
    vodUrl: '/straight/movies/329815/a-title'
};

const signal = new AbortController().signal;

/** A `fetch` that answers once with `body`, and records how it was called. */
function stubFetch(body, { ok = true, status = 200 } = {}) {
    const calls = [];
    const impl = async (url, opts) => {
        calls.push({ url, opts });
        return { ok, status, json: async () => body };
    };
    impl.calls = calls;
    return impl;
}

test('a partner row becomes a card with the referral ids on the link', async () => {
    const fetchImpl = stubFetch([MOVIE]);
    const [card] = await fetchAffiliateRow(PROGRAM, { fetchImpl, signal });

    assert.equal(card.id, 'test-vod:329815');
    assert.equal(card.title, 'A Title');
    assert.equal(card.partner, 'Partner');
    assert.equal(card.durationMs, 2054792);
    assert.equal(card.image, 'https://pics.example/a329815.jpg');

    const href = new URL(card.href);
    assert.equal(href.origin, 'https://partner.example', 'link stays on the partner');
    assert.equal(href.pathname, '/straight/movies/329815/a-title');
    assert.equal(href.searchParams.get('refid'), 'AEBN-119817', 'the commission rides here');
    assert.equal(href.searchParams.get('salesToolId'), '80');
});

test('no credentials and no referrer are offered to a partner', async () => {
    const fetchImpl = stubFetch([MOVIE]);
    await fetchAffiliateRow(PROGRAM, { fetchImpl, signal });

    const { opts } = fetchImpl.calls[0];
    assert.equal(opts.credentials, 'omit', 'a LustXR cookie must never reach a partner');
    assert.equal(opts.referrerPolicy, 'no-referrer');
});

test('a row pointing off the partner origin is dropped, not rendered', async () => {
    // The shape that matters: a compromised or hostile payload putting a link
    // to somewhere else entirely under our heading and in our styling.
    const fetchImpl = stubFetch([
        { ...MOVIE, movieId: 1, vodUrl: 'https://evil.example/phish' },
        { ...MOVIE, movieId: 2, vodUrl: '//evil.example/phish' },
        { ...MOVIE, movieId: 3 }
    ]);

    const cards = await fetchAffiliateRow(PROGRAM, { fetchImpl, signal });

    assert.equal(cards.length, 1, 'only the same-origin row survives');
    assert.equal(cards[0].id, 'test-vod:3');
});

test('an image that is not https is dropped', async () => {
    const fetchImpl = stubFetch([
        { ...MOVIE, movieId: 1, imageUrl: 'http://pics.example/a.jpg' },
        { ...MOVIE, movieId: 2, imageUrl: 'javascript:alert(1)' },
        { ...MOVIE, movieId: 3 }
    ]);

    const cards = await fetchAffiliateRow(PROGRAM, { fetchImpl, signal });

    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'test-vod:3');
});

test('a payload that is not a list is an error, not an empty row', async () => {
    const fetchImpl = stubFetch({ error: 'nope' });
    await assert.rejects(() => fetchAffiliateRow(PROGRAM, { fetchImpl, signal }), /expected a list/);
});

test('an HTTP error names the partner', async () => {
    const fetchImpl = stubFetch([], { ok: false, status: 503 });
    await assert.rejects(() => fetchAffiliateRow(PROGRAM, { fetchImpl, signal }), /Partner answered 503/);
});

test('one partner failing does not blank the section', async () => {
    const good = { ...PROGRAM, id: 'good' };
    const bad = { ...PROGRAM, id: 'bad', api: 'https://down.example/api' };

    const fetchImpl = async (url, opts) => {
        if (url.startsWith('https://down.example')) throw new Error('connection refused');
        return { ok: true, status: 200, json: async () => [MOVIE] };
    };

    const rows = await fetchAffiliates([bad, good], { fetchImpl, signal });

    assert.equal(rows.length, 1, 'the dead partner is dropped entirely');
    assert.equal(rows[0].program.id, 'good');
    assert.equal(rows[0].items.length, 1);
});

test('a partner with nothing to show leaves no empty heading behind', async () => {
    const fetchImpl = stubFetch([]);
    const rows = await fetchAffiliates([PROGRAM], { fetchImpl, signal });
    assert.deepEqual(rows, []);
});

test('every outbound link is disclosed as paid and cannot reach back', () => {
    const tokens = AFFILIATE_LINK_REL.split(/\s+/);

    // `sponsored` is the FTC and search-engine disclosure, `noopener` is what
    // the partner's own widget omits. Losing either silently is the point of
    // asserting on them rather than trusting the string to stay put.
    assert.ok(tokens.includes('sponsored'), 'a paid link says so');
    assert.ok(tokens.includes('nofollow'));
    assert.ok(tokens.includes('noopener'), 'the opened tab gets no handle back');
    assert.ok(tokens.includes('noreferrer'));
});

/**
 * `pitch` is the one kind with no group, because it is a banner rather than a
 * row and `_renderPitch` draws it directly. Named here rather than skipped so
 * that a *new* kind arriving without a group still fails: the point of this
 * assertion is catching a program that renders nowhere, and the exception has
 * to be as explicit as the rule for that to keep working.
 */
const UNGROUPED_KINDS = new Set(['pitch']);

test('every registered program is renderable and declares a known group', async () => {
    const kinds = new Set(AFFILIATE_GROUPS.map((g) => g.kind));

    assert.ok(AFFILIATE_PROGRAMS.length > 0, 'at least one program is configured');

    for (const program of AFFILIATE_PROGRAMS) {
        assert.ok(
            kinds.has(program.kind) || UNGROUPED_KINDS.has(program.kind),
            `${program.id} has somewhere to render`
        );
        // A proxied program is read from our own origin, so it inherits the
        // page's scheme and there is no absolute URL to check. Asserted as a
        // same-origin absolute path rather than waved through: a relative
        // `api` that forgot its leading slash would resolve against whatever
        // route the SPA happened to be on.
        if (program.proxied) {
            assert.match(
                program.api,
                /^\/api\//,
                `${program.id} is proxied, so it reads from our own /api/`
            );
        } else {
            assert.equal(
                new URL(program.api).protocol,
                'https:',
                `${program.id} is read over https`
            );
        }

        assert.ok(program.partner, `${program.id} names who the click leaves for`);

        // Without the tracking params the links still work and the commission
        // is lost silently, which is the failure nobody notices for a month.
        // Kept partner-agnostic deliberately: a live-cams deal will carry
        // different parameter names, and this should not need editing for it.
        //
        // A proxied program is exempt because its attribution was applied
        // server-side, before the payload reached this file — see the note on
        // the Bang entries in `affiliates.js`. The exemption is keyed on the
        // explicit `proxied` flag and not on `query` being empty, so a
        // browser-direct program that lost its parameters still fails here
        // rather than passing as a proxied one.
        if (!program.proxied) {
            assert.ok(
                Object.keys(program.query ?? {}).length > 0,
                `${program.id} carries something that attributes the sale`
            );
        }

        // And the bound that replaces it: a proxy decides the href, so the
        // only thing stopping our own server from putting an arbitrary link
        // under our heading is `linkOrigin`, which `toCard` enforces.
        if (program.proxied) {
            assert.equal(
                new URL(program.linkOrigin).protocol,
                'https:',
                `${program.id} bounds its links to an https origin`
            );
        }
    }
});

/* ---------------------------------------------- stars and the pitch feed -- */

const STARS_PROGRAM = {
    id: 'test-stars',
    kind: 'stars',
    title: 'Top Stars',
    partner: 'Partner',
    api: 'https://cdn.example/aebntopstarsstraight.json',
    linkOrigin: 'https://theater.example',
    query: { theaterId: '13992', refId: 'AEBN-119817' },
    adapter: 'aebnStars'
};

const STAR = {
    rankId: 1,
    starId: 107821,
    starName: 'A Performer',
    contentUrl: '/dispatcher/starDetail?starId=107821&genreId=101',
    images: {
        headSmall: 'https://pics.example/s107821_s.jpg',
        headMedium: 'https://pics.example/s107821_m.jpg',
        bodyLarge: 'https://pics.example/s107821_l.jpg'
    }
};

const PITCH_PROGRAM = {
    id: 'test-pitch',
    kind: 'pitch',
    title: 'Featured',
    partner: 'Partner',
    api: 'https://cdn.example/aebnpitchslidesstraight.json',
    linkOrigin: 'https://theater.example',
    list: 'slides',
    query: { theaterId: '13992', refId: 'AEBN-119817' },
    adapter: 'aebnPitch'
};

const SLIDE = {
    pitchItemId: 5189,
    sortOrder: 2,
    imageUrl: 'https://pics.example/promo-1366x400.jpg',
    altText: 'Check out rising star X!',
    contentUrl: '/dispatcher/starDetail?starId=149521&genreId=101'
};

test('a charted performer becomes a card carrying the id the bio route checks', async () => {
    const fetchImpl = stubFetch([STAR]);
    const [card] = await fetchAffiliateRow(STARS_PROGRAM, { fetchImpl, signal });

    assert.equal(card.title, 'A Performer');

    // A number, not a string. `server/routes/stars.js` keys its allowlist on
    // the numeric id, so a card carrying "107821" would miss every lookup.
    assert.equal(card.starId, 107821);

    // headMedium over the 533px body shot: the row renders ten of these above
    // the fold and the crop is a circle.
    assert.equal(card.image, 'https://pics.example/s107821_m.jpg');
});

test("a star's link goes to the theatre host, not the bucket the feed came from", async () => {
    const fetchImpl = stubFetch([STAR]);
    const [card] = await fetchAffiliateRow(STARS_PROGRAM, { fetchImpl, signal });

    const href = new URL(card.href);
    assert.equal(href.origin, 'https://theater.example', 'linkOrigin is what bounds it');
    assert.equal(href.searchParams.get('refId'), 'AEBN-119817');
    assert.equal(href.searchParams.get('theaterId'), '13992');

    // The capital I is the spelling this feed answers to; the movie API wants
    // `refid`. Normalising the two is how the commission stops arriving.
    assert.equal(href.searchParams.get('refid'), null, 'not silently lower-cased');
});

test('a star link off the declared origin is dropped', async () => {
    const fetchImpl = stubFetch([{ ...STAR, contentUrl: 'https://somewhere.else/promo' }]);
    const cards = await fetchAffiliateRow(STARS_PROGRAM, { fetchImpl, signal });

    assert.deepEqual(cards, [], 'linkOrigin bounds the link as tightly as the API origin does');
});

test('the pitch feed is unwrapped from the object around it and sorted', async () => {
    const first = { ...SLIDE, pitchItemId: 1, sortOrder: 1, altText: 'First' };
    const fetchImpl = stubFetch({ slides: [SLIDE, first], intervalSeconds: 3 });

    const cards = await fetchAffiliateRow(PITCH_PROGRAM, { fetchImpl, signal });

    assert.equal(cards.length, 2);
    assert.equal(cards[0].title, 'First', 'sortOrder decides, not feed order');
    assert.equal(cards[1].title, 'Check out rising star X!');
});

test('a wrapped feed that is missing its list says which key was empty', async () => {
    const fetchImpl = stubFetch({ intervalSeconds: 3 });

    await assert.rejects(
        () => fetchAffiliateRow(PITCH_PROGRAM, { fetchImpl, signal }),
        /Partner\.slides sent undefined/
    );
});

test('one failing partner does not blank the others', async () => {
    const impl = async (url) => {
        if (String(url).includes('topstars')) throw new Error('CloudFront is having a day');
        return { ok: true, status: 200, json: async () => ({ slides: [SLIDE] }) };
    };

    const rows = await fetchAffiliates([STARS_PROGRAM, PITCH_PROGRAM], { fetchImpl: impl });

    assert.equal(rows.length, 1, 'the dead program is dropped, not rendered empty');
    assert.equal(rows[0].program.id, 'test-pitch');
});

/**
 * Storefront links.
 *
 * The feeds above are a catalogue we lay out; these are one attributed link to
 * the partner's whole site. Nothing here reaches a partner either — the point
 * is that the attribution our commission depends on is built correctly, which
 * is a property of the string and not of their server.
 */

const STOREFRONT = {
    id: 'test-storefront',
    partner: 'Partner',
    label: 'All movies at Partner',
    base: 'https://partner.example/straight/',
    query: { refid: 'AEBN-119817', salesToolId: '4', campaignId: '33970' }
};

test('a storefront link carries every attribution id it was given', () => {
    const url = new URL(storefrontUrl(STOREFRONT));

    assert.equal(url.origin + url.pathname, 'https://partner.example/straight/');
    assert.equal(url.searchParams.get('refid'), 'AEBN-119817');
    assert.equal(url.searchParams.get('salesToolId'), '4');
    assert.equal(url.searchParams.get('campaignId'), '33970');
});

test('a storefront base that already has a query keeps it', () => {
    const url = new URL(
        storefrontUrl({ ...STOREFRONT, base: 'https://partner.example/straight/?lang=en' })
    );

    assert.equal(url.searchParams.get('lang'), 'en', 'the base kept what it came with');
    assert.equal(url.searchParams.get('refid'), 'AEBN-119817');
});

test('a mistyped storefront base throws rather than producing a plausible link', () => {
    assert.throws(() => storefrontUrl({ ...STOREFRONT, base: 'partner.example/straight/' }));
});

test('every registered storefront is a usable, paid, attributed link', () => {
    for (const s of AFFILIATE_STOREFRONTS) {
        assert.ok(s.id && s.partner && s.label, `${s.id}: needs an id, a partner and a label`);

        const url = new URL(storefrontUrl(s));
        assert.equal(url.protocol, 'https:', `${s.id}: must be https`);

        // The one id that is actually paid on. `salesToolId` and `campaignId`
        // are the partner's reporting dimensions and are theirs to lose — see
        // the note on AEBN's AVS redirect in `affiliates.js` — but a link with
        // no referral id on it is unpaid work.
        assert.ok(
            url.searchParams.get('refid') || url.searchParams.get('refId'),
            `${s.id}: carries no referral id, so a sale through it pays nobody`
        );
    }
});

test('storefront ids are unique, so one cannot quietly shadow another', () => {
    const ids = AFFILIATE_STOREFRONTS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
});

/* ------------------------------------------------------ browse controls -- */

/**
 * The storefront link is the first link on the page.
 *
 * It used to sit in the partner section's head, directly beside the sentence
 * that says the links there are paid. Moving it up above that sentence meant
 * the disclosure had to come with it — and the whole risk of the move is that
 * a later edit tidies one away and leaves the other. It has since moved again,
 * into the fixed header, which raises the stakes rather than lowering them:
 * a fixed element is on screen at every scroll position.
 *
 * These are source checks because `browse.js` imports CSS, PlayCanvas and
 * image assets and cannot be loaded in Node. They are coarse, and they are
 * still the only thing standing between a refactor and the most prominent
 * undisclosed affiliate link on the site.
 */
const browseSource = readFileSync(
    new URL('../src/ui/browse.js', import.meta.url),
    'utf8'
);

const camsSource = readFileSync(new URL('../src/ui/cams.js', import.meta.url), 'utf8');

/** The stylesheet, for the checks that are about layout rather than markup. */
const css = readFileSync(new URL('../src/styles/netflix.css', import.meta.url), 'utf8');

/**
 * One method's body, by name.
 *
 * Anchored on the four-space indent of a class method *definition* rather
 * than on the bare name, because most of these are also called from
 * somewhere earlier in the file — `_browseNavHtml` from `_mastheadHtml`, and
 * so on — and slicing between call sites produces a backwards range and a
 * silently empty string that passes any `doesNotMatch` put to it.
 *
 * Throws rather than returning '' on a missed anchor, so a renamed method
 * fails loudly here instead of quietly disarming the checks below.
 *
 * The trailing `(` in the anchor is load-bearing twice over: it is what
 * distinguishes a definition from a call, and it is what stops `_bind`
 * matching `_bindSearch` and returning the wrong method's body.
 *
 * `async` is optional in both patterns. It has to be in the second one as
 * well as the first: a terminator that does not recognise an async method
 * runs straight past it and returns two methods glued together, which is
 * how a `doesNotMatch` ends up reading a body it was never pointed at.
 */
function methodBody(name, src = browseSource) {
    const open = new RegExp(`\\n {4}(?:async )?${name}\\(`);
    const found = open.exec(src);

    assert.ok(found, `${name} moved or was renamed`);

    const after = found.index + found[0].length;

    assert.ok(!open.test(src.slice(after)), `${name} is defined more than once`);

    // To the next method definition at the same indent, or the end.
    const next = src.slice(after).search(/\n {4}(?:async )?[_a-zA-Z]+\(/);
    return next === -1 ? src.slice(found.index) : src.slice(found.index, after + next);
}

test('the browse group discloses the paid link it leads with', () => {
    const nav = methodBody('_browseNavHtml');
    assert.match(nav, /_storefrontButtonsHtml\(/, 'the storefront link is in the group');
    assert.match(nav, /browse-disclosure/, 'and so is the disclosure that covers it');
    assert.match(
        nav,
        /commission on sales, at no extra cost to you/,
        'the disclosure still says what the commission is'
    );

    // Ordering, not just presence: a disclosure under a link is a disclosure,
    // one on the next screen is not. Both sit in `.browse-nav-group`, which is
    // a column, so order in the emitted markup is order on the page.
    //
    // Measured in the returned template and not in the method body, because
    // the disclosure is built into a local above the `return` and so comes
    // first in source order no matter where it is rendered.
    const markup = nav.slice(nav.indexOf('<div class="browse-nav-group">'));
    assert.ok(markup.length > 0, 'the browse group template moved');
    assert.ok(
        markup.indexOf('browse-nav"') < markup.indexOf('${disclosure}'),
        'the disclosure reads directly after the buttons it covers'
    );
});

/**
 * The links and their disclosure are one subtree, in one builder.
 *
 * This is the structural half of the test above, and it is the half that
 * matters now the group is mounted inside `position: fixed` chrome. If the
 * pills were emitted in the header and the sentence left in the body, the
 * paid links would be on screen at every scroll position with their
 * disclosure somewhere up the page. Keeping both in `_browseNavHtml` makes
 * that unreachable by moving a mount point, which is how it would happen.
 */
test('nothing emits the storefront buttons except the group that discloses them', () => {
    const calls = browseSource.match(/_storefrontButtonsHtml\(/g) || [];
    assert.equal(calls.length, 2, 'one definition and one call site');

    const nav = methodBody('_browseNavHtml');
    assert.match(nav, /_storefrontButtonsHtml\(/, 'and the call site is the group builder');

    // The two mount points render that one group and add nothing of their own.
    for (const name of ['_mastheadHtml', '_headerHtml']) {
        const body = methodBody(name);
        assert.doesNotMatch(
            body,
            /_storefrontButtonsHtml\(|browse-disclosure/,
            `${name} mounts the group rather than rebuilding half of it`
        );
    }
});

/**
 * Affiliate-only mode puts the live navigation in the header, once.
 *
 * `_render` emits `.masthead` only in full mode for exactly this reason: both
 * branches calling the group builder is the obvious regression, and it draws
 * both pills twice on the same page.
 */
test('the browse group is mounted in one place per site mode', () => {
    const header = methodBody('_headerHtml');
    assert.match(header, /_browseNavHtml\(\)/, 'the header mounts it in affiliate-only mode');

    const render = methodBody('_render');
    assert.match(
        render,
        /AFFILIATES_ONLY \? '' : this\._mastheadHtml\(\)/,
        'and `_render` skips the body mount in that mode, so it is never drawn twice'
    );
});

/**
 * The Coming Soon controls are scenery, and must stay scenery.
 *
 * Two attributes are absent on purpose and neither absence is visible by
 * looking at the rendered page, which is what makes them worth a test:
 *
 * - `data-filter` is what `_bindHeader` binds. It is not called in this mode
 *   today, so adding one here would break nothing *now* — it would break
 *   whenever `AFFILIATES_ONLY` is flipped back, by wiring a disabled button
 *   that filters the page from behind a Coming Soon sign.
 * - `id="search-input"` is queried by one `querySelector`, which takes the
 *   first match in document order. The dead copy is emitted before the real
 *   header in neither mode — but a duplicate id is a coin toss worth not
 *   flipping, and in affiliate-only mode the dead one would be the only one.
 */
test('the Coming Soon header controls cannot be mistaken for the live ones', () => {
    const soon = methodBody('_headerSoonHtml');

    assert.doesNotMatch(soon, /data-filter/, 'no `data-filter`, so `_bindHeader` cannot wire them');
    assert.doesNotMatch(soon, /id="search-input"/, 'no duplicate of the real search field id');
    assert.doesNotMatch(soon, /id="compat-btn"|id="account-slot"/, 'and no other live id');

    // Inert three ways: the attribute stops the click, `tabindex` keeps them
    // out of the tab order, and `aria-hidden` keeps the set out of the
    // accessibility tree.
    //
    // Walked tag by tag rather than counted, because the six filters are
    // emitted from one `filter()` helper and a count of the source would be
    // three where the page has eight. This way a ninth control added without
    // the attributes fails whether it is written out or generated.
    const tags = soon.match(/<(?:button|input)\b[^>]*>/g) || [];
    assert.equal(tags.length, 3, 'the filter helper, the search field and Send to headset');
    for (const tag of tags) {
        assert.match(tag, /\bdisabled\b/, `not disabled: ${tag.replace(/\s+/g, ' ')}`);
        assert.match(tag, /tabindex="-1"/, `focusable: ${tag.replace(/\s+/g, ' ')}`);
    }

    // And the helper is called once per filter, so the page draws eight dead
    // controls from those three templates.
    assert.equal((soon.match(/\$\{filter\('/g) || []).length, 6, 'six filters');
    assert.equal((soon.match(/aria-hidden="true"/g) || []).length, 2, 'both groups are hidden from AT');
});

/**
 * The overlay is the only thing making the dimmed controls honest.
 *
 * A greyed-out control with no label is a bug report. The same control under
 * "Coming Soon" is a roadmap. The badge is deliberately outside the
 * `aria-hidden` groups, so the one part of this a screen reader reaches is
 * the part that explains the rest.
 */
test('the Coming Soon controls are labelled as such', () => {
    const soon = methodBody('_headerSoonHtml');
    assert.match(soon, /header-soon-veil/, 'the veil is present');
    assert.match(soon, /Coming Soon!/, 'and says so in words');
    assert.doesNotMatch(
        soon.slice(soon.indexOf('header-soon-veil')),
        /aria-hidden/,
        'the label itself is not hidden from a screen reader'
    );

    // The veil covers the group, so there is no viewport in which a dimmed
    // control is visible and its explanation is not.
    assert.match(css, /\.header-soon-veil\s*\{[^}]*position:\s*absolute/, 'the veil is positioned');
    assert.match(css, /\.header-soon\s*\{[^}]*position:\s*relative/, 'against the group it covers');
});

/**
 * Order of concession in the affiliate-only header.
 *
 * The responsive section's own rule is never to hide a control that is not
 * reachable elsewhere on the same screen. The Coming Soon group is the single
 * exception in the file, because it is not reachable anywhere by anyone. That
 * makes it the first thing to drop when the bar runs short — and the live
 * pills and their disclosure must never be dropped at all, at any width.
 */
test('the dead controls give way before the live ones', () => {
    assert.match(
        css,
        /@media \(max-width: 1720px\)\s*\{\s*\.header-soon > \.header-right\s*\{\s*display: none/,
        'the dead search and Send to headset go first'
    );
    assert.match(
        css,
        /@media \(max-width: 1280px\)\s*\{\s*\.header-soon\s*\{\s*display: none/,
        'then the dead filters'
    );

    // The lead has to hold the badge. Shorter and the label's tail sits on
    // "Home", which is the bug the lead exists to prevent and which fails
    // nothing — it just quietly hides the first filter again.
    const lead = css.match(/--soon-lead:\s*(\d+)px/);
    assert.ok(lead, 'the lead is declared');
    assert.ok(Number(lead[1]) >= 125, `the lead (${lead[1]}px) is wider than the badge`);

    // Nothing anywhere in the stylesheet hides the live group or its
    // disclosure. A breakpoint that dropped the sentence and kept the pills
    // would be an undisclosed paid link at that width only — which is the
    // kind of bug nobody finds by looking at one browser window.
    for (const sel of ['browse-nav-group', 'browse-disclosure', 'browse-nav']) {
        const rules = css.match(new RegExp(`\\.${sel}[^{]*\\{[^}]*\\}`, 'g')) || [];
        assert.ok(rules.length > 0, `${sel} has rules`);
        for (const rule of rules) {
            assert.doesNotMatch(
                rule,
                /display:\s*none|visibility:\s*hidden/,
                `.${sel} is never hidden: ${rule.slice(0, 80)}`
            );
        }
    }
});

test('the storefront is a link, not a button, and still declares itself paid', () => {
    const buttons = methodBody('_storefrontButtonsHtml');
    assert.match(buttons, /<a class="pill pill-movies"/, 'an anchor, so it can be opened in a tab');
    assert.match(buttons, /rel="\$\{AFFILIATE_LINK_REL\}"/, 'rel carries the paid declaration');
    assert.match(buttons, /aria-label=/, 'the partner is named to a screen reader');
});

test('the storefront label is short enough to be a control', () => {
    // It is printed inside a pill in the masthead. A sentence here does not
    // fail anything, it just silently wraps that row onto three lines.
    for (const s of AFFILIATE_STOREFRONTS) {
        assert.ok(
            s.label.length <= 16,
            `${s.id}: "${s.label}" is too long for a button (${s.label.length} chars)`
        );
        assert.ok(s.partner.length > 0, `${s.id}: the accessible name needs a partner`);
    }
});

/**
 * `docs/SEARCH.md` §5: nothing indexed links `cams.lustxr.com`.
 *
 * There was a "Live Cams" button in the masthead, and this test used to pin
 * it as a `<button>` on the grounds that "Live Cams" reads like a control
 * that wants an href. The button is gone — it scrolled to a shelf that is
 * already the first element in `<main>` — so what is left is the rule
 * itself, checked against both files that draw cam UI rather than against
 * the one control that happened to be the temptation.
 *
 * `src/ui/cams.js` is now the likelier place for it to come back: it holds
 * the theatre, which embeds the white label's player, and the distance from
 * an embed to an "open in a new tab" link is one line.
 */
test('no client code points a visitor at our own white label', () => {
    // Comments stripped first. The rule is worth writing down next to the
    // code it constrains — both files do exactly that — so a check against
    // raw source would be failed by the sentences explaining why it must
    // not fail.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const [name, src] of [
        ['browse.js', browseSource],
        ['cams.js', camsSource]
    ]) {
        const code = strip(src);
        assert.doesNotMatch(code, /cams\.lustxr\.com/, `${name}: the host appears in no code path`);
        assert.doesNotMatch(code, /whitelabel\.chaturbate/, `${name}: nor does the CNAME behind it`);
    }
});

/**
 * A keystroke must narrow the row without repainting the head.
 *
 * `_render` replaces the mount's `innerHTML` wholesale. Routing a keystroke
 * through it would destroy and recreate the input being typed into, losing
 * the caret after the first character — the kind of defect that is obvious
 * in a browser and invisible in a diff, because `this._render()` is what
 * every other path in this file legitimately calls.
 */
test('typing in the cam search redraws the row and not the box', () => {
    const bind = methodBody('_bindSearch', camsSource);

    const handler = bind.slice(bind.indexOf("addEventListener('input'"));
    const body = handler.slice(0, handler.indexOf('});'));

    assert.ok(body.length > 0, 'the input handler moved out of _bindSearch');

    assert.match(body, /this\.query = /, 'the query is held on the instance');
    assert.match(body, /this\._reflow\(\)/, 'and the row alone is redrawn');
    assert.doesNotMatch(body, /this\._render\(\)/, 'a full render would take the caret with it');

    // The request is deferred; the redraw is not. Both halves matter — one
    // is why it does not cost a request per letter, the other is why the
    // delay is invisible.
    assert.match(body, /clearTimeout\(this\.queryTimer\)/, 'the pending request is cancelled');
    assert.match(body, /setTimeout\(\(\) => this\._requery\(\), QUERY_DEBOUNCE_MS\)/);
});

test('nothing that can run while somebody is typing calls _render', () => {
    // `_render` replaces the mount, which destroys the input along with its
    // caret, its selection and its focus. Only `refresh` may call it, and
    // `refresh` runs once, before there is anybody typing into anything.
    for (const name of ['_requery', '_reflow', '_bindSearch', '_suggestTake', '_countLater']) {
        assert.doesNotMatch(
            methodBody(name, camsSource).replace(/\/\*[\s\S]*?\*\//g, ''),
            /this\._render\(\)/,
            `${name} can run mid-keystroke and must not replace the mount`
        );
    }

    assert.match(methodBody('refresh', camsSource), /this\._render\(\)/, 'something must');
});

test('a superseded cam query is abandoned rather than raced', () => {
    const load = methodBody('_load', camsSource);

    assert.match(load, /this\.inflight\?\.abort\(\)/, 'the previous request is aborted');
    assert.match(load, /signal: this\.inflight\.signal/, 'and this one is abortable');

    // Without this the row survives a cancelled keystroke; with `this.rooms
    // = []` in the catch it would blank on every other letter typed.
    const caught = load.slice(load.indexOf('} catch'));

    assert.match(caught, /return false/);
    assert.doesNotMatch(caught, /this\.rooms\s*=/, 'a failed request must not empty the row');

    // `applied` is what stops `_visible` filtering locally. Setting it
    // anywhere but after a landed response would claim the server had
    // narrowed a list it never saw.
    assert.equal(
        (load.match(/this\.applied = /g) || []).length,
        1,
        'applied is assigned in exactly one place'
    );
    assert.ok(
        load.indexOf('this.applied = ') < load.indexOf('return true'),
        'and only on the path where a response arrived'
    );
});

test('the cam count waits for the answer it is reporting', () => {
    // `_countLater` announces into a live region. If it fired before the
    // debounced request, it would announce the local preview's count and
    // then be corrected a moment later — two interruptions for one query.
    const settle = Number(camsSource.match(/const COUNT_SETTLE_MS = ([\d_]+)/)?.[1]);
    const debounce = Number(camsSource.match(/const QUERY_DEBOUNCE_MS = ([\d_]+)/)?.[1]);

    assert.ok(Number.isFinite(settle) && Number.isFinite(debounce), 'both constants exist');
    assert.ok(settle > debounce, `the count (${settle}ms) must settle after the query (${debounce}ms)`);
});

test('the suggestion list is the server vocabulary, not the sixty rooms in hand', () => {
    const suggest = methodBody('_suggest', camsSource);

    // `this.tags` is the facet the route computes over everything online.
    // Building this from `this.rooms` instead would offer only the tags
    // that happen to be on the current page, which is the bug the server
    // side of this feature exists to prevent.
    assert.match(suggest, /this\.tags\s*$|this\.tags\b/m, 'suggestions come from the facet');
    assert.doesNotMatch(suggest, /this\.rooms/, 'and not from the rooms already drawn');
});

/**
 * The shelf offers no VR filter, and that is a measurement rather than taste.
 *
 * Every room online on 2026-10-19 — 5,990 of them — was swept, and not one
 * carried any of the nineteen spellings in the route's `VR_TAGS`; the
 * partner's own tag index returns zero for all nineteen, and the room object
 * has no VR field. A filter whose answer is always "none" promises a feed
 * that does not exist, so the two buttons that used to sit in the head were
 * taken out.
 *
 * This guards the removal rather than the reasoning: a control is an easy
 * thing to put back from a screenshot, and the measurement that says not to
 * lives in a comment nobody re-reads. `?vr=1` deliberately stays supported
 * route-side — see the cams route tests — so putting the buttons back is a
 * markup change, which is exactly why it needs a test in front of it.
 */
test('the cam shelf draws no filter it cannot populate', () => {
    const render = methodBody('_render', camsSource);

    assert.doesNotMatch(render, /data-cam-filter/, 'no filter buttons in the head');
    assert.doesNotMatch(render, /VR & 3D|Everyone/, 'nor the labels they carried');

    // The state behind them too. A left-over `this.filter` is a filter that
    // is applied and cannot be changed, which is worse than either answer.
    assert.doesNotMatch(camsSource, /this\.filter\b/, 'and no filter state anywhere');
    assert.doesNotMatch(camsSource, /\bFILTERS\b/, 'nor the table they were drawn from');

    // The badge is not the filter: a room that does tag itself still says so
    // on its card, which is the no-op the route's VR-first sort is kept for.
    assert.match(render + camsSource, /cam-badge vr/, 'a VR room is still labelled');
});

test('the cam shelf lets go of its timers and its request', () => {
    const destroy = methodBody('destroy', camsSource);

    for (const held of ['countTimer', 'queryTimer']) {
        assert.match(destroy, new RegExp(`clearTimeout\\(this\\.${held}\\)`), `${held} is cleared`);
    }

    assert.match(destroy, /this\.inflight\?\.abort\(\)/, 'and the request in flight is dropped');
});

/* ------------------------------------------------------- the scene panel -- */

/**
 * A title opened here instead of at the partner.
 *
 * The brief this answers is "serve the content from the API so that the user
 * stays on our site", and the panel is as far as that can be taken: the
 * partner's `files[].url` are member-gated — 403 anonymously *and* with our
 * affiliate key — so the artwork, the cast and the stills can live here and
 * the film cannot. The checks below are in two halves, and the halves pull
 * against each other on purpose. The first says the panel must be good enough
 * to decide from. The second says it must never pretend to be the film.
 *
 * Source checks, for the reason given above `browseSource`: `browse.js`
 * imports CSS, PlayCanvas and image assets and will not load in Node.
 */
test('a card the API can describe opens here; every other card leaves', () => {
    const card = methodBody('_affiliateCardHtml');

    assert.match(card, /data-scene-id="\$\{scene\}"/, 'the id the panel is opened by');
    assert.match(card, /scene \? ` data-scene-id|\$\{scene \?/, 'and only when there is one');

    // The glyph is the promise. An arrow that means "this leaves the site" on
    // a card that opens a dialog is the specific lie this guards.
    assert.match(
        card,
        /scene \? icons\.info\(\{ size: 12 \}\) : icons\.external\(\{ size: 12 \}\)/,
        'outbound keeps the arrow, previewable does not'
    );
    assert.match(card, /card-preview-hint/, 'and the previewable one says so in words');

    // Still a real anchor underneath, both ways. Middle-click, "copy link"
    // and a crawler all depend on it, and `rel` only means anything here.
    assert.match(card, /<a class="card affiliate-card/, 'it is an anchor, not a div');
    assert.match(card, /href="\$\{escapeHtml\(item\.href\)\}"/, 'with the partner link on it');
    assert.match(card, /rel="\$\{AFFILIATE_LINK_REL\}"/, 'and the paid-link declaration');
});

test('a modified click is never answered with a dialog', () => {
    // ⌘-click, middle-click, shift and alt are a request for a new tab. The
    // moment one of them opens a panel on the current page instead, a visitor
    // has learned that the links on this site do not do what links do.
    const fn = browseSource.slice(browseSource.indexOf('function opensInPanel'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
        assert.match(body, new RegExp(`event\\.${key}`), `${key} falls through to the anchor`);
    }

    assert.match(body, /\(event\.button \?\? 0\) !== 0/, 'and so does any button but the first');
    assert.match(body, /if \(!card\.dataset\?\.sceneId\) return false/, 'a card with no detail never opens');
});

test('one click is counted once, as the thing it actually was', () => {
    // `_bindOutbound` and `_bindScenePanel` are both delegated listeners on
    // the same mount and both match `.affiliate-card`. Without the guard the
    // same press reports an outbound visit to a partner that never happened,
    // which is the measurement that would make the panel look like it was
    // working by making it look like it was not being used.
    const outbound = methodBody('_bindOutbound');
    const panel = methodBody('_bindScenePanel');

    assert.match(outbound, /if \(opensInPanel\(e, card\)\) return/, 'outbound stands down');
    assert.match(outbound, /EVENTS\.AFFILIATE_CLICK/, 'and still reports the clicks that do leave');

    assert.match(panel, /EVENTS\.SCENE_OPEN/, 'the panel reports its own opening');
    assert.match(panel, /opensInPanel\(event, anchor\)/, 'on the same predicate, so they agree');

    // The same rule as every other call site here: which row, never which
    // title. See the note on identifiers at the top of `src/analytics.js`.
    const report = panel.slice(panel.indexOf('EVENTS.SCENE_OPEN'));
    assert.doesNotMatch(report.slice(0, report.indexOf('});')), /sceneId|title/, 'and nothing identifying');
});

test('the panel never claims to be playing the film', () => {
    // The licence boundary, pinned. Their files answer 403 to us as well as
    // to the public, so a `<video>` or an `<iframe>` added here later would
    // be a broken player at best and hotlinking at worst — and either way it
    // would be this site appearing to host a partner's scene.
    const html = methodBody('_sceneHtml');

    assert.doesNotMatch(html, /<video|<iframe|<source/, 'no player in the panel');
    assert.doesNotMatch(html, /\.mp4|files\[|video\/file/, 'and no path to one');

    // What it does carry instead, and what the whole exercise rests on.
    assert.match(html, /scene-stills/, 'the contact sheet');
    assert.match(html, /scene-cast/, 'the cast');
    assert.match(html, /scene-genres/, 'the genres');
    assert.match(html, /scene\?\.studio/, 'and the studio');
});

test('the panel discloses the paid link it is built around', () => {
    const html = methodBody('_sceneHtml');

    assert.match(html, /rel="\$\{AFFILIATE_LINK_REL\}"/, 'the outbound link declares itself');
    assert.match(html, /target="_blank"/, 'and opens away from this page');
    assert.match(
        html,
        /commission on\s+anything you spend, at no extra cost to you/,
        'the disclosure says what the commission is'
    );

    // Where the film actually is, said plainly rather than left to be
    // discovered at the partner's paywall.
    assert.match(html, /Hosted and streamed by \$\{partner\}/, 'and who is hosting it');
    assert.match(html, /Watch at \$\{partner\}/, 'the button names the destination');
});

test('the panel opens before the request, not after it', () => {
    // The card is already holding the cover, the title and the link, so there
    // is no reason for anybody to watch a spinner to find out whether
    // pressing the thing did anything — and a partner that never answers has
    // to degrade to a sparse panel rather than one that never fills.
    const open = methodBody('_openScene');

    const painted = open.indexOf('document.body.append(el)');
    const fetched = open.indexOf('await this._fetchScene');

    assert.ok(painted > 0 && fetched > 0, 'both steps are still in _openScene');
    assert.ok(painted < fetched, 'the panel is on screen before the request is awaited');

    assert.match(open, /this\._sceneHtml\(seed, null\)/, 'drawn from what the card knew');
    assert.match(open, /if \(this\.scenePanel !== el\) return/, 'and a stale answer is dropped');

    // Appended to `<body>`, not into `.affiliates` — that section carries
    // `position: relative; z-index: 2` and is therefore a stacking context,
    // which is the bug that once put an advertisement over the bio card.
    assert.match(open, /document\.body\.append\(el\)/, 'outside the stacking context');
});

test('a row of cards costs one request per title at most', () => {
    const fetchScene = methodBody('_fetchScene');

    assert.match(fetchScene, /if \(!this\.scenes\.has\(key\)\)/, 'asked once');
    assert.match(fetchScene, /\.catch\(\(\) => null\)/, 'and a failure is remembered too');

    // Otherwise a partner that is down turns one outage into one request per
    // card per hover, which is the load pattern that gets a key revoked.
    assert.match(fetchScene, /this\.scenes\.set\(/, 'the promise is cached, not the result');
    assert.match(fetchScene, /\/\^\\d\{1,12\}\$\//, 'and the id is checked before it is spent');
});

test('the panel can be left by every route somebody would try', () => {
    const dismiss = methodBody('_bindSceneDismissal');
    const close = methodBody('_closeScene');
    const html = methodBody('_sceneHtml');

    assert.match(html, /scene-panel-backdrop" data-close/, 'clicking away closes it');
    assert.match(html, /scene-panel-close" data-close/, 'so does the button');
    assert.match(dismiss, /event\.key === 'Escape'/, 'and so does Escape');

    assert.match(dismiss, /event\.key !== 'Tab'/, 'Tab is trapped inside the dialog');
    assert.match(close, /removeEventListener\('keydown', this\.onSceneKeydown\)/, 'the trap is released');

    // Back to the card it opened from. Without it the next Tab restarts at
    // the top of the document and the row somebody was working through is
    // gone — the reason the cam theatre does the same thing.
    assert.match(close, /this\.sceneReturnFocusTo\?\.focus\?\.\(\)/, 'and focus goes home');
});

test('the panel is laid out as a dialog, over the page and not under it', () => {
    assert.match(css, /\.scene-panel \{[^}]*position: fixed/, 'fixed to the viewport');
    assert.match(css, /body\.scene-panel-open \{\s*overflow: hidden/, 'the page behind cannot scroll');

    // Above the header, the player and the modal backdrop; below the bio
    // card, which is placed against a card rather than over the page.
    const z = /\.scene-panel \{[^}]*z-index: (\d+)/.exec(css);
    assert.ok(z, 'the panel declares a level');
    assert.ok(Number(z[1]) > 50, 'over the modal backdrop');
    assert.ok(Number(z[1]) < 90, 'and under the performer card');

    // The hint on the card is a promise about what a click will do, so it
    // cannot be a thing that only appears once the pointer is already there.
    const hint = /\.card-preview-hint \{([^}]*)\}/.exec(css);
    assert.ok(hint, 'the hint is styled');
    assert.doesNotMatch(hint[1], /display: none|opacity: 0/, 'and is legible before the hover');
});

test('nothing in the panel moves for somebody who asked it not to', () => {
    // Two animations: the panel's entrance and the pulse that stands in for
    // the detail still loading. Both are decoration, and both are off here.
    for (const rule of ['.scene-panel-box', '.scene-panel.is-loading .scene-panel-info::after']) {
        const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const at = new RegExp(
            `@media \\(prefers-reduced-motion: reduce\\) \\{\\s*${escaped} \\{\\s*animation: none`
        );
        assert.match(css, at, `${rule} holds still`);
    }
});

test('a results grid is laid out on the same gutter as every row above it', () => {
    const grid = /\.affiliate-results \{([^}]*)\}/.exec(css);
    assert.ok(grid, 'the grid is styled');

    // 4vw is the site's gutter, and the shelves apply it themselves —
    // `#affiliate-groups` has none of its own, which the ad comment in this
    // stylesheet relies on. A grid that is not a shelf has to state it or it
    // runs to the viewport edge underneath a heading that does not.
    assert.match(grid[1], /padding: 0 4vw/, 'the grid states the gutter');
    assert.match(css, /\.shelf-head \{[^}]*padding: 0 4vw/, 'which is the one the heading uses');

    // `.affiliate-card` is `width: 168px` so that a scrolling track aligns.
    // A fixed width inside a `1fr` cell leaves dead space down the right of
    // every column instead of filling it.
    assert.match(
        css,
        /\.affiliate-results \.affiliate-card \{\s*width: auto/,
        'and a card in a cell takes the cell'
    );
});

test('the two rows from one partner are not the same row twice', () => {
    const bang = AFFILIATE_PROGRAMS.filter((p) => p.partner === 'Bang');
    assert.ok(bang.length >= 2, 'there is more than one');

    const apis = new Set(bang.map((p) => p.api));
    assert.equal(apis.size, bang.length, 'each reads a different sort');

    // Measured against the live API: `rating.allTime` returns 19 of the same
    // 24 titles as `views.allTime`, because the most-watched scenes are the
    // most-voted-on. Two headings over one list is a padded page, and it is
    // the specific mistake this pair was changed to avoid — see the note in
    // `src/catalog/affiliates.js`.
    assert.ok(
        !(apis.has('/api/bang/shelf/most-watched') && apis.has('/api/bang/shelf/top-rated')),
        'and all-time views and all-time rating are not both front-page rows'
    );
});
