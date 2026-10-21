import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CLASSES, CENSOR, CENSOR_IDS, assertLabelOrder } from '../src/labels.js';
import { decode, nms, tiles, merge, policyFingerprint, _internals } from '../src/detect.js';

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

const { SIDE, CONF, GENITAL_CONF, BREAST_CONF, WHOLE_TILE, TILE_ASPECT, TILE_OVERLAP, MAX_TILES } =
    _internals;

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
    // Deliberately buttocks: it is the only censorable class still judged at
    // CONF. Genitalia and breasts have bars far under it, so a score a hair
    // below CONF is a *placed box* for them and this case does not exist.
    const score = CONF - 0.01;
    const { raw, dims } = tensor(10, [
        { at: 4, box: [100, 100, 20, 20], scores: { BUTTOCKS_EXPOSED: score } }
    ]);

    const { boxes, bestCensorable, whole } = decode(raw, dims, FLAT);

    assert.deepEqual(boxes, [], 'not placed');
    assert.equal(bestCensorable.toFixed(2), score.toFixed(2), 'but the confidence is reported');

    // And remembering it has to mean something. A hair under CONF is the
    // model declining to commit, not the model saying no; it used to leave
    // `whole` false, and with nothing placed that meant the photograph.
    assert.equal(whole, true, 'so a near miss covers the frame rather than showing it');
});

test('the band between confidently-clean and a placed box is covered', () => {
    // The three outcomes, walked in order. Only the first is ever shown to
    // somebody who has not verified their age, so the boundary between the
    // first and the second is the one number in this service that has to be
    // wrong in the safe direction.
    //
    // Buttocks because the band only exists for a class judged at CONF, and
    // that is now the only censorable one. For genitalia and breasts the
    // middle outcome is a placed box, which is the point of their own bars.
    const at = (score) => {
        const { raw, dims } = tensor(10, [
            { at: 3, box: [100, 100, 20, 20], scores: { BUTTOCKS_EXPOSED: score } }
        ]);
        return decode(raw, dims, FLAT);
    };

    const clean = at(WHOLE_TILE - 0.01);
    assert.deepEqual(clean.boxes, [], 'nothing placed');
    assert.equal(clean.whole, false, 'confidently clean, so it is shown');

    const unsure = at(WHOLE_TILE + 0.01);
    assert.deepEqual(unsure.boxes, [], 'still nothing placed');
    assert.equal(unsure.whole, true, 'but not clean enough to show');

    const placed = at(CONF + 0.01);
    assert.equal(placed.boxes.length, 1, 'over CONF it is a box');

    assert.ok(WHOLE_TILE < CONF, 'the band has to exist at all');
});

test('each class is judged at its own bar, and the three bars are ordered', () => {
    // The reason this exists: on 30 live cam thumbnails, plainly visible male
    // genitalia scored 0.022 and 0.024 while the flat threshold was 0.18, and
    // four tiles were served with nothing covered. Breasts on the same frames
    // scored in the tenths, and buttocks higher still. One threshold cannot
    // serve all three, and two cannot either — see the measurement tables in
    // `src/detect.js`, where each bar's own floor is a different number.
    const score = (label, value) => {
        const { raw, dims } = tensor(10, [
            { at: 2, box: [100, 100, 24, 24], scores: { [label]: value } }
        ]);
        return decode(raw, dims, FLAT).boxes;
    };

    assert.ok(GENITAL_CONF < BREAST_CONF, 'genitals sit under breasts');
    assert.ok(BREAST_CONF < CONF, 'breasts sit under everything else');

    const GENITALIA = ['FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED'];

    // A score the genital bar clears and the breast bar does not. Nothing but
    // those three may be placed here.
    const faint = (GENITAL_CONF + BREAST_CONF) / 2;

    for (const label of GENITALIA) {
        assert.equal(score(label, faint).length, 1, `${label} is placed at ${faint.toFixed(4)}`);
    }

    for (const label of ['FEMALE_BREAST_EXPOSED', 'BUTTOCKS_EXPOSED']) {
        assert.deepEqual(score(label, faint), [], `${label} is not placed at ${faint.toFixed(4)}`);
    }

    // A score the breast bar clears and `CONF` does not. This band is the
    // 2026-10-21 change: breasts used to be judged at `CONF` and walked past
    // sheer tops and lingerie the model had scored perfectly well here.
    const weak = (BREAST_CONF + CONF) / 2;

    for (const label of [...GENITALIA, 'FEMALE_BREAST_EXPOSED']) {
        assert.equal(score(label, weak).length, 1, `${label} is placed at ${weak.toFixed(3)}`);
    }

    // Buttocks stay on `CONF`, deliberately. They are not in the brief, they
    // are what a pair of jeans fires, and lowering their bar was measured and
    // bought no image that was not already covered.
    assert.deepEqual(score('BUTTOCKS_EXPOSED', weak), [], 'BUTTOCKS_EXPOSED still needs CONF');

    // And each floor is a floor.
    assert.deepEqual(score('MALE_GENITALIA_EXPOSED', GENITAL_CONF - 0.005), [], 'under the genital bar');
    assert.deepEqual(score('FEMALE_BREAST_EXPOSED', BREAST_CONF - 0.005), [], 'under the breast bar');
});

