/**
 * What a threshold change actually does, over a corpus, before it ships.
 *
 * ## Why this is a script and not a judgement call
 *
 * Every number in the docstrings in `src/detect.js` came from a measurement
 * like this one, and they are the kind of number that cannot be reasoned to.
 * Lowering the bar catches more of what the brief names and also mosaics more
 * clothed promotional art, and the exchange rate between those two is a
 * property of one model and one corpus. It is not derivable; it has to be run.
 *
 * The expensive half is inference, so it happens once per image and the raw
 * head is kept. Every candidate setting is then evaluated by calling the real
 * {@link decode} over cached tensors — the same function the service runs, not
 * a copy of its arithmetic, which is the only way the result is about what
 * will actually ship.
 *
 * ## It tiles, because the service tiles
 *
 * An image is now read as a whole frame plus however many windows {@link
 * tiles} asks for, so the cache holds one head per *window* and each setting
 * is folded back with the service's own {@link merge}. This is not a detail:
 * the first version of this script ran one pass per image, and bars measured
 * that way are measured against roughly a quarter of the chances to fire that
 * production actually takes. Every number in `src/detect.js` dated 2026-10-21
 * or later was re-measured through this path for that reason.
 *
 * ## What it reports, and what it cannot
 *
 * There is no ground truth here. Nobody has labelled these images, so this
 * cannot print precision or recall and does not pretend to. What it can state
 * exactly is the *change*: which images move from shown to covered, how much
 * of each frame is covered, and how often the whole-frame fallback fires.
 *
 * `--contact` writes the images that change hands to a directory, **as the
 * visitor would see them** — put through the service's own {@link pixelate}
 * rather than shown as originals. That is the part worth looking at. A setting
 * that covers forty more images is good if they are forty pictures of genitals
 * and bad if they are forty clothed box covers, and the only thing that can
 * tell those apart is a person opening the folder.
 *
 * Two subfolders per setting, because a bar can move either way:
 *
 *   - `added/` became covered. Read these for false positives — a mosaic over
 *     a t-shirt is the cost of the bar being too low.
 *   - `lost/` stopped being covered, which is what *raising* a bar buys and
 *     what it risks. Read these for the thing this service exists to prevent.
 *
 *   node scripts/sweep-thresholds.js <corpus-dir> [--model path] [--contact dir]
 *
 * The corpus is not in this repository and must not be: it is several hundred
 * partner images fetched for a measurement, and this service stores nothing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { load, letterbox, tiles, toTensor, decode, merge } from '../src/detect.js';
import { pixelate } from '../src/mosaic.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const SIDE = 320;

/**
 * The settings to compare, in the order the table prints them.
 *
 * ## One bar at a time
 *
 * **A sweep that moves two bars at once cannot say which one caused a false
 * positive**, and this script learned that the expensive way. An earlier
 * version stepped `conf` and `genital` together, produced a column of
 * newly-covered clothed headshots, and the obvious reading — "the low bar is
 * too low" — was wrong. They came from `whole`, which defaults to `conf / 2`
 * and had been sliding down underneath the whole measurement. Breasts sat on
 * the wrong threshold for a day because of it.
 *
 * So the list is blocks, not a grid. Each block holds two numbers still and
 * walks the third, and any block that moves `conf` pins `whole` by hand.
 *
 * - `conf`     the bar for every censorable class without one of its own
 * - `genital`  the bar for the three classes in `GENITAL_IDS`
 * - `breast`   the bar for `FEMALE_BREAST_EXPOSED`
 * - `whole`    the score above which an empty box list becomes a whole-frame
 *              cover. Omitted means `conf / 2`, which is what the service does.
 */
/*
 * The bars move *up* here, which is the opposite of every earlier sweep, and
 * the reason is the tiling above rather than anything about the content.
 *
 * A wide banner is now read as several windows instead of one — 518 images
 * came to 1413 windows the last time this ran. Each window gets its own 2100
 * anchors and its own look at the same 18 classes, so the number of chances
 * the model has to place a box on one picture went up by about the same
 * factor — and a bar is a per-chance quantity. The three numbers in the tree
 * were all measured against one pass, and the first tiled run with them
 * unchanged put mosaics on an opaque white tank top and on several faces.
 * Nothing about the model changed; it was asked three times as many questions
 * at a bar set for asking once.
 *
 * There is no "before tiling" row, and there cannot be one: this harness
 * drives the service's own `tiles`, so everything it reports is tiled. To see
 * the untiled numbers, read the tables in `src/detect.js` — that is what they
 * are.
 */
