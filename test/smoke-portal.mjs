/**
 * Browser smoke test for authentication and Creator Studio.
 *
 * Drives the real UI rather than the API: registration through the dialog,
 * the header account menu, the Studio dashboard, the metadata editor, and a
 * genuine file upload with progress. These are the paths where a wiring
 * mistake between client and server produces a page that looks fine and does
 * nothing.
 *
 * Needs the server running. Run with:  node test/smoke-portal.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const EMAIL = `smoke-${Date.now()}@example.com`;
const PASSWORD = 'correcthorsebattery';
const CLIP = '/tmp/avr-smoke-clip.mp4';

const failures = [];
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`);
    if (!ok) failures.push(label);
};

// A tiny real clip, so the upload path exercises actual bytes.
if (!fs.existsSync(CLIP)) {
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=15:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        CLIP
    ]);
}

const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));

console.log(`\n  Portal smoke test against ${URL}\n`);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 15000 });

/* ------------------------------------------------------------ anonymous -- */

check('signed out shows a Sign in button', await page.locator('[data-account="signin"]').isVisible());

// The session-hint cookie exists precisely so this request is not made.
const authCalls = [];
page.on('request', (r) => {
    if (r.url().includes('/api/auth/refresh')) authCalls.push(r.url());
});
await page.reload({ waitUntil: 'networkidle' });
check('anonymous reload makes no refresh call', authCalls.length === 0, `${authCalls.length} call(s)`);

/* --------------------------------------------------------- registration -- */

await page.click('[data-account="signin"]');
await page.waitForSelector('.auth-modal', { timeout: 5000 });
await page.click('[data-toggle-mode]');
await page.waitForSelector('input[name="displayName"]');

await page.fill('input[name="displayName"]', 'Smoke Creator');
await page.fill('input[name="email"]', EMAIL);
await page.fill('input[name="password"]', PASSWORD);
await page.check('input[name="role"]');
await page.click('.auth-submit');

await page.waitForSelector('.account .avatar', { timeout: 10000 });
check('registration signs the user in', true, EMAIL);

const initials = await page.locator('.account .avatar').textContent();
check('header shows account initials', initials?.trim() === 'SC', initials);

/* ---------------------------------------------------------------- studio -- */

await page.click('[data-account="menu"]');
await page.waitForSelector('[data-account="studio"]', { timeout: 5000 });
await page.click('[data-account="studio"]');

await page.waitForSelector('.portal', { timeout: 10000 });
check('Creator Studio opens', true, await page.url());

// The dashboard loads its data after the shell renders.
await page.waitForSelector('.stat-tile', { timeout: 10000 }).catch(() => {});
const tiles = await page.locator('.stat-tile .stat-label').allTextContents();
check('dashboard renders stat tiles', tiles.length >= 4, tiles.join(', '));

/* ----------------------------------------------------------- new title -- */

page.once('dialog', (d) => d.accept('Smoke Test Reef'));
await page.click('[data-action="new"]');
await page.waitForSelector('.portal-form', { timeout: 10000 });
check('new title opens the editor', true);

await page.selectOption('select[name="projection"]', 'dome180');
await page.selectOption('select[name="stereo"]', 'sbs');
await page.fill('textarea[name="synopsis"]', 'Written by the smoke test.');
await page.click('.portal-form button[type="submit"]');
await page.waitForTimeout(1500);

// The editor re-renders from the server after save, so this reads persisted state.
const savedProjection = await page.locator('select[name="projection"]').inputValue();
check('metadata saves and reloads', savedProjection === 'dome180', savedProjection);

/* -------------------------------------------------------------- upload -- */

await page.setInputFiles('#upload-input', CLIP);

// Wait for the title to leave the draft state.
let status = '';
for (let i = 0; i < 40; i++) {
    status = (await page.locator('.editor-head .status').textContent().catch(() => ''))?.trim() ?? '';
    if (/Ready|Published|Failed/i.test(status)) break;
    await page.waitForTimeout(1500);
}

check('upload processes to a ready state', /Ready|Published/i.test(status), status);
check('upload did not fail', !/Failed/i.test(status), status);

/* ------------------------------------------------------------- publish -- */

await page.click('[data-view="titles"]');
await page.waitForSelector('.portal-table', { timeout: 5000 });

const publishBtn = page.locator('[data-action="publish"]').first();
if (await publishBtn.count()) {
    await publishBtn.click();
    await page.waitForTimeout(1800);
}

const statuses = await page.locator('.portal-table .status').allTextContents();
check('title reaches Published', statuses.some((s) => /Published/i.test(s)), statuses.join(', '));

/* ---------------------------------------------------------- public view -- */

await page.click('[data-action="exit"]');
await page.waitForSelector('.card', { timeout: 10000 });
await page.waitForTimeout(1200);

const inCatalog = await page.evaluate(async () => {
    const { items } = await (await fetch('/api/catalog')).json();
    const found = items.find((i) => i.title === 'Smoke Test Reef');
    return found ? { src: found.src, projection: found.format.projection, stereo: found.format.stereo } : null;
});

check('published title appears in the public catalog', !!inCatalog, JSON.stringify(inCatalog));
check(
    'published title kept its VR format',
    inCatalog?.projection === 'dome180' && inCatalog?.stereo === 'sbs',
    `${inCatalog?.projection}/${inCatalog?.stereo}`
);

/* --------------------------------------------------------- headset feed -- */

await page.click('[data-account="menu"]');
await page.click('[data-account="studio"]');
await page.waitForSelector('.portal', { timeout: 8000 });
await page.click('[data-view="feed"]');
await page.waitForSelector('[data-feed] code', { timeout: 8000 });

const feedUrls = await page.locator('[data-feed] code').allTextContents();
check('headset feed shows a tokenised DeoVR URL', feedUrls.some((u) => /\/deovr\/u\/.+/.test(u)), feedUrls[0]);

/* ------------------------------------------------------------- sign out -- */

await page.click('[data-action="exit"]');
await page.waitForSelector('.card', { timeout: 8000 });
await page.click('[data-account="menu"]');
await page.click('[data-account="signout"]');
await page.waitForSelector('[data-account="signin"]', { timeout: 8000 });
check('sign out returns to the signed-out header', true);

const hintAfterSignout = await page.evaluate(() => document.cookie.includes('avr_session='));
check('session hint cookie is cleared on sign out', !hintAfterSignout);

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

console.log(`\n  ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
