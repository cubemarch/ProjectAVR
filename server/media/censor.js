/**
 * The censoring image proxy's client half.
 *
 * Fetches a partner's artwork, sends it to the inference service, and hands
 * back the covered version. The model, the image stack and the GPU-shaped
 * decisions all live on the other side of one HTTP call — see
 * [`services/censor/`](../../services/censor/README.md) — so this file has no
 * native dependencies and this repository gains none.
 *
 * ## Why the service is remote
 *
 * Two reasons, and neither is performance. The first is that `onnxruntime` and
 * `sharp` are native modules, and adding them here means the application
 * server can no longer be built on a machine that does not match production.
 * The second is that the thing being moved to AWS later is the *inference*,
 * not the site; keeping the boundary at a URL means that move is
 * `AVR_CENSOR_ENDPOINT=` and nothing else.
 *
 * ## Fail-closed, at every step
 *
 * Every path through this file ends in either a covered image or `null`.
 * There is no path that returns the original. The caller turns `null` into a
 * placeholder, so an unconfigured endpoint, a dead service, a timeout, a
 * refused upstream and a corrupt JPEG all produce the same visible result: a
 * tile with nothing on it. That is the whole design. A censor that falls back
 * to the uncensored image under load is not a censor, it is a delay.
 */

import { Buffer } from 'node:buffer';

/** Longer than the service's own work and shorter than the client's 6s swap. */
const TIMEOUT_MS = 4_000;

/**
 * How long a covered image is reused.
 *
 * Shorter than the shelf's nine-second refresh so a visitor never sees the
 * same frame twice in a row, long enough that a hundred visitors looking at
 * the same room cost one scan rather than a hundred. This is the number that
 * makes the whole thing affordable: the work is per *room*, not per viewer.
 */
const TTL_MS = 6_000;

/**
 * Hard cap on cached images.
 *
 * `TtlCache` is not used here and the reason is memory. It never evicts an
 * expired entry until that same key is asked for again, which is correct for
 * a handful of catalogue responses and wrong for image bodies keyed on a room
 * name: rooms go off air constantly, their keys are never requested again,
 * and each one is holding tens of kilobytes. This keeps insertion order and
 * drops the oldest.
 */
const MAX_ENTRIES = 400;

/** Refuse anything that is not plausibly a thumbnail. */
const MAX_BYTES = 4 * 1024 * 1024;

const cache = new Map();

export function isConfigured() {
    return Boolean(process.env.AVR_CENSOR_ENDPOINT && process.env.AVR_CENSOR_TOKEN);
}

/**
 * Fetch `url`, cover anything explicit in it, and return the JPEG.
 *
 * @param {string} url Absolute http(s) URL, already host-checked by the caller.
 * @returns {Promise<Buffer|null>} The covered image, or `null` — never the original.
 */
export async function censor(url) {
    const hit = cache.get(url);

    if (hit && hit.expires > Date.now()) return hit.value;

    // The in-flight promise goes in before it settles, so sixty cards
    // refreshing on the same second produce one upstream fetch and one scan.
    const value = run(url);

    cache.set(url, { value, expires: Date.now() + TTL_MS });

    if (cache.size > MAX_ENTRIES) {
        for (const key of [...cache.keys()].slice(0, cache.size - MAX_ENTRIES)) {
            cache.delete(key);
        }
    }

    // Never hold on to a failure. Both arms are needed and the first is easy
    // to miss: `run` reports an unreachable service by resolving `null`, not
    // by throwing, so a `catch` alone would quietly pin the placeholder onto
    // a card for the whole TTL after a single blip.
    value.then(
        (out) => {
            if (!out) cache.delete(url);
        },
        () => cache.delete(url)
    );

    return value;
}

async function run(url) {
    if (!isConfigured()) return null;

    const source = await fetchImage(url);
    if (!source) return null;

    const endpoint = new URL('/scan', process.env.AVR_CENSOR_ENDPOINT).toString();
    const signal = AbortSignal.timeout(TIMEOUT_MS);

    let response;

    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': source.type,
                'X-Censor-Token': process.env.AVR_CENSOR_TOKEN
            },
            body: source.body,
            signal
        });
    } catch (err) {
        console.warn(`[censor] service unreachable: ${err.message}`);
        return null;
    }

    if (!response.ok) {
        console.warn(`[censor] service answered ${response.status}`);
        return null;
    }

    const out = Buffer.from(await response.arrayBuffer());

    if (!out.length) return null;

    // Logged, not acted on. The service has already covered whatever it could
    // not place; this is here so a row that has quietly gone all-mosaic
    // because the model stopped loading is visible in the logs rather than
    // only to whoever happens to look at the page.
    if (response.headers.get('x-censor-whole') === '1') {
        wholeFrames += 1;
    }

    scanned += 1;

    return out;
}

/** Pull the partner's image, with the same no-referrer stance the browser had. */
async function fetchImage(url) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);

    let response;

    try {
        response = await fetch(url, {
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' },
            signal
        });
    } catch (err) {
        console.warn(`[censor] upstream image failed: ${err.message}`);
        return null;
    }

    if (!response.ok) return null;

    const type = response.headers.get('content-type') || '';

    if (!type.startsWith('image/')) return null;

    const length = Number(response.headers.get('content-length') || 0);

    if (length > MAX_BYTES) return null;

    const body = Buffer.from(await response.arrayBuffer());

    if (!body.length || body.length > MAX_BYTES) return null;

    return { body, type };
}

/**
 * The tile shown when nothing could be covered.
 *
 * An SVG rather than a bitmap so it needs no image library to generate and no
 * binary in the tree, and it scales to whatever box the card gives it. It is
 * deliberately not a "broken image" and deliberately not blank — a visitor
 * who sees this should understand the tile is withheld, not that the site is
 * failing, because the most common reason they are seeing it is that they
 * have not verified their age.
 */
export const PLACEHOLDER = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 270" width="360" height="270">` +
        `<defs><pattern id="m" width="26" height="26" patternUnits="userSpaceOnUse">` +
        `<rect width="26" height="26" fill="#17161c"/>` +
        `<rect width="13" height="13" fill="#1d1c24"/>` +
        `<rect x="13" y="13" width="13" height="13" fill="#1d1c24"/>` +
        `</pattern></defs>` +
        `<rect width="360" height="270" fill="url(#m)"/>` +
        `<circle cx="180" cy="128" r="30" fill="none" stroke="#4b4a57" stroke-width="2"/>` +
        `<path d="M168 126v-7a12 12 0 0124 0v7" fill="none" stroke="#4b4a57" stroke-width="2"/>` +
        `<rect x="167" y="126" width="26" height="20" rx="3" fill="#4b4a57"/>` +
        `<text x="180" y="186" fill="#6b6a78" font-family="system-ui,sans-serif" ` +
        `font-size="13" text-anchor="middle">Verify your age to view</text>` +
        `</svg>`
);

let scanned = 0;
let wholeFrames = 0;

/** Counters for the status page. Cheap, and the only visibility this has. */
export function stats() {
    return { scanned, wholeFrames, cached: cache.size, configured: isConfigured() };
}

export const _internals = { TTL_MS, TIMEOUT_MS, MAX_ENTRIES, MAX_BYTES, cache };
