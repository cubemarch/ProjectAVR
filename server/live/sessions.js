import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { FRAME_TYPE, FLAG, TRACK, trackName, encodeFrame, encodeJsonFrame } from '../../src/live/protocol.js';
import { STEREO } from '../../src/catalog/media-format.js';

/**
 * Live broadcast registry.
 *
 * A session is one phone streaming one stereo pair. It holds the decoder
 * configuration for each track, fans encoded frames out to subscribers, and
 * disappears when the phone does.
 *
 * Nothing here is persisted. A live stream is by definition the thing that is
 * happening right now, so restarting the server ending every broadcast is the
 * correct behaviour rather than a limitation - and it keeps the rest of the
 * app tier's statelessness intact, since no other node needs to know about a
 * socket that is physically attached to this one.
 *
 * Two problems get solved here, and they are the two that actually make live
 * video hard:
 *
 *   Late joiners. A browser that connects mid-broadcast has missed the
 *   parameter sets and cannot start decoding at an arbitrary frame. Each
 *   session caches the latest CONFIG per track and gates every new subscriber
 *   until that track's next keyframe, so a viewer either sees correct video
 *   or sees nothing - never a screen of green mush.
 *
 *   Slow consumers. A subscriber on a weak link cannot be allowed to grow an
 *   unbounded send queue in the server's heap. When one falls behind it is cut
 *   back to keyframes, and if it is *still* behind it is dropped entirely.
 *   Live video is the one place where discarding data beats delaying it.
 */

/** Crockford-style alphabet: no I, L, O or U, so ids can be read aloud. */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Short, unambiguous broadcast id.
 *
 * Deliberately typeable: joining from a headset often means entering it with a
 * laser pointer on a virtual keyboard.
 */
export function makeSessionId(length = 6) {
    const bytes = crypto.randomBytes(length);
    let id = '';
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    return id;
}

/**
 * Bytes a subscriber may have outstanding before we stop sending it anything
 * but keyframes. Roughly a third of a second at 20 Mbit, which is long enough
 * to ride out a Wi-Fi hiccup and short enough that recovery is not a slideshow.
 */
const BACKPRESSURE_TRIM_BYTES = 768 * 1024;

/** Outstanding bytes at which a subscriber is considered gone. */
const BACKPRESSURE_DROP_BYTES = 6 * 1024 * 1024;

/** Window over which the advertised bitrate and frame rate are averaged. */
const STATS_WINDOW_MS = 4000;

/**
 * Unsent bytes on the contribution socket at which talkback is dropped.
 *
 * A quarter of a second of talkback, and a rounding error against the video
 * coming the other way. The contribution socket's job is carrying the
 * broadcast; speech going the other way gets whatever room is left and no more.
 */
const UPLINK_BACKLOG_LIMIT = 8 * 1024;

/**
 * Rolling counter for one track.
 *
 * Keeps a coarse ring of per-second buckets rather than a list of frame
 * timestamps, so the cost is constant no matter how long the broadcast runs.
 */
class TrackStats {
    constructor() {
        this.frames = 0;
        this.bytes = 0;
        this.keyframes = 0;
        this.dropped = 0;
        this.width = 0;
        this.height = 0;
        this.codec = null;
        this.lastTimestamp = 0;

        this._buckets = [];
    }

    record(byteLength, keyframe, timestamp) {
        this.frames += 1;
        this.bytes += byteLength;
        if (keyframe) this.keyframes += 1;
        if (timestamp) this.lastTimestamp = timestamp;

        const now = Date.now();
        this._buckets.push({ at: now, bytes: byteLength });

        const cutoff = now - STATS_WINDOW_MS;
        while (this._buckets.length && this._buckets[0].at < cutoff) this._buckets.shift();
    }

    /** @returns {{fps: number, kbps: number}} Averages over the recent window. */
    rates() {
        if (this._buckets.length < 2) return { fps: 0, kbps: 0 };

        const span = (this._buckets[this._buckets.length - 1].at - this._buckets[0].at) / 1000;
        if (span <= 0) return { fps: 0, kbps: 0 };

        const bytes = this._buckets.reduce((sum, b) => sum + b.bytes, 0);

        return {
            fps: Math.round((this._buckets.length / span) * 10) / 10,
            kbps: Math.round((bytes * 8) / span / 1000)
        };
    }

    summary() {
        return {
            frames: this.frames,
            bytes: this.bytes,
            keyframes: this.keyframes,
            dropped: this.dropped,
            width: this.width,
            height: this.height,
            codec: this.codec,
            ...this.rates()
        };
    }
}

/**
 * One subscriber's view of a session.
 *
 * Wraps whatever sink the transport provides - a WebSocket in production, a
 * plain object in tests - and owns the per-subscriber resync state.
 */
