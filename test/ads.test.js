import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AD_SCRIPT_SRC,
    adSlotHtml,
    anyZonesConfigured,
    bioCardAdHtml,
    cleanZone,
    mayServe,
    nativeStripHtml,
    pickSize,
    sfwZones
} from '../src/ads/juicyads.js';
import {
    AD_HOSTS,
    AD_PLACEMENTS,
    BIO_CARD_AD,
    MOBILE_BREAKPOINT_PX,
    NATIVE_STRIP
} from '../src/ads/zones.js';

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
 * A third arrived on 2026-10-20: an unverified visitor gets no adult zone at
 * all — since 2026-11-02, only a placement's `sfw` pair or nothing. The cases
 * below pass `verified: true` because they are about the first two properties
 * and would otherwise all assert the third by accident; the third has cases of
 * its own.
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

    // The profile card has no mobile tier to fall back to — it is one size at
    // every width — so this is the only thing standing between it and being
    // clipped on a phone. The card itself is `calc(100vw - 24px)` at its
    // widest, and the unit sits inside 16px of padding either side.
    assert.ok(
        BIO_CARD_AD.width <= 320 - 24 - 32,
        `the profile card unit is ${BIO_CARD_AD.width}px, too wide for the card on a 320px phone`
    );
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
            if (p.sfw && p.sfw[tier].zone !== null) ids.push(p.sfw[tier].zone);
        }
    }
    ids.push(...NATIVE_STRIP.zones);
    if (BIO_CARD_AD.zone !== null) ids.push(BIO_CARD_AD.zone);

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
        const html = adSlotHtml(id, { viewportWidth, verified: true });

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
        const html = adSlotHtml('not-yet-sold', { viewportWidth, placements, verified: true });

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

    assert.match(
        adSlotHtml('half-sold', { viewportWidth: DESKTOP, placements, verified: true }),
        /id="1129394"/
    );
    assert.equal(
        adSlotHtml('half-sold', { viewportWidth: PHONE, placements, verified: true }),
        ''
    );
});

test('an unverified visitor is never served an adult zone', () => {
    // The one rule on this site is that an unverified visitor does not see
    // genitals, and every other surface honours it by covering the artwork —
    // `services/censor/` pixelates it and `server/media/proxy.js` is how it
    // gets there. An ad cannot go through that: the creative is picked by an
    // auction at display time, drawn into the page by the network's own
    // loader from the network's own CDN, and frequently is not even an image.
    // There is no URL to sign and no bytes to pixelate.
    //
    // So an adult zone is not drawn. What may be drawn instead is a zone the
    // dashboard restricts to SFW creatives, named as `sfw` in `zones.js`. This
    // covers all three entry points rather than the one, because they are
    // three separate functions and an adult zone that escapes through any of
    // them is uncensored material in front of somebody who has not verified.
    const sfw = sfwZones();

    for (const viewportWidth of [DESKTOP, TABLET, PHONE]) {
        for (const p of AD_PLACEMENTS) {
            const html = adSlotHtml(p.id, { viewportWidth, verified: false });
            const zones = [...html.matchAll(/<ins [^>]*id="(\d+)"/g)].map((m) => Number(m[1]));

            for (const zone of zones) {
                assert.ok(sfw.has(zone), `${p.id} at ${viewportWidth}px serves ${zone}, which is not an SFW zone`);
            }
            if (!p.sfw) assert.equal(html, '', `${p.id} has no SFW pair and still draws at ${viewportWidth}px`);
        }
    }

    assert.equal(nativeStripHtml(NATIVE_STRIP, { verified: false }), '', 'the native strip');
    assert.equal(bioCardAdHtml(BIO_CARD_AD, { verified: false }), '', 'the profile card unit');
});

