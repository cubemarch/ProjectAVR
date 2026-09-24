import crypto from 'node:crypto';

import { sessions as defaultSessions, makeSessionId } from './sessions.js';

/**
 * Waiting viewers, and the rooms creators put them in.
 *
 * The problem this solves is that a broadcast id is not an invitation. A
 * six-character id is short enough to read aloud, which is the point of it, and
 * it means anybody who has one can watch - fine for a LAN test screen, wrong the
 * moment a creator wants to broadcast to one named person and nobody else.
 *
 * So the direction is reversed. A signed-in viewer with the monitor page open
 * registers here as *waiting*; the creator sees a list of who is waiting and
 * picks one; that choice is attached to the grant the creator is about to scan
 * into the phone. When the phone connects, the server joins the two on the
 * grant id, and the broadcast that appears is private to that one viewer.
 *
 * Three properties fall out of doing it this way and are worth stating, because
 * each one is load-bearing:
 *
 *   The QR code does not change. It is still `avr://pair?host=…&key=…`, and the
 *   capture app still has no idea that viewers, rooms or accounts exist. The
 *   key is the only unique id that crosses between the two products, and
 *   everything else is resolved from it on this side. See `pairing.js`.
 *
 *   Privacy is intrinsic, not a setting. A session started from a grant with no
 *   room attached - the shared stream key, or a destination the creator made
 *   without choosing anybody - behaves exactly as it always has: listed,
 *   joinable by id, public. Choosing a viewer is what makes a broadcast
 *   private, and there is no flag anywhere that can be wrong.
 *
 *   The viewer proves admission with a secret they were issued, not with their
 *   own id. The creator is shown viewer ids, so a viewer id cannot also be the
 *   thing that gets you into the room.
 *
 * Nothing here is persisted, for the same reason nothing in `sessions.js` is: a
 * waiting viewer is a browser tab that currently has a page open, and a room is
 * a pairing between that tab and a socket. Restarting the server ends both, and
 * that is correct rather than a limitation. It also inherits the same
 * single-process constraint the session registry documents - live is node-local
 * either way, so rooms add no new one.
 */

/**
 * How long a registered viewer stays on the list without checking back in.
 *
 * Generous relative to the poll interval below. A creator looking at a list of
 * people to admit needs it to be true, and the failure that matters is the row
 * that is still there after the tab closed - a creator picks it, the room never
 * fills, and the broadcast goes to nobody.
 */
const VIEWER_TTL_MS = 20_000;

/** What the monitor page is told to wait between check-ins. */
export const VIEWER_POLL_MS = 4000;

/**
 * How long a room survives with no broadcast in it.
 *
 * Longer than a grant's own five minutes on purpose. The room outliving the
 * credential is harmless - an expired grant cannot open it - and it means a
 * creator who fumbles the scan sees "waiting for the camera" rather than a room
 * that vanished while they were looking at it.
 */
const ROOM_IDLE_MS = 15 * 60_000;

/**
 * How long a closed room is kept around to be asked about.
 *
 * Purely so the creator's next poll can say *why* it closed - "the viewer left"
 * rather than a room that silently stopped existing. A closed room is skipped by
 * every lookup that grants anything, so this keeps a sentence, not a capability.
 */
const CLOSED_GRACE_MS = 60_000;

/**
 * Ceiling on the waiting list.
 *
 * A list a creator is expected to read is useless past a few dozen rows, and an
 * unbounded in-memory list keyed on "opened a page" is a way to spend a server's
 * heap from a browser. Past this, registration is refused and the page says so.
 */
const MAX_WAITING = 200;

/** Per account, so one signed-in user cannot fill the list from a script. */
const MAX_WAITING_PER_USER = 8;

/**
 * One browser tab with the monitor page open.
 *
 * Deliberately per *tab*, not per account: two windows of the same account are
 * two rows, because the creator is choosing a screen to put a broadcast on and
 * two screens are two choices. They are told apart by the device string and the
 * short id, both of which are visible in the list.
 */
class WaitingViewer {
    constructor({ userId, name, device }) {
        /** Shown to the creator. Not a capability. */
        this.id = makeSessionId(6);

        /**
         * Held only by the page that registered. This is what the relay checks,
         * and it is never in any response a creator can see.
         */
        this.token = crypto.randomBytes(32).toString('base64url');

        this.userId = userId;
        this.name = name;
        this.device = device;
        this.joinedAt = Date.now();
        this.lastSeenAt = this.joinedAt;

        /** @type {string|null} */
        this.roomId = null;
    }

