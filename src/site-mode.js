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

/**
 * The surfaces hidden above, shown as what they are: not here yet.
 *
 * This is the other half of the decision above, and it reverses part of it.
 * Hiding our own rows outright was right about the empty shelf and wrong
 * about the silence: a visitor who only ever sees paid partner rows has no
 * reason to think this site does anything itself, and the one thing it does
 * that no partner does — stereoscopic capture delivered to a headset — was
 * the thing being hidden.
 *
 * So the rows come back inert. Dimmed, unclickable, labelled **Coming
 * Soon!**, fetching nothing and bound to nothing.
 *
 * ## The rules these had to be written under
 *
 * - **No invented inventory.** No performer names, no titles, no counts, no
 *   dates. The cards are blank shapes on purpose. A placeholder that reads
 *   as a real listing is a lie about what is on the site, and the one shelf
 *   here that does carry card labels — the catalogue — labels them with
 *   format names, which are facts about the pipeline rather than claims
 *   about a library.
 * - **No promise with a date on it.** "Coming Soon!" is what was asked for
 *   and it is as far as this goes. Nothing here says when.
 * - **The blurbs are the point.** They are first-party description of our
 *   own engineering, which is the one kind of writing this page has none of
 *   — see `docs/SEARCH.md` on why a page of nothing but affiliate rows is a
 *   thin-affiliate problem no amount of generated filler would fix.
 *
 * Vocabulary is from `PROJECTION_LABELS` and `STEREO_LABELS` in
 * `catalog/media-format.js` and must stay that way: that table exists
 * because this product previously had four names for 180° across four
 * screens.
 *
 * **When `AFFILIATES_ONLY` goes back to `false`**, delete this and the
 * `_comingSoonHtml` that renders it. These shelves and the real ones carry
 * the same headings, and two Live Creators rows on one page is worse than
 * either problem this file was opened to solve.
 *
 * @typedef {{title: string, blurb: string, cards: number|string[]}} ComingSoonShelf
 * @type {ComingSoonShelf[]}
 */
export const COMING_SOON_SHELVES = [
    {
        title: 'Live Creators',
        blurb:
            'One-to-one streams in a stereoscopic 180° dome, sent to your headset ' +
            'as the camera captured them rather than flattened to a single image first.',
        cards: 6
    },
    {
        title: 'Recorded 1:1s',
        blurb:
            'Private sessions recorded server-side from the creator’s own camera, ' +
            'priced by the creator. The 2D or 3D tag is read off the file, so it ' +
            'says what was actually shot.',
        cards: 6
    },
    {
        // The one shelf with labelled cards. These are the formats the
        // pipeline encodes and the player reads — see `media-format.js` —
        // not a sample of a catalogue that does not exist.
        title: 'Every format your headset reads',
        // No repo paths in here. An earlier draft ended "What the headset
        // gets is in docs/DELIVERY.md", which is true, internal, and means
        // nothing to the person reading the page.
        blurb:
            'Quest, Vision Pro, Pico and anything that speaks WebXR, each offered ' +
            'the rendition it can actually decode rather than one file scaled to ' +
            'fit all of them.',
        cards: ['180° dome', '360° sphere', 'Stereo Side-by-Side', 'Standard']
    }
];
