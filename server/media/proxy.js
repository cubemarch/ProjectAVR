/**
 * Signed URLs for the censoring image proxy.
 *
 * ## The problem this solves
 *
 * `server/routes/cams.js` covers one partner's thumbnails and is safe from
 * server side request forgery for a structural reason written up on the route:
 * it takes a *room name*, not a URL, so the only addresses it can ever fetch
 * are ones that arrived in a feed we already hold. The parameter is an index
 * into our own data rather than an instruction.
 *
 * That trick does not generalise. Covering Bang's boxcover artwork, its
 * contact sheets and the performer stills means covering images from a
 * catalogue of 164,595 scenes, paged and searched — there is no small stable
 * list to index into, and keeping one would mean caching the entire catalogue
 * to serve a thumbnail. The obvious alternative, `?url=`, is the hole the cam
 * route was shaped to avoid: a proxy that fetches whatever it is handed will
 * read `169.254.169.254` on the instance's behalf for anybody who asks.
 *
 * So the URL travels, and a signature travels with it. The server mints both
 * when it builds the payload; the proxy recomputes the signature and refuses
 * anything it did not mint. The parameter is still not an instruction — it is
 * a URL this server already chose, handed back to it.
 *
 * ## Two bounds, not one
 *
 * The signature is the real bound. {@link HOSTS} is the second one, and it is
 * there because a single secret guarding a general-purpose fetcher is a lot of
 * weight on one rotation: if the key ever leaks, the allowlist is the
 * difference between "an attacker can make us censor arbitrary pictures" and
 * "an attacker can read our metadata endpoint". Both checks run on every
 * request and either one failing is a refusal.
 *
 * ## There is no expiry, deliberately
 *
 * A signed URL here grants exactly one capability: fetch a public image from a
 * partner CDN and pixelate it. That is not a capability worth time-bounding,
 * and an expiry would have a real cost — a page left open in a tab would fill
 * with broken tiles, and every mint would have to bust the browser cache. The
 * signature answers *which* URL, not *when*.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Image hosts this proxy will fetch from.
 *
 * Partner CDNs only. Nothing here is a hostname a visitor influences, and the
 * list is short on purpose: a host is added when a partner's artwork starts
 * being covered, not in advance. `endsWith('.' + host)` covers the numbered
 * shards partners put images behind without admitting `evil-i.bang.com`.
 *
 * Both entries were read off the live feeds rather than inferred from the
 * partner's domain, which is worth doing before adding a third: AEBN's API is
 * on `aebn.com` and their artwork is on `aebn.net`, so the hostname that looks
 * right is the one that silently covers nothing. An image on a host that is not
 * here is dropped rather than shown — see `coverDeep` in `routes/aebn.js`.
 */
const HOSTS = ['i.bang.com', 'pic.aebn.net'];

/** How many bytes of the digest ride in the URL. 128 bits is not brute-forced. */
const SIG_BYTES = 16;

let key = null;

/**
 * The signing key.
 *
 * Derived from `AVR_JWT_SECRET` rather than given one of its own, because a
 * deployment that has to set a second secret to make artwork render is a
 * deployment that will one day render artwork uncovered because somebody
 * missed it. Labelled on the way in so a signature here is not interchangeable
 * with a session token.
 *
 * With no secret set — development, and the first boot of a new deployment —
 * one is generated per process. Signed URLs then stop working across a
 * restart, which is correct: they are minted and used within one page load,
 * and the alternative is a well-known key signing a URL fetcher.
 */
function signingKey() {
    if (key) return key;

    const secret = process.env.AVR_JWT_SECRET;

    key = secret
        ? createHmac('sha256', secret).update('avr-media-proxy-v1').digest()
        : randomBytes(32);

    return key;
}

/** Whether `raw` is a partner image URL we are willing to fetch. */
export function allowedImage(raw) {
    let url;

    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();
    const ok = HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

    return ok ? url.toString() : null;
}

function signature(url) {
    return createHmac('sha256', signingKey()).update(url).digest().subarray(0, SIG_BYTES);
}

/**
 * The covered-proxy URL for a partner image, or `null` if we will not serve it.
 *
 * Returns a root-relative path so it works on any hostname this is deployed
 * under and so it never pins an origin into a cached payload.
 *
 * @param {string} raw Absolute https URL on an allowed partner host.
 * @returns {string|null}
 */
export function signedMediaUrl(raw) {
    const url = allowedImage(raw);
    if (!url) return null;

    const u = Buffer.from(url, 'utf8').toString('base64url');
    const s = signature(url).toString('base64url');

    return `/api/media?u=${u}&s=${s}`;
}

/**
 * Recover the URL behind a signed pair, or `null`.
 *
 * Both checks are re-run rather than assumed from the signature: a URL minted
 * before a host left {@link HOSTS} would otherwise keep working for as long as
 * somebody held the link.
 *
 * @param {unknown} u base64url of the URL
 * @param {unknown} s base64url of the truncated HMAC
 * @returns {string|null}
 */
export function verifyMediaUrl(u, s) {
    if (typeof u !== 'string' || typeof s !== 'string') return null;

    let url;
    let given;

    try {
        url = Buffer.from(u, 'base64url').toString('utf8');
        given = Buffer.from(s, 'base64url');
    } catch {
        return null;
    }

    if (given.length !== SIG_BYTES) return null;

    // Length is checked first because `timingSafeEqual` throws on a mismatch
    // rather than returning false, and a thrown comparison is a 500 where a
    // refusal belongs.
    //
    // Note for anyone writing a tamper test against this: the comparison is on
    // decoded bytes, and sixteen bytes spell as twenty-two base64url characters
    // of which the last carries four slack bits. So sixteen of the sixty-four
    // possible final characters decode to the same signature and all of them
    // verify. That is not a weakness — an attacker still needs the right 128
    // bits — but a test that tampers by changing the last character has a one
    // in four chance of changing nothing and reporting that forgery works.
    if (!timingSafeEqual(given, signature(url))) return null;

    return allowedImage(url);
}

export const _internals = { HOSTS, SIG_BYTES, signature };
