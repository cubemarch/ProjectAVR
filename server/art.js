import { buildLibrary } from './library.js';

/**
 * Procedural artwork.
 *
 * A library assembled by dropping files into a folder has no posters, and an
 * empty grey grid makes the whole app look broken. These SVGs are generated
 * deterministically from the title id, so every item gets stable, distinct art
 * with no binary assets in the repo - and a real poster dropped into the
 * catalog overrides it.
 */

const PALETTES = [
    ['#7c5cff', '#2d1b6b'],
    ['#00d8e0', '#0b4a5c'],
    ['#ff9d3d', '#6b2f10'],
    ['#ff5c8a', '#5c1030'],
    ['#4ade80', '#0f4429'],
    ['#facc15', '#5c4406'],
    ['#60a5fa', '#12356b'],
    ['#c084fc', '#3f1069']
];

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
}

function escapeXml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * Motif hinting at the projection: concentric rings for 360, an arc for 180,
 * a circle for fisheye, a frame for flat.
 */
function motif(projection, w, h, colour, opacity = 0.4) {
    const cx = w * 0.72;
    const cy = h * 0.5;
    const r = Math.min(w, h) * 0.3;
    const stroke = `stroke="${colour}" fill="none" stroke-opacity="${opacity}"`;

    switch (projection) {
        case 'sphere360':
            return `
                <circle cx="${cx}" cy="${cy}" r="${r}" ${stroke} stroke-width="2"/>
                <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.38}" ${stroke} stroke-width="2"/>
                <ellipse cx="${cx}" cy="${cy}" rx="${r * 0.42}" ry="${r}" ${stroke} stroke-width="2"/>
                <line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" ${stroke} stroke-width="2"/>`;
        case 'dome180':
            return `
                <path d="M ${cx - r} ${cy + r * 0.5} A ${r} ${r} 0 0 1 ${cx + r} ${cy + r * 0.5}" ${stroke} stroke-width="3"/>
                <path d="M ${cx - r * 0.6} ${cy + r * 0.5} A ${r * 0.6} ${r * 0.6} 0 0 1 ${cx + r * 0.6} ${cy + r * 0.5}" ${stroke} stroke-width="2"/>
                <line x1="${cx - r * 1.15}" y1="${cy + r * 0.5}" x2="${cx + r * 1.15}" y2="${cy + r * 0.5}" ${stroke} stroke-width="2"/>`;
        case 'fisheye':
            return `
                <circle cx="${cx}" cy="${cy}" r="${r}" ${stroke} stroke-width="3"/>
                <circle cx="${cx}" cy="${cy}" r="${r * 0.62}" ${stroke} stroke-width="2"/>
                <circle cx="${cx}" cy="${cy}" r="${r * 0.24}" ${stroke} stroke-width="2"/>`;
        default:
            return `
                <rect x="${cx - r * 1.2}" y="${cy - r * 0.7}" width="${r * 2.4}" height="${r * 1.4}" rx="6" ${stroke} stroke-width="3"/>
                <line x1="${cx - r * 1.2}" y1="${cy - r * 0.7}" x2="${cx + r * 1.2}" y2="${cy + r * 0.7}" ${stroke} stroke-width="1.5"/>`;
    }
}

/**
 * @param {object} item
 * @param {'poster'|'backdrop'} variant
 * @returns {string} SVG document.
 */
export function renderArt(item, variant) {
    const w = variant === 'backdrop' ? 1920 : 640;
    const h = variant === 'backdrop' ? 1080 : 360;

    const seed = hash(item.id);
    const [a, b] = PALETTES[seed % PALETTES.length];
    const angle = (seed >> 3) % 90;

    // Only posters carry text; see the note in the template below.
    const titleSize = 38;
    const tagSize = 16;

    const badges = [];
    if (item.format.projection === 'dome180') badges.push('180°');
    else if (item.format.projection === 'sphere360') badges.push('360°');
    else if (item.format.projection === 'fisheye') badges.push(`${item.format.fisheyeFov}° FISHEYE`);
    if (item.format.stereo !== 'mono') badges.push('3D');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle})">
      <stop offset="0%" stop-color="${a}"/>
      <stop offset="100%" stop-color="${b}"/>
    </linearGradient>
    <linearGradient id="v" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000" stop-opacity="0.75"/>
      <stop offset="70%" stop-color="#000" stop-opacity="0.1"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  ${
      // At billboard scale the motif is decoration behind a headline, not the
      // subject, so it drops back to a hint.
      motif(item.format.projection, w, h, '#ffffff', variant === 'backdrop' ? 0.13 : 0.4)
  }
  <rect width="${w}" height="${h}" fill="url(#v)"/>
  ${
      // Backdrops sit behind the billboard and modal, both of which draw their
      // own title over the top; burning one into the art just double-prints it.
      variant === 'backdrop'
          ? ''
          : `<text x="${w * 0.06}" y="${h * 0.62}" font-family="Helvetica,Arial,sans-serif" font-size="${titleSize}"
        font-weight="700" fill="#ffffff" letter-spacing="-1">${escapeXml(truncate(item.title, 18))}</text>
  <text x="${w * 0.06}" y="${h * 0.74}" font-family="Helvetica,Arial,sans-serif" font-size="${tagSize}"
        fill="#ffffff" fill-opacity="0.72" letter-spacing="3">${escapeXml(badges.join('  ·  ') || 'STANDARD')}</text>`
  }
</svg>`;
}

function truncate(str, max) {
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/**
 * @param {import('express').Express} app
 */
export function mountArt(app) {
    app.get('/art/:file', async (req, res) => {
        const match = /^(.+)-(poster|backdrop)\.svg$/.exec(req.params.file);
        if (!match) {
            res.status(404).end();
            return;
        }

        const [, id, variant] = match;
        const { items } = await buildLibrary();
        const item = items.find((i) => i.id === id);

        if (!item) {
            res.status(404).end();
            return;
        }

        res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(renderArt(item, variant));
    });
}
