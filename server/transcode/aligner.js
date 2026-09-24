/**
 * Keeps the two eyes together on their way into FFmpeg.
 *
 * FFmpeg is fed two raw Annex B pipes, one per eye, and `hstack` composes
 * whatever it is given. Nothing in that chain understands that the two streams
 * are a stereo pair - if the left pipe ever receives a frame the right pipe
 * does not, every subsequent frame is composed against the wrong partner and
 * stays that way for the rest of the broadcast.
 *
 * That failure is worth being careful about because of how it presents. A
 * one-frame offset between the eyes is not visible as a glitch; it reads as
 * depth, incorrectly, on anything that is moving. A viewer does not see a bug,
 * they get a headache twenty minutes in. So frames are matched by timestamp
 * here and written to the two pipes together, and an unmatched frame is
 * discarded rather than sent on alone.
 *
 * Matching by timestamp is only viable because of a decision made two layers
 * up: the phone's `AVCaptureDataOutputSynchronizer` hands both cameras' frames
 * over with the same presentation timestamp, so the values being compared are
 * identical rather than merely close.
 */

/** Timestamps should be identical; the tolerance is for rounding, not drift. */
const TOLERANCE_US = 1500;

/**
 * How far ahead one eye may get before its unmatched frames are abandoned.
 * Beyond this the partner is not late, it is missing.
 */
const MAX_SKEW_US = 250_000;

/** Hard cap per eye, so a wedged pipe cannot grow the heap without bound. */
const MAX_QUEUE = 120;

export class StereoAligner {
    /**
     * @param {object} handlers
     * @param {(left: Buffer, right: Buffer|null) => void} handlers.onPair
     *   Both eyes for one instant, or `[frame, null]` in mono.
     */
    constructor({ onPair, stereo = true } = {}) {
        this.onPair = onPair;
        this.stereo = stereo;

        /** @type {{timestamp: number, payload: Buffer, keyframe: boolean}[]} */
        this._left = [];
        /** @type {{timestamp: number, payload: Buffer, keyframe: boolean}[]} */
        this._right = [];

        this.paired = 0;
        this.unmatched = 0;
        this.overflowed = 0;
    }

    /** @param {{timestamp: number, payload: Buffer, keyframe: boolean}} unit */
    pushLeft(unit) {
        if (!this.stereo) {
            this.paired += 1;
            this.onPair(unit.payload, null);
            return;
        }

        this._push(this._left, unit);
        this._drain();
    }

    /** @param {{timestamp: number, payload: Buffer, keyframe: boolean}} unit */
    pushRight(unit) {
        if (!this.stereo) return;

        this._push(this._right, unit);
        this._drain();
    }

    _push(queue, unit) {
        queue.push(unit);

        while (queue.length > MAX_QUEUE) {
            queue.shift();
            this.overflowed += 1;
        }
    }

    /**
     * Emit every pair that can be formed, oldest first, and abandon anything
     * whose partner is now too old to arrive.
     */
    _drain() {
        while (this._left.length && this._right.length) {
            const left = this._left[0];
            const right = this._right[0];
            const skew = left.timestamp - right.timestamp;

            if (Math.abs(skew) <= TOLERANCE_US) {
                this._left.shift();
                this._right.shift();
                this.paired += 1;
                this.onPair(left.payload, right.payload);
                continue;
            }

            // The older head has no partner. Discard it and try again - the
            // next frame on that eye may well match.
            if (skew < 0) {
                this._left.shift();
            } else {
                this._right.shift();
            }

            this.unmatched += 1;
        }

        // One eye has stopped entirely. Let its partner's backlog go rather
        // than holding frames that will never be matched.
        this._expire(this._left, this._right);
        this._expire(this._right, this._left);
    }

    _expire(queue, other) {
        if (!queue.length || other.length) return;

        const newest = queue[queue.length - 1].timestamp;

        while (queue.length && newest - queue[0].timestamp > MAX_SKEW_US) {
            queue.shift();
            this.unmatched += 1;
        }
    }

    reset() {
        this._left.length = 0;
        this._right.length = 0;
    }

    summary() {
        return {
            paired: this.paired,
            unmatched: this.unmatched,
            overflowed: this.overflowed,
            pendingLeft: this._left.length,
            pendingRight: this._right.length
        };
    }
}
