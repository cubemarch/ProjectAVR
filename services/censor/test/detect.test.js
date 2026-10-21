import test from 'node:test';
import assert from 'node:assert/strict';

import { CLASSES, CENSOR, CENSOR_IDS, assertLabelOrder } from '../src/labels.js';
import { decode, nms, _internals } from '../src/detect.js';

/**
 * The decode, driven by a hand-built tensor.
 *
 * No model is loaded here and that is deliberate: shipping ten megabytes of
 * weights into a test suite to assert arithmetic is the wrong trade, and the
 * arithmetic is where the bugs are. The model's output is a flat array of
 * floats whose meaning is entirely positional, so these cases build that
 * array by hand with known values in known slots and check that what comes
 * out the other end is the box that was put in.
 *
 * The one thing this cannot check is whether the *positions* in
 * `src/labels.js` match the model file. Nothing in software can check that.
 * See `scripts/verify-labels.js`.
 */

const { SIDE, CONF, WHOLE_TILE } = _internals;

/**
 * Build a `[1, 4 + classes, anchors]` tensor, channel-major.
 *
 * Mirrors the layout the real head emits: a single anchor's numbers are
 * strided by `anchors`, not adjacent. Reading it the other way round is the
 * classic way to get a detector that returns confident nonsense, so the
 * fixture is laid out the hard way on purpose.
 */
function tensor(anchors, entries) {
    const channels = 4 + CLASSES.length;
    const raw = new Float32Array(channels * anchors);

    for (const { at, box, scores } of entries) {
        raw[at] = box[0];
        raw[anchors + at] = box[1];
        raw[anchors * 2 + at] = box[2];
        raw[anchors * 3 + at] = box[3];

        for (const [cls, score] of Object.entries(scores)) {
            raw[(4 + CLASSES.indexOf(cls)) * anchors + at] = score;
        }
    }

    return { raw, dims: [1, channels, anchors] };
}

/** An identity letterbox: no scaling, no padding, so boxes map one to one. */
const FLAT = { scale: 1, padX: 0, padY: 0, width: SIDE, height: SIDE };

test('the label list is self-consistent', () => {
    assert.equal(new Set(CLASSES).size, CLASSES.length, 'no duplicates');
    assert.ok(
        CENSOR_IDS.every((id) => id >= 0),
        `every censored name is in CLASSES: ${CENSOR.join(', ')}`
    );

    // A bare male chest is not what any of this is for, and covering it would
    // mosaic half the couples on the row.
    assert.ok(!CENSOR.includes('MALE_BREAST_EXPOSED'), 'male chests are out, deliberately');

    // Nothing the model says is already clothed should be covered.
    assert.ok(
        !CENSOR.some((name) => name.endsWith('_COVERED')),
        'nothing _COVERED is censored'
    );
});

test('a censorable box above threshold comes back in source pixels', () => {
    const { raw, dims } = tensor(10, [
        {
            at: 3,
            box: [100, 80, 40, 30], // cx, cy, w, h
            scores: { FEMALE_GENITALIA_EXPOSED: 0.9 }
        }
    ]);

    const { boxes } = decode(raw, dims, FLAT);

    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].label, 'FEMALE_GENITALIA_EXPOSED');

    // centre-form in, corner-form out
    assert.equal(boxes[0].x, 80);
    assert.equal(boxes[0].y, 65);
    assert.equal(boxes[0].w, 40);
    assert.equal(boxes[0].h, 30);
});

test('letterbox padding and scale are undone, not ignored', () => {
    const { raw, dims } = tensor(10, [
        { at: 1, box: [160, 160, 32, 32], scores: { ANUS_EXPOSED: 0.8 } }
    ]);

    // A 640x480 source letterboxed into 320x320: scaled by 0.5, padded 40px
    // top and bottom.
    const { boxes } = decode(raw, dims, {
        scale: 0.5,
        padX: 0,
        padY: 40,
        width: 640,
        height: 480
    });

    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].x, (160 - 16 - 0) / 0.5, 'x unpadded and unscaled');
    assert.equal(boxes[0].y, (160 - 16 - 40) / 0.5, 'y accounts for the vertical pad');
    assert.equal(boxes[0].w, 64, 'and the box grew with the source');
});