test('the policy fingerprint is stable, and moves when a bar moves', () => {
    // It exists so a deploy check can tell one build from another. Two ways
    // that can quietly stop being true: it starts varying between calls, so
    // it never matches; or it stops varying with the bars, so it always does.
    const fp = policyFingerprint();

    assert.match(fp, /^[0-9a-f]{12}$/, 'a short hex digest');
    assert.equal(fp, policyFingerprint(), 'same tree, same answer');

    // The bars themselves must not be readable off it.
    for (const n of [CONF, GENITAL_CONF, BREAST_CONF]) {
        assert.ok(!fp.includes(String(n).replace('0.', '')), `${n} is not in the clear`);
    }

    // And it has to actually depend on them. Nothing can reach in and change
    // a constant, so this checks the ingredient list the other way round: the
    // canonical string the digest is taken over is per-class, so a build with
    // breasts back on CONF has to hash differently from this one.
    const canonical = (bars, tiling = {}) =>
        createHash('sha256')
            .update(
                CENSOR_IDS.map((id) => `${CLASSES[id]}=${bars[CLASSES[id]] ?? CONF}`)
                    .sort()
                    .concat(
                        `WHOLE_TILE=${WHOLE_TILE}`,
                        `TILE_ASPECT=${tiling.aspect ?? TILE_ASPECT}`,
                        `TILE_OVERLAP=${tiling.overlap ?? TILE_OVERLAP}`,
                        `MAX_TILES=${tiling.max ?? MAX_TILES}`
                    )
                    .join('|')
            )
            .digest('hex')
            .slice(0, 12);

    const shipping = {
        FEMALE_GENITALIA_EXPOSED: GENITAL_CONF,
        MALE_GENITALIA_EXPOSED: GENITAL_CONF,
        ANUS_EXPOSED: GENITAL_CONF,
        FEMALE_BREAST_EXPOSED: BREAST_CONF
    };

    assert.equal(canonical(shipping), fp, 'the digest is over the bars actually in force');

    const previous = { ...shipping, FEMALE_BREAST_EXPOSED: CONF };
    assert.notEqual(canonical(previous), fp, 'and the previous tiering hashes differently');

    // How much of the picture the model gets to see decides what is covered
    // just as surely as the score it needs, and for one deploy this digest
    // could not tell. Tiling moved no bar, so the build that read a 1366x400
    // banner once and the build that reads it six times produced the same
    // twelve characters — and `/health` would have called the first one
    // correct.
    for (const [what, tiling] of [
        ['a different trigger', { aspect: TILE_ASPECT + 0.2 }],
        ['a different overlap', { overlap: TILE_OVERLAP + 0.1 }],
        ['a different cap', { max: MAX_TILES + 1 }]
    ]) {
        assert.notEqual(canonical(shipping, tiling), fp, `${what} hashes differently`);
    }
});

test('a censorable part is covered even when it loses its own anchor', () => {
    // The shape that leaked: the model reads the region as mostly torso and
    // also, less confidently, as a penis. Taking the anchor's winning class
    // and then asking whether it is censorable throws the second reading
    // away, which at thumbnail scale is where small parts live — inside
    // larger ones that score better.
    const { raw, dims } = tensor(10, [
        {
            at: 7,
            box: [120, 140, 30, 30],
            scores: { BELLY_EXPOSED: 0.62, MALE_GENITALIA_EXPOSED: 0.09 }
        }
    ]);

    const { boxes } = decode(raw, dims, FLAT);

    assert.equal(boxes.length, 1, 'the runner-up still places a box');
    assert.equal(boxes[0].label, 'MALE_GENITALIA_EXPOSED', 'and it is labelled as what it covers');
    assert.equal(boxes[0].score.toFixed(2), '0.09', 'carrying its own score, not the belly\'s');
});

test('two censorable classes on one anchor do not become two boxes', () => {
    // The cost of scoring every class independently is bounded by NMS, which
    // suppresses on overlap without regard to label. Without that, a low bar
    // multiplies boxes per anchor rather than finding more parts.
    const { raw, dims } = tensor(10, [
        {
            at: 1,
            box: [100, 100, 40, 40],
            scores: { FEMALE_GENITALIA_EXPOSED: 0.3, ANUS_EXPOSED: 0.2 }
        }
    ]);

    assert.equal(decode(raw, dims, FLAT).boxes.length, 1, 'one anchor is one box');
});

