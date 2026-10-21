import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Bang catalogue rows.
 *
 * Two halves, and the first is the one that matters. `normaliseVideo` is the
 * only thing between a third party's JSON and our page: every image `src` and
 * every outbound `href` on a Bang card is decided in it. So it is driven with
 * hostile input rather than a happy-path fixture — artwork pointing off their
 * host, an id that is not an id, a payload trying to supply its own link.
 *
 * The second half drives the routes with upstream stubbed, for the four
 * properties that are not visible from the pure functions: that an
 * unconfigured deployment renders nothing rather than erroring, that the sort
 * is a whitelist rather than a passthrough, that an upstream error arriving as
 * a 200 is treated as a failure rather than as an empty catalogue, and that
 * the API key does not leave in a query string.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-bang-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';

delete process.env.AVR_BANG_API_KEY;
delete process.env.AVR_BANG_AFF;

const { app } = await import('../server/index.js');
const { _internals, _resetBangCache } = await import('../server/routes/bang.js');

const { normaliseVideo, imageUrl, watchUrl, sceneSlug, SORTS, SHELVES } = _internals;

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;

test.after(() => {
    globalThis.fetch = realFetch;
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- fixture -- */

/**
 * One scene as upstream actually sends it.
 *
 * Copied from a live `POST /content/search/videos?by=views.allTime` response
 * on 2026-10-20, field names and all, which is a thing worth redoing before
 * trusting this file: the cam shelf sat empty in production for a working
 * affiliate code because its fixture had been written from the same
 * documentation as the code and carried the same stale field name.
 *
 * Two details here are real and load-bearing. `files[].url` is a plain-looking
 * MP4 that answers **403** to us — it is a member asset, which is why nothing
 * in this route ever offers it. And `genres[].id` really is `0` for every
 * genre, so the name is all there is to key on.
 */
function upstreamVideo(over = {}) {
    return {
        id: '572a72efbad19fca448b4569',
        identifier: 125768,
        name: 'Amateur Teen Nina North Eats Cum for Bang!',
        type: 'movie',
        order: 1,
        release_date: '2016-08-22',
        gay: false,
        category: 'straight',
        hd: true,
        duration: 2403,
        studio: { id: 305, name: 'best of bang!', img: 'https://i.bang.com/bang-assets/images/studio-logos/305_large.jpg' },
        series: { id: 3366, name: 'bang! real teens' },
        dvd: { id: '57222d05bad19f70228b4567', identifier: 25263, name: 'real teens: nina north', img: 'https://i.bang.com/covers/25263/front.jpg' },
        screenshots: [
            'https://i.bang.com/screenshots/25263/movie/1/1177540.jpg',
            'https://i.bang.com/screenshots/25263/movie/1/1177539.jpg'
        ],
        actors: [{ id: '572a72edbad19fca448b4567', identifier: 25006, name: 'Nina North', gender: 'F', img: 'https://i.bang.com/pornstars/25006.jpg' }],
        genres: [{ id: 0, name: 'outdoor' }, { id: 0, name: 'amateur' }],
        files: [
            { format_id: 16, url: 'https://www.bang.com/video/file/572a72efbad19fca448b4569/nina-north-scene-1.1080p.mp4', file_size: 2160744948, format: 'MP4 1080p HD' },
            { format_id: 14, url: 'https://www.bang.com/video/file/572a72efbad19fca448b4569/nina-north-scene-1.360p.mp4', file_size: 182290844, format: 'MP4 360p' }
        ],
        ...over
    };
}

/**
 * Stand in for Bang, and record what they were asked for.
 *
 * Anything that is not their host falls through to the real `fetch`, which is
 * load-bearing rather than tidiness: every case below reaches the route by
 * calling this server over HTTP, so a stub that swallowed everything would
 * answer the test's own request with the fixture and the route under test
 * would never run at all.
 */
function stubUpstream(body, { status = 200, fail = false } = {}) {
    const calls = [];

    globalThis.fetch = async (input, init) => {
        const href = String(input);
        if (!href.includes('api.bang.com')) return realFetch(input, init);

        calls.push({ url: new URL(href), init });

        if (fail) throw new Error('connection reset');

        return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
        });
    };

    return calls;
}

/* ------------------------------------------------------------- normalising -- */

