import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { STRIPS } from '../comic/strips.js';
import { rateLimit } from './auth/middleware.js';
import { censorBytes, PLACEHOLDER } from './media/censor.js';
import { viewFor } from './media/view.js';

/**
 * Lusty X, the comic: its page, its art, and when each strip comes out.
 *
 * Server-rendered for the same reason the guides are plain files: the readers
 * worth having on a comic page include the ones that do not run JavaScript,
 * and a strip whose transcript is in the HTML is a strip a crawler can read.
 * Unlike a guide it changes three times a week, which is why it is rendered
 * from `comic/strips.js` rather than written out by hand.
 *
 * ## A strip publishes itself
 *
 * A strip is out from 06:00 New York time on its date, *and* only once its
 * art is in `comic/art/`. Both, so art can ship in a deploy weeks early and
 * still wait for its day, and so a strip whose art is late is simply not out
 * yet rather than a page with a hole in it. Nothing about an unpublished strip
 * leaves this file: not its page, its art, its title or its dialogue.
 *
 * ## The art goes through the censor
 *
 * `docs/CENSOR.md` covers every image the site displays for a visitor who has
 * not verified, ours included, and the strips are no exception even though
 * none of them is explicit. The files are outside `public/` for that reason,
 * the way the house banners are: anything in `public/` is served as shipped
 * to whoever asks for it by name.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART_DIR = path.join(ROOT, 'comic', 'art');
const ART_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const BASE = 'https://lustxr.com';
const SCHEDULE = 'A new strip every Tuesday, Thursday and Saturday at 6 a.m. Eastern.';

/** `NN.jpg` and friends in `comic/art/`, or nothing if the folder is missing. */
export function listArt() {
    try {
        return fs.readdirSync(ART_DIR);
    } catch {
        return [];
    }
}

/** The art file for strip `n`, from a directory listing, or null. */
export function artFile(n, files) {
    const stem = String(n).padStart(2, '0');
    return files.find((f) => path.parse(f).name === stem && Object.hasOwn(ART_TYPES, path.parse(f).ext.toLowerCase())) ?? null;
}

/**
 * 06:00 in New York on `date`, as an epoch millisecond.
 *
 * The offset is asked of `Intl` rather than written down, so a strip dated
 * after the clocks change in March still comes out at six local time.
 */
export function releaseAt(date) {
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
        .formatToParts(new Date(`${date}T12:00:00Z`))
        .find((p) => p.type === 'timeZoneName').value;
    const [, sign, hours] = /GMT([+-])(\d+)/.exec(zone);
    return Date.parse(`${date}T06:00:00${sign}${hours.padStart(2, '0')}:00`);
}

/** Every strip that is out at `now`, in reading order. */
export function publishedStrips(now = Date.now(), files = listArt(), strips = STRIPS) {
    return strips.filter((s) => releaseAt(s.date) <= now && artFile(s.n, files)).sort((a, b) => a.n - b.n);
}

const pad = (n) => String(n).padStart(2, '0');
const href = (strip) => `/comic/${strip.n}`;

function escapeHtml(str) {
    return String(str).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

function longDate(date) {
    return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).format(new Date(`${date}T12:00:00Z`));
}

/** The image's alt text: the strip in one sentence, then the words in it. */
export function altText(strip) {
    const words = strip.panels
        .flatMap((p) => p.lines)
        .map(([who, text]) => `${who}: ${text}`)
        .join(' ');
    return `Lusty X, strip ${strip.n}, ${strip.title}. ${strip.summary} ${words}`.trim();
}

function transcriptHtml(strip) {
    const panels = strip.panels
        .map((panel, i) => {
            const lines = panel.lines.length
                ? panel.lines.map(([who, text]) => `<p><b>${escapeHtml(who)}:</b> ${escapeHtml(text)}</p>`).join('')
                : '<p><i>No words.</i></p>';
            return `<li><span class="panel-no">Panel ${i + 1}</span>${lines}</li>`;
        })
        .join('');

    return `
            <details class="transcript">
                <summary>Transcript</summary>
                <ol>${panels}</ol>
            </details>`;
}

