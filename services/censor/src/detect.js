import { createRequire } from 'node:module';

import { CLASSES, CENSOR_IDS } from './labels.js';

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
const CONF = 0.18;

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
 */
const WHOLE_TILE = 0.30;

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
 */
export function decode(raw, dims, { scale, padX, padY, width, height }) {
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

        // Tracked across every anchor, including ones that lose to a face or
        // a foot, because the whole-tile fallback asks "was the model sure
        // something censorable was here" and that question is not limited to
        // anchors where it also won.
        for (const id of CENSOR_IDS) {
            const score = raw[(4 + id) * anchors + a];
            if (score > bestCensorable) bestCensorable = score;
        }

        if (topScore < CONF || !CENSOR_IDS.includes(top)) continue;

        // cx, cy, w, h in letterboxed 320-space -> x, y, w, h in source space.
        const cx = raw[a];
        const cy = raw[anchors + a];
        const bw = raw[anchors * 2 + a];
        const bh = raw[anchors * 3 + a];

        out.push({
            label: CLASSES[top],
            score: topScore,
            x: (cx - bw / 2 - padX) / scale,
            y: (cy - bh / 2 - padY) / scale,
            w: bw / scale,
            h: bh / scale
        });
    }

    const boxes = clamp(nms(out), width, height);

    return {
        boxes,
        bestCensorable,

        // Decided here rather than by the caller, so there is exactly one
        // place that can answer "cover everything" and it is the same place
        // that knows why. A caller recomputing this from `bestCensorable` is
        // a caller that can get it wrong in the direction that shows skin.
        whole: boxes.length === 0 && bestCensorable >= WHOLE_TILE
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
export async function detect(buffer) {
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

    const { boxes, bestCensorable, whole } = decode(head.data, head.dims, box);

    return { width: box.width, height: box.height, boxes, whole, confidence: bestCensorable };
}

export const _internals = { SIDE, CONF, IOU, WHOLE_TILE, ANCHORS };
