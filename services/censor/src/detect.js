import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { CLASSES, CENSOR_IDS, GENITAL_IDS, BREAST_ID } from './labels.js';

/**
 * Both native modules are resolved on first use rather than imported.
 *
 * `decode`, `nms` and the label list are arithmetic over a flat array, and
 * they are where the bugs in this file live. Loading them should not require
 * a machine that can build `sharp` and `onnxruntime-node` — which is what a
 * top-level import would mean for the test suite, and for anyone reading the
 * decode on a laptop.
 */
const require = createRequire(import.meta.url);

const lazy = (name) => {
    let mod = null;
    return () => (mod ??= require(name));
};

const ort = lazy('onnxruntime-node');
const sharpOf = lazy('sharp');

/** The model's input is square and fixed. NudeNet v3 `320n.onnx`. */
const SIDE = 320;

/**
 * Anchors the head emits for a 320px input: strides 8, 16 and 32 give
 * 40x40 + 20x20 + 10x10 cells. Asserted against the real tensor at load
 * rather than trusted, because a different model file means a different
 * number and the reshape would otherwise read garbage as confidence.
 */
const ANCHORS = (SIDE / 8) ** 2 + (SIDE / 16) ** 2 + (SIDE / 32) ** 2;

/**
 * Confidence to accept a box.
 *
 * Low on purpose, and lower than the 0.25 these detectors usually ship with.
 * The two outcomes are not symmetric: a false positive mosaics a shoulder and
 * a false negative is the thing this service exists to prevent. Tuned for
 * recall and backstopped by {@link WHOLE_TILE} below, which catches the case
 * where the model is confident something is there and not confident where.
 */
const CONF = 0.15;

/**
 * The bar for the three classes in {@link GENITAL_IDS}, well under {@link CONF}.
 *
 * ## Why these get their own number
 *
 * Because the evidence says one threshold cannot serve both jobs. Sampling 30
 * live cam thumbnails on 2026-10-20 and looking at the output rather than the
 * box count, four tiles showed uncovered genitals. Probing those regions, the
 * model had scored them 0.022 and 0.024 — not close to `CONF`, not close to
 * the whole-frame fallback either, so nothing fired and the frame was served.
 * On the same images breasts and buttocks scored in the tenths. The detector
 * is not uniformly weak; it is weak on exactly the part the brief names.
 *
 * Lowering `CONF` to reach them was measured and rejected, and remeasured and
 * rejected again on 2026-10-21 once the bars were properly separated: with
 * breasts moved to {@link BREAST_CONF}, dropping `CONF` from 0.15 to 0.06
 * covers **zero** additional pictures out of 518. All it does is add buttocks
 * boxes to frames that were already covered. It is not the lever. This is.
 *
 * ## Why 0.015 and not lower
 *
 * 0.01 is where the model starts calling men's faces genitals. Stepping this
 * bar alone over 518 uncovered partner images on 2026-10-21, with the other
 * two pinned so every difference is attributable to this number:
 *
 * | this bar | genital boxes | newly covered | what the new ones are      |
 * | -------- | ------------- | ------------- | -------------------------- |
 * | 0.03     |           727 |             — | baseline                   |
 * | 0.02     |           837 |            +1 | clean                      |
 * | 0.015    |           924 |            +5 | all crotch regions, clean  |
 * | 0.01     |          1033 |            +7 | two men's headshots        |
 * | 0.005    |          1380 |           +16 | worse                      |
 *
 * So: 0.015. The five it gains there are underwear and swimwear crotches —
 * the exact miss the cam sampling above found — and the first false positive
 * is one step further down.
 */
const GENITAL_CONF = 0.015;

