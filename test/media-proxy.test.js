import test from 'node:test';
import assert from 'node:assert/strict';

import {
    allowedImage,
    signedMediaUrl,
    signedStorageUrl,
    verifyMediaUrl,
    verifyStorageUrl,
    _internals
} from '../server/media/proxy.js';

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

/* ------------------------------------------------------------ our own keys -- */

/**
 * The second namespace: a key in our own bucket rather than a partner's URL.
 *
 * It reaches the same route through the same `s` parameter, which is the whole
 * reason the cases below are worth having. Nothing structural keeps the two
 * apart — only the string each signature is computed over.
 */

const KEY = 'poster/7/42/9f3c1a2b4d5e6f70.jpg';

test('a key this server minted comes back, byte for byte', () => {
    const signed = signedStorageUrl(KEY);

    assert.ok(signed.startsWith('/api/media?'), 'the same route the partner URLs use');

    const { searchParams } = new URL(signed, 'https://example.test');

    assert.equal(searchParams.get('u'), null, 'and it carries no `u` to be read first');
    assert.equal(verifyStorageUrl(searchParams.get('k'), searchParams.get('s')), KEY);
});

test('a signature cannot cross between a URL and a key', () => {
    // The forgery this namespace exists to prevent. Both parameters are
    // attacker-supplied and both are checked against the same HMAC key, so if
    // the signed string were the bare value, a signature handed out for one
    // would verify as the other and `?k=` would become a reader for any
    // partner URL — or `?u=` a way to name an object in our bucket.
    const url = new URL(signedMediaUrl(OK), 'https://example.test').searchParams;
    const key = new URL(signedStorageUrl(OK), 'https://example.test').searchParams;

    assert.equal(url.get('u'), key.get('k'), 'the same string, signed in each namespace');
    assert.notEqual(url.get('s'), key.get('s'), 'and it must not sign to the same value');

    assert.equal(verifyStorageUrl(url.get('u'), url.get('s')), null, 'a URL signature as a key');
    assert.equal(verifyMediaUrl(key.get('k'), key.get('s')), null, 'and a key signature as a URL');
});

test('a key nobody signed is refused', () => {
    const { searchParams } = new URL(signedStorageUrl(KEY), 'https://example.test');
    const k = searchParams.get('k');

    assert.equal(verifyStorageUrl(k, ''), null, 'no signature');
    assert.equal(verifyStorageUrl(k, 'AAAAAAAAAAAAAAAAAAAAAA'), null, 'one of the right length');
    assert.equal(verifyStorageUrl(k, 'short'), null, 'and one of the wrong length');

    const other = new URL(signedStorageUrl('poster/7/43/0000.jpg'), 'https://example.test').searchParams;
    assert.equal(verifyStorageUrl(k, other.get('s')), null, 'a signature moved between keys');
});

test('a traversing key is refused even when the signature is ours', () => {
    // Belt and braces: nothing mints a key like these, so reaching this check
    // means something upstream already went wrong. The storage layer refuses
    // them too — this is the copy that stops a bad key being handed to it on
    // the strength of an HMAC alone.
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a\\..\\b.jpg', 'a\0b.jpg', 'poster/../../x']) {
        const signed = signedStorageUrl(bad);
        const { searchParams } = new URL(signed, 'https://example.test');

        assert.equal(verifyStorageUrl(searchParams.get('k'), searchParams.get('s')), null, bad);
    }
});

test('garbage in the key parameters is refused rather than thrown over', () => {
    // Same reasoning as the URL half: these arrive off `req.query`, where a
    // value is an array or an object as easily as a string, and a throw here
    // is a 500 on a request that deserves a placeholder.
    for (const bad of [[], {}, 42, null, undefined, 'not base64 !!!', '']) {
        assert.doesNotThrow(() => verifyStorageUrl(bad, bad));
        assert.equal(verifyStorageUrl(bad, bad), null);
    }

    // Signing is the other direction and has a narrower job: it is called
    // with a key off a database row, so what it refuses is the row being
    // empty or the column being something other than text. A string is signed
    // whatever is in it — the decode on the way back is what has to be
    // careful, not the encode on the way out.
    for (const bad of [[], {}, 42, null, undefined, '']) {
        assert.equal(signedStorageUrl(bad), null);
    }
});
