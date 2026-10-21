import test from 'node:test';
import assert from 'node:assert/strict';

import { allowedImage, signedMediaUrl, verifyMediaUrl, _internals } from '../server/media/proxy.js';

/**
 * The signature on a censoring image proxy.
 *
 * The cam thumbnail route is safe from request forgery structurally — it takes
 * a room name, so the only URLs it can fetch are ones that arrived in a feed
 * we hold. This module is what replaces that property for a catalogue too
 * large to hold, and the property it replaces it with is cryptographic rather
 * than structural. So the cases that matter are the ones about forgery, not
 * the ones about round-tripping.
 *
 * `AVR_JWT_SECRET` is deliberately not set here. The key then comes from
 * `randomBytes` once per process, which is the harder case to pass: a bug that
 * made the key constant or empty would still round-trip and would still be a
 * universal forgery.
 */

const OK = 'https://i.bang.com/covers/abc.jpg';

test('a URL this server minted comes back, byte for byte', () => {
    const signed = signedMediaUrl(OK);

    assert.ok(signed.startsWith('/api/media?'), 'root-relative, so it works on any hostname');

    const { searchParams } = new URL(signed, 'https://example.test');

    assert.equal(verifyMediaUrl(searchParams.get('u'), searchParams.get('s')), OK);
});

test('a URL nobody signed is refused', () => {
    const { searchParams } = new URL(signedMediaUrl(OK), 'https://example.test');
    const u = searchParams.get('u');

    assert.equal(verifyMediaUrl(u, ''), null, 'no signature');
    assert.equal(verifyMediaUrl(u, 'AAAAAAAAAAAAAAAAAAAAAA'), null, 'a signature of the right length');
    assert.equal(verifyMediaUrl(u, 'short'), null, 'and one of the wrong length');
    assert.equal(verifyMediaUrl(u, null), null, 'and none at all');
    assert.equal(verifyMediaUrl(undefined, undefined), null, 'and neither half');
});

test('the signature is over the URL, so swapping the URL breaks it', () => {
    // The forgery that matters. An attacker who has a valid pair from any page
    // on the site holds a signature; the question is whether they can move it
    // onto a URL of their own. This is the whole security property.
    const a = new URL(signedMediaUrl(OK), 'https://example.test').searchParams;
    const b = new URL(
        signedMediaUrl('https://i.bang.com/covers/other.jpg'),
        'https://example.test'
    ).searchParams;

    assert.notEqual(a.get('s'), b.get('s'), 'two URLs signed to the same value');
    assert.equal(verifyMediaUrl(a.get('u'), b.get('s')), null, 'a signature moved between URLs');
    assert.equal(verifyMediaUrl(b.get('u'), a.get('s')), null, 'and in the other direction');
});

test('nothing off a partner host is signed, whatever it is asked to sign', () => {
    // The second bound, and the reason it exists: if the key ever leaks, this
    // is the difference between an attacker making us censor arbitrary
    // pictures and an attacker reading the instance metadata endpoint. These
    // are the addresses a request-forgery hole is actually worth having.
    const refused = [
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'https://169.254.169.254/latest/meta-data/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://localhost:8080/admin',
        'http://127.0.0.1/',
        'http://[::1]/',
        'https://10.0.0.1/',
        'file:///etc/passwd',
        'gopher://127.0.0.1:25/',
        'https://evil.test/x.jpg',

        // The shapes an allowlist written with `includes` gets wrong.
        'https://i.bang.com.evil.test/x.jpg',
        'https://evil-i.bang.com/x.jpg',
        'https://i.bang.com@evil.test/x.jpg',

        // Right host, wrong scheme. The proxy fetches server-side, so a plain
        // http hop is one an on-path attacker chooses the bytes for.
        'http://i.bang.com/covers/abc.jpg'
    ];

    for (const url of refused) {
        assert.equal(signedMediaUrl(url), null, `signed: ${url}`);
        assert.equal(allowedImage(url), null, `allowed: ${url}`);
    }
});

test('a host that leaves the allowlist stops working for links already minted', () => {
    // Re-checked on the way in rather than taken on trust from the signature,
    // so removing a partner is a one-line change that takes effect at once
    // instead of whenever the last signed URL falls out of somebody's cache.
    const signed = signedMediaUrl(OK);
    const { searchParams } = new URL(signed, 'https://example.test');

    const hosts = _internals.HOSTS.splice(0, _internals.HOSTS.length);

    try {
        assert.equal(verifyMediaUrl(searchParams.get('u'), searchParams.get('s')), null);
    } finally {
        _internals.HOSTS.push(...hosts);
    }
});

test('a subdomain of a partner is fine and a lookalike is not', () => {
    assert.ok(signedMediaUrl('https://cdn2.i.bang.com/x.jpg'), 'partners shard their CDNs');
    assert.equal(signedMediaUrl('https://xi.bang.com/x.jpg'), null, 'and that is not a shard');
});

test('garbage in the query string is refused rather than thrown over', () => {
    // These reach the route straight off `req.query`, where the value can be
    // an array or an object as easily as a string. A throw here is a 500 on a
    // request that deserves a placeholder.
    for (const bad of [[], {}, 42, null, undefined, 'not base64 !!!', '']) {
        assert.doesNotThrow(() => verifyMediaUrl(bad, bad));
        assert.equal(verifyMediaUrl(bad, bad), null);
    }
});

test('the signature is long enough to be worth having', () => {
    assert.ok(_internals.SIG_BYTES >= 16, 'a truncated HMAC still has to be 128 bits');
});
