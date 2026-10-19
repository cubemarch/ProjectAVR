import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The live cam row.
 *
 * Two halves, and the first is the one that matters. `normalise` is the only
 * thing standing between a third party's JSON and our page: every URL in a
 * card comes out of it, the VR selection that is the row's whole claim to
 * being curated is decided in it, and the broadcaster's own geo exclusions are
 * read in it. So it is tested against hostile input rather than a happy-path
 * fixture - a `javascript:` href, an embed snippet pointing somewhere else, a
 * room that is not public, a broadcaster under 18.
 *
 * The second half drives the route, with upstream stubbed, for the three
 * properties that are not visible from the pure functions: that an unconfigured
 * deployment renders nothing rather than erroring, that a visitor who has not
 * passed the age gate gets no rooms from the endpoint even though the gate
 * itself is drawn in the browser, and that the broadcaster's exclusions are
 * applied per request rather than baked into the shared cache.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-cams-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';
process.env.AVR_GEO_DEFAULT_REGION = '';
process.env.AVR_GEO_FALLBACK = '';
process.env.AVR_AGE_NON_US = '';

delete process.env.AVR_CHATURBATE_WM;

const { app } = await import('../server/index.js');
const { _internals, _resetCamsCache, _expireCamsCache } = await import('../server/routes/cams.js');
const { ATTESTATION_VERSION } = await import('../server/identity/jurisdiction.js');

const { normalise, visibleTo, rank, embedSrc, chaturbateUrl, codeSet } = _internals;

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
 * One room as upstream actually sends it, with the field names they use.
 *
 * Verified against a live `onlinerooms` response on 2026-10-19, which is a
 * thing worth doing again before trusting this: the shelf was empty in
 * production for a working affiliate code because this fixture said
 * `room_status` and upstream had started saying `current_show`, and a fixture
 * written from the same stale documentation as the code under test agrees
 * with it about everything including what is wrong.
 */
function upstreamRoom(over = {}) {
    return {
        username: 'examplecam',
        display_name: 'Example Cam',
        gender: 'f',
        current_show: 'public',
        room_subject: 'hello',
        age: 24,
        num_users: 120,
        is_hd: true,
        is_new: false,
        tags: ['vr', 'bigroom'],
        spoken_languages: ['english'],
        image_url_360x270: 'https://thumb.highwebmedia.com/riw/examplecam.jpg',
        image_url: 'https://thumb.highwebmedia.com/riw/examplecam.jpg',
        chat_room_url_revshare: 'https://chaturbate.com/in/?tour=x&campaign=y&track=default&room=examplecam',
        iframe_embed_revshare:
            '<iframe src="https://chaturbate.com/embed/examplecam/?tour=x&amp;campaign=y" ' +
            'width="800" height="600"></iframe>',
        block_from_states: '',
        block_from_countries: '',
        ...over
    };
}

/* --------------------------------------------------------------- normalising -- */

