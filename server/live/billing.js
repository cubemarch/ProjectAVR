import { credits, creatorSettings } from '../db/index.js';
import { CLOSE_OUT_OF_CREDITS } from '../../src/live/protocol.js';

/**
 * Per-minute billing for watching a broadcast.
 *
 * A viewer pays the creator's rate for every minute they are attached, charged
 * at the start of the minute. The money moves through `credits.transfer()` like
 * everything else - two rows sharing a `ref_id`, viewer debited and creator
 * credited in one transaction - so a session that ran for forty minutes leaves
 * forty pairs of rows and no other trace. See `docs/MONETISATION.md`.
 *
 * Three decisions worth stating, because each of them is a place this could
 * have gone wrong quietly:
 *
 * **Charged in advance, per started minute.** The alternative is billing for
 * time already watched, which means a viewer who closes the tab at 59 seconds
 * owes money we have no way to collect. Charging first also makes running out
 * of credits a disconnection rather than a debt.
 *
 * **The server drives the clock.** A billing tick sent by the viewer's browser
 * is a billing tick a viewer can stop sending. The timer lives here, next to
 * the socket, and stops when the socket does.
 *
 * **One meter per account per broadcast.** A second tab attaches to the meter
 * that already exists rather than starting a second one. Two windows of the
 * same account are one person watching one stream, and billing them twice
 * would be indefensible on an invoice.
 */

/** How long a billed minute is. Overridable only so tests do not take an hour. */
const MINUTE_MS = 60_000;

/**
 * How long a viewer's start time is remembered after they stop watching.
 *
 * Long enough that "I closed the tab and came back" is the same watch, short
 * enough that the map is not a record of everyone who has ever watched.
 */
const EPOCH_TTL_MS = 6 * 60 * 60_000;

/** What a viewer can be watching in. Nothing else is accepted. */
export const MODES = ['2d', '3d'];

function normaliseMode(mode) {
    return MODES.includes(mode) ? mode : '2d';
}

/** Which side of the product a minute belongs to. Part of every minute's key. */
function scopeOf(isPrivate) {
    return isPrivate ? 'private' : 'public';
}

/**
 * What this broadcast costs, per minute, in each mode.
 *
 * `available` is not the same question as `rate`: a creator can have a 3D price
 * set and still not be offering 3D, either because they have not switched it on
 * for this side of the product or because the phone is sending one eye.
 *
 * @param {{creatorId: string|null, stereo: string}} session
 * @param {{isPrivate: boolean}} context
 */
export function ratesFor(session, { isPrivate }) {
    const pricing = creatorSettings.publicView(
        session.creatorId ? creatorSettings.byId(session.creatorId) : null
    );

    const stereo = session.stereo && session.stereo !== 'mono';
    const enabled3d = isPrivate ? pricing.private3dEnabled : pricing.public3dEnabled;

    return {
        private: isPrivate,
        '2d': {
            perMin: isPrivate ? pricing.private2dPerMin : pricing.public2dPerMin,
            available: true
        },
        '3d': {
            perMin: isPrivate ? pricing.private3dPerMin : pricing.public3dPerMin,
            available: Boolean(stereo && enabled3d)
        }
    };
}

/**
 * One account watching one broadcast, on one side of the product.
 *
 * Holds the timer and the handles for however many sockets that account has
 * open on this broadcast.
 *
 * Which minute is being charged is read off a clock, not off a counter. The
 * meter's `epoch` is the moment this viewer started paying for this broadcast,
 * and minute *n* is the nth `minuteMs` interval after it — so the key
 * `minute:<sessionId>:<viewerId>:<scope>:<n>` names a real interval of wall
 * clock rather than "the nth charge this object made". A reconnect inside a
 * minute already paid for replays that interval's key and is free; a reconnect
 * a quarter of an hour later lands on a key nobody has used. A counter would
 * have restarted at one and handed out every minute already bought, which is a
 * reconnect loop away from watching for the price of a single minute.
 *
 * `scope` is `public` or `private` and is in the key because a 1:1 turn is
 * billed at a different rate on the same session id. Without it the private
 * minutes would collide with the public ones the viewer already paid for and
 * the whole private turn would be free.
 */
