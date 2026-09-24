import { WebSocketServer } from 'ws';

import { sessions } from './sessions.js';
import { rooms as defaultRooms } from './rooms.js';
import { billing as defaultBilling } from './billing.js';
import { chat as defaultChat, MAX_TEXT } from './chat.js';
import { privateTurns as defaultTurns } from './private.js';
import { verifyAccessToken } from '../auth/tokens.js';
import {
    FLAG,
    FRAME_TYPE,
    MAX_UPSTREAM_BYTES,
    TALKBACK,
    TRACK,
    decodeFrame,
    decodeJson,
    encodeFrame,
    encodeJsonFrame
} from '../../src/live/protocol.js';

/**
 * Relay: the hop from ingest to everyone watching.
 *
 * Browsers cannot open a raw TCP socket, so the phone's frames leave here over
 * a binary WebSocket. Nothing is transcoded or even re-serialised on the way
 * through - the bytes the phone's encoder produced are the bytes the browser's
 * `VideoDecoder` receives, and the server's only job is deciding who gets them
 * and who is too far behind to keep up.
 *
 * Every frame goes out exactly as it arrived, which is what keeps the relay's
 * per-viewer cost to a `send()` and makes added latency a question of the
 * network rather than of this process.
 */

/**
 * Viewers per broadcast. A LAN relay fans out at line rate, so the real
 * constraint is upstream bandwidth: eight viewers on a 20 Mbit stereo stream
 * is already 160 Mbit off one NIC.
 */
const MAX_VIEWERS_PER_SESSION = Number(process.env.AVR_LIVE_MAX_VIEWERS || 16);

const PATH_PATTERN = /^\/live\/ws\/([0-9A-Za-z]{1,16})$/;

/**
 * Talkback a viewer may send per second, in bytes.
 *
 * Twice the nominal rate of the one format there is, so ordinary speech never
 * touches it and a page sending as fast as it can loop stops being this
 * process's problem. The camera's own socket is protected separately, by the
 * backlog check in `sendUpstream` - this is only about not spending the event
 * loop parsing a flood.
 */
const TALKBACK_BUDGET_BYTES = 64 * 1024;

/**
 * Wrap a `ws` socket in the sink interface {@link LiveSession} expects.
 *
 * `bufferedAmount` is the important one: it is how the session tells a viewer
 * that is keeping up from one that is quietly accumulating a queue in our heap.
 */
function sinkFor(ws) {
    return {
        send(bytes) {
            // `binary: true` keeps Uint8Array payloads from being sent as text.
            ws.send(bytes, { binary: true });
        },
        close(code, reason) {
            ws.close(code, reason);
        },
        get bufferedAmount() {
            return ws.bufferedAmount;
        }
    };
}

/**
 * A meter's way of reaching one viewer.
 *
 * Billing talks to this rather than to a socket, so the ledger side of the
 * product is testable with a plain object and knows nothing about `ws`.
 */
function billingHandle() {
    return {
        /** @type {import('ws').WebSocket|null} */
        ws: null,

        notify(payload) {
            if (this.ws?.readyState !== 1) return;
            this.ws.send(encodeJsonFrame(FRAME_TYPE.BILLING, payload), { binary: true });
        },

        close(code, reason) {
            this.ws?.close(code, reason);
        }
    };
}

export class LiveRelay {
    /**
     * @param {object} [opts]
     * @param {import('./sessions.js').SessionRegistry} [opts.registry]
     * @param {import('./rooms.js').RoomRegistry} [opts.rooms]
     */
    constructor({
        registry = sessions,
        rooms = defaultRooms,
        billing = defaultBilling,
        chat = defaultChat,
        turns = defaultTurns
    } = {}) {
        this.registry = registry;
        this.rooms = rooms;
        this.billing = billing;
        this.chat = chat;
        this.turns = turns;
        this.wss = null;
        this._onUpgrade = null;
        this._server = null;
    }

