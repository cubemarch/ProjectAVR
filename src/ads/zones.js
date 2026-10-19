/**
 * JuicyAds inventory: where an advertisement may appear, and which zone fills
 * it.
 *
 * This file is configuration and nothing else. It holds no behaviour, imports
 * nothing, and is the only place a zone id is written — so turning a placement
 * on, off, or into a different size is an edit here and nowhere else.
 *
 * ## Nothing renders until a zone id is real
 *
 * A placement with no zone id **draws nothing at all** — not a box, not a
 * label, not reserved space. That is the property that made this file safe to
 * deploy with one zone out of six live: the page was byte-for-byte what it had
 * been, and with nothing configured anywhere `jads.js` is never even fetched.
 *
 * Every placement below has an id as of 2026-10-18, so nothing exercises that
 * path in production today. It is pinned in `test/ads.test.js` against
 * synthetic placements instead, because it is the behaviour a seventh
 * placement added next month will depend on.
 *
 * The alternative — shipping placeholders that reserve space and say
 * "Advertisement" over an empty rectangle — is worse than having no ads. It
 * costs layout, it tells a visitor the site is monetised without monetising
 * it, and it looks identical to ads that are configured but failing to fill,
 * which is the one thing you need to be able to tell apart when debugging.
 *
 * ## Getting the ids
 *
 * A zone id is created in the JuicyAds publisher dashboard
 * (https://manage.juicyads.com/), one per placement per size. The dashboard
 * emits a full ad tag; the only part needed here is the numeric zone id from
 * it. The rest of the tag is reconstructed by `src/ads/juicyads.js`, which is
 * why the tag shape lives there rather than being pasted in five times.
 *
 * ## Desktop and mobile are different zones, not one zone scaled
 *
 * A 728x90 leaderboard on a 390px phone either overflows the viewport or is
 * scaled to illegibility, and in both cases the impression is wasted and the
 * advertiser is paying for it. JuicyAds publishes a separate mobile size list
 * for exactly this reason, so each placement here names both and the renderer
 * picks one from the viewport at render time.
 *
 * Sizes below are taken from https://www.juicyads.com/ad-types/ — the renderer
 * does not validate them against that list, so a typo here is a zone that
 * serves nothing rather than a build error.
 */

/**
 * The default width below which a placement switches to its mobile size.
 *
 * 760px rather than a round 768: it was chosen for the 728px leaderboard,
 * which needs a little room either side of it before it is worth serving.
 * Below this, the mobile creative is both the honest fit and the one
 * advertisers bid on for phone traffic.
 *
 * This is a default, not a universal rule. A placement whose desktop creative
 * is wider than 760px declares its own `desktopMinWidth`, because a unit
 * served into a container narrower than itself is clipped rather than scaled
 * — see the billboard below.
 */
export const MOBILE_BREAKPOINT_PX = 760;

/**
 * Where ads may appear, in page order.
 *
 * `id` is matched by `adSlotHtml()` and by the CSS, so renaming one means
 * renaming it in three places; the ids are deliberately boring for that
 * reason.
 *
 * A zone id appears exactly once across this whole file. The renderer writes
 * it to the `<ins>` as a DOM id and the loader looks the element back up by
 * it, so the same id in two placements would leave the second one permanently
 * empty — silently, since both would still be valid markup. `test/ads.test.js`
 * pins the uniqueness rather than leaving it to review.
 *
 * @typedef {{zone: number|null, width: number, height: number}} AdSize
 * @typedef {{id: string, label: string, desktopMinWidth?: number,
 *            desktop: AdSize, mobile: AdSize}} AdPlacement
 * @type {AdPlacement[]}
 */