test('an ordinary room becomes a card', () => {
    const room = normalise(upstreamRoom());

    assert.equal(room.username, 'examplecam');
    assert.equal(room.name, 'Example Cam');
    assert.equal(room.vr, true);
    assert.equal(room.hd, true);
    assert.equal(room.viewers, 120);
    assert.equal(room.age, 24);
    assert.match(room.href, /^https:\/\/chaturbate\.com\//);
    assert.equal(room.embed, 'https://chaturbate.com/embed/examplecam/?tour=x&campaign=y');
});

test('the status field is read under either name upstream has used', () => {
    // The live field is `current_show`. `room_status` is what it was called
    // when this route was written, and is still accepted because the failure
    // it caused was silent in both directions: a feed that goes back to the
    // old name would empty the shelf again with nothing to show for it in a
    // log or a test run.
    const current = normalise(upstreamRoom({ current_show: 'public' }));
    assert.ok(current, 'the live field name is honoured');

    const legacy = normalise(upstreamRoom({ current_show: undefined, room_status: 'public' }));
    assert.ok(legacy, 'so is the name upstream used previously');

    // And the old name must not be able to re-open a room the live field has
    // already closed, or a feed sending both would show private shows.
    const conflict = normalise(upstreamRoom({ current_show: 'private', room_status: 'public' }));
    assert.equal(conflict, null, 'the live field wins where the two disagree');
});

test('a room we would not show comes back as nothing', () => {
    const refused = {
        'a private show': { current_show: 'private' },
        'an away broadcaster': { current_show: 'away' },
        'a hidden show': { current_show: 'hidden' },

        // Fails closed. A status field we cannot read is not evidence that a
        // show is public, and this is the case the rename actually produced.
        'a room with no status field at all': { current_show: undefined },
        'a broadcaster under 18': { age: 17 },
        'no username': { username: '' },
        'a username with a path in it': { username: '../admin' },
        'no thumbnail': { image_url_360x270: '', image_url: '' },
        'an http thumbnail': { image_url_360x270: 'http://thumb.example/x.jpg', image_url: '' },
        'no link': { chat_room_url_revshare: '' },
        'a link somewhere else': { chat_room_url_revshare: 'https://not-chaturbate.example/in/?room=x' },
        'a javascript link': { chat_room_url_revshare: 'javascript:alert(1)' },
        'a lookalike domain': { chat_room_url_revshare: 'https://chaturbate.com.evil.example/in/' }
    };

    for (const [why, over] of Object.entries(refused)) {
        assert.equal(normalise(upstreamRoom(over)), null, why);
    }

    assert.equal(normalise(null), null);
    assert.equal(normalise('a string'), null);
});

test('a room with an embed we will not frame still gets a card, without one', () => {
    // The link is what earns; the embed is the upgrade. Losing the second is
    // not a reason to drop the first.
    const elsewhere = normalise(
        upstreamRoom({ iframe_embed_revshare: '<iframe src="https://evil.example/embed/"></iframe>' })
    );

    assert.equal(elsewhere.embed, null);
    assert.match(elsewhere.href, /^https:\/\/chaturbate\.com\//);

    assert.equal(normalise(upstreamRoom({ iframe_embed_revshare: '<script>x()</script>' })).embed, null);
    assert.equal(normalise(upstreamRoom({ iframe_embed_revshare: '' })).embed, null);
});

test('the embed is read as a URL, not trusted as markup', () => {
    assert.equal(
        embedSrc('<iframe src="https://chaturbate.com/embed/a/?x=1&amp;y=2"></iframe>'),
        'https://chaturbate.com/embed/a/?x=1&y=2',
        'the HTML entity in the query string survived into the src'
    );

    assert.equal(embedSrc("<iframe src='https://chaturbate.com/embed/a/'></iframe>"), 'https://chaturbate.com/embed/a/');
    assert.equal(embedSrc('<iframe src="http://chaturbate.com/embed/a/"></iframe>'), null, 'http was framed');
    assert.equal(embedSrc('<iframe srcdoc="<p>hi</p>"></iframe>'), null);
    assert.equal(embedSrc(null), null);
    assert.equal(embedSrc(''), null);
});

test('only https on their own domain is ever put in the page', () => {
    assert.ok(chaturbateUrl('https://chaturbate.com/in/?room=a'));
    assert.ok(chaturbateUrl('https://www.chaturbate.com/in/?room=a'), 'their own subdomains are theirs');
    assert.equal(chaturbateUrl('https://chaturbate.com.evil.example/'), null);
    assert.equal(chaturbateUrl('https://notchaturbate.com/'), null);
    assert.equal(chaturbateUrl('http://chaturbate.com/'), null);
    assert.equal(chaturbateUrl('javascript:alert(1)'), null);
    assert.equal(chaturbateUrl('data:text/html,<script>x()</script>'), null);
    assert.equal(chaturbateUrl(''), null);
    assert.equal(chaturbateUrl(null), null);
});

/**
 * The white label is a search liability, and this is what keeps it off the
 * indexed page.
 *
 * `cams.lustxr.com` is a CNAME to `cname.whitelabel.chaturbate.com` — a full
 * Chaturbate storefront, byte-identical to the one thousands of other
 * affiliates serve, on a subdomain of a domain already carrying a Safe
 * Browsing listing under appeal. Linking it from the front page would hand
 * Google a discovery path straight into exactly the duplicate-content case
 * `docs/SEARCH.md` spends a section refusing.
 *
 * Today nothing links it, and the guard above is why: a white label lives on
 * *our* hostname, not theirs, so it fails the same check that stops a
 * lookalike domain. That is a side effect rather than a stated intention,
 * which is precisely the kind of protection that disappears in a refactor —
 * so it is pinned here as its own property, with its own reason.
 */
test('our own hostnames can never become a cam link, white label included', () => {
    assert.equal(chaturbateUrl('https://cams.lustxr.com/'), null);
    assert.equal(chaturbateUrl('https://cams.lustxr.com/somebody'), null);
    assert.equal(chaturbateUrl('https://lustxr.com/'), null);
    assert.equal(chaturbateUrl('https://www.lustxr.com/'), null);
    assert.equal(
        chaturbateUrl('https://cname.whitelabel.chaturbate.com/'),
        'https://cname.whitelabel.chaturbate.com/',
        'their own host stays allowed — the bound is on whose domain it is, not on the word'
    );
});

test('VR is decided by a closed list, so the row is curated and not mirrored', () => {
    const vrFrom = (tags) => normalise(upstreamRoom({ tags })).vr;

    assert.equal(vrFrom(['vr']), true);
    assert.equal(vrFrom(['VR180']), true, 'tags arrive in any case');
    assert.equal(vrFrom(['metaquest']), true);
    assert.equal(vrFrom(['3d']), true);

    // The reason the list is closed rather than a substring match.
    assert.equal(vrFrom(['vrchat']), false);
    assert.equal(vrFrom(['servername']), false);
    assert.equal(vrFrom(['3dayweek']), false);
    assert.equal(vrFrom([]), false);
    assert.equal(normalise(upstreamRoom({ tags: 'not an array' })).vr, false);
});

test('a broadcaster excluding a place is read as a set of codes', () => {
    assert.deepEqual([...codeSet('AL, ak ,AZ')], ['AL', 'AK', 'AZ']);
    assert.equal(codeSet(''), null);
    assert.equal(codeSet('   '), null);
    assert.equal(codeSet('not-codes'), null);
    assert.equal(codeSet(undefined), null);

    // Junk among the valid ones is dropped rather than poisoning the set.
    assert.deepEqual([...codeSet('TX,,nonsense,UT')], ['TX', 'UT']);
});

test("a visitor is not shown a room whose broadcaster excluded them", () => {
    const room = normalise(upstreamRoom({ block_from_states: 'TX,UT', block_from_countries: 'DE' }));

    assert.equal(visibleTo(room, { country: 'US', region: 'OR' }), true);
    assert.equal(visibleTo(room, { country: 'US', region: 'TX' }), false);
    assert.equal(visibleTo(room, { country: 'DE', region: null }), false);

    // A state code only means a state inside the US. `TX` is also a region
    // code elsewhere, and matching it against a Texan exclusion would hide
    // rooms from people the broadcaster never excluded.
    assert.equal(visibleTo(room, { country: 'CA', region: 'TX' }), true);

    // An unresolved region shows the room; Chaturbate enforce on the click.
    assert.equal(visibleTo(room, { country: null, region: null }), true);
});

test('the row is ordered VR first, then HD, then by audience', () => {
    const room = (over) => ({ vr: false, hd: false, viewers: 0, ...over });

    const sorted = [
        room({ viewers: 900 }),
        room({ vr: true, viewers: 2 }),
        room({ hd: true, viewers: 50 }),
        room({ vr: true, hd: true, viewers: 1 })
    ].sort(rank);

    assert.deepEqual(
        sorted.map((r) => r.viewers),
        [1, 2, 50, 900]
    );
});

/* ------------------------------------------------------------------- route -- */

/** Stand in for Chaturbate. Returns what the real endpoint's body looks like. */
function stubUpstream(results, { status = 200, fail = false } = {}) {
    const calls = [];

    globalThis.fetch = async (url, options) => {
        const href = String(url);

        if (!href.includes('chaturbate.com')) return realFetch(url, options);

        calls.push(new URL(href));

        if (fail) throw new Error('upstream unreachable');

        return new Response(JSON.stringify({ results, count: results.length }), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    return calls;
}

/** A browser that has already been through the age gate. */
async function gatedVisitor(region = 'OR') {
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

    await call('/api/identity/gate/attest', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, version: ATTESTATION_VERSION })
    });

    return call;
}

test('a deployment with no affiliate code draws no row, and does not call it an error', async () => {
    _resetCamsCache();
    delete process.env.AVR_CHATURBATE_WM;

    const call = await gatedVisitor();
    const res = await call('/api/cams');

    assert.equal(res.status, 200, 'an unconfigured row put a red line in the console');
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.rooms, []);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

test('a visitor who has not passed the age gate is given no rooms', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    const calls = stubUpstream([upstreamRoom()]);

    const res = await realFetch(`${base}/api/cams`, {
        headers: { 'x-geo-country': 'US', 'x-geo-region': 'TX' }
    });
    const body = await res.json();

    assert.equal(body.gated, true);
    assert.deepEqual(body.rooms, []);
    assert.equal(body.owes, 'verification');
    assert.match(res.headers.get('cache-control'), /no-store/);

    // And the endpoint did not even ask upstream on their behalf.
    assert.equal(calls.length, 0, 'a gated visitor caused a request for adult artwork');

    delete process.env.AVR_CHATURBATE_WM;
});

test('a gated visitor gets the row, and the affiliate code stays server-side', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    const calls = stubUpstream([
        upstreamRoom({ username: 'vrone', tags: ['vr'], num_users: 10 }),
        upstreamRoom({ username: 'plaintwo', tags: [], is_hd: false, num_users: 900 })
    ]);

    const call = await gatedVisitor();
    const res = await call('/api/cams');

    assert.equal(res.body.configured, true);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.vrTotal, 1);
    assert.equal(res.body.rooms[0].username, 'vrone', 'the row was not VR-first');

    // What upstream was asked, which is the part the browser must never do.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get('wm'), 'test-wm');
    assert.equal(calls[0].searchParams.get('client_ip'), 'request_ip');

    // And what came back carries none of it, nor the broadcaster's exclusion
    // lists, which are ours to apply and not the browser's to know.
    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /test-wm/, 'the affiliate code reached the browser');
    assert.doesNotMatch(serialised, /blockedStates|blockedCountries/);

    delete process.env.AVR_CHATURBATE_WM;
});