    /**
     * Attach to the application's HTTP server.
     *
     * `noServer` mode rather than giving `ws` its own port: the relay has to
     * be reachable on the same origin as the app so the monitor page is not
     * making a cross-origin socket, and a headset only has to trust one host.
     *
     * @param {import('node:http').Server} server
     */
    attach(server) {
        // `maxPayload` is the one defence that has to be in the transport
        // rather than in our handler: it is what stops an oversized upstream
        // message from being buffered into the heap before anybody looks at it.
        this.wss = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: MAX_UPSTREAM_BYTES
        });
        this._server = server;

        this._onUpgrade = async (req, socket, head) => {
            let url;
            try {
                url = new URL(req.url, 'http://localhost');
            } catch {
                socket.destroy();
                return;
            }

            const match = PATH_PATTERN.exec(url.pathname);
            if (!match) return; // Not ours - leave it for any other handler.

            const session = this.registry.get(match[1]);

            if (!session || !session.live) {
                socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            // The admission check, and the only one there is. A broadcast a
            // creator started for a chosen viewer is watchable by that viewer's
            // page and nothing else; every other broadcast is watchable by
            // anyone, exactly as before rooms existed.
            //
            // The secret rides in the query string because a browser cannot set
            // a header on a `WebSocket` constructor. That is tolerable here for
            // the same reasons it is on the pairing link: it is minted per tab,
            // never navigated to, and dies with the broadcast. A 404 rather than
            // a 403 keeps a wrong guess from confirming that the id was right.
            // Who is knocking. Established before admission rather than after,
            // because a creator is admitted to their own private broadcast by
            // being that creator and nothing else - there is no token they
            // could have been handed for it.
            //
            // The token rides in the query string for the same reason `admit`
            // does - `new WebSocket()` cannot set a header - and this is an
            // upgrade GET, which is the case `bearerFrom()` in the auth
            // middleware already allows one for.
            const claims = await verifyAccessToken(url.searchParams.get('access_token') ?? '');
            const viewerId = claims?.sub ?? null;

            if (socket.destroyed) return;

            if (!this.rooms.mayWatch(session, url.searchParams.get('admit'), viewerId)) {
                socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            if (session.subscribers.size >= MAX_VIEWERS_PER_SESSION) {
                socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            const isPrivate = this.rooms.isPrivate(session);
            const free = this.billing.isFree(session, { viewerId, isPrivate });

            // An unidentified socket can watch what is free and nothing else.
            // Anonymous viewing of a priced broadcast is not a thing we can
            // bill for later, so it is refused now rather than given away.
            if (!free && !viewerId) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            // The meter charges the first minute inside `attach`, which is
            // before there is a socket to tell about it. So the handle is a
            // stable object created now and pointed at the WebSocket by
            // `_join`; anything announced in between is dropped, which is
            // right, because the opening statement is delivered on join anyway.
            const handle = billingHandle();

            const ticket = free
                ? { ok: true, meter: null, events: [] }
                : this.billing.attach({
                      session,
                      viewerId,
                      isPrivate,
                      mode: url.searchParams.get('mode'),
                      handle
                  });

            if (!ticket.ok) {
                socket.write('HTTP/1.1 402 Payment Required\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }

            if (socket.destroyed) {
                this.billing.detach(ticket.meter, handle);
                return;
            }

            this.wss.handleUpgrade(req, socket, head, (ws) =>
                this._join(ws, session, { ...ticket, handle, claims })
            );
        };

        server.on('upgrade', this._onUpgrade);
    }

    /**
     * @param {import('ws').WebSocket} ws
     * @param {import('./sessions.js').LiveSession} session
     * @param {{meter: object|null, events?: object[], handle: object,
     *   claims?: object|null}} ticket
     */
    _join(ws, session, ticket = { meter: null, events: [], handle: null }) {
        if (ticket.handle) ticket.handle.ws = ws;

        // Before the first frame, so a viewer sees what they are paying the
        // moment the picture starts rather than a minute into it. This is also
        // where a "one minute left" warning lands for somebody who joined with
        // barely enough to start.
        for (const event of ticket.events ?? []) ticket.handle?.notify(event);

        // Joining the broadcast is joining its room. Signed in only - there is
        // no name to put on a message otherwise - so an anonymous socket
        // watching a free broadcast can see the conversation start without it
        // and simply has nothing to say.
        const claims = ticket.claims ?? null;

        // How a 1:1 request reaches the creator, and its answer reaches the
        // asker, without either page having to be mid-poll at the time.
        const link = claims
            ? this.turns.link(session.id, {
                  userId: claims.sub,
                  notify: (payload) => {
                      if (ws.readyState !== 1) return;
                      ws.send(encodeJsonFrame(FRAME_TYPE.PRIVATE, payload), { binary: true });
                  }
              })
            : null;

        const participant = claims
            ? this.chat.join(session.id, {
                  userId: claims.sub,
                  name: claims.name || 'Someone',
                  role: claims.role,
                  host: claims.sub === session.creatorId,
                  notify: (message) => {
                      if (ws.readyState !== 1) return;
                      ws.send(encodeJsonFrame(FRAME_TYPE.CHAT, message), { binary: true });
                  }
              })
            : null;

        // Compression is off and frames are already compressed video, so the
        // only thing left to tune is not letting a dead socket linger.
        const subscriber = session.addSubscriber(sinkFor(ws));

        let alive = true;
        ws.on('pong', () => {
            alive = true;
        });

        const heartbeat = setInterval(() => {
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            try {
                ws.ping();
            } catch {
                /* closing */
            }
        }, 15_000);
        heartbeat.unref();

        const leave = () => {
            clearInterval(heartbeat);
            session.removeSubscriber(subscriber);
            this.chat.leave(session.id, participant);
            this.turns.unlink(session.id, link);
            // The meter stops when this account's last socket goes, so the
            // minute in progress is the last one billed.
            this.billing.detach(ticket.meter, ticket.handle);
        };

        ws.on('close', leave);
        ws.on('error', leave);

        // Per-socket, because the floor belongs to a socket and dies with it.
        const viewer = {
            participant,
            userId: claims?.sub ?? null,
            talkback: { budget: TALKBACK_BUDGET_BYTES, at: Date.now() }
        };

        ws.on('message', (data, isBinary) => this._fromViewer(session, viewer, data, isBinary));
    }

    /**
     * What a viewer may send.
     *
     * Until chat there was no return path at all, and the rule was that
     * anything arriving from a viewer was a bug or a probe. That rule is now
     * two cases wide - a line in the room, and talkback from the one viewer a
     * broadcast is private to - and everything outside them is still dropped in
     * silence: no error frame, no close, nothing that tells a prober whether
     * they found something. Oversized messages never reach here: `maxPayload`
     * refuses them at the socket.
     *
     * @param {import('./sessions.js').LiveSession} session
     * @param {{participant: object|null, userId: string|null, talkback: object}} viewer
     * @param {Buffer} data
     * @param {boolean} isBinary
     */
    _fromViewer(session, viewer, data, isBinary) {
        if (!isBinary) return;

        let frame;
        try {
            frame = decodeFrame(new Uint8Array(data));
        } catch {
            return;
        }

        if (!frame) return;

        if (frame.track === TRACK.TALKBACK) {
            this._talkback(session, viewer, frame);
            return;
        }

        const participant = viewer.participant;
        if (!participant || frame.type !== FRAME_TYPE.CHAT) return;

        let payload;
        try {
            payload = decodeJson(frame);
        } catch {
            return;
        }

        const posted = this.chat.post(session.id, participant, payload?.text);
        if (posted.ok) return;

        // Told back to the one socket it happened to, because a message that
        // silently fails to appear reads as a broken page. Only for the two
        // reasons a person can act on; `empty` and `not_in_room` are the page's
        // own bugs and are not worth a line in somebody's chat.
        if (posted.reason === 'rate_limited') {
            this.chat.notice(participant, 'Slow down a moment - that is a lot of messages at once.');
        } else if (posted.reason === 'too_long') {
            this.chat.notice(participant, `That message is too long. ${MAX_TEXT} characters is the limit.`);
        }
    }

    /**
     * Speech, going the wrong way up the pipeline.
     *
     * The one thing on this server that travels from a viewer to a camera, and
     * it is deliberately the narrowest path in the file:
     *
     *   **Only the person the broadcast is private to.** Not a public viewer,
     *   not the creator, not somebody who was in a 1:1 a minute ago - the check
     *   is against the open room, read fresh on every packet, so the floor is
     *   lost the instant the turn ends.
     *
     *   **The header is ours, the payload is theirs.** The frame is re-encoded
     *   with a track and a type this server chose, so nothing a viewer writes
     *   can reach the capture app claiming to be video, or configuration, or
     *   anything else it parses.
     *
     *   **Dropped, never queued.** Both here and in `sendUpstream`. Late speech
     *   is worse than missing speech, and the socket it would queue on is the
     *   one carrying the broadcast.
     *
     * @param {import('./sessions.js').LiveSession} session
     * @param {{userId: string|null, talkback: object}} viewer
     * @param {object} frame
     */
    _talkback(session, viewer, frame) {
        if (!viewer.userId) return;

        const room = this.rooms.roomFor(session);
        if (!room || room.userId !== viewer.userId) return;

        // A second's worth of allowance, refilled continuously.
        const budget = viewer.talkback;
        const now = Date.now();
        budget.budget = Math.min(
            TALKBACK_BUDGET_BYTES,
            budget.budget + ((now - budget.at) * TALKBACK_BUDGET_BYTES) / 1000
        );
        budget.at = now;

        if (budget.budget < frame.payload.length) return;
        budget.budget -= frame.payload.length;

        if (frame.type === FRAME_TYPE.CONFIG) {
            // The format is a constant, not a negotiation, so the viewer's
            // CONFIG is read as "talkback is starting" and answered with the
            // server's own description of the only format there is.
            let config;
            try {
                config = decodeJson(frame);
            } catch {
                return;
            }
            if (config?.codec !== TALKBACK.codec) return;

            session.sendUpstream(
                encodeJsonFrame(
                    FRAME_TYPE.CONFIG,
                    {
                        codec: TALKBACK.codec,
                        sampleRate: TALKBACK.sampleRate,
                        numberOfChannels: TALKBACK.numberOfChannels
                    },
                    { track: TRACK.TALKBACK }
                )
            );
            return;
        }

        if (frame.type !== FRAME_TYPE.AUDIO) return;

        // Whole 16-bit samples or nothing. A trailing half sample is a bug at
        // the sending end, and passing it on makes it the camera's bug.
        if (frame.payload.length === 0 || frame.payload.length % 2 !== 0) return;

        session.sendUpstream(
            encodeFrame({
                type: FRAME_TYPE.AUDIO,
                track: TRACK.TALKBACK,
                // Every PCM packet stands alone, so every one is a point the
                // far end can start playing from.
                flags: FLAG.KEYFRAME,
                timestamp: frame.timestamp,
                payload: frame.payload
            })
        );
    }

    detach() {
        if (this._onUpgrade && this._server) {
            this._server.off('upgrade', this._onUpgrade);
        }
        this.wss?.close();
        this.wss = null;
        this._server = null;
        this._onUpgrade = null;
    }
}
