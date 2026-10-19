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
        assert.equal(
            new URL(program.api).protocol,
            'https:',
            `${program.id} is read over https`
        );
        assert.ok(program.partner, `${program.id} names who the click leaves for`);

        // Without the tracking params the links still work and the commission
        // is lost silently, which is the failure nobody notices for a month.
        // Kept partner-agnostic deliberately: a live-cams deal will carry
        // different parameter names, and this should not need editing for it.
        assert.ok(
            Object.keys(program.query ?? {}).length > 0,
            `${program.id} carries something that attributes the sale`
        );
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

/** The stylesheet, for the checks that are about layout rather than markup. */
const css = readFileSync(new URL('../src/styles/netflix.css', import.meta.url), 'utf8');

/**
 * One method's body, by name.
 *
 * Anchored on the four-space indent of a class method *definition* rather
 * than on the bare name, because every one of these is also called from
 * somewhere earlier in the file — `_syncCamsButton` from `refreshCams`,
 * `_camsButtonHtml` from `_browseNavHtml` — and slicing between call sites
 * produces a backwards range and a silently empty string that passes any
 * `doesNotMatch` put to it.
 *
 * Throws rather than returning '' on a missed anchor, so a renamed method
 * fails loudly here instead of quietly disarming the checks below.
 */
function methodBody(name) {
    const open = `\n    ${name}(`;
    const start = browseSource.indexOf(open);
    assert.notEqual(start, -1, `${name} moved or was renamed`);
    assert.equal(
        browseSource.indexOf(open, start + 1),
        -1,
        `${name} is defined more than once`
    );

    // To the next method definition at the same indent, or the end.
    const next = browseSource.slice(start + open.length).search(/\n {4}[_a-zA-Z]+\(/);
    return next === -1 ? browseSource.slice(start) : browseSource.slice(start, start + open.length + next);
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
    // It is printed inside a pill beside "Live Cams". A sentence here does not
    // fail anything, it just silently wraps the masthead onto three lines.
    for (const s of AFFILIATE_STOREFRONTS) {
        assert.ok(
            s.label.length <= 16,
            `${s.id}: "${s.label}" is too long for a button (${s.label.length} chars)`
        );
        assert.ok(s.partner.length > 0, `${s.id}: the accessible name needs a partner`);
    }
});

test('the live cam control never points at our own white label', () => {
    // `docs/SEARCH.md` §4: nothing indexed links `cams.lustxr.com`. The
    // masthead button is the most plausible place for that to be undone,
    // because "Live Cams" reads like it wants an href.
    const cams = methodBody('_camsButtonHtml');
    assert.match(cams, /<button class="pill pill-cams"/, 'a button, so it cannot carry an href');

    // Comments stripped first. The rule is worth writing down next to the
    // control it constrains, and `_camsButtonHtml` does exactly that — so a
    // check against the raw source would be failed by the sentence
    // explaining why it must not fail.
    const code = browseSource.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /cams\.lustxr\.com/, 'the host appears in no code path');
    assert.doesNotMatch(code, /whitelabel\.chaturbate/, 'nor does the CNAME behind it');
});
