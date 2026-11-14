import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRIPS } from './strips.js';
import { DEFAULT_STYLE, MODEL, MONO_STYLES, NEGATIVE, PANELS, QUALITY, STYLES } from './panels.js';
import { enhancePrompts, safePrompt } from './openai.js';

/**
 * Draft comic pages: panel art from the generator, lettering from the script.
 *
 *   node comic/make.js 7-8               render the panels, then compose the pages
 *   node comic/make.js 7 --seed 4242     the same, reproducibly
 *   node comic/make.js 7-8 --compose     re-letter from the panels already rendered
 *   node comic/make.js 7 --style ink     another drawing style from panels.js
 *   node comic/make.js 7 --no-enhance    draw the panels.js prompts as written, without OpenAI
 *   node comic/make.js --prompt "1girl, original, red hair, rooftop, night" --style ink --count 4
 *                                        a prompt of your own, into drafts/custom/
 *
 * Panels are drawn by `server/render.py` on `cubemarch-hyworld` (see the
 * ProjectAnimateDiff README for the box) from the prompts in `panels.js`,
 * with the character LoRA that `server/train_lora.py` trained. Pages are laid out as HTML and photographed by Playwright at
 * 1086x1448, so every word on the page is set in type from `strips.js` and
 * none of it is left to a model that cannot spell.
 *
 * Output is `comic/drafts/NN.png` (or `NN-<style>.png`), never `comic/art/`: a file in `art/` is a
 * strip the site publishes on its date, and a draft is not that until someone
 * has looked at it and copied it across.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS = path.join(HERE, 'drafts');
const RAW = path.join(DRAFTS, 'raw');

const VM = { name: 'cubemarch-hyworld', zone: 'us-central1-b' };

/**
 * True when this code runs on the box itself, as the comic service does
 * (`service.js`, started with COMIC_ON_BOX=1). Jobs then run in place instead
 * of over `gcloud compute ssh`, and the box's busy marker is touched directly.
 */
const ON_BOX = process.env.COMIC_ON_BOX === '1';
const BUSY_MARKER = '/var/run/animatediff/busy';

/** Refresh the idle reaper's busy marker, as `txt2img.py` does while it works. */
export function touchBusy() {
    try {
        fs.mkdirSync(path.dirname(BUSY_MARKER), { recursive: true });
        fs.writeFileSync(BUSY_MARKER, `${Date.now()}\n`);
    } catch {
        // Not on the box, or no permission: nothing to keep awake.
    }
}