test('an ordinary scene becomes a card', () => {
    const scene = normaliseVideo(upstreamVideo());

    assert.equal(scene.id, '572a72efbad19fca448b4569');
    assert.equal(scene.ref, 125768);
    assert.equal(scene.title, 'Amateur Teen Nina North Eats Cum for Bang!');
    assert.equal(scene.durationMs, 2403 * 1000);
    assert.equal(scene.hd, true);
    assert.equal(scene.releaseDate, '2016-08-22');
    assert.equal(scene.studio, 'best of bang!');
    assert.equal(scene.series, 'bang! real teens');
    assert.equal(scene.image, 'https://i.bang.com/covers/25263/front.jpg');
    assert.equal(scene.screenshots.length, 2);
    assert.deepEqual(scene.actors, [{ name: 'Nina North', image: 'https://i.bang.com/pornstars/25006.jpg' }]);
    assert.deepEqual(scene.genres, ['outdoor', 'amateur']);
});

test('the member-only file URLs are never carried onto the card', () => {
    // They answer 403 to the affiliate tier, so offering one would be a dead
    // link at best. Asserted on the whole serialised card rather than on a
    // field, because the point is that it is nowhere rather than that one
    // named property is absent.
    const json = JSON.stringify(normaliseVideo(upstreamVideo()));

    assert.doesNotMatch(json, /\.mp4/, 'no file URL survives normalisation');
    assert.doesNotMatch(json, /video\/file/, 'nor the path they live under');
});

test('the outbound link is built here, never taken from the payload', () => {
    // The slug comes out of their own file URL because ours would be a guess,
    // and the bare `/video/{id}` form 404s - the slug is part of the route.
    const scene = normaliseVideo(upstreamVideo());

    assert.equal(
        scene.href,
        'https://www.bang.com/video/572a72efbad19fca448b4569/nina-north-scene-1'
    );
});

test('a scene with no files still gets a link, from a slugified title', () => {
    const scene = normaliseVideo(upstreamVideo({ files: [], name: 'Hardcore Blondes - Scene 4' }));

    assert.equal(
        scene.href,
        'https://www.bang.com/video/572a72efbad19fca448b4569/hardcore-blondes-scene-4'
    );
});

test('only the quality and the extension come off the slug', () => {
    // A slug may legitimately contain dots, and stripping every one would
    // mangle it into a link that 404s.
    assert.equal(
        sceneSlug({ files: [{ url: 'https://www.bang.com/video/file/x/dr.-smith-scene-2.1080p.mp4' }] }),
        'dr.-smith-scene-2'
    );
});

test('the tracking code rides on every link when it is configured', () => {
    process.env.AVR_BANG_AFF = 'LUSTXR-TEST';

    try {
        assert.equal(
            watchUrl('572a72efbad19fca448b4569', 'a-slug'),
            'https://www.bang.com/video/572a72efbad19fca448b4569/a-slug?aff=LUSTXR-TEST'
        );
    } finally {
        delete process.env.AVR_BANG_AFF;
    }

    // And without it the link is unattributed and still correct. A missing
    // tracking code should cost a commission, not a working page.
    assert.equal(
        watchUrl('572a72efbad19fca448b4569', 'a-slug'),
        'https://www.bang.com/video/572a72efbad19fca448b4569/a-slug'
    );
});

test('artwork from anywhere but their own host is refused', () => {
    const refused = {
        'another origin entirely': 'https://evil.example/cover.jpg',
        'their host as a prefix of somebody else': 'https://i.bang.com.evil.example/cover.jpg',
        'plain http': 'http://i.bang.com/covers/1/front.jpg',
        'a javascript URL': 'javascript:alert(1)',
        'a data URL': 'data:image/svg+xml;base64,AAAA',
        'not a URL at all': 'covers/1/front.jpg'
    };

    for (const [why, src] of Object.entries(refused)) {
        assert.equal(imageUrl(src), null, `${why} is refused`);
    }

    // A subdomain of theirs is fine; the bound is the registrable host.
    assert.ok(imageUrl('https://cdn.i.bang.com/covers/1/front.jpg'));
});

test('a scene we cannot safely draw comes back as nothing', () => {
    const refused = {
        'an id that is not a Mongo id': { id: '../../etc/passwd' },
        'an id of the wrong length': { id: 'abc123' },
        'an id with a path separator in it': { id: '572a72efbad19fca448b45/9' },
        'no title': { name: '   ' },

        // No artwork is no card: a scene we can neither picture nor fall back
        // on is somebody else's bandwidth for nothing.
        'no usable artwork anywhere': { dvd: { img: 'https://evil.example/x.jpg' }, screenshots: [] }
    };

    for (const [why, over] of Object.entries(refused)) {
        assert.equal(normaliseVideo(upstreamVideo(over)), null, `${why} is refused`);
    }

    assert.equal(normaliseVideo(null), null);
    assert.equal(normaliseVideo('a string'), null);
});

