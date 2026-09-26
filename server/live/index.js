import express from 'express';

import { sessions } from './sessions.js';
import { rooms, describeDevice, VIEWER_POLL_MS } from './rooms.js';
import { readiness, previewableSession, CHECK_KINDS, PREVIEW_POLL_MS } from './readiness.js';
import { billing } from './billing.js';
import { chat } from './chat.js';
import { privateTurns } from './private.js';
import { recorders, viewerConsent } from './recording.js';
import { IngestServer, getStreamKey, isStreamKeyPinned } from './ingest.js';
import { LiveRelay } from './relay.js';
import { DiscoveryBeacon, DISCOVERY_PORT } from './discovery.js';
import { lanAddress } from '../dlna.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { identityEnforced } from '../identity/providers.js';
import { playlistFor } from '../transcode/index.js';
import { recordingView } from '../routes/recordings.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from '../../src/live/protocol.js';

/**
 * Live subsystem wiring.
 *
 * Three listeners, two registries:
 *
 *   TCP  :8081   phones push encoded frames in
 *   WS   /live/ws/:id   browsers and headsets pull them out
 *   UDP  :8082   "is there a ProjectAVR on this network?"
 *
 * Unlike the rest of the app tier this is *not* stateless, and cannot be: a
 * session exists because a socket is open to this specific process. That is
 * why live sessions are absent from `buildLibrary()` and get their own
 * endpoints instead - folding an inherently node-local thing into the catalog
 * would quietly break the property the README makes the most of, which is that
 * any node can answer any catalog request.
 *
 * The second registry is `rooms.js`, which holds waiting viewers and the pairing
 * between a chosen viewer and the broadcast a creator is about to start. It is
 * node-local for exactly the same reason and inherits the same constraint.
 */

const INGEST_PORT = Number(process.env.AVR_LIVE_PORT || 8081);
const ENABLE_LIVE = process.env.AVR_LIVE !== '0';

/**
 * Only the first cluster worker binds the ingest and discovery ports - they
 * are single-owner sockets, the same constraint SSDP has.
 */
const IS_PRIMARY_WORKER = (process.env.AVR_WORKER_INDEX ?? '0') === '0';

let ingest = null;
let relay = null;
let beacon = null;

/**
 * REST surface for the live subsystem.
 *
 * @param {import('express').Express} app
 */