function stripNavHtml(strip, published) {
    const i = published.indexOf(strip);
    const prev = published[i - 1];
    const next = published[i + 1];
    const latest = published.at(-1);

    const link = (to, label, rel) =>
        to ? `<a class="nav-btn" href="${href(to)}"${rel ? ` rel="${rel}"` : ''}>${label}</a>` : `<span class="nav-btn" aria-disabled="true">${label}</span>`;

    return `
            <nav class="strip-nav" aria-label="Strips">
                ${link(published[0] !== strip && published[0], 'First')}
                ${link(prev, '← Previous', 'prev')}
                ${link(next, 'Next →', 'next')}
                ${link(latest !== strip && latest, 'Latest')}
            </nav>`;
}

function archiveHtml(strip, published) {
    const items = [...published]
        .reverse()
        .map(
            (s) => `
                <li><a href="${href(s)}"${s === strip ? ' aria-current="page"' : ''}>
                    <span class="arc-no">${pad(s.n)}</span> ${escapeHtml(s.title)}
                    <span class="arc-date">${escapeHtml(longDate(s.date))}</span>
                </a></li>`
        )
        .join('');

    return `
            <section class="archive" aria-labelledby="archive-title">
                <h2 id="archive-title">Every strip</h2>
                <ol reversed>${items}</ol>
            </section>`;
}

/**
 * One page of the comic.
 *
 * @param {object} opts
 * @param {object|null} opts.strip    The strip shown, or null when none is out yet.
 * @param {object[]} opts.published  Every published strip, in order.
 * @param {string} opts.canonical    The page's own address.
 */
