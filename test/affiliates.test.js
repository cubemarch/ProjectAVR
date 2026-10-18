import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AFFILIATE_GROUPS,
    AFFILIATE_LINK_REL,
    AFFILIATE_PROGRAMS,
    fetchAffiliateRow,
    fetchAffiliates
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