test('one upstream fetch serves every visitor, filtered per request', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    const calls = stubUpstream([
        upstreamRoom({ username: 'everywhere' }),
        upstreamRoom({ username: 'notintexas', block_from_states: 'TX' })
    ]);

    const oregon = await gatedVisitor('OR');
    const nevada = await gatedVisitor('NV');

    const first = await oregon('/api/cams');
    const second = await nevada('/api/cams');

    assert.equal(calls.length, 1, 'the shared list was fetched twice');
    assert.equal(first.body.total, 2);
    assert.equal(second.body.total, 2);

    // Not a Texan — Texas is in the twenty-seven, so a Texan cannot get past
    // the gate with a button and would be served the empty row above instead.
    // The per-request filter is asserted directly on `visibleTo` for that
    // reason; what this checks is that the cache is not the thing deciding.
    assert.match(first.headers.get('cache-control'), /private/);
    assert.doesNotMatch(first.headers.get('cache-control'), /public/);

    delete process.env.AVR_CHATURBATE_WM;
});

test('the filters cut the cached list rather than asking upstream again', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    const calls = stubUpstream([
        upstreamRoom({ username: 'vrwoman', tags: ['vr'], gender: 'f' }),
        upstreamRoom({ username: 'flatman', tags: [], gender: 'm' })
    ]);

    const call = await gatedVisitor();

    // `matched`, not `total`. The counts describe what this visitor could be
    // shown and so stay at two however the row is filtered, which is what
    // lets a caller size a control off them; `matched` is the filtered
    // figure. `?vr=1` has no control behind it today — the live feed has no
    // headset rooms — but it is route contract and a stubbed one matches.
    const vr = (await call('/api/cams?vr=1')).body;

    assert.equal(vr.matched, 1, 'one of the two is a headset room');
    assert.equal(vr.total, 2, 'but both are still on offer');
    assert.equal(vr.vrTotal, 1, 'and that count is pre-filter');

    assert.equal((await call('/api/cams?gender=m')).body.rooms[0].username, 'flatman');
    assert.equal((await call('/api/cams?gender=nonsense')).body.matched, 0);
    assert.equal(calls.length, 1, 'every filter cut the one cached list');

    delete process.env.AVR_CHATURBATE_WM;
});