export function renderPage({ strip, published, canonical }) {
    const title = strip ? `Lusty X ${pad(strip.n)}: ${strip.title}` : 'Lusty X';
    const description = strip
        ? strip.summary
        : 'Lusty X, a comic about a VR cam model in Miami and a payout that changed after the fact.';

    // A page with nothing on it yet is not worth a crawler's visit.
    const robots = strip ? 'index, follow, max-image-preview:large' : 'noindex, follow';
    const image = strip ? `${BASE}/comic/art/${strip.n}` : `${BASE}/og-card.png`;

    const jsonLd = strip
        ? `
        <script type="application/ld+json">
            ${JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'ComicStory',
                name: `${pad(strip.n)}: ${strip.title}`,
                description: strip.summary,
                url: `${BASE}${href(strip)}`,
                image,
                datePublished: strip.date,
                inLanguage: 'en',
                isFamilyFriendly: false,
                isPartOf: { '@type': 'ComicSeries', name: 'Lusty X', url: `${BASE}/comic` },
                publisher: { '@id': `${BASE}/#org` }
            })}
        </script>`
        : '';

    const body = strip
        ? `
            <p class="kicker">Lusty X · ${escapeHtml(strip.arc)}</p>
            <h1>${pad(strip.n)}: ${escapeHtml(strip.title)}</h1>
            <p class="updated">${escapeHtml(longDate(strip.date))}</p>

            <figure class="strip">
                <img src="/comic/art/${strip.n}" alt="${escapeHtml(altText(strip))}" />
            </figure>
            ${stripNavHtml(strip, published)}
            ${transcriptHtml(strip)}`
        : `
            <p class="kicker">Lusty X</p>
            <h1>The first strip is on its way</h1>
            <p>${SCHEDULE}</p>`;

    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0b0b0f" />
        <title>${escapeHtml(title)} · LustXR</title>
        <meta name="description" content="${escapeHtml(description)}" />
        <meta name="rating" content="adult" />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
        <meta name="robots" content="${robots}" />
        <link rel="canonical" href="${BASE}${canonical}" />

        <meta property="og:type" content="article" />
        <meta property="og:site_name" content="LustXR" />
        <meta property="og:title" content="${escapeHtml(title)}" />
        <meta property="og:description" content="${escapeHtml(description)}" />
        <meta property="og:url" content="${BASE}${canonical}" />
        <meta property="og:image" content="${image}" />
        <meta name="twitter:card" content="summary_large_image" />
        ${jsonLd}

        <link rel="stylesheet" href="/legal/page.css" />
        <style>
            .wrap { max-width: 760px; }
            .kicker {
                margin: 0 0 6px;
                color: var(--faint);
                font-size: 12px;
                font-weight: 600;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }
            .strip { margin: 0 0 20px; }
            .strip img {
                display: block;
                width: 100%;
                height: auto;
                aspect-ratio: 3 / 4;
                border-radius: 6px;
                background: var(--raised);
            }
            .strip-nav {
                display: grid;
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 8px;
                margin: 0 0 24px;
            }
            .nav-btn {
                padding: 10px 6px;
                border-radius: 999px;
                border: 1px solid var(--line);
                background: var(--raised);
                color: var(--text);
                font-size: 14px;
                font-weight: 600;
                text-align: center;
                text-decoration: none;
            }
            a.nav-btn:hover { border-color: var(--accent); }
            a.nav-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
            span.nav-btn { opacity: 0.35; }
            .transcript {
                margin: 0 0 32px;
                padding: 14px 18px;
                border: 1px solid var(--line);
                border-radius: 8px;
                background: var(--raised);
            }
            .transcript summary { cursor: pointer; color: var(--text); font-weight: 600; }
            .transcript ol { list-style: none; margin: 14px 0 0; padding: 0; }
            .transcript li { margin: 0 0 14px; }
            .transcript p { margin: 0 0 4px; }
            .panel-no {
                display: block;
                color: var(--faint);
                font-size: 11px;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }
            .archive ol { list-style: none; padding: 0; margin: 0; }
            .archive li { margin: 0; border-top: 1px solid var(--line); }
            .archive a {
                display: flex;
                flex-wrap: wrap;
                align-items: baseline;
                gap: 4px 10px;
                padding: 10px 0;
                color: var(--text);
                text-decoration: none;
            }
            .archive a:hover { color: var(--accent); }
            .archive a[aria-current] { color: var(--accent); }
            .arc-no { color: var(--faint); font-variant-numeric: tabular-nums; }
            .arc-date { margin-left: auto; color: var(--faint); font-size: 13px; }
            .fineprint { margin-top: 32px; color: var(--faint); font-size: 13px; }
            @media (max-width: 480px) {
                .strip-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                .arc-date { margin-left: 0; width: 100%; }
            }
        </style>

        <!-- Analytics, the same as the guide's: GA4 behind the production-host
             guard (see \`index.html\`), and Contentsquare. Both are disclosed
             in the privacy policy. -->
        <script>
            window.dataLayer = window.dataLayer || [];
            function gtag() {
                window.dataLayer.push(arguments);
            }
            gtag('js', new Date());
            try {
                const internal = new URLSearchParams(location.search).get('internal');
                if (internal === '1' || internal === '0') localStorage.setItem('avr:internal', internal);
                if (localStorage.getItem('avr:internal') === '1') gtag('set', { traffic_type: 'internal' });
            } catch {}
            gtag('config', 'G-HK6Q0JBGTC');

            if (location.hostname === 'lustxr.com' || location.hostname === 'www.lustxr.com') {
                const tag = document.createElement('script');
                tag.async = true;
                tag.src = 'https://www.googletagmanager.com/gtag/js?id=G-HK6Q0JBGTC';
                document.head.appendChild(tag);
            }
        </script>
        <script src="https://t.contentsquare.net/uxa/2e3ccfd49a95d.js" defer></script>
    </head>
    <body>
        <div class="wrap">
            <header class="site">
                <a class="brand" href="/">Lust<span>XR</span></a>
                <a href="/">Browse VR video →</a>
            </header>

            <main id="main">
            ${body}

            <section aria-labelledby="about-title">
                <h2 id="about-title">About Lusty X</h2>
                <p>
                    Lusty X is a cam model in Miami with a stereo camera, a borrowed headset
                    and a mind that notices when numbers move. When a friend’s payout statement
                    changes after the fact, she starts asking who prefers the revised edition.
                </p>
                <p>${SCHEDULE}</p>
            </section>
            ${published.length ? archiveHtml(strip, published) : ''}

            <p class="fineprint">
                Fiction. The characters, companies and cases in Lusty X are invented. Real
                public figures appear only as political commentary; none of them endorsed or
                took part in this comic.
            </p>
            </main>

            <footer class="site">
                <nav aria-label="Policies">
                    <a href="/">Home</a>
                    <a href="/guides/vr-headsets">VR headset guide</a>
                    <a href="/terms">Terms</a>
                    <a href="/privacy">Privacy</a>
                    <a href="/support">Support</a>
                    <a href="/2257">2257 statement</a>
                    <a href="/dmca">Content removal</a>
                </nav>
                <p>LustXR is an adult site. You must be 18 or older to use it.</p>
            </footer>
        </div>
    </body>
</html>
`;
}