export function mountLive(app) {
    const router = express.Router();

    // Per-route rather than router-wide: everything else here is a GET, and the
    // three bodies below are an id and a token. 4 kB is two orders of magnitude
    // more than any of them needs.
    const json = express.json({ limit: '4kb' });

    /**
     * Everything currently broadcasting that anybody may watch.
     *
     * A broadcast a creator started for one chosen viewer is absent from here.
     * That is not the security control - the relay is, and it checks the
     * admission secret - but a private broadcast appearing in a public list with
     * its id next to it would advertise both that it exists and what to aim at.
     *
     * Explicitly uncached: a five-second TTL of the kind the catalog uses would
     * mean a viewer waits five seconds to see a stream that is already running,
     * and the list is at most a handful of objects.
     */
    router.get('/sessions', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({
            sessions: sessions
                .list()
                .filter((session) => !rooms.isPrivate(session))
                .map(describe),
            relayPathTemplate: '/live/ws/{sessionId}'
        });
    });

    router.get('/sessions/:id', (req, res) => {
        const session = sessions.get(req.params.id);

        // 404 rather than 403 for a private one. The admitted viewer reaches its
        // broadcast through the room, never by looking a session up by id, so
        // there is no caller this costs and no existence to confirm.
        if (!session || rooms.isPrivate(session)) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json(describe(session));
    });

    /* ----------------------------------------------------- the waiting room -- */

    /**
     * Join the waiting list.
     *
     * Signed in only, and that is the entry requirement rather than an
     * implementation detail: the list is something a creator reads and picks a
     * person off, so every row has to be an account with a name. An
     * unauthenticated visitor still gets the monitor page and the public
     * broadcast list - they simply cannot put a row in front of a creator.
     *
     * The response carries a secret. It is the only time it is sent, it is held
     * in the page's memory, and it is what the relay checks when the page later
     * connects to a private broadcast. The `viewerId` beside it is not a
     * substitute: creators are shown viewer ids, so a viewer id cannot also be
     * the thing that admits you.
     */
    router.post('/waiting', requireAuth, json, (req, res) => {
        let viewer;
        try {
            viewer = rooms.register({
                userId: req.auth.sub,
                name: req.auth.name || 'Signed-in viewer',
                device: describeDevice(req.get('user-agent'))
            });
        } catch (err) {
            res.status(429).json({ error: err.message, code: err.code ?? null });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.status(201).json({
            viewerId: viewer.id,
            admitToken: viewer.token,
            name: viewer.name,
            device: viewer.device,
            pollAfterMs: VIEWER_POLL_MS
        });
    });

    /**
     * Check in, and find out whether anybody has chosen you.
     *
     * One call for both because they are one question asked from two ends: the
     * page wants to know if it has been admitted, and the list wants to know if
     * the page is still open. A viewer that stops calling drops off the list
     * within seconds, which is the only thing keeping the creator's list honest.
     */
    router.post('/waiting/:id', requireAuth, json, (req, res) => {
        const state = rooms.statusOf(req.params.id, req.body?.admitToken);

        res.set('Cache-Control', 'no-store');

        // A lapsed registration is not an error - the page simply registers
        // again - so it comes back as a status rather than a 404 the client has
        // to special-case in a catch block.
        res.json({ ...state, pollAfterMs: VIEWER_POLL_MS });
    });

    /**
     * The tab is closing.
     *
     * Best effort. `sendBeacon` cannot set an Authorization header, so this is
     * the one endpoint here that authorises on the admission secret alone -
     * which is sufficient, because the only thing it can do is remove the row
     * that secret belongs to.
     */
    router.post('/waiting/:id/leave', json, (req, res) => {
        rooms.forget(req.params.id, req.body?.admitToken);
        res.status(204).end();
    });

    /**
     * Who is waiting, for a creator about to choose one.
     *
     * Names and screens, nothing else. A creator has to be able to tell Dana's
     * headset from Dana's laptop, which takes a display name and a coarse device
     * string; an email address, an IP or a precise user agent would each be
     * somebody else's personal data printed on a page to solve a problem that
     * two words already solve.
     */
    router.get('/waiting', requireRole('creator'), (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ viewers: rooms.waiting() });
    });

    /**
     * How a room a creator opened is getting on.
     *
     * The creator's own end of the poll above: it answers "has the phone
     * connected yet", and after the broadcast ends it answers why the room
     * closed. Scoped to the creator who reserved it - a room id is six
     * characters and identifies a named person's screen, so it is not something
     * any signed-in creator should be able to walk.
     */
    router.get('/rooms/:id', requireRole('creator'), (req, res) => {
        const room = rooms.peek(req.params.id);

        if (!room || room.creatorId !== req.auth.sub) {
            res.status(404).json({ error: 'no such room' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            room: room.publicView(),
            closeReason: room.closeReason,
            pollAfterMs: VIEWER_POLL_MS
        });
    });

    /* -------------------------------------------------------------- watching -- */

    /**
     * What this broadcast costs, before committing to watching it.
     *
     * Asked by the player on the way in, and the answer is what the confirm
     * dialog shows. A price a viewer only finds out about by being charged is
     * not a price they agreed to, so this is a real endpoint rather than a
     * field the home page happens to carry.
     */
    router.get('/watch/:id', (req, res) => {
        const session = sessions.get(req.params.id);

        if (!session || !session.live) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        const isPrivate = rooms.isPrivate(session);

        // A private broadcast is not confirmed to exist to anybody but the
        // viewer it was opened for - the same 404 the relay and the session
        // list give. The quote is the last place that rule could leak from.
        const viewerId = req.auth?.sub ?? null;

        if (isPrivate && !rooms.mayWatch(session, req.query.admit, viewerId)) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            quote: billing.quote(session, { viewerId, isPrivate }),
            // In the same answer because it is the same question: the player
            // needs both what watching costs and whether asking for a 1:1 is
            // even on offer before it can draw its controls.
            oneToOne: privateTurns.quote(session, viewerId)
        });
    });

    /**
     * Switch between 2D and 3D mid-broadcast.
     *
     * Over HTTP rather than up the relay socket. What a viewer may send on that
     * socket is chat and talkback, and both are droppable by design; this
     * changes what they are charged, so it needs an answer the page can act on.
     * The new rate applies from the next minute boundary - the minute in
     * progress has been paid for, and re-pricing it would mean refunding or
     * double-charging.
     */
    router.post('/watch/:id/mode', requireAuth, json, (req, res) => {
        const changed = billing.setMode(req.params.id, req.auth.sub, req.body?.mode);

        if (!changed.ok) {
            const status = changed.reason === 'not_watching' ? 404 : 409;
            res.status(status).json({ error: changed.reason });
            return;
        }

        res.json(changed);
    });

    /* ------------------------------------------------------------ one to one -- */

    /**
     * Ask the creator of this broadcast for a private turn.
     *
     * Idempotent: asking again returns the request already standing rather than
     * putting a second row in front of the creator. The refusals are all things
     * the asker can act on, so each one comes back by name.
     */
    router.post('/watch/:id/private', requireAuth, json, (req, res) => {
        const session = sessions.get(req.params.id);

        if (!session || !session.live) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        const asked = privateTurns.request({
            session,
            viewer: { id: req.auth.sub, name: req.auth.name || 'Someone' }
        });

        if (!asked.ok) {
            const status =
                asked.reason === 'insufficient_credits' ? 402
                : asked.reason === 'too_many_requests' ? 429
                : 409;
            res.status(status).json({ error: asked.reason });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({ request: asked.request.privateView() });
    });

    /**
     * Where the asker's own request stands.
     *
     * The answer normally arrives on the socket as a PRIVATE frame, but an
     * acceptance lands in the same instant as the close that evicts everybody -
     * so this is the path that is always there, and it carries the admission
     * secret the page reconnects with.
     */
    router.get('/watch/:id/private', requireAuth, (req, res) => {
        const session = sessions.get(req.params.id);

        if (!session) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({ oneToOne: privateTurns.quote(session, req.auth.sub) });
    });

    /** Everyone asking this creator for a 1:1 right now. */
    router.get('/broadcasts/:id/requests', requireRole('creator'), (req, res) => {
        const session = sessions.get(req.params.id);

        if (!session || session.creatorId !== req.auth.sub) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            requests: privateTurns.pending(session.id).map((r) => r.publicView()),
            private: rooms.isPrivate(session),
            pollAfterMs: VIEWER_POLL_MS
        });
    });

    /**
     * Take one of them, and empty the room.
     *
     * Everything that makes this a private broadcast happens inside
     * `accept()` - the room, the admission secret, the disconnection of
     * everyone watching. The response is only what the creator's page needs to
     * redraw.
     */
    router.post('/private/:requestId/accept', requireRole('creator'), json, (req, res) => {
        const request = privateTurns.byId(req.params.requestId);
        const taken = privateTurns.accept(request, req.auth.sub);

        if (!taken.ok) {
            const status = taken.reason === 'not_pending' || taken.reason === 'not_yours' ? 404 : 409;
            res.status(status).json({ error: taken.reason });
            return;
        }

        // The admission secret is not in here. It went to the person it admits.
        res.json({ room: taken.room.publicView() });
    });

    router.post('/private/:requestId/decline', requireRole('creator'), json, (req, res) => {
        const declined = privateTurns.decline(privateTurns.byId(req.params.requestId), req.auth.sub);

        if (!declined.ok) {
            res.status(404).json({ error: declined.reason });
            return;
        }

        res.json({ ok: true });
    });

    router.post('/private/:requestId/cancel', requireAuth, json, (req, res) => {
        const cancelled = privateTurns.cancel(privateTurns.byId(req.params.requestId), req.auth.sub);

        if (!cancelled.ok) {
            res.status(404).json({ error: cancelled.reason });
            return;
        }

        res.json({ ok: true });
    });

    /**
     * End the turn. Either of them may, and the route is the same one.
     *
     * A viewer whose only way out of a room they are paying for is to close the
     * tab is a viewer being held in it.
     */
    router.post('/watch/:id/private/end', requireAuth, json, (req, res) => {
        const session = sessions.get(req.params.id);

        if (!session || !session.live) {
            res.status(404).json({ error: 'no such broadcast' });
            return;
        }

        const ended = privateTurns.end(session, req.auth.sub);

        if (!ended.ok) {
            res.status(ended.reason === 'not_private' ? 409 : 403).json({ error: ended.reason });
            return;
        }

        // The recording stops with the conversation whoever ended it, and the
        // permission the viewer was given expires with it. Awaiting the stop
        // would hold the response open for FFmpeg's shutdown and the upload;
        // the row is updated either way and the creator's list reflects it.
        recorders.stop(session.id, 'the private turn ended').catch(() => {});
        viewerConsent.clear(session.id);

        res.json({ ok: true });
    });

    /* ------------------------------------------------------------- recording -- */

    /**
     * Who is in this room, and which side is asking.
     *
     * Recording is a property of a 1:1 and of nothing else. A public broadcast
     * has an audience rather than a counterparty, and there is nobody in it to
     * ask.
     */
    function inRoom(req, res) {
        const session = sessions.get(req.params.id);

        if (!session || !session.live) {
            res.status(404).json({ error: 'no such broadcast' });
            return null;
        }

        const room = rooms.roomFor(session);

        if (!room) {
            res.status(409).json({ error: 'not_private' });
            return null;
        }

        const userId = req.auth.sub;

        if (userId !== room.creatorId && userId !== room.userId) {
            res.status(403).json({ error: 'not_yours' });
            return null;
        }

        return { session, room, userId, isCreator: userId === room.creatorId };
    }

    /**
     * The state of both recordings, from whichever side is asking.
     *
     * The creator is told about theirs, which this server is making, and about
     * a question waiting for them. The viewer is told what they are permitted
     * to do in their own browser, which is the only place their recording
     * exists.
     */
    router.get('/watch/:id/recording', requireAuth, (req, res) => {
        const ctx = inRoom(req, res);
        if (!ctx) return;

        res.set('Cache-Control', 'no-store');

        if (ctx.isCreator) {
            res.json({
                mine: recorders.stateFor(ctx.session.id),
                available: recorders.available,
                policy: viewerConsent.policyFor(ctx.room.creatorId),
                asked: viewerConsent.pending(ctx.session.id),
                pollAfterMs: VIEWER_POLL_MS
            });
            return;
        }

        res.json({
            viewer: viewerConsent.stateFor(ctx.session, ctx.userId),
            creatorRecording: recorders.isRecording(ctx.session.id),
            pollAfterMs: VIEWER_POLL_MS
        });
    });

    /**
     * Start the creator's recording.
     *
     * Nobody is asked, because there is nobody in the file to ask. What this
     * records is what the phone sent - the creator's own picture and voice -
     * and the viewer's audio travels the other way and never reaches it. The
     * viewer is told it is happening all the same, through the poll above: a
     * recording light is not consent but it is not nothing either.
     */
    router.post('/watch/:id/recording/start', requireRole('creator'), json, async (req, res) => {
        const ctx = inRoom(req, res);
        if (!ctx) return;

        if (!ctx.isCreator) {
            res.status(403).json({ error: 'not_yours' });
            return;
        }

        const started = await recorders.start({
            session: ctx.session,
            creatorId: ctx.userId,
            roomId: ctx.room.id
        });

        if (!started.ok) {
            res.status(started.reason === 'recording_unavailable' ? 503 : 409).json({ error: started.reason });
            return;
        }

        res.json({ id: started.id, mine: recorders.stateFor(ctx.session.id) });
    });

    /**
     * Stop it, finalise the file and store it.
     *
     * Awaited, unlike the stop on the way out of a turn: a creator who pressed
     * stop is waiting to be told whether they have a recording, and "it is in
     * your list" is only true once the row says `ready`.
     */
    router.post('/watch/:id/recording/stop', requireRole('creator'), json, async (req, res) => {
        const ctx = inRoom(req, res);
        if (!ctx) return;

        const stopped = await recorders.stop(ctx.session.id, 'stopped by the creator');

        if (!stopped.ok) {
            res.status(stopped.reason === 'not_recording' ? 409 : 500).json({ error: stopped.reason });
            return;
        }

        res.json({ recording: recordingView(stopped.recording) });
    });

    /** The viewer asks to record. Answered from the profile, or by the creator. */
    router.post('/watch/:id/recording/consent', requireAuth, json, (req, res) => {
        const ctx = inRoom(req, res);
        if (!ctx) return;

        if (ctx.isCreator) {
            res.status(409).json({ error: 'not_the_viewer' });
            return;
        }

        const asked = viewerConsent.ask(ctx.session, ctx.userId);

        if (!asked.ok) {
            res.status(403).json({ error: asked.reason });
            return;
        }

        res.json({ viewer: viewerConsent.stateFor(ctx.session, ctx.userId) });
    });

    router.post('/watch/:id/recording/consent/answer', requireRole('creator'), json, (req, res) => {
        const ctx = inRoom(req, res);
        if (!ctx) return;

        const answered = viewerConsent.answer(ctx.session, ctx.userId, req.body?.allow === true);

        if (!answered.ok) {
            res.status(answered.reason === 'nothing_asked' ? 409 : 403).json({ error: answered.reason });
            return;
        }

        res.json({ asked: viewerConsent.pending(ctx.session.id) });
    });

    /* --------------------------------------------------------- setup checks -- */

    /**
     * What this creator has confirmed so far this sign-in.
     *
     * Two checks, and the client uses this to decide which one to put in front
     * of them: a standard one before they can go on air at all, and a separate
     * one for 3D. See `readiness.js` for why the answer is per-session and not
     * stored.
     */
    router.get('/checks', requireRole('creator'), (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ checks: readiness.stateOf(req.auth.sub) });
    });

    /**
     * The broadcast the check should be putting on the screen.
     *
     * Polled by the profile page while a check is running: first to find out
     * whether a camera has connected at all, then for the id the preview opens
     * a relay socket to. Watching it costs the creator nothing - `billing`
     * exempts a creator from their own broadcast explicitly.
     *
     * `attributed` is the honest part. See `previewableSession()`.
     */
    router.get('/checks/preview', requireRole('creator'), (req, res) => {
        const found = previewableSession(sessions.list(), {
            creatorId: req.auth.sub,
            allowUnattributed: !identityEnforced(),
            isPrivate: (session) => rooms.isPrivate(session)
        });

        res.set('Cache-Control', 'no-store');

        if (!found) {
            res.json({ preview: null, reason: 'no_broadcast', pollAfterMs: PREVIEW_POLL_MS });
            return;
        }

        const { session, attributed } = found;

        res.json({
            preview: {
                sessionId: session.id,
                attributed,
                name: session.name,
                device: session.device,
                mode: session.mode,
                projection: session.projection,
                stereo: session.stereo,
                fisheyeFov: session.fisheyeFov,
                // Two eyes are arriving, as opposed to two eyes being claimed.
                // What gates the 3D confirmation, here and in the POST below.
                carryingStereo: session.carryingStereo,
                startedAt: session.startedAt,
                relayPath: `/live/ws/${session.id}`
            },
            pollAfterMs: PREVIEW_POLL_MS
        });
    });

    /**
     * Record a check the creator just completed.
     *
     * The confirmation is the creator's, not the server's: they are shown their
     * own outgoing picture and asked whether it is right. That is the only
     * thing that can answer "is the stereo pair the right way round", which is
     * the failure the 3D check exists to catch and which no automated probe
     * detects - a swapped pair is a valid, well-formed, entirely wrong stream.
     *
     * What the server can answer is whether there was anything to look at. A
     * confirmation with no broadcast running is not a weak check, it is a
     * statement about nothing, and it used to be accepted - so both refusals
     * below exist to keep the button honest rather than to second-guess the
     * person pressing it. The 3D one additionally requires that two eyes really
     * did arrive, because everything past that point is a judgement only a
     * human looking at the pair can make.
     */
    router.post('/checks/:kind', requireRole('creator'), json, (req, res) => {
        if (!CHECK_KINDS.includes(req.params.kind)) {
            res.status(404).json({ error: 'no such check' });
            return;
        }

        if (req.body?.confirmed !== true) {
            res.status(400).json({ error: 'the check is only passed by confirming it' });
            return;
        }

        const found = previewableSession(sessions.list(), {
            creatorId: req.auth.sub,
            allowUnattributed: !identityEnforced(),
            isPrivate: (session) => rooms.isPrivate(session)
        });

        if (!found) {
            res.status(409).json({
                error: 'there is no broadcast to confirm - start one from the capture app',
                code: 'no_broadcast'
            });
            return;
        }

        if (req.params.kind === 'spatial' && !found.session.carryingStereo) {
            res.status(409).json({
                error: 'this broadcast is sending one eye - switch the capture app to Stereo Side-by-Side',
                code: 'not_stereo'
            });
            return;
        }

        res.json({
            checks: readiness.pass(req.auth.sub, req.params.kind),
            // Which broadcast was confirmed, so a page that has been open a
            // while can tell it confirmed the one it was showing.
            sessionId: found.session.id
        });
    });

    /**
     * Pairing details for the capture app.
     *
     * Creator-gated, because it hands out the stream key. Discovery is public
     * and tells you a server is there; this is what lets you publish to it.
     */
    router.get('/pairing', requireRole('creator'), (req, res) => {
        const host = lanAddress();

        res.set('Cache-Control', 'no-store');

        // Under identity enforcement the shared key authorises nothing, and
        // handing it out would tell the capture app it is paired when its next
        // HELLO will be refused. Pairing then carries the address only; the key
        // is a per-creator stream key the app gets from a destination link.
        if (identityEnforced()) {
            res.json({
                protocol: PROTOCOL_NAME,
                version: PROTOCOL_VERSION,
                host,
                ingestPort: INGEST_PORT,
                httpPort: Number(process.env.PORT || 8080),
                discoveryPort: DISCOVERY_PORT,
                key: null,
                pinned: false,
                identityRequired: true,
                pairingUrl: `avr://pair?host=${encodeURIComponent(host)}&port=${INGEST_PORT}&identity=1`
            });
            return;
        }

        res.json({
            identityRequired: false,
            protocol: PROTOCOL_NAME,
            version: PROTOCOL_VERSION,
            host,
            ingestPort: INGEST_PORT,
            httpPort: Number(process.env.PORT || 8080),
            discoveryPort: DISCOVERY_PORT,
            key: getStreamKey(),
            pinned: isStreamKeyPinned(),
            // One scannable string for the capture app, so nobody types an IP
            // and a 16-character key into a phone by hand.
            pairingUrl: `avr://pair?host=${encodeURIComponent(host)}&port=${INGEST_PORT}&key=${encodeURIComponent(getStreamKey())}`
        });
    });

    app.use('/api/live', router);
}

