import { buildLibrary, absoluteUrl, renditionFilename } from './library.js';
import { profileFor, preferredRendition, listProfiles } from './delivery/profiles.js';

/**
 * M3U playlist export.
 *
 * The universal fallback: Whirligig, and effectively every other player with an
 * "open URL" box, can load a whole library from one of these. Projection
 * survives the trip because each entry's URL ends in a conventionally-named
 * file and the #EXTINF title carries the same tags.
 *
 * M3U carries one URL per entry and no notion of alternatives, so the choice
 * that DeoVR makes in its quality menu and DLNA makes across several `<res>`
 * elements has to be made here instead. It is made from the device profile -
 * the client's own if it announced one, otherwise `?device=`, otherwise the
 * conservative default. A creator handing a playlist to someone on a Quest 2
 * appends `?device=quest2` and gets a file that plays there.
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
        const profile = profileFor(req);

        const filter = req.query.projection;
        const list = filter ? items.filter((i) => i.format.projection === filter) : items;

        // A comment, so every player ignores it, but the one thing that makes a
        // wrong-looking playlist diagnosable: which ceiling produced it.
        const lines = ['#EXTM3U', `# ProjectAVR - renditions selected for: ${profile.label} (${profile.id})`];

        for (const item of list) {
            const label = item.conventionalFilename.replace(/\.[^.]+$/, '');
            const rendition = preferredRendition(item.renditions, profile);

            // A packaged rung goes out under the conventional name rebuilt at
            // that rung's own height, so the projection tags survive and the
            // resolution tag describes the file actually being served. A title
            // with nothing but itself to offer keeps the URL it always had.
            const packaged = rendition?.mp4 && !rendition.synthetic;

            const url = packaged
                ? `${base}/media/by-name/${encodeURIComponent(item.id)}/${encodeURIComponent(
                      renditionFilename(item, rendition)
                  )}?rendition=${encodeURIComponent(rendition.name)}&codec=${encodeURIComponent(rendition.codec)}`
                : item.local
                  ? `${base}/media/by-name/${encodeURIComponent(item.id)}/${encodeURIComponent(item.conventionalFilename)}`
                  : absoluteUrl(base, rendition?.hls || item.src);

            lines.push(`#EXTINF:${Math.round(item.duration || -1)},${label}`);
            lines.push(url);
        }

        res.type('audio/x-mpegurl')
            .set('Content-Disposition', 'inline; filename="projectavr.m3u"')
            .send(`${lines.join('\n')}\n`);
    });

    /**
     * What the profiles actually are.
     *
     * Published because `?device=` is only useful to someone who can find out
     * what to put in it, and because a creator whose headset is being served
     * the wrong rung needs to be able to see the ceiling that decided it.
     */
    app.get('/delivery/profiles.json', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300').json({
            detected: profileFor(req).id,
            profiles: listProfiles().map(({ id, label, maxHeight, maxBitrateKbps, codecs, container, note }) => ({
                id,
                label,
                // JSON has no Infinity; null reads as "no ceiling" and survives
                // the round trip, which `Infinity` would not.
                maxHeight: Object.fromEntries(
                    Object.entries(maxHeight).map(([codec, h]) => [codec, Number.isFinite(h) ? h : null])
                ),
                maxBitrateKbps: Number.isFinite(maxBitrateKbps) ? maxBitrateKbps : null,
                codecs,
                container,
                note
            }))
        });
    });
}
