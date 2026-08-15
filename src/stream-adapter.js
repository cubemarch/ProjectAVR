import { inferStreamType } from './media-utils.js';

const HLS_MODULE = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.0/dist/hls.mjs';
const DASH_MODULE = 'https://cdn.jsdelivr.net/npm/dashjs@5.2.0/dist/modern/esm/dash.all.min.js';

function createAbortError() {
  const error = new Error('The media load was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitForMetadata(video, signal, timeoutMs = 20_000) {
  if (signal.aborted) return Promise.reject(createAbortError());
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('The media source did not respond in time.'));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => {
      cleanup();
      reject(new Error(video.error?.message || 'The browser could not load this media source.'));
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class StreamAdapter {
  constructor(video, onError = () => {}) {
    this.video = video;
    this.onError = onError;
    this.hls = null;
    this.dash = null;
    this.loadGeneration = 0;
    this.loadContext = null;
  }

  async load(item) {
    this.reset();
    const context = this.createLoadContext();
    const { video } = this;
    const type = inferStreamType(item.url, item.streamType);

    video.playsInline = true;
    video.preload = 'metadata';
    video.loop = false;
    video.muted = false;

    // Video textures and JavaScript adaptive-stream clients require CORS.
    if (item.projection !== 'flat' || type !== 'file' || item.subtitleUrl) {
      video.crossOrigin = 'anonymous';
    } else {
      video.removeAttribute('crossorigin');
    }

    this.attachSubtitle(item.subtitleUrl);

    try {
      if (type === 'hls') {
        await this.loadHls(item.url, context);
      } else if (type === 'dash') {
        await this.loadDash(item.url, context);
      } else {
        video.src = item.url;
        video.load();
      }

      await Promise.race([
        waitForMetadata(video, context.controller.signal),
        context.failurePromise
      ]);
      this.assertCurrent(context);
      context.completed = true;
    } catch (error) {
      if (this.isCurrent(context)) this.disposeFailedLoad(context);
      throw error;
    }
  }

  async loadHls(url, context) {
    const { video } = this;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.load();
      return;
    }

    const module = await Promise.race([import(HLS_MODULE), context.failurePromise]);
    this.assertCurrent(context);
    const Hls = module.default;
    if (!Hls?.isSupported()) {
      throw new Error('HLS is not supported by this browser.');
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 60
    });
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      let message;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        message = 'The HLS stream returned a fatal network error. Check CORS and the manifest URL.';
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        message = `The HLS stream encountered a fatal media error: ${data.details || 'unknown error'}.`;
      } else {
        message = `HLS playback stopped: ${data.details || 'unknown error'}.`;
      }
      this.handleAdaptiveFailure(context, hls, new Error(message));
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  async loadDash(url, context) {
    const module = await Promise.race([import(DASH_MODULE), context.failurePromise]);
    this.assertCurrent(context);
    const dashjs = module.default || module;
    if (!dashjs?.MediaPlayer) {
      throw new Error('The MPEG-DASH player could not be initialized.');
    }
    const dash = dashjs.MediaPlayer().create();
    this.dash = dash;
    dash.on('error', (event) => {
      const message = event?.error?.message || event?.event?.message || 'MPEG-DASH playback error.';
      this.handleAdaptiveFailure(context, dash, new Error(message));
    });
    dash.initialize(this.video, url, false);
  }

  createLoadContext() {
    const controller = new AbortController();
    let rejectFailure;
    const failurePromise = new Promise((_resolve, reject) => { rejectFailure = reject; });
    // The active race observes this rejection. This extra handler also prevents an unhandled
    // rejection if reset happens in the small synchronous window before that race is installed.
    failurePromise.catch(() => {});

    const context = {
      generation: ++this.loadGeneration,
      controller,
      failurePromise,
      rejectFailure,
      completed: false,
      failed: false
    };
    controller.signal.addEventListener('abort', () => {
      if (!context.failed) {
        context.failed = true;
        rejectFailure(createAbortError());
      }
    }, { once: true });
    this.loadContext = context;
    return context;
  }

  isCurrent(context) {
    return this.loadContext === context && context.generation === this.loadGeneration && !context.controller.signal.aborted;
  }

  assertCurrent(context) {
    if (!this.isCurrent(context)) throw createAbortError();
  }

  handleAdaptiveFailure(context, player, error) {
    const ownsPlayer = this.hls === player || this.dash === player;
    if (!ownsPlayer || !this.isCurrent(context) || context.failed) return;
    context.failed = true;
    if (context.completed) {
      this.onError(error.message);
      this.reset();
    } else {
      context.rejectFailure(error);
    }
  }

  teardownPlayers() {
    const hls = this.hls;
    const dash = this.dash;
    this.hls = null;
    this.dash = null;
    hls?.destroy();
    dash?.reset();
  }

  clearVideo() {
    this.video.pause();
    for (const track of [...this.video.querySelectorAll('track[data-projectavr]')]) track.remove();
    this.video.removeAttribute('src');
    this.video.load();
  }

  disposeFailedLoad(context) {
    this.loadContext = null;
    context.controller.abort();
    this.teardownPlayers();
    this.clearVideo();
  }

  attachSubtitle(url) {
    for (const track of [...this.video.querySelectorAll('track[data-projectavr]')]) track.remove();
    if (!url) return;
    const track = document.createElement('track');
    track.dataset.projectavr = 'true';
    track.kind = 'subtitles';
    track.label = 'Subtitles';
    track.srclang = 'en';
    track.src = url;
    track.default = true;
    this.video.append(track);
  }

  reset() {
    this.loadGeneration += 1;
    const context = this.loadContext;
    this.loadContext = null;
    context?.controller.abort();
    this.teardownPlayers();
    this.clearVideo();
  }

  destroy() {
    this.reset();
  }
}
