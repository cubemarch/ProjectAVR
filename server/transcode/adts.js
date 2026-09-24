/**
 * Wrap raw AAC-LC access units in ADTS headers.
 *
 * The phone sends bare access units, because that is what the browser's
 * `AudioDecoder` wants: it is configured once from an `AudioSpecificConfig` and
 * then fed naked frames. FFmpeg reading from a pipe has no such configuration
 * step — `-f aac` expects a self-describing byte stream, and ADTS is what makes
 * one. Each seven-byte header repeats the sample rate, the channel count and
 * the frame length, so the demuxer can find frame boundaries in a stream it
 * joined at an arbitrary point.
 *
 * This is deliberately a pure function over plain numbers rather than a method
 * on the pipeline. A header that is wrong by one field does not fail loudly: it
 * produces audio at half speed, or in the wrong channel count, or a stream
 * FFmpeg quietly declines to open — all of which are much easier to catch with
 * a byte-level test than with an ear against a broadcast.
 */

/**
 * Sampling frequency index table, ISO/IEC 14496-3 Table 1.18. The same table
 * the phone uses to build the `AudioSpecificConfig`, and the index has to agree
 * with it or the two descriptions of the same audio disagree.
 */
export const SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
];

/** AAC-LC. The only profile this project produces. */
const AAC_LC = 2;

export const ADTS_HEADER_BYTES = 7;

/** Largest frame length the 13-bit field can express, header included. */
const MAX_FRAME_BYTES = 0x1fff;

/**
 * @param {number} sampleRate
 * @returns {number} Index into {@link SAMPLE_RATES}, or -1.
 */
export function sampleRateIndex(sampleRate) {
    return SAMPLE_RATES.findIndex((rate) => Math.abs(rate - sampleRate) < 1);
}

/**
 * Build one ADTS header.
 *
 * @param {object} options
 * @param {number} options.payloadLength - Access unit length, header excluded.
 * @param {number} options.sampleRate
 * @param {number} options.channels - 1-7. Channel configurations above 7 are
 *   expressed by a program config element, which this does not emit.
 * @returns {Buffer|null} `null` when the parameters cannot be described, so the
 *   caller drops the frame rather than emitting a header that lies about it.
 */
export function adtsHeader({ payloadLength, sampleRate, channels }) {
    const index = sampleRateIndex(sampleRate);

    if (index < 0) return null;
    if (!Number.isInteger(channels) || channels < 1 || channels > 7) return null;
    if (!Number.isInteger(payloadLength) || payloadLength <= 0) return null;

    const frameLength = payloadLength + ADTS_HEADER_BYTES;
    if (frameLength > MAX_FRAME_BYTES) return null;

    const header = Buffer.alloc(ADTS_HEADER_BYTES);

    // Syncword, 12 bits of 1, then MPEG-4 (0), layer 00, and protection absent
    // (1) — meaning no CRC follows, which is why the header is 7 bytes and not 9.
    header[0] = 0xff;
    header[1] = 0xf1;

    // Profile is the object type minus one: AAC-LC is object type 2, profile 1.
    header[2] = ((AAC_LC - 1) << 6) | (index << 2) | ((channels >> 2) & 0x01);

    // Channel configuration's low two bits, then originality, home, copyright
    // id and start — all zero — and the top two bits of the frame length.
    header[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
    header[4] = (frameLength >> 3) & 0xff;

    // Bottom three bits of the length, then an all-ones buffer fullness, which
    // is the value meaning "variable rate, do not model the buffer".
    header[5] = ((frameLength & 0x07) << 5) | 0x1f;

    // Remaining buffer fullness bits, and 00 for one access unit in this frame.
    header[6] = 0xfc;

    return header;
}

/**
 * Header and payload as one buffer, ready to write to FFmpeg's pipe.
 *
 * @param {Buffer|Uint8Array} payload
 * @param {{sampleRate: number, channels: number}} format
 * @returns {Buffer|null}
 */
export function wrapAdts(payload, { sampleRate, channels }) {
    const header = adtsHeader({ payloadLength: payload.length, sampleRate, channels });
    if (!header) return null;

    return Buffer.concat([header, Buffer.from(payload)]);
}
