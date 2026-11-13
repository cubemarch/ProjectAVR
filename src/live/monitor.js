import './live.css';

import { api } from '../api/client.js';
import { authModal } from '../ui/auth-modal.js';
import { LiveConnection, fetchSessions } from './connection.js';
import { StereoPipeline, webCodecsSupport } from './decoder.js';
import { AudioPlayer, audioCodecsAvailable } from './audio.js';
import { StereoView, LAYOUT, PROJECTION } from './stereo-view.js';
import { formatSummary } from '../catalog/media-format.js';
import { dollars as formatCredits } from '../ui/money.js';
import { Talkback, TALKBACK_STATE } from './talkback.js';
import { ViewerRecorder } from './recorder.js';
import { injectContentsquareScript } from '@contentsquare/tag-sdk';

// The same Contentsquare tag as `src/main.js` — this is the other entry point.
injectContentsquareScript({ clientId: '2e3ccfd49a95d' });
import { TRACK, trackName } from './protocol.js';

/**
 * The receiving end: a standalone page that joins a broadcast, decodes both
 * eyes and puts them on screen.
 *
 * Kept out of the main SPA on purpose. This page holds two hardware decoders
 * and a WebGL context and does nothing else, and a director watching a shot
 * should not also be carrying the catalog, the creator portal and the
 * PlayCanvas engine. It is also the page most likely to be opened on a headset
 * and left running.
 */

const POLL_INTERVAL_MS = 3000;

/** Fallback cadence for the seat poll; the server sends its own in every reply. */
const SEAT_POLL_MS = 4000;

/**
 * How often the 1:1 side is re-read.
 *
 * Both ends are told on their socket the moment anything happens, so this is
 * the safety net rather than the mechanism: the one message that cannot be
 * relied on is the acceptance, which is sent in the same instant as the close
 * that evicts the person it was sent to.
 */
const PRIVATE_POLL_MS = 4000;

/** Lines kept in the room pane. The server replays fifty on join. */
const CHAT_LINES = 200;

/** Whether this browser wants the stereographer's controls. Off by default. */
const TOOLS_KEY = 'avr.live.tools';

const el = (id) => document.getElementById(id);

class Monitor {
    constructor() {
        this.connection = null;
        this.pipeline = null;
        this.audio = null;
        this.view = null;

        this.sessionId = null;
        this.session = null;

        // What this broadcast costs and what it has cost so far. Both null for
        // a free one, which is what hides the strip in the stage bar.
        this.quote = null;
        this.billing = null;
        /** Which rate the viewer is being billed at, not which layout is drawn. */
        this.mode = '2d';

        this.projectionOverride = null;
        this.stats = { arrivals: [], pipelineMs: 0, lastPresentAt: 0, presented: 0 };

        // The waiting room. `seatToken` is the admission secret; it is held here
        // and nowhere else - not in storage, not in the URL the page shows - and
        // it is the only thing that gets a socket onto a private broadcast.
        this.seat = null;
        this.seatToken = null;
        this.seatState = null;

        // The room, and the way out of it into a private one.
        //
        // `admit` is the secret that got this socket onto a private broadcast -
        // held here and nowhere else, like the seat token, and dropped the
        // moment the turn ends. `hosting` is whether this is the viewer's own
        // broadcast, which is what decides whether they are asking for a 1:1 or
        // being asked.
        this.admit = null;
        this.oneToOne = null;
        this.hosting = false;
        this.requests = [];

        // The microphone, which only exists inside a 1:1 and is thrown away
        // with the socket it belonged to. Null means the person has not asked
        // for it once on this broadcast, which is not the same as off.
        this.talkback = null;

        // Recording, which is two unrelated things wearing one word. `recording`
        // is the polled state of the creator's, which this server makes and the
        // viewer is merely told about. `recorder` is the viewer's own, which is
        // made here out of the canvas and the two voices and is saved to their
        // disk - it is never uploaded and the server has no route that would
        // take it.
        this.recording = null;
        this.recorder = null;

        this._pollTimer = null;
        this._statsTimer = null;
        this._seatTimer = null;
        this._privateTimer = null;
    }

    /* ------------------------------------------------------------- boot -- */

    start() {
        const support = webCodecsSupport();
        if (!support.ok) {
            this.fatal(
                support.reason === 'insecure-context'
                    ? `WebCodecs is only available in a secure context, and this page was loaded over ` +
                          `plain HTTP from ${window.location.host}. Open the monitor on the machine ` +
                          `running the server at http://localhost:${window.location.port || 80}/live, ` +
                          `which browsers treat as secure, or put the server behind HTTPS to watch from ` +
                          `another device.`
                    : 'This browser has no WebCodecs support, so it cannot decode a live stream. ' +
                          'Chrome, Edge and Safari 17+ all work; Firefox needs media.webcodecs.enabled.'
            );
            return;
        }

        try {
            this.view = new StereoView(el('stage-canvas'));
        } catch (err) {
            this.fatal(err.message);
            return;
        }

        this.bindControls();
        this.renderRoom();
        this.pollSessions();
        this._pollTimer = setInterval(() => this.pollSessions(), POLL_INTERVAL_MS);
        this._statsTimer = setInterval(() => this.renderStats(), 500);

        StereoView.xrSupported().then((supported) => {
            el('enter-vr').disabled = !supported;
            el('enter-vr').title = supported
                ? 'View this broadcast in a headset'
                : 'No immersive-vr device available in this browser';
        });

        const loop = () => {
            this.pump();
            if (!this.view.xrSession) this.view.render();
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);

        const fromPath = location.pathname.match(/^\/live\/([0-9A-Za-z]+)/);
        const requested = fromPath?.[1] ?? new URLSearchParams(location.search).get('s');
        if (requested) this.join(requested);

        // Best effort on the way out, so a creator's list does not keep offering
        // a screen that has gone. The sweep covers it either way. Bound once
        // here rather than in `takeSeat`, which runs again on every sign-in,
        // sign-out and lapsed registration.
        window.addEventListener('pagehide', () => {
            if (this.seat) api.live.leave(this.seat.viewerId, this.seatToken);
        });

        this.bindAccount();
        this.takeSeat();
    }

    /* -------------------------------------------------------------- account -- */

    /**
     * Sign up, sign in, sign out - the whole of it, in the sidebar.
     *
     * Rendered from the session rather than on load, so finishing the dialog
     * updates the rest of the page (the chat box, the 1:1 panel) without a
     * reload. Everything on this page that needs an account says so where it
     * needs it; this is the one place that can do something about it.
     */
    bindAccount() {
        api.addEventListener('session', () => this.renderAccount());
        this.renderAccount();

        el('account-body').addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-account]');
            if (!btn) return;

