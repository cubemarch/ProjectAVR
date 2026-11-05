import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Covering partner artwork for a visitor who has not verified.
 *
 * Almost every case here is a failure case, and that is the shape of the
 * feature rather than an accident of testing. The happy path — a working
 * inference service covers an image and the card shows it — is one assertion.
 * The thing worth a test suite is the claim in `docs/CENSOR.md` that **no
 * path through this code answers with the original image**, because that
 * claim is only as good as its least-exercised branch, and the branch that
 * will actually be hit in production is the one where the service is down.
 *
 * So: an unset endpoint, a dead endpoint, a 500, a timeout, an empty body, a
 * non-image, an unknown room. Each one has to produce either a covered image
 * or nothing, and never a partner URL.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-censor-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';

delete process.env.AVR_CENSOR_ENDPOINT;
delete process.env.AVR_CENSOR_TOKEN;

const censorModule = await import('../server/media/censor.js');
const { censor, isConfigured, PLACEHOLDER, _internals } = censorModule;

const realFetch = globalThis.fetch;

/** Put the module back the way each test found it. */
function reset() {
    delete process.env.AVR_CENSOR_ENDPOINT;
    delete process.env.AVR_CENSOR_TOKEN;
    _internals.cache.clear();
    globalThis.fetch = realFetch;
}

function configure() {
    process.env.AVR_CENSOR_ENDPOINT = 'https://censor.example';
    process.env.AVR_CENSOR_TOKEN = 'test-token';
}

/** A fetch that answers the partner CDN and the service with whatever is given. */
function stub({ image, scan }) {
    const calls = [];

    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });

        if (String(url).includes('censor.example')) return scan();

        return image();
    };

    return calls;
}

/**
 * Bytes that begin like a JPEG.
 *
 * They have to. The client reads the magic number and discards the declared
 * content type, so a fixture that says `image/jpeg` over the body
 * `not-really-a-jpeg` — which is what this was — is now refused, correctly.
 * Nothing here decodes the image, so three bytes of truth are enough.
 */
const jpegBytes = (tail = 'body') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(tail)]);

const okImage = () =>
    new Response(jpegBytes(), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' }
    });

const okScan = () =>
    new Response(Buffer.from('covered-jpeg-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'X-Censor-Boxes': '1' }
    });

/* ------------------------------------------------------------- the client -- */

test('an unconfigured deployment censors nothing and admits it', async () => {
    reset();

    assert.equal(isConfigured(), false, 'not configured');
    assert.equal(await censor('https://cdn.example/a.jpg'), null, 'and returns nothing');
});

test('half-configured is not configured', async () => {
    reset();
    process.env.AVR_CENSOR_ENDPOINT = 'https://censor.example';

    assert.equal(isConfigured(), false, 'an endpoint without a token is not usable');
    assert.equal(await censor('https://cdn.example/a.jpg'), null);

    reset();
    process.env.AVR_CENSOR_TOKEN = 'test-token';

    assert.equal(isConfigured(), false, 'nor a token without an endpoint');
});

test('the covered image comes back, and the token goes with the request', async () => {
    reset();
    configure();

    const calls = stub({ image: okImage, scan: okScan });
    const out = await censor('https://cdn.example/a.jpg');

    assert.ok(Buffer.isBuffer(out), 'a buffer');
    assert.equal(out.toString(), 'covered-jpeg-bytes', 'and it is the service’s output');

    const scan = calls.find((c) => c.url.includes('censor.example'));
    assert.ok(scan, 'the service was called');
    assert.equal(scan.options.headers['X-Censor-Token'], 'test-token', 'authenticated');
    assert.equal(scan.options.method, 'POST');
    assert.ok(scan.url.endsWith('/scan'), `posted to /scan, got ${scan.url}`);
});

test('the original is never the answer, however the service fails', async () => {
    const failures = {
        unreachable: () => {
            throw new Error('ECONNREFUSED');
        },
        'a 500': () => new Response('boom', { status: 500 }),
        'a 401': () => new Response('no', { status: 401 }),
        'an empty 200': () => new Response(Buffer.alloc(0), { status: 200 })
    };

    for (const [name, scan] of Object.entries(failures)) {
        reset();
        configure();
        stub({ image: okImage, scan });

        const out = await censor('https://cdn.example/a.jpg');

        assert.equal(out, null, `${name} returns nothing`);
    }
});

