import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRIPS } from '../comic/strips.js';
import { altText, artFile, comicSitemapUrls, publishedStrips, releaseAt, renderPage } from '../server/comic.js';
import { RESERVED_SLUGS } from '../server/channels/slug.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Lusty X. The schedule is a promise printed on the page ("every Tuesday,
 * Thursday and Saturday"), and the release rule is the only thing keeping
 * next week's dialogue off this week's page, so both are pinned here.
 */

const ALL_ART = STRIPS.map((s) => `${String(s.n).padStart(2, '0')}.jpg`);

test('every strip is numbered once, in date order, with four panels', () => {
    const numbers = STRIPS.map((s) => s.n);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'in order');
    assert.equal(new Set(numbers).size, numbers.length, 'no number used twice');

    for (const s of STRIPS) {
        assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, `${s.n} has an ISO date`);
        assert.equal(s.panels.length, 4, `${s.n} has four panels`);
        assert.ok(s.summary.length > 20, `${s.n} has a summary for its alt text`);
    }

    for (let i = 1; i < STRIPS.length; i++) {
        assert.ok(STRIPS[i].date >= STRIPS[i - 1].date, `${STRIPS[i].n} is not dated before ${STRIPS[i - 1].n}`);
    }
});

test('the season runs Tuesday, Thursday and Saturday and peaks on New Year’s Eve', () => {
    const season = STRIPS.filter((s) => s.n >= 5);
    for (const s of season) {
        const day = new Date(`${s.date}T12:00:00Z`).getUTCDay();
        assert.ok([2, 4, 6].includes(day), `${s.n} "${s.title}" is on ${s.date}, not a Tuesday, Thursday or Saturday`);
    }

    assert.equal(STRIPS.find((s) => s.title === 'Midnight').date, '2026-12-31');

    // Three a week, no gaps, from the first strip to the climax.
    const run = season.filter((s) => s.date <= '2026-12-31');
    assert.equal(run[0].date, '2026-11-17');
    for (let i = 1; i < run.length; i++) {
        const gap = (Date.parse(run[i].date) - Date.parse(run[i - 1].date)) / 86_400_000;
        const saturday = new Date(`${run[i - 1].date}T12:00:00Z`).getUTCDay() === 6;
        assert.equal(gap, saturday ? 3 : 2, `${run[i - 1].n} to ${run[i].n} skips a publishing day`);
    }
});

test('a strip comes out at six in the morning New York time, winter or summer', () => {
    assert.equal(releaseAt('2026-11-17'), Date.parse('2026-11-17T11:00:00Z'));
    assert.equal(releaseAt('2027-06-01'), Date.parse('2027-06-01T10:00:00Z'));
});

test('a strip needs both its day and its art', () => {
    const strip = STRIPS.find((s) => s.n === 5);
    const before = releaseAt(strip.date) - 1;
    const after = releaseAt(strip.date);

    assert.ok(!publishedStrips(before, ALL_ART).includes(strip), 'not before six');
    assert.ok(publishedStrips(after, ALL_ART).includes(strip), 'out at six');
    assert.ok(!publishedStrips(after, ALL_ART.filter((f) => f !== '05.jpg')).includes(strip), 'not without art');
});

test('art is found by number, and only in an image format', () => {
    assert.equal(artFile(5, ['05.png', 'notes.txt']), '05.png');
    assert.equal(artFile(5, ['05.txt', '5.jpg', '055.jpg']), null);
    assert.equal(artFile(12, ['12.webp']), '12.webp');
});

test('nothing from an unpublished strip reaches a page or the sitemap', () => {
    // The morning strip 10 comes out: everything after it is still secret.
    const now = releaseAt(STRIPS.find((s) => s.n === 10).date);
    const published = publishedStrips(now, ALL_ART);
    const latest = published.at(-1);
    const html = renderPage({ strip: latest, published, canonical: '/comic' });

    for (const s of STRIPS.filter((x) => !published.includes(x))) {
        assert.ok(!html.includes(`/comic/${s.n}"`), `strip ${s.n} is linked`);
        for (const [, text] of s.panels.flatMap((p) => p.lines)) {
            // Short lines ("Pie!", "No.") also appear in other strips by chance.
            if (text.length < 24) continue;
            assert.ok(!html.includes(text), `strip ${s.n} leaks "${text}"`);
        }
    }

    const locs = comicSitemapUrls(now, ALL_ART).map((u) => u.loc);
    assert.deepEqual(locs, ['/comic', ...published.map((s) => `/comic/${s.n}`).reverse()]);
});

