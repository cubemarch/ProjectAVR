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
 * **It loads only when there is a new slot to fill.** Not once — once was
 * wrong, and `drainQueue()` below is the long version of why: the network's
 * loader reads its queue a single time per execution, so slots this site
 * inserts after the first paint need a fresh copy or they never fill. What
 * replaces the one-shot guard is `data-ad-filled`, which bounds the loads to
 * batches of genuinely new slots. `_renderAffiliates()` re-writing the same
 * markup on every refresh costs nothing.
 *
 * ## The tag shape is in one function, on purpose
 *
 * `adSlotHtml()` and `fillAdSlots()` between them reconstruct what the
 * JuicyAds dashboard emits as a copy-paste block: the `jads.js` script, an
 * `<ins>` carrying the zone id and its dimensions, and a push onto the
 * `adsbyjuicy` queue. It is reconstructed rather than pasted because pasting
 * the block once per slot puts the loader in the page once per slot.
 *
 * Checked against all twelve generated tags (zones 1129394, 1129396, 1129397,
 * 1129398, 1129400, 1129401, 1129402, 1129404, 1129405, 1129407, 1129419 and
 * 1129440, 2026-10-18), which differ from each other only in the id and the
 * two dimensions:
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

import { AD_HOSTS, AD_PLACEMENTS, BIO_CARD_AD, MOBILE_BREAKPOINT_PX, NATIVE_STRIP } from './zones.js';
import { ageOk } from '../age-state.js';

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
 * The gate on fetching `jads.js`. Checks the strip and the profile card as
 * well as the placements, because a site running only native units — or only
 * the one unit inside the hover card — is a legitimate configuration, and a
 * gate that missed it would leave a configured zone permanently unfilled.
 */
export function anyZonesConfigured() {
    const inPlacements = AD_PLACEMENTS.some(
        (p) => cleanZone(p.desktop.zone) || cleanZone(p.mobile.zone)
    );
    return (
        inPlacements ||
        sfwZones().size > 0 ||
        NATIVE_STRIP.zones.some((z) => cleanZone(z)) ||
        Boolean(cleanZone(BIO_CARD_AD.zone))
    );
}

/**
 * Every zone an unverified visitor may be served: the `sfw` pairs, and nothing
 * else. See the `sfw` section of `zones.js`.
 *
 * @param {object[]} [placements]
 * @returns {Set<number>}
 */
export function sfwZones(placements = AD_PLACEMENTS) {
    const zones = new Set();
    for (const p of placements) {
        for (const tier of ['desktop', 'mobile']) {
            const zone = cleanZone(p.sfw?.[tier]?.zone);
            if (zone) zones.add(zone);
        }
    }
    return zones;
}

/**
 * Whether this zone may be queued for this visitor.
 *
 * Any configured zone for a verified visitor; an SFW zone and only an SFW zone
 * for anybody else. This is the second of the two checks — the first is that
 * {@link adSlotHtml} never builds an adult slot for an unverified visitor — and
 * it exists so that one mistake in markup is not enough. A slot that reaches the
 * DOM by a route that forgot `verified` is still never handed to the network.
 *
 * @param {number|null} zone
 * @param {{verified?: boolean, placements?: object[]}} [opts]
 * @returns {boolean}
 */
export function mayServe(zone, { verified = ageOk(), placements = AD_PLACEMENTS } = {}) {
    if (!cleanZone(zone)) return false;
    return verified || sfwZones(placements).has(cleanZone(zone));
}

