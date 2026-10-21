import { visitorGate } from '../identity/visitor-gate.js';

/**
 * Whether this visitor's artwork is covered, and how the answer may be cached.
 *
 * The two come together because getting them apart is how a covered payload
 * ends up in a shared cache and is then handed to everybody — or, worse, how
 * an uncovered one does. Any route whose body differs by gate state has to set
 * both from the same decision, so there is one function and it returns both.
 *
 * `no-store` rather than a short TTL on the covered branch, so that passing
 * the gate redraws the page as the real one immediately instead of a few
 * minutes later. The uncovered branch is cacheable because it is what the
 * partner's own CDN would have served.
 *
 * This started as a local helper in `routes/bang.js` and was copied by hand
 * into `routes/aebn.js` with a comment pointing back at it. A third copy was
 * one surface too many: the rule is the same everywhere and a route that gets
 * the header wrong fails silently and in the dangerous direction.
 *
 * @param {import('express').Request} req
 * @returns {{covered: boolean, cacheControl: string}}
 */
export function viewFor(req) {
    const covered = !visitorGate(req).ok;

    return {
        covered,
        cacheControl: covered ? 'private, no-store' : 'public, max-age=300'
    };
}
