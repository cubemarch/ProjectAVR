import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AEBN's three feeds, read through our own server so the artwork can be covered.
 *
 * The interesting property is not that the proxy works — it is that the
 * covering rewrite cannot miss an image. These three payloads have three
 * different shapes and nothing in the route knows any of them, so the tests
 * that matter are the ones that walk the response looking for a partner URL
 * that survived, rather than ones that check a named field.
 *
 * The fixtures below are copied from the live feeds on 2026-10-20, field names
 * and all. That is worth redoing before trusting this file: the cam shelf sat
 * empty in production for a working affiliate code because its fixture had
 * been written from the same documentation as the code and carried the same
 * stale field name.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-aebn-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';

const { app } = await import('../server/index.js');
const { _internals, _resetAebnCache } = await import('../server/routes/aebn.js');
const { AFFILIATE_PROGRAMS } = await import('../src/catalog/affiliates.js');

const { coverDeep, looksLikeImage, feeds } = _internals;

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;

test.after(() => {
    globalThis.fetch = realFetch;
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- fixtures -- */

const PITCH = {
    intervalSeconds: 7,
    slides: [
        {
            pitchItemId: 5191,
            sortOrder: 1,
            imageUrl: 'https://pic.aebn.net/video-on-demand/straight/top-pitch/star/emma-sirus-140869-1366x400.jpg',
            itemType: 'com.aebn.content.domain.star.Star.starId',
            itemId: 140869,
            altText: 'Check out rising star Emma Sirus! Watch her content now!',
            contentUrl: '/dispatcher/starDetail?starId=140869&genreId=101'
        }
    ]
};

const STARS = [
    {
        rankId: 1,
        starId: 107821,
        starName: 'Kenna James',
        contentUrl: '/dispatcher/starDetail?starId=107821&genreId=101',
        images: {
            headSmall: 'https://pic.aebn.net/Stream/Movie/Stars/s107821_i42202_s.jpg',
            headMedium: 'https://pic.aebn.net/Stream/Movie/Stars/s107821_i42202_m.jpg',
            bodySmall: 'https://pic.aebn.net/Stream/Movie/Stars/s107821_i42203_s.jpg',
            bodyMedium: 'https://pic.aebn.net/Stream/Movie/Stars/s107821_i42203_m.jpg',
            bodyLarge: 'https://pic.aebn.net/Stream/Movie/Stars/s107821_i42203_l.jpg'
        }
    }
];

const NEWEST = [
    {
        durationMs: 9502060,
        publishedDate: 1792472400000,
        movieId: 329792,
        movieTitle: 'Stepfamily Always Comes First 18',
        imageUrl: 'https://pic.aebn.net/Stream/Movie/BoxCovers/a329792_xlf.jpg',
        vodUrl: '/straight/movies/329792/stepfamily-always-comes-first-18'
    }
];

const BODIES = new Map([
    ['aebnpitchslidesstraight.json', PITCH],
    ['aebntopstarsstraight.json', STARS],
    ['movies/newest', NEWEST]
]);

/**
 * Stand in for AEBN's two hosts.
 *
 * Anything else falls through to the real `fetch`, which is load-bearing
 * rather than tidiness: every case below reaches the route by calling this
 * server over HTTP, so a stub that swallowed everything would answer the
 * test's own request with a fixture and the route would never run.
 */
function stubUpstream({ fail = false, status = 200 } = {}) {
    const calls = [];

    globalThis.fetch = async (input, init) => {
        const href = String(input);
        if (!/aebn\.com|cloudfront\.net/.test(href)) return realFetch(input, init);

        calls.push(href);

        if (fail) throw new Error('connection reset');

        const key = [...BODIES.keys()].find((k) => href.includes(k));

        return new Response(JSON.stringify(BODIES.get(key) ?? null), {
            status,
            headers: { 'content-type': 'application/json' }
        });
    };

    return calls;
}

/** A browser that has been through the age gate, from a state that only asks for a click. */
async function verifiedVisitor(region = 'OR') {
    const jar = new Map();

    const call = async (url, options = {}) => {
        const headers = { ...(options.headers ?? {}), 'x-geo-country': 'US', 'x-geo-region': region };

        if (options.body) headers['Content-Type'] = 'application/json';
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

        const res = await realFetch(`${base}${url}`, { ...options, headers });

        for (const line of res.headers.getSetCookie?.() ?? []) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            if (pair.slice(eq + 1).trim()) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }

        return { status: res.status, body: await res.json(), headers: res.headers };
    };

    const gate = await call('/api/identity/gate');

    await call('/api/identity/gate/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: gate.body?.jurisdiction?.attestation?.version })
    });

    return call;
}

