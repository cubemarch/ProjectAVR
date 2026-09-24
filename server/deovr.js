import { toDeoVR } from '../src/catalog/media-format.js';
import { buildLibrary, absoluteUrl } from './library.js';
import { users, titles as titlesRepo } from './db/index.js';
import { getStorage } from './storage/index.js';

/**
 * DeoVR JSON feed - also the format Play'a consumes when you add a custom site.
 *
 * Two endpoints make up the contract:
 *
 *   GET /deovr            the library, grouped into named scenes
 *   GET /deovr/video/:id  one title, with its sources and 3D layout
 *
 * The shape below is the documented DeoVR site-integration schema. Field names
 * are snake_case in some places and camelCase in others; that inconsistency is
 * in the spec itself, not a mistake here, and the players are strict about it.
 */

/**
 * @param {import('express').Request} req
 * @returns {string} Scheme + host the client actually used, so URLs we hand
 *   back are reachable from the headset rather than from localhost.
 */
function baseUrlFor(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${req.get('host')}`;
}

function groupIntoScenes(items, rows) {
    if (rows && rows.length) {
        return rows.map((row) => ({
            name: row.title,
            items: row.items.map((id) => items.find((i) => i.id === id)).filter(Boolean)
        }));
    }

    const immersive = items.filter((i) => i.format.projection !== 'flat');
    const flat = items.filter((i) => i.format.projection === 'flat');

    return [
        { name: 'VR', items: immersive },
        { name: 'Standard', items: flat }
    ].filter((scene) => scene.items.length);
}

/**
 * @param {import('express').Express} app
 */
function toScene(scene, base) {
    return {
        name: scene.name,
        list: scene.items.map((item) => ({
            title: item.title,
            videoLength: Math.round(item.duration || 0),
            // Pointing at the detail endpoint (rather than the file) is what
            // lets DeoVR read projection metadata before it starts playing.
            video_url: `${base}/deovr/video/${encodeURIComponent(item.id)}`,
            thumbnailUrl: absoluteUrl(base, item.poster || `/art/${item.id}-poster.svg`)
        }))
    };
}

export function mountDeoVR(app) {
    /**
     * Per-creator feed.
     *
     * DeoVR and Play'a have no login flow, so identity has to ride in the URL.
     * The token is opaque and rotatable from the portal, and grants the public
     * catalog plus that creator's own unpublished titles - which is how you
     * preview a title in a headset before publishing it.
     */
    app.get('/deovr/u/:token', async (req, res) => {
        const user = users.byFeedToken(req.params.token);

        if (!user) {
            res.status(404).json({ authorized: '0', scenes: [] });
            return;
        }

        const base = baseUrlFor(req);
        const { items, rows } = await buildLibrary();
        const storage = getStorage();

        const drafts = titlesRepo
            .listByCreator(user.id)
            .filter((row) => row.status !== 'published' && (row.hls_key || row.source_key))
            .map((row) => ({
                id: row.slug,
                title: `${row.title} · ${row.status}`,
                duration: row.duration || 0,
                poster: row.poster_key ? storage.deliveryUrl(row.poster_key) : `/art/${row.slug}-poster.svg`
            }));

        const scenes = groupIntoScenes(items, rows);
        if (drafts.length) scenes.unshift({ name: 'Your unpublished titles', items: drafts });

        res.set('Cache-Control', 'private, no-store');
        res.json({ authorized: '1', scenes: scenes.map((scene) => toScene(scene, base)) });
    });

    app.get('/deovr', async (req, res) => {
        const base = baseUrlFor(req);
        const { items, rows } = await buildLibrary();

        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            // The public catalog needs no credentials; DeoVR still expects the key.
            authorized: '1',
            scenes: groupIntoScenes(items, rows).map((scene) => toScene(scene, base))
        });
    });

    app.get('/deovr/video/:id', async (req, res) => {
        const base = baseUrlFor(req);
        const { items } = await buildLibrary();
        let item = items.find((i) => i.id === req.params.id);

        // Drafts are absent from the public catalog but reachable from a
        // creator's own feed, so fall back to a direct lookup before 404ing.
        if (!item) {
            const row = titlesRepo.bySlug(req.params.id);
            const key = row?.hls_key || row?.source_key;

            if (row && key) {
                const storage = getStorage();
                item = {
                    id: row.slug,
                    title: row.title,
                    synopsis: row.synopsis,
                    duration: row.duration,
                    width: row.width,
                    height: row.height,
                    src: storage.deliveryUrl(key),
                    poster: row.poster_key ? storage.deliveryUrl(row.poster_key) : null,
                    format: {
                        projection: row.projection,
                        stereo: row.stereo,
                        fisheyeFov: row.fisheye_fov,
                        lens: row.lens
                    }
                };
            }
        }

        if (!item) {
            res.status(404).json({ error: 'not found' });
            return;
        }

        const { screenType, stereoMode, is3d } = toDeoVR(item.format);
        const width = item.width || 0;
        const height = item.height || 0;

        res.json({
            id: item.id,
            title: item.title,
            description: item.synopsis || '',
            videoLength: Math.round(item.duration || 0),

            is3d,
            screenType,
            stereoMode,
            skipIntro: 0,

            thumbnailUrl: absoluteUrl(base, item.poster || `/art/${item.id}-poster.svg`),
            videoThumbnail: item.previewClip ? absoluteUrl(base, item.previewClip) : undefined,

            encodings: [
                {
                    name: item.codec || 'h264',
                    videoSources: [
                        {
                            // `resolution` is the height, and drives the quality
                            // picker label in both DeoVR and Play'a.
                            resolution: height || 1080,
                            height: height || undefined,
                            width: width || undefined,
                            url: absoluteUrl(base, item.src)
                        }
                    ]
                }
            ],

            timeStamps: (item.chapters || []).map((c) => ({ ts: Math.round(c.time), name: c.name }))
        });
    });
}
