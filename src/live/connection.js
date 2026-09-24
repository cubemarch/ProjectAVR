import {
    CLOSE_OUT_OF_CREDITS,
    CLOSE_PRIVATE_ENDED,
    CLOSE_WENT_PRIVATE,
    FRAME_TYPE,
    TRACK,
    decodeFrame,
    decodeJson,
    encodeJsonFrame,
    trackName
} from './protocol.js';

/**
 * The viewer's end of the relay.
 *
 * A thin WebSocket wrapper that turns binary messages into protocol frames and
 * announces them. It deliberately knows nothing about decoding or rendering -
 * the point is that the same frames the phone's encoder emitted arrive here
 * unmodified, and everything downstream is the browser's business.
 *
 * Reconnection is handled here rather than by the caller, because a live
 * stream that drops for two seconds of Wi-Fi turbulence should come back by
 * itself. The relay replays the decoder config and gates on the next keyframe,
 * so a reconnect recovers a correct picture without any state carried across.
 */

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Stop sending upstream once this much is already queued in the socket.
 *
 * Talkback is live speech, so a backlog is not a queue to be drained - it is
 * latency that will never be recovered, and every packet added to it makes the
 * arrival later still. Dropping is both the honest and the recoverable choice:
 * the far end hears a gap, and the moment the network catches up it hears the
 * present rather than half a minute of the past. Sized at about half a second
 * of talkback, which is long enough to ride out a stalled frame and short
 * enough that nobody waits on it.
 */
const UPSTREAM_QUEUE_LIMIT = 16 * 1024;

export class LiveConnection extends EventTarget {
    /**
     * @param {string} sessionId
     * @param {object} [opts]
     * @param {string} [opts.origin] - Defaults to the page's own origin.
     * @param {boolean} [opts.reconnect]
     * @param {string|null} [opts.admit] - Admission secret for a private
     *   broadcast. Held in memory for the life of the page and never stored;
     *   most broadcasts need none, and the relay only asks when there is a room.
     * @param {string|null} [opts.accessToken] - Who is watching. Required only
     *   for a broadcast that charges; free ones do not ask and do not care.
     * @param {'2d'|'3d'} [opts.mode] - What the viewer is watching in, which is
     *   what they are billed at. Changed later over `/api/live/watch/:id/mode`,
     *   not on this socket.
     */
    constructor(
        sessionId,
        { origin = null, reconnect = true, admit = null, accessToken = null, mode = null } = {}
    ) {
        super();

        this.sessionId = String(sessionId).toUpperCase();
        this.reconnect = reconnect;
        this.admit = admit;
        this.accessToken = accessToken;
        this.mode = mode;
        this.session = null;

        this._origin = origin;
        this._ws = null;
        this._attempt = 0;
        this._closedByUs = false;
        this._reconnectTimer = null;

        this.bytesReceived = 0;
        this.framesReceived = 0;
        this.audioFramesReceived = 0;
    }

    get url() {
        const base = this._origin ?? location.origin;
        const wsBase = base.replace(/^http/, 'ws');

        // In the query string because `new WebSocket()` cannot set a header.
        // Tolerable for the same reason it is on the pairing link: it is minted
        // per tab, never navigated to, and dies with the broadcast. The access
        // token is there on the same terms, and only on this upgrade GET.
        const params = new URLSearchParams();
        if (this.admit) params.set('admit', this.admit);
        if (this.accessToken) params.set('access_token', this.accessToken);
        if (this.mode) params.set('mode', this.mode);

        const query = params.size ? `?${params}` : '';

        return `${wsBase}/live/ws/${this.sessionId}${query}`;
    }

    get connected() {
        return this._ws?.readyState === WebSocket.OPEN;
    }

    connect() {
        this._closedByUs = false;
        this._open();
    }

    _open() {
        const ws = new WebSocket(this.url);
        ws.binaryType = 'arraybuffer';
        this._ws = ws;

        ws.addEventListener('open', () => {
            this._attempt = 0;
            this._emit('open');
        });

        ws.addEventListener('message', (event) => {
            if (typeof event.data === 'string') return; // Nothing textual is sent.
            this._onFrame(new Uint8Array(event.data));
        });

        ws.addEventListener('error', () => {
            // The close event always follows and carries the useful detail, so
            // this only exists to stop an unhandled error surfacing in console.
        });

        ws.addEventListener('close', (event) => {
            this._ws = null;

            // Out of credits. Retrying would be five refused upgrades and then
            // a longer wait for the same answer, so the page is told once and
            // the viewer decides whether to top up.
            if (event.code === CLOSE_OUT_OF_CREDITS) {
                this.reconnect = false;
                this._emit('billing', { event: 'exhausted', sessionId: this.sessionId });
            }

            // The broadcast went private, or a private turn ended. Both are a
            // deliberate change of who may watch, so reconnecting on this
            // socket is wrong twice over: the accepted viewer comes back on a
            // new one carrying an admission secret, and everybody else would be
            // knocking at a door that was just shut - or, worse, walking back
            // into a public broadcast at the public rate having never asked to.
            if (event.code === CLOSE_WENT_PRIVATE || event.code === CLOSE_PRIVATE_ENDED) {
                this.reconnect = false;
                this._emit('evicted', {
                    code: event.code,
                    private: event.code === CLOSE_WENT_PRIVATE,
                    reason: event.reason
                });
            }

            this._emit('close', { code: event.code, reason: event.reason });

            if (this._closedByUs || !this.reconnect) return;

            // 404 and 503 arrive as a failed upgrade, which surfaces as 1006.
            // Retrying is still right: the broadcast may not have started yet.
            const delay = RECONNECT_DELAYS_MS[Math.min(this._attempt, RECONNECT_DELAYS_MS.length - 1)];
            this._attempt += 1;

            this._emit('reconnecting', { delay, attempt: this._attempt });
            this._reconnectTimer = setTimeout(() => this._open(), delay);
        });
    }

