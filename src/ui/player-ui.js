import * as pc from 'playcanvas';
import { icons } from './icons.js';
import { formatDuration } from '../catalog/catalog.js';
import { PROJECTION, STEREO } from '../catalog/media-format.js';

/**
 * 2D transport chrome shown over the video, on the desktop/mobile path and as
 * the pre-flight controls before entering a headset.
 *
 * Emits: 'back', 'enterVr', 'recenter', 'formatChange' (format)
 */
export class PlayerUI extends pc.EventHandler {
    /**
     * @param {HTMLElement} shell - The `.player-shell` element.
     * @param {import('../player/video-source.js').VideoSource} video
     * @param {{xrSupported: boolean}} caps
     */
    constructor(shell, video, caps) {
        super();

        this.shell = shell;
        this.video = video;
        this.caps = caps;
        this.item = null;
        this.format = null;

        this._idleTimer = null;
        this._scrubbing = false;

        this._build();
        this._bind();
    }

    _build() {
        const chrome = document.createElement('div');
        chrome.className = 'player-chrome';
        chrome.innerHTML = `
            <div class="player-top">
                <button class="ctl" data-action="back" title="Back to browse">${icons.back()}</button>
                <h3 data-el="title"></h3>
                <div class="spacer"></div>
                <span class="badge vr" data-el="fmt"></span>
            </div>
            <div class="player-bottom">
                <div class="scrubber" data-el="scrubber">
                    <div class="buffered" data-el="buffered"></div>
                    <div class="played" data-el="played"></div>
                    <div class="knob" data-el="knob"></div>
                </div>
                <div class="player-controls">
                    <button class="ctl" data-action="playpause" data-el="playpause">${icons.play()}</button>
                    <button class="ctl" data-action="back10" title="Back 10s">${icons.back10()}</button>
                    <button class="ctl" data-action="forward10" title="Forward 10s">${icons.forward10()}</button>
                    <button class="ctl" data-action="mute" data-el="mute">${icons.volume()}</button>
                    <span class="time" data-el="time">0:00 / 0:00</span>

                    <div class="spacer"></div>

                    <button class="ctl wide" data-action="projection" data-el="projection" title="Override projection">
                        ${icons.settings({ size: 15 })} <span data-el="projection-label">Flat</span>
                    </button>
                    <button class="ctl wide" data-action="stereo" data-el="stereo" title="Override stereo layout">
                        <span data-el="stereo-label">Mono</span>
                    </button>
                    <button class="ctl" data-action="recenter" title="Recentre view">${icons.recenter()}</button>
                    <button class="ctl wide" data-action="vr" data-el="vr" title="Enter VR">
                        ${icons.headset({ size: 16 })} VR
                    </button>
                    <button class="ctl" data-action="fullscreen" title="Fullscreen">${icons.fullscreen()}</button>
                </div>
            </div>
        `;

        this.shell.appendChild(chrome);
        this.chrome = chrome;

        this.el = {};
        chrome.querySelectorAll('[data-el]').forEach((node) => {
            this.el[node.dataset.el] = node;
        });
    }

