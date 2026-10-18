import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Performer biographies: a paid API behind a public URL.
 *
 * The feature is a hover card, but the thing worth testing is the spending.
 * `/api/stars/:id/bio` is unauthenticated, and behind it is an OpenAI key that
 * bills per call, so the properties held here are the ones that stand between
 * that key and a stranger with a loop:
 *
 *   - only the ids AEBN is currently charting are answerable, and a request
 *     for anything else is refused *before* the provider is contacted;
 *   - nothing a caller sends reaches the prompt - the name written about comes
 *     from the feed, keyed by an integer the caller does not choose the text of;
 *   - an answer is bought once and then served from disk, including across a
 *     restart, and including when the answer was "I don't know this person";
 *   - a deployment with no key configured still serves the page - the card
 *     just does not appear - because that is every deployment by default.
 *
 * No test here reaches the network: `globalThis.fetch` is replaced before the
 * server is imported, so both the chart feed and the provider are local and
 * every call to either is counted.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-stars-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_SUPERUSER_EMAIL = '';
process.env.AVR_STAR_BIO_CACHE = path.join(TMP, 'star-bios.json');
process.env.AVR_OPENAI_KEY = 'sk-test-not-a-real-key';

/* ------------------------------------------------------------ the stubs -- */

const CHARTED_ID = 107821;
const CHARTED_NAME = 'A Charted Performer';
const DECLINED_ID = 222222;

/** Charted, but deliberately never asked for until the no-key test. */
const UNBOUGHT_ID = 333333;
const UNCHARTED_ID = 999999;

const feed = [
    {
        rankId: 1,
        starId: CHARTED_ID,
        starName: CHARTED_NAME,
        contentUrl: `/dispatcher/starDetail?starId=${CHARTED_ID}&genreId=101`,
        images: { headMedium: 'https://pic.aebn.net/m.jpg', headSmall: 'https://pic.aebn.net/s.jpg' }
    },
    {
        rankId: 2,
        starId: DECLINED_ID,
        starName: 'Somebody Obscure',
        contentUrl: `/dispatcher/starDetail?starId=${DECLINED_ID}&genreId=101`,
        images: { headMedium: 'https://pic.aebn.net/m2.jpg' }
    },
    {
        rankId: 3,
        starId: UNBOUGHT_ID,
        starName: 'Unbought Performer',
        contentUrl: `/dispatcher/starDetail?starId=${UNBOUGHT_ID}&genreId=101`,
        images: { headMedium: 'https://pic.aebn.net/m3.jpg' }
    }
];

/** Every provider call made in the process, so "was it bought?" is checkable. */
const openaiCalls = [];
let feedCalls = 0;

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);

    if (href.includes('aebntopstars')) {
        feedCalls += 1;
        return new Response(JSON.stringify(feed), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (href.startsWith('https://api.openai.com/')) {
        const body = JSON.parse(opts.body);
        openaiCalls.push({ body, auth: opts.headers?.Authorization });

        const asked = body.messages.at(-1).content;
        const answer = asked.includes(CHARTED_NAME)
            ? { known: true, bio: 'Began working in 2014.', highlights: ['Award winner, 2019'] }
            : { known: false };

        return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    }

    return realFetch(url, opts);
};

const { app } = await import('../server/index.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    globalThis.fetch = realFetch;
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

const get = (id) => fetch(`${base}/api/stars/${id}/bio`);

/* ------------------------------------------------------------- the tests -- */

test('a charted performer is written about once and cached thereafter', async () => {
    const before = openaiCalls.length;

    const first = await get(CHARTED_ID);
    assert.equal(first.status, 200);

    const bio = await first.json();
    assert.equal(bio.known, true);
    assert.equal(bio.name, CHARTED_NAME);
    assert.equal(bio.bio, 'Began working in 2014.');
    assert.deepEqual(bio.highlights, ['Award winner, 2019']);

    assert.equal(openaiCalls.length, before + 1, 'bought exactly once');

    const second = await get(CHARTED_ID);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), bio);

    assert.equal(openaiCalls.length, before + 1, 'the second hover is free');
});

test('the cache is on disk, so a redeploy does not re-buy the same paragraphs', async () => {
    await get(CHARTED_ID);

    const onDisk = JSON.parse(fs.readFileSync(process.env.AVR_STAR_BIO_CACHE, 'utf8'));
    assert.equal(onDisk[CHARTED_ID].bio, 'Began working in 2014.');
});

test('a star who is not on the chart is refused before any money is spent', async () => {
    const before = openaiCalls.length;

    const res = await get(UNCHARTED_ID);

    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'unknown_star');

    // The whole reason the allowlist exists. Without this assertion the route
    // is an open OpenAI endpoint and the bill is somebody else's to run up.
    assert.equal(openaiCalls.length, before, 'the provider was never contacted');
});

test('a star id that is not a positive integer is refused', async () => {
    const before = openaiCalls.length;

    for (const bad of ['abc', '-1', '0', '1.5', '1e3', '%20', 'NaN']) {
        const res = await fetch(`${base}/api/stars/${bad}/bio`);
        assert.ok(res.status === 400 || res.status === 404, `${bad} is refused (${res.status})`);
    }

    assert.equal(openaiCalls.length, before, 'none of them reached the provider');
});

test('nothing the caller sends reaches the prompt', async () => {
    const call = openaiCalls.at(-1);

    const sent = JSON.stringify(call.body.messages);
    assert.ok(sent.includes(CHARTED_NAME), 'the name comes from the chart feed');

    // The request carries an integer and a path, and neither is interpolated
    // into the prompt. If that ever changes this is prompt injection with a
    // billable key behind it.
    assert.ok(!sent.includes('starId'), 'no request parameter is echoed into the prompt');

    assert.equal(call.auth, 'Bearer sk-test-not-a-real-key', 'the key goes to OpenAI and nowhere else');
});

test('the model declining to invent somebody is itself cached', async () => {
    const first = await get(DECLINED_ID);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).known, false, 'a decline is reported, not filled in');

    const before = openaiCalls.length;
    await get(DECLINED_ID);

    // Being told "I don't know" repeatedly, at a penny a time, is the exact
    // failure mode an uncached decline produces.
    assert.equal(openaiCalls.length, before, 'it is not asked again');
});

test('the chart feed is read once and then held, not fetched per hover', async () => {
    const before = feedCalls;

    await get(CHARTED_ID);
    await get(DECLINED_ID);
    await get(UNCHARTED_ID);

    assert.equal(feedCalls, before, 'the allowlist is cached for an hour');
});

test('with no key configured the route declines instead of failing the page', async () => {
    const key = process.env.AVR_OPENAI_KEY;
    delete process.env.AVR_OPENAI_KEY;

    try {
        const before = openaiCalls.length;

        // `UNBOUGHT_ID` has been on the chart since the first request but has
        // never been asked for, so nothing is in the cache for it. That
        // matters: a cached answer is served whether or not a key is present,
        // which is correct behaviour and would hide this entirely.
        const res = await get(UNBOUGHT_ID);

        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, 'no_provider');
        assert.equal(openaiCalls.length, before, 'nothing was attempted');
    } finally {
        process.env.AVR_OPENAI_KEY = key;
    }
});