            switch (btn.dataset.account) {
                case 'signup':
                    await authModal.open('register');
                    break;
                case 'signin':
                    await authModal.open('login');
                    break;
                case 'become-creator':
                    await authModal.openBecomeCreator();
                    break;
                case 'signout':
                    await api.logout();
                    break;
            }

            // Whoever is at the screen has changed, so the seat has to be
            // retaken under the new session - or dropped with the old one.
            // The chat box and the 1:1 panel both key off who is signed in.
            this.resetSeat();
            this.renderRoom();
            this.renderPrivate();
        });
    }

    renderAccount() {
        const body = el('account-body');
        if (!body) return;

        if (!api.signedIn) {
            body.innerHTML = `
                <p class="muted">
                    Watching is open to anyone. An account lets a creator invite this screen,
                    puts your name in the chat, and is needed to ask for a 1:1.
                </p>
                <div class="account-actions">
                    <button class="primary" data-account="signup">Sign up</button>
                    <button data-account="signin">Sign in</button>
                </div>`;
            return;
        }

        body.innerHTML = `
            <p class="account-who">
                <strong>${escapeHtml(api.user.displayName)}</strong>
                <span class="muted">${escapeHtml(api.user.role)}</span>
            </p>
            <div class="account-actions">
                ${
                    api.isCreator
                        ? `<a class="btn-link" href="/creator">Creator Studio</a>`
                        : `<button data-account="become-creator">Become a creator</button>`
                }
                <button data-account="signout">Sign out</button>
            </div>`;
    }

    /** Drop the seat this page holds and take one again as whoever is here now. */
    resetSeat() {
        clearTimeout(this._seatTimer);

        if (this.seat) api.live.leave(this.seat.viewerId, this.seatToken);

        this.seat = null;
        this.seatToken = null;
        this.seatState = null;
        el('seat').hidden = true;

        this.takeSeat();
    }

    /* ------------------------------------------------------ the waiting room -- */

    /**
     * Put this page on the waiting list, if there is anybody to put on it.
     *
     * Signed in only. That is the server's rule and this is just the client half
     * of it: a creator picks a person off a list of names, so a row has to have
     * an account behind it. Everything else on this page works signed out.
     *
     * Failing is not an error state worth showing. A monitor that cannot join a
     * waiting list is still a monitor - the public list and Join by id are both
     * untouched - so a failure here leaves the section hidden rather than
     * putting a red box in front of somebody who never asked to be invited.
     */
    async takeSeat() {
        try {
            await api.restore();
            if (!api.signedIn) return;

            const seat = await api.live.register();
            this.seat = seat;
            this.seatToken = seat.admitToken;
        } catch {
            return;
        }

        el('seat').hidden = false;
        this.seatState = { status: 'waiting' };
        this.renderSeat();
        this.pollSeat(this.seat.pollAfterMs ?? SEAT_POLL_MS);
    }

    pollSeat(delay) {
        clearTimeout(this._seatTimer);
        this._seatTimer = setTimeout(() => this.checkSeat(), delay);
    }

    async checkSeat() {
        if (!this.seat) return;

        let state;
        try {
            state = await api.live.status(this.seat.viewerId, this.seatToken);
        } catch {
            // A round trip that failed says nothing about the seat. Keep the
            // last state on screen and try again rather than declaring it lost.
            this.pollSeat(SEAT_POLL_MS);
            return;
        }

        // The registration lapsed - a sleeping laptop is the usual reason. Take
        // a new one rather than sitting on a dead id; the creator's list has
        // already dropped the old row.
        if (state.status === 'unknown') {
            this.seat = null;
            this.seatToken = null;
            this.seatState = null;
            el('seat').hidden = true;
            this.takeSeat();
            return;
        }

        const wasLive = this.seatState?.sessionId ?? null;
        this.seatState = state;
        this.renderSeat();

        if (state.status === 'live' && state.sessionId !== wasLive) {
            this.notify(`Room ${state.room.id} is on air. Joining.`, 'ok');
            this.join(state.sessionId, this.seatToken);
        }

        this.pollSeat(state.pollAfterMs ?? SEAT_POLL_MS);
    }

    renderSeat() {
        const body = el('seat-body');
        if (!body) return;

        const state = this.seatState;

        if (!state || state.status === 'waiting') {
            body.innerHTML = `
                <p class="muted">
                    You are on the waiting list as <strong>${escapeHtml(this.seat?.name ?? 'you')}</strong>
                    (${escapeHtml(this.seat?.device ?? 'this screen')}). A creator can open a broadcast
                    on this screen — it starts here on its own when they do.
                </p>`;
            return;
        }

        if (state.status === 'admitted') {
            body.innerHTML = `
                <p class="seat-admitted">
                    <strong>Room ${escapeHtml(state.room.id)}</strong> is open for you.
                    Waiting for the camera to connect.
                </p>`;
            return;
        }

        body.innerHTML = `
            <p class="seat-live">
                <strong>Room ${escapeHtml(state.room.id)}</strong> is on air —
                broadcast ${escapeHtml(state.sessionId)}.
            </p>`;
    }

    /**
     * Show or hide the stereographer's half of the page.
     *
     * Turning the tools off puts the picture back to side-by-side. Leaving it
     * in Difference with the button that set it now hidden would be a page
     * nobody could get a normal picture out of again.
     *
     * @param {boolean} on
     * @param {boolean} [persist] False on the first call, which only restores.
     */
    setTools(on, persist = true) {
        document.body.classList.toggle('show-tools', on);
        el('tools-toggle').setAttribute('aria-pressed', String(on));
        el('tools-toggle').classList.toggle('active', on);

        if (!on) {
            this.view.setLayout(LAYOUT.SBS);
            for (const b of document.querySelectorAll('[data-layout]')) {
                b.classList.toggle('active', b.dataset.layout === LAYOUT.SBS);
            }
        }

        if (persist) {
            try {
                localStorage.setItem(TOOLS_KEY, on ? '1' : '0');
            } catch {
                // Private browsing. The toggle still works for this visit.
            }
        }
    }

    bindControls() {
        let tools = false;
        try {
            tools = localStorage.getItem(TOOLS_KEY) === '1';
        } catch {
            // As above.
        }
        this.setTools(tools, false);

        el('tools-toggle').addEventListener('click', () => {
            this.setTools(!document.body.classList.contains('show-tools'));
        });

        for (const button of document.querySelectorAll('[data-layout]')) {
            button.addEventListener('click', () => {
                this.view.setLayout(button.dataset.layout);
                for (const b of document.querySelectorAll('[data-layout]')) {
                    b.classList.toggle('active', b === button);
                }
            });
        }

        el('projection').addEventListener('change', (event) => {
            this.projectionOverride = event.target.value || null;
            this.applyProjection();
        });

        const swapEyes = el('swap-eyes');
        swapEyes.addEventListener('change', (event) => {
            this.view.setSwapEyes(event.target.checked);
        });

        // And adopt whatever state the box is already in, rather than assuming
        // it starts clear. Firefox and Chrome restore checkbox state across a
        // soft reload, so binding only `change` leaves a box that is ticked
        // while the view is not swapped — the control silently reporting the
        // opposite of what is on screen.
        //
        // That matters more here than the usual form-restore annoyance. This
        // checkbox exists to diagnose eye order, so a reload turning it into a
        // liar corrupts the one measurement it is there to support. The markup
        // also carries `autocomplete="off"` now; this line is the half that
        // works whether or not the browser honours it.
        this.view.setSwapEyes(swapEyes.checked);

        el('enter-vr').addEventListener('click', () => {
            // The XR session drives its own frame loop; pump decoded pairs
            // from it so presentation stays locked to the headset's cadence
            // rather than the page's.
            this.view.onXrTick = () => this.pump();
            this.view
                .enterVR(() => {
                    this.view.onXrTick = null;
                })
                .catch((err) => this.notify(`Could not enter VR: ${err.message}`));
        });

        el('mute').addEventListener('click', () => {
            // The click *is* the gesture that lets a suspended AudioContext
            // resume, so this must stay a direct handler rather than anything
            // that defers the call.
            this.audio?.toggle();
            this.renderMuteButton();
        });

        for (const button of document.querySelectorAll('[data-mode]')) {
            button.addEventListener('click', () => this.switchMode(button.dataset.mode));
        }

        el('leave').addEventListener('click', () => this.leave());

        el('join-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const id = el('join-id').value.trim();
            if (id) this.join(id);
        });

        el('chat-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.say(el('chat-text').value);
        });

        // Delegated, because the buttons in here are redrawn every time
        // somebody asks or stops asking and a per-button listener would be
        // rebound with them.
        el('private-body').addEventListener('click', (event) => {
            const button = event.target.closest('[data-private]');
            if (button) this.onPrivateAction(button.dataset.private, button.dataset.request ?? null);
        });
    }

    /* ---------------------------------------------------------- sessions -- */

    async pollSessions() {
        let payload;
        try {
            payload = await fetchSessions();
        } catch {
            el('session-list').innerHTML = '<p class="muted">Cannot reach the server.</p>';
            return;
        }

        const list = el('session-list');

        if (!payload.sessions.length) {
            list.innerHTML =
                '<p class="muted">No broadcasts running. Start one from a capture app.</p>';
            return;
        }

        list.innerHTML = '';

        for (const session of payload.sessions) {
            const card = document.createElement('button');
            card.className = 'session-card';
            card.classList.toggle('active', session.sessionId === this.sessionId);

            const tracks = Object.entries(session.stats ?? {})
                .filter(([, s]) => s.frames > 0)
                .map(([name, s]) => `${name} ${s.width}×${s.height} ${s.fps}fps ${s.kbps}kbps`)
                .join(' · ');

            card.innerHTML = `
                <span class="live-dot"></span>
                <span class="session-name">${escapeHtml(session.name)}</span>
                <span class="session-id">${session.sessionId}</span>
                <span class="session-meta">${escapeHtml(session.device)} · ${escapeHtml(formatSummary(session))}</span>
                <span class="session-meta">${escapeHtml(tracks || 'waiting for frames')}</span>
                <span class="session-meta">${session.viewers} watching · up ${formatDuration(session.uptimeSeconds)}</span>
            `;

            card.addEventListener('click', () => this.join(session.sessionId));
            list.appendChild(card);
        }
    }

    /* -------------------------------------------------------------- join -- */

    /**
     * @param {string} sessionId
     * @param {string|null} [admit] - Admission secret, for a broadcast opened
     *   for this screen in particular. Public broadcasts do not have one and
     *   the relay does not ask.
     */
    async join(sessionId, admit = null) {
        const id = sessionId.toUpperCase();
        if (id === this.sessionId) return;

        this.leave();

        // Who is watching, asked before anything else. It decides three things
        // at once: whether a priced broadcast can be joined at all, whether
        // there is a name to put on a line in the room, and whether a 1:1 can
        // be asked for. A signed-out visitor still watches anything free.
        await api.restore().catch(() => {});

        // What it costs, before anything is charged. A broadcast that is free -
        // every broadcast on a deployment where nobody has set a price - quotes
        // `free` and the whole of the rest of this is skipped.
        this.quote = await api.live.quote(id, admit).catch(() => null);
        this.oneToOne = this.quote?.oneToOne ?? null;
        this.admit = admit;

        if (this.quote && !this.quote.free) {
            if (!api.signedIn) {
                this.notify('Sign in and buy credits to watch this broadcast.', 'warn');
                return;
            }

            this.mode = '2d';

            if (this.quote.balance < this.quote.modes['2d'].perMin) {
                this.notify(
                    `This broadcast costs ${formatCredits(this.quote.modes['2d'].perMin)} a minute and ` +
                        `you have ${formatCredits(this.quote.balance)}. Top up on your profile page.`,
                    'warn'
                );
                return;
            }
        }

        this.sessionId = id;
        this.pipeline = new StereoPipeline((err) => this.notify(err.message));
        this.audio = audioCodecsAvailable() ? new AudioPlayer((err) => this.notify(err.message, 'warn')) : null;
        this.audio?.addEventListener('available', () => this.renderMuteButton());
        // Unmuting can fail — a context the browser declines to resume — and
        // the button has to go back to saying so.
        this.audio?.addEventListener('mutechange', () => this.renderMuteButton());

        const paying = Boolean(this.quote && !this.quote.free);

        const connection = new LiveConnection(id, {
            admit,
            // Sent whenever there is one. It is what a broadcast that charges
            // bills, and equally what a room puts a name to - a signed-in
            // viewer on a free broadcast is charged nothing and can still
            // speak. Signed out, there is nothing to send and nothing to say.
            accessToken: api.signedIn ? api.accessToken : null,
            mode: paying ? this.mode : null
        });
        this.connection = connection;

        connection.addEventListener('billing', (event) => this.onBilling(event.detail));

        connection.addEventListener('ready', (event) => {
            this.session = event.detail;
            this.applyProjection();
            this.notify(`Joined "${this.session.name}"`, 'ok');
            document.body.classList.add('watching');
            el('stage-title').textContent = this.session.name;

            // Re-apply any config that arrived inside the READY snapshot; a
            // late joiner gets the whole track table in one go.
            for (const [name, config] of Object.entries(this.session.tracks ?? {})) {
                if (name === 'audio') {
                    this.audio?.configure(config);
                    continue;
                }

                const track = { left: TRACK.LEFT, right: TRACK.RIGHT, packed: TRACK.PACKED }[name];
                if (track !== undefined) this.pipeline.configure(track, config);
            }
        });

        connection.addEventListener('config', (event) => {
            const { track, config, name } = event.detail;

            if (track === TRACK.AUDIO) {
                if (!this.audio) {
                    this.notify('This browser cannot decode sound, so the broadcast plays silent.', 'warn');
                    return;
                }

                this.audio.configure(config);
                this.notify(
                    `sound: ${config.codec} ${config.sampleRate} Hz ` +
                        `${config.numberOfChannels === 1 ? 'mono' : `${config.numberOfChannels} ch`}`
                );
                return;
            }

            this.pipeline.configure(track, config);
            this.notify(`${name} eye: ${config.codec} ${config.codedWidth}×${config.codedHeight}`);
        });

        connection.addEventListener('audio', (event) => {
            this.stats.arrivals.push({ at: performance.now(), bytes: event.detail.payload.length });
            if (this.stats.arrivals.length > 240) this.stats.arrivals.shift();

            this.audio?.decode(event.detail);
        });

        connection.addEventListener('video', (event) => {
            this.stats.arrivals.push({ at: performance.now(), bytes: event.detail.payload.length });
            if (this.stats.arrivals.length > 240) this.stats.arrivals.shift();

            this.pipeline.decode(event.detail);
        });

        connection.addEventListener('ended', (event) => {
            this.notify(`Broadcast ended: ${event.detail.reason ?? 'stopped'}`, 'warn');
            this.leave();
        });

        connection.addEventListener('reconnecting', (event) => {
            this.notify(`Reconnecting in ${event.detail.delay} ms…`, 'warn');
        });

        connection.addEventListener('chat', (event) => this.onChat(event.detail));
        connection.addEventListener('private', (event) => this.onPrivate(event.detail));
        connection.addEventListener('evicted', (event) => this.onEvicted(event.detail));

        connection.connect();

        this.openRoom();

        history.replaceState({}, '', `/live/${id}`);
        el('join-id').value = id;
    }

    leave() {
        // Before the audio graph it is drawing from is torn down: a recording
        // in progress is stopped and *saved*, not discarded. The conversation
        // being over is the normal way one ends, and throwing away what
        // somebody was told they were recording would be the worst possible
        // reading of "the turn ended".
        if (this.recorder?.recording) {
            this.recorder.stop().catch(() => {});
        }
        this.recorder = null;
        this.recording = null;

        this.connection?.close();
        this.pipeline?.close();
        this.audio?.close();
        this.view?.exitVR();

        // The microphone goes with the socket. Leaving a broadcast with it
        // still open would be the page holding a live input device for a
        // conversation that is over.
        void this.talkback?.close();
        this.talkback = null;

        clearTimeout(this._privateTimer);

        this.connection = null;
        this.pipeline = null;
        this.audio = null;
        this.session = null;
        this.sessionId = null;
        this.quote = null;
        this.billing = null;
        this.admit = null;
        this.oneToOne = null;
        this.hosting = false;
        this.requests = [];
        this.stats.arrivals.length = 0;

        el('chat-log').innerHTML = '';
        this.renderRoom();
        this.renderBilling();
        this.renderMuteButton();
        document.body.classList.remove('watching');
        el('stage-title').textContent = 'No broadcast';
        history.replaceState({}, '', '/live');
    }

    /* -------------------------------------------------------------- room -- */

    /**
     * Joining a broadcast is joining the room that came with it.
     *
     * Nothing is asked for here - the server puts the socket in the room on the
     * way in and replays the backlog - so this is only the page catching up with
     * where it already is, plus the one question it cannot answer locally:
     * whose broadcast this is.
     */
    async openRoom() {
        const id = this.sessionId;

        this.hosting = false;
        this.requests = [];
        this.renderRoom();

        // A session deliberately does not publish its creator's account id, so
        // "is this mine" is asked by trying to read the creator-only request
        // list. A 404 is the ordinary answer and not worth reporting.
        if (api.isCreator) {
            try {
                const list = await api.live.privateRequests(id);
                if (id !== this.sessionId) return;

                this.hosting = true;
                this.requests = list.requests;
            } catch {
                /* somebody else's broadcast */
            }
        }

        this.renderPrivate();
        this.schedulePrivate();
    }

    /** @param {string} text */
    say(text) {
        const trimmed = String(text).trim();
        if (!trimmed) return;

        // A refusal - too fast, too long - comes back as a system line in the
        // room rather than from here, because it is the server that decides.
        if (!this.connection?.say(trimmed)) {
            this.notify('Not connected, so that was not said.', 'warn');
            return;
        }

        el('chat-text').value = '';
    }

    /**
     * A line in the room.
     *
     * The sender's own messages arrive back the same way everybody else's do,
     * so there is no local echo to reconcile and nothing on screen that the
     * server has not accepted.
     */
    onChat(message) {
        const log = el('chat-log');

        // Only follow along if they were already at the bottom. Yanking
        // somebody back down while they are reading up the room is the worst
        // habit a chat pane has.
        const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;

        const line = document.createElement('div');
        line.className = 'chat-line';
        if (message.system) line.classList.add('system');
        if (message.private) line.classList.add('private');
        if (message.host) line.classList.add('host');

        if (message.system) {
            line.textContent = message.text;
        } else {
            const who = document.createElement('span');
            who.className = 'who';
            who.textContent = message.name ?? 'Someone';
            // `textContent`, not `innerHTML`: this is the one place on the page
            // where a stranger's typing is put into the document.
            line.append(who, document.createTextNode(message.text));
        }

        log.appendChild(line);
        while (log.children.length > CHAT_LINES) log.firstChild.remove();

        if (pinned || message.history) log.scrollTop = log.scrollHeight;
    }

    renderRoom() {
        const input = el('chat-text');
        const send = el('chat-send');
        const state = el('room-state');

        const watching = Boolean(this.sessionId);
        const canSpeak = watching && api.signedIn;

        input.disabled = !canSpeak;
        send.disabled = !canSpeak;
        input.placeholder = canSpeak
            ? 'Say something'
            : watching
              ? 'Sign in to say something'
              : 'Join a broadcast first';

        state.textContent = watching ? (this.quote?.private ? 'private' : 'public') : '';
    }

    /* -------------------------------------------------------- one to one -- */

    schedulePrivate(delay = PRIVATE_POLL_MS) {
        clearTimeout(this._privateTimer);
        if (!this.sessionId || !api.signedIn) return;
        this._privateTimer = setTimeout(() => this.checkPrivate(), delay);
    }

    /**
     * Re-read where the 1:1 stands.
     *
     * The safety net, not the mechanism - both ends are told on their socket.
     * The one thing that genuinely needs a poll is an acceptance, which is sent
     * in the same instant as the close that carries the asker's socket away.
     */
    async checkPrivate() {
        const id = this.sessionId;
        if (!id || !api.signedIn) return;

        try {
            if (this.hosting) {
                const list = await api.live.privateRequests(id);
                if (id !== this.sessionId) return;

                this.requests = list.requests;
                if (this.quote) this.quote.private = list.private;
            } else {
                const state = await api.live.privateStatus(id);
                if (id !== this.sessionId) return;

                this.oneToOne = state;

                // An acceptance whose frame never made it out of the socket it
                // was closing. This is why the poll exists.
                const request = state.request;
                if (request?.state === 'accepted' && request.admit && request.admit !== this.admit) {
                    this.enterPrivate(request.admit);
                    return;
                }
            }
        } catch {
            // One failed round trip says nothing about the request. Keep what
            // is on screen and ask again.
            this.schedulePrivate();
            return;
        }

        await this.checkRecording();

        this.renderPrivate();
        this.schedulePrivate();
    }

    /**
     * Where recording stands, for whichever side this is.
     *
     * Folded into the 1:1 poll rather than given a timer of its own: it is only
     * ever asked inside a private turn, the two answers are drawn in the same
     * panel, and a permission question is not a sub-second matter. Outside a
     * turn there is nothing to ask and the state is dropped, so a panel cannot
     * go on showing a record button for a conversation that ended.
     */
    async checkRecording() {
        const id = this.sessionId;

        if (!id || !this.quote?.private) {
            this.recording = null;
            return;
        }

        try {
            const state = await api.live.recording.state(id);
            if (id === this.sessionId) this.recording = state;
        } catch {
            /* the turn may have just ended; the next poll settles it */
        }
    }

    /** Something happened to a 1:1 on this broadcast, pushed down the socket. */
    onPrivate(detail) {
        switch (detail.event) {
            case 'requested':
                // The creator's end. The list is the thing they act on, so it
                // is re-read rather than patched from the frame.
                this.notify(`${detail.name} is asking for a 1:1.`, 'ok');
                this.checkPrivate();
                break;

            case 'accepted':
                // Held rather than acted on: the close that evicts everybody is
                // landing right behind this, and `onEvicted` reconnects with
                // the secret this frame carries.
                this.oneToOne = { ...(this.oneToOne ?? {}), request: detail };
                this.notify('Your 1:1 was accepted. Reconnecting privately.', 'ok');
                break;

            case 'declined':
            case 'expired':
            case 'cancelled':
                this.oneToOne = { ...(this.oneToOne ?? {}), request: null };
                this.notify(refusalText(detail), 'warn');
                this.renderPrivate();
                break;

            default:
                break;
        }
    }

    /**
     * The socket was closed because who may watch changed.
     *
     * Three people get this close and it means something different to each:
     * the creator is reconnecting into their own private broadcast, the
     * accepted viewer is reconnecting with a secret, and everybody else is
     * being told the door shut.
     */
    onEvicted(detail) {
        const id = this.sessionId;

        if (!detail.private) {
            // The turn ended. Not reconnected on purpose: the broadcast is
            // public again and watching it costs the public rate, which nobody
            // should start paying by having left a tab open.
            this.notify('The 1:1 ended.', 'warn');
            this.leave();
            return;
        }

        if (this.hosting) {
            this.notify('The broadcast is private now. Reconnecting.', 'ok');
            this.leave();
            this.join(id);
            return;
        }

        const request = this.oneToOne?.request;
        if (request?.state === 'accepted' && request.admit) {
            this.enterPrivate(request.admit);
            return;
        }

        this.notify('This broadcast has gone private.', 'warn');
        this.leave();
    }

    /** Come back on a new socket, as the one person admitted to it. */
    async enterPrivate(admit) {
        const id = this.sessionId;
        if (!id) return;

        this.leave();
        await this.join(id, admit);
    }

    async onPrivateAction(action, requestId) {
        const id = this.sessionId;
        if (!id) return;

        try {
            if (action === 'ask') {
                const request = await api.live.askPrivate(id);
                this.oneToOne = { ...(this.oneToOne ?? {}), request };
                this.notify('Asked for a 1:1. It is the creator’s to accept.', 'ok');
            } else if (action === 'cancel') {
                await api.live.cancelPrivate(requestId);
                this.oneToOne = { ...(this.oneToOne ?? {}), request: null };
            } else if (action === 'accept') {
                await api.live.acceptPrivate(requestId);
            } else if (action === 'decline') {
                await api.live.declinePrivate(requestId);
            } else if (action === 'end') {
                await api.live.endPrivate(id);
            } else if (action === 'talk') {
                // Not an API call, and deliberately handled on the same click
                // as the rest: the gesture is what lets the browser open a
                // microphone, so it must not be deferred behind an await.
                await this.toggleTalkback();
                return;
            } else if (action === 'record') {
                // The viewer's own recording. Same reason as talkback: it opens
                // a microphone, so nothing may be awaited before it.
                await this.toggleMyRecording();
                return;
            } else if (action === 'record-ask') {
                const { viewer } = await api.live.recording.askConsent(id);
                this.recording = { ...(this.recording ?? {}), viewer };
                this.notify(
                    viewer.allowed
                        ? 'You may record this conversation.'
                        : 'Asked the creator whether you may record.',
                    'ok'
                );
            } else if (action === 'record-start') {
                await api.live.recording.start(id);
                this.notify('Recording your side of the conversation.', 'ok');
            } else if (action === 'record-stop') {
                const { recording } = await api.live.recording.stop(id);
                this.notify(
                    `Recording saved — ${recordingLength(recording.durationMs)}, tagged ${recording.tag.toUpperCase()}. ` +
                        `It is in your profile, where you can put it on sale.`,
                    'ok'
                );
            } else if (action === 'record-allow' || action === 'record-refuse') {
                await api.live.recording.answerConsent(id, action === 'record-allow');
            }
        } catch (err) {
            this.notify(privateError(err), 'warn');
        }

        this.renderPrivate();
        this.checkPrivate();
    }

    /**
     * Let them hear you, or stop.
     *
     * Talkback is only ever offered inside a 1:1 and only to the viewer: the
     * creator is the camera, and the relay will not carry a packet from anyone
     * but the person the room belongs to. The control is drawn on the same two
     * conditions, so there is nothing here that would send into a public room
     * even if the button somehow got clicked in one.
     */
    async toggleTalkback() {
        if (this.talkback && this.talkback.state !== TALKBACK_STATE.OFF) {
            await this.talkback.close();
            this.renderPrivate();
            return;
        }

        if (!this.connection || !this.quote?.private) {
            this.notify('Talkback only works inside a 1:1.', 'warn');
            return;
        }

        if (!this.session?.talkback) {
            this.notify('This camera is not accepting talkback.', 'warn');
            return;
        }

        if (!this.talkback) {
            this.talkback = new Talkback({
                // Looked up per packet rather than captured, so a reconnect
                // inside the same turn does not leave the microphone talking
                // into a socket that closed.
                send: (bytes) => this.connection?.sendUpstream(bytes) ?? false
            });

            this.talkback.addEventListener('state', () => this.renderPrivate());
            this.talkback.addEventListener('level', (event) => this.renderLevel(event.detail.level));
            this.talkback.addEventListener('notice', (event) => this.notify(event.detail.message, 'warn'));
        }

        const opened = await this.talkback.open();
        if (!opened && this.talkback.error) this.notify(this.talkback.error, 'warn');

        this.renderPrivate();
    }

    /**
     * Record this conversation to this computer, or stop and save.
     *
     * The permission is checked here as well as drawn, because a button that
     * is not on screen is not a guarantee about anything. What the check is
     * not is a security boundary: the file is made in this browser out of a
     * canvas and a microphone the person already has, so what it really
     * enforces is that this product does not offer to do it behind the
     * creator's back.
     */
    async toggleMyRecording() {
        if (this.recorder?.recording) {
            const saved = await this.recorder.stop();
            this.notify(
                saved
                    ? `Saved ${saved.filename} (${recordingLength(saved.durationMs)}) to your downloads.`
                    : 'Nothing was recorded.',
                saved ? 'ok' : 'warn'
            );
            this.renderPrivate();
            return;
        }

        if (!this.quote?.private) {
            this.notify('Recording only works inside a 1:1.', 'warn');
            return;
        }

        if (!this.recording?.viewer?.allowed) {
            this.notify('The creator has not agreed to this conversation being recorded.', 'warn');
            return;
        }

        if (!this.recorder) {
            this.recorder = new ViewerRecorder({
                canvas: el('stage-canvas'),
                audio: this.audio,
                // Talkback's microphone if it is open, rather than a second
                // capture of the same device. Looked up per start, so turning
                // talkback on after recording began does not silently change
                // which stream is being recorded mid-file.
                microphone: () => this.talkback?.stream ?? null
            });

            this.recorder.addEventListener('change', () => this.renderPrivate());
        }

        const started = await this.recorder.start();

        if (!started) {
            if (this.recorder.error) this.notify(this.recorder.error, 'warn');
        } else if (this.recorder.warning) {
            this.notify(this.recorder.warning, 'warn');
        }

        this.renderPrivate();
    }

    /**
     * The microphone meter.
     *
     * Written straight to the element rather than through `renderPrivate`,
     * because this happens twenty-five times a second and rebuilding the panel
     * at that rate would take the buttons out from under the pointer.
     */
    renderLevel(level) {
        const meter = el('mic-level');
        if (!meter) return;

        // Square-rooted so ordinary speech moves the bar visibly instead of
        // sitting in the bottom tenth of it.
        meter.style.transform = `scaleX(${Math.sqrt(Math.min(1, level)).toFixed(3)})`;
    }

    renderPrivate() {
        const panel = el('one-to-one');
        const body = el('private-body');
        const isPrivate = Boolean(this.quote?.private);

        this.renderRoom();

        if (!this.sessionId) {
            panel.hidden = true;
            return;
        }

        if (this.hosting) {
            panel.hidden = false;
            body.innerHTML = isPrivate
                ? `<div class="private-now">This broadcast is private to one viewer. Nobody else can
                       watch it while it is.</div>
                   ${recordRow(this.recording)}
                   <button data-private="end">End the 1:1</button>`
                : this.requests.length
                  ? this.requests.map(askRow).join('')
                  : '<p class="muted">Nobody is asking for a 1:1 right now.</p>';
            return;
        }

        if (isPrivate) {
            panel.hidden = false;
            body.innerHTML = `
                <div class="private-now">
                    You are in a 1:1${
                        this.billing?.ratePerMin
                            ? ` at ${escapeHtml(formatCredits(this.billing.ratePerMin))} a minute`
                            : ''
                    }.
                </div>
                ${talkRow(this.talkback, this.session?.talkback === true)}
                ${viewerRecordRow(this.recording?.viewer ?? null, this.recorder, this.recording?.creatorRecording === true)}
                <button data-private="end">End the 1:1</button>`;

            if (this.talkback) this.renderLevel(this.talkback.level);
            return;
        }

        // Nothing on offer, or nobody signed in to take it up. Either way there
        // is no control to draw and the section stays out of the way.
        if (!this.oneToOne?.offered) {
            panel.hidden = true;
            return;
        }

        panel.hidden = false;

        if (!api.signedIn) {
            body.innerHTML = '<p class="muted">Sign in to ask this creator for a 1:1.</p>';
            return;
        }

        const request = this.oneToOne.request;

        if (request?.state === 'pending') {
            body.innerHTML = `
                <p>Asked for a 1:1 at ${escapeHtml(formatCredits(request.ratePerMin))} a minute.
                   Waiting for the creator.</p>
                <button data-private="cancel" data-request="${escapeHtml(request.id)}">Withdraw the request</button>`;
            return;
        }

        body.innerHTML = `
            <p>${escapeHtml(privatePrices(this.oneToOne.modes))}</p>
            <button data-private="ask" class="primary">Ask for a 1:1</button>`;
    }

    /* ----------------------------------------------------------- billing -- */

    /**
     * A minute was charged, is about to be unaffordable, or was not affordable.
     *
     * Nothing here can change what happened - the money moved before the frame
     * carrying this arrived - so the page's only job is to be honest about it
     * early enough that the viewer can do something.
     */
    onBilling(detail) {
        this.billing = { ...this.billing, ...detail };

        if (detail.mode && detail.mode !== this.mode) this.mode = detail.mode;

        if (detail.event === 'low_balance') {
            this.notify(
                `${formatCredits(detail.balance)} left — about a minute. Top up on your profile page.`,
                'warn'
            );
        }

        if (detail.event === 'exhausted') {
            this.notify('Out of credits. Top up on your profile page to carry on watching.', 'warn');
        }

        this.renderBilling();
    }

    /**
     * Ask to be billed at the other rate.
     *
     * The picture does not change here; the *layout* buttons do that. This is
     * the commercial half - what the viewer is paying for - and the server
     * applies it at the next minute boundary, so the button reflects the
     * request rather than pretending it took effect now.
     */
    async switchMode(mode) {
        if (!this.sessionId || !this.billing) return;
        if (mode === this.mode) return;

        try {
            await api.live.mode(this.sessionId, mode);
            this.mode = mode;
            this.notify(`Switching to ${mode.toUpperCase()} from the next minute.`);
        } catch (err) {
            this.notify(
                err.status === 409 ? 'This broadcast is not offering 3D.' : `Could not switch: ${err.message}`,
                'warn'
            );
        }

        this.renderBilling();
    }

    renderBilling() {
        const strip = el('billing');
        if (!strip) return;

        if (!this.billing) {
            strip.hidden = true;
            return;
        }

        const rate = this.billing.ratePerMin ?? 0;
        const remaining = this.billing.minutesRemaining;

        strip.hidden = false;
        el('cost-summary').textContent =
            `${formatCredits(rate)}/min · ${formatCredits(this.billing.balance ?? 0)} left` +
            (typeof remaining === 'number' ? ` · ~${remaining} min` : '');

        for (const button of document.querySelectorAll('[data-mode]')) {
            const available = this.quote?.modes?.[button.dataset.mode]?.available ?? true;
            button.disabled = !available;
            button.title = available
                ? `Watch in ${button.dataset.mode.toUpperCase()}`
                : 'Not offered on this broadcast';
            button.classList.toggle('active', button.dataset.mode === this.mode);
        }
    }

    /* ------------------------------------------------------------- frame -- */

    /** Move one decoded pair from the pipeline onto the GPU. */
    pump() {
        if (!this.pipeline) return;

        const pair = this.pipeline.takePair();
        if (!pair) return;

        if (!pair.matched) this.stats.unpaired = (this.stats.unpaired ?? 0) + 1;

        this.view.present(pair);

        this.stats.presented += 1;
        this.stats.lastPresentAt = performance.now();
    }

    /**
     * The button says what the sound is doing now, not what clicking it does.
     * A control labelled with its own action is ambiguous about which state it
     * is reporting, and this one spends most of its life in the state nobody
     * chose - muted, because the browser insisted.
     */
    renderMuteButton() {
        const button = el('mute');
        if (!button) return;

        if (!this.audio?.available) {
            button.disabled = true;
            button.classList.remove('active');
            button.textContent = 'Sound off';
            button.title = audioCodecsAvailable()
                ? 'This broadcast has no sound'
                : 'This browser cannot decode sound';
            return;
        }

        button.disabled = false;
        button.classList.toggle('active', !this.audio.muted);
        button.textContent = this.audio.muted ? 'Sound off' : 'Sound on';
        button.title = this.audio.muted ? 'Play the broadcast sound' : 'Mute the broadcast sound';
    }

    applyProjection() {
        const projection = this.projectionOverride ?? this.session?.projection ?? PROJECTION.FLAT;
        const fov = this.session?.fisheyeFov ?? 180;
        this.view.setProjection(projection, fov);
    }

    /* ------------------------------------------------------------- stats -- */

    renderStats() {
        const target = el('stats');

        if (!this.pipeline || !this.session) {
            target.innerHTML = '<p class="muted">Not watching anything.</p>';
            return;
        }

        const stats = this.pipeline.stats();
        const now = performance.now();

        const recent = this.stats.arrivals.filter((a) => now - a.at < 2000);
        const kbps = recent.length
            ? Math.round((recent.reduce((sum, a) => sum + a.bytes, 0) * 8) / 2 / 1000)
            : 0;

        const rows = [
            ['Broadcast', `${this.session.name} (${this.sessionId})`],
            ['Source', `${this.session.device}`],
            // Not `flat / sbs / 3d`. Those are handshake values, and printing
            // them here showed a paying viewer the inside of the pipe.
            ['Layout', formatSummary(this.session)],
            ['Watching in', (this.session.mode ?? this.mode).toUpperCase()],
            ['Link', `${kbps} kbps in · ${this.connection?.connected ? 'connected' : 'offline'}`],
            ['Pairs shown', `${stats.pairsPresented}`],
            [
                'Unpaired',
                stats.unpairedPresented
                    ? `${stats.unpairedPresented} — one eye is lagging`
                    : 'none — eyes in lockstep'
            ]
        ];

        if (this.session.baselineMm) {
            rows.push(['Interaxial', `${this.session.baselineMm.toFixed(1)} mm`]);
        }
        if (this.session.hfovDeg) {
            rows.push(['Eye FOV', `${this.session.hfovDeg.toFixed(1)}° horizontal`]);
        }

        const audio = this.audio?.stats();
        rows.push([
            'Sound',
            audio?.codec
                ? `${audio.channels === 1 ? 'mono' : `${audio.channels} ch`} ${audio.sampleRate} Hz · ` +
                  `${audio.muted ? 'muted' : `${audio.played} played`}` +
                  `${audio.resets ? ` · ${audio.resets} resync${audio.resets === 1 ? '' : 's'}` : ''}`
                : 'none on this broadcast'
        ]);

        const eyeRows = ['left', 'right', 'packed']
            .filter((name) => stats[name].decoded > 0 || stats[name].codec)
            .map((name) => {
                const s = stats[name];
                return `<tr>
                    <td>${name}</td>
                    <td>${s.codec ?? '—'}</td>
                    <td>${s.width}×${s.height}</td>
                    <td>${s.decoded}</td>
                    <td>${s.dropped}</td>
                    <td>${s.queued}</td>
                </tr>`;
            })
            .join('');

        target.innerHTML = `
            <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
            <table class="track-table">
                <thead><tr><th>track</th><th>codec</th><th>size</th><th>decoded</th><th>dropped</th><th>queue</th></tr></thead>
                <tbody>${eyeRows || '<tr><td colspan="6" class="muted">no tracks yet</td></tr>'}</tbody>
            </table>
        `;
    }

    /* ----------------------------------------------------------- notices -- */

    notify(message, kind = 'info') {
        const log = el('log');
        const line = document.createElement('div');
        line.className = `log-line ${kind}`;
        line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
        log.prepend(line);

        while (log.children.length > 40) log.lastChild.remove();
    }

    fatal(message) {
        document.body.innerHTML = `<div class="fatal"><h1>Live monitor unavailable</h1><p>${escapeHtml(message)}</p></div>`;
    }
}

