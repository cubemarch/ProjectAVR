/**
 * Deciding whether a click landed on a picture the server covered.
 *
 * Split out of `ui/image-gate.js` so it can be tested. The overlay itself
 * reaches the brand lockup through `ui/age-gate.js`, which imports a PNG, so
 * `node --test` cannot load that module at all; nothing here imports anything,
 * which is the whole point. It is also the half worth pinning: the overlay is
 * visible the moment it is wrong, and this is not.
 *
 * Every function here takes the nodes it works on as arguments rather than
 * reaching for `document`, so a test can pass four plain objects.
 */

/**
 * Endpoints whose every response is covered. See `server/routes/media.js`.
 *
 * Keying on the URL rather than a list of CSS classes means a new shelf is
 * gated the moment its artwork goes through the proxy, and a decorative image
 * never is, with nobody having to remember either. The `\b` after `media`
 * matches `/api/media?...` and `/api/media/...` and not `/api/mediakit`.
 */
export const COVERED = /^\/api\/(?:media\b|cams\/thumb\/)/;

/** Ad slots, which the overlay must never stand in front of. See `src/ads/juicyads.js`. */
export const AD = '.ad-slot, ins.adsbyjuicy';

/** The URL behind an element, whether it got there as `src` or as a background. */
export function imageUrl(el) {
    if (el?.tagName === 'IMG') return el.getAttribute('src') || '';

    // Inline only, deliberately. Reading computed styles on every click walks
    // the cascade for the whole ancestor chain, and every background this
    // needs to see is written as an inline `style` by `ui/browse.js`.
    const inline = el?.getAttribute?.('style') || '';
    const match = /background-image\s*:\s*url\(\s*['"]?([^'")]+)/i.exec(inline);

    return match ? match[1] : '';
}

/**
 * The covered picture at or above `start`, or `null`.
 *
 * @param {Element|null} start Where the click landed.
 * @param {Element|null} stop Ancestor to stop before, exclusive.
 */
export function coveredPicture(start, stop) {
    if (!start) return null;

    // Ad creatives are excluded twice over: they are not served from the
    // covered endpoints, and this skips anything inside an ad slot regardless.
    // Clicking an advert has to reach the advertiser — that is what was sold.
    if (start.closest(AD)) return null;

    // Walk up rather than test the target alone: the click usually lands on
    // the `<img>`, but a card with a background-image swallows it on the
    // wrapper, and an overlaid caption or duration badge swallows it on a
    // `<span>` with no picture of its own.
    for (let el = start; el && el !== stop; el = el.parentElement) {
        if (COVERED.test(imageUrl(el))) return el;
    }

    return null;
}

/**
 * Whether a click was the kind that asks us for the page.
 *
 * Middle-click, ctrl-click and the rest are "open in a new tab", and a visitor
 * who does that has not asked us anything; cancelling one would eat an
 * interaction the browser was going to handle.
 */
export function isPlainLeftClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