test('an upstream that is not an image is refused before the service sees it', async () => {
    reset();
    configure();

    const calls = stub({
        image: () => new Response('<html>404</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
        scan: okScan
    });

    assert.equal(await censor('https://cdn.example/a.jpg'), null, 'nothing comes back');
    assert.equal(
        calls.filter((c) => c.url.includes('censor.example')).length,
        0,
        'and the service was not asked to scan a web page'
    );
});

test('a partner that mislabels a real JPEG still gets it covered', async () => {
    reset();
    configure();

    // This is not hypothetical. Bang serves boxcovers from `i.bang.com` and
    // labels 31 of the 51 on the three shelves `application/octet-stream`;
    // all 51 are the same Exif-prefixed JPEG. Trusting the header blanked
    // three fifths of the catalogue — fail-closed, so nothing leaked, but a
    // visitor saw "Verify your age to view" on most of the page.
    const calls = stub({
        image: () =>
            new Response(jpegBytes(), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
            }),
        scan: okScan
    });

    const out = await censor('https://i.bang.com/covers/13510/front.jpg');

    assert.equal(out?.toString(), 'covered-jpeg-bytes', 'the cover came back covered');

    const scan = calls.find((c) => c.url.includes('censor.example'));
    assert.equal(
        scan.options.headers['Content-Type'],
        'image/jpeg',
        'and the service was told what the bytes are, not what the partner claimed'
    );
});

test('a header saying image over bytes that are not is refused', async () => {
    reset();
    configure();

    // The other half of reading the magic number, and the reason it is a
    // sniff rather than a special case for `octet-stream`: a partner CDN
    // answering a login page with `200 image/jpeg` used to have those bytes
    // forwarded to the decoder.
    const calls = stub({
        image: () =>
            new Response(Buffer.from('<html>login</html>'), {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg' }
            }),
        scan: okScan
    });

    assert.equal(await censor('https://cdn.example/a.jpg'), null, 'nothing comes back');
    assert.equal(
        calls.filter((c) => c.url.includes('censor.example')).length,
        0,
        'and the service never saw it'
    );
});

test('an upstream 404 does not become an image', async () => {
    reset();
    configure();
    stub({ image: () => new Response('gone', { status: 404 }), scan: okScan });

    assert.equal(await censor('https://cdn.example/a.jpg'), null);
});

test('one scan serves a burst, and a failure is not cached', async () => {
    reset();
    configure();

    let scans = 0;
    const calls = stub({
        image: okImage,
        scan: () => {
            scans += 1;
            return okScan();
        }
    });

    // The thing that makes this affordable: sixty cards refreshing on the
    // same second is one upstream fetch and one scan, not sixty.
    const burst = await Promise.all(
        Array.from({ length: 20 }, () => censor('https://cdn.example/same.jpg'))
    );

    assert.equal(scans, 1, 'one scan for twenty concurrent callers');
    assert.ok(
        burst.every((b) => b?.toString() === 'covered-jpeg-bytes'),
        'and they all got the image'
    );

    // A rejection must not be held for the TTL, or one blip blanks the row.
    reset();
    configure();

    let attempt = 0;
    stub({
        image: okImage,
        scan: () => {
            attempt += 1;
            return attempt === 1 ? new Response('boom', { status: 500 }) : okScan();
        }
    });

    assert.equal(await censor('https://cdn.example/b.jpg'), null, 'first fails');
    assert.ok(await censor('https://cdn.example/b.jpg'), 'and the next one is tried, not served the failure');
    assert.equal(calls.length >= 0, true);
});

test('the cache is bounded, because rooms go off air and never come back', async () => {
    reset();
    configure();
    stub({ image: okImage, scan: okScan });

    for (let i = 0; i < _internals.MAX_ENTRIES + 50; i += 1) {
        await censor(`https://cdn.example/${i}.jpg`);
    }

    assert.ok(
        _internals.cache.size <= _internals.MAX_ENTRIES,
        `held ${_internals.cache.size}, cap is ${_internals.MAX_ENTRIES}`
    );
});