/**
 * Whether this page may file impressions at all.
 *
 * Two halves. The host check keeps development out of the account, and the
 * configuration check means a production deploy with no zones yet behaves
 * exactly like today's site rather than like a broken one. Who may be served
 * which zone is decided per zone, by {@link mayServe} — the subject of the
 * section below.
 *
 * ## An ad cannot be run through the censor, so it is not run at all
 *
 * The instruction this implements was "run all images and artwork including
 * ads through the censor" (David, 2026-10-20). Everything else on the page
 * can be: `server/media/proxy.js` mints a signed URL, the server fetches the
 * image, the inference service pixelates it, and the visitor gets the covered
 * copy. An ad cannot go through that pipeline, for reasons that are the ad
 * network's design rather than an omission here:
 *
 *   - **There is no URL to sign.** The creative is chosen by an auction that
 *     runs at display time. Nothing on our side knows what image will be
 *     shown until the network's loader has already shown it.
 *   - **We never hold the bytes.** `jads.js` replaces the `<ins>` with its own
 *     children in the visitor's browser, from the network's own CDN. A server
 *     side image proxy is not in that path and cannot be put in it.
 *   - **Many creatives are not images.** A fair share of the inventory is an
 *     iframe or a video. There is nothing for an image censor to censor.
 *   - **Interposing would break the thing being paid for.** The impression is
 *     counted by the script that draws the creative, and the advertiser is
 *     paying for that count. Re-serving creatives from our own origin would
 *     file impressions the network cannot attribute, which is the definition
 *     of invalid traffic and the category publisher accounts are closed over.
 *
 * So the rule — an unverified visitor does not see genitals — is enforced the
 * only way it can be here: the adult slots are not drawn and their zones are
 * never queued. Until 2026-11-02 that meant an unverified visitor saw no ads
 * at all. Since then they are served the zones in each placement's `sfw` pair,
 * which the dashboard restricts to SFW creatives, and nothing else. That moves
 * the covering for those slots from our censor to the network's own category
 * review, which is the one trade in this file that does not fail closed; it
 * is bounded to the zones `zones.js` names as `sfw`, and a placement without
 * one still draws nothing.
 *
 * `ageOk()` is false until the server has answered, so the first paint of a
 * page whose gate fetch is still in flight gets the SFW slots too. `main.js`
 * resolves the state before the rows that contain them render, and a visitor
 * who passes the gate reloads into the adult ones.
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
 * `verified` is the third seam and the reason all three exist as parameters
 * rather than as reads of global state: an unverified visitor gets the
 * placement's `sfw` pair or no slot at all — see {@link adsEnabled} for why an
 * ad cannot be covered the way the artwork around it is — and "never an adult
 * zone until verified" is a property worth asserting from a test rather than
 * inferring from a module-level flag.
 *
 * @param {string} placementId
 * @param {{viewportWidth?: number, placements?: object[], verified?: boolean}} [opts]
 * @returns {string}
 */