    /** @param {Uint8Array} bytes */
    _onFrame(bytes) {
        this.bytesReceived += bytes.length;

        let frame;
        try {
            frame = decodeFrame(bytes);
        } catch (err) {
            this._emit('error', { message: `malformed frame: ${err.message}` });
            return;
        }

        switch (frame.type) {
            case FRAME_TYPE.READY:
                this.session = decodeJson(frame);
                this._emit('ready', this.session);
                break;

            case FRAME_TYPE.CONFIG:
                this._emit('config', { track: frame.track, name: trackName(frame.track), config: decodeJson(frame) });
                break;

            case FRAME_TYPE.VIDEO:
                this.framesReceived += 1;
                this._emit('video', frame);
                break;

            case FRAME_TYPE.AUDIO:
                this.audioFramesReceived += 1;
                this._emit('audio', frame);
                break;

            case FRAME_TYPE.BILLING:
                // What the minute just starting costs and what is left after
                // it. Purely informational - the charge has already happened
                // server-side, and nothing the page does can undo or avoid it.
                this._emit('billing', decodeJson(frame));
                break;

            case FRAME_TYPE.CHAT:
                // A line in the room that came with the broadcast. Backlog
                // replayed on join is flagged `history` so the page can put it
                // up without announcing forty messages as if they just arrived.
                this._emit('chat', decodeJson(frame));
                break;

            case FRAME_TYPE.PRIVATE:
                // Somebody asked for a 1:1, or answered one. The socket is the
                // fast path; the page polls as well, because an acceptance
                // arrives in the same instant as the close that carries it away.
                this._emit('private', decodeJson(frame));
                break;

            case FRAME_TYPE.BYE:
                // The broadcast is over, as opposed to the socket failing, so
                // there is nothing to reconnect to.
                this.reconnect = false;
                this._emit('ended', decodeJson(frame));
                break;

            default:
                break;
        }
    }

    /**
     * Say something in the room.
     *
     * Who said it is not in the payload and cannot be: the server takes the
     * name off the access token this connection was opened with, so there is
     * nothing here to forge.
     *
     * @param {string} text
     * @returns {boolean} Whether it left the page. A refusal arrives separately,
     *   as a system line in the room.
     */
    say(text) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed || !this.connected) return false;

        this._ws.send(encodeJsonFrame(FRAME_TYPE.CHAT, { text: trimmed }));
        return true;
    }

    /**
     * Send one already-encoded frame up the socket.
     *
     * Only talkback uses this, and only from {@link Talkback}, which owns the
     * encoding so that the microphone path never has to know what a WebSocket
     * is. Refusals are silent and return `false`: a dropped 40 ms packet is not
     * an error condition, it is what congestion is supposed to look like on a
     * live microphone, and reporting each one would be a hundred events a
     * second at exactly the moment the page is least able to afford them.
     *
     * The server drops too, independently - a byte budget per socket and a
     * backlog check on the camera's own connection. Three places, because the
     * only one of them that can drop a packet *before* it costs anything is
     * this one.
     *
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    sendUpstream(bytes) {
        if (!this.connected) return false;
        if (this._ws.bufferedAmount > UPSTREAM_QUEUE_LIMIT) return false;

        this._ws.send(bytes);
        return true;
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    close() {
        this._closedByUs = true;
        clearTimeout(this._reconnectTimer);
        this._ws?.close(1000, 'viewer left');
        this._ws = null;
    }
}

/**
 * Fetch the list of broadcasts currently running on this server.
 *
 * @param {string} [origin]
 * @returns {Promise<{sessions: object[]}>}
 */
export async function fetchSessions(origin = '') {
    const response = await fetch(`${origin}/api/live/sessions`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`session list failed: HTTP ${response.status}`);
    return response.json();
}

export { TRACK, CLOSE_OUT_OF_CREDITS, CLOSE_WENT_PRIVATE, CLOSE_PRIVATE_ENDED };
