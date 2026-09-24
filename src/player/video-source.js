import * as pc from 'playcanvas';

/**
 * The single HTMLVideoElement that backs every playback surface.
 *
 * There is deliberately only one of these for the whole app. The DOM player and
 * the WebXR renderer both read from it, so entering or leaving immersive mode
 * is a change of *presentation* rather than a reload: playback position, buffer
 * and audio all survive the transition, and there is never a moment where two
 * decoders are competing for the same stream.
 *
 * Autoplay policy note: browsers - and the Quest browser in particular - only
 * allow playback to start from a user gesture. Every call path into `play()`
 * here originates from a click or a controller press for that reason.
 */
export class VideoSource extends pc.EventHandler {
    /**
     * @param {pc.Application} app
     */
    constructor(app) {
        super();

        this.app = app;
        this.item = null;
        this._hls = null;

        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'metadata';
        video.loop = false;
        video.className = 'avr-video';
        this.element = video;

        // 4K/8K stereo frames are large; mipmaps would cost a full chain rebuild
        // every frame for no benefit, since the video always fills the view.
        this.texture = new pc.Texture(app.graphicsDevice, {
            name: 'avr-video',
            format: pc.PIXELFORMAT_RGB8,
            minFilter: pc.FILTER_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false,
            flipY: true
        });
        this.texture.setSource(video);

        this._bindEvents();
    }

    _bindEvents() {
        const v = this.element;

        const forward = (domEvent, name) => {
            v.addEventListener(domEvent, () => this.fire(name, this));
        };

        forward('play', 'play');
        forward('pause', 'pause');
        forward('ended', 'ended');
        forward('waiting', 'buffering');
        forward('playing', 'playing');
        forward('timeupdate', 'timeupdate');
        forward('durationchange', 'durationchange');
        forward('volumechange', 'volumechange');

        v.addEventListener('loadedmetadata', () => {
            this.fire('loadedmetadata', this);
        });

        v.addEventListener('error', () => {
            const err = v.error;
            this.fire('error', err ? `${err.code}: ${err.message || 'media error'}` : 'unknown media error');
        });
    }

    /**
     * Point the element at a catalog item.
     *
     * HLS sources get hls.js on browsers without native support, which includes
     * the Chromium-based headset browsers. It is imported lazily so the ~200 KB
     * never lands on users playing progressive MP4s.
     *
     * @param {object} item - Catalog entry with a `src`.
     * @returns {Promise<void>}
     */
    async load(item) {
        this.item = item;
        this._teardownHls();

        const src = item.src;
        const isHls = /\.m3u8(\?|$)/i.test(src);

        if (isHls && !this.element.canPlayType('application/vnd.apple.mpegurl')) {
            const { default: Hls } = await import('hls.js');
            if (Hls.isSupported()) {
                const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
                hls.loadSource(src);
                hls.attachMedia(this.element);
                this._hls = hls;
            } else {
                this.element.src = src;
            }
        } else {
            this.element.src = src;
        }

        await new Promise((resolve) => {
            if (this.element.readyState >= 1) return resolve();
            this.element.addEventListener('loadedmetadata', resolve, { once: true });
            this.element.addEventListener('error', resolve, { once: true });
        });
    }

    _teardownHls() {
        if (this._hls) {
            this._hls.destroy();
            this._hls = null;
        }
        this.element.removeAttribute('src');
        this.element.load();
    }

    /** Push the current video frame to the GPU. Call once per rendered frame. */
    updateTexture() {
        if (this.element.readyState >= 2) {
            this.texture.upload();
        }
    }

    /** @returns {Promise<void>} */
    play() {
        const result = this.element.play();
        return result && result.catch ? result.catch((err) => this.fire('error', err.message)) : Promise.resolve();
    }

    pause() {
        this.element.pause();
    }

    togglePlay() {
        if (this.element.paused) this.play();
        else this.pause();
    }

    /** @param {number} seconds - Relative offset; negative rewinds. */
    seekBy(seconds) {
        this.seekTo(this.element.currentTime + seconds);
    }

    /** @param {number} seconds */
    seekTo(seconds) {
        const duration = this.element.duration;
        const max = Number.isFinite(duration) ? duration : Number.MAX_SAFE_INTEGER;
        this.element.currentTime = Math.min(Math.max(seconds, 0), max);
    }

    get paused() {
        return this.element.paused;
    }

    get currentTime() {
        return this.element.currentTime;
    }

    get duration() {
        return Number.isFinite(this.element.duration) ? this.element.duration : 0;
    }

    get progress() {
        return this.duration > 0 ? this.currentTime / this.duration : 0;
    }

    /**
     * Aspect ratio of a *single eye*, which is what the cinema screen needs.
     *
     * @param {object} format - Result of `resolveFormat`.
     * @returns {number}
     */
    aspectForFormat(format) {
        const w = this.element.videoWidth || 1920;
        const h = this.element.videoHeight || 1080;

        if (format.stereo === 'sbs') return (w / 2) / h;
        if (format.stereo === 'tb') return w / (h / 2);
        return w / h;
    }

    get volume() {
        return this.element.volume;
    }

    set volume(value) {
        this.element.volume = Math.min(Math.max(value, 0), 1);
    }

    get muted() {
        return this.element.muted;
    }

    set muted(value) {
        this.element.muted = value;
    }

    destroy() {
        this._teardownHls();
        this.texture.destroy();
    }
}
