/**
 * Browser smoke test.
 *
 * Boots the built app against a running server and asserts the things a unit
 * test cannot reach: that PlayCanvas initialises, the stereo shader compiles on
 * a real GL context, the browse UI renders from the catalog, and that entering
 * an immersive title switches to the rendered surface without throwing.
 *
 * Run with:  npm run build && npm start &  then  node test/smoke.mjs
 */

import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';

const failures = [];
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`);
    if (!ok) failures.push(label);
};

const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const pageErrors = [];

page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));

console.log(`\n  Smoke test against ${URL}\n`);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 15000 });

/* ------------------------------------------------------------------ browse -- */

const cardCount = await page.locator('.card').count();
check('browse renders cards', cardCount > 0, `${cardCount} cards`);

const heroTitle = await page.locator('.billboard h1').textContent();
check('billboard has a hero title', !!heroTitle?.trim(), heroTitle);

const shelfCount = await page.locator('.shelf').count();
check('shelves rendered', shelfCount > 0, `${shelfCount} shelves`);

// Badges only exist for immersive titles, so assert the correspondence rather
// than their bare presence - a flat-only library legitimately has none.
const { immersiveCount, immersiveId } = await page.evaluate(async () => {
    const { items } = await (await fetch('/api/catalog')).json();
    const immersive = items.filter((i) => i.format.projection !== 'flat' || i.format.stereo !== 'mono');
    return { immersiveCount: immersive.length, immersiveId: immersive[0]?.id ?? null };
});

const badgeText = await page.locator('.card-badges .badge').allTextContents();
check(
    'format badges match immersive content',
    immersiveCount > 0 ? badgeText.length > 0 : badgeText.length === 0,
    `${immersiveCount} immersive title(s), ${badgeText.length} badge(s)`
);

/* -------------------------------------------------------------- playcanvas -- */

const engineUp = await page.evaluate(() => {
    const canvas = document.getElementById('render-canvas');
    if (!canvas) return { ok: false, why: 'no canvas' };
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return { ok: !!gl, why: gl ? gl.getParameter(gl.VERSION) : 'no gl context' };
});
check('WebGL context created', engineUp.ok, engineUp.why);

/* ----------------------------------------------------------------- search -- */

// Derive the query from the catalog so this works whatever is in the library.
const firstTitle = await page.locator('.card-title').first().textContent({ timeout: 5000 }).catch(() => null);
const query = (firstTitle || '').trim().split(/\s+/)[0];

if (query) {
    await page.fill('#search-input', query);
    await page.waitForTimeout(400);
    const searchShelf = await page.locator('.shelf-head h2').first().textContent();
    check('search finds a known title', /Results for/.test(searchShelf || ''), searchShelf);
} else {
    console.log('  skip  search (no card titles found)');
}

// A query matching nothing must land on the empty state, not a bare page.
await page.fill('#search-input', 'zzzznotathing');
await page.waitForTimeout(400);
const emptyHeading = await page.locator('.empty-state h2').textContent().catch(() => null);
check('empty search renders the empty state', !!emptyHeading, emptyHeading || 'missing');

await page.fill('#search-input', '');
await page.waitForTimeout(400);
check('clearing search restores the shelves', (await page.locator('.shelf').count()) > 0);

/* ------------------------------------------------------------ compat panel -- */

await page.click('#compat-btn');
await page.waitForSelector('.compat-modal', { timeout: 5000 });
const compatCards = await page.locator('.compat-card h3').allTextContents();
check('compat panel lists players', compatCards.length >= 5, compatCards.join(', '));

const endpoints = await page.locator('.endpoint code').allTextContents();
check('compat panel shows endpoints', endpoints.some((e) => e.includes('/deovr')), endpoints.join(' | '));
await page.click('.compat-backdrop .modal-close');

/* --------------------------------------------------- immersive playback -- */

// Start playing something. Prefer a genuinely immersive title; otherwise take
// the first title and reach the same code path via the projection override,
// which is exactly what a viewer does with a mislabelled file.
const playId =
    immersiveId ??
    (await page.evaluate(async () => {
        const { items } = await (await fetch('/api/catalog')).json();
        return items[0]?.id ?? null;
    }));

if (playId) {
    await page.evaluate((id) => {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        card?.scrollIntoView();
        card?.querySelector('[data-action="play"]')?.click();
    }, playId);

    await page.waitForTimeout(2500);
    check('playback shell opens', (await page.locator('.player-shell').isVisible()) === true);

    if (!immersiveId) {
        // Cycle flat -> 180 dome. This builds the projection mesh and puts the
        // stereo material through a real shader compile.
        await page.click('[data-action="projection"]');
        await page.waitForTimeout(1200);
        check(
            'projection override reports 180°',
            (await page.locator('[data-el="projection-label"]').textContent()) === '180°'
        );

        // And flip to side-by-side, which switches the shader's unpacking branch.
        await page.click('[data-action="stereo"]');
        await page.waitForTimeout(800);
        check(
            'stereo override reports SBS',
            (await page.locator('[data-el="stereo-label"]').textContent()) === 'SBS 3D'
        );
    }

    await page.waitForTimeout(800);
    const rendered = await page.evaluate(() => ({
        bodyClass: document.body.className,
        canvasVisible: getComputedStyle(document.getElementById('render-canvas')).display
    }));

    check(
        'immersive format switches to the rendered surface',
        rendered.bodyClass.includes('is-immersive') && rendered.canvasVisible === 'block',
        `body="${rendered.bodyClass}" canvas=${rendered.canvasVisible}`
    );
} else {
    console.log('  skip  playback (empty catalog)');
}

/* ------------------------------------------------------------- diagnostics -- */

// A failed shader compile surfaces as a console error rather than an exception,
// so this assertion is what actually guards the stereo material.
const shaderErrors = consoleErrors.filter((e) => /shader|glsl|compile|link/i.test(e));
check('no shader compile errors', shaderErrors.length === 0, shaderErrors.join(' | '));
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

// Media requests to the public CC bucket can fail in a sandbox; that is not a
// defect in this app, so network noise is reported but not failed on.
const otherErrors = consoleErrors.filter((e) => !/shader|glsl|compile|link/i.test(e));
if (otherErrors.length) {
    console.log(`\n  note: ${otherErrors.length} other console error(s):`);
    for (const e of otherErrors.slice(0, 5)) console.log(`    - ${e.slice(0, 160)}`);
}

await browser.close();

console.log(`\n  ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