class WatchMeter {
    constructor({ session, viewerId, scope, epoch, mode, rates, registry, minuteMs }) {
        this.session = session;
        this.sessionId = session.id;
        this.creatorId = session.creatorId;
        this.viewerId = viewerId;
        this.scope = scope;
        this.epoch = epoch;
        this.rates = rates;
        this.registry = registry;
        this.minuteMs = minuteMs;

        this.mode = normaliseMode(mode);

        /**
         * A mode change takes effect at the next boundary rather than now. The
         * minute in progress has been paid for at the old rate; re-pricing it
         * retroactively would mean either refunding or double-charging, and
         * both of those are worse than waiting up to sixty seconds.
         */
        this.pendingMode = this.mode;

        this.minute = 0;
        /** Carried across reconnects, so a statement is a running total. */
        this.spent = epoch.spent;
        this.startedAt = Date.now();
        this.nextChargeAt = null;

        /** @type {Set<{notify: Function, close: Function}>} */
        this.handles = new Set();
        this._timer = null;
    }

    get ratePerMin() {
        return this.rates[this.mode].perMin;
    }

    /** Which minute of this viewer's watching the clock is currently in. */
    get minuteNow() {
        return Math.floor((Date.now() - this.epoch.startedAt) / this.minuteMs) + 1;
    }

    /**
     * Charge the minute the clock is in.
     *
     * @returns {{ok: true, balance: number} | {ok: false, reason: string}}
     */
    _charge() {
        this.mode = this.pendingMode;
        const amount = this.ratePerMin;
        this.minute = this.minuteNow;
        this.nextChargeAt = this.epoch.startedAt + this.minute * this.minuteMs;

        // A creator who has not set a price for the mode being watched is
        // giving it away, and a free minute is not a ledger event.
        if (amount <= 0) return { ok: true, balance: credits.account(this.viewerId).balance };

        try {
            const moved = credits.transfer({
                fromUserId: this.viewerId,
                toUserId: this.creatorId,
                amount,
                reason: 'watch',
                refType: 'live_minute',
                refId: `${this.sessionId}:${this.scope}:${this.minute}`,
                idemKey: `minute:${this.sessionId}:${this.viewerId}:${this.scope}:${this.minute}`
            });

            // `applied: false` is a minute this viewer already bought - a
            // reconnect inside it - so it is theirs again for nothing and does
            // not go on the running total a second time. The balance that comes
            // back with a replay is the one that entry produced, which may be
            // several purchases old, so the live one is read instead.
            if (moved.applied === false) return { ok: true, balance: credits.account(this.viewerId).balance };

            this.spent += amount;
            this.epoch.spent = this.spent;

            return { ok: true, balance: moved.balance };
        } catch (err) {
            if (err.code === 'insufficient_credits') return { ok: false, reason: 'insufficient_credits' };
            throw err;
        }
    }

    /** What the viewer's player is told after every charge. */
    _statement(balance) {
        return {
            sessionId: this.sessionId,
            mode: this.mode,
            ratePerMin: this.ratePerMin,
            minute: this.minute,
            spent: this.spent,
            balance,
            // Enough for the next minute, or the last one they get.
            minutesRemaining: this.ratePerMin > 0 ? Math.floor(balance / this.ratePerMin) : null,
            nextChargeAt: this.nextChargeAt
        };
    }

    /**
     * What a viewer is told about a minute that was just charged.
     *
     * A warning always accompanies the last affordable minute, including when
     * that is the first one - a viewer who can pay for one minute and no more
     * should hear about it on the way in rather than sixty seconds later, at
     * the point where the only remaining option is to stop watching.
     */
    _eventsFor(balance) {
        const statement = this._statement(balance);
        const events = [{ event: 'charged', ...statement }];

        if (this.ratePerMin > 0 && balance < this.ratePerMin) {
            events.push({ event: 'low_balance', ...statement });
        }

        return events;
    }

    _announce(events) {
        for (const handle of this.handles) {
            for (const event of events) {
                try {
                    handle.notify(event);
                } catch {
                    /* the socket is going away; `detach` will follow */
                }
            }
        }
    }

