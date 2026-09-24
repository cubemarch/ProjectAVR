/**
 * The audio thread's half of talkback.
 *
 * Runs on the real-time audio thread, which is the reason it exists: the
 * microphone produces 128 samples at a time and the wire wants 640, and doing
 * that accumulation on the main thread would put every packet behind whatever
 * the page is rendering.
 *
 * The float-to-integer conversion happens here too, so the main thread receives
 * bytes that are ready to send and never touches a sample. Nothing here
 * allocates per quantum except the packet it is about to hand over, which is
 * transferred rather than copied.
 */

class TalkbackProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this._size = options.processorOptions?.frameSamples ?? 640;
        this._buffer = new Float32Array(this._size);
        this._filled = 0;
    }

    process(inputs) {
        const input = inputs[0]?.[0];

        // No input connected yet. Returning true keeps the node alive; false
        // would let the browser garbage-collect it mid-conversation.
        if (!input) return true;

        for (let i = 0; i < input.length; i += 1) {
            this._buffer[this._filled] = input[i];
            this._filled += 1;

            if (this._filled < this._size) continue;

            const pcm = new Int16Array(this._size);

            for (let s = 0; s < this._size; s += 1) {
                // Clamped before scaling: a sample over 1.0 - which an input
                // gain can easily produce - would otherwise wrap to full-scale
                // negative and arrive as a click.
                const sample = Math.max(-1, Math.min(1, this._buffer[s]));
                pcm[s] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            }

            this.port.postMessage(pcm, [pcm.buffer]);
            this._filled = 0;
        }

        return true;
    }
}

registerProcessor('talkback', TalkbackProcessor);
