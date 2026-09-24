import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

import {
    FrameReader,
    FRAME_TYPE,
    TRACK,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    frameTypeName,
    decodeJson,
    encodeJsonFrame
} from '../../src/live/protocol.js';
import { PROJECTION, STEREO } from '../../src/catalog/media-format.js';
import { sessions } from './sessions.js';
import { redeemBroadcastGrant } from '../identity/broadcast.js';
import { identityEnforced } from '../identity/providers.js';
import { tlsMaterial } from './tls.js';

/**
 * Ingest server: the socket the phone pushes into.
 *
 * Raw TCP rather than WebSocket or RTMP. The phone and the server are on the
 * same Wi-Fi, so there is no proxy to traverse and nothing to gain from an
 * HTTP upgrade - and the frames are already length-prefixed, which is the only
 * thing WebSocket would have added. What that buys is a very short path from
 * `VTCompressionSession`'s output callback to `socket.write`, which is the
 * whole game for glass-to-glass latency.
 *
 * RTMP was the other candidate and is the wrong tool here: it is single-track
 * by design, so carrying two eyes means either two independent connections
 * that can drift apart or packing both eyes into one frame before they are
 * encoded. This protocol keeps the eyes as sibling tracks on one socket, which
 * is what makes them stay in sync.
 */

/** Drop a connection that has not identified itself. */
const HELLO_TIMEOUT_MS = 10_000;

/** Drop a broadcast that has gone quiet - the phone slept, or Wi-Fi died. */
const IDLE_TIMEOUT_MS = 15_000;

/**
 * Concurrent broadcasts allowed. Each one pins a hardware decode path in every
 * viewer's browser, so this is a small number by nature rather than a limit
 * worth raising.
 */
const MAX_SESSIONS = Number(process.env.AVR_LIVE_MAX_SESSIONS || 8);

const VALID_PROJECTIONS = new Set(Object.values(PROJECTION));
const VALID_STEREO = new Set(Object.values(STEREO));
const VALID_MODES = new Set(['separate', 'packed', 'mono']);

/**
 * The shared secret the phone presents in HELLO.
 *
 * Generated per run when unset so a fresh checkout is usable immediately
 * without being open to anything that can reach the port. It is printed at
 * startup for pairing, the same way the DLNA library announces itself - set
 * `AVR_LIVE_KEY` to pin it across restarts so the phone does not need
 * re-pairing every time the server reloads.
 */
let streamKey = process.env.AVR_LIVE_KEY || null;

export function getStreamKey() {
    if (!streamKey) streamKey = crypto.randomBytes(8).toString('hex');
    return streamKey;
}

export function isStreamKeyPinned() {
    return Boolean(process.env.AVR_LIVE_KEY);
}

/**
 * Print the broadcaster's capture-graph diagnostics, and call out the ways it
 * can be live and still wrong.
 *
 * Optional throughout: older builds of the app do not send it, and a missing
 * block is not worth a warning.
 */
function logCaptureDiagnostics(sessionId, capture) {
    if (!capture || typeof capture !== 'object') return;

    const pick = (key) => (capture[key] === undefined ? '?' : capture[key]);

    console.log(
        `[live] ${sessionId} capture: multiCam=${pick('multiCamSupported')} ` +
            `stereoRequested=${pick('stereoRequested')} ` +
            `wide=${pick('wideFormat')} ultra=${pick('ultraWideFormat')} ` +
            `cost=${pick('hardwareCost')} connections=${pick('connections')} ` +
            `ultraConnected=${pick('ultraWideConnected')} ` +
            `buffers=${pick('wideBuffers')}/${pick('ultraWideBuffers')} (wide/ultra) ` +
            `pairs=${pick('pairsEmitted')} mono=${pick('monoFallbacks')} ` +
            `closestSkew=${pick('closestSkewMs')}ms ` +
            `preview=${pick('previewConnected')} ` +
            `matchLenses=${pick('matchLenses')} trim=${pick('lensTrimStops')}st ` +
            `shortfall=${pick('lensShortfallStops')}st leftPulledDown=${pick('lensWideBiasStops')}st`
    );

    if (Number(capture.lensShortfallStops) > 0.33) {
        console.warn(
            `[live] ${sessionId} the eyes are ${capture.lensShortfallStops} stops apart - ` +
                `the ultra-wide cannot be raised any further`
        );
    }

    if (capture.stereoRequested && capture.wideBuffers > 0 && capture.ultraWideBuffers === 0) {
        console.warn(
            `[live] ${sessionId} the ultra-wide camera has never delivered a buffer - ` +
                `it is not producing frames, rather than producing unpairable ones`
        );
    } else if (capture.stereoRequested && capture.ultraWideBuffers > 0 && capture.pairsEmitted === 0) {
        console.warn(
            `[live] ${sessionId} both cameras are delivering but nothing pairs - ` +
                `their clocks are ${capture.closestSkewMs}ms apart at best`
        );
    }

    if (capture.runtimeError) {
        console.warn(`[live] ${sessionId} capture runtime error: ${capture.runtimeError}`);
    }
    if (capture.stereoRequested && capture.ultraWideConnected === false) {
        console.warn(
            `[live] ${sessionId} stereo requested but the ultra-wide is not connected - ` +
                `both eyes will be the wide camera`
        );
    }
    if (capture.previewConnected === false) {
        console.warn(
            `[live] ${sessionId} the phone's viewfinder is not connected - ` +
                `the operator is framing this shot blind`
        );
    }
    if (Number(capture.hardwareCost) > 1) {
        console.warn(
            `[live] ${sessionId} multi-cam hardware cost ${capture.hardwareCost} is over budget - ` +
                `the system will throttle or drop a camera`
        );
    }
}

