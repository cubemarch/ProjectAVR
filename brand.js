/**
 * The product name, in one place.
 *
 * The site and the web app are **LustXR**. The repository, the npm package,
 * the Docker image and the source comments are **ProjectAVR** — that is the
 * codebase's name, not the product's, and the two are deliberately allowed to
 * differ. A reader who finds "ProjectAVR" in a file header has not found a
 * stale brand.
 *
 * This file exists because the name is expected to change again: the plan is a
 * general-audience product, and the last rename was Carnal3D to LustXR. Every
 * string a visitor, a creator or a headset can read comes from here, so that
 * change is one line rather than a sweep with a risk of half-renamed consent
 * copy.
 *
 * Both tiers import this. It sits at the repository root rather than in
 * `server/` or `src/` because neither of those may import from the other:
 * `server/` is Node and `src/` is the browser bundle.
 *
 * ## What must not be renamed with it
 *
 * The wire identifiers are a contract with a codebase in another repository
 * (see CLAUDE.md) and none of them is branding:
 *
 * - `avr://` — the pairing URL scheme
 * - `avr-live` — the protocol name in the handshake
 * - `AVR-DISCOVER/1` — the discovery probe string
 * - `AVR_LIVE_*` — the environment variables
 *
 * Renaming any of those is a breaking change for clients that are not built
 * from this tree and will not fail this build.
 */

/**
 * The product, as a visitor sees it written.
 *
 * Two places cannot import this and hold the literal instead: the `<title>`
 * and the inline SVG favicon in `index.html` and `live.html`. They are read by
 * the browser before any bundle runs, and a title rewritten from JavaScript
 * flashes the old one first. Grep both files when this changes.
 */
export const BRAND = 'LustXR';

/**
 * How the media server introduces itself to DLNA and UPnP clients.
 *
 * SkyBox and Pigasus list this string in their server picker, so it is the
 * name someone scrolls past in a headset. `README.md` quotes it; keep the two
 * in step.
 */
export const DLNA_FRIENDLY_NAME = `${BRAND} Library`;

/**
 * The default name for a live destination, shown in the capture app's
 * destination list when a pairing link carries no name of its own.
 *
 * This travels over the wire but is not a wire identifier — it is display
 * text in the `name` parameter, and the receiving app treats it as such.
 */
export const LIVE_DESTINATION_NAME = `${BRAND} Live`;
