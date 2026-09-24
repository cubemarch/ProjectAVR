/**
 * The capture app's privacy policy and support pages.
 *
 * Apple requires a reachable privacy policy for any app that uses the camera
 * (Guideline 5.1.1) and expects a working support URL in the App Store Connect
 * metadata. Both are static documents with no dependency on the rest of the
 * server, which is why they are plain files rather than anything rendered.
 *
 * Two things about *where* they are served matter more than how.
 *
 * The capture app is a content-neutral broadcasting tool and must not link to a
 * viewing platform - so whatever host name ends up in the app's `Info.plist`
 * should belong to the tool, not to a catalogue. These routes can live behind
 * such a host name while running in the same process; nothing here assumes
 * otherwise, and nothing on either page mentions anything but the app.
 *
 * And they are mounted rather than left to the static middleware, because the
 * SPA catch-all would otherwise answer `/privacy` with `index.html` once a
 * `dist/` exists - which is to say the link would work in development and
 * quietly stop working in production, at the point where a reviewer clicks it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = path.join(ROOT, 'public', 'legal');

/**
 * Where support mail goes.
 *
 * Deliberately not baked into the HTML. An address checked into a public
 * repository is an address in every scraper's list within a week, and the
 * person who deploys this is not necessarily the person who answers it.
 */
const SUPPORT_EMAIL = (process.env.AVR_SUPPORT_EMAIL || '').trim();

/**
 * The contact block, or a warning that there is not one.
 *
 * Failing visibly is the point. An unset address that rendered as an empty
 * space would ship, pass every test, and be discovered by a reviewer following
 * the support URL - so the page says what is wrong instead, in a box nobody can
 * mistake for content.
 */
function contactBlock() {
    if (!SUPPORT_EMAIL) {
        return `<div class="unconfigured">
        This deployment has not set a support contact. Set
        <code>AVR_SUPPORT_EMAIL</code> before publishing - the App Store
        requires a working support URL, and this page is not one yet.
    </div>`;
    }

    const escaped = escapeHtml(SUPPORT_EMAIL);
    return `<div class="contact">
        <strong>Contact</strong><br>
        <a href="mailto:${encodeURI(SUPPORT_EMAIL)}">${escaped}</a><br>
        Please include the app version from <strong>Diagnostics</strong>.
    </div>`;
}

function escapeHtml(value) {
    return value.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

/** Read once. These are files in the deployment, not content. */
const cache = new Map();

function render(name) {
    if (!cache.has(name)) {
        const html = fs.readFileSync(path.join(PAGE_DIR, `${name}.html`), 'utf8');
        cache.set(name, html.replace('{{CONTACT}}', contactBlock()));
    }

    return cache.get(name);
}

/**
 * @param {import('express').Express} app
 */
export function mountLegal(app) {
    for (const [route, page] of [
        ['/privacy', 'privacy'],
        ['/support', 'support']
    ]) {
        app.get(route, (req, res) => {
            res.type('html');
            // Short rather than immutable: these are the pages that get edited
            // in a hurry during a review, and a year-long cache on the copy a
            // reviewer already fetched is not recoverable.
            res.set('Cache-Control', 'public, max-age=300');
            res.send(render(page));
        });
    }
}
