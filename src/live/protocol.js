/**
 * AVR Live wire protocol.
 *
 * One framing for two hops - phone to ingest over TCP, and ingest to browser
 * over a binary WebSocket - so a frame is parsed by exactly one piece of code
 * no matter which side of the relay it is on. This module is deliberately
 * dependency-free and written against `Uint8Array`/`DataView` rather than
 * `Buffer`, because the browser monitor imports it as-is. (Node `Buffer` is a
 * `Uint8Array`, so the server side costs nothing for this.)
 *
 * Frame layout, little-endian throughout:
 *
 *      offset  size  field
 *      0       4     length      bytes following this field (= 16 + payload)
 *      4       1     type        FRAME_TYPE
 *      5       1     track       TRACK
 *      6       2     flags       FLAG bitfield
 *      8       8     timestamp   capture time, microseconds
 *      16      4     sequence    per-track counter, wraps at 2^32
 *      20      N     payload
 *
 * Length-prefixing rather than a per-frame magic number: both transports are
 * ordered and reliable, so there is nothing to resynchronise to, and a magic
 * on every frame would be 4 bytes of ceremony at 60 fps x 2 eyes. The one
 * place a magic *is* worth having is the handshake, which is why HELLO
 * carries a protocol name and version the server checks before trusting
 * anything else on the socket.
 */

/** Wire protocol version. Bumped on any incompatible framing change. */
export const PROTOCOL_VERSION = 1;

/** Identifies the protocol in the HELLO payload. */
export const PROTOCOL_NAME = 'avr-live';

export const FRAME_TYPE = {
    /** Phone -> server. JSON. Opens a broadcast and describes it. */
    HELLO: 1,
    /** Server -> phone. JSON. Accepts the broadcast, returns its id. */
    READY: 2,
    /** JSON. Decoder configuration for one track. */
    CONFIG: 3,
    /** Encoded video access unit, Annex B. */
    VIDEO: 4,
    /** Encoded audio access unit. Raw AAC-LC, no ADTS header. */
    AUDIO: 5,
    /** JSON. Periodic counters, either direction. */
    STATS: 6,
    /** JSON. Orderly shutdown. */
    BYE: 7,
    PING: 8,
    PONG: 9,
    /**
     * Server -> viewer. JSON. What this minute cost and what is left.
     *
     * Only ever travels on the relay hop, never on the contribution hop: the
     * phone neither sends nor receives it, and nothing about money is expressed
     * in the capture app. Viewers on an older build fall through the `default`
     * case and ignore it, which is the whole reason it is a new type rather
     * than a new field on an existing one.
     */
    BILLING: 10,
    /**
     * JSON. One chat message, in either direction on the relay hop.
     *
     * Viewer -> server it is `{text}` and nothing else; who said it is taken
     * from the access token on the socket rather than from the payload, because
     * a client-supplied name is a client-supplied name. Server -> viewer it is
     * the whole message: `{id, at, name, role, host, text}`.
     *
     * This is the first thing a viewer is allowed to send, and the relay's
     * parser is written on that basis - a size cap, a rate limit, and a switch
     * with one case in it.
     *
     * Never on the contribution hop. The capture app has no chat, does not
     * parse this type, and must not grow a reader for it.
     */
    CHAT: 11,
    /**
     * Server -> browser. JSON. The state of a 1:1 request on this broadcast.
     *
     * `{event, ...}` where event is `requested` (to the creator's page),
     * `accepted` / `declined` / `cancelled` / `ended` (to the viewer's). An
     * accepted event carries the admission token the viewer's page reconnects
     * with, which is why this is a frame on an already-admitted socket rather
     * than something a page could poll for.
     */
    PRIVATE: 12
};

/**
 * WebSocket close code for a viewer who has run out of credits.
 *
 * In the 4000-4999 application range, which is the only part of the space a
 * server may define, and distinct from every other reason a relay socket
 * closes so the page can say what actually happened rather than "connection
 * lost". Here rather than in the relay because both ends need the number.
 */
export const CLOSE_OUT_OF_CREDITS = 4402;

/**
 * WebSocket close code for a broadcast that has just gone private.
 *
 * The creator accepted somebody's 1:1 request, so everyone else watching is
 * disconnected. Distinct from a dropped connection because the page must not
 * reconnect: there is nothing to reconnect to until the turn ends, and a
 * reconnect loop against a private broadcast is a stranger knocking.
 */
export const CLOSE_WENT_PRIVATE = 4403;

/**
 * WebSocket close code for the end of a 1:1.
 *
 * Both people in the room get it, and neither page reconnects on its own. The
 * broadcast is public again from this moment, so an automatic reconnect would
 * be a page quietly enrolling somebody in the public rate; rejoining is a thing
 * the person does.
 */
export const CLOSE_PRIVATE_ENDED = 4404;

/**
 * Largest thing a viewer may send up the relay socket.
 *
 * A viewer's upstream vocabulary is a chat line and a packet of talkback
 * audio, so this is sized for the larger of the two plus its header - 40 ms of
 * 16 kHz mono PCM is 1280 bytes. The relay sets it on the socket itself, which
 * means an oversized message is refused by `ws` before it is a string in our
 * heap rather than after.
 */
