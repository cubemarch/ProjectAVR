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

/** One room as upstream actually sends it, with the field names they use. */
function upstreamRoom(over = {}) {
    return {
        username: 'examplecam',
        display_name: 'Example Cam',
        gender: 'f',
        room_status: 'public',
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

test('a room we would not show comes back as nothing', () => {
    const refused = {
        'a private show': { room_status: 'away' },
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

    assert.equal((await call('/api/cams?vr=1')).body.total, 1);
    assert.equal((await call('/api/cams?gender=m')).body.rooms[0].username, 'flatman');
    assert.equal((await call('/api/cams?gender=nonsense')).body.total, 0);
    assert.equal(calls.length, 1, 'a filter click cost an upstream request');

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
