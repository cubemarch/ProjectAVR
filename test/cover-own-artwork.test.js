import test from 'node:test';
import assert from 'node:assert/strict';

import { coverOwnArtwork } from '../server/library.js';
import { verifyStorageUrl } from '../server/media/proxy.js';

/**
 * Our own posters and backdrops, covered for a visitor who has not verified.
 *
 * The partner shelves had this first and their artwork is somebody else's; the
 * catalogue is ours, which makes no difference to the viewer and none to the
 * statutes. A poster is a frame a creator picked out of their own film and
 * nothing has looked at it.
 *
 * What makes this worth its own file rather than an assertion on the route is
 * that `buildLibrary` is cached once per process. The covering therefore
 * cannot be a flag threaded into the item shape — it is a pass over the
 * response on the way out, and a pass that mutated the cached originals would
 * cover the catalogue for everybody including the people who verified.
 */

const PORTAL = {
    id: 'reef-dive',
    title: 'Reef Dive',
    source: 'portal',
    poster: '/stream/poster/7/42/abc.jpg',
    backdrop: '/stream/backdrop/7/42/def.jpg',
    posterKey: 'poster/7/42/abc.jpg',
    backdropKey: 'backdrop/7/42/def.jpg'
};

/** A file dropped in `public/media/`: a drawn SVG and no key to cover. */
const SCANNED = {
    id: 'sample-8k',
    title: 'Sample 8K',
    source: 'media-dir',
    poster: '/art/sample-8k-poster.svg'
};

function keyBehind(url) {
    const { searchParams } = new URL(url, 'https://example.test');
    return verifyStorageUrl(searchParams.get('k'), searchParams.get('s'));
}

test('a poster and a backdrop are replaced by signed proxy URLs', () => {
    const [item] = coverOwnArtwork([PORTAL]);

    assert.ok(item.poster.startsWith('/api/media?'), 'the poster goes through the censor');
    assert.ok(item.backdrop.startsWith('/api/media?'), 'and so does the backdrop');

    assert.equal(keyBehind(item.poster), PORTAL.posterKey);
    assert.equal(keyBehind(item.backdrop), PORTAL.backdropKey);
});

test('the keys themselves do not survive into a covered payload', () => {
    // Under `CDN_BASE_URL` a delivery URL is the base and the key with nothing
    // in between, so a key left in the response is the uncovered picture
    // written out a second time. The covered item has to carry no way back.
    const [item] = coverOwnArtwork([PORTAL]);

    assert.equal(item.posterKey, undefined);
    assert.equal(item.backdropKey, undefined);
    assert.equal(JSON.stringify(item).includes('poster/7/42/abc.jpg'), false);
});

test('the cached originals are left alone', () => {
    // The failure this guards against is the loud one: a mutating pass covers
    // the catalogue for every request served from the cache afterwards,
    // including the ones from visitors who verified.
    const items = [{ ...PORTAL }];
    const before = JSON.stringify(items);

    coverOwnArtwork(items);

    assert.equal(JSON.stringify(items), before);
});

test('an item with nothing of ours in it is passed through untouched', () => {
    const [item] = coverOwnArtwork([SCANNED]);

    assert.equal(item, SCANNED, 'the same object, not a copy');
    assert.equal(item.poster, '/art/sample-8k-poster.svg');
});

test('one of the two is covered when only one of the two is there', () => {
    const [posterOnly] = coverOwnArtwork([{ ...PORTAL, backdrop: undefined, backdropKey: undefined }]);

    assert.ok(posterOnly.poster.startsWith('/api/media?'));
    assert.equal(posterOnly.backdrop, undefined, 'and nothing is invented for the missing one');

    const [backdropOnly] = coverOwnArtwork([{ ...PORTAL, poster: undefined, posterKey: undefined }]);

    assert.equal(backdropOnly.poster, undefined);
    assert.ok(backdropOnly.backdrop.startsWith('/api/media?'));
});

test('a mixed catalogue keeps its order and its length', () => {
    const items = coverOwnArtwork([SCANNED, PORTAL, SCANNED]);

    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.id), ['sample-8k', 'reef-dive', 'sample-8k']);
});