class Subscriber {
    /**
     * @param {{send: Function, close: Function, bufferedAmount?: number}} sink
     */
    constructor(sink) {
        this.sink = sink;
        this.id = crypto.randomUUID();
        this.joinedAt = Date.now();
        this.bytesSent = 0;
        this.framesSent = 0;
        this.framesDropped = 0;

        /**
         * Tracks this subscriber has seen a keyframe on. Until a track appears
         * here, its inter frames are useless to the decoder and are discarded.
         * @type {Set<number>}
         */
        this.synced = new Set();

        /** True once we have trimmed to keyframes and are waiting to recover. */
        this.throttled = false;
    }

    get bufferedAmount() {
        return this.sink.bufferedAmount ?? 0;
    }

    send(bytes) {
        this.sink.send(bytes);
        this.bytesSent += bytes.length;
        this.framesSent += 1;
    }

    close(code, reason) {
        try {
            this.sink.close(code, reason);
        } catch {
            /* already gone */
        }
    }

    summary() {
        return {
            id: this.id,
            joinedAt: this.joinedAt,
            bytesSent: this.bytesSent,
            framesSent: this.framesSent,
            framesDropped: this.framesDropped,
            buffered: this.bufferedAmount,
            throttled: this.throttled
        };
    }
}

/**
 * A single live broadcast.
 *
 * @fires LiveSession#closed
 * @fires LiveSession#subscribers
 */
export class LiveSession extends EventEmitter {
    /**
     * @param {object} meta - Validated HELLO payload.
     */
    constructor(meta) {
        super();

        this.id = makeSessionId();
        this.startedAt = Date.now();
        this.closedAt = null;
        this.closeReason = null;

        this.name = meta.name || 'Untitled broadcast';
        this.device = meta.device || 'unknown device';
        this.mode = meta.mode || 'separate';
        this.projection = meta.projection || 'flat';
        this.stereo = meta.stereo || 'mono';
        this.fisheyeFov = meta.fisheyeFov ?? null;
        this.lens = meta.lens ?? null;

        /**
         * The verified creator this broadcast belongs to, or null when the
         * deployment is still pairing with the shared stream key - which
         * identifies a device, not a person.
         *
         * Not in `describe()`: a viewer has no business knowing an account id.
         */
        this.creatorId = meta.userId ?? null;

        /**
         * The grant this broadcast was authorised with, or null on the shared
         * stream key.
         *
         * Carried so the room registry can tell which broadcast belongs to which
         * admitted viewer without the ingest path having to know rooms exist. A
         * grant is single-use, so this is a one-to-one handle on the thing the
         * creator was looking at in the browser when they chose who to let in.
         *
         * Not in `describe()` either. It is a credential identifier, and the
         * only reason it is here is that the server needs to join two of its own
         * tables on it.
         */
        this.grantId = meta.grantId ?? null;

        /** Interaxial distance in millimetres, for depth-correct rendering. */
        this.baselineMm = meta.baselineMm ?? null;
        /** Horizontal field of view of one eye, degrees. */
        this.hfovDeg = meta.hfovDeg ?? null;

        /** @type {Map<number, object>} track -> latest CONFIG payload, parsed. */
        this.configs = new Map();
        /** @type {Map<number, Uint8Array>} track -> the CONFIG frame, ready to send. */
        this._configFrames = new Map();
        /** @type {Map<number, TrackStats>} */
        this.stats = new Map();

        /** @type {Set<Subscriber>} */
        this.subscribers = new Set();

        /**
         * The way back to the camera, when the contribution hop offers one.
         *
         * Everything else on a session travels outwards. This is the single
         * exception: talkback, so the person holding the camera can hear the
         * person they are broadcasting to. Set by the ingest handler, which is
         * the only place that has the phone's socket, and cleared when it goes.
         *
         * @type {{write: (bytes: Uint8Array) => void, backlog: number}|null}
         */
        this._uplink = null;
    }

    get live() {
        return this.closedAt === null;
    }

    /**
     * Is there a camera on the other end that can be spoken to?
     *
     * Every deployment has broadcasts that cannot be: an HLS-only path, a
     * session whose socket has gone quiet. The page asks before offering a
     * microphone button that would do nothing.
     */
    get talkbackAvailable() {
        return this._uplink !== null;
    }

    /** @param {{write: Function, backlog: number}|null} sink */
    setUplink(sink) {
        this._uplink = sink;
    }

