import crypto from 'node:crypto';

import { credits, creatorSettings } from '../db/index.js';
import { sessions as defaultSessions } from './sessions.js';
import { rooms as defaultRooms } from './rooms.js';
import { chat as defaultChat } from './chat.js';
import { billing as defaultBilling, ratesFor } from './billing.js';
import { CLOSE_WENT_PRIVATE, CLOSE_PRIVATE_ENDED } from '../../src/live/protocol.js';

/**
 * Going one to one.
 *
 * A viewer watching a public broadcast asks the creator for a private turn; the
 * creator accepts; the broadcast they are already running becomes private to
 * that one person, at the creator's private rate, and everybody else is
 * disconnected. When it ends the broadcast is public again and nothing about it
 * has changed but who was allowed to watch.
 *
 * The shape of it is the part worth reading:
 *
 *   **The camera never re-pairs.** It is the same session, the same socket from
 *   the phone and the same encoder settings throughout. The capture app is not
 *   told that any of this happened and has nothing to do with it - which is
 *   what keeps a 1:1 a property of the web product rather than a feature of a
 *   broadcasting tool.
 *
 *   **Everyone reconnects, including the person who asked.** Admission and
 *   price are both decided during the WebSocket upgrade, so the honest way to
 *   change either is to make every socket knock again. The accepted viewer is
 *   handed an admission secret first and comes straight back; everybody else
 *   gets a close code that means "stop", not "retry".
 *
 *   **The public minutes and the private minutes are separate purchases.**
 *   Billing keys a minute on the side of the product it was watched on, so the
 *   private turn starts its own meter at its own rate. Nothing is refunded and
 *   nothing is re-priced backwards.
 *
 * Nothing is persisted. A request is a question somebody is asking right now,
 * and a server restart is an answer of "no".
 */

/**
 * How long a request stands before it lapses.
 *
 * A creator mid-shot cannot be watching a request list, so this is generous -
 * but not so generous that somebody gets an acceptance for a question they
 * asked in a different part of the evening.
 */
const REQUEST_TTL_MS = 120_000;

/** Pending requests per broadcast. A list a creator reads, so a readable length. */
const MAX_PENDING = 20;

class PrivateRequest {
    constructor({ sessionId, creatorId, userId, name, ratePerMin }) {
        this.id = crypto.randomUUID();
        this.sessionId = sessionId;
        this.creatorId = creatorId;
        this.userId = userId;
        this.name = name;
        this.ratePerMin = ratePerMin;
        this.createdAt = Date.now();

        /** pending | accepted | declined | cancelled | expired */
        this.state = 'pending';
        this.reason = null;

        /**
         * Set once, on acceptance, and handed to the asker's page.
         *
         * Kept on the request so the page can also *poll* for it, which is what
         * happens when the acceptance lands in the same instant as the close
         * that evicts them - the frame may not make it out, the poll always
         * will.
         */
        this.admit = null;
        this.roomId = null;
    }

    get expiresAt() {
        return this.createdAt + REQUEST_TTL_MS;
    }

    /** What the creator's list shows. No account id: a name and a wait. */
    publicView() {
        return {
            id: this.id,
            name: this.name,
            ratePerMin: this.ratePerMin,
            waitingSeconds: Math.round((Date.now() - this.createdAt) / 1000),
            expiresAt: this.expiresAt,
            state: this.state
        };
    }

    /** What the asker is told about their own request, secret included. */
    privateView() {
        return {
            id: this.id,
            sessionId: this.sessionId,
            state: this.state,
            reason: this.reason,
            ratePerMin: this.ratePerMin,
            expiresAt: this.expiresAt,
            admit: this.admit
        };
    }
}

export class PrivateTurns {
    constructor({
        sessions = defaultSessions,
        rooms = defaultRooms,
        chat = defaultChat,
        billing = defaultBilling
    } = {}) {
        this.sessions = sessions;
        this.rooms = rooms;
        this.chat = chat;
        this.billing = billing;

        /** @type {Map<string, PrivateRequest>} */
        this._requests = new Map();

        /**
         * Sockets that can be told something, by broadcast.
         *
         * The relay registers one per viewer socket. Used for the two moments
         * where waiting for a poll would be the wrong experience: a creator
         * being asked, and an asker being accepted.
         *
         * @type {Map<string, Set<{userId: string, notify: Function}>>}
         */
        this._links = new Map();
    }

    /* -------------------------------------------------------------- links -- */

    link(sessionId, { userId, notify }) {
        const link = { userId, notify };
        let set = this._links.get(sessionId);
        if (!set) {
            set = new Set();
            this._links.set(sessionId, set);
        }
        set.add(link);
        return link;
    }

    unlink(sessionId, link) {
        const set = this._links.get(sessionId);
        if (!set || !link) return;

        set.delete(link);
        if (set.size === 0) this._links.delete(sessionId);
    }

