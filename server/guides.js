import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guides: plain documents written for people choosing what to watch on.
 *
 * Served the same way as the policy pages and for the same reason — the
 * readers worth having here are the ones that do not run JavaScript — but
 * kept apart from them, because a guide is published when it is ready rather
 * than because a statute or a processor asks for it.
 *
 * ## The page decides whether it is published, not this file
 *
 * A guide is routed from the moment it is listed below, and goes into the
 * sitemap only once its own robots tag stops saying `noindex`. That keeps the
 * two signals a crawler reads from ever disagreeing: a sitemap that lists a
 * noindex page is asking Google to crawl something it has just been told to
 * drop, and Search Console reports every one of them as an error.
 *
 * Publishing a draft is therefore one edit, in the guide itself: take the
 * draft boxes out, swap the robots tag, add the canonical. `test/seo.test.js`
 * refuses the swap while a draft box is still on the page, and refuses a
 * published guide whose canonical names any address but its own route.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'guides');

/** Extension-less address → file under `public/guides/`. */
export const GUIDES = Object.freeze({
    '/guides/vr-headsets': 'vr-headsets.html'
});

export const guidePath = (file) => path.join(DIR, file);

/** True when the page no longer asks to be kept out of search. */
export function isPublished(html) {
    return !/<meta\s+name="robots"[^>]*noindex/i.test(html);
}

/**
 * The routes that belong in the sitemap, read from disk on every call.
 *
 * Cheap — a handful of small files behind an hour of `Cache-Control` — and it
 * means a guide published by an edit and a deploy is listed without anybody
 * remembering to list it. A file that cannot be read is left out rather than
 * thrown about: the route would 404 too, and a sitemap must not list that.
 */
export function publishedGuides(read = (file) => fs.readFileSync(guidePath(file), 'utf8')) {
    return Object.entries(GUIDES)
        .filter(([, file]) => {
            try {
                return isPublished(read(file));
            } catch {
                return false;
            }
        })
        .map(([route]) => route);
}
