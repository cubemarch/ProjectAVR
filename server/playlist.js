import { buildLibrary, absoluteUrl } from './library.js';

/**
 * M3U playlist export.
 *
 * The universal fallback: Whirligig, and effectively every other player with an
 * "open URL" box, can load a whole library from one of these. Projection
 * survives the trip because each entry's URL ends in a conventionally-named
 * file and the #EXTINF title carries the same tags.
 */

function baseUrlFor(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${req.get('host')}`;
}

/**
 * @param {import('express').Express} app
 */
export function mountPlaylist(app) {
    app.get('/playlist.m3u', async (req, res) => {
        const base = baseUrlFor(req);
        const { items } = await buildLibrary();

        const filter = req.query.projection;
        const list = filter ? items.filter((i) => i.format.projection === filter) : items;

        const lines = ['#EXTM3U'];

        for (const item of list) {
            const label = item.conventionalFilename.replace(/\.[^.]+$/, '');
            const url = item.local
                ? `${base}/media/by-name/${encodeURIComponent(item.id)}/${encodeURIComponent(item.conventionalFilename)}`
                : absoluteUrl(base, item.src);

            lines.push(`#EXTINF:${Math.round(item.duration || -1)},${label}`);
            lines.push(url);
        }

        res.type('audio/x-mpegurl')
            .set('Content-Disposition', 'inline; filename="projectavr.m3u"')
            .send(`${lines.join('\n')}\n`);
    });
}