/** One person asking for a private turn, and the two answers. */
function askRow(request) {
    const id = escapeHtml(request.id);

    return `
        <div class="ask-row">
            <span>${escapeHtml(request.name)}</span>
            <button data-private="accept" data-request="${id}" class="primary">Take</button>
            <button data-private="decline" data-request="${id}">No</button>
            <span class="waiting">
                ${escapeHtml(formatCredits(request.ratePerMin))}/min · waiting
                ${formatDuration(request.waitingSeconds ?? 0)}
            </span>
        </div>`;
}

/**
 * The microphone control, and an honest label for what it is doing.
 *
 * Three states worth distinguishing, because "nothing happens when I press
 * talk" has three different causes and only one of them is fixable by the
 * person pressing it.
 *
 * @param {import('./talkback.js').Talkback|null} talkback
 * @param {boolean} available - Whether the camera on the other end is there to
 *   hear it. False for a broadcast whose contribution socket has gone.
 */
function talkRow(talkback, available) {
    if (!available) {
        return '<p class="muted">This camera is not set up for talkback, so they cannot hear you.</p>';
    }

    if (!Talkback.supported) {
        return '<p class="muted">This browser cannot send your microphone.</p>';
    }

    const state = talkback?.state ?? TALKBACK_STATE.OFF;
    const starting = state === TALKBACK_STATE.STARTING;
    const live = state === TALKBACK_STATE.LIVE;

    return `
        <div class="talk-row">
            <button data-private="talk" class="${live ? 'talking' : ''}" ${starting ? 'disabled' : ''}>
                ${starting ? 'Starting…' : live ? 'Stop talking' : 'Talk to them'}
            </button>
            <div class="mic-meter" aria-hidden="true"><i id="mic-level"></i></div>
        </div>
        <p class="muted">${
            live
                ? 'Your microphone is live to their camera. Nobody else is in this room.'
                : 'Your microphone is off. They can see you are here but cannot hear you.'
        }</p>`;
}