/**
 * The bar for `FEMALE_BREAST_EXPOSED`, between the other two.
 *
 * ## Why breasts are not on either of the other numbers
 *
 * They were on `CONF` until 2026-10-21, and that was measured wrong rather
 * than reasoned wrong: the sweep that set it moved `CONF` and `GENITAL_CONF`
 * together, so a change it attributed to the breast bar had in fact come from
 * the whole-frame fallback dropping with `CONF`. Separating the two showed the
 * breast bar is the single biggest lever on this corpus, and that it has its
 * own floor, nowhere near the other two.
 *
 * Over the same 518 images, this bar alone, the other two pinned:
 *
 * | this bar | breast boxes | newly covered | what the new ones are         |
 * | -------- | ------------ | ------------- | ----------------------------- |
 * | 0.15     |          466 |             — | baseline, breasts on `CONF`   |
 * | 0.05     |          577 |            +6 | sheer and lingerie            |
 * | 0.03     |          659 |           +17 | sheer, lingerie, topless      |
 * | 0.02     |          746 |           +31 | a clothed man in a shirt      |
 * | 0.015    |          816 |           +38 | worse                         |
 *
 * 0.03 is the floor. One step down and the additions include a man in a white
 * button-down, a woman in a plain t-shirt and a sundress on a road — clothed
 * promotional art, which is the failure this whole file is written to avoid.
 *
 * `BUTTOCKS_EXPOSED` deliberately stays on `CONF`. It is not in the brief, it
 * is the class most often fired by a pair of jeans, and the sweep says moving
 * it buys nothing: `CONF` at 0.06 places 71 more buttocks boxes and covers no
 * image that was not already covered.
 *
 * ## What the three bars together do
 *
 * | setting                  | boxes | whole-frame | shown | mean area |
 * | ------------------------ | ----- | ----------- | ----- | --------- |
 * | 0.18 flat (was deployed) |  1078 |          10 |   130 |     12.2% |
 * | 0.15 / 0.03              |  1360 |           7 |   123 |     13.0% |
 * | 0.15 / 0.015 / 0.03      |  1747 |           2 |   101 |     13.3% |
 *
 * Two columns are worth reading twice. The whole-frame count went *down*, not
 * up: a whole-frame mosaic is what this service does when it is sure something
 * is there and cannot say where, so a bar low enough to place the box is a bar
 * that stops it having to destroy the picture instead. And mean covered area
 * moved three tenths of a point while 22 more images became covered — the
 * extra boxes are landing on things. A bar low enough to scatter would have
 * shown up here as area climbing with no images changing hands.
 */
const BREAST_CONF = 0.03;

/**
 * The bar a given class has to clear.
 *
 * Three tiers, not a global threshold, because the model's confidence is not
 * calibrated the same way across classes and the brief does not weight them
 * the same either. Which class sits on which number is a measured decision,
 * re-measured whenever one of them moves; `scripts/sweep-thresholds.js` is the
 * measurement and the tables above are its output. Production passes nothing
 * and gets the three constants.
 */
function barFor(id, conf, genitalConf, breastConf) {
    if (GENITAL_IDS.includes(id)) return genitalConf;
    if (id === BREAST_ID) return breastConf;
    return conf;
}

/** Boxes overlapping more than this are the same part seen twice. */
const IOU = 0.45;

/**
 * Cover the entire image when the best censorable score is above this but no
 * box cleared {@link CONF}.
 *
 * This is the thumbnail-resolution fallback and it will fire more often than
 * is comfortable. At 360x270 a subject can be forty pixels tall, which is
 * under what box regression is reliable at even when classification is sure.
 * The honest response to "something is there and I cannot say where" is to
 * cover all of it, not none of it.
 *
 * ## Why this is half of {@link CONF} and not the 0.30 it started at
 *
 * This number is doing a second job that only became visible once the
 * mosaic started working. It is not only "was the model sure something was
 * there" — it is the line under which **an empty box list is trustworthy**,
 * because an image with no boxes and a score below this is the one case in
 * this service that gets shown to an unverified visitor unmodified.
 *
 * At 0.30 that line sat well above {@link CONF}, so a score of 0.25 — which
 * is to say "the model nearly placed a box and did not" — produced no boxes,
 * no whole-frame cover, and the photograph. Absence of evidence was being
 * read as evidence of absence, in the one direction that shows skin.
 *
 * Measured over the 51 boxcovers on the three Bang shelves, 2026-10-20:
 * images that produced a box scored 0.221 to 0.884; images the model cleared
 * scored 0.002 to 0.152. The populations do not overlap and the gap is wide,
 * so the threshold is not finely balanced — anywhere in 0.16 to 0.22 splits
 * this sample identically. It sits at half of `CONF` instead, which is below
 * the gap rather than inside it, because the sample is 51 images of one kind
 * and the cost of the two mistakes is not symmetric: too high shows a
 * photograph, too low mosaics a clothed cover.
 *
 * Expressed against `CONF` rather than written as a number so the two move
 * together. `CONF` is deliberately tuned for recall; a score at half of an
 * already-generous bar is weak, and anything between the two is the model
 * declining to commit. That band gets covered.
 */
