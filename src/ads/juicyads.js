/**
 * JuicyAds, rendered into a single-page app.
 *
 * ## Why this is not the approach `catalog/affiliates.js` takes
 *
 * That file refuses the partner's drop-in widget and reads their JSON feed
 * instead, for four reasons written at the top of it. Three of those reasons
 * still apply here, and the fourth no longer matters, but the conclusion
 * inverts anyway — so the difference is worth stating rather than leaving as
 * an apparent inconsistency.
 *
 * An affiliate feed is data: a list of films, which this site can lay out
 * itself and link to. An ad is not data. The creative is chosen by an auction
 * that runs at display time, the impression is counted by the script that
 * draws it, and the advertiser is paying for that count. There is no JSON
 * endpoint that returns "the ad", and reimplementing the slot locally would
 * mean serving creatives nobody bid on and billing nobody for them.
 *
 * So the network's script does run here. What this module does is bound it:
 * it loads once, it loads only where it should, and it loads only when there
 * is something for it to fill.
 *
 * ## The three bounds
 *
 * **It does not load in development.** `AD_HOSTS` gates it to the production
 * hostnames, for the same reason the GA4 tag in `index.html` is gated. An
 * impression filed from a dev server or a headless screenshot run is one an
 * advertiser is charged for, which makes it invalid traffic — the category
 * publisher accounts are closed over, not a rounding error in a dashboard.
 *
 * **It does not load with nothing configured.** If no zone anywhere has an
 * id, `jads.js` is never requested and no markup is emitted, so this whole
 * subsystem cost a deployed site exactly nothing in the window between it
 * being written and the first id being pasted into `zones.js`, and costs
 * nothing again if the ids are ever taken back out.
 *
 * **It loads once.** `_scriptPromise` is the guard. `_renderAffiliates()` runs
 * again on every refresh and re-writes the slot markup each time, and without
 * this each of those would append another copy of a third-party script to the
 * head.
 *
 * ## The tag shape is in one function, on purpose
 *
 * `adSlotHtml()` and `fillAdSlots()` between them reconstruct what the
 * JuicyAds dashboard emits as a copy-paste block: the `jads.js` script, an
 * `<ins>` carrying the zone id and its dimensions, and a push onto the
 * `adsbyjuicy` queue. It is reconstructed rather than pasted because pasting
 * the block once per slot puts the loader in the page once per slot.
 *
 * Checked against all seven generated tags (zones 1129394, 1129396, 1129397,
 * 1129398, 1129400, 1129401 and 1129402, 2026-10-18), which differ from each
 * other only in the id and the two dimensions:
 *
 *     <script type="text/javascript" data-cfasync="false" async
 *             src="https://poweredby.jads.co/js/jads.js"></script>
 *     <ins id="1129394" data-width="728" data-height="90"></ins>
 *     <script type="text/javascript" data-cfasync="false" async>
 *       (adsbyjuicy = window.adsbyjuicy || []).push({'adzone':1129394});
 *     </script>
 *
 * The one addition is `class="adsbyjuicy"` on the `<ins>`, which the network
 * does not emit and does not read. It is what `fillAdSlots()` selects on, so
 * that finding this site's ad slots does not mean matching every element whose
 * id happens to be numeric.
 *
 * If the dashboard's generated tag ever differs from this — a different host
 * for the script, a different attribute on the `<ins>` — this is the only
 * file to change, and `AD_SCRIPT_SRC` plus `slotHtml()` are the only two
 * things in it that encode the format.
 */

import { AD_HOSTS, AD_PLACEMENTS, MOBILE_BREAKPOINT_PX, NATIVE_STRIP } from './zones.js';

/**
 * The network's loader.
 *
 * `data-cfasync="false"` is on the injected tag because this site is behind
 * Cloudflare, and Rocket Loader defers third-party scripts by rewriting them
 * — which breaks a queue-draining loader like this one by letting the pushes
 * happen before the drainer is defined.
 */