test('a scene with no cover falls back to its first screenshot', () => {
    const scene = normaliseVideo(upstreamVideo({ dvd: null }));

    assert.equal(scene.image, 'https://i.bang.com/screenshots/25263/movie/1/1177540.jpg');
});

test('an off-host screenshot is dropped rather than shown', () => {
    const scene = normaliseVideo(
        upstreamVideo({
            screenshots: ['https://evil.example/1.jpg', 'https://i.bang.com/screenshots/25263/movie/1/1177539.jpg']
        })
    );

    assert.deepEqual(scene.screenshots, ['https://i.bang.com/screenshots/25263/movie/1/1177539.jpg']);
});

/* ------------------------------------------------------------- the registry -- */

test('every shelf on the front page names a sort that exists', () => {
    assert.ok(SHELVES.size > 0, 'at least one shelf is configured');

    for (const id of SHELVES.keys()) {
        assert.ok(SORTS.has(id), `${id} resolves to a sort`);
    }
});

test('no shelf claims to be sorted by something the API cannot do', () => {
    // The API's whole vocabulary is views, rating and release date - there is
    // no revenue dimension, so there can be no "top selling" row. This pins
    // the copy to that: a heading making a claim the data cannot support is
    // the kind of thing this domain is in no position to print.
    for (const title of SHELVES.values()) {
        assert.doesNotMatch(title, /selling|best.?seller|top.?sell/i, `"${title}" claims sales data`);
    }

    for (const by of SORTS.values()) {
        assert.match(by, /^(views|rating|releaseDate)\./, `${by} is one the API reports`);
    }
});

/* ------------------------------------------------------------------ routes -- */

test('an unconfigured deployment renders nothing rather than erroring', async () => {
    // The normal state in development and on any deployment without a Bang
    // deal. A 503 here would put a red line in the console of a working site.
    for (const target of ['/api/bang/shelf/most-watched', '/api/bang/search', '/api/bang/scene/125768']) {
        const res = await fetch(`${base}${target}`);
        const body = await res.json();

        assert.equal(res.status, 200, `${target} is not an error`);
        assert.equal(body.configured, false, `${target} says so plainly`);
        assert.deepEqual(body.items, [], `${target} draws nothing`);
    }
});

test('the routes are noindex even before they are configured', async () => {
    // Belt and braces with robots.txt, which already disallows /api/: a
    // disallow stops a crawl, a header is read by anything that got here
    // without consulting the file first.
    const res = await fetch(`${base}/api/bang/shelf/most-watched`);

    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
});

test('a configured shelf draws the partner catalogue', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [upstreamVideo()], total: 164595, size: 1 });

    const res = await fetch(`${base}/api/bang/shelf/most-watched`);
    const body = await res.json();

    assert.equal(body.configured, true);
    assert.equal(body.title, 'Most Watched');
    assert.equal(body.items.length, 1);
    assert.match(body.items[0].href, /^https:\/\/www\.bang\.com\//);

    assert.equal(calls.length, 1, 'one upstream call');
    assert.equal(calls[0].url.searchParams.get('by'), 'views.allTime');
});

test('the key goes in a header and never into the URL', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 0, size: 0 });
    await fetch(`${base}/api/bang/shelf/top-rated`);

    // Their spec accepts `?a-api-key=` too. Both authenticate; only one of
    // them stays out of access logs, proxy logs and error reports.
    assert.doesNotMatch(calls[0].url.href, /test-key/, 'the key is not in the URL');
    assert.equal(calls[0].init.headers.Authorization, 'affiliate test-key');
});

test('the sort is a whitelist, not a passthrough', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 0, size: 0 });

    // A `by` their index cannot sort on comes back as HTTP 200 carrying an
    // Elasticsearch query_shard_exception, naming the index and its UUID. So
    // visitor input never reaches that parameter.
    await fetch(`${base}/api/bang/search?sort=nonsense.value`);

    assert.equal(calls[0].url.searchParams.get('by'), 'views.allTime', 'falls back to a real sort');

    // And an unknown shelf is a 404 here rather than a bad request upstream.
    const res = await fetch(`${base}/api/bang/shelf/top-selling`);
    assert.equal(res.status, 404);
    assert.equal(calls.length, 1, 'the unknown shelf cost no upstream call');
});

