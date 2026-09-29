import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECTION, STEREO } from '../../src/catalog/media-format.js';

/**
 * The burned-in brand mark.
 *
 * Burned in here, on the server, during packaging - not by whatever captured
 * the footage. Two reasons, and both of them are the point of doing it this
 * way:
 *
 *   - A contribution encoder is a general-purpose camera. The capture app is
 *     one client of the ingest protocol among any number of others (see
 *     `CLAUDE.md`), so a mark applied there would be absent from everything
 *     else and present in files that never reach this site.
 *   - A mark applied after upload applies to *every* rendition this site
 *     produces, from one place, and can be changed for the whole library by
 *     re-packaging rather than by re-shooting.
 *
 * What is deliberately *not* claimed: this is branding, not protection. A
 * burned-in overlay survives a re-upload to somewhere else, which is what it is
 * for. It does not survive a determined crop, and nothing here pretends
 * otherwise.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The goggle symbol, not the wordmark.
 *
 * This used to be `logo-text.png` on the reasoning that a wordmark reads at a
 * glance and at an angle. That is still true, and it is the cost of the change:
 * the mark no longer states the product's name, so a viewer who does not
 * already know the symbol learns nothing from it. It was traded away
 * deliberately. The wordmark said **Carnal3D**, the rename to LustXR left that
 * burned into every rendition the packager had ever produced, and a mark that
 * is merely uninformative beats one that is wrong.
 *
 * It is also a different shape - 3:2 against the wordmark's 3:1 - so at the
 * same {@link WIDTH_FRACTION} it covers about twice the height. Verified
 * composited at 250px over a light background before switching: the
 * transparency is real, there is no black card behind the glow, and the goggle
 * outline survives the scale even though the detail inside it does not. If it
 * reads heavy on real footage, `WIDTH_FRACTION` is the knob rather than the
 * file.
 *
 * Swap a LustXR wordmark back in here - or a symbol-and-wordmark lockup - as
 * soon as one exists.
 */
export const WATERMARK_FILE = process.env.AVR_WATERMARK_FILE || path.join(ROOT, 'art', 'logo-symbol.png');

/**
 * How much of an eye's width the mark spans.
 *
 * Smaller for immersive projections because the viewer only ever sees a slice
 * of the frame: on a 180° dome a mark spanning 10% of the eye's width covers
 * roughly 18° of yaw, which in a ~100° field of view is about the same apparent
 * size as 13% of a flat frame.
 */
const WIDTH_FRACTION = { flat: 0.13, immersive: 0.1 };

/** Inset from the edge of an eye, as a fraction of that eye's short side. */
const MARGIN_FRACTION = 0.035;

/**
 * How far down an eye the immersive mark sits, as a fraction of the eye's
 * height. Equirectangular maps vertical pixels to pitch, so 0.7 is about 36°
 * below the horizon - low enough to stay out of the scene, high enough that a
 * viewer looking straight ahead still catches it.
 */
const IMMERSIVE_Y_FRACTION = 0.7;

export function watermarkOpacity() {
    const raw = Number(process.env.AVR_WATERMARK_OPACITY);
    if (!Number.isFinite(raw)) return 0.62;
    return Math.min(1, Math.max(0, raw));
}

/** Off by default nowhere - but a self-hoster running their own site can. */
export function watermarkEnabled() {
    return process.env.AVR_WATERMARK !== '0';
}

/** @returns {string|null} The mark's path, or null if it is off or missing. */
export function watermarkSource() {
    if (!watermarkEnabled()) return null;

    try {
        fs.accessSync(WATERMARK_FILE, fs.constants.R_OK);
        return WATERMARK_FILE;
    } catch {
        return null;
    }
}

/**
 * The rectangles one mark has to be drawn into, one per eye.
 *
 * This is the part that is easy to get wrong and hard to notice. A packed
 * stereo frame is two pictures in one raster: side-by-side puts them left and
 * right of the midline, over-under above and below it. A single overlay in the
 * corner of *the frame* therefore lands in the corner of *one eye* and nowhere
 * in the other, and a headset showing an object to one eye only cannot fuse it
 * - it swims in front of the scene at no fixed depth and gives people a
 * headache. Both eyes, at the matching position within each, or neither.
 *
 * @param {number} width - Source frame width.
 * @param {number} height - Source frame height.
 * @param {string} stereo - A {@link STEREO} value.
 * @returns {Array<{x: number, y: number, width: number, height: number}>}
 */