    get staleAt() {
        return this.lastSeenAt + VIEWER_TTL_MS;
    }

    /** What a creator is allowed to see: a name, a screen, and how long they have waited. */
    publicView() {
        return {
            id: this.id,
            name: this.name,
            device: this.device,
            waitingSeconds: Math.round((Date.now() - this.joinedAt) / 1000)
        };
    }
}

/**
 * One creator, one viewer, one broadcast.
 *
 * Created empty. `grantId` arrives when the destination link is minted, which
 * for the face-check path is a round trip later than the room itself - so the
 * room is reserved against the challenge first and the grant is bound to it
 * when the check comes back. `sessionId` arrives when the phone connects.
 */
class Room {
    constructor({ creatorId, viewerId, challengeId = null, userId = null, admitToken = null }) {
        this.id = makeSessionId(6);
        this.creatorId = creatorId;
        this.viewerId = viewerId;
        this.challengeId = challengeId;
        this.grantId = null;
        this.sessionId = null;
        this.createdAt = Date.now();
        this.closedAt = null;
        this.closeReason = null;

        /**
         * The account this room is for, when it was opened around an account
         * rather than around a tab on the waiting list.
         *
         * A room reserved from the waiting list is for a *screen* - `viewerId`
         * is a `WaitingViewer`, which is one browser window - because the
         * creator is choosing where to put a broadcast. A room opened by
         * accepting a 1:1 request is for a *person*, who is already watching
         * and whose account is the thing being billed.
         */
        this.userId = userId;

        /**
         * This room's own admission secret, for the same case.
         *
         * A waiting-list room borrows the secret the waiting tab already holds.
         * A room opened mid-broadcast has no such tab behind it, so it carries
         * one, and the accepted viewer is handed it once.
         */
        this.admitToken = admitToken;
    }

    get open() {
        return this.closedAt === null;
    }

    /**
     * Both screens show this, and that is its whole job.
     *
     * The creator's browser and the viewer's browser display the same six
     * characters, so the human on each end can confirm they are looking at the
     * same room before anything goes on air. Nothing is authorised by it.
     */
    publicView() {
        return {
            id: this.id,
            sessionId: this.sessionId,
            createdAt: this.createdAt,
            open: this.open
        };
    }
}

export class RoomRegistry {
    /**
     * @param {object} [opts]
     * @param {import('./sessions.js').SessionRegistry} [opts.sessions]
     */
    constructor({ sessions = defaultSessions } = {}) {
        /** @type {Map<string, WaitingViewer>} */
        this._viewers = new Map();
        /** @type {Map<string, Room>} */
        this._rooms = new Map();

        this.sessions = sessions;

        // Subscribed here rather than called from the ingest path, so nothing on
        // the hot socket has to know rooms exist. A session with no room simply
        // finds nothing to bind.
        this._onStarted = (session) => this._bindSession(session);
        this._onEnded = (session) => this._releaseSession(session);
        sessions.on('started', this._onStarted);
        sessions.on('ended', this._onEnded);
    }

    /** Only for tests and shutdown; the singleton lives as long as the process. */
    detach() {
        this.sessions.off('started', this._onStarted);
        this.sessions.off('ended', this._onEnded);
        this._viewers.clear();
        this._rooms.clear();
    }

    /* ----------------------------------------------------------- sweeping -- */

    /**
     * Drop what has gone stale.
     *
     * Lazily, on every read, rather than on a timer. A timer here would be a
     * handle to unref, a thing to stop in tests, and a source of work on an idle
     * server - and the only observer of staleness is a request that is already
     * running.
     */
    _sweep() {
        const now = Date.now();

        for (const viewer of this._viewers.values()) {
            if (viewer.staleAt > now) continue;
            this._viewers.delete(viewer.id);
            if (viewer.roomId) this._closeRoom(this._rooms.get(viewer.roomId), 'the viewer went away');
        }

        for (const room of this._rooms.values()) {
            if (!room.open) {
                if (room.closedAt + CLOSED_GRACE_MS <= now) this._rooms.delete(room.id);
                continue;
            }
            // An occupied room is kept by the broadcast in it, however long that
            // runs. The clock is only on rooms nothing ever arrived in.
            if (!room.sessionId && room.createdAt + ROOM_IDLE_MS <= now) {
                this._closeRoom(room, 'nobody connected');
            }
        }
    }

