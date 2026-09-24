/**
 * Shared media-format vocabulary.
 *
 * This module is the single source of truth for "how is this video laid out",
 * and it is deliberately dependency-free so the browser app, the Express
 * server, the DeoVR/HereSphere feeds and the DLNA service all speak the same
 * language.
 *
 * Two orthogonal properties describe any video:
 *
 *   projection - how pixels map onto geometry (flat / 180 dome / 360 sphere /
 *                circular fisheye)
 *   stereo     - how the two eyes are packed into one frame (mono /
 *                side-by-side / top-bottom)
 *
 * Native VR players discover these either from an API (DeoVR, Play'a) or by
 * sniffing the filename (SkyBox, Pigasus, Whirligig). We support both, which
 * is why the token tables below matter as much as the metadata does.
 */

export const PROJECTION = {
    FLAT: 'flat',
    DOME180: 'dome180',
    SPHERE360: 'sphere360',
    FISHEYE: 'fisheye'
};

export const STEREO = {
    MONO: 'mono',
    SBS: 'sbs',
    TB: 'tb'
};

/**
 * Filename tokens recognised by the major players, most specific first.
 *
 * Order matters: `_360` must be tested before `_180` would ever match a string
 * like `_360x180`, and the fisheye variants must be tested before the generic
 * `_fisheye`.
 */
const PROJECTION_TOKENS = [
    { re: /(^|[^a-z0-9])mkx220([^a-z0-9]|$)/i, projection: PROJECTION.FISHEYE, fisheyeFov: 220, lens: 'mkx220' },
    { re: /(^|[^a-z0-9])mkx200([^a-z0-9]|$)/i, projection: PROJECTION.FISHEYE, fisheyeFov: 200, lens: 'mkx200' },
    { re: /(^|[^a-z0-9])vrca220([^a-z0-9]|$)/i, projection: PROJECTION.FISHEYE, fisheyeFov: 220, lens: 'vrca220' },
    { re: /(^|[^a-z0-9])rf52([^a-z0-9]|$)/i, projection: PROJECTION.FISHEYE, fisheyeFov: 190, lens: 'rf52' },
    { re: /fisheye\s*(\d{3})/i, projection: PROJECTION.FISHEYE, fovFromMatch: 1, lens: 'fisheye' },
    { re: /(^|[^a-z0-9])fisheye([^a-z0-9]|$)/i, projection: PROJECTION.FISHEYE, fisheyeFov: 180, lens: 'fisheye' },
    { re: /360\s*x\s*180/i, projection: PROJECTION.SPHERE360 },
    { re: /(^|[^a-z0-9])(eq)?360([^a-z0-9]|$)/i, projection: PROJECTION.SPHERE360 },
    { re: /180\s*x\s*180/i, projection: PROJECTION.DOME180 },
    { re: /(^|[^a-z0-9])(eq)?180([^a-z0-9]|$)/i, projection: PROJECTION.DOME180 }
];

const STEREO_TOKENS = [
    { re: /(^|[^a-z0-9])(3dv|tb|ou|overunder|over_under)([^a-z0-9]|$)/i, stereo: STEREO.TB },
    { re: /(^|[^a-z0-9])(3dh|lr|sbs|halfsbs|half_sbs)([^a-z0-9]|$)/i, stereo: STEREO.SBS },
    { re: /(^|[^a-z0-9])(2d|mono)([^a-z0-9]|$)/i, stereo: STEREO.MONO }
];

/**
 * Infer projection + stereo layout from a filename or URL.
 *
 * Follows the de-facto convention shared by SkyBox VR, Pigasus and Whirligig,
 * e.g. `Reef Dive_8K_180x180_3dh_LR.mp4`.
 *
 * @param {string} name - Filename, path or URL.
 * @returns {{projection: string, stereo: string, fisheyeFov: number|null, lens: string|null}}
 */
export function detectFormatFromName(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';

    let projection = PROJECTION.FLAT;
    let fisheyeFov = null;
    let lens = null;

    for (const token of PROJECTION_TOKENS) {
        const match = base.match(token.re);
        if (!match) continue;
        projection = token.projection;
        lens = token.lens || null;
        fisheyeFov = token.fovFromMatch ? Number(match[token.fovFromMatch]) : (token.fisheyeFov ?? null);
        break;
    }

    // A bare `_LR` on an otherwise unmarked file is ambiguous, but every player
    // treats it as stereo, so we do too.
    let stereo = STEREO.MONO;
    for (const token of STEREO_TOKENS) {
        if (token.re.test(base)) {
            stereo = token.stereo;
            break;
        }
    }

    // Immersive projections are overwhelmingly stereo. If a file says 180/fisheye
    // but carries no stereo token, side-by-side is the safe default - it is what
    // DeoVR and Play'a assume as well.
    if (stereo === STEREO.MONO && !/(^|[^a-z0-9])(2d|mono)([^a-z0-9]|$)/i.test(base)) {
        if (projection === PROJECTION.DOME180 || projection === PROJECTION.FISHEYE) {
            stereo = STEREO.SBS;
        }
    }

    return { projection, stereo, fisheyeFov, lens };
}

