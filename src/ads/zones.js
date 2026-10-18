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
 * Every placement ships with `zone: null`, and a placement with no zone id
 * **draws nothing at all** — not a box, not a label, not reserved space. That
 * is deliberate and it is the property that makes this file safe to deploy
 * before the account has any zones in it: the page is byte-for-byte what it
 * was, and `jads.js` is never even fetched.
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
 * The breakpoint at which a placement switches to its mobile size.
 *
 * 760px rather than a round 768: the widest desktop unit used here is the
 * 728px leaderboard, and it needs the page gutter (`4vw`) to fit either side
 * of it before it is worth serving. Below this, the mobile creative is both
 * the honest fit and the one advertisers bid on for phone traffic.
 */
export const MOBILE_BREAKPOINT_PX = 760;

/**
 * Where ads may appear, in page order.
 *
 * `id` is matched by `adSlotHtml()` and by the CSS, so renaming one means
 * renaming it in three places; the ids are deliberately boring for that
 * reason.
 *
 * @typedef {{zone: number|null, width: number, height: number}} AdSize
 * @typedef {{id: string, label: string, desktop: AdSize, mobile: AdSize}} AdPlacement
 * @type {AdPlacement[]}
 */
export const AD_PLACEMENTS = [
    {
        id: 'top-leaderboard',
        label: 'Above the partner section',

        // The only live zone as of 2026-10-18. Taken from the dashboard tag
        // `<ins id="1129394" data-width="728" data-height="90">`.
        desktop: { zone: 1129394, width: 728, height: 90 },

        // No mobile counterpart exists yet, so **phones see no ad here**. That
        // is the deliberate choice over serving the 728 wide unit to a 390pt
        // screen: a fixed-size creative in a narrower box is clipped, not
        // shrunk, and scaling it with a CSS transform misrepresents the
        // creative to the advertiser paying for the impression.
        //
        // Create a 300x100 Mobile Medium zone in the dashboard and paste the
        // id here; nothing else needs to change.
        mobile: { zone: null, width: 300, height: 100 }
    },
    {
        id: 'mid-billboard',
        label: 'Between the performer row and the on-demand row',
        desktop: { zone: null, width: 900, height: 250 },
        mobile: { zone: null, width: 300, height: 250 }
    },
    {
        id: 'footer-leaderboard',
        label: 'Below the last content row',
        desktop: { zone: null, width: 728, height: 90 },
        mobile: { zone: null, width: 300, height: 100 }
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
 * Three is the most that fits beside the 300px cards this site already uses
 * without the strip looking like a different website.
 *
 * @type {{zones: number[], width: number, height: number}}
 */
export const NATIVE_STRIP = {
    zones: [],
    width: 300,
    height: 300
};

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