const WHOLE_TILE = CONF / 2;

/**
 * A short, stable fingerprint of the covering policy, for `/health`.
 *
 * ## What it is for
 *
 * Answering "is the image I just built the image that is serving", which
 * nothing could answer before. A deploy here has twice reported success while
 * the service stayed on an older image — once because the build failed and
 * the deploy on the next line was not conditional on it, once because the
 * documented image path and the pushed image path were different names. Both
 * times the checks that were run came back clean, because every one of them
 * tested a property both builds had.
 *
 * `X-Censor-Confidence` is not this. Its absence means detection did not
 * finish, in every build there has ever been; reading it as a version marker
 * is a mistake already made once here.
 *
 * ## Why a hash and not the numbers
 *
 * `/health` is the one unauthenticated route, and the bars are the single
 * most useful thing to know if you are trying to get a picture past this
 * service. They are derivable from public source, so this is not a secret and
 * is not handled as one — but there is no reason to hand them to a casual
 * reader of a public endpoint in plain text either.
 *
 * Covers every censorable class's own bar, and `WHOLE_TILE`. Change any one
 * of them and this changes; change something that does not affect what gets
 * covered and it does not.
 */
export function policyFingerprint() {
    const canonical = CENSOR_IDS.map((id) => `${CLASSES[id]}=${barFor(id, CONF, GENITAL_CONF, BREAST_CONF)}`)
        .sort()
        .concat(`WHOLE_TILE=${WHOLE_TILE}`)
        .join('|');

    return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

let session = null;

/**
 * Load the ONNX session once, lazily.
 *
 * `onnxruntime-node` is required rather than imported so that this module can
 * be loaded — and the pure functions below tested — on a machine that has no
 * native runtime built for it. Nothing calls {@link detect} without a model.
 */
export async function load(modelPath) {
    if (session) return session;

    session = await ort().InferenceSession.create(modelPath, {
        graphOptimizationLevel: 'all',
        // One thread per request is the right shape for a request-scoped
        // service: concurrency comes from the container, not from inside a
        // single inference, and intra-op threads just contend under load.
        intraOpNumThreads: 1,
        executionMode: 'sequential'
    });

    return session;
}

/**
 * Letterbox to the model's square input without distorting the subject.
 *
 * A plain `resize` to 320x320 squashes a 360x270 thumbnail by a third
 * vertically. The model was trained on undistorted people, so squashing them
 * costs recall exactly where it is already weakest. Returns the scale and pad
 * needed to map boxes back.
 */
export async function letterbox(buffer) {
    const image = sharpOf()(buffer, { failOn: 'none' });
    const meta = await image.metadata();

    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    if (!width || !height) throw new Error('unreadable image');

    const scale = Math.min(SIDE / width, SIDE / height);
    const drawWidth = Math.round(width * scale);
    const drawHeight = Math.round(height * scale);
    const padX = Math.floor((SIDE - drawWidth) / 2);
    const padY = Math.floor((SIDE - drawHeight) / 2);

    const { data } = await image
        .resize(drawWidth, drawHeight, { fit: 'fill', kernel: 'cubic' })
        .extend({
            top: padY,
            bottom: SIDE - drawHeight - padY,
            left: padX,
            right: SIDE - drawWidth - padX,
            background: { r: 114, g: 114, b: 114 }
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return { data, scale, padX, padY, width, height };
}

/** HWC bytes to the NCHW float tensor the model wants, normalised to 0..1. */
export function toTensor(data) {
    const plane = SIDE * SIDE;
    const out = new Float32Array(plane * 3);

    for (let i = 0; i < plane; i += 1) {
        out[i] = data[i * 3] / 255;
        out[plane + i] = data[i * 3 + 1] / 255;
        out[plane * 2 + i] = data[i * 3 + 2] / 255;
    }

    return out;
}

/**
 * Read the raw head into boxes in the *original* image's pixel space.
 *
 * The tensor is `[1, 4 + classes, anchors]` laid out channel-major, so a
 * single anchor's numbers are strided by `anchors` rather than adjacent —
 * reading it as rows of candidates is the classic way to get a detector that
 * returns plausible nonsense.
 *
 * Exported for the tests, which drive it with a hand-built tensor. That is
 * the only way to check the decode without shipping a 10MB model into the
 * test suite.
 *
 * `all` keeps the thirteen classes the service does not cover. Production
 * never wants them — it only needs to know what to mosaic — but the label
 * self-test does, and badly: faces and feet are the two classes whose
 * position in a photograph is known in advance, so they are the only
 * evidence that the index-to-name mapping is right at all. Filtering them
 * out leaves that script able to see only the classes it is trying to prove.
 *
 * `conf`, `genitalConf`, `breastConf` and `wholeTile` default to the constants
 * above and exist so a threshold sweep can drive this function rather than a
 * copy of it. Every number in the docstrings here came from such a sweep, and
 * a reimplementation of the decode is the one way to measure a setting that
 * the service will not actually use.
 *
 * `wholeTile` follows `conf` unless given explicitly, which keeps the
 * relationship the constant expresses — but a sweep moving `conf` must pin it,
 * or the whole-frame fallback moves underneath the measurement and the result
 * gets attributed to the wrong bar. That mistake is what put breasts on the
 * wrong threshold until 2026-10-21.
 *
 * **Nothing in the service passes them.** `detect` forwards its options, the
 * server passes `{}`, and the only caller that sets them is
 * `scripts/sweep-thresholds.js`. They are not a runtime knob and must not
 * become one: a censor whose bar can be raised by a request parameter is a
 * censor with a bypass.
 */
export function decode(
    raw,
    dims,
    { scale, padX, padY, width, height },
    {
        all = false,
        conf = CONF,
        genitalConf = GENITAL_CONF,
        breastConf = BREAST_CONF,
        wholeTile = conf / 2
    } = {}
) {
    const [, channels, anchors] = dims;
    const classes = channels - 4;

    if (classes !== CLASSES.length) {
        throw new Error(
            `censor: model has ${classes} classes, labels.js lists ` +
                `${CLASSES.length}. The transcription does not match the model.`
        );
    }

    const out = [];
    let bestCensorable = 0;

    for (let a = 0; a < anchors; a += 1) {
        let top = -1;
        let topScore = 0;

        for (let c = 0; c < classes; c += 1) {
            const score = raw[(4 + c) * anchors + a];
            if (score > topScore) {
                topScore = score;
                top = c;
            }
        }

        if (top < 0) continue;

        // cx, cy, w, h in letterboxed 320-space -> x, y, w, h in source space.
        // One anchor is one box; only the label and score differ between the
        // candidates below.
        const cx = raw[a];
        const cy = raw[anchors + a];
        const bw = raw[anchors * 2 + a];
        const bh = raw[anchors * 3 + a];

        const geometry = {
            x: (cx - bw / 2 - padX) / scale,
            y: (cy - bh / 2 - padY) / scale,
            w: bw / scale,
            h: bh / scale
        };

        // Every censorable class is judged on its own score, against its own
        // bar, whether or not it won the anchor.
        //
        // It used to have to win: the anchor's top class was taken and then
        // tested for censorability, so genitalia scoring 0.14 under a belly
        // scoring 0.40 placed nothing. That reads as reasonable and is the
        // wrong shape for this service — "the model thinks this is mostly a
        // torso and also thinks there is a penis in it" is not a frame to
        // leave alone. It is also the exact failure mode at thumbnail scale,
        // where a small part sits inside a larger one that scores better.
        //
        // The cost is bounded by NMS, which suppresses on overlap without
        // regard to label, so two classes firing on one anchor collapse back
        // to one box rather than compounding.
        let placed = false;

        for (const id of CENSOR_IDS) {
            const score = raw[(4 + id) * anchors + a];

            // Tracked across every anchor, including ones that place nothing,
            // because the whole-tile fallback asks "was the model sure
            // something censorable was here" and that question is not limited
            // to anchors that cleared a bar.
            if (score > bestCensorable) bestCensorable = score;

            if (score < barFor(id, conf, genitalConf, breastConf)) continue;

            out.push({ label: CLASSES[id], score, ...geometry });
            placed = true;
        }

        // The thirteen classes this service does not cover exist only for the
        // label self-test. Nothing in production reads them.
        if (all && !placed && !CENSOR_IDS.includes(top) && topScore >= conf) {
            out.push({ label: CLASSES[top], score: topScore, ...geometry });
        }
    }

    const boxes = clamp(nms(out), width, height);

    // Counted rather than `boxes.length`, because under `all` the list also
    // holds faces and feet, and a frame with a face in it and nothing covered
    // is still a frame with nothing covered.
    const covering = boxes.filter((b) => CENSOR_IDS.includes(CLASSES.indexOf(b.label))).length;

    return {
        boxes,
        bestCensorable,

        // Decided here rather than by the caller, so there is exactly one
        // place that can answer "cover everything" and it is the same place
        // that knows why. A caller recomputing this from `bestCensorable` is
        // a caller that can get it wrong in the direction that shows skin.
        whole: covering === 0 && bestCensorable >= wholeTile
    };
}

/** Greedy non-maximum suppression, highest score wins its neighbourhood. */
export function nms(boxes) {
    const kept = [];

    for (const box of [...boxes].sort((a, b) => b.score - a.score)) {
        if (!kept.some((k) => iou(k, box) > IOU)) kept.push(box);
    }

    return kept;
}

function iou(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const t = Math.min(a.y + a.h, b.y + b.h);

    if (r <= x || t <= y) return 0;

    const overlap = (r - x) * (t - y);

    return overlap / (a.w * a.h + b.w * b.h - overlap);
}

/** Keep boxes inside the frame; a box half off the edge still has to cover. */
function clamp(boxes, width, height) {
    return boxes
        .map((box) => {
            const x = Math.max(0, box.x);
            const y = Math.max(0, box.y);

            return {
                ...box,
                x,
                y,
                w: Math.min(width - x, box.w + Math.min(0, box.x)),
                h: Math.min(height - y, box.h + Math.min(0, box.y))
            };
        })
        .filter((box) => box.w > 1 && box.h > 1);
}

/**
 * One image in, a verdict out.
 *
 * `whole` is the instruction to cover everything, and it is set both by the
 * confidence fallback and by anything that went wrong. A caller that cannot
 * tell "clean" from "broken" would show a broken image uncensored, so the two
 * are never the same return value — see the service's error path.
 */
export async function detect(buffer, options = {}) {
    const box = await letterbox(buffer);
    const tensor = toTensor(box.data);

    const input = new (ort().Tensor)('float32', tensor, [1, 3, SIDE, SIDE]);
    const output = await session.run({ [session.inputNames[0]]: input });
    const head = output[session.outputNames[0]];

    if (head.dims[2] !== ANCHORS) {
        throw new Error(
            `censor: model emits ${head.dims[2]} anchors, expected ${ANCHORS} ` +
                `for a ${SIDE}px input. Wrong model file.`
        );
    }

    const { boxes, bestCensorable, whole } = decode(head.data, head.dims, box, options);

    return { width: box.width, height: box.height, boxes, whole, confidence: bestCensorable };
}

export const _internals = { SIDE, CONF, GENITAL_CONF, BREAST_CONF, IOU, WHOLE_TILE, ANCHORS };