export const AD_PLACEMENTS = [
    {
        id: 'top-skyscraper',
        label: 'Down the right of the first screen',

        // ## Why this one is not laid out as a row
        //
        // Every other placement here is a band the page flows around. A
        // 160x600 cannot be: in the masthead it makes a 600px-tall strip
        // with two buttons floating in the middle of it, and between two
        // shelves it is a narrow column with empty space either side.
        //
        // So it leaves the flow. `.ad-slot-top-skyscraper` is positioned
        // against `#browse-main`, which gives up a column on the right to
        // make room — see the rule of that name in `netflix.css`, and
        // `has-sky-rail` in `browse.js`, which is what couples the two.
        //
        // ## The 1280 floor is about the page, not about the creative
        //
        // Everywhere else `desktopMinWidth` is the width of the unit plus a
        // little room, because a unit served into a narrower container is
        // clipped by the slot's `overflow: hidden`. This unit is 160px wide
        // and would "fit" on a phone. What has to fit is the page beside it:
        // the reserved column costs the content a little over 200px, and
        // `mid-billboard` further down is 908px inside a 4vw gutter, so the
        // narrowest viewport where both still fit is around 1190. 1280 is
        // the next round number above it.
        //
        // Below that the slot renders nothing, the column is not reserved,
        // and the page is exactly what it was before this was added.
        //
        // `mobile.zone` is null. There is no mobile id for this placement,
        // and a 160x600 on a 390px phone is two thirds of the viewport
        // anyway. Pointing it at another placement's mobile zone would put
        // the same id on the page twice and silently empty one of them.
        desktopMinWidth: 1280,
        desktop: { zone: 1129440, width: 160, height: 600 },
        mobile: { zone: null, width: 300, height: 250 }
    },
    {
        id: 'top-leaderboard',

        // Below the cam shelf rather than above it, as of 2026-10-18. With
        // the skyscraper above already drawing at the top of the first
        // screen, a 728x90 directly under the masthead would make the first
        // two things on the page both advertisements. The live rows in
        // between are what keep this one legible as part of a page. The
        // label has always said "above the partner section" and that is
        // still exactly where it is.
        label: 'Above the partner section',
        desktop: { zone: 1129394, width: 728, height: 90 },
        mobile: { zone: 1129396, width: 300, height: 100 }
    },
    {
        id: 'pitch-billboard',
        label: 'Below the partner promo banner',

        // 1129419, back where it started.
        //
        // It spent part of 2026-10-18 as `top-billboard` in the masthead and
        // came back the same day, when the skyscraper above took that
        // position with an id of its own. That is the whole reason this
        // entry can exist again: **a zone id can only be in one placement**,
        // because the renderer writes it to the `<ins>` as a DOM id and the
        // loader looks the element back up by it, so a second copy would be
        // permanently empty. The top slot getting 1129440 freed 1129419
        // rather than leaving this band empty.
        //
        // Same 908x258 and the same 940 floor as `mid-billboard`, for the
        // same reason given there: below that the creative is clipped by the
        // slot's `overflow: hidden` and the advertiser is billed for an ad
        // nobody saw the end of.
        //
        // `mobile.zone` is null — there has never been a mobile id for this
        // position, and the same rule as everywhere else applies: borrowing
        // another placement's would duplicate it.
        desktopMinWidth: 940,
        desktop: { zone: 1129419, width: 908, height: 258 },
        mobile: { zone: null, width: 300, height: 250 }
    },
    {
        id: 'mid-billboard',
        label: 'Between the performer row and the on-demand row',

        // 908x258, not the round 900x250 this placement was sketched at —
        // that is the size the dashboard actually offers, and the numbers
        // here have to match the zone exactly or the reserved space is the
        // wrong shape.
        //
        // It is also the one unit too wide for the default breakpoint. A
        // tablet at 820px would otherwise be served 908px of creative into an
        // 820px box and have the right 88px of it cut off by the slot's
        // `overflow: hidden` — no broken layout, no scrollbar, just an
        // advertiser billed for an ad nobody saw the end of. Below 940 (the
        // creative plus a little room either side) this serves the 300x250
        // instead, which is the right unit for a tablet anyway.
        desktopMinWidth: 940,
        desktop: { zone: 1129400, width: 908, height: 258 },
        mobile: { zone: 1129401, width: 300, height: 250 }
    },
    {
        id: 'footer-leaderboard',
        label: 'Below the last content row',
        desktop: { zone: 1129397, width: 728, height: 90 },
        mobile: { zone: 1129398, width: 300, height: 100 }
    }
];

/**
 * Native units, which are a strip rather than a single placement.
 *
 * Native is the one format where more than one unit side by side reads as
 * intended rather than as a wall of banners, because the whole point of the
 * format is that it matches the surrounding grid — and the surrounding grid
 * here is a row of cards.
 *
 * One zone id per unit. An empty list draws no strip; a list of two draws two.
 * The format is designed to be tiled — 108x140 is a thumbnail, and a single
 * one of them centred in a 1440px page read as a stray image rather than as a
 * row, which is why there are three.
 *
 * Three is also about the ceiling. The strip wraps rather than scrolls, so a
 * fourth is not a layout problem, but a row of thumbnails stops reading as
 * part of this site's grid somewhere around there and starts reading as a
 * banner farm.
 *
 * @type {{zones: number[], width: number, height: number}}
 */
export const NATIVE_STRIP = {
    zones: [1129402, 1129404, 1129405],
    width: 108,
    height: 140
};

/**
 * The unit inside the performer profile card.
 *
 * One size at every viewport, which is why it is not an `AD_PLACEMENTS` entry:
 * 178x30 is narrower than the narrowest phone this site is laid out for, so
 * there is no width at which a different creative would be the honest fit and
 * nothing for `pickSize()` to choose between.
 *
 * It is also the only slot on the page that lives in something built at
 * runtime rather than in a template, and that has one consequence worth
 * stating here rather than only in `browse.js`: the profile card is rewritten
 * on every hover, and re-rendering this `<ins>` with it would file a fresh
 * impression each time. A visitor reading three profiles would be three
 * impressions of one slot, which is the definition of invalid traffic. The
 * card is therefore built so that the ad is a permanent child and only the
 * biography above it is replaced.
 *
 * @type {{zone: number|null, width: number, height: number}}
 */
export const BIO_CARD_AD = { zone: 1129407, width: 178, height: 30 };

/**
 * Hosts that are allowed to load the ad script.
 *
 * The same guard, and the same reasoning, as the GA4 tag in `index.html`:
 * without it every `npm run dev`, every headless test run and every
 * screenshot check files real impressions against the account. An ad network
 * bills advertisers for those, which makes it invalid traffic rather than
 * noise in a dashboard — and invalid traffic is what publisher accounts get
 * closed for.
 *
 * Development therefore renders the slot markup and never fetches `jads.js`,
 * so layout can be checked without serving anything.
 */
export const AD_HOSTS = ['lustxr.com', 'www.lustxr.com'];