/* ------------------------------------------------------------- the rewrite -- */

test('every partner image in a payload is covered, whatever shape it arrived in', () => {
    // One assertion over all three feeds rather than three field-by-field
    // ones, because "did it miss a field" is the only question here and a
    // test that names the fields can only ever miss the same ones the code
    // does.
    for (const [name, body] of [['pitch', PITCH], ['stars', STARS], ['newest', NEWEST]]) {
        const json = JSON.stringify(coverDeep(body));

        assert.doesNotMatch(json, /pic\.aebn\.net/, `${name} leaked a partner image host`);
        assert.match(json, /\\?\/api\\?\/media\?u=/, `${name} covered nothing at all`);
    }
});

test('the five star sizes are all covered, not just the one the row draws', () => {
    // The adapter picks `headMedium`. The other four are still real artwork of
    // a real person and a payload is a thing a reader can open.
    const [star] = coverDeep(STARS);

    for (const [size, url] of Object.entries(star.images)) {
        assert.match(url, /^\/api\/media\?u=/, `${size} was left as the partner's URL`);
    }
});

test('text beside the images is left exactly as it arrived', () => {
    // The walk is blind to field names, so the thing to prove is that it is
    // also blind in the other direction: a sell line, a title and a
    // site-relative path are not URLs it should be touching.
    const [slide] = coverDeep(PITCH).slides;

    assert.equal(slide.altText, PITCH.slides[0].altText);
    assert.equal(slide.contentUrl, PITCH.slides[0].contentUrl, 'a relative path is not an image');
    assert.equal(slide.itemType, PITCH.slides[0].itemType, 'nor is a dotted class name');
    assert.equal(slide.itemId, 140869, 'and numbers stay numbers');
});

test('a partner image we cannot sign is dropped rather than passed through', () => {
    // The fail-closed half, and the case that makes it matter: AEBN serving
    // artwork from a host nobody added to the allowlist. A gap in the row is
    // the intended outcome. Shown next to a signable URL so the test cannot
    // pass by covering nothing.
    const covered = coverDeep({
        good: 'https://pic.aebn.net/Stream/Movie/BoxCovers/a1_xlf.jpg',
        moved: 'https://images.aebn.example/BoxCovers/a1.jpg',
        insecure: 'http://pic.aebn.net/Stream/Movie/BoxCovers/a1_xlf.jpg'
    });

    assert.match(covered.good, /^\/api\/media\?u=/);
    assert.equal(covered.moved, null, 'a new partner host is not a free pass');
    assert.equal(covered.insecure, null, 'and neither is the right host over plain http');
});

test('what counts as an image is decided by the URL and not by the field name', () => {
    assert.ok(looksLikeImage('https://pic.aebn.net/a/b.jpg'));
    assert.ok(looksLikeImage('https://pic.aebn.net/a/b.WEBP'), 'extensions are not case-sensitive');
    assert.ok(looksLikeImage('http://anywhere.test/x.png'), 'plain http still gets asked about');

    assert.ok(!looksLikeImage('/dispatcher/starDetail?starId=1'), 'a site-relative path');
    assert.ok(!looksLikeImage('Check out rising star Emma Sirus!'), 'a sell line');
    assert.ok(!looksLikeImage('com.aebn.content.domain.star.Star.starId'), 'a dotted class name');
    assert.ok(!looksLikeImage('https://pic.aebn.net/feed.json'), 'and a URL that is not a picture');
});

/* ---------------------------------------------------------------- the route -- */