    /**
     * Wake at the next boundary rather than one minute from now.
     *
     * A viewer who attaches forty seconds into a minute has twenty seconds of
     * it left, and a fixed interval would put every later charge out of step
     * with the intervals the keys name.
     */
    _schedule() {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._tick(), Math.max(0, this.nextChargeAt - Date.now()));
        this._timer.unref?.();
    }

    _tick() {
        const charged = this._charge();

        if (!charged.ok) {
            const balance = credits.account(this.viewerId).balance;
            this._announce([{ event: 'exhausted', ...this._statement(balance) }]);
            this.stop('out of credits', CLOSE_OUT_OF_CREDITS);
            return;
        }

        this._schedule();
        this._announce(this._eventsFor(charged.balance));
    }

    /** First minute, taken before a frame is delivered. */
    open() {
        const charged = this._charge();
        if (!charged.ok) return charged;

        this._schedule();

        return { ok: true, events: this._eventsFor(charged.balance) };
    }

    stop(reason, code = 1000) {
        clearTimeout(this._timer);
        this._timer = null;
        this.registry._forget(this);

        for (const handle of [...this.handles]) {
            this.handles.delete(handle);
            try {
                handle.close(code, reason);
            } catch {
                /* already gone */
            }
        }
    }
}

export class BillingRegistry {
    /**
     * @param {object} [opts]
     * @param {number} [opts.minuteMs] - Tests only; production is a minute.
     */
    constructor({ minuteMs = MINUTE_MS } = {}) {
        this.minuteMs = minuteMs;
        /** @type {Map<string, WatchMeter>} */
        this._meters = new Map();

        /**
         * When each viewer started paying, per broadcast and side.
         *
         * Outlives the meter on purpose: it is what makes a reconnect resume
         * the same minute numbering instead of starting again at one and being
         * handed every minute already bought. Swept lazily, since an entry is
         * two numbers and a broadcast id that will never be issued again.
         *
         * @type {Map<string, {startedAt: number, spent: number}>}
         */
        this._epochs = new Map();
    }

    _key(sessionId, viewerId, scope = 'public') {
        return `${sessionId}:${viewerId}:${scope}`;
    }

    /** Epochs are kept well past any minute they could still be inside. */
    _sweepEpochs() {
        const cutoff = Date.now() - Math.max(EPOCH_TTL_MS, this.minuteMs * 60);
        for (const [key, epoch] of this._epochs) {
            if (epoch.startedAt <= cutoff) this._epochs.delete(key);
        }
    }

    _epochFor(key) {
        let epoch = this._epochs.get(key);
        if (!epoch) {
            this._sweepEpochs();
            epoch = { startedAt: Date.now(), spent: 0 };
            this._epochs.set(key, epoch);
        }
        return epoch;
    }

    /**
     * What it would cost this account to watch, before they commit to it.
     *
     * Deliberately answerable without attaching: a price a viewer only
     * discovers by being charged is not a price they agreed to.
     *
     * @param {object} session
     * @param {{viewerId: string|null, isPrivate: boolean}} context
     */
    quote(session, { viewerId, isPrivate }) {
        const rates = ratesFor(session, { isPrivate });
        const free = this.isFree(session, { viewerId, rates });
        const balance = viewerId ? credits.account(viewerId).balance : 0;

        return {
            free,
            private: isPrivate,
            modes: {
                '2d': rates['2d'],
                '3d': rates['3d']
            },
            balance,
            // Already paying for this broadcast on another tab, so joining
            // again costs nothing new.
            attached: Boolean(viewerId && this._meters.has(this._key(session.id, viewerId, scopeOf(isPrivate))))
        };
    }

    /**
     * Is watching this free for this account?
     *
     * Three ways it can be, and the first two matter more than the third: a
     * broadcast from a deployment that has no creator account behind it (the
     * shared stream key) cannot pay anybody, and a creator watching their own
     * broadcast - the monitor page, during the setup check - must not be
     * charged for looking at themselves.
     *
     * The third is having no price on it, and that has to be asked about the
     * side of the product the socket is actually on: a free public stream with
     * a priced 1:1 behind it is an ordinary way to sell, and reading the public
     * price for a private turn would hand the private minutes away.
     */
    isFree(session, { viewerId, isPrivate = false, rates = null }) {
        if (!session.creatorId) return true;
        if (viewerId && viewerId === session.creatorId) return true;

        const priced = rates ?? ratesFor(session, { isPrivate });
        return priced['2d'].perMin <= 0 && priced['3d'].perMin <= 0;
    }