test('a query narrows the row without narrowing what the row says it has', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([
        upstreamRoom({ username: 'ada', display_name: 'Ada', tags: ['blonde', 'vr'] }),
        upstreamRoom({ username: 'bea', display_name: 'Bea', tags: ['blonde'] }),
        upstreamRoom({ username: 'cyd', display_name: 'Cyd', tags: ['brunette'] })
    ]);

    const call = await gatedVisitor();
    const names = (body) => body.rooms.map((r) => r.username).sort();

    const blonde = (await call('/api/cams?q=blonde')).body;

    assert.deepEqual(names(blonde), ['ada', 'bea']);
    assert.equal(blonde.matched, 2, 'two matched');
    assert.equal(blonde.total, 3, 'out of three on offer');
    assert.equal(blonde.vrTotal, 1, 'and the VR count ignores the box entirely');

    // Every word, not any word: the second term narrows.
    assert.deepEqual(names((await call('/api/cams?q=blonde%20vr')).body), ['ada']);

    // Substring, so a half-typed word still finds the tag.
    assert.deepEqual(names((await call('/api/cams?q=blon')).body), ['ada', 'bea']);

    // The box and the buttons compose rather than replacing each other.
    assert.deepEqual(names((await call('/api/cams?q=blonde&vr=1')).body), ['ada']);

    delete process.env.AVR_CHATURBATE_WM;
});