test('the SFW leaderboard is off, and an unverified visitor gets an empty slot', () => {
    // 1130677 served an adult creative on 2026-11-05 and was switched off;
    // see the comment on `top-leaderboard` in `zones.js`. Until JuicyAds
    // confirms it, neither lock may let it through.
    assert.equal(adSlotHtml('top-leaderboard', { viewportWidth: DESKTOP, verified: false }), '');
    assert.equal(adSlotHtml('top-leaderboard', { viewportWidth: PHONE, verified: false }), '');
    assert.equal(mayServe(1130677, { verified: false }), false);

    // A verified visitor keeps the adult zone, and never sees the SFW one.
    const verified = adSlotHtml('top-leaderboard', { viewportWidth: DESKTOP, verified: true });
    assert.match(verified, /id="1129394"/);
    assert.doesNotMatch(verified, /1130677/);
});

test('an unset SFW tier is empty, never the adult zone at that size', () => {
    const placements = [
        {
            id: 'half-sfw',
            label: 'An SFW desktop zone and no SFW mobile one',
            desktop: { zone: 11, width: 728, height: 90 },
            mobile: { zone: 12, width: 300, height: 100 },
            sfw: {
                desktop: { zone: 21, width: 728, height: 102 },
                mobile: { zone: null, width: 300, height: 100 }
            }
        }
    ];

    assert.match(adSlotHtml('half-sfw', { viewportWidth: DESKTOP, placements, verified: false }), /id="21"/);
    assert.equal(adSlotHtml('half-sfw', { viewportWidth: PHONE, placements, verified: false }), '');
});

test('only an SFW zone may be queued for an unverified visitor', () => {
    // The second lock. `fillAdSlots` pushes whatever `<ins>` it finds, so a
    // slot built by a route that forgot `verified` would otherwise reach the
    // network. This is the check it makes per zone before pushing.
    const adult = [];
    for (const p of AD_PLACEMENTS) adult.push(p.desktop.zone, p.mobile.zone);
    adult.push(...NATIVE_STRIP.zones, BIO_CARD_AD.zone);

    for (const zone of adult.filter((z) => z !== null)) {
        assert.equal(mayServe(zone, { verified: false }), false, `${zone} is queued for an unverified visitor`);
        assert.equal(mayServe(zone, { verified: true }), true, `${zone} is withheld from a verified one`);
    }

    assert.equal(mayServe('12"><x', { verified: true }), false, 'junk is not a zone for anybody');

    // And the default is the unverified answer, as everywhere else here.
    assert.equal(mayServe(1129394), false);
});

test('every SFW creative fits the floor it is served from', () => {
    for (const p of AD_PLACEMENTS.filter((p) => p.sfw)) {
        const floor = p.desktopMinWidth || MOBILE_BREAKPOINT_PX;
        assert.ok(p.sfw.desktop.width <= floor, `${p.id} SFW serves ${p.sfw.desktop.width}px from ${floor}px up`);
        assert.ok(p.sfw.mobile.width <= 320, `${p.id} SFW mobile is too wide for 320`);
    }
});

test('withholding is the default, not something a caller has to ask for', () => {
    // `verified` defaults to `ageOk()`, which is false until the server has
    // answered. The risk this guards is the ordering one: a slot rendered
    // during the window between first paint and the gate fetch landing. A
    // default of "verified" would make that window an adult impression.
    assert.doesNotMatch(adSlotHtml('top-leaderboard', { viewportWidth: DESKTOP }), /1129394/);
    assert.equal(adSlotHtml('mid-billboard', { viewportWidth: DESKTOP }), '');
    assert.equal(nativeStripHtml(), '');
    assert.equal(bioCardAdHtml(), '');
});

test('an unknown placement id is empty rather than throwing', () => {
    assert.equal(adSlotHtml('no-such-slot', { viewportWidth: DESKTOP, verified: true }), '');
});

test('the native strip draws one unit per configured zone', () => {
    const html = nativeStripHtml(NATIVE_STRIP, { verified: true });

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

    assert.equal(nativeStripHtml(empty, { verified: true }), '', 'no zones, no wrapper');
    assert.equal(
        nativeStripHtml(junk, { verified: true }),
        '',
        'and nothing a bad paste left behind'
    );
});