const SETTINGS = [
    { name: 'baseline = deployed', conf: 0.15, genital: 0.015, breast: 0.03 },

    // The genital bar alone. Everything else pinned, so every delta is one of
    // FEMALE_GENITALIA / MALE_GENITALIA / ANUS.
    { name: 'genital 0.02', conf: 0.15, genital: 0.02, breast: 0.03 },
    { name: 'genital 0.03', conf: 0.15, genital: 0.03, breast: 0.03 },
    { name: 'genital 0.05', conf: 0.15, genital: 0.05, breast: 0.03 },
    { name: 'genital 0.08', conf: 0.15, genital: 0.08, breast: 0.03 },

    // The breast bar alone.
    { name: 'breast 0.05', conf: 0.15, genital: 0.015, breast: 0.05 },
    { name: 'breast 0.08', conf: 0.15, genital: 0.015, breast: 0.08 },
    { name: 'breast 0.12', conf: 0.15, genital: 0.015, breast: 0.12 },

    // `conf` alone, which governs only BUTTOCKS and MALE_BREAST. `whole`
    // pinned at the baseline's 0.075 so it cannot move underneath these.
    { name: 'conf 0.25', conf: 0.25, genital: 0.015, breast: 0.03, whole: 0.075 },
    { name: 'conf 0.35', conf: 0.35, genital: 0.015, breast: 0.03, whole: 0.075 },

    // Candidates, all three together.
    { name: 'cand .15/.03/.05', conf: 0.15, genital: 0.03, breast: 0.05 },
    { name: 'cand .15/.05/.08', conf: 0.15, genital: 0.05, breast: 0.08 },
    { name: 'cand .25/.05/.08', conf: 0.25, genital: 0.05, breast: 0.08, whole: 0.075 }
];

const dir = process.argv[2];
const modelArg = process.argv.indexOf('--model');
const contactArg = process.argv.indexOf('--contact');
const model = modelArg > 0 ? process.argv[modelArg + 1] : '/tmp/censor-model/320n.onnx';
const contact = contactArg > 0 ? process.argv[contactArg + 1] : null;

if (!dir) {
    console.error('usage: node scripts/sweep-thresholds.js <corpus-dir> [--model p] [--contact d]');
    process.exit(2);
}

/** Fraction of the frame the boxes cover, counted once where they overlap. */
function coveredFraction(boxes, width, height) {
    if (!boxes.length) return 0;

    // A coarse 64x64 occupancy grid rather than exact union geometry: the
    // question is "roughly how much of this picture is mosaic", and a grid
    // that cannot double-count is worth more here than a precise number.
    const N = 64;
    const cell = new Uint8Array(N * N);

    for (const b of boxes) {
        const x0 = Math.max(0, Math.floor((b.x / width) * N));
        const x1 = Math.min(N - 1, Math.ceil(((b.x + b.w) / width) * N) - 1);
        const y0 = Math.max(0, Math.floor((b.y / height) * N));
        const y1 = Math.min(N - 1, Math.ceil(((b.y + b.h) / height) * N) - 1);

        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) cell[y * N + x] = 1;
        }
    }

    return cell.reduce((n, v) => n + v, 0) / cell.length;
}

const files = (await fs.readdir(dir))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();

if (!files.length) {
    console.error(`no images in ${dir}`);
    process.exit(2);
}

console.log(`model   ${model}`);
console.log(`corpus  ${files.length} images in ${dir}\n`);

const session = await load(model);

/** One inference per window, kept, so the settings below are free. */
const images = [];
let unreadable = 0;
let windows = 0;

/** The model over one window, with the head kept rather than decoded. */
async function head(buffer, region) {
    const box = await letterbox(buffer, region);
    const input = new ort.Tensor('float32', toTensor(box.data), [1, 3, SIDE, SIDE]);
    const output = await session.run({ [session.inputNames[0]]: input });
    const out = output[session.outputNames[0]];

    return { box, data: out.data, dims: out.dims };
}

for (const [i, file] of files.entries()) {
    if (i % 25 === 0) process.stderr.write(`  inference ${i}/${files.length}\r`);

    try {
        const buffer = await fs.readFile(path.join(dir, file));
        const whole = await head(buffer, null);
        const passes = [whole];

        for (const region of tiles(whole.box.imageWidth, whole.box.imageHeight)) {
            passes.push(await head(buffer, region));
        }

        windows += passes.length;
        images.push({
            file,
            passes,
            width: whole.box.imageWidth,
            height: whole.box.imageHeight
        });
    } catch {
        // The service covers the whole frame when it cannot read an image, so
        // these are already handled and are not what a threshold affects.
        unreadable++;
    }
}

process.stderr.write(' '.repeat(40) + '\r');
console.log(
    `decoded ${images.length} images as ${windows} windows ` +
        `(${(windows / Math.max(1, images.length)).toFixed(1)} per image), ` +
        `unreadable ${unreadable} (those are covered whole regardless)\n`
);

const results = [];

