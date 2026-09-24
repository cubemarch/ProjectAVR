import { api } from '../api/client.js';
import { LiveConnection } from './connection.js';
import { StereoPipeline, webCodecsSupport } from './decoder.js';
import { StereoView, LAYOUT, PROJECTION } from './stereo-view.js';
import { AudioPlayer, audioCodecsAvailable } from './audio.js';
import { TRACK } from './protocol.js';

/**
 * The picture a creator is actually confirming, inside the setup check.
 *
 * The checks used to be an attestation: a paragraph telling the creator to
 * "look at the monitor" and a button saying it looked right, on a page with no
 * monitor on it. The only live picture in the product was the separate operator
 * page at `/live`, which the check neither embedded nor linked - so the honest
 * reading of a passed check was "somebody pressed a button".
 *
 * This is the missing half. It finds the creator's own broadcast, decodes it in
 * the page and puts it above the confirm button, and it refuses to enable that
 * button until frames are actually on the screen. What it does *not* do is
 * decide whether the picture is right: a swapped stereo pair is a valid,
 * well-formed, entirely wrong stream, and no probe detects it. The point of the
 * preview is to put the one detector that works - a person - in front of the
 * thing they are being asked about.
 *
 * Two things are deliberately not hidden from that person:
 *
 *   Whether the server can prove the camera is theirs. On the shared stream key
 *   it cannot, and the panel says so rather than implying otherwise.
 *
 *   Whether the browser can decode at all. WebCodecs needs a secure context, so
 *   a profile page opened over plain HTTP at a LAN address has no decoder, and
 *   the failure is a configuration fact rather than a missing feature.
 */

/** Layouts offered for the 3D check, in the order they are worth trying. */
const SPATIAL_LAYOUTS = [
    { id: LAYOUT.SBS, label: 'Side by side', hint: 'Both eyes, as the rig sends them' },
    { id: LAYOUT.ANAGLYPH, label: 'Anaglyph', hint: 'Red/cyan - depth without a headset' },
    { id: LAYOUT.DIFFERENCE, label: 'Difference', hint: '|L − R| - alignment errors show as banding' },
    { id: LAYOUT.LEFT, label: 'Left only', hint: 'One eye at a time, to tell them apart' },
    { id: LAYOUT.RIGHT, label: 'Right only', hint: 'One eye at a time, to tell them apart' }
];

export class CheckPreview extends EventTarget {
    /**
     * @param {object} opts
     * @param {'standard'|'spatial'} opts.kind
     */
    constructor({ kind }) {
        super();

        this.kind = kind === 'spatial' ? 'spatial' : 'standard';

        /** The element the caller inserts. Survives the page re-rendering. */
        this.el = document.createElement('div');
        this.el.className = `check-preview kind-${this.kind}`;

        this.state = {
            phase: 'starting',
            message: 'Looking for your camera…',
            attributed: null,
            carryingStereo: false,
            frames: 0,
            audio: false,
            fatal: false
        };

        this.session = null;
        this.connection = null;
        this.pipeline = null;
        this.audio = null;
        this.view = null;

        this._pollTimer = null;
        this._frameTimer = null;
        this._lastRenderAt = 0;
        this._stopped = false;
        this._swapEyes = false;
        this._layout = LAYOUT.SBS;

        this._build();
    }

    /**
     * Is the confirm button allowed to be pressed?
     *
     * Pictures on the screen, and for the 3D check a pair to have an opinion
     * about. The server applies the same two rules to the POST - this is the
     * half that stops somebody being told "no" after they have already decided
     * the stream looks fine.
     */
    get confirmable() {
        if (this.state.phase !== 'live' || this.state.frames === 0) return false;
        if (this.kind === 'spatial') return this.state.carryingStereo;
        return true;
    }

    /* ------------------------------------------------------------ lifecycle -- */

    start() {
        const support = webCodecsSupport();

        if (!support.ok) {
            this._set({
                phase: 'unsupported',
                fatal: true,
                message:
                    support.reason === 'insecure-context'
                        ? `This page was loaded over plain HTTP from ${location.host}, and browsers only ` +
                          `expose the video decoder in a secure context. Open your profile at ` +
                          `http://localhost:${location.port || 80}/ - which counts as secure - or put the ` +
                          `server behind HTTPS, then run the check again.`
                        : 'This browser cannot decode live video. Chrome, Edge and Safari 17+ all can; ' +
                          'Firefox needs media.webcodecs.enabled.'
            });
            return;
        }

        try {
            this.view = new StereoView(this._canvas);
        } catch (err) {
            this._set({ phase: 'unsupported', fatal: true, message: err.message });
            return;
        }

        this.view.setLayout(this._layout);

        const loop = () => {
            if (this._stopped) return;

            const pair = this.pipeline?.takePair();
            if (pair) {
                this.view.present(pair);
                this.state.frames += 1;

                // The first frame is the one that matters - it is what clears
                // the overlay and unlocks the confirm button. After that the
                // readout is refreshed twice a second, because rewriting the
                // toolbar sixty times a second would rebuild the buttons out
                // from under whoever is trying to press one.
                const now = performance.now();
                if (this.state.frames === 1 || now - this._lastRenderAt > 500) {
                    this._lastRenderAt = now;
                    this._set({});
                }
            }

            this.view.render();
            this._frameTimer = requestAnimationFrame(loop);
        };
        this._frameTimer = requestAnimationFrame(loop);

        this._look();
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._pollTimer);
        cancelAnimationFrame(this._frameTimer);