    /**
     * Send one frame up to the camera.
     *
     * Dropped rather than queued when the contribution socket is already
     * backing up. Talkback is speech: a packet delivered two seconds late is
     * worse than one never delivered, and a growing queue on the one socket
     * carrying the broadcast would cost the picture to save a syllable.
     *
     * @param {Uint8Array} bytes - An already-encoded frame.
     * @returns {boolean} Whether it went.
     */
    sendUpstream(bytes) {
        if (!this._uplink || !this.live) return false;
        if (this._uplink.backlog > UPLINK_BACKLOG_LIMIT) return false;

        try {
            this._uplink.write(bytes);
            return true;
        } catch {
            // The socket is going; the ingest handler will clear the uplink.
            return false;
        }
    }

    /** Which tracks have produced at least one frame. */
    get tracks() {
        return [...this.stats.keys()].sort((a, b) => a - b);
    }

    /**
     * Are two eyes actually arriving?
     *
     * Asked by the 3D setup check, and the reason it is measured rather than
     * read off `this.stereo` is that `stereo` is whatever the phone said in its
     * HELLO. A rig whose second camera never started sends `stereo: 'sbs'` and
     * one eye, which is precisely the failure the check exists to catch - so
     * the answer here is frames received, not intent announced.
     *
     * Configuration alone is not enough either: a track can be described and
     * then never produce a picture. Both eyes have to have delivered something.
     */
    get carryingStereo() {
        const arriving = (track) => this.configs.has(track) && (this.stats.get(track)?.frames ?? 0) > 0;

        // Packed is one track carrying both eyes, so the pair cannot be
        // confirmed from the track table - only from what the phone says the
        // packing is.
        if (arriving(TRACK.PACKED)) return this.stereo !== STEREO.MONO;

        return arriving(TRACK.LEFT) && arriving(TRACK.RIGHT);
    }

    _statsFor(track) {
        let stats = this.stats.get(track);
        if (!stats) {
            stats = new TrackStats();
            this.stats.set(track, stats);
        }
        return stats;
    }

    /**
     * Record a track's decoder configuration and forward it to everyone
     * already watching.
     *
     * @param {number} track - {@link TRACK}
     * @param {object} config - `{codec, codedWidth, codedHeight, ...}`
     */
    setConfig(track, config) {
        this.configs.set(track, config);

        const frame = encodeJsonFrame(FRAME_TYPE.CONFIG, config, { track });
        this._configFrames.set(track, frame);

        const stats = this._statsFor(track);
        stats.codec = config.codec ?? stats.codec;
        stats.width = config.codedWidth ?? stats.width;
        stats.height = config.codedHeight ?? stats.height;

        // A changed config invalidates every subscriber's decoder, so they all
        // need the new one and then a fresh keyframe before anything decodes.
        for (const sub of this.subscribers) {
            sub.synced.delete(track);
            this._deliver(sub, frame);
        }
    }

    /**
     * Fan one encoded access unit out to every subscriber.
     *
     * Both gates below — the late-joiner sync gate and the keyframes-only trim
     * — are written for video, where most access units depend on an earlier
     * one. Audio has no such dependency: every AAC-LC access unit decodes on
     * its own, the phone flags them all {@link FLAG.KEYFRAME} accordingly, and
     * so sound passes straight through both. That is deliberate. A silent
     * broadcast is not a degraded broadcast, it is a broken one, and audio is
     * around 1% of the bytes — trimming it would save nothing and cost
     * everything.
     *
     * @param {object} frame - Decoded wire frame from the ingest socket.
     * @param {Uint8Array} raw - The same frame still serialised, so the common
     *   path forwards bytes without re-encoding them once per subscriber.
     */
    publish(frame, raw) {
        const keyframe = (frame.flags & FLAG.KEYFRAME) !== 0;
        this._statsFor(frame.track).record(frame.payload.length, keyframe, frame.timestamp);

        for (const sub of this.subscribers) {
            // A subscriber that has not yet seen a keyframe on this track
            // cannot decode anything else, so there is no point sending it.
            if (!sub.synced.has(frame.track)) {
                if (!keyframe) {
                    sub.framesDropped += 1;
                    continue;
                }
                sub.synced.add(frame.track);
            }

            const buffered = sub.bufferedAmount;

            if (buffered > BACKPRESSURE_DROP_BYTES) {
                this._removeSubscriber(sub, 1013, 'too far behind');
                continue;
            }

            if (buffered > BACKPRESSURE_TRIM_BYTES && !keyframe) {
                // Keep the connection but let it catch up on keyframes alone.
                // The next keyframe re-establishes a clean picture.
                sub.throttled = true;
                sub.framesDropped += 1;
                this._statsFor(frame.track).dropped += 1;
                continue;
            }

            if (keyframe) sub.throttled = false;

            this._deliver(sub, raw);
        }
    }

    _deliver(sub, bytes) {
        try {
            sub.send(bytes);
        } catch {
            this._removeSubscriber(sub, 1011, 'send failed');
        }
    }

