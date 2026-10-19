/**
 * The camera half of the anonymous age check, shared by both age gates.
 *
 * `age-gate.js` runs it for a signed-out visitor and `auth-modal.js` for an
 * account, and they differ in almost everything — one is a full-page overlay
 * rebuilt from a template, the other a dialog class that re-renders itself —
 * but not in what a photograph for an age estimate should be. The frame size,
 * the mirroring, and what to say about each way the estimate can decline are
 * properties of the check, not of the screen it is taken on, so they live
 * here and neither copy can drift from the other.
 *
 * Nothing here uploads anything. Each surface sends its own request, because
 * the two endpoints answer to different gates and frame their errors
 * differently; what they share is the frame they send and the words they use
 * about the answer.
 */

/**
 * How large a photograph is sent.
 *
 * A face is a few hundred pixels of the frame however many the sensor has, so
 * the estimate is the same at 960px as at 4000. Downscaling in the page rather
 * than letting the provider do it means somebody on a phone uploads tens of
 * kilobytes over whatever connection they are on instead of several megabytes,
 * and it keeps the request inside the server's own ceiling without the viewer
 * ever meeting it.
 */
const SELFIE_EDGE = 960;
const SELFIE_QUALITY = 0.9;

/**
 * What to say about each way the estimate can decline.
 *
 * Written so the viewer knows whether the next move is another photograph or
 * a different method — "it did not pass" with no steer is the message that
 * makes somebody take the same photograph four times. `age_below_minimum` is
 * the one that is nobody's fault and has no retake: the floor is set above 18
 * on purpose, and the document route is what that buys.
 */
export const DECLINE_TEXT = {
    no_face_detected:
        'No face was found in the photo. Make sure your whole face is in frame and lit from the front, then take another.',
    low_liveness_score:
        'The photo was not clear enough to check. Try again in brighter, even light, looking straight at the camera.',
    age_not_detected: 'An age could not be read from the photo. Try again, a little closer and in better light.',
    more_than_one_face: 'There was more than one person in the photo. Take another with nobody else in frame.',
    liveness_face_attack:
        'That looked like a screen or a print rather than a face. The camera has to see you, not a picture of you.',
    age_below_minimum:
        'The estimate did not clearly place you over the threshold. This route only passes faces it is certain about, so being declined here is not a finding that you are under 18 — confirm with a document instead, using one of the other methods above.'
};

/** Whether this browser will let the page use a camera at all. */
export function cameraAvailable() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Why the camera did not open, in terms of what the viewer can do about it. */
export function cameraProblem(err) {
    switch (err?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'The camera was blocked. Allow it for this site in your browser, or choose one of the other methods above.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'No camera was found on this device. Choose one of the other methods above.';
        case 'NotReadableError':
            return 'The camera is in use by another app. Close it and try again, or choose one of the other methods above.';
        default:
            return 'The camera could not be started. Choose one of the other methods above.';
    }
}

/**
 * Open the front camera into a `<video>`, and hand back the stream to stop.
 *
 * The caller owns the stream from here, and owning it means stopping it: a
 * track left running is a camera light left on, which on this of all checks
 * is the difference between a photograph and surveillance.
 *
 * @param {HTMLVideoElement} video
 * @returns {Promise<MediaStream>} rejects with the `getUserMedia` error, which
 *   {@link cameraProblem} turns into something worth reading
 */
export async function openSelfieCamera(video) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false
    });

    video.srcObject = stream;

    // A refused autoplay is not fatal — the element still holds frames, and
    // the capture reads the frame rather than the playback.
    await video.play().catch(() => {});

    return stream;
}

/** Stop every track and detach, so the camera light goes out. */
export function stopSelfieCamera(stream, video) {
    stream?.getTracks().forEach((track) => track.stop());
    if (video) video.srcObject = null;
}

/**
 * One frame, downscaled, as a JPEG.
 *
 * Drawn unmirrored even though the preview is mirrored in CSS: a mirror is
 * what makes a preview feel like a mirror, and it is not what the estimate
 * should be shown.
 *
 * @returns {Promise<Blob|null>} null if the camera has not produced a frame.
 */
export function frameFrom(video) {
    const width = video?.videoWidth ?? 0;
    const height = video?.videoHeight ?? 0;

    if (!width || !height) return Promise.resolve(null);

    const scale = Math.min(1, SELFIE_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');

    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', SELFIE_QUALITY));
}

/**
 * What to tell somebody whose estimate came back a no.
 *
 * @param {{reason?: string, canRetry?: boolean}} body the route's own answer
 */
export function declineText(body) {
    return (
        DECLINE_TEXT[body?.reason] ??
        (body?.canRetry
            ? 'The check did not pass. Take another photo.'
            : 'The check did not pass. Choose one of the other methods above.')
    );
}