test('a query reaches every field printed on the card, and nothing behind it', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([
        upstreamRoom({ username: 'byhandle' }),
        upstreamRoom({ username: 'r2', display_name: 'ByName' }),
        upstreamRoom({ username: 'r3', room_subject: 'playing BySubject tonight' }),
        upstreamRoom({ username: 'r4', tags: ['bytag'] }),
        upstreamRoom({ username: 'r5', spoken_languages: ['bylanguage'] })
    ]);

    const call = await gatedVisitor();
    const one = async (q) => (await call(`/api/cams?q=${q}`)).body;

    for (const [q, who] of [
        ['byhandle', 'byhandle'],
        ['byname', 'r2'],
        ['bysubject', 'r3'],
        ['bytag', 'r4'],
        ['bylanguage', 'r5']
    ]) {
        const body = await one(q);

        assert.equal(body.matched, 1, `"${q}" matched something other than one room`);
        assert.equal(body.rooms[0].username, who, `"${q}" found the wrong room`);
    }

    // Case folds both ways round: the query is lowercased and so is the
    // haystack, so a capitalised display name is found by a typed one.
    assert.equal((await one('BYNAME')).rooms[0].username, 'r2');

    // The revshare link has our affiliate code and the partner's hostname in
    // it. If `href` were searchable, this would match all five.
    assert.equal((await one('chaturbate')).matched, 0, 'the outbound URL is not a haystack');

    // Nor does the field the match is made against travel to the browser.
    assert.equal((await one('byname')).rooms[0].search, undefined);

    delete process.env.AVR_CHATURBATE_WM;
});

test('a pasted paragraph is truncated rather than run', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([upstreamRoom({ username: 'ada', tags: ['blonde'] })]);

    const call = await gatedVisitor();

    // Seven words. The seventh is nonsense and would exclude the room if the
    // cap were not applied, so this fails loudly if `QUERY_TERMS` stops
    // biting rather than silently doing more work than intended.
    const seven = 'blonde blonde blonde blonde blonde blonde zzzznope';

    assert.equal((await call(`/api/cams?q=${encodeURIComponent(seven)}`)).body.matched, 1);

    // Same for the character cap: padding past 64 pushes the nonsense out.
    const long = `${'blonde '.repeat(9)}zzzznope`;

    assert.ok(long.length > 64, 'the fixture has to exceed the cap to test it');
    assert.equal((await call(`/api/cams?q=${encodeURIComponent(long)}`)).body.matched, 1);

    // A repeated-group pattern, which is the shape that hangs a backtracking
    // engine. It is a literal substring here, so it simply matches nothing.
    const evil = `${'a+'.repeat(20)}!`;

    assert.equal((await call(`/api/cams?q=${encodeURIComponent(evil)}`)).body.matched, 0);

    // Whitespace-only is not a filter, and neither is a missing one.
    assert.equal((await call('/api/cams?q=%20%20')).body.matched, 1);
    assert.equal((await call('/api/cams?q=')).body.matched, 1);

    // A repeated `?q=` arrives as an array, which has no `.slice(0, 64)` that
    // means what this wants. It must narrow to nothing rather than throw.
    assert.equal((await call('/api/cams?q=blonde&q=blonde')).status, 200);

    delete process.env.AVR_CHATURBATE_WM;
});