        this.connection?.close();
        this.pipeline?.close();
        this.audio?.close();
        this.view?.destroy();

        this.connection = this.pipeline = this.audio = this.view = null;
        this.el.remove();
    }

    /* -------------------------------------------------------------- finding -- */

    /** Ask the server which broadcast this check is about, and wait if none. */
    async _look() {
        if (this._stopped) return;

        let answer;
        try {
            answer = await api.checks.preview();
        } catch (err) {
            this._set({ phase: 'waiting', message: err.message });
            this._pollTimer = setTimeout(() => this._look(), 4000);
            return;
        }

        if (this._stopped) return;

        if (!answer.preview) {
            this._set({
                phase: 'waiting',
                attributed: null,
                carryingStereo: false,
                message:
                    'No camera is connected. Start a broadcast in the capture app and it will appear here ' +
                    'within a second or two.'
            });
            this._pollTimer = setTimeout(() => this._look(), answer.pollAfterMs ?? 2000);
            return;
        }

        const preview = answer.preview;

        // Already watching this one: nothing to do but keep the stereo flag
        // current, which flips the moment the second eye starts arriving.
        if (this.session?.sessionId === preview.sessionId) {
            this._set({ attributed: preview.attributed, carryingStereo: preview.carryingStereo });
            this._pollTimer = setTimeout(() => this._look(), answer.pollAfterMs ?? 2000);
            return;
        }

        this._join(preview);
        this._pollTimer = setTimeout(() => this._look(), answer.pollAfterMs ?? 2000);
    }

    /* ------------------------------------------------------------- watching -- */

    /** @param {object} preview - The `preview` object from the server. */
    _join(preview) {
        this.connection?.close();
        this.pipeline?.close();
        this.audio?.close();

        this.session = preview;

        this._set({
            phase: 'connecting',
            frames: 0,
            audio: false,
            attributed: preview.attributed,
            carryingStereo: preview.carryingStereo,
            message: 'Connecting to your broadcast…'
        });

        this.pipeline = new StereoPipeline((err) => this._set({ message: err.message }));

        // Sound is half of what the standard check is confirming. It is not
        // part of the 3D one, which is about the pair and nothing else, and
        // opening a second audio context for it would be noise in both senses.
        this.audio =
            this.kind === 'standard' && audioCodecsAvailable()
                ? new AudioPlayer((err) => this._set({ message: err.message }))
                : null;
        this.audio?.addEventListener('available', () => this._render());

        this.view?.setProjection(preview.projection ?? PROJECTION.FLAT, preview.fisheyeFov ?? 180);

        // No `mode`: the creator is not being billed for their own broadcast,
        // so there is no rate to declare. `billing.isFree()` is where that is
        // decided, and this relies on it rather than restating it.
        const connection = new LiveConnection(preview.sessionId, {
            accessToken: api.signedIn ? api.accessToken : null
        });
        this.connection = connection;

        connection.addEventListener('ready', (event) => {
            for (const [name, config] of Object.entries(event.detail?.tracks ?? {})) {
                if (name === 'audio') this.audio?.configure(config);
                else this._configureVideo({ left: TRACK.LEFT, right: TRACK.RIGHT, packed: TRACK.PACKED }[name], config);
            }
            this._set({ phase: 'live', message: '' });
        });

        connection.addEventListener('config', (event) => {
            const { track, config } = event.detail;
            if (track === TRACK.AUDIO) this.audio?.configure(config);
            else this._configureVideo(track, config);
        });

        connection.addEventListener('video', (event) => this.pipeline?.decode(event.detail));

        connection.addEventListener('audio', (event) => {
            this.audio?.decode(event.detail);
            if (!this.state.audio) this._set({ audio: true });
        });

        connection.addEventListener('ended', () => this._dropped('The broadcast ended.'));
        connection.addEventListener('close', () => {
            if (this.state.phase === 'live') this._dropped('The broadcast dropped. Waiting for it to come back…');
        });

        connection.connect();
    }

    _configureVideo(track, config) {
        if (track === undefined || track === null) return;
        this.pipeline?.configure(track, config);
    }

    _dropped(message) {
        this.session = null;
        this._set({ phase: 'waiting', frames: 0, audio: false, carryingStereo: false, message });
    }

    /* -------------------------------------------------------------- the DOM -- */

    _build() {
        this.el.innerHTML = `
            <div class="check-stage">
                <canvas></canvas>
                <div class="check-overlay" hidden></div>
            </div>
            <div class="check-tools"></div>
            <p class="check-readout"></p>
        `;

        this._canvas = this.el.querySelector('canvas');
        this._overlay = this.el.querySelector('.check-overlay');
        this._tools = this.el.querySelector('.check-tools');
        this._readout = this.el.querySelector('.check-readout');

        this._tools.onclick = (event) => {
            const button = event.target.closest('button[data-preview-act]');
            if (!button) return;

            switch (button.dataset.previewAct) {
                case 'layout':
                    this._layout = button.dataset.layout;
                    this.view?.setLayout(this._layout);
                    this._render();
                    break;
                case 'swap':
                    this._swapEyes = !this._swapEyes;
                    this.view?.setSwapEyes(this._swapEyes);
                    this._render();
                    break;
                case 'listen':
                    this.audio?.toggleMute().then(() => this._render());
                    break;
            }
        };

        this._render();
    }

    /** @param {object} patch */
    _set(patch) {
        const before = this.confirmable;
        Object.assign(this.state, patch);
        this._render();

        // Only the transition matters to the page: it is what enables the
        // confirm button, and re-dispatching it sixty times a second while
        // frames arrive would make a render loop out of a state change.
        if (this.confirmable !== before) {
            this.dispatchEvent(new CustomEvent('confirmable', { detail: this.confirmable }));
        }
    }

    _render() {
        const showing = this.state.phase === 'live' && this.state.frames > 0;

        this._overlay.hidden = showing;
        if (!showing) {
            this._overlay.className = `check-overlay${this.state.fatal ? ' fatal' : ''}`;
            this._overlay.textContent = this.state.message || 'Waiting for pictures…';
        }

        this._tools.innerHTML = this._toolsHtml(showing);
        this._readout.innerHTML = this._readoutHtml(showing);
    }

    _toolsHtml(showing) {
        if (this.state.fatal) return '';

        const parts = [];

        if (this.kind === 'spatial') {
            parts.push(
                SPATIAL_LAYOUTS.map(
                    (layout) => `
                        <button class="btn sm ${this._layout === layout.id ? 'active' : ''}"
                            data-preview-act="layout" data-layout="${layout.id}"
                            title="${escapeAttr(layout.hint)}" ${showing ? '' : 'disabled'}>
                            ${layout.label}
                        </button>`
                ).join('')
            );

            parts.push(`
                <button class="btn ghost sm ${this._swapEyes ? 'active' : ''}" data-preview-act="swap"
                    title="Diagnostic only - this swaps the preview, not the broadcast"
                    ${showing ? '' : 'disabled'}>
                    Swap eyes
                </button>
            `);
        }

        if (this.kind === 'standard') {
            const available = Boolean(this.audio?.available);
            const muted = this.audio?.muted !== false;

            parts.push(`
                <button class="btn sm ${available && !muted ? 'active' : ''}" data-preview-act="listen"
                    ${available ? '' : 'disabled'}
                    title="${
                        available
                            ? 'Use headphones - your speakers will feed back into the camera'
                            : audioCodecsAvailable()
                              ? 'No sound has arrived from this broadcast'
                              : 'This browser cannot decode sound'
                    }">
                    ${available && !muted ? 'Listening' : 'Listen'}
                </button>
            `);
        }

        return parts.join('');
    }

    _readoutHtml(showing) {
        const lines = [];

        if (this.state.attributed === false) {
            lines.push(
                `<strong>This is whatever camera is connected.</strong> The server is using the shared stream ` +
                    `key, which identifies a device and not a person, so it cannot prove this picture is yours. ` +
                    `Check it is before confirming.`
            );
        }

        if (showing && this.kind === 'spatial') {
            lines.push(
                this.state.carryingStereo
                    ? `Two eyes are arriving. In <em>Difference</em> a correctly aligned rig cancels to near ` +
                          `black; bright horizontal bands mean the cameras are not level. In <em>Anaglyph</em>, ` +
                          `things close to the camera should sit in front of things behind them - if near and ` +
                          `far are inverted the eyes are the wrong way round, and <em>Swap eyes</em> will ` +
                          `confirm it. Fix that in the capture app: swapping here changes only this preview.`
                    : `Only one eye is arriving, so there is no pair to confirm. Set the capture app to ` +
                          `<strong>Stereo Side-by-Side</strong> and check the second camera is connected.`
            );
        }

        if (showing && this.kind === 'standard') {
            lines.push(
                this.state.audio
                    ? `Picture and sound are both arriving. Press <em>Listen</em> on headphones if you want to ` +
                          `hear it - speakers will feed straight back into the camera.`
                    : `Picture is arriving. No sound has come through yet - if the capture app is set to record ` +
                          `audio, give it a moment or check the microphone permission on the phone.`
            );
        }

        if (showing && this.session) {
            lines.push(
                `<span class="muted">Broadcast ${escapeHtml(this.session.sessionId)} · ` +
                    `${escapeHtml(this.session.device ?? 'unknown device')} · ` +
                    `${this.state.frames} frames shown</span>`
            );
        }

        return lines.map((line) => `<span class="check-line">${line}</span>`).join('');
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

const escapeAttr = escapeHtml;