/** Constant-time compare, so the key cannot be recovered a byte at a time. */
function keyMatches(presented) {
    const expected = Buffer.from(getStreamKey());
    const actual = Buffer.from(String(presented ?? ''));

    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // length; hash both sides to a fixed width first.
    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(actual).digest();

    return crypto.timingSafeEqual(a, b);
}

/**
 * Decide whether the key in a HELLO may put something on air, and whose it is.
 *
 * Two credentials are accepted, and which ones depends on `AVR_IDENTITY_ENFORCE`:
 *
 *   - A **broadcast grant**: per-creator, issued in the browser behind a face
 *     check, good for one broadcast and a few minutes. Attributes the session to
 *     a real account.
 *   - The shared **server key** (`AVR_LIVE_KEY`): identifies nobody. Every phone
 *     presents the same secret, so a session cannot be attributed, and revoking
 *     one device means re-pairing all of them.
 *
 * The shared key is the default because a fresh checkout has no accounts and no
 * verification provider, and a pairing flow that cannot work out of the box is
 * a pairing flow nobody sets up. Enforcement turns it off.
 *
 * @param {unknown} presented
 * @returns {{ok: true, userId: string|null, grantId: string|null}|{ok: false, error: string, code: string}}
 */
function authoriseBroadcaster(presented) {
    const enforced = identityEnforced();

    // Shared key first when it is still allowed: it is a hash comparison, where
    // the creator-key path is a database read, and a creator key is never also a
    // valid shared key.
    if (!enforced && keyMatches(presented)) return { ok: true, userId: null, grantId: null };

    // The grant's id travels with the session as well as the account's, so a
    // live broadcast can be traced back to the exact face check that authorised
    // it rather than only to the creator who eventually holds several.
    const creator = redeemBroadcastGrant(presented);
    if (creator) return { ok: true, userId: creator.userId, grantId: creator.grantId };

    return {
        ok: false,
        // The code, not the prose, is what the phone acts on. This rejection is
        // *terminal*: a key that is wrong or revoked will be wrong or revoked on
        // every retry, and the six-attempt backoff ladder would otherwise become
        // a minute of the operator watching a progress spinner that was never
        // going to resolve. One code for both cases, so the phone does not have
        // to match on prose that says different things depending on enforcement.
        code: 'credential_rejected',
        error: enforced ? 'a broadcast grant is required - scan a destination link from the browser first' : 'bad stream key'
    };
}

/**
 * Normalise and bounds-check a HELLO payload.
 *
 * Everything here ends up in the catalog and in front of a shader, so an
 * unchecked `projection` would be a string the renderer has no geometry for.
 *
 * A rejection may carry a `code`. Its only job is to tell the broadcaster
 * whether trying again could ever work: a wrong credential or a protocol the
 * server does not speak will be just as wrong in four seconds, so those are
 * marked terminal and everything else is left for the client's usual backoff.
 *
 * @param {object} hello
 * @returns {{ok: true, meta: object}|{ok: false, error: string, code?: string}}
 */