    _bind() {
        this.chrome.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            e.stopPropagation();
            this._action(btn.dataset.action);
        });

        // Click anywhere on the video area toggles playback, the way every
        // streaming player behaves.
        this.shell.addEventListener('click', (e) => {
            if (e.target.closest('.player-controls') || e.target.closest('.player-top')) return;
            this.video.togglePlay();
        });

        this._bindScrubber();

        ['play', 'pause'].forEach((evt) => this.video.on(evt, () => this._syncPlayButton()));
        this.video.on('timeupdate', () => this._syncTime());
        this.video.on('durationchange', () => this._syncTime());
        this.video.on('volumechange', () => this._syncVolume());

        const wake = () => this.showChrome();
        this.shell.addEventListener('pointermove', wake);
        this.shell.addEventListener('pointerdown', wake);

        window.addEventListener('keydown', (e) => this._onKey(e));
    }

    _bindScrubber() {
        const bar = this.el.scrubber;

        const seekFromEvent = (e) => {
            const rect = bar.getBoundingClientRect();
            const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
            this.video.seekTo(ratio * this.video.duration);
        };

        bar.addEventListener('pointerdown', (e) => {
            this._scrubbing = true;
            bar.setPointerCapture(e.pointerId);
            seekFromEvent(e);
        });

        bar.addEventListener('pointermove', (e) => {
            if (this._scrubbing) seekFromEvent(e);
        });

        const stop = (e) => {
            if (!this._scrubbing) return;
            this._scrubbing = false;
            try {
                bar.releasePointerCapture(e.pointerId);
            } catch {
                /* pointer already released */
            }
        };

        bar.addEventListener('pointerup', stop);
        bar.addEventListener('pointercancel', stop);
    }

    _onKey(e) {
        if (!this.shell.offsetParent) return;
        if (e.target.tagName === 'INPUT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.video.togglePlay();
                break;
            case 'ArrowLeft':
                this.video.seekBy(-10);
                break;
            case 'ArrowRight':
                this.video.seekBy(10);
                break;
            case 'ArrowUp':
                this.video.volume += 0.1;
                break;
            case 'ArrowDown':
                this.video.volume -= 0.1;
                break;
            case 'm':
                this.video.muted = !this.video.muted;
                break;
            case 'f':
                this._action('fullscreen');
                break;
            case 'c':
                this.fire('recenter');
                break;
            case 'Escape':
                this.fire('back');
                break;
        }

        this.showChrome();
    }

    _action(name) {
        switch (name) {
            case 'back':
                this.fire('back');
                break;
            case 'playpause':
                this.video.togglePlay();
                break;
            case 'back10':
                this.video.seekBy(-10);
                break;
            case 'forward10':
                this.video.seekBy(10);
                break;
            case 'mute':
                this.video.muted = !this.video.muted;
                break;
            case 'recenter':
                this.fire('recenter');
                break;
            case 'vr':
                this.fire('enterVr');
                break;
            case 'projection':
                this._cycleProjection();
                break;
            case 'stereo':
                this._cycleStereo();
                break;
            case 'fullscreen':
                if (document.fullscreenElement) document.exitFullscreen();
                else document.documentElement.requestFullscreen?.();
                break;
        }
    }

    /**
     * Manual projection override.
     *
     * Auto-detection covers well-named files, but a mislabelled download is
     * common enough that every serious VR player offers a manual cycle. This is
     * ours.
     */
    _cycleProjection() {
        const order = [PROJECTION.FLAT, PROJECTION.DOME180, PROJECTION.SPHERE360, PROJECTION.FISHEYE];
        const next = order[(order.indexOf(this.format.projection) + 1) % order.length];

        this.format = { ...this.format, projection: next, fisheyeFov: this.format.fisheyeFov || 190 };
        this._syncFormat();
        this.fire('formatChange', this.format);
    }

    _cycleStereo() {
        const order = [STEREO.MONO, STEREO.SBS, STEREO.TB];
        const next = order[(order.indexOf(this.format.stereo) + 1) % order.length];

        this.format = { ...this.format, stereo: next };
        this._syncFormat();
        this.fire('formatChange', this.format);
    }

    /**
     * @param {object} item
     * @param {object} format
     */
    setItem(item, format) {
        this.item = item;
        this.format = format;

        this.el.title.textContent = item.title;
        this.el.vr.style.display = this.caps.xrSupported ? '' : 'none';

        this._syncFormat();
        this._syncTime();
        this._syncPlayButton();
        this._syncVolume();
        this.showChrome();
    }

    _syncFormat() {
        const f = this.format;

        const projLabel =
            f.projection === PROJECTION.DOME180
                ? '180°'
                : f.projection === PROJECTION.SPHERE360
                  ? '360°'
                  : f.projection === PROJECTION.FISHEYE
                    ? `Fisheye ${f.fisheyeFov}°`
                    : 'Flat';

        const stereoLabel = f.stereo === STEREO.SBS ? 'SBS 3D' : f.stereo === STEREO.TB ? 'OU 3D' : 'Mono';

        this.el['projection-label'].textContent = projLabel;
        this.el['stereo-label'].textContent = stereoLabel;
        this.el.fmt.textContent = `${projLabel} · ${stereoLabel}`;

        this.el.projection.classList.toggle('active', f.projection !== PROJECTION.FLAT);
        this.el.stereo.classList.toggle('active', f.stereo !== STEREO.MONO);
    }

    _syncPlayButton() {
        this.el.playpause.innerHTML = this.video.paused ? icons.play() : icons.pause();
        if (!this.video.paused) this.scheduleHide();
    }

    _syncVolume() {
        this.el.mute.innerHTML = this.video.muted || this.video.volume === 0 ? icons.mute() : icons.volume();
    }

    _syncTime() {
        if (this._scrubbing) return;

        const pct = this.video.progress * 100;
        this.el.played.style.width = `${pct}%`;
        this.el.knob.style.left = `${pct}%`;
        this.el.time.textContent = `${formatDuration(this.video.currentTime)} / ${formatDuration(this.video.duration)}`;

        const buffered = this.video.element.buffered;
        if (buffered.length && this.video.duration) {
            const end = buffered.end(buffered.length - 1);
            this.el.buffered.style.width = `${(end / this.video.duration) * 100}%`;
        }
    }

    showChrome() {
        this.chrome.classList.remove('hidden');
        this.scheduleHide();
    }

    scheduleHide() {
        clearTimeout(this._idleTimer);
        if (this.video.paused) return;

        this._idleTimer = setTimeout(() => {
            this.chrome.classList.add('hidden');
        }, 3200);
    }

    /** Hide the flat chrome while an XR session owns the display. */
    setImmersive(immersive) {
        this.chrome.style.display = immersive ? 'none' : '';
    }
}