test('the placeholder says what is wrong rather than looking broken', () => {
    const svg = PLACEHOLDER.toString();

    assert.match(svg, /^<svg/, 'it is an SVG, so it needs no image library');
    assert.match(svg, /Verify your age/i, 'and it explains itself');

    // Nothing here may *load*. Checking for `http` would be the obvious
    // assertion and the wrong one: `xmlns="http://www.w3.org/2000/svg"` is a
    // namespace name, not an address, and nothing fetches it. What would
    // actually leak a request is a reference, so that is what is asserted.
    assert.doesNotMatch(svg, /\b(?:xlink:href|href|src)\s*=/i, 'it references nothing');
    assert.doesNotMatch(svg, /url\(\s*['"]?[a-z]+:/i, 'and loads no remote paint');
    assert.doesNotMatch(svg, /<(?:image|script|foreignObject|use)\b/i, 'and pulls in nothing');
});

/* -------------------------------------------------------------- the route -- */

const { app } = await import('../server/index.js');
const { _internals: cams, _resetCamsCache } = await import('../server/routes/cams.js');

const { present } = cams;
const server = app.listen(0);

test('a covered room loses its embed and its partner URL', () => {
    const room = {
        username: 'someone',
        thumb: 'https://thumb.live.mmcdn.com/ri/someone.jpg',
        href: 'https://chaturbate.com/in/?track=x&room=someone',
        embed: 'https://chaturbate.com/embed/someone/?track=x'
    };

    const open = present(room, false);

    assert.equal(open.thumb, room.thumb, 'uncovered, nothing changes');
    assert.equal(open.embed, room.embed);

    const shut = present(room, true);

    assert.equal(shut.thumb, '/api/cams/thumb/someone', 'covered, the thumb is ours');
    assert.doesNotMatch(JSON.stringify(shut), /mmcdn/, 'and the CDN URL is not in the payload at all');

    // The one that would quietly undo everything else: the embed is a live,
    // uncovered broadcast inside our own page.
    assert.equal(shut.embed, null, 'the white-label player is withheld');

    // But the outbound link stays. It leaves for a site that runs its own
    // check, and it is the only thing on the card that earns anything.
    assert.equal(shut.href, room.href, 'the outbound link survives');
});

test('a username with a slash in it cannot escape the proxy path', () => {
    const out = present({ username: '../../etc/passwd', thumb: 'x', href: 'y', embed: 'z' }, true);

    assert.equal(out.thumb, '/api/cams/thumb/..%2F..%2Fetc%2Fpasswd');
    assert.doesNotMatch(out.thumb, /\/\.\.\//, 'no traversal survives into the path');
});

test('with no censor configured, the cam row is withheld rather than shown', async () => {
    reset();
    _resetCamsCache();

    process.env.AVR_CHATURBATE_WM = 'test-wm';

    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cams`);
    const body = await res.json();

    // No gate cookie on this request, so the visitor is unverified. The
    // censor is unconfigured, so there is no covered version to show. The
    // answer has to be the old one.
    assert.equal(body.gated, true, 'gated');
    assert.deepEqual(body.rooms, [], 'and empty — not the uncovered row');

    delete process.env.AVR_CHATURBATE_WM;
});

test('the thumbnail proxy serves a placeholder for a room it does not know', async () => {
    reset();
    _resetCamsCache();

    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cams/thumb/nobody`);

    assert.equal(res.status, 200, 'not an error — a card wants an image');
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);

    const body = await res.text();
    assert.match(body, /Verify your age/i);
});

test('the thumbnail proxy takes a username, never a URL', async () => {
    // The route that does not exist is the point. A `?url=` proxy over a
    // validator that pins only the scheme would fetch anything it was handed,
    // including the instance metadata endpoint.
    const res = await fetch(
        `http://127.0.0.1:${server.address().port}` +
            `/api/cams/thumb?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`
    );

    assert.equal(res.status, 404, 'there is no URL-taking form of this route');
});

/* -------------------------------------------------------- house banners -- */

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (buf) => PNG.every((b, i) => buf[i] === b);

test('a house banner is the covered copy or the placeholder, never the file as shipped', async () => {
    // Unconfigured first: the one state where returning the PNG would be the
    // easy thing to do, and the one this route must answer with the
    // placeholder instead.
    reset();
    let res = await realFetch(`http://127.0.0.1:${server.address().port}/api/house/slr-premium`);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.ok(!isPng(Buffer.from(await res.arrayBuffer())), 'the original went out uncovered');

    reset();
    configure();
    const calls = stub({ image: okImage, scan: okScan });

    res = await realFetch(`http://127.0.0.1:${server.address().port}/api/house/slr-premium`);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'covered-jpeg-bytes');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);

    // The service was handed the banner itself, and nothing was fetched from
    // anywhere else to get it.
    const scans = calls.filter((c) => c.url.includes('censor.example'));
    assert.equal(scans.length, 1);
    assert.equal(calls.length, 1, 'a house banner is read from disk, not fetched');
});

test('a house banner id the list does not have is the placeholder', async () => {
    reset();
    configure();
    stub({ image: okImage, scan: okScan });

    for (const id of ['nope', '__proto__', 'constructor', '..%2F..%2Fpackage.json']) {
        const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/house/${id}`);
        assert.equal(res.headers.get('content-type'), 'image/svg+xml', id);
    }
});

test.after(() => {
    reset();
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});
