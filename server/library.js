import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFormat, buildConventionalFilename, PROJECTION, STEREO } from '../src/catalog/media-format.js';
import { titles as titlesRepo } from './db/index.js';
import { getStorage } from './storage/index.js';
import { TtlCache } from './cache.js';

/**
 * Library assembly.
 *
 * Two sources feed one catalog:
 *
 *   1. Published titles from the database - everything uploaded through the
 *      creator portal.
 *   2. Files sitting in `public/media/`, for self-hosters who would rather drop
 *      a file in a folder than use a web form.
 *
 * Both are normalised to the same item shape, so the web app, the DeoVR feed,
 * DLNA and the M3U export all consume one thing and can never disagree about
 * what a title is.
 *
 * Everything is cached. An earlier version rebuilt this on every request -
 * including once per DLNA browse and once per poster - which meant a full
 * `readdir` plus a `stat` per file on a hot path. Under any real concurrency
 * that is the bottleneck long before bandwidth is.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const MEDIA_DIR = path.join(ROOT, 'public', 'media');
export const CATALOG_FILE = path.join(ROOT, 'public', 'catalog.json');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.m3u8']);

const MIME = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.m3u8': 'application/vnd.apple.mpegurl'
};

// Short enough that a newly published title appears almost immediately, long
// enough that a burst of traffic collapses into a single rebuild.
const catalogCache = new TtlCache(5000);

/** Call after any write that changes what is published. */
export function invalidateCatalog() {
    catalogCache.invalidate();
}

/* ----------------------------------------------------------------- helpers -- */

