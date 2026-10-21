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

/**
 * Declared content types allowed as far as a download.
 *
 * Not the real check — {@link sniff} is — but the real check needs the bytes,
 * and reading a body to find out it was HTML is work a header can avoid. So
 * this gate is deliberately generous: `image/*`, the two spellings of "some
 * bytes, I don't know what", and a missing header. Everything else is refused
 * before anything is read.
 */
const FETCHABLE = /^(?:image\/|application\/octet-stream|binary\/octet-stream|$)/;

/**
 * Image formats, by the bytes they start with.
 *
 * This exists because a partner's declared content type turned out to be
 * worthless. Bang serves its boxcovers from `i.bang.com` and labels 31 of 51
 * of them `application/octet-stream`; the other 20 are `image/jpeg`. All 51
 * are byte-for-byte the same kind of file — Exif-prefixed JPEG, `ffd8ffe1` —
 * so the header is not describing older uploads or a different encoder, it is
 * just inconsistent. Measured 2026-10-20 across all three shelves.
 *
 * Checking the magic number instead is also *tighter* than trusting the
 * header, which is the part worth keeping: a host that says `image/jpeg` and
 * sends a login page no longer gets those bytes forwarded to the decoder.
 *
 * The formats are the ones `sharp` decodes on the other side. A format that
 * is not here is refused rather than passed along hopefully, because the cost
 * of being wrong is a tile that quietly shows an uncovered photograph.
 */
const MAGIC = [
    [[0xff, 0xd8, 0xff], 'image/jpeg'],
    [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
    [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
    [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
    [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff']
];

/**
 * The real content type of `body`, read off its first bytes, or `null`.
 *
 * WebP and AVIF/HEIF carry their marker at an offset rather than at the
 * start — `RIFF....WEBP` and `....ftyp`— so they are matched separately
 * instead of being bent into {@link MAGIC}.
 */
function sniff(body) {
    for (const [bytes, type] of MAGIC) {
        if (bytes.every((b, i) => body[i] === b)) return type;
    }

    if (body.length >= 12) {
        const riff = body.toString('latin1', 0, 4);
        const webp = body.toString('latin1', 8, 12);
        if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';

        if (body.toString('latin1', 4, 8) === 'ftyp') {
            const brand = body.toString('latin1', 8, 12);
            if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
            if (brand.startsWith('heic') || brand.startsWith('heix')) return 'image/heic';
            if (brand.startsWith('mif1') || brand.startsWith('msf1')) return 'image/heif';
        }
    }

    return null;
}

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

    const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

    if (!FETCHABLE.test(declared)) return null;

    const length = Number(response.headers.get('content-length') || 0);

    if (length > MAX_BYTES) return null;

    const body = Buffer.from(await response.arrayBuffer());

    if (!body.length || body.length > MAX_BYTES) return null;

    // The declared type is discarded here, not reconciled. It got the response
    // this far and it has no further say: what goes to the decoder is what the
    // bytes actually are.
    const type = sniff(body);

    if (!type) return null;

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