    _signal(sessionId, userId, payload) {
        for (const link of this._links.get(sessionId) ?? []) {
            if (link.userId !== userId) continue;
            try {
                link.notify(payload);
            } catch {
                /* the socket is going away */
            }
        }
    }

    /* ------------------------------------------------------------ sweeping -- */

    _sweep() {
        const now = Date.now();

        for (const request of this._requests.values()) {
            if (request.state === 'pending' && request.expiresAt <= now) {
                request.state = 'expired';
                this._signal(request.sessionId, request.userId, {
                    event: 'expired',
                    ...request.privateView()
                });
            }

            // Answered requests are kept just long enough to be collected by a
            // poll, then dropped. The acceptance lives on in the room.
            if (request.state !== 'pending' && request.createdAt + REQUEST_TTL_MS * 2 <= now) {
                this._requests.delete(request.id);
            }
        }
    }

    /* ------------------------------------------------------------ the ask -- */

    /**
     * Is this creator offering 1:1 at all?
     *
     * A creator with no private price has not opted into private turns, and
     * their viewers are not shown the button. The 3D price counts as much as
     * the 2D one: pricing only 3D is a way of saying "privately, in stereo".
     */
    offered(session) {
        if (!session.creatorId) return false;

        const rates = ratesFor(session, { isPrivate: true });
        return rates['2d'].perMin > 0 || rates['3d'].perMin > 0;
    }

    /**
     * What a private turn would cost this viewer, and whether they can ask.
     *
     * @param {object} session
     * @param {string|null} userId
     */
    quote(session, userId) {
        const offered = this.offered(session);
        const rates = ratesFor(session, { isPrivate: true });

        // The answered ones too, not just the pending one. This is the path an
        // accepted viewer collects their admission secret on - their socket was
        // closed by the very acceptance they are asking about - so restricting
        // it to requests still waiting would answer "nothing is happening" to
        // the one person something just happened to.
        const existing = userId ? this.latest(session.id, userId) : null;

        return {
            offered,
            modes: { '2d': rates['2d'], '3d': rates['3d'] },
            request: existing ? existing.privateView() : null
        };
    }

    /**
     * Ask the creator for a 1:1.
     *
     * @param {object} input
     * @param {object} input.session
     * @param {{id: string, name: string}} input.viewer
     * @returns {{ok: true, request: PrivateRequest} | {ok: false, reason: string}}
     */
    request({ session, viewer }) {
        this._sweep();

        if (!session.live) return { ok: false, reason: 'not_live' };
        if (viewer.id === session.creatorId) return { ok: false, reason: 'own_broadcast' };
        if (!this.offered(session)) return { ok: false, reason: 'private_unavailable' };
        if (this.rooms.isPrivate(session)) return { ok: false, reason: 'already_private' };

        // Asking twice is asking once. A page that lost its answer re-asks, and
        // that must not put a second row in front of the creator.
        const mine = this.mine(session.id, viewer.id);
        if (mine) return { ok: true, request: mine };

        const pending = this.pending(session.id);
        if (pending.length >= MAX_PENDING) return { ok: false, reason: 'too_many_requests' };

        // The cheapest private minute on offer, because that is the least this
        // can cost and the point of the check is not taking somebody into a
        // room they cannot afford to be in for one minute.
        const rates = ratesFor(session, { isPrivate: true });
        const ratePerMin = cheapest(rates);

        if (credits.account(viewer.id).balance < ratePerMin) {
            return { ok: false, reason: 'insufficient_credits' };
        }

        const request = new PrivateRequest({
            sessionId: session.id,
            creatorId: session.creatorId,
            userId: viewer.id,
            name: viewer.name,
            ratePerMin
        });

        this._requests.set(request.id, request);

        // Straight to whichever socket the creator is reading their own
        // broadcast on. A creator with no browser open finds it in the list
        // when they next look.
        this._signal(session.id, session.creatorId, { event: 'requested', ...request.publicView() });

        return { ok: true, request };
    }

    /** This viewer's own outstanding request on this broadcast, if any. */
    mine(sessionId, userId) {
        this._sweep();

        for (const request of this._requests.values()) {
            if (request.sessionId === sessionId && request.userId === userId && request.state === 'pending') {
                return request;
            }
        }
        return null;
    }

    /**
     * This viewer's most recent request on this broadcast, answered or not.
     *
     * Requests are dropped by the sweep a couple of minutes after they are
     * answered, so this is "what happened just now", not a history.
     */
    latest(sessionId, userId) {
        this._sweep();

        let newest = null;
        for (const request of this._requests.values()) {
            if (request.sessionId !== sessionId || request.userId !== userId) continue;
            if (!newest || request.createdAt > newest.createdAt) newest = request;
        }
        return newest;
    }

