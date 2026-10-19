import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Search and discoverability surfaces.
 *
 * Everything here is a tag or a line in a text file, which is exactly why it
 * needs a test: none of it changes how the site behaves, so none of it breaks
 * visibly when it is deleted. A `<meta>` removed while tidying a head block
 * produces a site that works perfectly and quietly stops being classified the
 * way it asked to be, and the first evidence is a ranking change weeks later
 * that looks like it could be anything.
 *
 * Two of these are not ordinary SEO hygiene but statements about what this
 * site is, and they are the reason the file exists at all:
 *
 *   - **The adult rating.** Google's explicit-content guidelines ask a site
 *     like this one to declare itself, and the consequence of not declaring
 *     is not a penalty — it is being classified by a machine looking at a
 *     page that is empty until JavaScript runs. Both outcomes of guessing
 *     wrong are bad, and only one of them is recoverable quickly.
 *   - **`noindex` on the broadcast document.** A session address is dead
 *     minutes after it is created. Indexing one spends our crawl budget to
 *     produce a result that 404s for whoever clicks it.
 */

const INDEX = read('index.html');
const LIVE = read('live.html');
const ROBOTS = read('public/robots.txt');

/* ------------------------------------------------- explicit declaration -- */

test('both documents declare themselves adult', () => {
    for (const [name, html] of [
        ['index.html', INDEX],
        ['live.html', LIVE]
    ]) {
        assert.match(
            html,
            /<meta\s+name="rating"\s+content="adult"\s*\/?>/,
            `${name} is missing the adult rating Google's explicit guidelines ask for`
        );

        // The RTA label is what parental-control software and device-level
        // filters read. Google treats it as interchangeable with the tag
        // above and asks for only one; the two are both here because the
        // things that read the second have never heard of the first.
        assert.match(
            html,
            /content="RTA-5042-1996-1400-1577-RTA"/,
            `${name} is missing the RTA label`
        );
    }
});

test('the catalogue is indexable and the broadcast document is not', () => {
    assert.doesNotMatch(
        INDEX,
        /<meta\s+name="robots"[^>]*noindex/,
        'the home page must not be noindex — it is the page the whole site ranks on'
    );
    assert.match(INDEX, /max-image-preview:large/, 'results should be allowed a thumbnail');

    assert.match(
        LIVE,
        /<meta\s+name="robots"\s+content="noindex/,
        'a session address outlives nothing and must not be indexed'
    );
});

test('the home page says where it canonically lives', () => {
    // Without this, `lustxr.com/` and `www.lustxr.com/` are two pages with
    // the same content as far as a crawler is concerned, and whatever ranking
    // the site earns is split between them.
    assert.match(INDEX, /<link\s+rel="canonical"\s+href="https:\/\/lustxr\.com\/"\s*\/?>/);
});

/* ------------------------------------------------------ crawlable text -- */

test('the home page carries content for crawlers that do not run JavaScript', () => {
    // This is the whole of the site's presence in anything that reads HTML as
    // text rather than rendering it — which is most of what feeds a
    // generative answer. The body is otherwise four empty divs.
    assert.match(INDEX, /<noscript>/, 'no fallback content at all');
    assert.match(INDEX, /application\/ld\+json/, 'no structured data');

    const ld = INDEX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ld, 'the structured data block is findable');

    const graph = JSON.parse(ld[1]);
    assert.equal(graph['@context'], 'https://schema.org');

    const types = graph['@graph'].map((node) => node['@type']);
    assert.ok(types.includes('WebSite'), 'a WebSite node');
    assert.ok(types.includes('Organization'), 'an Organization node');

    // The same declaration the rating tag makes, in the vocabulary Google
    // builds a knowledge panel from. Saying one and not the other invites
    // the two to be reconciled by guesswork.
    const site = graph['@graph'].find((node) => node['@type'] === 'WebSite');
    assert.equal(site.isFamilyFriendly, false);
});

/**
 * The fallback has to describe the page that is actually served.
 *
 * `docs/SEARCH.md` §2 puts it plainly: the moment the `<noscript>` describes
 * something the rendered page does not, it stops being a fallback and
 * becomes cloaking. That is not a hypothetical here — it has already
 * happened once. The text claimed the site "sorts it by format" and that
 * "every entry here is labelled with its projection and its stereo layout",
 * and neither was true: `_affiliateCardHtml` renders a title, a partner and
 * a duration, and the format filters are drawn under a Coming Soon sign.
 *
 * The exposure is one-directional and quiet. Nothing fails, nothing looks
 * wrong in a browser, and the only reader who sees both the claim and the
 * page is a crawler. So the check is on the two specific claims that went
 * stale, plus the sentence that keeps the rest honest.
 */