test('a strip page declares itself adult, names its own address, and carries its words', () => {
    const published = publishedStrips(releaseAt('2026-11-21'), ALL_ART);
    const strip = published.at(-1);
    const html = renderPage({ strip, published, canonical: `/comic/${strip.n}` });

    assert.match(html, /<meta name="rating" content="adult" \/>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://lustxr.com/comic/${strip.n}" />`));
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.ok(html.includes('none of them endorsed or'), 'the public-figures note');

    // The transcript says what the strip says, escaped.
    for (const [who] of strip.panels.flatMap((p) => p.lines)) {
        assert.ok(html.includes(`<b>${who}:</b>`), `${who} is in the transcript`);
    }
    assert.ok(altText(strip).includes(strip.summary));
});

test('a comic with nothing out yet asks not to be indexed', () => {
    const html = renderPage({ strip: null, published: [], canonical: '/comic' });
    assert.match(html, /<meta name="robots" content="noindex, follow" \/>/);
});

test('real people in the season are listed where the strip shows them', () => {
    const named = { 5: 'Mike Johnson', 6: 'Elizabeth Warren', 7: 'Donald Trump' };
    for (const [n, who] of Object.entries(named)) {
        const strip = STRIPS.find((s) => s.n === Number(n));
        assert.ok(strip.figures?.some((f) => f.startsWith(who)), `strip ${n} lists ${who} in figures`);
    }
});

test('the comic is linked from the front page with JavaScript and without it', () => {
    const noscript = read('index.html').match(/<noscript>([\s\S]*?)<\/noscript>/)[1];
    assert.ok(noscript.includes('href="/comic"'), 'the crawlable copy links it');

    const browse = read('src/ui/browse.js');
    assert.match(browse, /id="comic-feature-slot"/, 'the card has a slot');
    assert.match(browse, /\['\/comic', 'Lusty X comic'\]/, 'and the footer links it');
});

test('nobody can claim the comic’s address as a channel', () => {
    for (const name of ['comic', 'comics', 'lustyx']) {
        assert.ok(RESERVED_SLUGS.has(name), `${name} is reserved`);
    }
});

test('no real person is in a first panel, which the front page crops to', () => {
    for (const s of STRIPS.filter((x) => x.figures?.length)) {
        for (const figure of s.figures) {
            const surname = figure.split(',')[0].split(' ').at(-1);
            assert.ok(!s.panels[0].art.includes(surname), `strip ${s.n} shows ${surname} in panel 1`);
        }
    }
});

test('an art prompt letters every line of its strip, word for word', async () => {
    const { promptFor, select } = await import('../comic/prompts.js');
    for (const s of STRIPS) {
        const prompt = promptFor(s);
        assert.ok(prompt.includes(`${String(s.n).padStart(2, '0')}  ${s.title.toUpperCase()}`), `${s.n} has its header`);
        for (const [, text] of s.panels.flatMap((p) => p.lines)) {
            assert.ok(prompt.includes(`“${text}”`), `${s.n} letters "${text}"`);
        }
    }
    assert.deepEqual(select('5-7').map((s) => s.n), [5, 6, 7]);
});

test('the saved art prompts are the ones the script would print today', async () => {
    const { promptsDocument } = await import('../comic/prompts.js');
    const saved = read('comic/PROMPTS.md');
    const range = /node comic\/prompts\.js (\S+) --write/.exec(saved)[1];
    assert.equal(saved, promptsDocument(range), `comic/PROMPTS.md is stale: run node comic/prompts.js ${range} --write`);
});

test('no prompt reaches the image model without the safety floor, whoever wrote it', async () => {
    const { safePrompt } = await import('../comic/openai.js');
    const { panelPrompt, customPrompt } = await import('../comic/make.js');

    // A prompt that asks for everything the comic must not draw.
    const hostile = 'nsfw, rating:explicit, 1girl, nude, lustyx, lingerie, young, cleavage, rooftop, night';
    for (const out of [safePrompt(hostile), panelPrompt(hostile, 'ink'), customPrompt(hostile)]) {
        assert.match(out, /(^|, )safe(, |$)/, `"safe" is forced: ${out}`);
        for (const banned of ['nsfw', 'explicit', 'nude', 'lingerie', 'young', 'cleavage']) {
            assert.ok(!out.split(', ').some((t) => t.includes(banned)), `"${banned}" survived: ${out}`);
        }
        assert.ok(out.includes('rooftop'), 'the scene survives');
    }

    // The order panelPrompt depends on: count, original, safe.
    assert.deepEqual(safePrompt('office, 2girls, original').split(', ').slice(0, 3), ['2girls', 'original', 'safe']);
    assert.deepEqual(safePrompt('office').split(', ').slice(0, 3), ['1girl', 'original', 'safe']);
});