    /* ------------------------------------------------------------ viewers -- */

    /**
     * Put a signed-in viewer on the waiting list.
     *
     * Signed in is the whole entry requirement, and it is what makes the list
     * readable: every row is an account with a name on it, so a creator is
     * choosing a person rather than an anonymous device. It also means an
     * unauthenticated stranger cannot put a row in front of a creator at all.
     *
     * @param {{userId: string, name: string, device: string}} input
     * @returns {WaitingViewer}
     * @throws {Error} with `.code` when the list is full
     */
    register({ userId, name, device }) {
        this._sweep();

        if (this._viewers.size >= MAX_WAITING) {
            throw Object.assign(new Error('the waiting list is full'), { code: 'waiting_list_full' });
        }

        let mine = 0;
        for (const viewer of this._viewers.values()) {
            if (viewer.userId === userId) mine += 1;
        }

        if (mine >= MAX_WAITING_PER_USER) {
            throw Object.assign(new Error('too many windows open on this account'), { code: 'too_many_windows' });
        }

        const viewer = new WaitingViewer({ userId, name, device });
        this._viewers.set(viewer.id, viewer);
        return viewer;
    }

    /**
     * Check in, and find out what has happened.
     *
     * One call does both because they are the same question asked from the two
     * ends: the page wants to know whether it has been admitted, and the list
     * wants to know whether the page is still there.
     *
     * @returns {WaitingViewer|null} null when the registration has lapsed, which
     *   the page handles by registering again.
     */
    refresh(id, token) {
        this._sweep();

        const viewer = this._viewers.get(String(id ?? ''));
        if (!viewer || !tokenMatches(token, viewer.token)) return null;

        viewer.lastSeenAt = Date.now();
        return viewer;
    }

    /** The page was closed. Nothing depends on this arriving - the sweep covers it. */
    forget(id, token) {
        const viewer = this._viewers.get(String(id ?? ''));
        if (!viewer || !tokenMatches(token, viewer.token)) return false;

        this._viewers.delete(viewer.id);
        if (viewer.roomId) this._closeRoom(this._rooms.get(viewer.roomId), 'the viewer left');

        return true;
    }

    /** Everyone still free to be chosen. Longest wait first, so nobody is buried. */
    waiting() {
        this._sweep();

        return [...this._viewers.values()]
            .filter((viewer) => !viewer.roomId)
            .sort((a, b) => a.joinedAt - b.joinedAt)
            .map((viewer) => viewer.publicView());
    }

    /**
     * Where a given viewer stands.
     *
     * Four states, and the monitor page has a screen for each:
     *
     *   `unknown`   the registration lapsed; register again
     *   `waiting`   on the list, nobody has chosen you
     *   `admitted`  a creator has, but the camera has not connected yet
     *   `live`      there is a broadcast to join, and `sessionId` says which
     */
    statusOf(id, token) {
        const viewer = this.refresh(id, token);
        if (!viewer) return { status: 'unknown', room: null, sessionId: null };

        const room = viewer.roomId ? this._rooms.get(viewer.roomId) : null;
        if (!room?.open) return { status: 'waiting', room: null, sessionId: null };

        return {
            status: room.sessionId ? 'live' : 'admitted',
            room: room.publicView(),
            sessionId: room.sessionId
        };
    }

    /** The admission secret for a viewer, for the page that owns it. Never listed. */
    tokenFor(id) {
        return this._viewers.get(String(id ?? ''))?.token ?? null;
    }

    /* -------------------------------------------------------------- rooms -- */