const pad = (n) => String(n).padStart(2, '0');
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function gcloud(args, opts = {}) {
    return execFileSync('gcloud', [...args, '--zone', VM.zone, '--quiet'], { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

/* ------------------------------------------------------------ render -- */

/**
 * Start the box if it is off, wait for SSH, and pause its idle reaper.
 *
 * The box powers itself off when it looks idle, and a box that has just
 * booted and not yet been given work looks exactly like that: the first two
 * attempts at this found it shutting down before the prompts arrived. So the
 * reaper's timer is stopped for the run, the way `setup.sh` stops it while
 * provisioning, and `resumeIdle` re-arms it afterwards. A transient unit
 * re-arms it in 30 minutes regardless, so a run that dies half way cannot
 * leave an A100 running all night.
 */
function ensureUp() {
    if (ON_BOX) {
        touchBusy();
        return;
    }

    const status = () =>
        execFileSync('gcloud', ['compute', 'instances', 'describe', VM.name, '--zone', VM.zone, '--format=value(status)'], {
            encoding: 'utf8'
        }).trim();

    for (let s = status(); s !== 'RUNNING'; s = status()) {
        if (s === 'TERMINATED') {
            console.error(`${VM.name} is stopped; starting it (A100 time is billed until the idle reaper stops it)`);
            gcloud(['compute', 'instances', 'start', VM.name]);
        } else {
            console.error(`${VM.name} is ${s}; waiting`);
            execFileSync('sleep', ['10']);
        }
    }

    for (let attempt = 1; ; attempt++) {
        try {
            gcloud(
                ['compute', 'ssh', VM.name, '--command',
                    'sudo systemctl stop gpu-idle.timer && ' +
                    'sudo systemd-run --on-active=30min --unit=comic-rearm-idle --collect systemctl start gpu-idle.timer >/dev/null 2>&1; true'],
                { stdio: 'ignore' }
            );
            return;
        } catch {
            if (attempt >= 30) throw new Error(`${VM.name} did not answer SSH after ${attempt} tries`);
            execFileSync('sleep', ['10']);
        }
    }
}

/** Hand the box back to its idle reaper. */
function resumeIdle() {
    if (ON_BOX) return;

    try {
        gcloud(['compute', 'ssh', VM.name, '--command', 'sudo systemctl start gpu-idle.timer; sudo systemctl stop comic-rearm-idle.timer 2>/dev/null; true'], {
            stdio: 'ignore'
        });
    } catch {
        console.error(`could not re-arm the idle reaper on ${VM.name}; it re-arms itself within 30 minutes`);
    }
}

/**
 * Every panel of every strip asked for, in one `txt2img` run, so the model
 * loads once. With `--seed S`, panel k of the run is always seed S + k.
 */
/** "count, original, rating" + style + the rest of the panel + quality. */
export function panelPrompt(prompt, style) {
    // Every prompt passes here on its way to the GPU, whoever wrote it: a
    // script, OpenAI, or a person editing tags in the web page. So this is
    // where the floor is enforced, not left to anyone's instructions.
    const tags = safePrompt(prompt).split(', ');
    return [...tags.slice(0, 3), STYLES[style], ...tags.slice(3), QUALITY].join(', ');
}

/** `07` for the default style, `07-ink` for another, so drafts sit side by side. */
const stem = (n, style) => (style === DEFAULT_STYLE ? pad(n) : `${pad(n)}-${style}`);

/**
 * Run a job on the box: copy `files` into a fresh directory there, run the
 * command `command(dir)` returns, and give back its stdout and the directory.
 * From a Mac that is `gcloud compute ssh`, with the box started and its idle
 * reaper paused for the duration; on the box it is a local shell.
 */
export function runOnBox(files, command) {
    if (ON_BOX) {
        touchBusy();
        const dir = fs.mkdtempSync('/tmp/comic-');
        for (const f of files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
        const out = execFileSync('bash', ['-c', command(dir)], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
        return { out, dir };
    }

    const dir = `/tmp/comic-${Date.now()}`;
    ensureUp();
    gcloud(['compute', 'ssh', VM.name, '--command', `mkdir -p ${dir}`]);
    gcloud(['compute', 'scp', ...files, `${VM.name}:${dir}/`]);
    try {
        return { out: gcloud(['compute', 'ssh', VM.name, '--command', command(dir)], { stdio: ['ignore', 'pipe', 'inherit'] }), dir };
    } finally {
        resumeIdle();
    }
}

/* ----------------------------------------------------------- layouts -- */

/** A page holds one to six panels. More than six stops reading as a strip. */
export const MAX_PANELS = 6;

/**
 * Where each panel sits on the page, for `n` panels, as CSS grid placements.
 * The page stays the series' tall shape; panels change size instead. An odd
 * count opens with a wide establishing panel across the top.
 *
 *   1: one splash          2: two stacked        3: wide, then two
 *   4: two by two          5: wide, then 2x2     6: two by three
 */
export function layout(n) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PANELS) throw new Error(`a page holds 1 to ${MAX_PANELS} panels, not ${n}`);
    const cell = (col, colSpan, row, rowSpan = 1) => ({ col, colSpan, row, rowSpan });
    switch (n) {
        case 1: return { cols: 1, rows: 1, cells: [cell(1, 1, 1)] };
        case 2: return { cols: 1, rows: 2, cells: [cell(1, 1, 1), cell(1, 1, 2)] };
        case 3: return { cols: 2, rows: 2, cells: [cell(1, 2, 1), cell(1, 1, 2), cell(2, 1, 2)] };
        case 4: return { cols: 2, rows: 2, cells: [cell(1, 1, 1), cell(2, 1, 1), cell(1, 1, 2), cell(2, 1, 2)] };
        case 5: return { cols: 2, rows: 3, cells: [cell(1, 2, 1), cell(1, 1, 2), cell(2, 1, 2), cell(1, 1, 3), cell(2, 1, 3)] };
        case 6: return { cols: 2, rows: 3, cells: [cell(1, 1, 1), cell(2, 1, 1), cell(1, 1, 2), cell(2, 1, 2), cell(1, 1, 3), cell(2, 1, 3)] };
    }
}

/** The panel area of a 1086x1448 page, measured from `pageHtml`'s layout. */
const GRID = { width: 1054, height: 1270, gap: 10 };

/**
 * Animagine XL 4.0's trained sizes, from its model card. Drawing a panel at
 * the one nearest its shape means a wide panel is composed wide, rather than
 * drawn tall and then cropped to a strip of its middle.
 */
const BUCKETS = [[1024, 1024], [896, 1152], [1152, 896], [832, 1216], [1216, 832], [768, 1344], [1344, 768], [640, 1536], [1536, 640]];

/** The render size for each panel of an `n`-panel page. */
export function panelSizes(n) {
    const { cols, rows, cells } = layout(n);
    const colW = (GRID.width - GRID.gap * (cols - 1)) / cols;
    const rowH = (GRID.height - GRID.gap * (rows - 1)) / rows;
    return cells.map(({ colSpan, rowSpan }) => {
        const aspect = (colW * colSpan + GRID.gap * (colSpan - 1)) / (rowH * rowSpan + GRID.gap * (rowSpan - 1));
        const [width, height] = BUCKETS.reduce((best, b) =>
            Math.abs(Math.log(b[0] / b[1] / aspect)) < Math.abs(Math.log(best[0] / best[1] / aspect)) ? b : best
        );
        return { width, height };
    });
}

/**
 * One `render.py` run on the box: every prompt, `count` images each, the
 * model loaded once. With `--seed S`, image k of the run is always seed S + k.
 * Returns each image's metadata and a local path to it, in order.
 */
function txt2img(prompts, seed, count = 1, sizes = null) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-'));

    // The job file is the whole contract with `server/render.py`, which loads
    // the character LoRA that the service's own `txt2img.py` cannot. Paths
    // in it are relative to the job's directory, wherever that ends up.
    const job = {
        model: MODEL.id,
        lora: MODEL.lora ?? null,
        lora_scale: MODEL.loraScale ?? 1,
        prompts,
        negative: NEGATIVE,
        seed,
        count,
        width: MODEL.width,
        height: MODEL.height,
        // One size per prompt when the panels differ in shape; see `panelSizes`.
        ...(sizes ? { sizes } : {}),
        steps: MODEL.steps,
        guidance: MODEL.guidance,
        out: 'out'
    };
    fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job, null, 2));
    fs.copyFileSync(path.join(HERE, 'server', 'render.py'), path.join(tmp, 'render.py'));
    fs.writeFileSync(
        path.join(tmp, 'run.sh'),
        [
            'set -euo pipefail',
            'cd "$(dirname "$0")"',
            // The service's .env for HF_HOME, so the model comes from its warm
            // cache. Root, because a first run downloads into that cache.
            'set -a; . /opt/animatediff/.env; set +a',
            '/opt/animatediff-venv/bin/python render.py job.json'
        ].join('\n') + '\n'
    );

    console.error(`rendering ${prompts.length * count} image(s) on ${VM.name}, seed ${seed}`);
    const files = ['job.json', 'render.py', 'run.sh'].map((f) => path.join(tmp, f));
    const { out, dir } = runOnBox(files, (d) => `sudo bash ${d}/run.sh`);

    const made = out
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l));
    if (made.length !== prompts.length * count) throw new Error(`asked for ${prompts.length * count} images, got ${made.length}`);

    if (ON_BOX) return made.map((m) => ({ ...m, local: path.join(dir, m.path) }));

    gcloud(['compute', 'scp', ...made.map((m) => `${VM.name}:${dir}/${m.path}`), tmp]);
    return made.map((m) => ({ ...m, local: path.join(tmp, path.basename(m.path)) }));
}