test('the profile card unit draws at its one size', () => {
    const html = bioCardAdHtml(BIO_CARD_AD, { verified: true });

    assert.match(html, /id="1129407"/);
    assert.match(html, /class="ad-slot ad-slot-bio-card"/);
    assert.match(html, /data-width="178"/);
    assert.match(html, /data-height="30"/);
    assert.match(html, /--ad-w:178px/);
    assert.match(html, /--ad-h:30px/);

    // The class the card's own stylesheet hangs the in-popup spacing on, and
    // the hook `_bindStarBios` relies on being able to hide while a biography
    // is still being fetched.
    assert.equal(html.match(/class="adsbyjuicy"/g).length, 1, 'one unit, not a strip');
    assert.match(html, />Advertisement</, 'disclosed, like every other slot');
});

test('an unconfigured profile card unit renders nothing', () => {
    // The card is built from a string concatenation rather than a template
    // with a hole in it, so `''` here is the difference between a biography
    // sitting above its disclaimer and one with an empty labelled box wedged
    // into the middle of it.
    assert.equal(bioCardAdHtml({ zone: null, width: 178, height: 30 }), '');
    assert.equal(bioCardAdHtml({ zone: 'nope', width: 178, height: 30 }), '');
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

/* ------------------------------------------------------- paint order -- */

/*
 * An ad that covers a popup is worth less than no ad at all: the reader loses
 * the thing they asked for, and the advertiser is billed for an impression
 * that made the site worse. The two properties below are what keep that from
 * happening, and both are one line of CSS that nothing visibly depends on —
 * so both are deletable while tidying and neither fails loudly when deleted.
 */

const CSS = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'netflix.css'),
    'utf8'
);

const BROWSE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'browse.js'),
    'utf8'
);

const MAIN = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js'),
    'utf8'
);

/** Every `z-index: <n>` in the sheet, as numbers. */
function zIndexes() {
    return [...CSS.matchAll(/z-index:\s*(-?\d+)\s*;/g)].map((m) => Number(m[1]));
}

test('the age gate is the top layer, then the interstitial, then the banner, then the profile card', () => {
    // One ordering, because the only elements allowed above the profile card
    // are the age gate and the two things that open it. Anything else
    // appearing up there is an ad format that has escaped its slot, which is
    // the bug this section exists to catch.
    //
    // The banner joined the list on 2026-10-20, when the gate stopped being a
    // blocking interstitial. It has to be under the dialog — it opens it, so
    // a banner painting over its own dialog would cover the thing it just
    // asked for — and over everything else, because it is the only standing
    // explanation of why every image on the page is a mosaic.
    //
    // The image interstitial joined on 2026-10-21, between the two. Over the
    // banner because they offer the same gate and the standing strip should
    // not poke through this one's backdrop; under the dialog for the reason
    // below.
    const gate = CSS.match(/\.age-gate\s*\{[^}]*?z-index:\s*(\d+)/)?.[1];
    const image = CSS.match(/\.image-gate\s*\{[^}]*?z-index:\s*(\d+)/)?.[1];
    const banner = CSS.match(/\.age-banner\s*\{[^}]*?z-index:\s*(\d+)/)?.[1];
    const card = CSS.match(/\.star-bio\s*\{[^}]*?z-index:\s*(\d+)/)?.[1];

    assert.ok(gate, '.age-gate has no z-index at all');
    assert.ok(image, '.image-gate has no z-index at all');
    assert.ok(banner, '.age-banner has no z-index at all');
    assert.ok(card, '.star-bio has no z-index at all');

    const all = zIndexes();
    assert.equal(
        Number(gate),
        Math.max(...all),
        'something in the sheet now paints at or above the age gate'
    );

    // The gate is what stands between a minor and the page. A popup over it
    // is not a cosmetic defect.
    assert.ok(Number(gate) > Number(image), 'the interstitial can cover the dialog it opens');
    assert.ok(Number(image) > Number(banner), 'the banner can poke through the interstitial');
    assert.ok(Number(banner) > Number(card), 'the profile card can cover the age banner');

    const overlays = [Number(gate), Number(image), Number(banner)];
    const others = all.filter((n) => !overlays.includes(n));
    assert.equal(
        Number(card),
        Math.max(...others),
        'something other than the age gate now paints at or above the profile card'
    );
});