test('confident but unplaceable covers the whole frame', () => {
    // The thumbnail-resolution case: the model is sure something is there and
    // cannot say where well enough to clear the box threshold. Covering none
    // of it is the one answer that is not allowed.
    const { raw, dims } = tensor(10, [
        { at: 5, box: [100, 100, 8, 8], scores: { BUTTOCKS_EXPOSED: WHOLE_TILE + 0.05 } }
    ]);

    // Force the box below threshold by making a non-censorable class win the
    // anchor, which is exactly the real shape of this: the detector thinks
    // the anchor is mostly a belly, with real buttock confidence underneath.
    raw[(4 + CLASSES.indexOf('BELLY_EXPOSED')) * 10 + 5] = 0.99;

    const { boxes, whole, bestCensorable } = decode(raw, dims, FLAT);

    assert.deepEqual(boxes, [], 'no box cleared');
    assert.ok(bestCensorable >= WHOLE_TILE, 'but the confidence was there');
    assert.equal(whole, true, 'so the whole frame is covered');
});

test('the service is blind to what it does not cover, and the self-test is not', () => {
    const { raw, dims } = tensor(10, [
        { at: 2, box: [100, 40, 50, 50], scores: { FACE_FEMALE: 0.95 } },
        { at: 6, box: [100, 300, 30, 20], scores: { FEET_COVERED: 0.8 } }
    ]);

    // Production only ever needs to know what to mosaic, so everything else
    // is dropped before it reaches a caller.
    assert.deepEqual(decode(raw, dims, FLAT).boxes, [], 'nothing censorable, nothing returned');

    // But those are the two classes whose position is known in advance, which
    // makes them the only evidence that the mapping is right. The label
    // self-test would be checking its own assumption without them.
    const all = decode(raw, dims, FLAT, { all: true }).boxes;

    assert.equal(all.length, 2, 'the self-test sees them');

    const face = all.find((b) => b.label === 'FACE_FEMALE');
    const feet = all.find((b) => b.label === 'FEET_COVERED');

    assert.ok(face && feet, `both came back, got ${all.map((b) => b.label).join(', ')}`);
    assert.ok(face.y < feet.y, 'and the face is above the feet');

    // A frame holding only a face is still a frame with nothing to cover.
    assert.equal(decode(raw, dims, FLAT, { all: true }).whole, false, 'and nothing is covered whole');
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

/* ------------------------------------------------------------- tiling -- */

/** Where a list of windows starts and ends along the axis it walks. */
function spans(list, horizontal) {
    return list
        .map((t) => (horizontal ? [t.left, t.left + t.width] : [t.top, t.top + t.height]))
        .sort((a, b) => a[0] - b[0]);
}

test('a frame that already fills the input is read once and not tiled', () => {
    assert.deepEqual(tiles(320, 320), [], 'a square wastes none of the input');
    assert.deepEqual(tiles(1200, 1200), [], 'however large');
    assert.deepEqual(tiles(440, 400), [], 'and 1.1 is under the bar');
    assert.deepEqual(tiles(400, 440), [], 'in either orientation');

    assert.ok(tiles(400 * TILE_ASPECT + 1, 400).length > 0, 'just past it, there are windows');
});

test('windows cover the long axis end to end, with no strip left unread', () => {
    // A gap here is not a near miss. It is a band of the picture that nothing
    // ever looks at, in a service whose entire job is to look.
    for (const [w, h] of [
        [1366, 400],
        [1920, 1079],
        [800, 300],
        [100, 150],
        [533, 800],
        [4000, 3],
        [3, 4000]
    ]) {
        const horizontal = w >= h;
        const long = Math.max(w, h);
        const list = tiles(w, h);
        const seen = spans(list, horizontal);

        assert.ok(list.length >= 2, `${w}x${h} is lopsided enough to tile`);
        assert.equal(seen[0][0], 0, `${w}x${h} starts at the edge`);
        assert.equal(seen.at(-1)[1], long, `${w}x${h} reaches the far edge`);

        for (let i = 1; i < seen.length; i += 1) {
            assert.ok(
                seen[i][0] <= seen[i - 1][1],
                `${w}x${h} leaves nothing between window ${i - 1} and ${i}`
            );
        }

        for (const t of list) {
            assert.ok(t.left >= 0 && t.top >= 0, `${w}x${h} window starts inside the frame`);
            assert.ok(t.left + t.width <= w, `${w}x${h} window ends inside the frame`);
            assert.ok(t.top + t.height <= h, `${w}x${h} window ends inside the frame`);
        }
    }
});

test('the window count is bounded however lopsided the frame', () => {
    // `verify-deploy.js` sends a 4000x3 sliver on purpose. Window-side-equals-
    // short-edge would ask for over a thousand 3x3 inferences for it; past the
    // cap the windows get longer instead of more numerous.
    for (const [w, h] of [
        [4000, 3],
        [3, 4000],
        [20000, 40],
        [1366, 400]
    ]) {
        assert.ok(tiles(w, h).length <= MAX_TILES, `${w}x${h} stays inside the cap`);
    }

    const sliver = tiles(4000, 3);
    assert.ok(sliver.every((t) => t.width > 3), 'the sliver got wider windows, not more of them');
});

test('windows overlap by enough to hold a small part whole', () => {
    // The guarantee: a region narrower than `side * TILE_OVERLAP` falls wholly
    // inside at least one window rather than being split across two. That is
    // the property the whole change rests on — a breast cut in half by a
    // window edge is two half-detections and no box.
    const list = tiles(1366, 400);
    const seen = spans(list, true);

    for (let i = 1; i < seen.length; i += 1) {
        const shared = seen[i - 1][1] - seen[i][0];
        assert.ok(
            shared >= 400 * TILE_OVERLAP,
            `windows ${i - 1} and ${i} share ${shared}px, wanted ${400 * TILE_OVERLAP}`
        );
    }
});

test('a box found in a window comes back placed in the frame', () => {
    // Boxes leave `decode` in frame coordinates whoever called it, so there is
    // no window-local intermediate a second call site could forget to shift.
    const { raw, dims } = tensor(10, [
        { at: 4, box: [160, 160, 40, 40], scores: { MALE_GENITALIA_EXPOSED: 0.9 } }
    ]);

    const window = { scale: 1, padX: 0, padY: 0, width: SIDE, height: SIDE, left: 966, top: 0 };
    const { boxes } = decode(raw, dims, window);

    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].x, 966 + 140, 'shifted by where the window sits');
    assert.equal(boxes[0].y, 140, 'and not shifted on the axis that did not move');
});

