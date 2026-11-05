/**
 * House banners: partner creatives we hold ourselves, for the visitor who has
 * not passed the gate.
 *
 * Added 2026-11-05, the day the JuicyAds SFW zone was switched off for serving
 * an adult creative (see `top-leaderboard` in `zones.js`). The problem with a
 * network zone is that the auction picks the image and we never hold it, so
 * nothing on our side can look at it first. These are the opposite: a fixed
 * image, chosen by hand, linked to a storefront in `catalog/affiliates.js`.
 *
 * **They still go through the censor, every time.** David supplied these as
 * SFW, and if they are, covering changes nothing a visitor can see. If any
 * part of one is not — the scene thumbnails along the edges of the 728x90 are
 * the likeliest — it is covered, which is the rule for every other partner
 * image on the page. `/api/house/:id` (`server/routes/house.js`) serves the
 * covered copy or the placeholder and has no branch that returns the file as
 * shipped, the same as `/api/media`.
 *
 * Only an unverified visitor is shown one. A verified visitor gets the paying
 * zones instead, so a house banner's only job is the slot that would
 * otherwise be empty.
 *
 * @typedef {{file: string, width: number, height: number,
 *            storefront: string, alt: string}} HouseAd
 * @type {Readonly<Record<string, HouseAd>>}
 */
export const HOUSE_ADS = Object.freeze({
    'slr-premium': {
        file: 'slr-premium-728x90.png',
        width: 728,
        height: 90,
        storefront: 'slr-tour',
        alt: 'SLR Premium — over 2,000 VR videos in one subscription'
    },
    'slr-library': {
        file: 'slr-library-300x250.png',
        width: 300,
        height: 250,
        storefront: 'slr-tour',
        alt: 'SexLikeReal — the biggest VR library, top studios, 5,000 videos'
    },
    'slr-library-4k': {
        file: 'slr-library-4k-300x250.png',
        width: 300,
        height: 250,
        storefront: 'slr-tour',
        alt: 'SexLikeReal — the biggest VR library, in 4K 3D at 60fps'
    }
});

/** Where the covered copy of a house banner is served. */
export const houseAdSrc = (id) => `/api/house/${encodeURIComponent(id)}`;