/**
 * Draw strips from `strips.js`. With `enhance`, OpenAI rewrites each panel's
 * prompt from its art direction first, using the `panels.js` prompt as a
 * draft; without it, the `panels.js` prompts are drawn as written.
 */
export async function render(strips, seed, style = DEFAULT_STYLE, enhance = true) {
    const prompts = new Map();
    for (const s of strips) {
        const drafts = PANELS[s.n].map((p) => p.prompt);
        prompts.set(s.n, enhance ? await enhancePrompts(s, drafts) : drafts);
        if (enhance) console.error(`enhanced strip ${pad(s.n)}:\n${prompts.get(s.n).map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
    }
    const jobs = strips.flatMap((s) => prompts.get(s.n).map((p, i) => ({ n: s.n, panel: i + 1, prompt: panelPrompt(p, style) })));
    const sizes = strips.flatMap((s) => panelSizes(prompts.get(s.n).length));
    const made = txt2img(jobs.map((j) => j.prompt), seed, 1, sizes);

    fs.mkdirSync(RAW, { recursive: true });
    jobs.forEach((job, i) => {
        fs.copyFileSync(made[i].local, path.join(RAW, `${stem(job.n, style)}-${job.panel}.png`));
    });
    for (const s of strips) {
        const meta = made.filter((_, i) => jobs[i].n === s.n).map(({ prompt, seed, seconds }) => ({ prompt, seed, seconds }));
        fs.writeFileSync(path.join(RAW, `${stem(s.n, style)}.json`), JSON.stringify({ model: MODEL, style, negative: NEGATIVE, panels: meta }, null, 2));
    }
}

/**
 * A prompt of your own, for trying a scene or a look before it goes in
 * `panels.js`. Same model, same style presets, and the same limits as the
 * strips: the rating is always `safe`, any other rating tag in the prompt is
 * dropped, and the comic's negative prompt applies. This is the comic's
 * generator, and the comic is non-explicit.
 *
 * Images land in `drafts/custom/`, unlettered, with a `.json` beside each
 * holding the exact prompt and seed to reproduce it.
 */
export function customPrompt(prompt) {
    const [count, , rating, ...rest] = safePrompt(prompt).split(', ');
    return [rating, count, ...rest].filter(Boolean).join(', ');
}

export function renderCustom(prompt, { seed, style = DEFAULT_STYLE, count = 1 }) {
    const tags = customPrompt(prompt).split(', ');
    const full = [tags[0], STYLES[style], ...tags.slice(1), QUALITY].join(', ');
    const made = txt2img([full], seed, count);

    const dir = path.join(DRAFTS, 'custom');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    made.forEach((m, k) => {
        const name = `${stamp}-${style}-${k + 1}`;
        fs.copyFileSync(m.local, path.join(dir, `${name}.png`));
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ model: MODEL, style, prompt: m.prompt, negative: NEGATIVE, seed: m.seed }, null, 2));
        console.error(`wrote ${path.relative(process.cwd(), path.join(dir, `${name}.png`))}`);
    });
}

/* ----------------------------------------------------------- compose -- */

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function insertHtml(ins) {
    const text = escapeHtml(ins.text);
    switch (ins.type) {
        case 'chyron':
            return `<div class="chyron"><span class="chyron-tag">NEWS</span><span class="chyron-text">${text}</span></div>`;
        case 'doc':
            return `<div class="doc"><p>${text}</p>${ins.check ? `<p class="check">☑ ${escapeHtml(ins.check)}</p>` : ''}</div>`;
        case 'label':
            return `<div class="label">${text}</div>`;
        case 'note':
            return `<div class="note">${text}</div>`;
        case 'badge':
            return `<div class="badge"><i></i>${text}</div>`;
        default:
            throw new Error(`unknown insert type ${ins.type}`);
    }
}

function panelHtml(panel, spec, art, cell) {
    const place = `grid-column: ${cell.col} / span ${cell.colSpan}; grid-row: ${cell.row} / span ${cell.rowSpan};`;
    const captions = panel.lines.filter(([who]) => who === 'Caption');
    const speech = panel.lines.filter(([who]) => who !== 'Caption' && who !== 'Screen');
    const screens = panel.lines.filter(([who]) => who === 'Screen');

    return `
        <section class="panel" style="${place}">
            <img class="art" src="${art}" alt="" />
            <div class="top">
                ${captions.map(([, text]) => `<div class="caption">${escapeHtml(text)}</div>`).join('')}
                ${speech.map(([who, text], i) => `<div class="balloon ${i % 2 ? 'right' : 'left'}" data-who="${escapeHtml(who)}">${escapeHtml(text)}</div>`).join('')}
            </div>
            ${(spec.inserts ?? []).map(insertHtml).join('')}
            ${screens.length ? `<div class="screen">${screens.map(([, text]) => `<p>${escapeHtml(text)}</p>`).join('')}</div>` : ''}
        </section>`;
}

export function pageHtml(strip, arts, style = DEFAULT_STYLE, spec = PANELS[strip.n]) {
    const grid = layout(strip.panels.length);
    return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
    * { box-sizing: border-box; margin: 0; }
    html, body { width: 1086px; height: 1448px; }
    body {
        display: grid;
        grid-template-rows: auto 1fr auto;
        padding: 18px 16px 14px;
        background: #f2eadb;
        color: #141414;
        font-family: Georgia, 'Times New Roman', 'P052', 'Nimbus Roman', serif;
    }
    header { text-align: center; }
    .title { display: flex; align-items: center; gap: 22px; }
    .title::before, .title::after { content: ''; flex: 1; border-top: 3px double #141414; }
    h1 { font: italic 900 64px/0.95 'Bodoni 72', Didot, 'C059', Georgia, serif; letter-spacing: 0.02em; }
    .sub { margin: 6px 0 12px; font-size: 19px; letter-spacing: 0.32em; }
    .grid {
        display: grid;
        grid-template-columns: repeat(${grid.cols}, minmax(0, 1fr));
        grid-template-rows: repeat(${grid.rows}, minmax(0, 1fr));
        gap: 10px;
        min-height: 0;
    }
    .panel { position: relative; overflow: hidden; border: 3px solid #141414; background: #ddd; }
    .art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .mono .art { filter: grayscale(1) contrast(1.12); }
    .top {
        position: absolute; inset: 10px 10px auto 10px;
        display: flex; flex-direction: column; gap: 8px;
    }
    .caption {
        align-self: flex-start;
        max-width: 72%;
        padding: 6px 10px;
        background: #f6eccf;
        border: 2px solid #141414;
        font: 600 17px/1.2 Georgia, serif;
        letter-spacing: 0.02em;
    }
    .balloon {
        position: relative;
        max-width: 68%;
        padding: 12px 18px;
        background: #fff;
        border: 2px solid #141414;
        border-radius: 48% / 42%;
        font: italic 21px/1.18 Georgia, serif;
        text-align: center;
    }
    .balloon.left { align-self: flex-start; }
    .balloon.right { align-self: flex-end; }
    .balloon::after {
        content: '';
        position: absolute; bottom: -15px;
        border: 9px solid transparent;
        border-top: 16px solid #141414;
    }
    .balloon.left::after { left: 32%; }
    .balloon.right::after { right: 32%; }
    .balloon::before {
        content: '';
        position: absolute; bottom: -10px; z-index: 1;
        border: 7px solid transparent;
        border-top: 12px solid #fff;
    }
    .balloon.left::before { left: calc(32% + 2px); }
    .balloon.right::before { right: calc(32% + 2px); }
    .screen {
        position: absolute; left: 12px; right: 12px; bottom: 12px;
        padding: 10px 14px;
        border-radius: 14px;
        background: rgba(12, 14, 20, 0.92);
        border: 2px solid #141414;
        color: #f2f4f8;
        font: 500 16px/1.35 -apple-system, 'Helvetica Neue', Arial, 'Nimbus Sans', 'DejaVu Sans', sans-serif;
    }
    .chyron {
        position: absolute; left: 8%; right: 8%; top: 54%;
        display: flex;
        border: 2px solid #141414;
        font: 800 15px/1.2 -apple-system, 'Helvetica Neue', Arial, 'Nimbus Sans', 'DejaVu Sans', sans-serif;
        letter-spacing: 0.04em;
    }
    .chyron-tag { padding: 7px 9px; background: #b3121b; color: #fff; }
    .chyron-text { flex: 1; padding: 7px 10px; background: #fff; }
    .doc {
        position: absolute; left: 12%; right: 12%; top: 34%;
        padding: 16px 18px;
        background: #fbfaf5;
        border: 1px solid #9a948a;
        box-shadow: 0 6px 16px rgba(0,0,0,0.25);
        transform: rotate(-2deg);
        font: 16px/1.45 'Times New Roman', serif;
    }
    .doc .check { margin-top: 10px; font-weight: 700; }
    .label {
        position: absolute; left: 14px; bottom: 14px;
        max-width: 70%;
        padding: 5px 8px;
        background: #fff;
        border: 1px solid #141414;
        font: 700 12px/1.25 -apple-system, 'Helvetica Neue', Arial, 'Nimbus Sans', 'DejaVu Sans', sans-serif;
        letter-spacing: 0.04em;
    }
    .note {
        position: absolute; left: 16px; bottom: 16px;
        padding: 8px 14px;
        background: #fffbe8;
        border: 1px solid #8f8a78;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        transform: rotate(-6deg);
        font: 22px/1 'Bradley Hand', 'Noteworthy', 'Z003', cursive;
    }
    .badge {
        position: absolute; left: 14px; bottom: 14px;
        display: flex; align-items: center; gap: 7px;
        padding: 5px 11px;
        border-radius: 999px;
        background: #b3121b;
        color: #fff;
        font: 800 13px/1.2 -apple-system, 'Helvetica Neue', Arial, 'Nimbus Sans', 'DejaVu Sans', sans-serif;
        letter-spacing: 0.05em;
    }
    .badge i { width: 8px; height: 8px; border-radius: 50%; background: #fff; }
    footer { display: flex; align-items: center; gap: 18px; margin-top: 12px; font-size: 17px; letter-spacing: 0.32em; }
    footer::before, footer::after { content: ''; flex: 1; border-top: 1px solid #141414; }
</style></head>
<body class="${MONO_STYLES.has(style) ? 'mono' : ''}">
    <header>
        <div class="title"><h1>LUSTY X</h1></div>
        <p class="sub">${strip.n ? `${pad(strip.n)}&nbsp;&nbsp;` : ''}${escapeHtml(strip.title.toUpperCase())}</p>
    </header>
    <main class="grid">
        ${strip.panels.map((p, i) => panelHtml(p, spec[i], arts[i], grid.cells[i])).join('')}
    </main>
    <footer>${escapeHtml(strip.arc.toUpperCase())}</footer>
</body></html>`;
}

/** Letter the rendered panels into `drafts/NN.png`. */
export async function compose(strips, style = DEFAULT_STYLE) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1086, height: 1448 }, deviceScaleFactor: 1 });
        for (const s of strips) {
            const arts = s.panels.map((_, i) => i + 1).map((k) => {
                const file = path.join(RAW, `${stem(s.n, style)}-${k}.png`);
                return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
            });
            await page.setContent(pageHtml(s, arts, style), { waitUntil: 'load' });
            await page.evaluate(() => document.fonts.ready);
            const out = path.join(DRAFTS, `${stem(s.n, style)}.png`);
            await page.screenshot({ path: out });
            console.error(`wrote ${path.relative(process.cwd(), out)}`);
        }
    } finally {
        await browser.close();
    }
}

