import { EVENTS, track } from './analytics.js';

/**
 * The first time a person, rather than a page load, did something.
 *
 * ## Why this exists
 *
 * The first week of Analytics (2026-10-18 to 25) could not say how many
 * visitors there were. Of 63 users, about a dozen were single loads from as
 * many countries, each logging exactly `page_view`, `session_start` and
 * `first_visit` and spending no time at all — the shape of a headless browser
 * that runs the tag and leaves. GA4's own signals do not separate them:
 * `user_engagement` only needs the tab to be in the foreground, which a
 * headless browser always is, and an "engaged session" can be earned by
 * sitting still for ten seconds.
 *
 * What a loader that never interacts cannot produce is input. So this waits
 * for the first press, key or wheel turn the browser itself vouches for and
 * reports it once. A report built on "users with `first_interaction`" is a
 * count of somebody, and the ones without it are the noise.
 *
 * It filters the passive loaders, not every bot. Input driven through the
 * DevTools protocol arrives trusted, and a crawler built to look human will.
 * That is fine: the ones it removes are the ones that were most of the count.
 *
 * ## What is deliberately not an interaction
 *
 * `scroll`, because `scrollTo` raises a trusted one with no person involved —
 * a wheel or a touch is what a scrolling human produces first. `focus`,
 * `mousemove` and `visibilitychange` for the same reason in other forms: a
 * window can gain them without anybody being there.
 *
 * ## What is sent
 *
 * Two categorical parameters, under the rule at the head of `analytics.js`:
 * which kind of input it was, and how long after the page started, in four
 * coarse bands. The band is what distinguishes a reflexive click on the
 * age gate from somebody who read for half a minute first, and it is the
 * same four strings for everybody.
 */

/** The inputs listened for. Each says which kind it was through {@link inputOf}. */
const TYPES = ['pointerdown', 'keydown', 'wheel'];

/** `pointerType` values worth keeping apart. Anything else is a `pointer`. */
const POINTERS = new Set(['mouse', 'touch', 'pen']);

/**
 * Coarse bands for how long the visitor took. Ordered, and named so that a
 * report sorted alphabetically still reads in order.
 *
 * @param {number} ms milliseconds since the page started
 * @returns {string}
 */
export function delayBand(ms) {
    if (ms < 1000) return 'a_under_1s';
    if (ms < 5000) return 'b_1_to_5s';
    if (ms < 30000) return 'c_5_to_30s';
    return 'd_over_30s';
}

/**
 * Which kind of input an event was, as one of a fixed handful of strings.
 *
 * @param {{type: string, pointerType?: string}} event
 * @returns {string}
 */
export function inputOf(event) {
    if (event.type === 'keydown') return 'key';
    if (event.type === 'wheel') return 'wheel';
    return POINTERS.has(event.pointerType) ? event.pointerType : 'pointer';
}

/**
 * Report the first trusted input on this page, once.
 *
 * Listens in the capture phase so nothing on the page can stop it first, and
 * passively so it can never delay a scroll or a click — measurement must not
 * be the reason a link does not follow. Every listener is removed on the
 * first report, so a long visit carries no cost for it after the first second.
 *
 * Once per load rather than once per session: a reload is a fresh document
 * that a bot can load just as easily, and the question is asked of each one.
 *
 * @param {EventTarget} [target]
 * @param {() => number} [now] milliseconds since the page started
 * @returns {() => void} removes the listeners without reporting
 */
export function watchFirstInteraction(target = window, now = () => performance.now()) {
    const options = { capture: true, passive: true };
    let reported = false;

    const stop = () => {
        for (const type of TYPES) target.removeEventListener(type, onInput, options);
    };

    function onInput(event) {
        // A `dispatchEvent` from script is untrusted. That is the one kind of
        // input a page can fake on its own, so it is the one that never counts.
        if (reported || !event.isTrusted) return;

        reported = true;
        stop();

        const input = inputOf(event);
        const after = delayBand(now());
        track(EVENTS.FIRST_INTERACTION, { input, after });
    }

    for (const type of TYPES) target.addEventListener(type, onInput, options);

    return stop;
}
