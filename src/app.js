import { BUILT_IN_CATALOG, CATALOG_ROWS } from './catalog.js';
import {
  buildDeoVrPayload,
  buildM3u,
  buildPlayaDetailPayload,
  buildPortableMetadata,
  filenameHint,
  formatTime,
  hasCredentialHints,
  layoutLabel,
  normalizeMediaItem,
  projectionLabel,
  safeMediaUrl,
  searchMatches
} from './media-utils.js';
import { StreamAdapter } from './stream-adapter.js';

const STORAGE_KEY = 'projectavr.library.v1';
const ART_CLASSES = ['art-coral', 'art-ocean', 'art-violet', 'art-gold', 'art-mint', 'art-night'];

const refs = {
  topbar: document.querySelector('[data-topbar]'),
  searchInput: document.querySelector('#searchInput'),
  catalogRows: document.querySelector('#catalogRows'),
  catalogStatus: document.querySelector('#catalogStatus'),
  emptyState: document.querySelector('#emptyState'),
  addSourceButton: document.querySelector('#addSourceButton'),
  heroAddButton: document.querySelector('#heroAddButton'),
  heroPlayButton: document.querySelector('#heroPlayButton'),
  capabilitiesButton: document.querySelector('#capabilitiesButton'),
  sourceDialog: document.querySelector('#sourceDialog'),
  sourceForm: document.querySelector('#sourceForm'),
  sourceName: document.querySelector('#sourceName'),
  sourceUrl: document.querySelector('#sourceUrl'),
  sourceFile: document.querySelector('#sourceFile'),
  sourceProjection: document.querySelector('#sourceProjection'),
  sourceLayout: document.querySelector('#sourceLayout'),
  sourceType: document.querySelector('#sourceType'),
  subtitleUrl: document.querySelector('#subtitleUrl'),
  sourceError: document.querySelector('#sourceError'),
  playerDialog: document.querySelector('#playerDialog'),
  playerTitle: document.querySelector('#playerTitle'),
  playerFormat: document.querySelector('#playerFormat'),
  playerDetails: document.querySelector('#playerDetails'),
  modePills: document.querySelector('#modePills'),
  playerStage: document.querySelector('#playerStage'),
  mediaVideo: document.querySelector('#mediaVideo'),
  xrCanvas: document.querySelector('#xrCanvas'),
  loadingState: document.querySelector('#loadingState'),
  playerError: document.querySelector('#playerError'),
  dragHint: document.querySelector('#dragHint'),
  externalButton: document.querySelector('#externalButton'),
  enterVrButton: document.querySelector('#enterVrButton'),
  playPauseButton: document.querySelector('#playPauseButton'),
  currentTime: document.querySelector('#currentTime'),
  duration: document.querySelector('#duration'),
  timeline: document.querySelector('#timeline'),
  muteButton: document.querySelector('#muteButton'),
  volume: document.querySelector('#volume'),
  resetViewButton: document.querySelector('#resetViewButton'),
  fullscreenButton: document.querySelector('#fullscreenButton'),
  externalDialog: document.querySelector('#externalDialog'),
  handoffUrl: document.querySelector('#handoffUrl'),
  filenameHint: document.querySelector('#filenameHint'),
  externalPlayers: document.querySelector('#externalPlayers'),
  copyUrlButton: document.querySelector('#copyUrlButton'),
  shareButton: document.querySelector('#shareButton'),
  downloadPlaylistButton: document.querySelector('#downloadPlaylistButton'),
  downloadMetadataButton: document.querySelector('#downloadMetadataButton'),
  capabilityDialog: document.querySelector('#capabilityDialog'),
  capabilityList: document.querySelector('#capabilityList'),
  toast: document.querySelector('#toast')
};

let userLibrary = loadUserLibrary();
let transientLibrary = [];
let sourceMode = 'url';
let currentItem = null;
let toastTimer = 0;
let playerLoadGeneration = 0;
let capabilityProbeActive = false;
let immersiveRenderer = null;
let immersiveRendererPromise = null;

const streamAdapter = new StreamAdapter(refs.mediaVideo, showPlayerError);

