import { resolveFormat, formatBadges, isImmersive, PROJECTION, STEREO } from './media-format.js';

/**
 * Catalog loading and shelf construction.
 */

/**
 * Fetch the library and decorate every entry with its resolved format.
 *
 * Prefers the API (which the compatibility server also serves to DeoVR and
 * DLNA, so everything stays in sync) and falls back to the static file when the
 * app is hosted without a backend.
 *
 * @param {string} [url]
 * @returns {Promise<{items: object[], rows: object[]}>}
 */
export async function loadCatalog(url = '/api/catalog') {
    let raw;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        raw = await res.json();
    } catch {
        const res = await fetch('/catalog.json');
        raw = await res.json();
    }

    const items = (raw.items || []).map(decorate);

    return { items, rows: buildRows(items, raw.rows) };
}

function decorate(item) {
    const format = resolveFormat(item);

    return {
        ...item,
        format,
        badges: formatBadges(format),
        immersive: isImmersive(format),
        poster: item.poster || `/art/${item.id}-poster.svg`,
        backdrop: item.backdrop || `/art/${item.id}-backdrop.svg`
    };
}

/**
 * Build the browse shelves.
 *
 * Explicit rows from the catalog win; otherwise we derive a sensible default
 * set. Empty rows are dropped so a small library does not render a page of
 * headings with nothing under them.
 *
 * @param {object[]} items
 * @param {object[]} [declared]
 * @returns {object[]}
 */
function buildRows(items, declared) {
    if (Array.isArray(declared) && declared.length) {
        return declared
            .map((row) => ({
                title: row.title,
                items: row.items.map((id) => items.find((i) => i.id === id)).filter(Boolean)
            }))
            .filter((row) => row.items.length);
    }

    const rows = [
        { title: 'Trending Now', items: items.filter((i) => i.trending) },
        { title: 'VR 180 · Stereoscopic', items: items.filter((i) => i.format.projection === PROJECTION.DOME180) },
        { title: '360° Experiences', items: items.filter((i) => i.format.projection === PROJECTION.SPHERE360) },
        { title: 'Fisheye & Wide Lens', items: items.filter((i) => i.format.projection === PROJECTION.FISHEYE) },
        { title: 'Standard Video', items: items.filter((i) => !i.immersive) },
        { title: 'All Titles', items }
    ];

    return rows.filter((row) => row.items.length);
}

/**
 * Pick the hero title for the billboard.
 *
 * @param {object[]} items
 * @returns {object|null}
 */
export function pickHero(items) {
    return items.find((i) => i.hero) || items.find((i) => i.immersive) || items[0] || null;
}

/**
 * Case-insensitive search across title, synopsis, genre and format tags, so
 * typing "360" or "3D" finds things too.
 *
 * @param {object[]} items
 * @param {string} query
 * @returns {object[]}
 */
export function searchCatalog(items, query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    return items.filter((item) => {
        const haystack = [
            item.title,
            item.synopsis,
            item.genre,
            ...(item.tags || []),
            ...item.badges,
            item.format.projection === PROJECTION.DOME180 ? '180' : '',
            item.format.projection === PROJECTION.SPHERE360 ? '360' : '',
            item.format.stereo !== STEREO.MONO ? '3d stereo' : '2d'
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        return haystack.includes(q);
    });
}

/** Format seconds as H:MM:SS or M:SS. */
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';

    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}