test('the profile card is not nested inside a stacking context', () => {
    // `.affiliates` is `position: relative; z-index: 2`, which makes it one.
    // The card used to be rendered inside it, and the effect was that its
    // z-index was resolved against its siblings in that section rather than
    // against the page - so the whole card painted at level 2 and an ad
    // sitting above level 2 covered it, however high the number above went.
    //
    // This is a source check because `browse.js` imports CSS and assets and
    // cannot be loaded in Node. It is worth having anyway: the markup is one
    // template string, and moving the card back inside the section is a
    // two-line edit that looks tidier than it is.
    const browse = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'browse.js'),
        'utf8'
    );

    const section = browse.indexOf('<section class="affiliates"');
    const endOfSection = browse.indexOf('</section>', section);
    const bio = browse.indexOf('id="star-bio"');

    assert.ok(section > 0 && endOfSection > 0 && bio > 0, 'the template moved');
    assert.ok(bio > endOfSection, 'the profile card is back inside .affiliates');
});

test('an ad creative cannot paint outside its own slot', () => {
    // Without this, a creative that sets a large z-index on something it
    // injects competes with the rest of the document on equal terms, and the
    // formats that pay best are exactly the ones that try.
    const slot = CSS.match(/^\.ad-slot\s*\{[\s\S]*?\n\}/m)?.[0];
    assert.ok(slot, '.ad-slot rule not found');
    assert.match(slot, /isolation:\s*isolate/, 'ad slots are no longer isolated');
});

test('the skyscraper is the 160x600 zone, and only there', () => {
    const sky = AD_PLACEMENTS.find((p) => p.id === 'top-skyscraper');

    assert.ok(sky, 'the skyscraper placement exists');
    assert.equal(sky.desktop.zone, 1129440);
    assert.equal(sky.desktop.width, 160);
    assert.equal(sky.desktop.height, 600);

    const uses = AD_PLACEMENTS.filter(
        (p) => p.desktop.zone === 1129440 || p.mobile.zone === 1129440
    );
    assert.equal(uses.length, 1, 'zone 1129440 is in exactly one placement');
});

test('the skyscraper is not served where the page cannot give up the column', () => {
    // The only placement whose floor is about the page rather than about the
    // creative. 160px fits anywhere; the reserved column plus a 908px
    // `mid-billboard` inside a 4vw gutter does not, below roughly 1190.
    const sky = AD_PLACEMENTS.find((p) => p.id === 'top-skyscraper');
    const mid = AD_PLACEMENTS.find((p) => p.id === 'mid-billboard');

    assert.ok(sky.desktopMinWidth >= 1280, 'the floor leaves room for a page');

    // At the floor: viewport, less the reserved rail, less a gutter either
    // side of what is left, still fits the widest unit below it.
    const w = sky.desktopMinWidth;
    const rail = 0.04 * w + sky.desktop.width + 28;
    assert.ok(w - rail - 2 * (0.04 * w) >= mid.desktop.width, 'the content column is too narrow');

    assert.equal(
        adSlotHtml('top-skyscraper', { viewportWidth: w - 1, verified: true }),
        '',
        'served below its floor'
    );
    assert.notEqual(
        adSlotHtml('top-skyscraper', { viewportWidth: w, verified: true }),
        '',
        'not served at its floor'
    );
});

