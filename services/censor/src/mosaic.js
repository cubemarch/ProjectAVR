import sharp from 'sharp';

/**
 * Roughly how many blocks span the long edge of a covered image.
 *
 * Mosaic rather than blur, deliberately. A Gaussian at thumbnail scale looks
 * like a focus problem — the visitor reads it as a broken image rather than a
 * decision, and a mild blur is partially recoverable by sharpening. Blocks
 * this large are unambiguous, cheap, and nothing comes back out of them.
 */
const BLOCKS = 26;

/**
 * Safety margin on a detector box before anything is drawn.
 *
 * Boxes come back tight to the part. Tight is wrong here: the model is least
 * accurate at exactly the scale these thumbnails live at, and the cost of
 * being 10% short is the entire point of the service.
 */
const PAD = 1.22;

/**
 * Extra factor so an **ellipse** covers the rectangle it is given.
 *
 * An ellipse inscribed in a w x h box only covers the inner w/root2 x h/root2
 * of it — the four corners of the detector's own box stay visible, which at
 * this resolution is frequently the part that mattered. Scaling the axes by
 * root2 makes the ellipse circumscribe the padded box instead of fitting
 * inside it.
 *
 * This is the whole reason a circle costs more coverage area than a
 * rectangle, and it is why {@link SHAPE} can be switched: the rectangle is
 * tighter and uglier, the ellipse is softer and has to be bigger to be honest.
 */
const ELLIPSE_FIT = Math.SQRT2;

/** `ellipse` is what was asked for; `rect` covers the same box with less area. */
const SHAPE = process.env.CENSOR_SHAPE === 'rect' ? 'rect' : 'ellipse';

/**
 * Pixelate `buffer` over `boxes`, or entirely when `whole` is set.
 *
 * Always returns a JPEG. The caller is a thumbnail proxy whose output goes
 * straight into an `<img>`, and handing it back whatever format arrived means
 * the one time a broadcaster's CDN serves a WebP the proxy starts emitting a
 * format some headset browser does not decode.
 */
export async function pixelate(buffer, { boxes = [], whole = false } = {}) {
    const base = sharp(buffer, { failOn: 'none' }).removeAlpha();
    const meta = await base.metadata();

    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    if (!width || !height) throw new Error('unreadable image');

    const blocks = await blocky(buffer, width, height);

    // Nothing to place: the whole frame is the mosaic. Also the error path
    // every caller in this service falls back to, so it has to be the
    // simplest branch here.
    if (whole || !boxes.length) {
        return sharp(blocks).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    }

    const patches = [];

    for (const box of boxes) {
        const region = grow(box, width, height);
        if (!region) continue;

        const patch = sharp(blocks).extract(region);

        patches.push({
            input:
                SHAPE === 'ellipse'
                    ? await patch
                          .composite([{ input: ellipse(region.width, region.height), blend: 'dest-in' }])
                          .png()
                          .toBuffer()
                    : await patch.png().toBuffer(),
            left: region.left,
            top: region.top
        });
    }

    if (!patches.length) {
        // Boxes that all grew to nothing. Treated as "something was detected
        // and could not be placed", which is the whole-tile case, not the
        // clean case.
        return sharp(blocks).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    }

    return base.composite(patches).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
}

/** The whole frame, quantised. Nearest on the way back up or it re-blurs. */
async function blocky(buffer, width, height) {
    const small = Math.max(4, Math.round(BLOCKS * (Math.min(width, height) / Math.max(width, height))));
    const w = width >= height ? BLOCKS : small;
    const h = width >= height ? small : BLOCKS;

    return sharp(buffer, { failOn: 'none' })
        .removeAlpha()
        .resize(w, h, { fit: 'fill', kernel: 'cubic' })
        .resize(width, height, { fit: 'fill', kernel: 'nearest' })
        .png()
        .toBuffer();
}

/**
 * Pad a box and clip it to the frame.
 *
 * Returns integers because `extract` takes pixels, and `null` when the result
 * is too small to be worth compositing — which the caller treats as a reason
 * to cover everything rather than as nothing to do.
 */
export function grow(box, width, height) {
    const factor = PAD * (SHAPE === 'ellipse' ? ELLIPSE_FIT : 1);

    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const w = box.w * factor;
    const h = box.h * factor;

    const left = Math.max(0, Math.floor(cx - w / 2));
    const top = Math.max(0, Math.floor(cy - h / 2));
    const right = Math.min(width, Math.ceil(cx + w / 2));
    const bottom = Math.min(height, Math.ceil(cy + h / 2));

    if (right - left < 2 || bottom - top < 2) return null;

    return { left, top, width: right - left, height: bottom - top };
}

/** An alpha mask: opaque inside the ellipse, transparent outside. */
function ellipse(width, height) {
    return Buffer.from(
        `<svg width="${width}" height="${height}">` +
            `<ellipse cx="${width / 2}" cy="${height / 2}" ` +
            `rx="${width / 2}" ry="${height / 2}" fill="#fff"/>` +
            `</svg>`
    );
}

export const _internals = { BLOCKS, PAD, ELLIPSE_FIT, SHAPE };