/**
 * The creator's recording control, and the viewer's question if there is one.
 *
 * What this button starts is made on the server out of the contribution feed,
 * so it holds the creator's picture and the creator's voice and nothing the
 * viewer said - talkback travels the other way and never passes through it.
 * That asymmetry is the reason this side needs no permission and the other
 * side does, and the label says so rather than leaving it to be discovered.
 *
 * @param {object|null} state - The creator's half of `GET .../recording`.
 */
function recordRow(state) {
    if (!state) return '';

    if (state.available === false) {
        return '<p class="muted">Recording is not available on this server right now.</p>';
    }

    const mine = state.mine ?? { recording: false };
    const elapsed = mine.startedAt ? formatDuration(Math.floor((Date.now() - mine.startedAt) / 1000)) : '';

    const control = mine.recording
        ? `<button data-private="record-stop" class="recording">Stop recording${elapsed ? ` · ${escapeHtml(elapsed)}` : ''}</button>`
        : '<button data-private="record-start">Record this 1:1</button>';

    const question = state.asked
        ? `<div class="record-ask">
               <p>Your viewer is asking to record this conversation. Their recording would
                  carry both voices and is saved on their own computer, not here.</p>
               <button data-private="record-allow" class="primary">Allow</button>
               <button data-private="record-refuse">Refuse</button>
           </div>`
        : '';

    return `
        <div class="record-row">${control}</div>
        <p class="muted">${
            mine.recording
                ? 'Recording your camera and your voice. Theirs is not in it.'
                : 'Records your camera and your voice only. You can put it up for sale afterwards.'
        }</p>
        ${question}`;
}