test('the reserved column and the creative it is reserved for agree', () => {
    // `--sky-rail-w` adds the creative width to a gutter and some air. It is
    // the one number in the stylesheet that has to track `zones.js`, and the
    // failure when it drifts is an advertisement painted over a shelf.
    const sky = AD_PLACEMENTS.find((p) => p.id === 'top-skyscraper');
    const rail = CSS.match(/--sky-rail-w:\s*calc\(([^)]*)\)/)?.[1];

    assert.ok(rail, '--sky-rail-w is no longer a calc()');
    assert.match(rail, /\b4vw\b/, 'the rail does not include the page gutter it aligns to');
    assert.ok(
        rail.includes(`${sky.desktop.width}px`),
        `--sky-rail-w (${rail}) does not reserve the creative's ${sky.desktop.width}px`
    );
});

test('the skyscraper is positioned out of the flow, and the page insets for it', () => {
    // Two halves of one arrangement. Either without the other is a 600px
    // hole in the layout or an ad on top of the content.
    const slot = CSS.match(/^\.ad-slot-top-skyscraper\s*\{[\s\S]*?\n\}/m)?.[0];
    const main = CSS.match(/^#browse-main\.has-sky-rail\s*\{[\s\S]*?\n\}/m)?.[0];

    assert.ok(slot, '.ad-slot-top-skyscraper rule not found');
    assert.ok(main, '#browse-main.has-sky-rail rule not found');

    assert.match(slot, /position:\s*absolute/, 'the skyscraper is back in the flow');
    assert.match(main, /position:\s*relative/, 'nothing anchors the skyscraper');
    assert.match(main, /padding-right:\s*var\(--sky-rail-w\)/, 'the column is not reserved');
});

test('the class that reserves the column is set from the markup, not a second breakpoint', () => {
    // `has-sky-rail` has to come from whether the slot rendered. A media
    // query would be the 1280 floor written in `zones.js` and again in the
    // stylesheet, and they drift.
    assert.match(
        BROWSE,
        /const skyscraper = adSlotHtml\('top-skyscraper'\)/,
        'the skyscraper is no longer rendered once and reused'
    );
    assert.match(BROWSE, /skyscraper && 'has-sky-rail'/, 'the class no longer follows the markup');
    assert.doesNotMatch(CSS, /@media[^{]*1280[^{]*\{[^}]*has-sky-rail/, 'the floor is in the CSS too');
});

test('no slot is written into the partner section while it is still hidden', () => {
    // `.affiliates` ships `hidden` and un-hides when the feed answers, about
    // 700ms in. `fillAdSlots` has run by then, so an `<ins>` sitting in the
    // template inside that section is registered — and the impression
    // counted — while the section is `display: none`.
    //
    // `pitch-billboard` is the one this catches: its natural home is right
    // under `<div id="affiliate-pitch">`, three lines up from here, and it
    // is built in `_renderAffiliates` instead.
    const start = BROWSE.indexOf('<section class="affiliates"');
    const end = BROWSE.indexOf('</section>', start);

    assert.ok(start > 0 && end > start, 'the partner section moved or was renamed');
    assert.doesNotMatch(
        BROWSE.slice(start, end),
        /adSlotHtml\(/,
        'an ad slot is in the template inside the section that ships hidden'
    );
});

test('1129419 came back to the pitch band rather than being left on the floor', () => {
    // It was `top-billboard` for part of a day. The skyscraper taking the
    // top slot with an id of its own is what freed it, and a live zone that
    // is in no placement earns nothing.
    const pitch = AD_PLACEMENTS.find((p) => p.id === 'pitch-billboard');

    assert.ok(pitch, 'the pitch placement exists');
    assert.equal(pitch.desktop.zone, 1129419);
    assert.ok(pitch.desktopMinWidth >= pitch.desktop.width, 'the floor clears the creative');

    const uses = AD_PLACEMENTS.filter(
        (p) => p.desktop.zone === 1129419 || p.mobile.zone === 1129419
    );
    assert.equal(uses.length, 1, 'zone 1129419 is in exactly one placement');
});

/* ------------------------------------------- the two slots in the shell -- */

/**
 * `top-skyscraper` and `top-leaderboard` are the only slots emitted by
 * `_render` and by nothing else, which makes them the only two that can be
 * withheld permanently by an ordering mistake rather than for the visit.
 *
 * They were, for the life of `5a86352`. That commit gave `adSlotHtml` its
 * `verified` guard — correctly, an ad is the one thing on the page that cannot
 * be covered — and `BrowseUI`'s constructor ran before the gate had answered,
 * so both returned `''` for every visitor including a verified one, and the
 * two highest-value placements on the site were dark. Nothing failed. The
 * symptom was a page that looked deliberately ad-free, plus the knock-on that
 * `has-sky-rail` is derived from the skyscraper's markup, so every row below
 * also ran the width of the missing rail.
 *
 * Neither half is visible from `juicyads.js`, so both are pinned against
 * source the way `image-gate.test.js` pins the overlay it cannot import.
 */
test('the age gate resolves before the render that emits the shell slots', () => {
    const gate = MAIN.indexOf('initAgeGate()');
    const construct = MAIN.indexOf('new BrowseUI(');

    assert.ok(gate > 0, 'main.js still calls initAgeGate');
    assert.ok(construct > 0, 'main.js still constructs BrowseUI');
    assert.ok(
        gate < construct,
        'BrowseUI renders before the gate has answered, so adSlotHtml withholds ' +
            'the skyscraper and the leaderboard and nothing ever draws them'
    );

    // Resolved, not merely started. Sitting in the `Promise.all` above the
    // constructor is what makes it free; `void initAgeGate()` on its own line
    // would satisfy the ordering above and none of the point.
    const before = MAIN.slice(0, construct);
    assert.match(
        before,
        /await Promise\.all\(\[[\s\S]*initAgeGate\(\)[\s\S]*\]\);/,
        'initAgeGate is called before the constructor but not awaited before it'
    );
});

test('passing the gate reloads, rather than refilling the slots in place', () => {
    // The anchors are still emitted, ad or no ad: the stylesheet insets the
    // column against them whether or not a creative lands there.
    for (const id of ['top-skyscraper-slot', 'top-leaderboard-slot']) {
        assert.match(BROWSE, new RegExp(`id="${id}"`), `${id} is the anchor and it is gone`);
    }

    assert.match(MAIN, /onAgeChange\(\([\s\S]{0,400}location\.reload\(\)/, 'passing the gate does not reload');

    // The reason it has to be a reload and not a refresh. `fillAdSlots`
    // appends the network's loader, which requests a creative and counts the
    // impression as it runs; doing that on a document about to be replaced
    // bills an advertiser for a banner nobody can see. Either one or the
    // other, never both.
    const handler = MAIN.slice(MAIN.indexOf('onAgeChange(('));
    assert.doesNotMatch(
        handler.slice(0, 400),
        /refreshShellAdSlots|refreshAffiliates|refreshCams/,
        'the reload also refreshes, so an impression is filed and then thrown away'
    );

    assert.ok(
        !BROWSE.includes('refreshShellAdSlots()'),
        'refreshShellAdSlots survives with no caller, describing a mechanism that is gone'
    );

    // The guard. An unguarded reload on `ok` reloads forever for every
    // visitor who was already verified when they arrived.
    assert.match(
        MAIN,
        /wasOk\s*=\s*ageState\(\)\.ok/,
        'nothing snapshots the age state, so the reload has no edge to trigger on'
    );
    assert.match(
        MAIN,
        /if \(age\.ok === wasOk\) return;/,
        'the handler reloads on every `ok`, not only on the transition into one'
    );
});

test('the placements are in page order', () => {
    const ids = AD_PLACEMENTS.map((p) => p.id);
    const expected = [
        'top-skyscraper',
        'top-leaderboard',
        'pitch-billboard',
        'mid-billboard',
        'footer-leaderboard'
    ];

    assert.deepEqual(ids, expected, 'the list is read top to bottom as the page is');
});