async function getImmersiveRenderer() {
  if (immersiveRenderer) return immersiveRenderer;
  if (!immersiveRendererPromise) {
    immersiveRendererPromise = import('./vr-player.js')
      .then(({ ImmersiveVideoRenderer }) => {
        immersiveRenderer = new ImmersiveVideoRenderer(refs.xrCanvas, refs.mediaVideo, {
          onError: showPlayerError,
          onStatus: updateVrStatus
        });
        return immersiveRenderer;
      })
      .catch((error) => {
        immersiveRendererPromise = null;
        throw error;
      });
  }
  return immersiveRendererPromise;
}

function allItems() {
  return [
    ...BUILT_IN_CATALOG.map((item, index) => normalizeMediaItem(item, index)),
    ...userLibrary,
    ...transientLibrary
  ];
}

function loadUserLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const normalized = Array.isArray(saved)
      ? saved.map((item, index) => normalizeMediaItem(item, index)).filter((item) => !item.local)
      : [];
    const retained = normalized.filter((item) => (
      !hasCredentialHints(item.url) && (!item.subtitleUrl || !hasCredentialHints(item.subtitleUrl))
    ));
    if (retained.length !== normalized.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(retained));
    return retained;
  } catch {
    return [];
  }
}

function persistLibrary() {
  const serializable = userLibrary.map(({ local: _local, template: _template, ephemeral: _ephemeral, ...item }) => item);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function renderCatalog() {
  const query = refs.searchInput.value;
  const items = allItems().filter((item) => searchMatches(item, query));
  const fragment = document.createDocumentFragment();
  let visibleCards = 0;

  for (const row of CATALOG_ROWS) {
    const rowItems = items.filter(row.filter);
    if (!rowItems.length && row.id !== 'library') continue;

    const section = document.createElement('section');
    section.className = 'catalog-row';
    section.id = row.id;
    section.setAttribute('aria-labelledby', `${row.id}-title`);

    const heading = document.createElement('div');
    heading.className = 'row-heading';
    const headingCopy = document.createElement('div');
    const title = document.createElement('h2');
    title.id = `${row.id}-title`;
    title.textContent = row.title;
    const subtitle = document.createElement('p');
    subtitle.textContent = row.subtitle;
    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = `${rowItems.length} ${rowItems.length === 1 ? 'title' : 'titles'}`;
    headingCopy.append(title, subtitle);
    heading.append(headingCopy, count);

    const track = document.createElement('div');
    track.className = 'card-track';
    if (rowItems.length) {
      rowItems.forEach((item, index) => track.append(createMediaCard(item, index)));
      visibleCards += rowItems.length;
    } else {
      track.append(createAddCard());
    }

    section.append(heading, track);
    fragment.append(section);
  }

  refs.catalogRows.replaceChildren(fragment);
  refs.catalogStatus.textContent = `${items.length} ${items.length === 1 ? 'title' : 'titles'} available`;
  refs.emptyState.hidden = Boolean(visibleCards) || !query.trim();
}

function createMediaCard(item, index) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'media-card';
  card.setAttribute('aria-label', `${item.template ? 'Configure' : 'Play'} ${item.title}`);

  const art = document.createElement('span');
  art.className = `card-art ${item.art}`;
  const number = document.createElement('span');
  number.className = 'card-number';
  number.textContent = String(index + 1).padStart(2, '0');
  art.append(number);

  const overlay = document.createElement('span');
  overlay.className = 'card-overlay';
  const badges = document.createElement('span');
  badges.className = 'card-badges';
  [projectionLabel(item.projection), item.layout !== 'mono' ? layoutLabel(item.layout) : item.streamType]
    .filter(Boolean)
    .forEach((label) => {
      const badge = document.createElement('span');
      badge.className = 'card-badge';
      badge.textContent = label;
      badges.append(badge);
    });

  const bottom = document.createElement('span');
  bottom.className = 'card-bottom';
  const copy = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = item.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = item.subtitle;
  const play = document.createElement('span');
  play.className = 'card-play';
  play.setAttribute('aria-hidden', 'true');
  play.textContent = item.template ? '+' : '▶';
  copy.append(title, subtitle);
  bottom.append(copy, play);
  overlay.append(badges, bottom);
  card.append(art, overlay);

  card.addEventListener('click', () => item.template ? openSourceDialog(item) : openPlayer(item));
  return card;
}

function createAddCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'media-card';
  card.setAttribute('aria-label', 'Add a media source');
  const art = document.createElement('span');
  art.className = 'card-art art-night';
  const number = document.createElement('span');
  number.className = 'card-number';
  number.textContent = '+';
  art.append(number);
  const overlay = document.createElement('span');
  overlay.className = 'card-overlay';
  const spacer = document.createElement('span');
  const bottom = document.createElement('span');
  bottom.className = 'card-bottom';
  const copy = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = 'Add your first source';
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = 'Direct URL or local file';
  copy.append(title, subtitle);
  bottom.append(copy);
  overlay.append(spacer, bottom);
  card.append(art, overlay);
  card.addEventListener('click', () => openSourceDialog());
  return card;
}

function openSourceDialog(preset = {}) {
  refs.sourceForm.reset();
  refs.sourceError.hidden = true;
  refs.sourceName.value = preset.template ? '' : preset.title || '';
  refs.sourceProjection.value = preset.projection || 'flat';
  refs.sourceLayout.value = preset.layout || 'mono';
  refs.sourceType.value = preset.streamType || 'auto';
  switchSourceMode('url');
  refs.sourceDialog.showModal();
  window.setTimeout(() => refs.sourceName.focus(), 0);
}

function switchSourceMode(mode) {
  sourceMode = mode;
  const urlField = document.querySelector('[data-url-field]');
  const fileField = document.querySelector('[data-file-field]');
  urlField.hidden = mode !== 'url';
  fileField.hidden = mode !== 'file';
  refs.sourceUrl.required = mode === 'url';
  refs.sourceFile.required = mode === 'file';
  document.querySelectorAll('[data-source-tab]').forEach((tab) => {
    const active = tab.dataset.sourceTab === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
}

async function submitSource(event) {
  event.preventDefault();
  refs.sourceError.hidden = true;

  try {
    const file = refs.sourceFile.files?.[0];
    if (sourceMode === 'file' && !file) throw new Error('Choose a video file from this device.');
    const url = sourceMode === 'file' ? URL.createObjectURL(file) : safeMediaUrl(refs.sourceUrl.value);
    const item = normalizeMediaItem({
      id: `user-${crypto.randomUUID?.() || Date.now()}`,
      title: refs.sourceName.value,
      subtitle: sourceMode === 'file' ? `${file.name} · local` : 'Personal library source',
      description: 'A source added to ProjectAVR on this device.',
      url,
      projection: refs.sourceProjection.value,
      layout: refs.sourceLayout.value,
      streamType: sourceMode === 'file' ? 'file' : refs.sourceType.value,
      subtitleUrl: refs.subtitleUrl.value,
      art: ART_CLASSES[(userLibrary.length + transientLibrary.length) % ART_CLASSES.length],
      tags: ['library', refs.sourceProjection.value, refs.sourceLayout.value],
      local: sourceMode === 'file',
      ephemeral: sourceMode === 'url' && (
        hasCredentialHints(url) || (refs.subtitleUrl.value && hasCredentialHints(refs.subtitleUrl.value))
      )
    });

    if (item.local || item.ephemeral) transientLibrary.push(item);
    else {
      userLibrary.push(item);
      persistLibrary();
    }
    renderCatalog();
    refs.sourceDialog.close();
    if (item.ephemeral) showToast('Credential-bearing URL kept for this session only');
    await openPlayer(item);
  } catch (error) {
    refs.sourceError.textContent = error.message || 'The source could not be added.';
    refs.sourceError.hidden = false;
  }
}

async function openPlayer(item) {
  const loadGeneration = ++playerLoadGeneration;
  const isCurrentLoad = () => (
    loadGeneration === playerLoadGeneration && currentItem === item && refs.playerDialog.open
  );
  currentItem = item;
  immersiveRenderer?.clearMedia?.();
  clearPlayerError();
  refs.loadingState.hidden = false;
  refs.playerDialog.showModal();
  refs.playerTitle.textContent = item.title;
  refs.playerFormat.textContent = `${projectionLabel(item.projection).toUpperCase()} VIDEO`;
  refs.playerDetails.textContent = `${item.streamType.toUpperCase()} · ${projectionLabel(item.projection)} · ${layoutLabel(item.layout)}`;
  refs.playerStage.classList.toggle('is-immersive', item.projection !== 'flat');
  refs.dragHint.hidden = item.projection === 'flat';
  refs.resetViewButton.hidden = item.projection === 'flat';
  refs.enterVrButton.hidden = item.projection === 'flat';
  refs.enterVrButton.disabled = true;
  refs.externalButton.disabled = false;
  renderModePills(item);

  try {
    await streamAdapter.load(item);
    if (!isCurrentLoad()) return;
    if (item.projection !== 'flat') {
      const renderer = await getImmersiveRenderer();
      if (!isCurrentLoad()) return;
      await renderer.setMedia(item);
      if (!isCurrentLoad()) {
        renderer.clearMedia?.();
        return;
      }
      renderer.resize();
      refs.enterVrButton.disabled = !renderer.isVrAvailable();
      refs.enterVrButton.title = renderer.isVrAvailable()
        ? 'Enter immersive VR'
        : 'Open over HTTPS in a WebXR-compatible headset browser';
    }
    if (!isCurrentLoad()) return;
    refs.loadingState.hidden = true;
    await refs.mediaVideo.play().catch(() => {});
    if (!isCurrentLoad()) return;
    updateTransport();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (!isCurrentLoad()) return;
    refs.loadingState.hidden = true;
    showPlayerError(error.message || 'The media source could not be opened.');
  }
}

function renderModePills(item) {
  refs.modePills.replaceChildren();
  [projectionLabel(item.projection), layoutLabel(item.layout), item.streamType.toUpperCase()]
    .forEach((label) => {
      const pill = document.createElement('span');
      pill.className = 'mode-pill';
      pill.textContent = label;
      refs.modePills.append(pill);
    });
}

async function closePlayer() {
  playerLoadGeneration += 1;
  await immersiveRenderer?.exitVr?.().catch(() => {});
  immersiveRenderer?.clearMedia?.();
  refs.mediaVideo.pause();
  streamAdapter.reset();
  if (refs.playerDialog.open) refs.playerDialog.close();
  currentItem = null;
}

function showPlayerError(message) {
  refs.playerError.textContent = message;
  refs.playerError.hidden = false;
}

function clearPlayerError() {
  refs.playerError.textContent = '';
  refs.playerError.hidden = true;
}

function updateVrStatus(status) {
  refs.enterVrButton.disabled = !status.available;
  refs.enterVrButton.innerHTML = status.presenting
    ? '<span aria-hidden="true">◉</span> In VR'
    : '<span aria-hidden="true">◉</span> Enter VR';
}

function updateTransport() {
  const { currentTime, duration, paused, muted, volume } = refs.mediaVideo;
  refs.currentTime.textContent = formatTime(currentTime);
  refs.duration.textContent = formatTime(duration);
  refs.timeline.value = Number.isFinite(duration) && duration > 0 ? String(Math.round(currentTime / duration * 1000)) : '0';
  refs.timeline.setAttribute('aria-valuetext', `${formatTime(currentTime)} of ${formatTime(duration)}`);
  refs.playPauseButton.textContent = paused ? '▶' : 'Ⅱ';
  refs.playPauseButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  refs.muteButton.textContent = muted || volume === 0 ? '○' : '◕';
  refs.muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

function openExternalDialog() {
  if (!currentItem) return;
  const reusable = Boolean(currentItem.url && !currentItem.url.startsWith('blob:'));
  refs.handoffUrl.textContent = reusable ? currentItem.url : 'Local file — available only on this device';
  refs.filenameHint.textContent = filenameHint(currentItem);
  [refs.copyUrlButton, refs.shareButton, refs.downloadPlaylistButton].forEach((button) => { button.disabled = !reusable; });
  renderExternalPlayers(currentItem, reusable);
  refs.externalDialog.showModal();
}

function renderExternalPlayers(item, reusable) {
  const players = [
    {
      name: 'DeoVR',
      status: 'JSON + URL',
      copy: 'Export a single-video JSON file, host it over HTTPS, then open its deovr:// URL.',
      action: 'Export DeoVR JSON',
      onClick: () => downloadJson(buildDeoVrPayload(item, {
        resolution: refs.mediaVideo.videoHeight || undefined
      }), `${slug(item.title)}.deovr.json`)
    },
    {
      name: 'PLAY’A',
      status: 'API v2',
      copy: 'Use the exported detail payload inside a hosted PLAY’A API v2 catalog.',
      action: 'Export PLAY’A detail',
      onClick: () => downloadJson(buildPlayaDetailPayload(item, {
        durationSeconds: Number.isFinite(refs.mediaVideo.duration) ? refs.mediaVideo.duration : undefined
      }), `${slug(item.title)}.playa.json`)
    },
    {
      name: 'SKYBOX VR Player',
      status: 'File / WebDAV',
      copy: 'Use a renamed local file, WebDAV, SMB, DLNA, USB, or SKYBOX AirScreen.',
      href: 'https://forum.skybox.xyz/d/157-filename-rules-for-vr-format',
      action: 'Filename rules ↗'
    },
    {
      name: 'Pigasus VR Player',
      status: 'File / LAN',
      copy: 'Use local storage, UPnP/DLNA, or Samba and select the matching projection.',
      href: 'https://hanginghatstudios.com/pigasus-faq/',
      action: 'Player guide ↗'
    },
    {
      name: 'Whirligig',
      status: 'File / PC CLI',
      copy: 'Open a local file and choose flat, barrel/equirectangular, SBS, or over-under; PC builds also expose projection flags.',
      href: 'https://www.whirligig.xyz/command-line',
      action: 'Player guide ↗'
    }
  ];

  refs.externalPlayers.replaceChildren(...players.map((player) => {
    const card = document.createElement('article');
    card.className = 'external-player';
    const header = document.createElement('header');
    const name = document.createElement('strong');
    name.textContent = player.name;
    const status = document.createElement('span');
    status.textContent = player.status;
    header.append(name, status);
    const copy = document.createElement('p');
    copy.textContent = player.copy;
    card.append(header, copy);

    if (player.onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = player.action;
      button.disabled = !reusable;
      button.addEventListener('click', player.onClick);
      card.append(button);
    } else {
      const link = document.createElement('a');
      link.href = player.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = player.action;
      card.append(link);
    }
    return card;
  }));
}

async function renderCapabilities() {
  if (capabilityProbeActive || refs.capabilityDialog.open) return;
  capabilityProbeActive = true;
  try {
    const testVideo = document.createElement('video');
    const webgl2 = Boolean(document.createElement('canvas').getContext('webgl2'));
    let immersiveVr = false;
    try {
      immersiveVr = Boolean(await navigator.xr?.isSessionSupported?.('immersive-vr'));
    } catch {
      immersiveVr = false;
    }

    const capabilities = [
      ['Secure context', window.isSecureContext || location.hostname === 'localhost', 'HTTPS or localhost required'],
      ['WebGL 2', webgl2, 'Required for immersive renderer'],
      ['WebXR immersive VR', immersiveVr, 'Headset/browser dependent'],
      ['H.264 / MP4', Boolean(testVideo.canPlayType('video/mp4; codecs="avc1.42E01E"')), 'Browser codec support'],
      ['VP9 / WebM', Boolean(testVideo.canPlayType('video/webm; codecs="vp9"')), 'Browser codec support'],
      ['Native HLS', Boolean(testVideo.canPlayType('application/vnd.apple.mpegurl')), 'hls.js fallback included'],
      ['Media Source Extensions', 'MediaSource' in window, 'HLS and DASH fallback engine']
    ];

    refs.capabilityList.replaceChildren(...capabilities.map(([label, supported, detail]) => {
      const row = document.createElement('div');
      row.className = `capability-row${supported ? '' : ' is-limited'}`;
      const copy = document.createElement('span');
      copy.textContent = label;
      copy.title = detail;
      const status = document.createElement('span');
      status.textContent = supported ? 'AVAILABLE' : 'LIMITED';
      row.append(copy, status);
      return row;
    }));
    if (!refs.capabilityDialog.open) refs.capabilityDialog.showModal();
  } finally {
    capabilityProbeActive = false;
  }
}

function slug(value) {
  return String(value || 'projectavr').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'projectavr';
}

function downloadText(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson(value, filename) {
  downloadText(`${JSON.stringify(value, null, 2)}\n`, filename, 'application/json');
}

async function copyCurrentUrl() {
  if (!currentItem?.url || currentItem.url.startsWith('blob:')) return;
  await navigator.clipboard.writeText(currentItem.url);
  showToast('Direct media URL copied');
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => refs.toast.classList.remove('is-visible'), 2600);
}

function installEvents() {
  window.addEventListener('scroll', () => refs.topbar.classList.toggle('is-scrolled', window.scrollY > 24), { passive: true });
  refs.searchInput.addEventListener('input', renderCatalog);
  refs.addSourceButton.addEventListener('click', () => openSourceDialog());
  refs.heroAddButton.addEventListener('click', () => openSourceDialog({ projection: '360', layout: 'mono' }));
  refs.heroPlayButton.addEventListener('click', () => openPlayer(allItems().find((item) => item.id === 'showcase')));
  refs.capabilitiesButton.addEventListener('click', renderCapabilities);
  refs.sourceForm.addEventListener('submit', submitSource);
  document.querySelectorAll('[data-source-tab]').forEach((tab) => tab.addEventListener('click', () => switchSourceMode(tab.dataset.sourceTab)));
  document.querySelectorAll('[data-open-source]').forEach((button) => button.addEventListener('click', () => openSourceDialog()));
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('[data-close-player]').forEach((button) => button.addEventListener('click', closePlayer));

  for (const dialog of [refs.sourceDialog, refs.externalDialog, refs.capabilityDialog]) {
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }
  refs.playerDialog.addEventListener('cancel', (event) => { event.preventDefault(); closePlayer(); });

  refs.mediaVideo.addEventListener('timeupdate', updateTransport);
  refs.mediaVideo.addEventListener('durationchange', updateTransport);
  refs.mediaVideo.addEventListener('play', updateTransport);
  refs.mediaVideo.addEventListener('pause', updateTransport);
  refs.mediaVideo.addEventListener('playing', () => { refs.loadingState.hidden = true; });
  refs.mediaVideo.addEventListener('waiting', () => { refs.loadingState.hidden = false; });
  refs.mediaVideo.addEventListener('error', () => {
    if (refs.mediaVideo.error) showPlayerError('The browser rejected this media source or codec.');
  });

  refs.playPauseButton.addEventListener('click', () => {
    if (refs.mediaVideo.paused) refs.mediaVideo.play().catch((error) => showPlayerError(error.message));
    else refs.mediaVideo.pause();
  });
  refs.timeline.addEventListener('input', () => {
    if (Number.isFinite(refs.mediaVideo.duration)) {
      refs.mediaVideo.currentTime = Number(refs.timeline.value) / 1000 * refs.mediaVideo.duration;
    }
  });
  refs.muteButton.addEventListener('click', () => {
    refs.mediaVideo.muted = !refs.mediaVideo.muted;
    updateTransport();
  });
  refs.volume.addEventListener('input', () => {
    refs.mediaVideo.volume = Number(refs.volume.value);
    refs.mediaVideo.muted = refs.mediaVideo.volume === 0;
    updateTransport();
  });
  refs.resetViewButton.addEventListener('click', () => immersiveRenderer?.resetView());
  refs.fullscreenButton.addEventListener('click', () => refs.playerStage.requestFullscreen?.());
  refs.enterVrButton.addEventListener('click', () => {
    getImmersiveRenderer()
      .then((renderer) => renderer.enterVr())
      .catch((error) => showPlayerError(error.message));
  });
  refs.externalButton.addEventListener('click', openExternalDialog);

  refs.copyUrlButton.addEventListener('click', copyCurrentUrl);
  refs.shareButton.addEventListener('click', async () => {
    if (!currentItem?.url) return;
    if (navigator.share) {
      await navigator.share({
        title: currentItem.title,
        text: 'Open this video source',
        url: currentItem.url
      }).catch(() => {});
    } else {
      await copyCurrentUrl();
    }
  });
  refs.downloadPlaylistButton.addEventListener('click', () => {
    if (!currentItem) return;
    try {
      downloadText(buildM3u(currentItem), `${slug(currentItem.title)}.m3u`, 'audio/x-mpegurl');
    } catch (error) {
      showToast(error.message);
    }
  });
  refs.downloadMetadataButton.addEventListener('click', () => {
    if (currentItem) {
      downloadJson(buildPortableMetadata(currentItem), `${slug(currentItem.title)}.projectavr.json`);
    }
  });
}

installEvents();
renderCatalog();
updateTransport();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
