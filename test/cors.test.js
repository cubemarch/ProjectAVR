import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CORS: who may read a response, and with whose cookies.
 *
 * The server used to answer every request by reflecting whatever `Origin`
 * arrived into `Access-Control-Allow-Origin` and sending
 * `Access-Control-Allow-Credentials: true` next to it. That pair is the one
 * configuration the specification treats as "any site on the internet may read
 * this visitor's private responses", and it was a permissive default from the
 * first commit rather than a decision anything depended on.
 *
 * Nothing in `src/` ever needed it. Every request the app makes is a relative
 * path, so it is same-origin and a browser does not apply CORS to it at all.
 * The clients that *are* cross-origin - DeoVR, Play'a, DLNA renderers, a CDN
 * edge in front of the HLS ladder - are either not browsers, and so never send
 * `Origin` nor enforce the answer, or are reading public bytes that carry no
 * cookie. Those two facts are what let the reflection go without replacing it
 * with anything.
 *
 * What is pinned here:
 *
 *   - an unrecognised origin is told nothing, on a request and on a preflight;
 *   - the configured origins are told yes, and nothing else is;
 *   - a credentialed answer carries `Vary: Origin`, because it depends on who
 *     asked and a shared cache that does not know that will serve one origin's
 *     approval to the next;
 *   - public media is open to everyone and never credentialed, which is the
 *     combination that is safe by construction rather than by configuration;
 *   - `X-AVR-Consent-Version` is not an allowed header, which is the mechanism
 *     behind the claim in docs/STATE-AGE-LAWS.md that another origin cannot
 *     mint an age pass by posting a photograph of an adult.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-cors-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_SUPERUSER_EMAIL = '';

// The two inputs under test. A developer's `.env` names a real address, so both
// are set here rather than inherited - otherwise this file would pass or fail
// on whatever machine it ran on.
const CANONICAL = 'https://lustxr.test';
const SECOND = 'https://www.lustxr.test';
const HOSTILE = 'https://evil.example';

process.env.AVR_PUBLIC_URL = CANONICAL;
process.env.AVR_CORS_ORIGINS = `${SECOND}, `;

const { app } = await import('../server/index.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * A preflight, which is the one response the middleware writes by itself.
 *
 * Going through `OPTIONS` keeps these assertions about the policy and not about
 * whichever route happens to sit at the path, which may 404 or ask for a token.
 *
 * @param {string} path
 * @param {string | null} origin
 * @param {{ method?: string, headers?: string }} [ask]
 */
async function preflight(path, origin, ask = {}) {
    const headers = { 'Access-Control-Request-Method': ask.method ?? 'GET' };

    if (origin) headers.Origin = origin;
    if (ask.headers) headers['Access-Control-Request-Headers'] = ask.headers;

    const res = await fetch(`${base}${path}`, { method: 'OPTIONS', headers });

    return res;
}

/** The allow-headers list, lowercased and split, or `[]` when absent. */
function allowed(res) {
    const raw = res.headers.get('access-control-allow-headers');
    if (!raw) return [];
    return raw.split(',').map((name) => name.trim().toLowerCase());
}

test('an unrecognised origin is told nothing at all', async () => {
    const res = await preflight('/api/health', HOSTILE);

    assert.equal(res.status, 204, 'the preflight is still answered');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'but with no permission in it');
    assert.equal(res.headers.get('access-control-allow-credentials'), null, 'and no credentials');

    // The regression itself: the old middleware echoed this back verbatim.
    assert.notEqual(res.headers.get('access-control-allow-origin'), HOSTILE);
});

test('an unrecognised origin is told nothing on a real request either', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: HOSTILE } });

    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('the canonical origin may read a credentialed response', async () => {
    const res = await preflight('/api/health', CANONICAL);

    assert.equal(res.headers.get('access-control-allow-origin'), CANONICAL, 'named, never starred');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('a second configured origin is allowed, and the list tolerates a stray comma', async () => {
    const res = await preflight('/api/health', SECOND);

    assert.equal(res.headers.get('access-control-allow-origin'), SECOND);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('a near miss on the configured origin is not a match', async () => {
    for (const origin of [
        'http://lustxr.test', // scheme
        'https://lustxr.test:8443', // port
        'https://lustxr.test.evil.example', // suffix
        'https://evil.example/lustxr.test' // path, which is not part of an origin
    ]) {
        const res = await preflight('/api/health', origin);
        assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
    }
});

test('a credentialed answer varies by origin, so a cache cannot cross-serve it', async () => {
    const res = await preflight('/api/health', CANONICAL);
    const vary = String(res.headers.get('vary') ?? '').toLowerCase();

    assert.match(vary, /\borigin\b/, 'the permission depends on who asked');

    // Including when the answer is no: the absence of the header is just as
    // origin-dependent as its presence, and just as wrong to reuse.
    const refused = await preflight('/api/health', HOSTILE);
    assert.match(String(refused.headers.get('vary') ?? '').toLowerCase(), /\borigin\b/);
});

test('public media is open to everyone and credentialed to nobody', async () => {
    const paths = [
        '/stream/anything.mp4',
        '/media/anything.mp4',
        '/playlist.m3u',
        '/deovr',
        '/live/hls/SESSION/master.m3u8',
        '/delivery/profiles.json',
        '/art/poster.png'
    ];

    for (const path of paths) {
        const res = await preflight(path, HOSTILE, { headers: 'range' });

        assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
        assert.equal(res.headers.get('access-control-allow-credentials'), null, `${path} sends no cookie`);
        assert.ok(allowed(res).includes('range'), `${path} can be read by byte range`);
    }
});

test('the open answer does not depend on asking from somewhere', async () => {
    // A native player sends no `Origin` header at all. It also does not enforce
    // the answer, but the header has to be unconditional for the CDN in front
    // of the HLS ladder to have something to cache.
    const res = await preflight('/live/hls/SESSION/master.m3u8', null);

    assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('a diagnostics route under a media prefix is not media', async () => {
    const res = await preflight('/live/transcode', HOSTILE);

    assert.equal(res.headers.get('access-control-allow-origin'), null, 'shares the prefix, not the policy');
});

test('the API does not accept the header the selfie route hides behind', async () => {
    // docs/STATE-AGE-LAWS.md: the consent version travels in a header so that
    // posting a photograph preflights, and the preflight is what stops another
    // origin minting an age pass. That only holds while the header is refused.
    for (const origin of [CANONICAL, HOSTILE]) {
        const res = await preflight('/api/identity/gate/verify/selfie', origin, {
            method: 'POST',
            headers: 'content-type, x-avr-consent-version'
        });

        assert.ok(!allowed(res).includes('x-avr-consent-version'), `not allowed from ${origin}`);
    }
});

test('the API does not advertise the media headers, and media does not advertise authorization', async () => {
    const api = allowed(await preflight('/api/health', CANONICAL));
    const media = allowed(await preflight('/media/anything.mp4', HOSTILE));

    assert.ok(!api.includes('range'), 'an API response is not a byte range');
    assert.ok(!api.includes('soapaction'), 'nor a SOAP call');
    assert.ok(!media.includes('authorization'), 'and public bytes take no bearer token');
});

test('the nosniff header survives both branches', async () => {
    for (const path of ['/api/health', '/media/anything.mp4']) {
        const res = await fetch(`${base}${path}`, { headers: { Origin: HOSTILE } });
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    }
});
