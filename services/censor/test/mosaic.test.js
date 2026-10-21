import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { pixelate, grow, _internals } from '../src/mosaic.js';

/**
 * Does the cover actually cover?
 *
 * Every test here answers that one question by counting pixels, and the
 * reason is that on 2026-10-20 this service spent its entire life returning
 * uncovered photographs while reporting that it had covered them.
 *
 * `blocky` chained two `.resize()` calls on one `sharp` pipeline. `sharp`
 * allows one resize per pipeline and the second call replaces the first, so
 * the downsample never ran and the "mosaic" was the original image at its
 * own dimensions. Everything downstream was correct — the model found the
 * right regions, `grow` padded them, `composite` placed patches exactly
 * where it should — and every patch was cut from an unquantised copy of the
 * photograph. The service answered 200, set `X-Censor-Boxes: 4`, and handed
 * back the picture.
 *
 * Nothing caught it. `detect.test.js` tested the model. The deployment was
 * verified on latency, byte counts, content types and compression ratios —
 * all of which a re-encoded original passes perfectly. The file size even
 * *fell*, which read as evidence the mosaic was working.
 *
 * So the rule for this file: **no assertion about an image here is allowed
 * to be about its size, its type or its headers.** Decode it and compare
 * pixels, or it is not a test of covering.
 */

/** A photograph-ish image: smooth gradients plus fine detail that mosaicing destroys. */
async function source(width = 350, height = 506) {
    const px = Buffer.alloc(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            px[i] = (x * 255) / width;
            px[i + 1] = (y * 255) / height;
            // High-frequency checker. Survives a re-encode, cannot survive a
            // 26-block downsample, so it is the thing being measured.
            px[i + 2] = (x + y) % 2 ? 240 : 15;
        }
    }

    return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/** Share of channel samples in `region` that moved by more than JPEG noise. */
async function moved(before, after, region) {
    const a = await sharp(before).removeAlpha().extract(region).raw().toBuffer();
    const b = await sharp(after).removeAlpha().extract(region).raw().toBuffer();

    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++;

    return n / a.length;
}

const CHEST = { x: 120, y: 150, w: 100, h: 80 };

test('a box is covered, and covering it changes the pixels under it', async () => {
    const src = await source();
    const out = await pixelate(src, { boxes: [CHEST] });

    const region = grow(CHEST, 350, 506);
    const share = await moved(src, out, region);

    // The exact number depends on the image; what is being asserted is that
    // it is nothing like zero. The broken version scored 0.00.
    assert.ok(share > 0.25, `expected the box to be visibly covered, only ${(share * 100).toFixed(1)}% of it moved`);
});

test('whole-frame is the fallback the rest of the service relies on, so it has to work', async () => {
    const src = await source();
    const out = await pixelate(src, { whole: true });

    const share = await moved(src, out, { left: 0, top: 0, width: 350, height: 506 });

    // This is the branch taken when the model will not load. `server.js`
    // logs "Serving whole-frame mosaic for every request" and treats it as
    // the safe state; it was returning the photograph.
    assert.ok(share > 0.25, `the whole-frame mosaic left the frame alone — only ${(share * 100).toFixed(1)}% moved`);
});

test('a cleared image is handed back, and an uncertain one is not', async () => {
    const src = await source();
    const frame = { left: 0, top: 0, width: 350, height: 506 };

    // These two differ by one flag and they are the whole safety argument
    // for showing anything at all. `whole:false` with no boxes is the
    // detector saying it looked and there is nothing; `whole:true` is it
    // saying it could not tell. Covering both — which is what this did
    // until 2026-10-20 — mosaiced every clothed cover in the catalogue.
    const baseline = await sharp(src).removeAlpha().jpeg({ quality: 78, mozjpeg: true }).toBuffer();

    const cleared = await pixelate(src, { boxes: [], whole: false });
    assert.ok(
        (await moved(baseline, cleared, frame)) < 0.05,
        'a cleared image comes back as itself, re-encoded'
    );

    const unsure = await pixelate(src, { boxes: [], whole: true });
    assert.ok(
        (await moved(src, unsure, frame)) > 0.25,
        'an uncertain one is covered entirely'
    );
});

test('what is outside the box is left alone', async () => {
    const src = await source();
    const out = await pixelate(src, { boxes: [CHEST] });

    // Measured against a re-encode of the source rather than the source
    // itself. `pixelate` always re-encodes at quality 78, and the detail in
    // this fixture is a one-pixel checker — the worst case there is — so
    // comparing to the original would charge the mosaic for JPEG's own
    // losses and fail a correct implementation. The baseline carries the
    // same losses, so what is left is bleed and nothing else.
    const baseline = await sharp(src).removeAlpha().jpeg({ quality: 78, mozjpeg: true }).toBuffer();

    // Far corner, well clear of the padded box.
    const share = await moved(baseline, out, { left: 0, top: 440, width: 60, height: 60 });

    assert.ok(share < 0.05, `the cover bled across the frame: ${(share * 100).toFixed(1)}% of a far corner moved`);
});

test('the mosaic is coarse enough that nothing comes back out of it', async () => {
    const src = await source();
    const out = await pixelate(src, { whole: true });

    // A mosaic means neighbouring pixels inside one block are equal. Sample
    // horizontally adjacent pairs; on the original the checker makes almost
    // every pair differ, on a 26-block mosaic almost none do.
    const { data, info } = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    let same = 0;
    let total = 0;

    for (let y = 0; y < info.height; y += 7) {
        for (let x = 0; x < info.width - 1; x += 7) {
            const i = (y * info.width + x) * info.channels;
            total++;
            if (Math.abs(data[i] - data[i + info.channels]) <= 2) same++;
        }
    }

    assert.ok(
        same / total > 0.6,
        `blocks are not flat, so this is a resize and not a mosaic: ${((same / total) * 100).toFixed(1)}% of adjacent pairs match`
    );
});

test('a box that grows past the frame is clipped, not dropped', () => {
    assert.deepEqual(grow({ x: -40, y: -40, w: 60, h: 60 }, 350, 506), {
        left: 0,
        top: 0,
        width: Math.ceil(-10 + 30 * _internals.PAD * _internals.ELLIPSE_FIT),
        height: Math.ceil(-10 + 30 * _internals.PAD * _internals.ELLIPSE_FIT)
    });

    assert.equal(grow({ x: 10, y: 10, w: 0, h: 0 }, 350, 506), null, 'a zero box is not worth placing');
});
