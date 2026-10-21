/**
 * Prove the class order in `src/labels.js` matches the model that shipped.
 *
 * ## Why this is a manual step and not a test
 *
 * The check needs an image whose contents are known, and the images this
 * service exists to handle are not things to commit to a repository. So the
 * fixture is supplied by whoever runs it, from the feed the service will
 * actually see, and the result is recorded in the deploy log rather than in
 * CI.
 *
 * Run it once per model file. A mismatch here is the only failure this
 * service has that looks completely healthy from the outside: boxes come
 * back, latency is normal, the mosaic lands somewhere, and it is on a face
 * while the thing it was built for is still on screen.
 *
 *     npm run verify -- ./sample.jpg FEMALE_BREAST_EXPOSED
 *
 * Exits non-zero if any expected label is missing. With no expected labels it
 * prints everything the model found and asserts nothing, which is the right
 * first call when you are working out what the fixture contains.
 */
import { argv, exit } from 'node:process';
import { readFile } from 'node:fs/promises';

import { load, detect } from '../src/detect.js';
import { CLASSES, CENSOR, assertLabelOrder } from '../src/labels.js';

const [, , file, ...expected] = argv;

if (!file) {
    console.error('usage: npm run verify -- <image> [EXPECTED_LABEL ...]');
    exit(2);
}

const model = process.env.CENSOR_MODEL || '/app/model/320n.onnx';

await load(model);

const image = await readFile(file);

// `all` — this script is the one caller that wants the classes the service
// throws away. Faces and feet are the only two whose position in a photograph
// is known before you look, so they are the evidence that the mapping holds;
// running this in production mode would show only the classes under suspicion.
const verdict = await detect(image, { all: true });

console.log(`model    ${model}`);
console.log(`classes  ${CLASSES.length} transcribed, censoring ${CENSOR.length}`);
console.log(`image    ${file} (${verdict.width}x${verdict.height})`);
console.log(`whole    ${verdict.whole}`);
console.log(`peak     ${verdict.confidence?.toFixed(3) ?? 'n/a'}`);
console.log('');

if (!verdict.boxes.length) {
    console.log('no boxes above threshold');
} else {
    for (const box of verdict.boxes) {
        const at = `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`;
        const mark = CENSOR.includes(box.label) ? 'cover' : '     ';

        // Vertical centre as a fraction of height. The number to read when
        // you are checking the mapping rather than the detection: a FACE_*
        // near 1.0 or a FEET_* near 0.0 means the list is wrong, whatever
        // the scores say.
        const y = ((box.y + box.h / 2) / verdict.height).toFixed(2);

        console.log(`  ${box.score.toFixed(3)}  ${mark}  y=${y}  ${box.label.padEnd(26)} ${at}`);
    }
}

if (!expected.length) {
    console.log('\nNo expected labels given - nothing asserted.');
    exit(0);
}

try {
    assertLabelOrder(verdict.boxes, expected);
    console.log(`\nOK: found all of [${expected.join(', ')}]`);
} catch (err) {
    console.error(`\n${err.message}`);
    exit(1);
}