/**
 * One page from any script: render its four panels, letter them, save it.
 *
 * For scripts that are not in `strips.js` yet, such as the ones `new.js`
 * writes. `strip` is shaped like a `strips.js` entry (`title`, `arc`,
 * `panels[].lines`), `spec` like a `panels.js` entry (`prompt`, `inserts`).
 */
export async function makePage({ strip, spec, seed, style = DEFAULT_STYLE, out }) {
    if (strip.panels.length !== spec.length) throw new Error(`the script has ${strip.panels.length} panels but ${spec.length} prompts`);
    const made = txt2img(spec.map((p) => panelPrompt(p.prompt, style)), seed, 1, panelSizes(spec.length));
    const arts = made.map((m) => `data:image/png;base64,${fs.readFileSync(m.local).toString('base64')}`);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1086, height: 1448 }, deviceScaleFactor: 1 });
        await page.setContent(pageHtml(strip, arts, style, spec), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: out });
    } finally {
        await browser.close();
    }
    return made;
}

/* --------------------------------------------------------------- cli -- */

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const args = process.argv.slice(2);
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

    const seed = flag('--seed') !== undefined ? Number(flag('--seed')) : Math.floor(Math.random() * 2 ** 31);
    const style = flag('--style') ?? DEFAULT_STYLE;
    if (!Object.hasOwn(STYLES, style)) {
        console.error(`unknown style ${style}; panels.js has ${Object.keys(STYLES).join(', ')}`);
        process.exit(1);
    }

    fs.mkdirSync(DRAFTS, { recursive: true });

    if (flag('--prompt') !== undefined) {
        const count = Math.min(Math.max(Number(flag('--count') ?? 1), 1), 8);
        renderCustom(flag('--prompt'), { seed, style, count });
    } else {
        const [from, to = from] = (args.find((a) => /^\d+(-\d+)?$/.test(a)) ?? '').split('-').map(Number);
        const strips = STRIPS.filter((s) => s.n >= from && s.n <= to);
        const missing = strips.filter((s) => !PANELS[s.n]);
        if (!strips.length || missing.length) {
            console.error(
                strips.length
                    ? `no panel prompts for strip ${missing.map((s) => s.n).join(', ')}: add them to comic/panels.js`
                    : 'usage: node comic/make.js <n>|<from>-<to> [--seed N] [--style S] [--compose] [--no-enhance]\n' +
                          '       node comic/make.js --prompt "<tags>" [--style S] [--count 1-8] [--seed N]'
            );
            process.exit(1);
        }

        if (!args.includes('--compose')) await render(strips, seed, style, !args.includes('--no-enhance'));
        await compose(strips, style);
    }
}
