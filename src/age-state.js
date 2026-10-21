/**
 * What the server last said about this visitor's age, held in one place.
 *
 * Three modules need the answer and none of them should be asking for it
 * separately: `ui/age-gate.js` draws the banner and the dialog from it,
 * `ads/juicyads.js` refuses to request an ad without it, and the browse UI
 * labels covered rows with it. Before this existed the gate was a blocking
 * `await` and the answer was implicit — there was nothing to coordinate,
 * because nothing else ran until the visitor was through.
 *
 * It is deliberately not a cache of the *server's* decision. The server
 * decides for itself on every request, from the cookie, and covers artwork
 * accordingly; nothing here can talk it out of that. This is the client's copy
 * so the page can describe what is happening, and the worst a stale or forged
 * value can do is draw the wrong banner over artwork that is covered anyway.
 */

/** @typedef {{ok: boolean, owes: 'attestation'|'verification', jurisdiction: object|null}} AgeState */

/** @type {AgeState} */
let state = { ok: false, owes: 'attestation', jurisdiction: null };

/** @type {Set<(s: AgeState) => void>} */
const listeners = new Set();

/** @returns {AgeState} */
export function ageState() {
    return state;
}

/**
 * Whether this visitor may be shown uncovered adult artwork.
 *
 * Starts false and is only ever true after the server has said so, which is
 * the ordering that matters: a module reading this before the first fetch
 * lands gets the cautious answer rather than `undefined`.
 */
export function ageOk() {
    return state.ok === true;
}

/**
 * Record the server's answer and tell everybody who asked.
 *
 * @param {Partial<AgeState>|null} next
 */
export function setAgeState(next) {
    if (!next) return;

    state = {
        ok: next.ok === true,
        owes: next.owes === 'verification' ? 'verification' : 'attestation',
        jurisdiction: next.jurisdiction ?? null
    };

    for (const fn of listeners) {
        // One subscriber throwing must not stop the others being told, and in
        // particular must not stop the ad modules being told, since the thing
        // they do on being told is stop drawing ads.
        try {
            fn(state);
        } catch (err) {
            console.warn(`[age] listener failed: ${err?.message ?? err}`);
        }
    }
}

/**
 * Subscribe to changes.
 *
 * @param {(s: AgeState) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onAgeChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Test seam: forget the visitor and everybody watching them. */
export function _resetAgeState() {
    state = { ok: false, owes: 'attestation', jurisdiction: null };
    listeners.clear();
}