    byId(id) {
        this._sweep();
        return this._requests.get(String(id ?? '')) ?? null;
    }

    /** Everyone asking, longest wait first. */
    pending(sessionId) {
        this._sweep();

        return [...this._requests.values()]
            .filter((r) => r.sessionId === sessionId && r.state === 'pending')
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /* ----------------------------------------------------------- the answer -- */

    /**
     * Take this viewer, and only this viewer.
     *
     * @param {PrivateRequest} request
     * @param {string} creatorId - the account answering, checked against the room
     * @returns {{ok: true, room: object, admit: string} | {ok: false, reason: string}}
     */
    accept(request, creatorId) {
        this._sweep();

        if (!request || request.state !== 'pending') return { ok: false, reason: 'not_pending' };
        if (request.creatorId !== creatorId) return { ok: false, reason: 'not_yours' };

        const session = this.sessions.get(request.sessionId);
        if (!session?.live) return { ok: false, reason: 'not_live' };

        // Checked again at the moment of acceptance and not only when the
        // request was made. Minutes have passed, and they may have spent the
        // balance somewhere else in them.
        if (credits.account(request.userId).balance < request.ratePerMin) {
            request.state = 'declined';
            request.reason = 'insufficient_credits';
            this._signal(request.sessionId, request.userId, { event: 'declined', ...request.privateView() });
            return { ok: false, reason: 'viewer_cannot_pay' };
        }

        let room;
        try {
            room = this.rooms.takeOver(session, { creatorId, userId: request.userId });
        } catch (err) {
            return { ok: false, reason: err.code ?? 'takeover_failed' };
        }

        request.state = 'accepted';
        request.admit = room.admitToken;
        request.roomId = room.id;

        // Told before anybody is disconnected, so the accepted page has its
        // secret in hand when its socket closes underneath it.
        this._signal(request.sessionId, request.userId, { event: 'accepted', ...request.privateView() });

        // Everyone else who was asking is answered too. Being told no is worth
        // a round trip; being left on a list that can no longer be reached is
        // not.
        for (const other of this.pending(session.id)) {
            if (other.id === request.id) continue;
            other.state = 'declined';
            other.reason = 'someone_else';
            this._signal(other.sessionId, other.userId, { event: 'declined', ...other.privateView() });
        }

        // And now the room empties. Every meter stops as its socket goes, so
        // the public minute in progress is the last public minute charged.
        session.evictSubscribers(CLOSE_WENT_PRIVATE, 'this broadcast has gone private');

        return { ok: true, room, admit: room.admitToken };
    }

    /** No, and say so rather than leaving it to time out. */
    decline(request, creatorId) {
        if (!request || request.state !== 'pending') return { ok: false, reason: 'not_pending' };
        if (request.creatorId !== creatorId) return { ok: false, reason: 'not_yours' };

        request.state = 'declined';
        request.reason = 'declined';
        this._signal(request.sessionId, request.userId, { event: 'declined', ...request.privateView() });

        return { ok: true };
    }

    /** The asker changed their mind. */
    cancel(request, userId) {
        if (!request || request.state !== 'pending') return { ok: false, reason: 'not_pending' };
        if (request.userId !== userId) return { ok: false, reason: 'not_yours' };

        request.state = 'cancelled';
        return { ok: true };
    }

    /**
     * End the turn, from either side.
     *
     * Symmetrical on purpose. Either person can leave a conversation, and a
     * viewer who can only stop paying by closing a tab is a viewer being held
     * in a room.
     *
     * @param {object} session
     * @param {string} userId - whoever is ending it
     * @returns {{ok: true} | {ok: false, reason: string}}
     */
    end(session, userId) {
        const room = this.rooms.roomFor(session);
        if (!room) return { ok: false, reason: 'not_private' };
        if (userId !== room.creatorId && userId !== room.userId) return { ok: false, reason: 'not_yours' };

        this.rooms.close(room, 'the private turn ended');

        // Both of them are disconnected, and neither page reconnects on its
        // own: the broadcast is public again and watching it costs the public
        // rate, which is a charge nobody should incur by having left a tab
        // open.
        session.evictSubscribers(CLOSE_PRIVATE_ENDED, 'the private session ended');

        return { ok: true };
    }

    /** Tests and shutdown. */
    clear() {
        this._requests.clear();
        this._links.clear();
    }
}

/** The lowest price on offer across the modes that are actually available. */
function cheapest(rates) {
    const prices = [rates['2d'], rates['3d']]
        .filter((r) => r.available && r.perMin > 0)
        .map((r) => r.perMin);

    return prices.length ? Math.min(...prices) : 0;
}

/** The registry the live routes and the relay both talk to. */
export const privateTurns = new PrivateTurns();