    /**
     * Attach a viewer.
     *
     * Immediately replays the cached CONFIG for every known track; video
     * follows from that track's next keyframe.
     *
     * @param {{send: Function, close: Function, bufferedAmount?: number}} sink
     * @returns {Subscriber}
     */
    addSubscriber(sink) {
        const sub = new Subscriber(sink);
        this.subscribers.add(sub);

        this._deliver(sub, encodeJsonFrame(FRAME_TYPE.READY, this.describe(), { track: 0 }));

        for (const frame of this._configFrames.values()) this._deliver(sub, frame);

        this.emit('subscribers', this.subscribers.size);
        return sub;
    }

    /** @param {Subscriber} sub */
    removeSubscriber(sub) {
        this._removeSubscriber(sub, 1000, 'left');
    }

    _removeSubscriber(sub, code, reason) {
        if (!this.subscribers.delete(sub)) return;
        sub.close(code, reason);
        this.emit('subscribers', this.subscribers.size);
    }

    /**
     * Disconnect everyone watching, without ending the broadcast.
     *
     * The camera keeps rolling and the session keeps its id, configs and
     * stats - what changes is who is allowed to be attached to it. This is how
     * a broadcast goes private mid-shot: admission is re-decided at the next
     * upgrade, so the way to re-decide it for everyone already in is to make
     * them all knock again.
     *
     * @param {number} code - A close code the page can act on.
     * @param {string} reason
     * @returns {number} how many were disconnected.
     */
    evictSubscribers(code, reason) {
        const going = [...this.subscribers];
        for (const sub of going) this._removeSubscriber(sub, code, reason);
        return going.length;
    }

    /**
     * End the broadcast and disconnect everyone watching.
     *
     * @param {string} reason
     */
    close(reason = 'ended') {
        if (this.closedAt) return;

        this.closedAt = Date.now();
        this.closeReason = reason;

        const bye = encodeJsonFrame(FRAME_TYPE.BYE, { sessionId: this.id, reason });
        for (const sub of [...this.subscribers]) {
            this._deliver(sub, bye);
            this._removeSubscriber(sub, 1000, reason);
        }

        this.emit('closed', this);
    }

    /** Metadata a viewer needs before the first frame arrives. */
    describe() {
        return {
            sessionId: this.id,
            name: this.name,
            device: this.device,
            mode: this.mode,
            projection: this.projection,
            stereo: this.stereo,
            fisheyeFov: this.fisheyeFov,
            lens: this.lens,
            baselineMm: this.baselineMm,
            hfovDeg: this.hfovDeg,
            startedAt: this.startedAt,
            live: this.live,
            // Whether there is a camera at the other end that could hear a
            // viewer, so a page does not offer a microphone that goes nowhere.
            talkback: this.talkbackAvailable,
            tracks: Object.fromEntries(
                [...this.configs.entries()].map(([track, config]) => [trackName(track), config])
            )
        };
    }

    /** Everything the monitor UI and `/api/live/sessions` report. */
    summary() {
        return {
            ...this.describe(),
            uptimeSeconds: Math.round(((this.closedAt ?? Date.now()) - this.startedAt) / 1000),
            viewers: this.subscribers.size,
            stats: Object.fromEntries([...this.stats.entries()].map(([t, s]) => [trackName(t), s.summary()]))
        };
    }
}

/**
 * Process-wide set of active broadcasts.
 *
 * Scoped to one node on purpose: a session is bound to an open TCP socket on
 * this machine, so there is nothing meaningful to share with a sibling node.
 * Multi-node live would need the relay addressed separately from the API,
 * which is a different design rather than a bigger map.
 */
export class SessionRegistry extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, LiveSession>} */
        this._sessions = new Map();
    }

    /**
     * @param {object} meta - Validated HELLO payload.
     * @returns {LiveSession}
     */
    create(meta) {
        let session = new LiveSession(meta);

        // Vanishingly unlikely with 32^6 ids, but a collision would hand one
        // broadcaster another's viewers, so it is worth the two lines.
        while (this._sessions.has(session.id)) session = new LiveSession(meta);

        this._sessions.set(session.id, session);

        session.once('closed', () => {
            this._sessions.delete(session.id);
            this.emit('ended', session);
        });

        this.emit('started', session);
        return session;
    }

    /** @returns {LiveSession|undefined} */
    get(id) {
        return this._sessions.get(String(id || '').toUpperCase());
    }

    /** @returns {LiveSession[]} Newest first. */
    list() {
        return [...this._sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
    }

    get size() {
        return this._sessions.size;
    }

    closeAll(reason = 'server shutting down') {
        for (const session of [...this._sessions.values()]) session.close(reason);
    }
}

/** The registry the ingest server and the relay both talk to. */
export const sessions = new SessionRegistry();

export { TRACK, FRAME_TYPE, FLAG, encodeFrame };