/**
 * Resolve a catalog entry's format, preferring explicit metadata and falling
 * back to filename sniffing. Explicit always wins - the catalog author knows
 * more than the filename does.
 *
 * @param {object} item - Catalog entry.
 * @returns {{projection: string, stereo: string, fisheyeFov: number|null, lens: string|null}}
 */
export function resolveFormat(item) {
    const sniffed = detectFormatFromName(item.src || item.file || item.title || '');
    const projection = item.projection || sniffed.projection;
    const isFisheye = projection === PROJECTION.FISHEYE;

    return {
        projection,
        stereo: item.stereo || sniffed.stereo,
        fisheyeFov: isFisheye ? (item.fisheyeFov || sniffed.fisheyeFov || 180) : null,
        lens: item.lens || sniffed.lens || null
    };
}

/**
 * Build a filename that every convention-sniffing player will read correctly.
 *
 * Used by the export tooling so that files copied onto a headset, an SMB share
 * or a DLNA server keep their metadata even with no API in the picture.
 *
 * @param {string} title - Human title.
 * @param {object} format - Result of {@link resolveFormat}.
 * @param {object} [opts]
 * @param {string} [opts.ext] - File extension including dot.
 * @param {number} [opts.height] - Source height, used for the resolution tag.
 * @returns {string}
 */
export function buildConventionalFilename(title, format, opts = {}) {
    const { ext = '.mp4', height = null } = opts;
    const safe = String(title)
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, ' ');

    const parts = [safe];

    if (height) {
        const tag = height >= 4000 ? '8K' : height >= 2000 ? '4K' : height >= 1400 ? '2K' : `${height}p`;
        parts.push(tag);
    }

    if (format.projection === PROJECTION.SPHERE360) parts.push('360x180');
    else if (format.projection === PROJECTION.DOME180) parts.push('180x180');
    else if (format.projection === PROJECTION.FISHEYE) {
        parts.push(format.lens && format.lens !== 'fisheye' ? format.lens.toUpperCase() : `FISHEYE${format.fisheyeFov || 180}`);
    }

    if (format.stereo === STEREO.SBS) parts.push('3dh', 'LR');
    else if (format.stereo === STEREO.TB) parts.push('3dv', 'TB');
    else if (format.projection !== PROJECTION.FLAT) parts.push('MONO');

    return parts.join('_') + ext;
}

/**
 * Translate our vocabulary into DeoVR's, which Play'a also consumes.
 *
 * DeoVR's `screenType` covers flat/dome/sphere plus named fisheye lenses, and
 * `stereoMode` is off/sbs/tb.
 *
 * @param {object} format - Result of {@link resolveFormat}.
 * @returns {{screenType: string, stereoMode: string, is3d: boolean}}
 */
export function toDeoVR(format) {
    let screenType = 'flat';

    switch (format.projection) {
        case PROJECTION.DOME180:
            screenType = 'dome';
            break;
        case PROJECTION.SPHERE360:
            screenType = 'sphere';
            break;
        case PROJECTION.FISHEYE:
            // DeoVR understands specific lens profiles by name and applies the
            // matching de-warp; anything else falls back to generic fisheye.
            if (format.lens === 'mkx200') screenType = 'mkx200';
            else if (format.lens === 'mkx220') screenType = 'mkx220';
            else if (format.lens === 'rf52') screenType = 'rf52';
            else if (format.lens === 'vrca220') screenType = 'vrca220';
            else screenType = 'fisheye';
            break;
        default:
            screenType = 'flat';
    }

    const stereoMode = format.stereo === STEREO.SBS ? 'sbs' : format.stereo === STEREO.TB ? 'tb' : 'off';

    return { screenType, stereoMode, is3d: format.stereo !== STEREO.MONO };
}

/**
 * Short badges for the browse UI, e.g. ["180°", "3D"].
 *
 * @param {object} format - Result of {@link resolveFormat}.
 * @returns {string[]}
 */
export function formatBadges(format) {
    const badges = [];

    if (format.projection === PROJECTION.DOME180) badges.push('180°');
    else if (format.projection === PROJECTION.SPHERE360) badges.push('360°');
    else if (format.projection === PROJECTION.FISHEYE) badges.push(`${format.fisheyeFov || 180}° FISHEYE`);

    if (format.stereo !== STEREO.MONO) badges.push('3D');

    return badges;
}

/** True when the title needs the 3D renderer rather than a plain video element. */
export function isImmersive(format) {
    return format.projection !== PROJECTION.FLAT || format.stereo !== STEREO.MONO;
}
