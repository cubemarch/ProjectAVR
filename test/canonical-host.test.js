import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * `www` is not a second site.
 *
 * Both names resolve to this server and the proxy serves them from one block,
 * so for as long as there was no redirect there were two live addresses for
 * every page. Google indexed them separately and divided the ranking signals
 * between them, which is a self-inflicted wound that gets more expensive to
 * undo the longer each half accumulates history. The pages already declare the
 * apex canonical, but that is a hint a search engine may overrule; a 301 is
 * not.
 *
 * What is pinned here:
 *
 *   - `www.<canonical>` is sent to the apex, permanently, with the path and
 *     query carried across untouched;
 *   - the apex itself, and any host that is not `www.<canonical>`, is left
 *     alone - a redirect that fires on the wrong host is a redirect loop;
 *   - only `GET` and `HEAD` move, because much of the world re-sends a 301'd
 *     `POST` as a `GET` and drops the body with it;
 *   - an upgrade request never moves, because the live ingest in docs/LIVE.md
 *     is a WebSocket through this same proxy and a socket client is under no
 *     obligation to follow a redirect mid-handshake;
 *   - with no `AVR_PUBLIC_URL` there is no canonical address, and the
 *     behaviour is to do nothing rather than to guess one.
 *
 * The redirect is also asserted to happen on a path that would otherwise 404,
 * which is what shows it runs ahead of routing rather than inside it.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-canonical-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_SUPERUSER_EMAIL = '';

// A developer's `.env` names a real address, so this is set here rather than
// inherited - otherwise the file would pass or fail on whichever machine ran
// it. `.test` cannot be registered, so nothing here can reach the network.
const CANONICAL = 'https://lustxr.test';

process.env.AVR_PUBLIC_URL = CANONICAL;

const { app } = await import('../server/index.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const PORT = server.address().port;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * One request with an arbitrary `Host`, without following the answer.
 *
 * `node:http` rather than `fetch`, because the whole point is to control the
 * `Host` header and that is exactly the header a fetch implementation reserves
 * to itself.
 *
 * @param {string} host
 * @param {string} target
 * @param {{ method?: string, headers?: Record<string, string> }} [opts]
 * @returns {Promise<{ status: number, location: string | undefined }>}
 */
function request(host, target, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: PORT,
                path: target,
                method: opts.method ?? 'GET',
                headers: { Host: host, ...(opts.headers ?? {}) }
            },
            (res) => {
                res.resume();
                res.once('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
            }
        );

        req.once('error', reject);
        req.end();
    });
}

test('www is sent to the apex, permanently', async () => {
    const res = await request('www.lustxr.test', '/');

    assert.equal(res.status, 301);
    assert.equal(res.location, 'https://lustxr.test/');
});

test('the path and query survive the move', async () => {
    const res = await request('www.lustxr.test', '/terms?from=sitemap&x=1%202');

    assert.equal(res.status, 301);
    assert.equal(res.location, 'https://lustxr.test/terms?from=sitemap&x=1%202');
});

test('a path that does not exist still redirects, so this runs before routing', async () => {
    const res = await request('www.lustxr.test', '/nothing-is-here');

    assert.equal(res.status, 301);
    assert.equal(res.location, 'https://lustxr.test/nothing-is-here');
});

test('HEAD moves too, because a crawler asks with it', async () => {
    const res = await request('www.lustxr.test', '/', { method: 'HEAD' });

    assert.equal(res.status, 301);
    assert.equal(res.location, 'https://lustxr.test/');
});

test('the apex is left alone, which is what keeps this from looping', async () => {
    const res = await request('lustxr.test', '/');

    assert.notEqual(res.status, 301);
    assert.equal(res.location, undefined);
});

test('a host that is not www.<canonical> is left alone', async () => {
    for (const host of ['evil.example', 'www.evil.example', 'lustxr.test.evil.example', '127.0.0.1']) {
        const res = await request(host, '/');

        assert.notEqual(res.status, 301, `${host} should not have been redirected`);
    }
});

test('POST is not redirected, because a 301 would drop the body', async () => {
    const res = await request('www.lustxr.test', '/api/health', { method: 'POST' });

    assert.notEqual(res.status, 301);
    assert.equal(res.location, undefined);
});

test('public media is not redirected, because its clients are not browsers', async () => {
    // A DLNA renderer, a DeoVR shell or a CDN edge pulling HLS is entitled to
    // handle a 301 on a ranged read badly, and none of these are pages a
    // search engine would rank, so there is nothing to consolidate either.
    for (const target of [
        '/playlist.m3u',
        '/stream/anything',
        '/media/x.mp4',
        '/art/mark.png',
        '/dlna/control',
        '/deovr/u',
        '/delivery/profiles.json',
        '/live/hls/index.m3u8'
    ]) {
        const res = await request('www.lustxr.test', target);

        assert.notEqual(res.status, 301, `${target} should not have been redirected`);
    }
});

test('a path that merely starts like public media still redirects', async () => {
    // `/live/transcode` is diagnostics, not media, and the regex draws that
    // line already - this pins that the redirect reads the same line.
    const res = await request('www.lustxr.test', '/live/transcode');

    assert.equal(res.status, 301);
    assert.equal(res.location, 'https://lustxr.test/live/transcode');
});

test('an upgrade request is not redirected', async () => {
    // Only `Upgrade`, without `Connection: Upgrade` - with both, Node routes
    // the socket to its own `upgrade` event and Express never sees it at all,
    // which would pass this test without testing anything.
    const res = await request('www.lustxr.test', '/', { headers: { Upgrade: 'websocket' } });

    assert.notEqual(res.status, 301);
    assert.equal(res.location, undefined);
});

test('no canonical address configured means no redirect', async () => {
    // Also covers the cache: the parse is keyed on the raw string, so a change
    // here must take effect on the very next request. If this passes while the
    // first test also passes, the value is not frozen at import.
    delete process.env.AVR_PUBLIC_URL;

    try {
        const res = await request('www.lustxr.test', '/');

        assert.notEqual(res.status, 301);
        assert.equal(res.location, undefined);
    } finally {
        process.env.AVR_PUBLIC_URL = CANONICAL;
    }

    const after = await request('www.lustxr.test', '/');
    assert.equal(after.status, 301, 'restoring the variable should restore the redirect');
});

test('a malformed canonical address disables the redirect rather than throwing', async () => {
    process.env.AVR_PUBLIC_URL = 'not-a-url';

    try {
        const res = await request('www.lustxr.test', '/');

        assert.notEqual(res.status, 500);
        assert.notEqual(res.status, 301);
    } finally {
        process.env.AVR_PUBLIC_URL = CANONICAL;
    }
});
