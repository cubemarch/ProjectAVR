/**
 * The detector's class list, and which of those classes get covered.
 *
 * ## The order of this array is load-bearing and is not ours
 *
 * The model emits a score per class as a bare array of numbers. Nothing in the
 * file says which number is which part — the mapping is positional, and it is
 * the order the model was *trained* in. This array is a transcription of that
 * order for NudeNet v3's `320n.onnx`.
 *
 * Get it wrong by one and the service still runs, still returns boxes, still
 * looks correct in every test that does not have a human looking at the
 * output — and covers faces while leaving genitals on screen. There is no
 * error path for this. It is the reason `assertLabelOrder` exists and the
 * reason the server refuses to start without it.
 *
 * If you swap the model, re-read the order off the model card and re-run the
 * fixture. Do not assume a fork kept it.
 */
export const CLASSES = Object.freeze([
    'FEMALE_GENITALIA_COVERED',
    'FACE_FEMALE',
    'BUTTOCKS_EXPOSED',
    'FEMALE_BREAST_EXPOSED',
    'FEMALE_GENITALIA_EXPOSED',
    'MALE_BREAST_EXPOSED',
    'ANUS_EXPOSED',
    'FEET_EXPOSED',
    'BELLY_COVERED',
    'FEET_COVERED',
    'ARMPITS_COVERED',
    'ARMPITS_EXPOSED',
    'FACE_MALE',
    'BELLY_EXPOSED',
    'MALE_GENITALIA_EXPOSED',
    'ANUS_COVERED',
    'FEMALE_BREAST_COVERED',
    'BUTTOCKS_COVERED'
]);

/**
 * What gets covered.
 *
 * The brief was genitalia, breasts and anuses. `BUTTOCKS_EXPOSED` is in by
 * judgement rather than by instruction: a thumbnail is 360x270 and a rear view
 * at that size is frequently the same pixels as `ANUS_EXPOSED` with the
 * detector unsure which it is seeing. Covering only one of the two means the
 * disagreement decides whether a visitor sees it.
 *
 * `MALE_BREAST_EXPOSED` is deliberately **out**. A bare male chest is not what
 * any of this is for and covering it would mosaic half the couples on the row.
 *
 * Nothing `_COVERED` is here, by definition — the model is telling us it is
 * already clothed.
 */
export const CENSOR = Object.freeze([
    'FEMALE_GENITALIA_EXPOSED',
    'MALE_GENITALIA_EXPOSED',
    'FEMALE_BREAST_EXPOSED',
    'ANUS_EXPOSED',
    'BUTTOCKS_EXPOSED'
]);

/** Indices of {@link CENSOR} within {@link CLASSES}, resolved once. */
export const CENSOR_IDS = Object.freeze(CENSOR.map((name) => CLASSES.indexOf(name)));

/**
 * Refuse to start if the transcription above has drifted from the model.
 *
 * Called at boot with the output of a single inference over a committed
 * fixture whose contents are known. It is the only thing standing between a
 * one-line reordering and a service that silently stops working while
 * reporting success — see the warning at the head of this file.
 *
 * Deliberately a hard throw rather than a warning. A censor that is not
 * covering anything should not be serving.
 */
export function assertLabelOrder(detections, expected) {
    if (CENSOR_IDS.some((id) => id < 0)) {
        throw new Error(
            `censor: CENSOR names not present in CLASSES: ` +
                CENSOR.filter((n) => !CLASSES.includes(n)).join(', ')
        );
    }

    const found = new Set(detections.map((d) => d.label));
    const missing = expected.filter((label) => !found.has(label));

    if (missing.length) {
        throw new Error(
            `censor: label self-test failed. The fixture should detect ` +
                `[${expected.join(', ')}] but the model reported ` +
                `[${[...found].join(', ') || 'nothing'}]. The class order in ` +
                `labels.js probably does not match the model file. Refusing to ` +
                `start: a miscalibrated censor covers faces and shows genitals.`
        );
    }
}