export function validateHello(hello) {
    if (!hello || typeof hello !== 'object') return { ok: false, error: 'malformed hello' };

    if (hello.protocol !== PROTOCOL_NAME) {
        return {
            ok: false,
            code: 'protocol_rejected',
            error: `unrecognised protocol ${JSON.stringify(hello.protocol)}`
        };
    }

    if (hello.version !== PROTOCOL_VERSION) {
        return {
            ok: false,
            code: 'protocol_rejected',
            error: `protocol version ${hello.version} is not ${PROTOCOL_VERSION}`
        };
    }

    const authorised = authoriseBroadcaster(hello.key);
    if (!authorised.ok) return authorised;

    const projection = String(hello.projection ?? PROJECTION.FLAT);
    const stereo = String(hello.stereo ?? STEREO.MONO);
    const mode = String(hello.mode ?? 'separate');

    if (!VALID_PROJECTIONS.has(projection)) return { ok: false, error: `unknown projection ${projection}` };
    if (!VALID_STEREO.has(stereo)) return { ok: false, error: `unknown stereo layout ${stereo}` };
    if (!VALID_MODES.has(mode)) return { ok: false, error: `unknown mode ${mode}` };

    const finiteOrNull = (value, min, max) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };

    return {
        ok: true,
        meta: {
            userId: authorised.userId,
            grantId: authorised.grantId ?? null,
            name: String(hello.name ?? 'Untitled broadcast').slice(0, 120),
            device: String(hello.device ?? 'unknown device').slice(0, 120),
            mode,
            projection,
            stereo,
            fisheyeFov: finiteOrNull(hello.fisheyeFov, 90, 360),
            lens: hello.lens ? String(hello.lens).slice(0, 32) : null,
            baselineMm: finiteOrNull(hello.baselineMm, 0, 500),
            hfovDeg: finiteOrNull(hello.hfovDeg, 1, 360)
        }
    };
}

/**
 * TCP listener that turns connections into {@link LiveSession}s.
 */
export class IngestServer {
    /**
     * @param {object} [opts]
     * @param {number} [opts.port]
     * @param {string} [opts.host] - Omit for dual-stack. `0.0.0.0` binds IPv4
     *   only, which on a network that hands out real IPv6 addresses means a
     *   phone resolving this host over IPv6 gets an immediate connection
     *   refusal - indistinguishable, from the app, from the server being down.
     * @param {import('./sessions.js').SessionRegistry} [opts.registry]
     */
    constructor({ port = Number(process.env.AVR_LIVE_PORT || 8081), host = undefined, registry = sessions } = {}) {
        this.port = port;
        this.host = host;
        this.registry = registry;
        this.server = null;
    }

    start() {
        const material = tlsMaterial();

        if (material) {
            // `tls.Server` is a `net.Server` with the handshake in front, so
            // `_handle` is unchanged - a `TLSSocket` is a duplex stream with the
            // same interface. Client certificates are not requested: the phone
            // authenticates with its grant in HELLO, and asking for one would
            // mean issuing and distributing them.
            this.server = tls.createServer(
                { cert: material.cert, key: material.key, minVersion: 'TLSv1.2' },
                (socket) => this._handle(socket)
            );

            this.server.on('tlsClientError', (err) => {
                // Ordinary on a public port: scanners, and phones pinned to a
                // certificate this server has since replaced. Worth a line
                // because the second case looks like "it just stopped working".
                console.warn(`[live] TLS handshake failed: ${err.message}`);
            });

            console.log(`[live] ingest TLS enabled, pin sha256/${material.pin}`);
        } else {
            this.server = net.createServer((socket) => this._handle(socket));
        }

        this.server.on('error', (err) => {
            console.error(`[live] ingest listener failed: ${err.message}`);
        });

        // With no host, Node binds the unspecified address dual-stack, so the
        // same listener answers 192.168.1.x and the Bonjour name that resolves
        // to IPv6. Tests pass 127.0.0.1 explicitly.
        if (this.host) this.server.listen(this.port, this.host);
        else this.server.listen(this.port);

        return this.server;
    }

    stop() {
        this.server?.close();
        this.server = null;
    }