test('a box is clipped to its own window, not to the frame', () => {
    // A window can only speak for what it saw. A box regressed off its right
    // edge is not evidence about the next window along, which gets its own
    // look — so it is cut at the window, and the overlap is what makes that
    // safe rather than lossy.
    const { raw, dims } = tensor(10, [
        { at: 0, box: [310, 160, 40, 40], scores: { ANUS_EXPOSED: 0.9 } }
    ]);

    const window = { scale: 1, padX: 0, padY: 0, width: SIDE, height: SIDE, left: 400, top: 0 };
    const { boxes } = decode(raw, dims, window);

    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].x, 400 + 290, 'placed in the frame');
    assert.equal(boxes[0].x + boxes[0].w, 400 + SIDE, 'and cut at the window edge');
});

test('merging windows collapses a part that two of them found', () => {
    const one = {
        boxes: [{ label: 'FEMALE_BREAST_EXPOSED', score: 0.4, x: 300, y: 50, w: 60, h: 60 }],
        bestCensorable: 0.4,
        whole: false
    };
    const two = {
        boxes: [{ label: 'FEMALE_BREAST_EXPOSED', score: 0.6, x: 304, y: 52, w: 60, h: 60 }],
        bestCensorable: 0.6,
        whole: false
    };

    const merged = merge([one, two]);

    assert.equal(merged.boxes.length, 1, 'an overlap is one part seen twice, not two parts');
    assert.equal(merged.boxes[0].score, 0.6, 'and the confident window wins');
    assert.equal(merged.confidence, 0.6, 'the reported confidence is the highest anywhere');
    assert.equal(merged.whole, false);
});

test('one sure window covers the whole frame even when the others cleared', () => {
    // The fallback has to survive merging. A window that was confident and
    // could not place is the case this service was built around, and folding
    // it in with four quiet windows must not average it away.
    const quiet = { boxes: [], bestCensorable: 0.001, whole: false };
    const sure = { boxes: [], bestCensorable: WHOLE_TILE + 0.01, whole: true };

    assert.equal(merge([quiet, quiet, sure, quiet]).whole, true, 'any window is enough');
    assert.equal(merge([quiet, quiet, quiet]).whole, false, 'and none of them is not');

    // But a placed box is a better answer than destroying the picture, even
    // when the window that placed it is not the window that was sure.
    const placed = {
        boxes: [{ label: 'ANUS_EXPOSED', score: 0.9, x: 10, y: 10, w: 20, h: 20 }],
        bestCensorable: 0.9,
        whole: false
    };

    assert.equal(merge([sure, placed]).whole, false, 'something was covered, so not everything is');
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
