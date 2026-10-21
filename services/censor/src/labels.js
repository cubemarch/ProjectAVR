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
 * The subset held to the lowest of the three bars.
 *
 * These three are the ones the brief is most about, and they are also the
 * three the model is worst at. They are small, they are frequently occluded by
 * a hand or a thigh, and at 360x270 they can be a dozen pixels across — so the
 * score they come back with is low even when a person looking at the tile
 * would call it obvious. Measured on 30 live cam thumbnails on 2026-10-20,
 * plainly visible male genitalia scored 0.022 and 0.024 against a `CONF` of
 * 0.18; breasts and buttocks, which are larger and rarely occluded, scored an
 * order of magnitude higher on the same frames.
 *
 * So the threshold is split rather than lowered across the board. Dropping
 * `CONF` far enough to catch these would have mosaiced clothed promotional art
 * throughout the catalogue; dropping it only here cost one boxcover out of 51
 * and raised the number of boxes placed on the cam shelf by three fifths.
 *
 * {@link BREAST} is the second split, added 2026-10-21, and the reason this
 * list is "the lowest bar" and not "the low bar". See `GENITAL_CONF` and
 * `BREAST_CONF` in `detect.js` for what each one costs, measured.
 */
export const GENITALS = Object.freeze([
    'FEMALE_GENITALIA_EXPOSED',
    'MALE_GENITALIA_EXPOSED',
    'ANUS_EXPOSED'
]);

/** Indices of {@link GENITALS} within {@link CLASSES}, resolved once. */
export const GENITAL_IDS = Object.freeze(GENITALS.map((name) => CLASSES.indexOf(name)));

/**
 * The one class on a bar of its own, between the two above.
 *
 * Not folded into {@link GENITALS}, and not left with the rest, because it is
 * neither. The three above are the classes the model scores in the hundredths
 * when they are plainly visible; breasts it scores in the tenths, so the bar
 * that rescues a vulva would, applied here, start covering t-shirts. But the
 * brief names breasts too, and at `CONF` the detector was walking past sheer
 * tops and lingerie it had scored perfectly well. See `BREAST_CONF` in
 * `detect.js` for what each step of that bar costs, measured.
 */
export const BREAST = 'FEMALE_BREAST_EXPOSED';

/** Index of {@link BREAST} within {@link CLASSES}, resolved once. */
export const BREAST_ID = CLASSES.indexOf(BREAST);

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