test('a suggestion never promises more rooms than picking it returns', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([
        upstreamRoom({ username: 'ada', tags: ['blonde', 'vr'] }),
        upstreamRoom({ username: 'bea', tags: ['blonde'] }),
        upstreamRoom({ username: 'cyd', tags: ['blonde', 'solo'] }),
        upstreamRoom({ username: 'dot', tags: ['solo'] }),
        upstreamRoom({ username: 'eve', tags: ['lonely'] }),

        // Says the word, does not carry the tag. The facet counts tags and
        // the query reads the subject too, so this room is in one and not
        // the other — which is the whole point of the floor below.
        upstreamRoom({ username: 'fay', tags: [], room_subject: 'blonde today' })
    ]);

    const call = await gatedVisitor();
    const facet = (body) => Object.fromEntries(body.tags.map((t) => [t.tag, t.count]));

    const all = facet((await call('/api/cams')).body);

    assert.equal(all.blonde, 3);
    assert.equal(all.solo, 2);
    assert.equal(all.lonely, undefined, 'a tag on one room is not worth suggesting');
    assert.equal(all.vr, undefined, 'nor is the tag that only marks the room as VR');

    // Commonest first, so a list cut to eight rows is cut at the useful end.
    assert.deepEqual(
        (await call('/api/cams')).body.tags.map((t) => t.tag),
        ['blonde', 'solo']
    );

    // Narrowed by `?vr=1`, only one room is in scope — so no tag clears the
    // floor, and the list is empty rather than full of dead ends.
    assert.deepEqual((await call('/api/cams?vr=1')).body.tags, []);

    // The box does not move it. Suggestions that reshuffled per keystroke
    // would move the row the visitor is reaching for.
    const picked = (await call('/api/cams?q=blonde')).body;

    assert.deepEqual(facet(picked), all);

    // And the direction of the gap. A suggestion reading "blonde 3" that
    // returns four rooms is a pleasant surprise; one that returns two is the
    // search looking broken, and only one of those is reachable from here.
    assert.ok(
        picked.matched >= all.blonde,
        `picking a suggestion returned ${picked.matched}, which must not be under the ${all.blonde} it promised`
    );
    assert.equal(picked.matched, 4, 'the room that only says the word is found too');

    delete process.env.AVR_CHATURBATE_WM;
});

test('an upstream blip serves the last good list rather than emptying the row', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([upstreamRoom({ username: 'stillhere' })]);

    const call = await gatedVisitor();
    assert.equal((await call('/api/cams')).body.rooms[0].username, 'stillhere');

    // Age the cache out but keep what it last held, which is the state a real
    // deployment is in when the TTL lapses during an outage.
    _expireCamsCache();
    stubUpstream([], { fail: true });

    const stale = await call('/api/cams');

    assert.equal(stale.status, 200, 'a partner outage took the page down with it');
    assert.equal(stale.body.rooms[0].username, 'stillhere');

    delete process.env.AVR_CHATURBATE_WM;
});

test('an outage with nothing cached is a 502, not an empty row pretending to be a quiet night', async () => {
    _resetCamsCache();
    process.env.AVR_CHATURBATE_WM = 'test-wm';

    stubUpstream([], { fail: true });

    const call = await gatedVisitor();
    const res = await call('/api/cams');

    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'upstream_failed');

    _resetCamsCache();
    delete process.env.AVR_CHATURBATE_WM;
});