test('a face is detected and not covered', () => {
    const { raw, dims } = tensor(10, [
        { at: 2, box: [100, 100, 50, 50], scores: { FACE_FEMALE: 0.95 } }
    ]);

    const { boxes, bestCensorable } = decode(raw, dims, FLAT);

    assert.deepEqual(boxes, [], 'nothing to cover');
    assert.ok(bestCensorable < WHOLE_TILE, 'and no reason to cover everything');
});

test('below threshold is not a box, but is still remembered', () => {
    const score = CONF - 0.01;
    const { raw, dims } = tensor(10, [
        { at: 4, box: [100, 100, 20, 20], scores: { MALE_GENITALIA_EXPOSED: score } }
    ]);

    const { boxes, bestCensorable } = decode(raw, dims, FLAT);

    assert.deepEqual(boxes, [], 'not placed');
    assert.equal(bestCensorable.toFixed(2), score.toFixed(2), 'but the confidence is reported');
});

test('confident but unplaceable covers the whole frame', () => {
    // The thumbnail-resolution case: the model is sure something is there and
    // cannot say where well enough to clear the box threshold. Covering none
    // of it is the one answer that is not allowed.
    const { raw, dims } = tensor(10, [
        { at: 5, box: [100, 100, 8, 8], scores: { FEMALE_BREAST_EXPOSED: WHOLE_TILE + 0.05 } }
    ]);

    // Force the box below threshold by making a non-censorable class win the
    // anchor, which is exactly the real shape of this: the detector thinks
    // the anchor is mostly a belly, with real breast confidence underneath.
    raw[(4 + CLASSES.indexOf('BELLY_EXPOSED')) * 10 + 5] = 0.99;

    const { boxes, whole, bestCensorable } = decode(raw, dims, FLAT);

    assert.deepEqual(boxes, [], 'no box cleared');
    assert.ok(bestCensorable >= WHOLE_TILE, 'but the confidence was there');
    assert.equal(whole, true, 'so the whole frame is covered');
});

test('a wrong-sized model is refused rather than misread', () => {
    const anchors = 10;
    const raw = new Float32Array((4 + CLASSES.length + 3) * anchors);

    assert.throws(
        () => decode(raw, [1, 4 + CLASSES.length + 3, anchors], FLAT),
        /does not match the model/,
        'three extra classes is a different model, not a detail'
    );
});

test('overlapping boxes for the same part become one', () => {
    const kept = nms([
        { label: 'A', score: 0.9, x: 10, y: 10, w: 50, h: 50 },
        { label: 'A', score: 0.8, x: 12, y: 12, w: 50, h: 50 },
        { label: 'B', score: 0.7, x: 200, y: 200, w: 40, h: 40 }
    ]);

    assert.equal(kept.length, 2, 'the near-duplicate is dropped');
    assert.equal(kept[0].score, 0.9, 'and the survivor is the confident one');
});

test('boxes are clipped to the frame, not dropped at its edge', () => {
    const { raw, dims } = tensor(10, [
        // Centred on the top-left corner: half of it is off-frame.
        { at: 0, box: [0, 0, 60, 60], scores: { BUTTOCKS_EXPOSED: 0.7 } }
    ]);

    const { boxes } = decode(raw, dims, FLAT);

    assert.equal(boxes.length, 1, 'a part half off the edge still has to be covered');
    assert.equal(boxes[0].x, 0);
    assert.equal(boxes[0].y, 0);
    assert.ok(boxes[0].w > 1 && boxes[0].h > 1);
});

test('the self-test refuses a model that found nothing it was told to expect', () => {
    assert.throws(
        () => assertLabelOrder([], ['FEMALE_BREAST_EXPOSED']),
        /label self-test failed/,
        'silence is the failure mode this exists to catch'
    );

    assert.throws(
        () => assertLabelOrder([{ label: 'FACE_FEMALE' }], ['FEMALE_BREAST_EXPOSED']),
        /probably does not match/,
        'and so is covering the wrong thing confidently'
    );

    assert.doesNotThrow(() =>
        assertLabelOrder([{ label: 'FEMALE_BREAST_EXPOSED' }], ['FEMALE_BREAST_EXPOSED'])
    );
});
