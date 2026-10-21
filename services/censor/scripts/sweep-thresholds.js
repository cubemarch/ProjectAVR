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
 * ## What it reports, and what it cannot
 *
 * There is no ground truth here. Nobody has labelled these images, so this
 * cannot print precision or recall and does not pretend to. What it can state
 * exactly is the *change*: which images move from shown to covered, how much
 * of each frame is covered, and how often the whole-frame fallback fires.
 *
 * `--contact` writes the images that newly become covered to a directory, at
 * thumbnail size. That is the part worth looking at. A setting that covers
 * forty more images is good if they are forty pictures of genitals and bad if
 * they are forty clothed box covers, and the only thing that can tell those
 * apart is a person opening the folder.
 *
 *   node scripts/sweep-thresholds.js <corpus-dir> [--model path] [--contact dir]
 *
 * The corpus is not in this repository and must not be: it is several hundred
 * partner images fetched for a measurement, and this service stores nothing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { load, letterbox, toTensor, decode } from '../src/detect.js';

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
const SETTINGS = [
    { name: '0.18 flat (was live)', conf: 0.18, genital: 0.18, breast: 0.18, whole: 0.09 },
    { name: 'baseline 0.15 / 0.03', conf: 0.15, genital: 0.03, breast: 0.15 },

    // The genital bar alone. Everything else pinned, so every delta is one of
    // FEMALE_GENITALIA / MALE_GENITALIA / ANUS.
    { name: 'genital 0.02', conf: 0.15, genital: 0.02, breast: 0.15 },
    { name: 'genital 0.015', conf: 0.15, genital: 0.015, breast: 0.15 },
    { name: 'genital 0.01', conf: 0.15, genital: 0.01, breast: 0.15 },
    { name: 'genital 0.005', conf: 0.15, genital: 0.005, breast: 0.15 },

    // The breast bar alone. At 0.15 it is on `conf`, which is where it was.
    { name: 'breast 0.05', conf: 0.15, genital: 0.03, breast: 0.05 },
    { name: 'breast 0.03', conf: 0.15, genital: 0.03, breast: 0.03 },
    { name: 'breast 0.02', conf: 0.15, genital: 0.03, breast: 0.02 },
    { name: 'breast 0.015', conf: 0.15, genital: 0.03, breast: 0.015 },

    // `conf` alone, which now governs only BUTTOCKS and MALE_BREAST. `whole`
    // pinned at the baseline's 0.075 so it cannot move underneath these.
    { name: 'conf 0.10', conf: 0.1, genital: 0.03, breast: 0.15, whole: 0.075 },
    { name: 'conf 0.06', conf: 0.06, genital: 0.03, breast: 0.15, whole: 0.075 },

    // What the three chosen numbers do together, which is the thing shipping.
    { name: 'CHOSEN .15/.015/.03', conf: 0.15, genital: 0.015, breast: 0.03 }
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

/** One inference per image, kept, so the settings below are free. */
const heads = [];
let unreadable = 0;

for (const [i, file] of files.entries()) {
    if (i % 50 === 0) process.stderr.write(`  inference ${i}/${files.length}\r`);

    try {
        const buffer = await fs.readFile(path.join(dir, file));
        const box = await letterbox(buffer);
        const input = new ort.Tensor('float32', toTensor(box.data), [1, 3, SIDE, SIDE]);
        const output = await session.run({ [session.inputNames[0]]: input });
        const head = output[session.outputNames[0]];

        heads.push({ file, box, data: head.data, dims: head.dims });
    } catch {
        // The service covers the whole frame when it cannot read an image, so
        // these are already handled and are not what a threshold affects.
        unreadable++;
    }
}

process.stderr.write(' '.repeat(40) + '\r');
console.log(`decoded ${heads.length}, unreadable ${unreadable} (those are covered whole regardless)\n`);

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

    for (const h of heads) {
        const v = decode(h.data, h.dims, h.box, opts);
        const area = v.whole ? 1 : coveredFraction(v.boxes, h.box.width, h.box.height);

        boxes += v.boxes.length;
        if (v.whole) wholes++;
        areaSum += area;
        if (v.boxes.length || v.whole) covered.add(h.file);

        for (const b of v.boxes) byLabel.set(b.label, (byLabel.get(b.label) || 0) + 1);
    }

    results.push({
        ...setting,
        boxes,
        wholes,
        covered,
        byLabel,
        shown: heads.length - covered.size,
        meanArea: areaSum / heads.length
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
const baseline = results[1];

console.log(`\nagainst "${baseline.name}":`);

for (const r of results.slice(2)) {
    const added = [...r.covered].filter((f) => !baseline.covered.has(f));
    const lost = [...baseline.covered].filter((f) => !r.covered.has(f));

    console.log(
        `  ${r.name.padEnd(pad)} +${String(added.length).padStart(3)} newly covered, ` +
            `-${lost.length} no longer covered`
    );

    if (contact && added.length) {
        const out = path.join(contact, r.name.replace(/[^\w.]+/g, '_'));
        await fs.mkdir(out, { recursive: true });

        for (const file of added) {
            await sharp(path.join(dir, file))
                .resize(220, 220, { fit: 'inside' })
                .jpeg({ quality: 80 })
                .toFile(path.join(out, file));
        }
    }
}

if (contact) console.log(`\ncontact sheets under ${contact} — look at them before choosing`);
