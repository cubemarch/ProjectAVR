/**
 * What this site measures, in one list.
 *
 * GA4 is loaded in `index.html` and `live.html` — the measurement id is in the
 * page source, and only the production hosts fetch the remote tag, so `gtag`
 * exists everywhere but calls from a development server or a test run queue
 * onto `dataLayer` and are never drained. That is what makes {@link track}
 * safe to call from anywhere without an environment check of its own.
 *
 * ## Why a module rather than `gtag(...)` at each call site
 *
 * Three reasons, and the third is the one that matters.
 *
 * First, an inventory. Everything this site reports is named in
 * {@link EVENTS}, so the question "what do we collect" has a file to answer it
 * rather than a grep. The privacy policy makes a promise about this and has to
 * be kept in step with it.
 *
 * Second, a typo in an event name is otherwise silent. There is no error and
 * no missing data — just a second event with a slightly different name that
 * nobody has built a report on, discovered months later.
 *
 * Third, the rule below has somewhere to live.
 *
 * ## Nothing here may identify anybody
 *
 * Every parameter sent from here is *categorical*: which method passed the
 * gate, which partner a link went to, which shelf a card came from. Never a
 * user id, an email, a session id, an age-check reference, or a title a
 * particular person opened.
 *
 * This is not a general preference, it is two specific commitments. The
 * privacy policy says Analytics "is configured for aggregate measurement — we
 * read it as totals, not as a record of what any one person watched", and
 * `server/identity/visitor-gate.js` deliberately keeps the identity provider's
 * inquiry id out of the response body so that "a reference the page never sees
 * is one it cannot leak into a URL or an analytics beacon". A page that then
 * put one here would have defeated both.
 *
 * `test/analytics.test.js` pins it.
 */

/**
 * Every event this site sends.
 *
 * GA4 wants snake_case, at most 40 characters, and not one of the reserved
 * names. `search` is deliberately the GA4 recommended event rather than a
 * custom one, because the standard name is the one its built-in reports read.
 */
export const EVENTS = Object.freeze({
    /** The gate was drawn. The denominator for everything below it. */
    AGE_GATE_SHOWN: 'age_gate_shown',

    /** The visitor is through, by whichever route. Always exactly one per load. */
    AGE_GATE_PASSED: 'age_gate_passed',

    /** A check came back saying no. Rare, and the thing to watch after a provider change. */
    AGE_GATE_FAILED: 'age_gate_failed',

    /** The visitor took the way out instead. */
    AGE_GATE_LEFT: 'age_gate_left',

    /** A partner's storefront, from the masthead. Today that is "All Movies" at AEBN. */
    STOREFRONT_CLICK: 'storefront_click',

    /** A card in a partner row — a title or a performer. */
    AFFILIATE_CLICK: 'affiliate_click',

    /** A cam room opened in the on-page theatre. Not yet a visit to the partner. */
    CAM_OPEN: 'cam_open',

    /** A cam room actually followed out to the partner. */
    CAM_CLICK: 'cam_click',

    /** The cam row's search box. GA4's recommended name, for its built-in report. */
    SEARCH: 'search'
});

/**
 * Report one thing that happened.
 *
 * Fire-and-forget by design: an analytics call must never be awaited, never
 * throw into a click handler, and never be the reason a link does not
 * navigate. `gtag` already sends over `navigator.sendBeacon` where it can, so
 * a report survives the page going away without any help here.
 *
 * Parameters that are `null` or `undefined` are dropped rather than sent as
 * empty strings, so a missing value is absent from the report instead of
 * becoming a populated-looking `(not set)` bucket.
 *
 * @param {string} name one of {@link EVENTS}
 * @param {Record<string, string | number | boolean>} [params] categorical only — see the
 *   note on identifiers at the top of this file
 */
export function track(name, params = {}) {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;

    const clean = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === '') continue;
        clean[key] = value;
    }

    try {
        window.gtag('event', name, clean);
    } catch {
        // Measurement is never worth a broken page. An ad blocker replacing
        // `gtag` with something that throws is the ordinary case here, and it
        // must not take a navigation or an age check down with it.
    }
}

/**
 * A jurisdiction, flattened to one string a report can group by.
 *
 * `publicPolicy` in `server/identity/jurisdiction.js` sends `country` and
 * `region` separately — `US` and `TX` — and the pair is what the statutes in
 * `docs/STATE-AGE-LAWS.md` turn on, so they are rejoined here into the
 * `US-TX` form those documents use. Country alone when the region did not
 * resolve, which is a state the gate treats as requiring verification and so
 * is worth being able to count.
 *
 * Nothing finer than this is ever sent. A region is a legal category, not a
 * location: it is the same string for everybody in the state.
 *
 * @param {{region?: string | null, country?: string | null} | null | undefined} jurisdiction
 * @returns {string | undefined}
 */
export function regionOf(jurisdiction) {
    const country = jurisdiction?.country;
    const region = jurisdiction?.region;

    if (country && region) return `${country}-${region}`;
    return country || region || undefined;
}