export const MAX_UPSTREAM_BYTES = 4096;

/**
 * Talkback audio format. One format, not a negotiation.
 *
 * Linear PCM because the far end is a camera, and every codec that would save
 * bandwidth here costs a decoder on a device whose job is encoding. 16 kHz
 * mono signed 16-bit is 256 kbit/s against the several megabits already coming
 * the other way, it is intelligible speech, and the phone plays it by handing
 * the samples to the audio engine with nothing in between.
 *
 * Little-endian: every platform this runs on is, and saying so in the name
 * means a big-endian one fails loudly rather than quietly playing noise.
 */
export const TALKBACK = {
    codec: 'pcm-s16le',
    sampleRate: 16_000,
    numberOfChannels: 1,
    /** Samples per packet. 40 ms - small enough to feel live, big enough not to thrash. */
    frameSamples: 640
};

const TYPE_NAMES = Object.fromEntries(Object.entries(FRAME_TYPE).map(([k, v]) => [v, k]));

/** Human-readable frame type, for logs and errors. */
export function frameTypeName(type) {
    return TYPE_NAMES[type] ?? `UNKNOWN(${type})`;
}

export const TRACK = {
    LEFT: 0,
    RIGHT: 1,
    /** The one sound track. Mono or stereo is described by its CONFIG. */
    AUDIO: 2,
    /** A single stream with both eyes packed into one frame (side-by-side). */
    PACKED: 3,
    /**
     * Talkback: the one track that travels *up* the pipeline.
     *
     * Viewer -> server -> camera, so the person operating the camera can hear
     * whoever they are broadcasting to. It is never published to subscribers
     * and never mixed into the broadcast - it goes to the contribution socket
     * and stops there.
     *
     * Deliberately not the same track as the broadcast's own sound. They travel
     * in opposite directions, carry different formats and are configured
     * separately, and giving them one number would mean a single dropped `if`
     * could put a viewer's microphone into everybody else's speakers.
     */
    TALKBACK: 4
};

const TRACK_NAMES = { 0: 'left', 1: 'right', 2: 'audio', 3: 'packed', 4: 'talkback' };

/** Human-readable track name, used as the key in session/stat objects. */
export function trackName(track) {
    return TRACK_NAMES[track] ?? `track${track}`;
}

export const FLAG = {
    /**
     * Access unit is safe to start decoding from.
     *
     * For video that means an IDR. For audio it means every frame: an AAC-LC
     * access unit decodes independently of its neighbours, so the flag is
     * literally true on all of them. It has to be set, too — a subscriber that
     * joins mid-broadcast is held at the gate until the first keyframe on each
     * track, and an audio track that never claimed one would be silent for the
     * whole session rather than for a fraction of a second.
     */
    KEYFRAME: 1 << 0,
    /** A gap precedes this frame; the decoder should expect artefacts. */
    DISCONTINUITY: 1 << 1
};

export const HEADER_BYTES = 20;

/**
 * Largest payload we will allocate for. A 4K intra frame at a silly bitrate is
 * comfortably under this; anything larger means the stream is desynchronised
 * or hostile, and we would rather drop the connection than the heap.
 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serialise one frame.
 *
 * @param {object} frame
 * @param {number} frame.type - {@link FRAME_TYPE}
 * @param {number} [frame.track] - {@link TRACK}
 * @param {number} [frame.flags] - {@link FLAG} bitfield
 * @param {number|bigint} [frame.timestamp] - Capture time in microseconds.
 * @param {number} [frame.sequence]
 * @param {Uint8Array} [frame.payload]
 * @returns {Uint8Array}
 */
export function encodeFrame({ type, track = 0, flags = 0, timestamp = 0, sequence = 0, payload = null }) {
    const body = payload ?? new Uint8Array(0);

    if (body.length > MAX_PAYLOAD_BYTES) {
        throw new RangeError(`payload ${body.length} exceeds ${MAX_PAYLOAD_BYTES}`);
    }

    const out = new Uint8Array(HEADER_BYTES + body.length);
    const view = new DataView(out.buffer);

    view.setUint32(0, HEADER_BYTES - 4 + body.length, true);
    view.setUint8(4, type);
    view.setUint8(5, track);
    view.setUint16(6, flags, true);
    view.setBigUint64(8, BigInt(Math.trunc(Number(timestamp))), true);
    view.setUint32(16, sequence >>> 0, true);

    out.set(body, HEADER_BYTES);
    return out;
}

/**
 * Serialise a frame whose payload is JSON.
 *
 * @param {number} type - {@link FRAME_TYPE}
 * @param {object} value
 * @param {object} [opts] - Any other {@link encodeFrame} field.
 * @returns {Uint8Array}
 */
export function encodeJsonFrame(type, value, opts = {}) {
    return encodeFrame({ ...opts, type, payload: textEncoder.encode(JSON.stringify(value)) });
}

/**
 * Parse a frame's payload as JSON.
 *
 * @param {{payload: Uint8Array}} frame
 * @returns {object}
 */