/**
 * The viewer's recording control.
 *
 * Nothing here uploads anything. The file is written by this browser to this
 * computer, which is why it may contain both voices at all - and why the
 * creator is asked first, since one of those voices is theirs.
 *
 * @param {{policy: string, allowed: boolean, state: string}|null} viewer
 * @param {import('./recorder.js').ViewerRecorder|null} recorder
 * @param {boolean} creatorRecording
 */
function viewerRecordRow(viewer, recorder, creatorRecording) {
    if (!viewer) return '';

    const theirs = creatorRecording
        ? '<p class="muted">The creator is recording their own camera and voice.</p>'
        : '';

    if (!ViewerRecorder.supported) {
        return `<p class="muted">This browser cannot record video.</p>${theirs}`;
    }

    if (recorder?.busy) {
        return `<div class="record-row"><button disabled>${
            recorder.state === 'saving' ? 'Saving…' : 'Starting…'
        }</button></div>${theirs}`;
    }

    if (recorder?.recording) {
        return `
            <div class="record-row"><button data-private="record" class="recording">Stop and save</button></div>
            <p class="muted">Recording to your own computer. Nothing is uploaded.</p>
            ${theirs}`;
    }

    if (viewer.state === 'denied') {
        return `<p class="muted">${
            viewer.policy === 'never'
                ? 'This creator does not allow viewers to record.'
                : 'The creator said no to recording this conversation.'
        }</p>${theirs}`;
    }

    if (viewer.state === 'asked') {
        return `<p class="muted">Waiting for the creator to say whether you may record.</p>${theirs}`;
    }

    if (viewer.allowed) {
        return `
            <div class="record-row"><button data-private="record">Record this 1:1</button></div>
            <p class="muted">Both voices, saved to your own computer. Nothing is uploaded.</p>
            ${theirs}`;
    }

    return `
        <div class="record-row"><button data-private="record-ask">Ask to record</button></div>
        <p class="muted">Recording a 1:1 needs the creator’s agreement. The file would stay on your computer.</p>
        ${theirs}`;
}