    /**
     * Reserve a room for a creator and the viewer they chose.
     *
     * Reserved before the grant exists because the face-check path mints the
     * grant a round trip later, and the viewer the creator picked has to survive
     * the gap. `challengeId` is how it is found again; the unlock path, which
     * mints immediately, binds the grant in the same breath.
     *
     * A creator who reserves a second room supersedes their first, as long as
     * the first has no broadcast in it. Two open invitations from one creator
     * would mean the next phone to connect could land in either.
     *
     * @param {{creatorId: string, viewerId: string, challengeId?: string|null}} input
     * @returns {Room}
     * @throws {Error} with `.code` when the viewer is gone or already spoken for
     */
    reserve({ creatorId, viewerId, challengeId = null }) {
        this._sweep();

        const viewer = this._viewers.get(String(viewerId ?? ''));
        if (!viewer) {
            throw Object.assign(new Error('that viewer is no longer waiting'), { code: 'viewer_gone' });
        }

        if (viewer.roomId && this._rooms.get(viewer.roomId)?.open) {
            throw Object.assign(new Error('that viewer is already in a room'), { code: 'viewer_busy' });
        }

        for (const room of this._rooms.values()) {
            if (room.open && room.creatorId === creatorId && !room.sessionId) {
                this._closeRoom(room, 'superseded');
            }
        }

        const room = new Room({ creatorId, viewerId: viewer.id, challengeId });
        this._rooms.set(room.id, room);
        viewer.roomId = room.id;

        return room;
    }

    /**
     * Make a broadcast that is already running private to one account.
     *
     * The other way round from {@link reserve}: there, a creator picks somebody
     * before the camera connects and the broadcast is private from its first
     * frame. Here the broadcast exists, people are watching it, and the creator
     * has accepted one of them for a 1:1 - so the room is opened directly onto
     * the live session.
     *
     * Privacy stays intrinsic either way. `isPrivate` is still "is there an
     * open room pointing at this session", there is still no flag on the
     * session that could be wrong, and closing the room puts the broadcast back
     * exactly where it was. What changes is only *when* the creator chose.
     *
     * Disconnecting whoever is currently watching is the caller's job, not
     * this one's: rooms decide admission, and admission is re-decided when a
     * socket next knocks.
     *
     * @param {{id: string, creatorId: string|null}} session
     * @param {{creatorId: string, userId: string}} input
     * @returns {Room}
     * @throws {Error} with `.code` when the broadcast is already spoken for
     */
    takeOver(session, { creatorId, userId }) {
        this._sweep();

        if (this.roomFor(session)) {
            throw Object.assign(new Error('that broadcast is already private'), { code: 'already_private' });
        }

        const room = new Room({
            creatorId,
            viewerId: null,
            userId,
            admitToken: crypto.randomBytes(32).toString('base64url')
        });

        room.sessionId = session.id;
        this._rooms.set(room.id, room);

        return room;
    }

    /**
     * Attach the minted grant to the room reserved for it.
     *
     * This is the join. From here the phone's HELLO is enough to find the room,
     * and the phone never had to carry anything but the key.
     */
    bindGrant(room, grantId) {
        if (!room?.open) return null;
        room.grantId = grantId;
        return room;
    }

    /** Find the room parked against a face check that has just come back. */
    byChallenge(challengeId) {
        this._sweep();
        if (!challengeId) return null;

        for (const room of this._rooms.values()) {
            if (room.open && room.challengeId === challengeId) return room;
        }
        return null;
    }

    byId(id) {
        const room = this._rooms.get(String(id ?? ''));
        return room?.open ? room : null;
    }

    /**
     * Any room, open or closed, for telling its creator what became of it.
     *
     * Separate from {@link byId} on purpose. Everything that acts on a room -
     * binding a grant, admitting a socket - must not see a closed one, so the
     * lookup those paths use stays strict and this one is read-only by name.
     */
    peek(id) {
        this._sweep();
        return this._rooms.get(String(id ?? '')) ?? null;
    }

    /** The creator gave up, or picked somebody else. */
    close(room, reason = 'closed') {
        this._closeRoom(room, reason);
    }

    _closeRoom(room, reason) {
        if (!room?.open) return;

        room.closedAt = Date.now();
        room.closeReason = reason;

        const viewer = this._viewers.get(room.viewerId);
        if (viewer?.roomId === room.id) viewer.roomId = null;
    }

    /* ---------------------------------------------------------- broadcast -- */

    /** A phone connected. If its grant had a room, that room now has a broadcast. */
    _bindSession(session) {
        if (!session.grantId) return;

        for (const room of this._rooms.values()) {
            if (!room.open || room.grantId !== session.grantId) continue;

            room.sessionId = session.id;
            return;
        }
    }