/**
 * A session as the API reports it: its own summary plus the two ways to watch.
 *
 * The relay path is always present because the relay is always running. `hls`
 * is null until FFmpeg has written a playlist, which takes a second or two
 * after the broadcast starts - a client should fall back to the relay rather
 * than wait for it.
 */
function describe(session) {
    return {
        ...session.summary(),
        relayPath: `/live/ws/${session.id}`,
        hls: playlistFor(session.id)
    };
}

/**
 * Start the listeners and attach the relay.
 *
 * @param {import('node:http').Server} server - The app's HTTP server.
 */
export function startLive(server) {
    if (!ENABLE_LIVE) return;

    // The relay rides the HTTP server, so every worker can serve viewers.
    relay = new LiveRelay();
    relay.attach(server);

    if (!IS_PRIMARY_WORKER) return;

    ingest = new IngestServer({ port: INGEST_PORT });
    ingest.start();

    beacon = new DiscoveryBeacon({
        httpPort: Number(process.env.PORT || 8080),
        ingestPort: INGEST_PORT
    });
    beacon.start();
}

export function stopLive() {
    sessions.closeAll('server shutting down');
    billing.clear();
    chat.clear();
    privateTurns.clear();
    rooms.detach();
    ingest?.stop();
    beacon?.stop();
    relay?.detach();
    ingest = relay = beacon = null;
}

/** Lines for the startup banner. */
export function liveBanner() {
    if (!ENABLE_LIVE) return [];

    const lines = [[`Live ingest`, `tcp://${lanAddress()}:${INGEST_PORT}  (iPhone capture app)`]];

    if (IS_PRIMARY_WORKER) {
        if (identityEnforced()) {
            lines.push([`Stream key`, 'disabled - each creator holds their own, issued behind a face check']);
        } else {
            lines.push([`Stream key`, isStreamKeyPinned() ? '(pinned via AVR_LIVE_KEY)' : getStreamKey()]);
        }
    }

    return lines;
}

export { sessions, rooms };