/**
 * `/comic`, `/comic/:n`, `/comic/art/:n` and `/api/comic/latest`.
 *
 * Mounted outside the build-only block in `server/index.js`, so it works on a
 * dev server with no `dist/` as well as in production.
 */
export function mountComic(app) {
    // Nags the deploy log, not the reader: a strip due within a week with no
    // art will not come out on its day.
    const soon = Date.now() + 7 * 86_400_000;
    const files = listArt();
    for (const s of STRIPS) {
        if (releaseAt(s.date) <= soon && !artFile(s.n, files)) {
            console.warn(`[comic] strip ${pad(s.n)} "${s.title}" is due ${s.date} and comic/art/ has no ${pad(s.n)}.jpg`);
        }
    }

    const page = (res, status, html) => {
        res.status(status);
        res.set('Content-Type', 'text/html; charset=utf-8');
        // Short, because the front of the series changes at six o'clock and a
        // stale `/comic` is a reader told there is nothing new.
        res.set('Cache-Control', 'public, max-age=300');
        res.send(html);
    };

    app.get('/comic', (_req, res) => {
        const published = publishedStrips();
        page(res, 200, renderPage({ strip: published.at(-1) ?? null, published, canonical: '/comic' }));
    });

    app.get('/comic/:n(\\d{1,3})', (req, res) => {
        const published = publishedStrips();
        const strip = published.find((s) => s.n === Number(req.params.n));

        if (!strip) {
            // The same answer for a strip that is not out yet and one that
            // will never exist, so the address says nothing about the plan.
            page(res, 404, renderPage({ strip: published.at(-1) ?? null, published, canonical: '/comic' }));
            return;
        }

        page(res, 200, renderPage({ strip, published, canonical: href(strip) }));
    });

    app.get('/comic/art/:n(\\d{1,3})', rateLimit({ windowMs: 60_000, max: 300 }), async (req, res) => {
        const files = listArt();
        const strip = publishedStrips(Date.now(), files).find((s) => s.n === Number(req.params.n));
        if (!strip) {
            res.sendStatus(404);
            return;
        }

        const file = artFile(strip.n, files);
        const view = viewFor(req);

        if (!view.covered) {
            res.set('Cache-Control', view.cacheControl);
            res.type(ART_TYPES[path.extname(file).toLowerCase()]);
            res.sendFile(path.join(ART_DIR, file));
            return;
        }

        const bytes = await fs.promises.readFile(path.join(ART_DIR, file)).catch(() => null);
        const covered = bytes ? await censorBytes(`comic-${strip.n}`, bytes).catch(() => null) : null;

        if (!covered) {
            res.set('Content-Type', 'image/svg+xml');
            res.set('Cache-Control', 'private, max-age=5');
            res.send(PLACEHOLDER);
            return;
        }

        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', view.cacheControl);
        res.send(covered);
    });

    // What the front page's card needs, and nothing else.
    app.get('/api/comic/latest', (_req, res) => {
        const latest = publishedStrips().at(-1);
        res.set('Cache-Control', 'public, max-age=300');
        res.json(
            latest
                ? { n: latest.n, title: latest.title, date: latest.date, href: href(latest), image: `/comic/art/${latest.n}` }
                : null
        );
    });
}

/** The comic's addresses for the sitemap, newest strip first. */
export function comicSitemapUrls(now = Date.now(), files = listArt()) {
    const published = publishedStrips(now, files);
    if (!published.length) return [];
    return [{ loc: '/comic', priority: '0.6', changefreq: 'daily' }, ...published.reverse().map((s) => ({ loc: href(s), priority: '0.5', changefreq: 'yearly' }))];
}