test('the feeds this route serves are the ones the programs ask for', () => {
    // Both halves come from the same registry, so this is really a check that
    // the derivation did not silently produce an empty map - which would make
    // every row 404 and every test below pass for the wrong reason.
    const map = feeds();
    const programs = AFFILIATE_PROGRAMS.filter((p) => p.api.startsWith('/api/aebn/'));

    assert.equal(map.size, 3, 'three feeds');
    assert.equal(programs.length, 3, 'and three programs reading them');

    for (const program of programs) {
        const segment = program.api.slice('/api/aebn/'.length);
        assert.equal(map.get(segment), program.upstream, `${program.id} resolves to its own upstream`);
    }
});

test('an unverified visitor gets the row with every image covered', async () => {
    _resetAebnCache();
    stubUpstream();

    try {
        const res = await realFetch(`${base}/api/aebn/stars`);
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.doesNotMatch(JSON.stringify(body), /pic\.aebn\.net/, 'a partner image survived');
        assert.match(body[0].images.headMedium, /^\/api\/media\?u=/);

        // The row is still a row. Covering is not withholding - the names and
        // the chart order are what make it browsable at all.
        assert.equal(body[0].starName, 'Kenna James');
        assert.equal(body[0].rankId, 1);

        assert.match(res.headers.get('cache-control'), /private|no-store/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a verified visitor gets the partner artwork directly', async () => {
    _resetAebnCache();
    stubUpstream();

    try {
        const call = await verifiedVisitor();
        const { status, body, headers } = await call('/api/aebn/newest');

        assert.equal(status, 200);
        assert.equal(body[0].imageUrl, NEWEST[0].imageUrl, 'untouched, straight off their CDN');
        assert.doesNotMatch(JSON.stringify(body), /\/api\/media/, 'nothing was covered');
        assert.match(headers.get('cache-control'), /public/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('one upstream read is shared, and the gate is applied after it', async () => {
    // The cache holds the partner's payload, not a rendered one. If it ever
    // held the covered version, the first unverified visitor would poison it
    // for every verified one behind them - so the thing to prove is that two
    // visitors on opposite sides of the gate get different bodies from the
    // same single upstream call.
    _resetAebnCache();
    const calls = stubUpstream();

    try {
        const anon = await (await realFetch(`${base}/api/aebn/newest`)).json();

        const call = await verifiedVisitor();
        const { body: verified } = await call('/api/aebn/newest');

        assert.equal(calls.length, 1, 'the partner was read once');
        assert.match(anon[0].imageUrl, /^\/api\/media\?u=/);
        assert.equal(verified[0].imageUrl, NEWEST[0].imageUrl);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a feed nobody registered is a 404 rather than a fetch', async () => {
    // The route takes a path segment, so this is the request-forgery question
    // in its own shape: the segment indexes a map built from our own registry
    // and is never turned into a URL.
    _resetAebnCache();
    const calls = stubUpstream();

    try {
        // The traversal is percent-encoded deliberately. Written plainly,
        // `fetch` resolves it away before the request leaves — the server is
        // asked for `/api/bang/search` and answers it, which is correct and
        // is not this route being tested. Encoded, it arrives as one segment
        // and has to be refused here.
        const bad = ['gay', 'pitchslides', '%2e%2e%2fbang%2fsearch', 'https%3A%2F%2Fevil.test'];

        for (const segment of bad) {
            const res = await realFetch(`${base}/api/aebn/${segment}`);
            assert.equal(res.status, 404, segment);
            await res.json();
        }

        assert.equal(calls.length, 0, 'nothing upstream was contacted');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a partner outage is an empty row, not a broken one', async () => {
    _resetAebnCache();
    stubUpstream({ fail: true });

    try {
        const res = await realFetch(`${base}/api/aebn/pitch`);
        const body = await res.json();

        assert.equal(res.status, 502);
        assert.equal(body.code, 'upstream_failed');
        assert.equal(res.headers.get('cache-control'), 'no-store', 'a failure is not cached');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('the feeds are kept out of search results', async () => {
    _resetAebnCache();
    stubUpstream();

    try {
        const res = await realFetch(`${base}/api/aebn/stars`);
        await res.json();

        assert.match(res.headers.get('x-robots-tag'), /noindex/);
    } finally {
        globalThis.fetch = realFetch;
    }
});
