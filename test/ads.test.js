import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AD_SCRIPT_SRC,
    adSlotHtml,
    anyZonesConfigured,
    cleanZone,
    nativeStripHtml,
    pickSize
} from '../src/ads/juicyads.js';
import { AD_HOSTS, AD_PLACEMENTS, MOBILE_BREAKPOINT_PX, NATIVE_STRIP } from '../src/ads/zones.js';

/**
 * Ad slots.
 *
 * Two properties are worth a suite here, and neither is about how an ad looks.
 *
 * The first is that an unconfigured placement renders **nothing** — not a
 * reserved box, not a label. That is what lets this ship before the account
 * has zones for every size, and it is the difference between a page that has
 * no ads and a page covered in empty grey rectangles.
 *
 * The second is the viewport split. Desktop and mobile are different zone ids,
 * not one creative that reflows, so the size chosen at render time decides
 * which id is asked for. Getting that backwards serves a 728px leaderboard to
 * a phone, where it is clipped rather than scaled and the advertiser is billed
 * for an impression nobody could read.
 *
 * Nothing here touches a DOM or a network. `adSlotHtml` takes the viewport
 * width as a parameter for exactly that reason.
 */

const PHONE = 390;
const TABLET = 820;
const DESKTOP = 1440;

/* ------------------------------------------------------- configuration -- */

test('every placement declares both a desktop and a mobile size', () => {
    assert.ok(AD_PLACEMENTS.length > 0, 'there is inventory');

    for (const p of AD_PLACEMENTS) {
        for (const tier of ['desktop', 'mobile']) {
            const size = p[tier];
            assert.ok(size, `${p.id} has a ${tier} size`);
            assert.ok(size.width > 0 && size.height > 0, `${p.id}.${tier} is dimensioned`);
        }
    }
});

test('every mobile creative fits the narrowest phone', () => {
    // 320px is the floor this site supports. JuicyAds' mobile sizes are all
    // 300 wide, so this holds today — it is pinned because a desktop size
    // pasted into a `mobile` slot by mistake is invisible in review and
    // obvious only on a phone.
    for (const p of AD_PLACEMENTS) {
        assert.ok(p.mobile.width <= 320, `${p.id} mobile is ${p.mobile.width}px wide, too wide for 320`);
    }

    assert.ok(NATIVE_STRIP.width <= 320, 'the native unit fits a phone too');
});

test('a zone id is a positive integer or it is not a zone', () => {
    assert.equal(cleanZone(1129394), 1129394);
    assert.equal(cleanZone('1129394'), 1129394, 'a pasted string still works');

    for (const bad of [null, undefined, 0, -1, 1.5, 'abc', '', '12"><script>', NaN, Infinity, {}]) {
        assert.equal(cleanZone(bad), null, `${String(bad)} is not a zone`);
    }
});

/* --------------------------------------------------------- the split -- */

test('the viewport decides which size is asked for', () => {
    const p = {
        desktop: { zone: 1, width: 728, height: 90 },
        mobile: { zone: 2, width: 300, height: 100 }
    };

    assert.equal(pickSize(p, DESKTOP).zone, 1);
    assert.equal(pickSize(p, TABLET).zone, 1, 'a tablet is served the desktop unit');
    assert.equal(pickSize(p, PHONE).zone, 2);

    // The boundary itself, both sides, because an off-by-one here is a whole
    // class of device getting the wrong creative.
    assert.equal(pickSize(p, MOBILE_BREAKPOINT_PX).zone, 1);
    assert.equal(pickSize(p, MOBILE_BREAKPOINT_PX - 1).zone, 2);
});

/* ---------------------------------------------------------- rendering -- */

test('the live leaderboard renders its zone and reserves its height', () => {
    const html = adSlotHtml('top-leaderboard', { viewportWidth: DESKTOP });

    assert.match(html, /id="1129394"/, 'the dashboard zone id');
    assert.match(html, /data-width="728"/);
    assert.match(html, /data-height="90"/);
    assert.match(html, /--ad-w:728px/, 'the width is reserved in CSS too');
    assert.match(html, /--ad-h:90px/);
    assert.match(html, /class="adsbyjuicy"/, 'fillAdSlots selects on this');
    assert.match(html, />Advertisement</, 'and it says what it is');
});

test('a placement with no zone for this viewport renders nothing at all', () => {
    // The top leaderboard has a desktop zone and no mobile one. On a phone it
    // must be absent rather than empty: an "Advertisement" label over a blank
    // 300x100 box is worse than no ad, and is indistinguishable from an ad
    // that is configured but failing to fill.
    const phone = adSlotHtml('top-leaderboard', { viewportWidth: PHONE });

    assert.equal(phone, '', 'no markup, no label, no reserved space');
    assert.doesNotMatch(phone, /Advertisement/);
});

test('an unknown placement id is empty rather than throwing', () => {
    assert.equal(adSlotHtml('no-such-slot', { viewportWidth: DESKTOP }), '');
});

test('the unconfigured placements stay silent until they have ids', () => {
    for (const id of ['mid-billboard', 'footer-leaderboard']) {
        assert.equal(adSlotHtml(id, { viewportWidth: DESKTOP }), '', `${id} desktop`);
        assert.equal(adSlotHtml(id, { viewportWidth: PHONE }), '', `${id} mobile`);
    }
});

test('the native strip is absent while it has no zones', () => {
    assert.equal(nativeStripHtml(), '', 'an empty strip is no strip');
});

/* -------------------------------------------------------------- gates -- */

test('something is configured, so the loader is allowed to run', () => {
    // If this ever fails, every slot on the site has gone quiet and `jads.js`
    // is no longer fetched at all — which is correct behaviour, but only if it
    // was intended.
    assert.equal(anyZonesConfigured(), true);
});

test('ads are confined to the production hostnames', () => {
    assert.deepEqual(AD_HOSTS, ['lustxr.com', 'www.lustxr.com']);

    // Not localhost, not a preview host. An impression filed from a dev server
    // or a headless test run is invalid traffic on a real advertiser's budget,
    // and invalid traffic is what publisher accounts are closed over.
    for (const host of ['localhost', '127.0.0.1', 'staging.lustxr.com', 'lustxr.com.evil.net']) {
        assert.ok(!AD_HOSTS.includes(host), `${host} may not serve ads`);
    }
});

test('the loader is the network\'s own, over https', () => {
    const url = new URL(AD_SCRIPT_SRC);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'poweredby.jads.co');
});
