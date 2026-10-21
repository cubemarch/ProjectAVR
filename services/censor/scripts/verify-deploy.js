/**
 * Does the deployed service actually cover anything?
 *
 * ## Why this is not a smoke test
 *
 * The mosaic was broken for its entire first day in production and every
 * signal anybody checked read as healthy. `/health` said the model was
 * loaded, because it was. The latency was right. The content type was right.
 * `X-Censor-Boxes` reported real regions, found by a model that was working
 * correctly. And the response was *smaller* than the request, which is what a
 * mosaic does to a JPEG and is therefore what the deployment check looked for.
 *
 * All of it was true of an image that had been decoded and re-encoded and
 * otherwise left alone. `blocky` chained two `.resize()` calls on one `sharp`
 * pipeline, the second silently replaced the first, and the service answered
 * every request with the photograph. The docstring on `blocky` in
 * `src/mosaic.js` has the measurement.
 *
 * So this script does the one thing none of those checks did: it decodes the
 * response and counts how many pixels moved.
 *
 * ## The probe has to be checked against the local mosaic first
 *
 * The first version of this script sent a solid-colour sliver, and a solid
 * colour put through a correct mosaic comes back the same solid colour. It
 * reported 0.0% moved against known-good code and called production broken.
 *
 * A measurement that cannot tell a working service from a broken one is worse
 * than no measurement, because somebody acts on it. So the probe is now run
 * through this repository's own {@link pixelate} before it is sent anywhere,
 * and if the local mosaic does not visibly change it the script aborts
 * instead of reporting on the service. The remote number means something only
 * in relation to that local one.
 *
 * ## The probe is a sliver, on purpose
 *
 * 4000x3 of stripes is nothing anybody has to look at, which matters for a
 * check somebody should be willing to run from a laptop against production.
 * It is also unintelligible to a 320x320 detector, so `detect` throws and the
 * service takes its whole-frame fallback -- the branch it enters whenever it
 * cannot tell, the one its own docstring calls safe, and therefore the one
 * whose silent failure costs the most.
 *
 * Note that this branch returns no `X-Censor-Confidence`, because there is no
 * confidence to report when detection did not finish. That header's absence
 * says nothing about which build is running; do not read it as a version.
 *
 *   AVR_CENSOR_TOKEN=... node scripts/verify-deploy.js https://host
 *
 * Exits non-zero if the service is failing open.
 */

import { createRequire } from 'node:module';

import { pixelate } from '../src/mosaic.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

/** Below this, nothing happened: JPEG noise alone clears a couple of percent. */
const MIN_MOVED = 20;

/** Luma difference that counts as a pixel moving, over a re-encode's wobble. */
const DELTA = 8;

const base = (process.argv[2] || '').replace(/\/$/, '');
const token = process.env.AVR_CENSOR_TOKEN || process.env.CENSOR_TOKEN;

if (!base || !token) {
    console.error('usage: AVR_CENSOR_TOKEN=... node scripts/verify-deploy.js https://host');
    process.exit(2);
}

/**
 * The probe: stripes fine enough that any honest downsample destroys them.
 *
 * Seven-pixel bars against a 64-block mosaic across 4000px means every block
 * averages several bars together, so a working mosaic flattens the whole
 * thing and a broken one returns the stripes intact.
 */
async function probe() {
    const w = 4000;
    const h = 3;
    const raw = Buffer.alloc(w * h * 3);

    for (let x = 0; x < w; x++) {
        const on = Math.floor(x / 7) % 2 === 0;
        for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 3;
            raw[i] = on ? 250 : 5;
            raw[i + 1] = on ? 10 : 240;
            raw[i + 2] = on ? 120 : 30;
        }
    }

    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** Percentage of pixels whose luma moved, both sides sampled to one grid. */
async function movedPercent(before, after) {
    const grid = { width: 128, height: 128, fit: 'fill' };

    const [a, b] = await Promise.all([
        sharp(before).resize(grid).greyscale().raw().toBuffer(),
        sharp(after).resize(grid).greyscale().raw().toBuffer()
    ]);

    let moved = 0;
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) > DELTA) moved++;
    }

    return (moved / a.length) * 100;
}

const image = await probe();

// Control first. If this repository's own mosaic does not change the probe,
// the probe is the problem and nothing can be concluded about the service.
const local = await movedPercent(image, await pixelate(image, { boxes: [], whole: true }));

if (local < MIN_MOVED) {
    console.error(
        `ABORT the probe is not measurable: the local mosaic moved only ${local.toFixed(1)}% ` +
            `of its pixels, so a remote result would mean nothing. Fix the probe.`
    );
    process.exit(2);
}

const res = await fetch(`${base}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-censor-token': token },
    body: image
});

if (!res.ok) {
    console.error(`FAIL  /scan answered ${res.status} ${await res.text()}`);
    process.exit(1);
}

const out = Buffer.from(await res.arrayBuffer());
const whole = res.headers.get('x-censor-whole');
const boxes = res.headers.get('x-censor-boxes');
const remote = await movedPercent(image, out);

console.log(
    `local=${local.toFixed(1)}%  remote=${remote.toFixed(1)}%  ` +
        `whole=${whole} boxes=${boxes}`
);

// A clean pass on a sliver would mean the model confidently decided there was
// nothing there, which it cannot have done with three rows of pixels. Treat
// it as a failure to reach the branch rather than a pass.
if (whole !== '1') {
    console.error(`FAIL  expected the whole-frame fallback on a 4000x3 sliver, got whole=${whole}`);
    process.exit(1);
}

if (remote < MIN_MOVED) {
    console.error(
        `FAIL  the service reported a whole-frame mosaic and moved ${remote.toFixed(1)}% ` +
            `of the pixels, where this repository's code moves ${local.toFixed(1)}%. ` +
            `It is returning the original and saying it is not.`
    );
    process.exit(1);
}

console.log(`OK    whole-frame mosaic moved ${remote.toFixed(1)}% of the pixels`);
