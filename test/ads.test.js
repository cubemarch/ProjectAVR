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

test('no zone id is used twice', () => {
    // The renderer writes the zone id to the `<ins>` as a DOM id, and the
    // network's loader looks the element back up by it when it drains the
    // queue. Two slots sharing an id is therefore not two ads: it is one ad
    // and one permanently empty box, with nothing in the markup to say so.
    const ids = [];

    for (const p of AD_PLACEMENTS) {
        for (const tier of ['desktop', 'mobile']) {
            if (p[tier].zone !== null) ids.push(p[tier].zone);
        }
    }
    ids.push(...NATIVE_STRIP.zones);

    assert.equal(new Set(ids).size, ids.length, `a zone id repeats in ${ids.join(', ')}`);
});

test('a desktop unit is never wider than the narrowest width it is served at', () => {
    // The invariant behind `desktopMinWidth`. A creative wider than its own
    // floor is clipped by the slot's `overflow: hidden` at every width
    // between the two — which produces no error, no scrollbar and no visible
    // symptom except on the devices in that band.
    for (const p of AD_PLACEMENTS) {
        const floor = p.desktopMinWidth || MOBILE_BREAKPOINT_PX;

        assert.ok(
            p.desktop.width <= floor,
            `${p.id} serves a ${p.desktop.width}px unit from ${floor}px up`
        );
    }
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

test('a placement with a wide creative sets its own floor', () => {
    const billboard = AD_PLACEMENTS.find((p) => p.id === 'mid-billboard');
    assert.equal(billboard.desktopMinWidth, 940);

    // A tablet is well above the default breakpoint and still gets the mobile
    // unit here, because 908px of creative does not fit an 820px screen.
    assert.equal(pickSize(billboard, TABLET).zone, billboard.mobile.zone);

    assert.equal(pickSize(billboard, 939).zone, billboard.mobile.zone);
    assert.equal(pickSize(billboard, 940).zone, billboard.desktop.zone);

    // And the floor is this placement's alone — the leaderboards still turn
    // over at the default, so raising one did not quietly raise them all.
    const top = AD_PLACEMENTS.find((p) => p.id === 'top-leaderboard');
    assert.equal(pickSize(top, TABLET).zone, top.desktop.zone);
});

/* ---------------------------------------------------------- rendering -- */

test('every placement emits its own zone at each viewport', () => {
    // Table-driven because the mistake this catches is a transposed paste:
    // six ids off one dashboard page, differing in their last two digits,
    // going into six slots. A swapped pair still renders a perfectly valid
    // ad — the wrong size, in the wrong place, looking like a CSS bug.
    const expected = [
        ['top-leaderboard', DESKTOP, 1129394, 728, 90],
        ['top-leaderboard', PHONE, 1129396, 300, 100],
        ['mid-billboard', DESKTOP, 1129400, 908, 258],
        ['mid-billboard', PHONE, 1129401, 300, 250],
        ['footer-leaderboard', DESKTOP, 1129397, 728, 90],
        ['footer-leaderboard', PHONE, 1129398, 300, 100]
    ];

    for (const [id, viewportWidth, zone, w, h] of expected) {
        const where = `${id} at ${viewportWidth}px`;
        const html = adSlotHtml(id, { viewportWidth });

        assert.match(html, new RegExp(`id="${zone}"`), `${where}: zone id`);
        assert.match(html, new RegExp(`data-width="${w}"`), `${where}: width`);
        assert.match(html, new RegExp(`data-height="${h}"`), `${where}: height`);

        // The same numbers again as custom properties. These are what reserve
        // the space before the creative lands, so a slot carrying the right
        // zone and the wrong reservation still shifts the page when it fills.
        assert.match(html, new RegExp(`--ad-w:${w}px`), `${where}: width reserved`);
        assert.match(html, new RegExp(`--ad-h:${h}px`), `${where}: height reserved`);

        assert.match(html, /class="adsbyjuicy"/, `${where}: fillAdSlots selects on this`);
        assert.match(html, />Advertisement</, `${where}: and it says what it is`);
    }
});

test('an unconfigured placement renders nothing at all', () => {
    // Against a synthetic placement, because every real one now has an id.
    // This is the property the whole module is built around, so it does not
    // get to lapse just because the live configuration stopped exercising it:
    // a label over a blank box is worse than no ad, and is indistinguishable
    // from a zone that is configured and failing to fill.
    const placements = [
        {
            id: 'not-yet-sold',
            label: 'A placement waiting for an id',
            desktop: { zone: null, width: 728, height: 90 },
            mobile: { zone: null, width: 300, height: 100 }
        }
    ];

    for (const viewportWidth of [DESKTOP, TABLET, PHONE]) {
        const html = adSlotHtml('not-yet-sold', { viewportWidth, placements });

        assert.equal(html, '', `${viewportWidth}px: no markup, no label, no reserved space`);
        assert.doesNotMatch(html, /Advertisement/);
    }
});

test('one tier configured does not render the other', () => {
    // The state the top leaderboard was in for most of 2026-10-18: a desktop
    // zone and no mobile one. Phones got nothing, rather than a 728px
    // creative clipped into a 390px column and billed as an impression.
    const placements = [
        {
            id: 'half-sold',
            label: 'Desktop only',
            desktop: { zone: 1129394, width: 728, height: 90 },
            mobile: { zone: null, width: 300, height: 100 }
        }
    ];

    assert.match(adSlotHtml('half-sold', { viewportWidth: DESKTOP, placements }), /id="1129394"/);
    assert.equal(adSlotHtml('half-sold', { viewportWidth: PHONE, placements }), '');
});

test('an unknown placement id is empty rather than throwing', () => {
    assert.equal(adSlotHtml('no-such-slot', { viewportWidth: DESKTOP }), '');
});

test('the native strip draws one unit per configured zone', () => {
    const html = nativeStripHtml();

    assert.match(html, /class="ad-strip"/);
    assert.match(html, /id="1129402"/);
    assert.match(html, /--ad-w:108px/);
    assert.match(html, /--ad-h:140px/);
    assert.equal(
        html.match(/class="adsbyjuicy"/g).length,
        NATIVE_STRIP.zones.length,
        'one unit per zone, no more'
    );
});

test('an empty strip is no strip', () => {
    const empty = { zones: [], width: 108, height: 140 };
    const junk = { zones: [null, 0, 'abc'], width: 108, height: 140 };

    assert.equal(nativeStripHtml(empty), '', 'no zones, no wrapper');
    assert.equal(nativeStripHtml(junk), '', 'and nothing a bad paste left behind');
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