test('the crawlable fallback does not claim features the page marks as Coming Soon', () => {
    const noscript = INDEX.match(/<noscript>([\s\S]*?)<\/noscript>/);
    assert.ok(noscript, 'the fallback is findable');
    const text = noscript[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    assert.doesNotMatch(
        text,
        /[Ee]very entry here is labelled/,
        'affiliate cards carry no projection or stereo label, so this would be a claim about nothing'
    );
    assert.doesNotMatch(
        text,
        /sorts it by format/,
        'the format filters are drawn disabled under a Coming Soon badge'
    );

    // And it says which of the two it is. A fallback that silently drops the
    // claim reads as a smaller site; one that dates it reads as an honest
    // one, and it is the only text an AI crawler gets — see `docs/SEARCH.md`.
    assert.match(
        text,
        /in progress|not yet available/,
        'the fallback says the own-library is not live rather than just omitting it'
    );
});

/* ------------------------------------------------------------ robots -- */

test('robots.txt points at the sitemap', () => {
    // A sitemap nothing references is a sitemap nothing fetches, short of
    // submitting it by hand in Search Console and never changing it.
    assert.match(ROBOTS, /^Sitemap: https:\/\/lustxr\.com\/sitemap\.xml$/m);
});

test('robots.txt lets the catalogue be crawled and keeps the APIs out', () => {
    assert.match(ROBOTS, /^Allow: \/$/m);
    assert.match(ROBOTS, /^Disallow: \/api\/$/m);

    // `Disallow: /` anywhere in this file would take the site out of search
    // entirely, and it is one character away from the line above it.
    assert.doesNotMatch(ROBOTS, /^Disallow: \/$/m, 'the whole site is blocked from crawling');
});

test('the crawlers that feed generative answers are named and allowed', () => {
    // Named rather than left to the wildcard, because several of them honour
    // their own user-agent and ignore `*`, and because Google-Extended is a
    // separate opt-in from Googlebot: a site that never mentions it is absent
    // from AI Overviews and Gemini grounding while ranking normally in
    // Search, which is a difference nobody notices by looking at rankings.
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']) {
        assert.match(ROBOTS, new RegExp(`^User-agent: ${bot}$`, 'm'), `${bot} is not addressed`);
    }
});

/* ------------------------------------------------------ policy pages -- */

test('every policy page the site links to exists and is indexable', () => {
    // A broken link to a terms page is worse than no link: it is the exact
    // shape of a site that put a footer together and never built what it
    // pointed at, and it is read that way by the people who assess whether a
    // domain is what it claims to be.
    const linked = [...INDEX.matchAll(/href="\/(support|privacy|terms|2257|dmca)"/g)].map(
        (m) => m[1]
    );

    const FILES = {
        terms: 'terms.html',
        privacy: 'privacy.html',
        2257: '2257.html',
        dmca: 'dmca.html',
        support: 'support.html'
    };

    for (const page of new Set(linked)) {
        const file = FILES[page];
        assert.ok(file, `index.html links to /${page}, which has no file behind it`);

        const html = read(path.join('public', 'legal', file));
        assert.match(html, /<meta\s+name="rating"\s+content="adult"/, `/${page} declares itself`);
        assert.match(html, /rel="canonical"/, `/${page} has a canonical URL`);
        assert.doesNotMatch(html, /noindex/, `/${page} should be findable`);
    }
});

test('the policy pages do not link to each other through a hole', () => {
    // These five cross-link heavily in their footers, which is the point —
    // a reviewer landing on any one of them can reach the rest. It also
    // means one renamed file leaves four dead links behind it, on exactly
    // the pages whose job is to look like someone is minding the shop.
    const ROUTES = {
        '/': true,
        '/terms': 'terms.html',
        '/privacy': 'privacy.html',
        '/2257': '2257.html',
        '/dmca': 'dmca.html',
        '/support': 'support.html'
    };

    for (const [route, file] of Object.entries(ROUTES)) {
        if (file === true) continue;

        const full = path.join(ROOT, 'public', 'legal', file);
        assert.ok(fs.existsSync(full), `${route} is routed to ${file}, which does not exist`);

        for (const [, href] of read(path.join('public', 'legal', file)).matchAll(
            /href="(\/[^"#]*)"/g
        )) {
            // The stylesheet is a real file rather than a route.
            if (href.startsWith('/legal/')) continue;

            assert.ok(href in ROUTES, `${file} links to ${href}, which nothing serves`);
        }
    }
});

test('the site publishes one contact address, not two', () => {
    // The structured data is the copy a knowledge panel and a generative
    // answer quote, so it is the copy most likely to be the one a reader
    // actually uses - and it is the only one with no page around it to show
    // that it is wrong. An address here that nothing delivers to is a DMCA
    // notice that never arrives, on a site whose removal policy is the main
    // thing it is judged on.
    const ADDRESS = 'contact@lustxr.com';

    const ld = JSON.parse(INDEX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const org = ld['@graph'].find((node) => node['@type'] === 'Organization');

    assert.equal(org.email, ADDRESS);
    assert.equal(org.contactPoint.email, ADDRESS);

    for (const file of ['terms.html', 'privacy.html', '2257.html', 'dmca.html', 'support.html']) {
        const html = read(path.join('public', 'legal', file));
        assert.match(html, new RegExp(`mailto:${ADDRESS}`), `${file} publishes a different one`);
    }
});

test('the exemption statement says the thing it exists to say', () => {
    // The whole document rests on one factual claim — that this site hosts
    // nothing — and that claim is what makes an exemption rather than a
    // records statement lawful. If the site ever starts hosting its own
    // video, this page has to be rewritten before it does, and a test that
    // merely checked the file existed would not say so.
    const html = read('public/legal/2257.html');

    // Whitespace-tolerant: the sentence is long enough that the formatter
    // wraps it, and where it wraps changes when a word either side of it
    // changes. Matching the literal would make this test fail on a reflow.
    assert.match(html, /does not\s+produce,\s+film,\s+upload,\s+host or\s+store/i);
    assert.match(html, /28 C\.F\.R\./, 'cites the regulation the exemption comes from');
    assert.match(html, /contact@lustxr\.com/, 'and says where to send an enquiry');

    // The same claim, made to the crawler on the home page. These two have
    // to agree: a directory in its own terms and a host in its markup is
    // the discrepancy that makes the rest of the page not worth believing.
    assert.match(INDEX, /does not host or produce/i);
});