export function adSlotHtml(
    placementId,
    { viewportWidth = viewport(), placements = AD_PLACEMENTS, verified = ageOk() } = {}
) {
    const placement = placements.find((p) => p.id === placementId);
    if (!placement) return '';

    // The SFW pair replaces both tiers rather than being merged with them, so
    // an unset SFW tier is an empty slot, never a fall-through to the adult
    // zone at that size. The floor stays the placement's own.
    if (!verified && !placement.sfw) return '';
    const tiers = verified ? placement : { ...placement, ...placement.sfw };

    const size = pickSize(tiers, viewportWidth);
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
 * @param {{verified?: boolean}} [opts]
 * @returns {string}
 */
export function nativeStripHtml(strip = NATIVE_STRIP, { verified = ageOk() } = {}) {
    if (!verified) return '';

    const units = strip.zones
        .map((z) => cleanZone(z))
        .filter(Boolean)
        .map((zone) => slotHtml(zone, strip.width, strip.height, 'ad-slot-native'))
        .join('');

    return units ? `<div class="ad-strip">${units}</div>` : '';
}

/**
 * The unit inside the performer profile card, as HTML.
 *
 * No viewport argument, because there is only one size — see `BIO_CARD_AD` in
 * `zones.js`. Still returns `''` when unconfigured, so the card is built
 * without an ad in it rather than with an empty labelled box in the middle of
 * somebody's biography.
 *
 * @param {{zone: number|null, width: number, height: number}} [unit]
 * @param {{verified?: boolean}} [opts]
 * @returns {string}
 */
export function bioCardAdHtml(unit = BIO_CARD_AD, { verified = ageOk() } = {}) {
    if (!verified) return '';

    const zone = cleanZone(unit.zone);
    if (!zone) return '';

    return slotHtml(zone, unit.width, unit.height, 'ad-slot-bio-card');
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
 * Hand the queue to the network, once per batch of newly-registered slots.
 *
 * ## `jads.js` is not a resident drainer, and this module used to assume it was
 *
 * The loader reads `window.adsbyjuicy` exactly once — at the moment it
 * executes — fills every zone whose `<ins>` is in the DOM right then, and
 * never looks again. There is no callback, no second pass and no observer. A
 * zone pushed after that moment stays in the array for the life of the page
 * and never fills, silently, because from the network's side nothing asked
 * for it.
 *
 * That is fatal here, because this site inserts most of its slots after the
 * first paint. Only `top-skyscraper` and `top-leaderboard` are in the initial
 * render; the pitch billboard and the mid billboard arrive when the partner
 * feed answers, the native strip and the footer leaderboard arrive with the
 * content rows, and the profile card's unit is not built until somebody hovers
 * a performer. Loading the script once — which this module did, deliberately,
 * to keep one copy in the head — filled the two early slots and abandoned the
 * rest. The symptom is the one `zones.js` warns is hardest to read: a
 * labelled, correctly-sized, permanently empty box, indistinguishable from an
 * ad that no advertiser bid on.
 *
 * So a fresh copy is appended per batch. Three things make that safe rather
 * than a way to bill an advertiser twice:
 *
 *   - **It re-runs.** The loader's guard is `if (!a || !a.loaded)`, and the
 *     flag it sets on the way out is `a.adsbyjuicy.loaded` — a different
 *     property, which `a.loaded` never becomes. A second copy therefore
 *     drains again, which is the behaviour relied on here.
 *   - **It cannot fill the same zone twice.** It finishes each one by
 *     replacing the `<ins>` with its own children, so the element
 *     `getElementById(zone)` would have found is gone and that entry is
 *     skipped on every later pass, however many times the queue is re-read.
 *   - **It is not asked to.** `data-ad-filled` stops this module pushing a
 *     zone it has already pushed, so the re-read is over old entries plus the
 *     new batch, never a duplicate of the new batch.
 *
 * The tag removes itself once it has run. The fill happens synchronously
 * inside its own execution, so there is nothing left to keep, and a page where
 * every hover appends a permanent `<script>` to the head is a leak. What does
 * accumulate is the network's own `message` listener and its 1x1 position
 * probe, one per drain — theirs to own, cheap, and not worth fighting.
 */
function drainQueue() {
    const tag = document.createElement('script');
    tag.async = true;
    tag.src = AD_SCRIPT_SRC;
    tag.setAttribute('data-cfasync', 'false');

    const done = () => tag.remove();
    tag.addEventListener('load', done);
    tag.addEventListener('error', done);

    document.head.appendChild(tag);
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
 * The queue is pushed to *before* the drainer is appended, and both happen in
 * one synchronous pass. That ordering is the whole contract: the loader fills
 * from the array as it finds it at execution time, so a zone queued after it
 * runs is a zone that never fills, and an `<ins>` inserted after it runs is a
 * zone it could not find. Doing both here, together, is what guarantees
 * neither can happen.
 *
 * @param {ParentNode} [root]
 */
export function fillAdSlots(root = document) {
    if (!adsEnabled()) return;

    const slots = [...root.querySelectorAll('ins.adsbyjuicy:not([data-ad-filled])')];
    if (!slots.length) return;

    window[AD_QUEUE] = window[AD_QUEUE] || [];

    let queued = 0;
    for (const ins of slots) {
        const zone = cleanZone(ins.id);
        if (!zone) continue;

        // Left unmarked, not marked and skipped: it was never asked for, and
        // the reload on passing the gate rebuilds the page anyway.
        if (!mayServe(zone)) continue;

        ins.setAttribute('data-ad-filled', '');
        window[AD_QUEUE].push({ adzone: zone });
        queued++;
    }

    // Nothing new to fill means nothing to ask for. Without this, a refresh
    // that re-rendered only unconfigured slots would still fetch the loader.
    if (queued) drainQueue();
}