export function slugify(filename) {
    return path
        .basename(filename, path.extname(filename))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

export function titleFromFilename(filename) {
    return path
        .basename(filename, path.extname(filename))
        .replace(/[_.]/g, ' ')
        .replace(
            /\b(180x180|360x180|180|360|3dh|3dv|lr|tb|ou|sbs|mono|2d|half[\s-]?sbs|mkx200|mkx220|rf52|vrca220|fisheye\d*|8k|6k|5k|4k|2k|\d{3,4}p|h26[45]|hevc|x26[45])\b/gi,
            ''
        )
        .replace(/\s+/g, ' ')
        .trim();
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/* ------------------------------------------------------- filesystem source -- */

async function scanMediaDir() {
    let entries;
    try {
        entries = await fs.readdir(MEDIA_DIR, { withFileTypes: true });
    } catch {
        return [];
    }

    const files = await Promise.all(
        entries
            .filter((entry) => entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase()))
            .map(async (entry) => {
                const ext = path.extname(entry.name).toLowerCase();
                const stat = await fs.stat(path.join(MEDIA_DIR, entry.name)).catch(() => null);
                if (!stat) return null;

                return {
                    id: slugify(entry.name),
                    title: titleFromFilename(entry.name),
                    filename: entry.name,
                    src: `/media/${encodeURIComponent(entry.name)}`,
                    size: stat.size,
                    mime: MIME[ext] || 'video/mp4',
                    local: true,
                    source: 'filesystem'
                };
            })
    );

    return files.filter(Boolean);
}

/* --------------------------------------------------------- database source -- */

/**
 * Read the packager's rendition manifest off a row.
 *
 * Every delivery surface needs the same thing from it - the list of things a
 * client could be given, with a height, a bitrate and a codec on each - so it
 * is unpacked once, here, rather than parsed again in the DeoVR feed, the DLNA
 * browse and the M3U export. That is the same reason `buildLibrary` exists at
 * all: five surfaces reading one shape cannot disagree about what a title is.
 *
 * Titles packaged before renditions were recorded, and titles published without
 * a transcode at all, get an empty list. Callers fall back to `src`, which is
 * what those titles have always been served as.
 *
 * @returns {{renditions: Array<{name: string, height: number, width: number|null,
 *            bitrate: number, codec: string, hls: string|null, mp4: string|null,
 *            bytes: number|null}>, watermarked: boolean}}
 */
export function renditionsForRow(row) {
    return renditionsFrom(row, getStorage());
}

function renditionsFrom(row, storage) {
    const empty = { renditions: [], watermarked: false };
    if (!row.renditions) return empty;

    let parsed;
    try {
        parsed = JSON.parse(row.renditions);
    } catch {
        // A malformed manifest must not take the whole catalog down with it.
        console.warn(`[library] unreadable rendition manifest on ${row.slug}`);
        return empty;
    }

    return {
        watermarked: !!parsed?.watermarked,
        renditions: (parsed?.renditions ?? [])
            .filter((r) => r && r.height)
            .map((r) => ({
                name: r.name ?? `${r.height}p`,
                height: r.height,
                width: r.width ?? null,
                bitrate: r.bitrate ?? 0,
                codec: r.codec ?? 'h264',
                hls: r.hlsKey ? storage.deliveryUrl(r.hlsKey) : null,
                mp4: r.mp4Key ? storage.deliveryUrl(r.mp4Key) : null,
                bytes: r.bytes ?? null
            }))
            .sort((a, b) => b.height - a.height)
    };
}

/**
 * Convert a database row into the shared item shape.
 *
 * `src` is minted here rather than stored, so the same row can be delivered
 * from a local disk today and a CDN edge tomorrow with no migration.
 */
function fromDbRow(row) {
    const storage = getStorage();

    // Prefer the HLS ladder when packaging has produced one: adaptive bitrate
    // is what keeps a 8K stereo title watchable on a congested link.
    const key = row.hls_key || row.source_key;
    const isHls = !!row.hls_key;
    const { renditions, watermarked } = renditionsFrom(row, storage);

    return {
        renditions,
        watermarked,
        id: row.slug,
        dbId: row.id,
        title: row.title,
        synopsis: row.synopsis || '',
        genre: row.genre || '',
        studio: row.studio || '',
        year: row.year || undefined,
        duration: row.duration || 0,
        width: row.width || undefined,
        height: row.height || undefined,
        resolution: row.height ? `${row.height}p` : undefined,
        size: row.size_bytes || undefined,

        projection: row.projection,
        stereo: row.stereo,
        fisheyeFov: row.fisheye_fov || undefined,
        lens: row.lens || undefined,

        src: key ? storage.deliveryUrl(key) : null,
        storageKey: key,
        mime: isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        local: !storage.isRemote,
        source: 'portal',
        creatorId: row.creator_id,
        poster: row.poster_key ? storage.deliveryUrl(row.poster_key) : undefined,
        backdrop: row.backdrop_key ? storage.deliveryUrl(row.backdrop_key) : undefined,
        publishedAt: row.published_at
    };
}

/**
 * The one-rendition stand-in for a title that was never packaged.
 *
 * Files dropped into `public/media/`, entries hand-written into
 * `catalog.json`, and portal uploads that predate the packager or ran with
 * `AVR_SKIP_TRANSCODE=1` all have exactly one thing to serve: whatever `src`
 * points at. Giving them a single-entry list rather than an empty one means
 * every delivery surface iterates renditions unconditionally and none of them
 * needs a "what if there aren't any" branch.
 *
 * Note what this is *not*: it is not watermarked, and it is not adaptive. A
 * self-hoster's own files are their own business, but a portal upload that
 * lands here is a title that skipped the brand mark, and `watermarked` stays
 * false so that is visible rather than assumed.
 */
function soleRendition(item) {
    const isHls = /\.m3u8(\?|$)/i.test(item.src || '') || item.mime === 'application/vnd.apple.mpegurl';

    return {
        name: item.height ? `${item.height}p` : 'source',
        height: item.height ?? 0,
        width: item.width ?? null,
        bitrate: 0,
        codec: item.codec ?? 'h264',
        hls: isHls ? item.src : null,
        mp4: isHls ? null : item.src,
        bytes: item.size ?? null,
        // Not a rung of anything. Surfaces use this to tell "the only thing
        // there is" apart from "the one I chose", and go on addressing it the
        // way they always have rather than through a rendition URL that would
        // only redirect back to the same file.
        synthetic: true
    };
}

/**
 * The filename one rung is presented under.
 *
 * SkyBox, Pigasus and Whirligig read projection and stereo layout from the last
 * path segment and from nowhere else, so every rung needs the full conventional
 * name and not just a suffix on the title's. Regenerating it at the rung's own
 * height is what keeps the resolution tag honest: appending `_1080p` to a name
 * that already ends `_8K_...` produces a file claiming to be both.
 */
export function renditionFilename(item, rendition) {
    return buildConventionalFilename(item.title, item.format, {
        ext: '.mp4',
        height: rendition?.height || item.height
    });
}

/* ------------------------------------------------------------------- build -- */

/**
 * Build the full catalog. Cached; call {@link invalidateCatalog} after writes.
 *
 * @returns {Promise<{items: object[], rows: object[]|null}>}
 */
export function buildLibrary() {
    return catalogCache.get('catalog', async () => {
        const [declared, scanned] = await Promise.all([
            readJson(CATALOG_FILE, { items: [], rows: null }),
            scanMediaDir()
        ]);

        const byId = new Map();

        // Filesystem first, then curated JSON overrides, then database titles -
        // portal uploads are the most authoritative source.
        for (const file of scanned) byId.set(file.id, file);

        for (const item of declared.items || []) {
            const existing = byId.get(item.id);
            byId.set(item.id, existing ? { ...existing, ...item } : { ...item, source: 'catalog.json' });
        }

        for (const row of titlesRepo.listPublished()) {
            const item = fromDbRow(row);
            if (!item.src) continue;
            byId.set(item.id, item);
        }

        const items = [...byId.values()]
            .filter((item) => item.src)
            .map((item) => {
                const format = resolveFormat(item);

                return {
                    ...item,
                    format,
                    duration: item.duration || 0,
                    renditions: item.renditions?.length ? item.renditions : [soleRendition(item)],
                    watermarked: item.watermarked ?? false,
                    conventionalFilename: buildConventionalFilename(item.title, format, {
                        ext: path.extname(item.filename || item.src || '') || '.mp4',
                        height: item.height
                    })
                };
            });

        const rows = Array.isArray(declared.rows)
            ? declared.rows
                  .map((row) => ({ title: row.title, items: row.items.filter((id) => byId.has(id)) }))
                  .filter((row) => row.items.length)
            : null;

        return { items, rows };
    });
}

/** Absolute path on disk for a filesystem-sourced item, or null. */
export function localPathFor(item) {
    if (!item.filename) return null;
    return path.join(MEDIA_DIR, item.filename);
}

export function absoluteUrl(baseUrl, src) {
    return /^https?:\/\//i.test(src) ? src : `${baseUrl}${src}`;
}

export { PROJECTION, STEREO };
