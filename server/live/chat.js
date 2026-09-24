import crypto from 'node:crypto';

/**
 * The room that comes with a broadcast.
 *
 * Joining a public stream joins its chat, because a stream with a chat beside
 * it is one place and a stream with a chat somewhere else is two. There is no
 * separate join step and no room id to exchange: the broadcast id is the room.
 *
 * Three things about the shape of this, each of which is a decision rather than
 * an accident:
 *
 *   **Nothing is persisted.** A chat room exists for as long as its broadcast
 *   does and is gone with it, for the same reason `sessions.js` keeps nothing:
 *   this is a conversation happening in a room, not a message history product.
 *   It also means there is no chat log to disclose, subpoena or leak.
 *
 *   **Identity comes from the socket, not the payload.** A participant is
 *   registered by the relay from the verified access token, and the only thing
 *   a client can put in a message is its text. A display name arriving in the
 *   payload would be a display name anybody could choose.
 *
 *   **A private turn has a chat too, and it is the same code.** Two people in a
 *   1:1 are a room with two participants in it. Nothing here knows the
 *   difference, because the relay only ever admits who is allowed to be there.
 *
 * Not on the phone. The capture app has no chat, and a creator reads their room
 * in the browser - see the "Do not add" list in `docs/IOS_BRIEF.md`.
 */

/** Kept per room, and sent to whoever joins next so they arrive mid-conversation. */
const HISTORY = 50;

/** Longest single message. Past this a chat line is a payload, not a sentence. */
export const MAX_TEXT = 400;

/**
 * Burst allowance and refill, per participant.
 *
 * Five in hand covers somebody typing fast and reacting to something; one every
 * two seconds is the sustained rate. Both are per participant rather than per
 * account, which is the same thing in practice and cheaper to reason about.
 */
const BUCKET_CAPACITY = 5;
const BUCKET_REFILL_MS = 2000;

class Participant {
    constructor({ userId, name, role, host, notify }) {
        this.id = crypto.randomUUID();
        this.userId = userId;
        this.name = name;
        this.role = role;
        this.host = host;
        this.notify = notify;

        this.tokens = BUCKET_CAPACITY;
        this.lastRefillAt = Date.now();
    }

    /** @returns {boolean} false when this one is going too fast. */
    _spend() {
        const now = Date.now();
        const earned = Math.floor((now - this.lastRefillAt) / BUCKET_REFILL_MS);

        if (earned > 0) {
            this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + earned);
            this.lastRefillAt = now;
        }

        if (this.tokens <= 0) return false;

        this.tokens -= 1;
        return true;
    }
}

class ChatRoom {
    constructor(sessionId) {
        this.sessionId = sessionId;
        /** @type {Set<Participant>} */
        this.participants = new Set();
        /** @type {object[]} */
        this.history = [];
    }

    _remember(message) {
        this.history.push(message);
        if (this.history.length > HISTORY) this.history.shift();
    }

    _fanOut(message) {
        for (const participant of this.participants) {
            try {
                participant.notify(message);
            } catch {
                /* the socket is going away; `leave` will follow */
            }
        }
    }
}

export class ChatRegistry {
    constructor() {
        /** @type {Map<string, ChatRoom>} */
        this._rooms = new Map();
    }

    _room(sessionId) {
        let room = this._rooms.get(sessionId);
        if (!room) {
            room = new ChatRoom(sessionId);
            this._rooms.set(sessionId, room);
        }
        return room;
    }

    /**
     * Put a signed-in watcher in the room.
     *
     * Returns the participant, which is the handle every other call takes. An
     * anonymous socket does not get one: there is no name to put on a message,
     * and "anonymous can watch, signed in can speak" is the line the rest of
     * the product already draws.
     *
     * @param {string} sessionId
     * @param {{userId: string, name: string, role: string, host: boolean,
     *   notify: (message: object) => void}} who
     */
    join(sessionId, { userId, name, role, host = false, notify }) {
        const room = this._room(sessionId);
        const participant = new Participant({ userId, name, role, host, notify });

        room.participants.add(participant);

        // What has been said so far, to this one socket only, so somebody who
        // joins a conversation in progress can see what it is about. Marked, so
        // a page can render it without a notification chime for each line.
        for (const message of room.history) {
            try {
                notify({ ...message, history: true });
            } catch {
                break;
            }
        }

        return participant;
    }

    leave(sessionId, participant) {
        const room = this._rooms.get(sessionId);
        if (!room || !participant) return;

        room.participants.delete(participant);

        // An empty room is deleted rather than kept warm. The broadcast it
        // belonged to may well be over, and a room nobody is in has nothing in
        // it worth carrying.
        if (room.participants.size === 0) this._rooms.delete(sessionId);
    }

    /**
     * Say something.
     *
     * @returns {{ok: true, message: object} | {ok: false, reason: string}}
     */
    post(sessionId, participant, text) {
        const room = this._rooms.get(sessionId);
        if (!room || !participant || !room.participants.has(participant)) {
            return { ok: false, reason: 'not_in_room' };
        }

        // Collapse runs of whitespace as well as trimming: a message that is
        // forty newlines is a way of taking over somebody else's screen.
        const body = String(text ?? '').replace(/\s+/g, ' ').trim();

        if (!body) return { ok: false, reason: 'empty' };
        if (body.length > MAX_TEXT) return { ok: false, reason: 'too_long' };
        if (!participant._spend()) return { ok: false, reason: 'rate_limited' };

        const message = {
            id: crypto.randomUUID(),
            at: Date.now(),
            name: participant.name,
            role: participant.role,
            host: participant.host,
            text: body
        };

        room._remember(message);
        room._fanOut(message);

        return { ok: true, message };
    }

    /**
     * A line from the server itself.
     *
     * Used for the things a room needs to be told rather than told by somebody:
     * a 1:1 starting, a 1:1 ending. Has no `name`, which is how a page knows to
     * render it as an event and not as speech.
     */
    announce(sessionId, text) {
        const room = this._rooms.get(sessionId);
        if (!room) return null;

        const message = { id: crypto.randomUUID(), at: Date.now(), system: true, text: String(text) };

        room._remember(message);
        room._fanOut(message);

        return message;
    }

    /**
     * A line only one participant sees.
     *
     * For telling somebody why what they typed did not appear. It is not
     * remembered and not fanned out, because it happened to them rather than in
     * the room.
     */
    notice(participant, text) {
        if (!participant) return null;

        const message = { id: crypto.randomUUID(), at: Date.now(), system: true, private: true, text: String(text) };

        try {
            participant.notify(message);
        } catch {
            /* the socket is going away */
        }

        return message;
    }

    /** Everyone currently in the room, for a page that wants to show who is here. */
    roster(sessionId) {
        const room = this._rooms.get(sessionId);
        if (!room) return [];

        return [...room.participants].map((p) => ({ name: p.name, host: p.host }));
    }

    /** Tests and shutdown. */
    clear() {
        this._rooms.clear();
    }

    get size() {
        return this._rooms.size;
    }
}

/** The registry the relay talks to. */
export const chat = new ChatRegistry();