    /**
     * @param {net.Socket} socket
     */
    _handle(socket) {
        const peer = `${socket.remoteAddress}:${socket.remotePort}`;

        // Nagle batches small writes, which is exactly wrong for a stream of
        // frames that each need to leave immediately.
        socket.setNoDelay(true);

        const reader = new FrameReader();

        /** @type {import('./sessions.js').LiveSession|null} */
        let session = null;
        let closed = false;

        /**
         * @param {string} reason
         * @param {string} [code] Present when trying again cannot help. See
         *   `validateHello`; the broadcaster stops rather than backing off.
         */
        const fail = (reason, code) => {
            if (closed) return;
            console.warn(`[live] ${peer} rejected: ${reason}`);
            try {
                // `reason` as well as `error`, because a BYE from the relay to a
                // viewer already uses `reason` and one frame type reading two
                // different keys depending on who sent it is how a client ends
                // up showing "the server ended the session" over a perfectly
                // good explanation.
                socket.end(encodeJsonFrame(FRAME_TYPE.BYE, { error: reason, reason, code }));
            } catch {
                /* socket already gone */
            }
            socket.destroy();
        };

        const done = (reason) => {
            if (closed) return;
            closed = true;
            clearTimeout(helloTimer);
            clearInterval(idleTimer);

            if (session) {
                console.log(`[live] ${session.id} "${session.name}" ended (${reason})`);
                session.close(reason);
            }
            socket.destroy();
        };

        const helloTimer = setTimeout(() => {
            if (!session) fail('no hello within the handshake window');
        }, HELLO_TIMEOUT_MS);

        let lastFrameAt = Date.now();
        const idleTimer = setInterval(() => {
            if (session && Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) done('broadcaster went quiet');
        }, 5000);

        socket.on('data', (chunk) => {
            lastFrameAt = Date.now();

            let frames;
            try {
                frames = reader.push(chunk);
            } catch (err) {
                fail(err.message);
                return;
            }

            for (const frame of frames) {
                if (closed) return;

                if (!session) {
                    if (frame.type !== FRAME_TYPE.HELLO) {
                        fail(`expected HELLO, got ${frameTypeName(frame.type)}`);
                        return;
                    }

                    let hello;
                    try {
                        hello = decodeJson(frame);
                    } catch {
                        fail('hello payload is not valid json');
                        return;
                    }

                    const check = validateHello(hello);
                    if (!check.ok) {
                        fail(check.error, check.code);
                        return;
                    }

                    if (this.registry.size >= MAX_SESSIONS) {
                        fail(`server already carrying ${MAX_SESSIONS} broadcasts`);
                        return;
                    }

                    clearTimeout(helloTimer);
                    session = this.registry.create(check.meta);

                    // The way back to the camera. This handler is the only
                    // place that has the phone's socket, and talkback is the
                    // only thing that ever travels along it in this direction -
                    // so the session is given a way to write to it rather than
                    // the socket itself, and cannot be made to do anything else
                    // with it.
                    session.setUplink({
                        write: (bytes) => socket.write(bytes),
                        get backlog() {
                            return socket.writableLength;
                        }
                    });
                    session.once('closed', () => session.setUplink(null));

                    console.log(
                        `[live] ${session.id} "${session.name}" started from ${peer} ` +
                            `(${session.mode}, ${session.projection}/${session.stereo}` +
                            `${session.creatorId ? `, creator ${session.creatorId}` : ', unattributed'})`
                    );

                    // The capture graph as the phone actually built it. Logged
                    // rather than stored: a stereo session that comes up with
                    // one camera is invisible everywhere else, and reading it
                    // here beats attaching the device to Xcode.
                    logCaptureDiagnostics(session.id, hello.capture);

                    socket.write(encodeJsonFrame(FRAME_TYPE.READY, session.describe()));
                    continue;
                }

                this._route(session, frame, socket);
            }
        });

        socket.on('error', (err) => done(`socket error: ${err.message}`));
        socket.on('close', () => done('broadcaster disconnected'));
    }

    /**
     * Dispatch one post-handshake frame.
     *
     * @param {import('./sessions.js').LiveSession} session
     * @param {object} frame
     * @param {net.Socket} socket
     */
    _route(session, frame, socket) {
        switch (frame.type) {
            case FRAME_TYPE.CONFIG: {
                let config;
                try {
                    config = decodeJson(frame);
                } catch {
                    return;
                }
                session.setConfig(frame.track, config);
                break;
            }

            case FRAME_TYPE.VIDEO:
            case FRAME_TYPE.AUDIO:
                session.publish(frame, frame.raw);
                break;

            case FRAME_TYPE.PING:
                // Echo the payload back untouched so the phone can measure a
                // true round trip rather than trusting our clock.
                socket.write(
                    encodeJsonFrame(FRAME_TYPE.PONG, { at: Date.now() }, { timestamp: frame.timestamp })
                );
                break;

            case FRAME_TYPE.STATS:
                break;

            case FRAME_TYPE.BYE:
                session.close('broadcaster stopped');
                socket.end();
                break;

            default:
                break;
        }
    }
}

export { TRACK };
