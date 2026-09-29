import { BRAND } from '../../brand.js';
import symbolUrl from '../assets/logo-symbol.png';
import wordmarkUrl from '../assets/logo-wordmark.png';

/**
 * The brand lockup: goggle symbol on the left, wordmark on the right.
 *
 * One function rather than the same two `<img>` tags pasted into four
 * templates, because the header, the sign-in dialog, Creator Studio and the
 * live monitor all show it and the last rename proved they drift. `brand.js`
 * already does this for the *name*; this does it for the *mark*.
 *
 * ## Why images and not text
 *
 * The wordmark is a drawn logotype - a custom `X`/`R` ligature with a gradient
 * - so there is no font that renders it. The name still reaches assistive
 * technology and the DOM through the wordmark's `alt`; the symbol is `alt=""`
 * because it says the same thing again and a screen reader announcing
 * "LustXR LustXR" is worse than one that does not.
 *
 * ## Why these files and not the ones in `art/`
 *
 * `art/logo-symbol.png` and `art/logo-text.png` are the masters - 1536x1024
 * and 2172x724 - and they stay that size because the watermark burns them into
 * frames up to 8K (see `server/media/watermark.js`). Shipping 2.1MB of that to
 * a browser to draw a 34px header would be absurd, so `src/assets/` holds
 * downscaled copies, generated with:
 *
 *     ffmpeg -i art/logo-symbol.png -vf "scale=-1:216:flags=lanczos" src/assets/logo-symbol.png
 *     ffmpeg -i art/logo-text.png   -vf "scale=-1:144:flags=lanczos" src/assets/logo-wordmark.png
 *
 * 216px and 144px tall is a little over 3x the largest place either is drawn -
 * the 68px header symbol - which covers a 3x display. Regenerate both when the
 * masters change, and again if any of the sizes below grows: Vite hashes the
 * filenames, so a new file invalidates the old one in every cache on its own.
 */

/** Intrinsic aspect ratios, so the `width`/`height` attributes reserve the
 *  right box before the images load and the header does not jump. */
const SYMBOL_RATIO = 324 / 216;
const WORDMARK_RATIO = 432 / 144;

/**
 * @param {object} [opts]
 * @param {number} [opts.symbolHeight] - Drawn height of the symbol, in CSS
 *   pixels. Only sets the layout hint; the stylesheet is what sizes it, so
 *   pass whatever that context's CSS uses.
 * @param {number} [opts.wordmarkHeight] - Drawn height of the wordmark.
 * @returns {string} HTML for the two marks, in order, with no wrapper - the
 *   caller supplies the `.brand` element so it can add its own suffix
 *   ("Studio", "Live") alongside.
 */
export function brandLockup({ symbolHeight = 68, wordmarkHeight = 42 } = {}) {
    const sw = Math.round(symbolHeight * SYMBOL_RATIO);
    const ww = Math.round(wordmarkHeight * WORDMARK_RATIO);

    return `
        <img class="brand-symbol" src="${symbolUrl}" alt="" width="${sw}" height="${symbolHeight}" />
        <img class="brand-word" src="${wordmarkUrl}" alt="${BRAND}" width="${ww}" height="${wordmarkHeight}" />
    `.trim();
}

export { symbolUrl, wordmarkUrl };
