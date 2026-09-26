/**
 * Money, in one place.
 *
 * One credit is one cent. Nothing a viewer reads is ever denominated in
 * credits, because a balance of 2500 and a price of 25 are not comparable at a
 * glance and the mistake they invite is expensive. Three surfaces were each
 * dividing by 100 on their own and disagreeing about whether to print the
 * dollar sign; this is the only place that conversion now happens.
 */

/**
 * @param {number} credits
 * @returns {string} e.g. `$25.00`
 */
export function dollars(credits) {
    return `$${(Math.round(Number(credits) || 0) / 100).toFixed(2)}`;
}

/**
 * A running rate. Written out rather than abbreviated to `/min`, because the
 * per-minute charge is the single most consequential number on the page.
 *
 * @param {number} credits
 * @returns {string} e.g. `$0.25 a minute`
 */
export function perMinute(credits) {
    return `${dollars(credits)} a minute`;
}