test('an upstream error arriving as a 200 is not an empty catalogue', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    // This is verbatim the shape a bad sort returns: status 200, no result
    // list, and an Elasticsearch stack trace in the body.
    stubUpstream({
        error: '400 Bad Request: {"error":{"root_cause":[{"type":"query_shard_exception",' +
            '"reason":"No mapping found for [nonsense] in order to sort on",' +
            '"index_uuid":"LyFz6xmmRV-xRs4ZHJDNMw","index":"videos"}]}}'
    });

    const res = await fetch(`${base}/api/bang/search`);
    const body = await res.json();

    assert.equal(res.status, 502, 'a failure, not a quiet night');
    assert.doesNotMatch(JSON.stringify(body), /index_uuid|query_shard/, 'and their internals stay upstream');
});

test('a shelf whose partner is having a bad minute goes missing, not red', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    stubUpstream(null, { fail: true });

    const res = await fetch(`${base}/api/bang/shelf/most-watched`);
    const body = await res.json();

    // `fetchAffiliates` drops a program that returns nothing, so an empty
    // list renders as the row being absent - which is the right outcome for
    // one partner being down, and is why this is not a 502.
    assert.equal(res.status, 200);
    assert.deepEqual(body.items, []);
});

test('paging is clamped to something this server will pay for', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 164595, size: 0 });

    await fetch(`${base}/api/bang/search?page=99999&size=5000`);
    assert.equal(calls[0].url.searchParams.get('page'), '100');
    assert.equal(calls[0].url.searchParams.get('size'), '60');

    await fetch(`${base}/api/bang/search?page=-3&size=0`);
    assert.equal(calls[1].url.searchParams.get('page'), '1');
    assert.equal(calls[1].url.searchParams.get('size'), '24');
});

test('the orientation flag is never sent, because sending it inverts it', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 0, size: 0 });
    await fetch(`${base}/api/bang/search?q=anything`);

    // Measured against the live API: `gay=true` and `gay=false` BOTH return
    // the same 9,888 gay-category results, and omitting it is the only way to
    // get the 164,595 straight ones. Sending `gay=false` to ask for straight
    // content returns the exact opposite of what it reads like.
    assert.equal(calls[0].url.searchParams.has('gay'), false);
});

test('a search term is forwarded, clipped, as their own parameter', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 0, size: 0 });

    await fetch(`${base}/api/bang/search?q=${encodeURIComponent('  lana rhoades  ')}`);
    assert.equal(calls[0].url.searchParams.get('term'), 'lana rhoades');

    await fetch(`${base}/api/bang/search?q=${encodeURIComponent('x'.repeat(500))}`);
    assert.equal(calls[1].url.searchParams.get('term').length, 64);
});

test('a scene id that is not an id costs no upstream call', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [], total: 0, size: 0 });

    const res = await fetch(`${base}/api/bang/scene/not-an-id`);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
});

test('a scene is looked up by the key their search will actually answer to', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [upstreamVideo()], total: 1, size: 1 });
    await fetch(`${base}/api/bang/scene/125768`);

    // `?id=` is in their spec and does not work - it answers 200 with an
    // error body and no result list, so the panel would have been empty for
    // every scene on the page. Only `?identifier=` resolves one.
    assert.equal(calls[0].url.searchParams.get('identifier'), '125768');
    assert.equal(calls[0].url.searchParams.has('id'), false);
});

test('a scene their search does not know is a 404 here', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    // Their search answers a miss with an empty list rather than a 404, so
    // the distinction has to be drawn on this side.
    stubUpstream({ results: [], total: 0, size: 0 });

    const res = await fetch(`${base}/api/bang/scene/125768`);
    assert.equal(res.status, 404);
});

test('one upstream call serves every visitor for the life of the cache', async (t) => {
    process.env.AVR_BANG_API_KEY = 'test-key';
    _resetBangCache();

    t.after(() => {
        delete process.env.AVR_BANG_API_KEY;
        globalThis.fetch = realFetch;
        _resetBangCache();
    });

    const calls = stubUpstream({ results: [upstreamVideo()], total: 1, size: 1 });

    await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/api/bang/shelf/most-watched`)));

    assert.equal(calls.length, 1, 'eight concurrent readers, one upstream request');
});