    /**
     * Start (or join) the meter for this account on this broadcast.
     *
     * @param {object} input
     * @param {object} input.session
     * @param {string} input.viewerId
     * @param {boolean} input.isPrivate
     * @param {string} input.mode
     * @param {{notify: Function, close: Function}} input.handle
     * @returns {{ok: true, meter: WatchMeter|null, events: object[]}
     *   | {ok: false, reason: string}}
     */
    attach({ session, viewerId, isPrivate, mode, handle }) {
        const rates = ratesFor(session, { isPrivate });

        if (this.isFree(session, { viewerId, rates })) return { ok: true, meter: null, events: [] };

        const scope = scopeOf(isPrivate);
        const key = this._key(session.id, viewerId, scope);
        const existing = this._meters.get(key);

        if (existing) {
            existing.handles.add(handle);
            return { ok: true, meter: existing, events: existing._eventsFor(credits.account(viewerId).balance) };
        }

        const meter = new WatchMeter({
            session,
            viewerId,
            scope,
            epoch: this._epochFor(key),
            mode,
            rates,
            registry: this,
            minuteMs: this.minuteMs
        });

        // Registered before the first charge so that two sockets racing to
        // attach cannot both create a meter and both bill minute one. The
        // idempotency key would catch the second charge anyway; this keeps it
        // from needing to.
        this._meters.set(key, meter);
        meter.handles.add(handle);

        const opened = meter.open();

        if (!opened.ok) {
            meter.handles.delete(handle);
            this._meters.delete(key);
            return { ok: false, reason: opened.reason };
        }

        return { ok: true, meter, events: opened.events };
    }

    /**
     * A socket closed. The meter stops when the last one does.
     */
    detach(meter, handle) {
        if (!meter) return;

        meter.handles.delete(handle);
        if (meter.handles.size === 0) meter.stop('viewer left');
    }

    /**
     * Switch a viewer between 2D and 3D.
     *
     * Over HTTP rather than up the relay socket. The socket does now carry
     * chat and talkback the other way, but both of those are fire-and-forget:
     * this one changes what somebody is charged and the page has to be told
     * whether it worked, so it wants a status code, not a frame that may have
     * been dropped for backpressure. Takes effect at the next minute boundary.
     *
     * @returns {{ok: true, mode: string, ratePerMin: number} | {ok: false, reason: string}}
     */
    setMode(sessionId, viewerId, mode) {
        const wanted = normaliseMode(mode);
        const meter = this.meterFor(sessionId, viewerId);

        if (!meter) return { ok: false, reason: 'not_watching' };
        if (!meter.rates[wanted].available) return { ok: false, reason: 'mode_unavailable' };

        meter.pendingMode = wanted;
        return { ok: true, mode: wanted, ratePerMin: meter.rates[wanted].perMin };
    }

    /**
     * The meter this account is being billed on for this broadcast.
     *
     * Private first: a viewer who has been taken into a 1:1 is on the private
     * meter, and a public one for the same broadcast can only be a leftover
     * that has not finished closing.
     *
     * @returns {WatchMeter|undefined}
     */
    meterFor(sessionId, viewerId) {
        return (
            this._meters.get(this._key(sessionId, viewerId, 'private')) ??
            this._meters.get(this._key(sessionId, viewerId, 'public'))
        );
    }

    _forget(meter) {
        const key = this._key(meter.sessionId, meter.viewerId, meter.scope);
        if (this._meters.get(key) === meter) this._meters.delete(key);
    }

    /**
     * Tests and shutdown.
     *
     * Nothing else needs to sweep: a broadcast ending closes every subscriber
     * socket, and the relay detaches the meter as each one goes. The meter
     * outliving its session would mean the socket did too.
     */
    clear() {
        for (const meter of [...this._meters.values()]) meter.stop('shutting down');
        this._meters.clear();
        this._epochs.clear();
    }

    get size() {
        return this._meters.size;
    }
}

/** The registry the relay and the live routes both talk to. */
export const billing = new BillingRegistry();