export function eyeRects(width, height, stereo) {
    if (stereo === STEREO.SBS) {
        const half = Math.floor(width / 2);
        return [
            { x: 0, y: 0, width: half, height },
            { x: half, y: 0, width: width - half, height }
        ];
    }

    if (stereo === STEREO.TB) {
        const half = Math.floor(height / 2);
        return [
            { x: 0, y: 0, width, height: half },
            { x: 0, y: half, width, height: height - half }
        ];
    }

    return [{ x: 0, y: 0, width, height }];
}

/**
 * Where the mark goes within one eye.
 *
 * Flat video gets the bottom-right corner, which is where a viewer's eye is
 * not. Immersive projections get the bottom centre instead, because the corners
 * of an equirectangular frame are not corners at all - the left and right edges
 * are directly behind the viewer and the top and bottom rows are the poles,
 * smeared across the whole sky. A mark in the "corner" of a 360 frame ends up
 * stretched into an unreadable band overhead.
 *
 * Returned as ffmpeg overlay expressions rather than numbers, so that `w` and
 * `h` - the scaled mark's own dimensions, which only ffmpeg knows - can do the
 * arithmetic.
 *
 * @param {{x: number, y: number, width: number, height: number}} eye
 * @param {boolean} immersive
 * @returns {{x: string, y: string}}
 */
export function placementIn(eye, immersive) {
    const margin = Math.round(Math.min(eye.width, eye.height) * MARGIN_FRACTION);

    if (immersive) {
        return {
            x: `${eye.x + Math.round(eye.width / 2)}-w/2`,
            y: `${eye.y + Math.round(eye.height * IMMERSIVE_Y_FRACTION)}-h/2`
        };
    }

    return {
        x: `${eye.x + eye.width - margin}-w`,
        y: `${eye.y + eye.height - margin}-h`
    };
}

/**
 * Build the filter chain that burns the mark into a frame.
 *
 * Composited once, at source resolution, *before* the ladder splits - not once
 * per rung. One overlay pass instead of five, and every rung then carries a
 * mark that scales with it, so the 480p rung's mark is the same size relative
 * to the picture as the 4320p one's.
 *
 * @param {object} opts
 * @param {number} opts.width - Source frame width.
 * @param {number} opts.height - Source frame height.
 * @param {object} opts.format - Resolved media format.
 * @param {number} [opts.inputIndex] - ffmpeg input index of the mark.
 * @param {string} [opts.inLabel] - Label of the frame to mark.
 * @param {string} [opts.outLabel] - Label to produce.
 * @returns {{filters: string[], outLabel: string}|null} Null when there is
 *   nothing to burn, in which case the caller should use `inLabel` unchanged.
 */
export function watermarkFilters({ width, height, format, inputIndex = 1, inLabel = '0:v', outLabel = 'marked' }) {
    if (!width || !height) return null;

    const stereo = format?.stereo ?? STEREO.MONO;
    const immersive = (format?.projection ?? PROJECTION.FLAT) !== PROJECTION.FLAT;
    const eyes = eyeRects(width, height, stereo);

    const markWidth = Math.max(16, Math.round(eyes[0].width * (immersive ? WIDTH_FRACTION.immersive : WIDTH_FRACTION.flat)));

    const filters = [
        // `colorchannelmixer` scales the alpha the PNG already has rather than
        // replacing it, so the mark's own soft edges survive the fade.
        `[${inputIndex}:v]scale=${markWidth}:-1,format=rgba,colorchannelmixer=aa=${watermarkOpacity()}[wmsrc]`
    ];

    // A filter output feeds exactly one consumer, so a mark drawn into two eyes
    // has to be split into two copies first. (Input *streams* like `[0:v]` are
    // auto-split by ffmpeg; labels produced inside the graph are not.)
    const marks = eyes.map((_, i) => `wm${i}`);
    if (marks.length > 1) filters.push(`[wmsrc]split=${marks.length}${marks.map((m) => `[${m}]`).join('')}`);
    else filters.push(`[wmsrc]null[${marks[0]}]`);

    let current = inLabel;

    eyes.forEach((eye, i) => {
        const { x, y } = placementIn(eye, immersive);
        const next = i === eyes.length - 1 ? outLabel : `${outLabel}_${i}`;

        // `eval=init` computes the position once instead of per frame. The
        // expressions are constant, and on an 8K source that is a measurable
        // share of the pass.
        filters.push(`[${current}][${marks[i]}]overlay=x=${x}:y=${y}:eval=init[${next}]`);
        current = next;
    });

    return { filters, outLabel: current };
}