export const AD_SCRIPT_SRC = 'https://poweredby.jads.co/js/jads.js';

/** The global the loader drains, named the way the network's own tag names it. */
const AD_QUEUE = 'adsbyjuicy';

let _scriptPromise = null;

/* ------------------------------------------------------------ selection -- */

/**
 * A zone id, or `null` if this one is not configured.
 *
 * Coerced and range-checked rather than trusted: `zones.js` is hand-edited
 * from a dashboard, and a zone id pasted with a stray quote would otherwise
 * reach `adSlotHtml()` as a string and be interpolated straight into markup.
 * A bad value is treated as "not configured", which fails to the inert state
 * rather than to a broken slot.
 *
 * @param {unknown} zone
 * @returns {number|null}
 */
export function cleanZone(zone) {
    const n = Number(zone);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Which creative size a placement uses at this viewport.
 *
 * Takes the width rather than reading `window`, so the choice is testable
 * without a DOM and so a caller rendering a template string does not have to
 * be in a browser.
 *
 * `MOBILE_BREAKPOINT_PX` is the floor for most placements but not all of
 * them: it was picked for a 728px leaderboard, and a placement with a wider
 * desktop creative sets its own `desktopMinWidth`. Serving a unit into a
 * container narrower than itself clips it — the slot's `overflow: hidden`
 * takes the right edge off rather than letting the page scroll sideways —
 * so the floor has to track the creative, not the other way round.
 *
 * @param {object} placement
 * @param {number} viewportWidth
 */
export function pickSize(placement, viewportWidth) {
    const floor = placement.desktopMinWidth || MOBILE_BREAKPOINT_PX;
    return viewportWidth < floor ? placement.mobile : placement.desktop;
}

/** @returns {number} the current viewport width, or a desktop default off-DOM. */
function viewport() {
    return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

/**
 * Whether anything at all is configured.
 *
 * The gate on fetching `jads.js`. Checks the strip as well as the placements,
 * because a site running only native units is a legitimate configuration.
 */
export function anyZonesConfigured() {
    const inPlacements = AD_PLACEMENTS.some(
        (p) => cleanZone(p.desktop.zone) || cleanZone(p.mobile.zone)
    );
    return inPlacements || NATIVE_STRIP.zones.some((z) => cleanZone(z));
}

/**
 * Whether this page may file impressions.
 *
 * Both halves matter. The host check keeps development out of the account;
 * the configuration check means a production deploy with no zones yet behaves
 * exactly like today's site rather than like a broken one.
 */
export function adsEnabled() {
    if (typeof window === 'undefined') return false;
    if (!anyZonesConfigured()) return false;
    return AD_HOSTS.includes(window.location.hostname);
}

/* -------------------------------------------------------------- markup -- */

/**
 * One slot, as HTML, ready to go into a template string.
 *
 * Returns `''` — not a placeholder — when the placement is unknown or its
 * zone for this viewport is unset. See the header of `zones.js` for why an
 * empty labelled box is the wrong failure.
 *
 * The width and height go on as a CSS custom property *and* as the `<ins>`
 * attributes the network reads. The custom property is what reserves the
 * space before the creative arrives: an ad that pushes the page down when it
 * fills is the layout shift every content site is judged on, and it is
 * entirely avoidable when the size is known in advance, which for a fixed ad
 * size it always is.
 *
 * `placements` is a seam, for the same reason `viewportWidth` is one. Every
 * real placement currently has a zone id, so the live configuration no longer
 * exercises the empty-zone path at all — and that path is the whole safety
 * property of this module. Passing a synthetic list is how it stays tested.
 *
 * @param {string} placementId
 * @param {{viewportWidth?: number, placements?: object[]}} [opts]
 * @returns {string}
 */
export function adSlotHtml(placementId, { viewportWidth = viewport(), placements = AD_PLACEMENTS } = {}) {
    const placement = placements.find((p) => p.id === placementId);
    if (!placement) return '';

    const size = pickSize(placement, viewportWidth);
    const zone = cleanZone(size.zone);
    if (!zone) return '';

    return slotHtml(zone, size.width, size.height, `ad-slot-${placementId}`);
}

/**
 * The native strip, as HTML.
 *
 * Drawn as a row of equal units rather than as individual slots so that two
 * configured zones centre as a pair instead of leaving a gap where the third
 * would be.
 *
 * Takes the strip as a parameter for the same reason `adSlotHtml` takes a
 * placement list: the configured strip is no longer empty, so "an empty strip
 * draws nothing" has to be checked against one that is.
 *
 * @param {{zones: number[], width: number, height: number}} [strip]
 * @returns {string}
 */
export function nativeStripHtml(strip = NATIVE_STRIP) {
    const units = strip.zones
        .map((z) => cleanZone(z))
        .filter(Boolean)
        .map((zone) => slotHtml(zone, strip.width, strip.height, 'ad-slot-native'))
        .join('');

    return units ? `<div class="ad-strip">${units}</div>` : '';
}

/**
 * The markup the network's own tag uses, with the label this site adds.
 *
 * The label is not decoration. An ad sitting directly beneath a row of paid
 * affiliate links, in the same card styling, is indistinguishable from
 * editorial unless it says what it is — and the affiliate disclosure above it
 * makes a specific claim ("we earn a commission on sales") that is not true
 * of a CPM banner. Two different things being paid for in two different ways
 * need two different labels.
 */
function slotHtml(zone, width, height, className) {
    return (
        `<aside class="ad-slot ${className}" style="--ad-w:${width}px;--ad-h:${height}px">` +
        `<span class="ad-label">Advertisement</span>` +
        `<ins class="adsbyjuicy" id="${zone}" data-width="${width}" data-height="${height}"></ins>` +
        `</aside>`
    );
}

/* --------------------------------------------------------------- fill -- */

/**
 * Fetch the loader, once.
 *
 * Resolves when the script is in the head, not when it has drawn anything —
 * the queue is drained asynchronously by the network's own code and there is
 * no callback for "filled". A failure resolves rather than rejects: an ad
 * network being unreachable is not a reason for a caller to take a branch,
 * and there is nothing to retry that the browser is not already retrying.
 *
 * @returns {Promise<void>}
 */
export function loadAdScript() {
    if (_scriptPromise) return _scriptPromise;

    _scriptPromise = new Promise((resolve) => {
        const tag = document.createElement('script');
        tag.async = true;
        tag.src = AD_SCRIPT_SRC;
        tag.setAttribute('data-cfasync', 'false');
        tag.addEventListener('load', () => resolve());
        tag.addEventListener('error', () => resolve());
        document.head.appendChild(tag);
    });

    return _scriptPromise;
}

/**
 * Register every slot currently in the DOM with the network.
 *
 * Call after the markup is inserted, never before: the loader looks the
 * `<ins>` up by id when it drains the queue, and a zone pushed before its
 * element exists is a zone that silently never fills.
 *
 * Pushing is idempotent per element, not per call — `data-ad-filled` marks
 * the ones already registered, because `_renderAffiliates()` re-runs and
 * would otherwise push the same zone again on every refresh and have the
 * network count it twice.
 *
 * @param {ParentNode} [root]
 */
export function fillAdSlots(root = document) {
    if (!adsEnabled()) return;

    const slots = [...root.querySelectorAll('ins.adsbyjuicy:not([data-ad-filled])')];
    if (!slots.length) return;

    loadAdScript();

    window[AD_QUEUE] = window[AD_QUEUE] || [];

    for (const ins of slots) {
        const zone = cleanZone(ins.id);
        if (!zone) continue;

        ins.setAttribute('data-ad-filled', '');
        window[AD_QUEUE].push({ adzone: zone });
    }
}

/** Test seam: forget the one-shot script guard. */
export function resetAdScriptForTests() {
    _scriptPromise = null;
}
