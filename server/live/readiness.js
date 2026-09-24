import { EventEmitter } from 'node:events';

/**
 * Stream setup checks.
 *
 * Before a creator can go on air they confirm their stream is actually working,
 * once per sign-in. Sending 3D is a second, separate confirmation, because a
 * rig that produces a perfectly good flat picture can still be sending a
 * mis-paired stereo view that looks wrong in a headset and fine on a laptop -
 * and the person who finds out is the paying viewer.
 *
 * Deliberately in memory and deliberately not persisted. "Once per sign-in" is
 * a statement about this session, not about this account: a check that survived
 * a restart would be a check the creator did on equipment they may no longer be
 * sitting in front of. Node-local, single-process, exactly like
 * `sessions.js` and `rooms.js`.
 */

/**
 * How long a check stands before it has to be done again.
 *
 * A ceiling rather than the main mechanism - signing out clears it, and most
 * checks die with the process. This is for the laptop left signed in for a
 * week, where "you confirmed this on Monday" is not an answer about today.
 */
const CHECK_TTL_MS = Number(process.env.AVR_STREAM_CHECK_TTL || 12 * 3600) * 1000;

/** The two kinds of confirmation, and nothing else is accepted. */
export const CHECK_KINDS = ['standard', 'spatial'];

/**
 * How often a creator waiting for their own camera should ask again.
 *
 * The answer changes when a phone connects, which is a human walking across a
 * room, so this is tuned for "the picture appears about when they look back at
 * the screen" rather than for minimising requests.
 */
export const PREVIEW_POLL_MS = 2000;

/**
 * Which broadcast a setup check should be showing this creator.
 *
 * The check is a person looking at their own outgoing picture and saying
 * whether it is right, so the first job is finding the picture. Two cases, and
 * the difference between them is worth carrying all the way to the screen:
 *
 *   **Attributed.** The broadcast came in on a per-creator grant, so the server
 *   knows whose camera it is. The creator is confirming their own stream and
 *   the confirmation means what it says.
 *
 *   **Unattributed.** The deployment is still on the shared stream key, which
 *   identifies a device and not a person. Every phone presents the same secret,
 *   so there is no way to prove the camera that just connected belongs to the
 *   creator looking at this page - only that *a* camera did. Refusing to show
 *   it would make the check impossible on every development install; showing it
 *   silently would dress a guess up as a fact. So it is shown and flagged, and
 *   the page says so in as many words.
 *
 * Another creator's attributed broadcast is never returned under either case.
 *
 * @param {Array<{live: boolean, creatorId: string|null, startedAt: number}>} list
 * @param {object} opts
 * @param {string|null} opts.creatorId - Who is asking.
 * @param {boolean} [opts.allowUnattributed] - Whether the shared stream key is
 *   still in use. False under identity enforcement, where every broadcast
 *   carries a creator and an unattributed one should not exist.
 * @param {(session: object) => boolean} [opts.isPrivate] - A 1:1 belonging to
 *   somebody else, which is the one unattributed broadcast not to hand over.
 * @returns {{session: object, attributed: boolean}|null}
 */
export function previewableSession(list, { creatorId, allowUnattributed = false, isPrivate = () => false } = {}) {
    const newest = (candidates) => candidates.sort((a, b) => b.startedAt - a.startedAt)[0];

    const live = list.filter((session) => session.live);

    const mine = creatorId ? live.filter((session) => session.creatorId === creatorId) : [];
    if (mine.length) return { session: newest(mine), attributed: true };

    if (!allowUnattributed) return null;

    const shared = live.filter((session) => !session.creatorId && !isPrivate(session));
    if (shared.length) return { session: newest(shared), attributed: false };

    return null;
}

export class ReadinessRegistry extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, {standard: number|null, spatial: number|null}>} */
        this._checks = new Map();
    }

    _row(userId) {
        const id = String(userId ?? '');
        if (!this._checks.has(id)) this._checks.set(id, { standard: null, spatial: null });
        return this._checks.get(id);
    }

    _fresh(at) {
        return typeof at === 'number' && at + CHECK_TTL_MS > Date.now();
    }

    /** Record a completed check. */
    pass(userId, kind) {
        if (!CHECK_KINDS.includes(kind)) {
            throw Object.assign(new Error(`unknown check: ${kind}`), { code: 'unknown_check' });
        }

        const row = this._row(userId);
        row[kind] = Date.now();
        this.emit('passed', { userId: String(userId), kind });
        return this.stateOf(userId);
    }

    /**
     * Forget everything this account has confirmed.
     *
     * Called on sign-in, which is what makes the check per-session: the new
     * session starts owing both confirmations regardless of what the last one
     * did. Also called on sign-out, so a shared machine does not hand the next
     * person a creator who is already cleared to broadcast.
     */
    reset(userId) {
        this._checks.delete(String(userId ?? ''));
    }

    stateOf(userId) {
        const row = this._checks.get(String(userId ?? '')) ?? { standard: null, spatial: null };

        return {
            standard: this._fresh(row.standard),
            spatial: this._fresh(row.spatial),
            standardAt: this._fresh(row.standard) ? new Date(row.standard).toISOString() : null,
            spatialAt: this._fresh(row.spatial) ? new Date(row.spatial).toISOString() : null
        };
    }

    /** May this creator go on air at all? */
    mayBroadcast(userId) {
        return this.stateOf(userId).standard;
    }

    /**
     * May this creator offer 3D?
     *
     * Both checks, not just the spatial one: the spatial check confirms the
     * stereo pair, and the standard check confirms there is a working stream to
     * pair. A creator who somehow has the second without the first has not
     * demonstrated the thing.
     */
    maySendSpatial(userId) {
        const state = this.stateOf(userId);
        return state.standard && state.spatial;
    }

    /**
     * Every creator whose standard check is still good.
     *
     * The home page's "ready" list. Expired rows are dropped as they are found
     * rather than on a timer: the set is small, this is the only thing that
     * walks it, and a sweep would be a second place for the TTL to be decided.
     *
     * @returns {string[]}
     */
    readyCreators() {
        const ready = [];

        for (const [userId, row] of this._checks) {
            if (this._fresh(row.standard)) ready.push(userId);
            else if (!this._fresh(row.spatial)) this._checks.delete(userId);
        }

        return ready;
    }

    /** Tests only. */
    clear() {
        this._checks.clear();
    }
}

export const readiness = new ReadinessRegistry();