export function decodeJson(frame) {
    return JSON.parse(textDecoder.decode(frame.payload));
}

/**
 * Parse exactly one frame out of a complete buffer.
 *
 * Used for WebSocket, where message boundaries are preserved by the transport
 * and every message is a whole frame. TCP goes through {@link FrameReader}
 * instead, because it has no such guarantee.
 *
 * @param {Uint8Array} bytes
 * @returns {{type: number, track: number, flags: number, timestamp: number, sequence: number, payload: Uint8Array}}
 */
export function decodeFrame(bytes) {
    if (bytes.length < HEADER_BYTES) {
        throw new RangeError(`frame is ${bytes.length} bytes, shorter than the ${HEADER_BYTES}-byte header`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(0, true);
    const payloadLength = length - (HEADER_BYTES - 4);

    if (payloadLength < 0 || HEADER_BYTES + payloadLength > bytes.length) {
        throw new RangeError(`frame declares ${length} bytes but the buffer holds ${bytes.length - 4}`);
    }

    return {
        type: view.getUint8(4),
        track: view.getUint8(5),
        flags: view.getUint16(6, true),
        timestamp: Number(view.getBigUint64(8, true)),
        sequence: view.getUint32(16, true),
        payload: bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength),
        raw: bytes
    };
}

/** True when the frame is a keyframe a decoder can start from. */
export function isKeyframe(frame) {
    return (frame.flags & FLAG.KEYFRAME) !== 0;
}

/**
 * Reassembles frames from a byte stream.
 *
 * TCP gives no message boundaries: one `data` event can carry half a frame,
 * or nine of them, and a 4K keyframe will always span several segments. This
 * buffers whatever does not yet form a complete frame and hands back the ones
 * that do.
 *
 * The buffer is compacted only when the consumed prefix grows past a
 * threshold, so a steady stream of small frames does not memmove the tail on
 * every single frame.
 */
export class FrameReader {
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxPayloadBytes] - Reject frames larger than this.
     */
    constructor({ maxPayloadBytes = MAX_PAYLOAD_BYTES } = {}) {
        this.maxPayloadBytes = maxPayloadBytes;
        this._buffer = new Uint8Array(0);
        this._offset = 0;
    }

    /** Bytes buffered but not yet formed into a complete frame. */
    get pending() {
        return this._buffer.length - this._offset;
    }

    /**
     * Append received bytes and return every frame they complete.
     *
     * @param {Uint8Array} chunk
     * @returns {Array<object>} Zero or more frames, in arrival order.
     * @throws {RangeError} If a frame declares an implausible length, which
     *   means the stream is desynchronised and cannot be recovered.
     */
    push(chunk) {
        this._append(chunk);

        const frames = [];

        for (;;) {
            const available = this._buffer.length - this._offset;
            if (available < 4) break;

            const view = new DataView(this._buffer.buffer, this._buffer.byteOffset, this._buffer.byteLength);
            const length = view.getUint32(this._offset, true);
            const payloadLength = length - (HEADER_BYTES - 4);

            if (payloadLength < 0 || payloadLength > this.maxPayloadBytes) {
                throw new RangeError(`frame declares a ${payloadLength}-byte payload; stream is desynchronised`);
            }

            const total = 4 + length;
            if (available < total) break;

            // Copy the frame out rather than handing back a view into the
            // shared buffer: the caller may hold it for as long as it takes to
            // forward it, and compaction would move it underneath.
            //
            // Exactly one copy is made. `raw` is the whole frame, ready to be
            // relayed on untouched, and `payload` is a view into it - so the
            // fan-out path never re-serialises a frame it just parsed.
            const start = this._offset;
            const raw = this._buffer.slice(start, start + total);

            frames.push({
                type: view.getUint8(start + 4),
                track: view.getUint8(start + 5),
                flags: view.getUint16(start + 6, true),
                timestamp: Number(view.getBigUint64(start + 8, true)),
                sequence: view.getUint32(start + 16, true),
                payload: raw.subarray(HEADER_BYTES),
                raw
            });

            this._offset += total;
        }

        this._compact();
        return frames;
    }

    _append(chunk) {
        if (this._offset === this._buffer.length) {
            // Nothing outstanding - adopt the chunk instead of concatenating.
            this._buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            this._offset = 0;
            return;
        }

        const tail = this._buffer.length - this._offset;
        const merged = new Uint8Array(tail + chunk.length);
        merged.set(this._buffer.subarray(this._offset), 0);
        merged.set(chunk, tail);

        this._buffer = merged;
        this._offset = 0;
    }

    _compact() {
        if (this._offset === 0) return;

        if (this._offset === this._buffer.length) {
            this._buffer = new Uint8Array(0);
            this._offset = 0;
            return;
        }

        // Only pay for the memmove once the dead prefix is worth reclaiming.
        if (this._offset > 64 * 1024) {
            this._buffer = this._buffer.slice(this._offset);
            this._offset = 0;
        }
    }

    reset() {
        this._buffer = new Uint8Array(0);
        this._offset = 0;
    }
}