    /**
     * The broadcast ended, so the room is over.
     *
     * Not reopened for the next connection. The grant is single-use, so there is
     * no next connection that could legitimately arrive - and a room that
     * outlived its broadcast would be an invitation still standing after the
     * creator thought they were finished.
     */
    _releaseSession(session) {
        for (const room of this._rooms.values()) {
            if (room.sessionId === session.id) this._closeRoom(room, 'the broadcast ended');
        }
    }

    /**
     * The room a broadcast belongs to, if any.
     *
     * Matched on the grant as well as on the session id, deliberately. Binding
     * happens on the registry's `started` event, and so does the transcoder's
     * own hook - so anything that asks this question from a `started` listener
     * would otherwise get an answer that depends on which listener was attached
     * first. The grant is set on the session before the event is emitted, which
     * makes the grant the order-independent half of the join.
     *
     * @param {{id: string, grantId?: string|null}} session
     * @returns {Room|null}
     */
    roomFor(session) {
        this._sweep();

        for (const room of this._rooms.values()) {
            if (!room.open) continue;
            if (room.sessionId === session.id) return room;
            if (session.grantId && room.grantId === session.grantId) return room;
        }
        return null;
    }

    /**
     * Is this broadcast private to somebody?
     *
     * Asked by the session list, the relay and the transcoder. A session with no
     * room is public, which is every session on a deployment that never uses
     * this.
     *
     * @param {{id: string, grantId?: string|null}} session
     */
    isPrivate(session) {
        return this.roomFor(session) !== null;
    }

    /**
     * May this socket watch this broadcast?
     *
     * The default is yes, and that is deliberate: everything that was watchable
     * before rooms existed is still watchable, and the only thing that can take
     * that away is a creator having explicitly chosen one person.
     *
     * @param {{id: string, grantId?: string|null}} session
     * @param {unknown} token - the `admit` parameter off the relay URL
     * @param {string|null} [userId] - the verified account on the socket, if any
     */
    mayWatch(session, token, userId = null) {
        const room = this.roomFor(session);
        if (!room) return true;

        // The creator is the source of the picture. Shutting the broadcaster
        // out of their own broadcast protects nobody, and a 1:1 needs them on a
        // socket to read the room and be heard in it.
        if (userId && userId === room.creatorId) return true;

        // A room opened onto a running broadcast carries its own secret; one
        // reserved from the waiting list borrows the waiting tab's.
        if (room.admitToken) return tokenMatches(token, room.admitToken);

        const viewer = this._viewers.get(room.viewerId);
        if (!viewer) return false;

        return tokenMatches(token, viewer.token);
    }
}

/**
 * Constant-time compare of two admission secrets.
 *
 * Hashed first so the comparison is over two equal-length digests - a length
 * check on the raw strings would leak the length, and `timingSafeEqual` throws
 * on a mismatch rather than returning false.
 */
function tokenMatches(presented, expected) {
    const a = crypto.createHash('sha256').update(String(presented ?? '')).digest();
    const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * The screen a viewer is sitting at, as a creator will read it.
 *
 * Coarse on purpose. The creator needs to tell one of their own windows from
 * another, which takes a browser and a platform; anything finer is a
 * fingerprint of somebody else's machine printed on a page, and the user agent
 * is the only thing available here that is not.
 */
export function describeDevice(userAgent) {
    const ua = String(userAgent ?? '');

    const platform =
        /Apple Vision/i.test(ua) ? 'Apple Vision Pro'
        : /Quest|OculusBrowser/i.test(ua) ? 'Meta Quest'
        : /iPad/i.test(ua) ? 'iPad'
        : /iPhone/i.test(ua) ? 'iPhone'
        : /Android/i.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
        : /Windows/i.test(ua) ? 'Windows'
        : /Linux/i.test(ua) ? 'Linux'
        : 'Unknown device';

    // Order matters: every one of these says "Safari" too, and Edge says
    // "Chrome" as well. Most specific first.
    const browser =
        /OculusBrowser/i.test(ua) ? 'Quest Browser'
        : /Edg\//i.test(ua) ? 'Edge'
        : /OPR\//i.test(ua) ? 'Opera'
        : /Firefox\//i.test(ua) ? 'Firefox'
        : /Chrome\//i.test(ua) ? 'Chrome'
        : /Safari\//i.test(ua) ? 'Safari'
        : null;

    return browser ? `${platform} · ${browser}` : platform;
}

/** The registry the relay, the live routes and the identity routes all talk to. */
export const rooms = new RoomRegistry();