for (const setting of SETTINGS) {
    const opts = {
        conf: setting.conf,
        genitalConf: setting.genital,
        breastConf: setting.breast
    };
    if (setting.whole !== undefined) opts.wholeTile = setting.whole;

    let boxes = 0;
    let wholes = 0;
    let areaSum = 0;
    const covered = new Set();

    // Per class, because the headline counts cannot answer "did that come
    // from the bar I moved". A row that gains 40 boxes is a different
    // decision depending on whether they are vulvas or buttocks.
    const byLabel = new Map();

    for (const image of images) {
        // Decoded per window and folded with the service's own `merge`, so
        // what is counted here is what `detect` would have returned.
        const v = merge(image.passes.map((p) => decode(p.data, p.dims, p.box, opts)));
        const area = v.whole ? 1 : coveredFraction(v.boxes, image.width, image.height);

        boxes += v.boxes.length;
        if (v.whole) wholes++;
        areaSum += area;
        if (v.boxes.length || v.whole) covered.add(image.file);

        for (const b of v.boxes) byLabel.set(b.label, (byLabel.get(b.label) || 0) + 1);
    }

    results.push({
        ...setting,
        boxes,
        wholes,
        covered,
        byLabel,
        shown: images.length - covered.size,
        meanArea: areaSum / images.length
    });
}

const pad = Math.max(...results.map((r) => r.name.length));

console.log(
    `${'setting'.padEnd(pad)} | boxes | whole | shown uncovered | mean covered area`
);
console.log(`${'-'.repeat(pad)}-+-------+-------+-----------------+------------------`);

for (const r of results) {
    console.log(
        `${r.name.padEnd(pad)} | ${String(r.boxes).padStart(5)} | ` +
            `${String(r.wholes).padStart(5)} | ${String(r.shown).padStart(15)} | ` +
            `${(r.meanArea * 100).toFixed(1).padStart(16)}%`
    );
}

// Boxes per class, which is where the attribution lives. Abbreviated because
// the full NudeNet names are 22 characters and there are five of them.
const SHORT = {
    FEMALE_GENITALIA_EXPOSED: 'f.gen',
    MALE_GENITALIA_EXPOSED: 'm.gen',
    ANUS_EXPOSED: 'anus',
    FEMALE_BREAST_EXPOSED: 'breast',
    BUTTOCKS_EXPOSED: 'butt'
};

const COLS = Object.keys(SHORT);

console.log(`\n${'setting'.padEnd(pad)} | ${COLS.map((c) => SHORT[c].padStart(6)).join(' | ')}`);
console.log(`${'-'.repeat(pad)}-+-${COLS.map(() => '------').join('-+-')}`);

for (const r of results) {
    const cells = COLS.map((c) => String(r.byLabel.get(c) || 0).padStart(6));
    console.log(`${r.name.padEnd(pad)} | ${cells.join(' | ')}`);
}

// The diff against what is in the tree today, which is the decision being
// made. The count is the headline; the folder is the evidence.
//
// First row by construction, not by name: `SETTINGS[0]` is the deployed bars,
// and every other row is read as a move away from it.
const baseline = results[0];

/** Write what a visitor would be served for `files` at `setting`. */
async function sheet(where, files, setting) {
    if (!files.length) return;

    await fs.mkdir(where, { recursive: true });

    const opts = { conf: setting.conf, genitalConf: setting.genital, breastConf: setting.breast };
    if (setting.whole !== undefined) opts.wholeTile = setting.whole;

    for (const file of files) {
        const image = images.find((i) => i.file === file);
        const verdict = merge(image.passes.map((p) => decode(p.data, p.dims, p.box, opts)));
        const buffer = await fs.readFile(path.join(dir, file));

        await sharp(await pixelate(buffer, verdict))
            .resize(260, 260, { fit: 'inside' })
            .jpeg({ quality: 80 })
            .toFile(path.join(where, file.replace(/\.\w+$/, '.jpg')));
    }
}

console.log(`\nagainst "${baseline.name}":`);

for (const r of results.slice(2)) {
    const added = [...r.covered].filter((f) => !baseline.covered.has(f));
    const lost = [...baseline.covered].filter((f) => !r.covered.has(f));

    console.log(
        `  ${r.name.padEnd(pad)} +${String(added.length).padStart(3)} newly covered, ` +
            `-${String(lost.length).padStart(3)} no longer covered`
    );

    if (contact) {
        const out = path.join(contact, r.name.replace(/[^\w.]+/g, '_'));

        // `added` at the new setting, because the question is what the mosaic
        // lands on there. `lost` at the *baseline*, because the question is
        // what the picture being given back used to have covered.
        await sheet(path.join(out, 'added'), added, r);
        await sheet(path.join(out, 'lost'), lost, baseline);
    }
}

if (contact) console.log(`\ncontact sheets under ${contact} — look at them before choosing`);