/** A recorded length, from milliseconds, for a line of prose. */
function recordingLength(durationMs) {
    return formatDuration(Math.max(0, Math.round((durationMs ?? 0) / 1000)));
}

/** What a private turn costs, in whichever modes are on offer. */
function privatePrices(modes) {
    const parts = [];
    if (modes?.['2d']?.perMin > 0) parts.push(`${formatCredits(modes['2d'].perMin)}/min in 2D`);
    if (modes?.['3d']?.available && modes['3d'].perMin > 0) {
        parts.push(`${formatCredits(modes['3d'].perMin)}/min in 3D`);
    }

    return parts.length
        ? `A private 1:1 with this creator is ${parts.join(', or ')}.`
        : 'This creator takes private 1:1 requests.';
}

/** Why the request is not standing any more, in the asker's terms. */
function refusalText(detail) {
    if (detail.event === 'expired') return 'Your 1:1 request lapsed without an answer.';
    if (detail.event === 'cancelled') return 'Your 1:1 request was withdrawn.';

    if (detail.reason === 'someone_else') return 'The creator took somebody else’s 1:1.';
    if (detail.reason === 'insufficient_credits') {
        return 'Not enough credits for a 1:1 by the time the creator answered.';
    }

    return 'The creator declined the 1:1.';
}

/**
 * A failed 1:1 call, said as a person would.
 *
 * The server answers with a machine-readable reason and the client owns the
 * wording, which is what keeps the two from drifting apart in translation.
 */
function privateError(err) {
    switch (err.message) {
        case 'insufficient_credits':
            return 'A 1:1 costs more than you have. Top up on your profile page.';
        case 'private_unavailable':
            return 'This creator is not taking 1:1 requests.';
        case 'already_private':
            return 'This broadcast is already in a 1:1.';
        case 'too_many_requests':
            return 'Too many people are asking right now. Try again in a moment.';
        case 'viewer_cannot_pay':
            return 'They cannot afford the minute any more, so the request was declined.';
        case 'own_broadcast':
            return 'That is your own broadcast.';
        case 'not_pending':
            return 'That request has already been answered.';
        default:
            return `Could not do that: ${err.message}`;
    }
}

function escapeHtml(value) {
    return String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
}

new Monitor().start();

export { Monitor, LAYOUT, trackName };
