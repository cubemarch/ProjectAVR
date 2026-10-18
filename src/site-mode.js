/**
 * What the site is currently willing to show.
 *
 * This file exists to be found and flipped back, which is why it sits next to
 * `main.js` rather than inside a folder: it is a temporary posture, not an
 * architectural choice, and the thing that goes wrong with temporary postures
 * is that nobody can find the switch six months later.
 */

/**
 * Show the affiliate partner rows and nothing else.
 *
 * Set `true` on 2026-10-18 at David's request, until there is original content
 * to put in front of people. The reasoning: a platform with no creators on it
 * reads worse than a clean storefront. An empty "Live Creators" row, a hero
 * with nothing behind it and a sign-up for a service with nothing in it all
 * advertise the one thing the site does not want to advertise yet.
 *
 * **What this hides** — the billboard, Live Creators, the Recorded 1:1s
 * market, every catalogue shelf, the detail modal, and the whole of the
 * header except the brand (the format filters, My List, search and "Send to
 * headset" all act on the catalogue, and the account controls offer a signup
 * that leads nowhere). Nothing is fetched for any of it.
 *
 * **What still works** — `/creator` and `/profile` by direct URL. Both open
 * the auth modal when signed out, so this does not lock anybody out of the
 * Creator Studio; it only removes the links. The server is untouched: every
 * API route still answers exactly as before, so this is a front-of-house
 * change and not a feature flag anything depends on.
 *
 * **To bring it all back**: set this to `false`, rebuild, deploy. There is no
 * second place to change and no server-side counterpart. Then re-check the
 * affiliate section's placement — it was put above Live Creators when the
 * page had a billboard over it, and that ordering is worth another look once
 * there are real creators to rank against paid rows.
 */
export const AFFILIATES_ONLY = true;
