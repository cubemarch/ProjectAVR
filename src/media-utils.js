const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'blob:']);
const CREDENTIAL_QUERY_KEY = /(?:^|[-_])(token|auth|authorization|credential|signature|signed|jwt|session|secret|policy|expires|access[-_]?key|key[-_]?pair[-_]?id)(?:$|[-_])/i;

export const PROJECTIONS = Object.freeze({
  flat: { label: 'Flat', code: 0, filename: '' },
  '180': { label: '180°', code: 1, filename: '_180' },
  '360': { label: '360°', code: 0, filename: '_360' }
});

export const LAYOUTS = Object.freeze({
  mono: { label: 'Mono', code: 0, eyeOrder: 0, filename: '' },
  sbs: { label: 'Side-by-side', code: 1, eyeOrder: 0, filename: '_LR' },
  tb: { label: 'Top-bottom', code: 2, eyeOrder: 0, filename: '_TB' },
  'sbs-reverse': { label: 'Side-by-side reversed', code: 1, eyeOrder: 1, filename: '_RL' },
  'tb-reverse': { label: 'Bottom-top', code: 2, eyeOrder: 1, filename: '_BT' }
});

export function safeMediaUrl(value, base = 'https://projectavr.local/') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('A media URL is required.');
  }

  const url = new URL(value.trim(), base);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new TypeError('Use an HTTP(S) URL or a local video file.');
  }
  return url.href;
}

export function hasCredentialHints(value) {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('blob:')) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key));
  } catch {
    return false;
  }
}

export function inferStreamType(url = '', declared = 'auto') {
  if (declared && declared !== 'auto') return declared;
  const pathname = url.split(/[?#]/, 1)[0].toLowerCase();
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.mpd')) return 'dash';
  return 'file';
}

export function normalizeMediaItem(input, index = 0) {
  const projection = PROJECTIONS[input.projection] ? input.projection : 'flat';
  const layout = LAYOUTS[input.layout] ? input.layout : 'mono';
  const rawUrl = input.url || '';
  const url = rawUrl ? safeMediaUrl(rawUrl) : '';
  const title = String(input.title || input.name || `Untitled ${index + 1}`).trim().slice(0, 80);

  return {
    id: String(input.id || `media-${Date.now()}-${index}`),
    title,
    subtitle: String(input.subtitle || (projection === 'flat' ? 'Regular video' : 'Immersive video')).slice(0, 120),
    description: String(input.description || '').slice(0, 400),
    url,
    projection,
    layout,
    streamType: inferStreamType(url, input.streamType),
    subtitleUrl: input.subtitleUrl ? safeMediaUrl(input.subtitleUrl) : '',
    art: String(input.art || 'art-night'),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    template: Boolean(input.template),
    local: Boolean(input.local),
    ephemeral: Boolean(input.ephemeral),
    featured: Boolean(input.featured)
  };
}

export function projectionLabel(projection) {
  return PROJECTIONS[projection]?.label || PROJECTIONS.flat.label;
}

export function layoutLabel(layout) {
  return LAYOUTS[layout]?.label || LAYOUTS.mono.label;
}

export function filenameHint(item) {
  const sourcePath = item.url && !item.url.startsWith('blob:') ? new URL(item.url).pathname : '';
  const extensionMatch = sourcePath.match(/\.(mp4|m4v|webm|mkv)$/i);
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : '.mp4';
  const cleanTitle = String(item.title || 'ProjectAVR')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'ProjectAVR';
  const projection = PROJECTIONS[item.projection]?.filename || '';
  const layout = LAYOUTS[item.layout]?.filename || '';
  return `${cleanTitle}${projection}${layout}${extension}`;
}

export function buildM3u(item) {
  if (!item.url || item.url.startsWith('blob:')) {
    throw new TypeError('A reusable HTTP(S) URL is required for an external playlist.');
  }
  return `#EXTM3U\n#EXTINF:-1,${item.title.replace(/[\r\n,]/g, ' ')}\n${item.url}\n`;
}

export function buildPortableMetadata(item) {
  const projection = item.projection === 'flat'
    ? { kind: 'flat', fov: 0 }
    : { kind: 'equirectangular', fov: Number(item.projection) };
  const layout = item.layout.startsWith('sbs')
    ? 'side-by-side'
    : item.layout.startsWith('tb') ? 'top-bottom' : 'mono';
  const order = item.layout.endsWith('reverse') ? 'right-first' : 'left-first';

  return {
    schema: 'https://cubemarch.com/projectavr/media/v1',
    id: item.id,
    title: item.title,
    projection,
    stereo: { layout, order, packing: layout === 'mono' ? 'full' : 'half' },
    sources: [{ url: item.url, streamType: item.streamType }],
    subtitleUrl: item.subtitleUrl || undefined,
    filenameHint: filenameHint(item)
  };
}

export function buildDeoVrPayload(item, options = {}) {
  const screenType = item.projection === '180' ? 'dome' : item.projection === '360' ? 'sphere' : 'flat';
  const stereoMode = item.layout.startsWith('sbs') ? 'sbs' : item.layout.startsWith('tb') ? 'tb' : 'off';
  const videoSource = { url: item.url };
  const resolution = Number(options.resolution);
  if (Number.isFinite(resolution) && resolution > 0) videoSource.resolution = Math.round(resolution);
  return {
    encodings: [{
      name: options.name || 'Original',
      videoSources: [videoSource]
    }],
    title: item.title,
    id: options.numericId || 1,
    is3d: stereoMode !== 'off',
    screenType,
    stereoMode,
    skipIntro: 0
  };
}

export function buildPlayaDetailPayload(item, options = {}) {
  const projection = item.projection === 'flat' ? 'FLT' : item.projection;
  const stereo = {
    mono: 'MN', sbs: 'LR', 'sbs-reverse': 'RL', tb: 'TB', 'tb-reverse': 'BT'
  }[item.layout] || 'MN';
  const link = {
    is_stream: true,
    is_download: false,
    url: item.url,
    projection,
    stereo,
    quality_name: options.qualityName || 'Original'
  };
  const qualityOrder = Number(options.qualityOrder);
  if (Number.isFinite(qualityOrder) && qualityOrder >= 0) link.quality_order = qualityOrder;

  const duration = Number(options.durationSeconds);
  const data = {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle || '',
    description: item.description || '',
    details: [{
      type: 'full',
      duration_seconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0,
      links: [link]
    }]
  };
  if (options.previewImage) data.preview_image = safeMediaUrl(options.previewImage);
  const releaseDate = Number(options.releaseDate);
  if (Number.isFinite(releaseDate) && releaseDate > 0) data.release_date = Math.round(releaseDate);

  return {
    status: { code: 1 },
    data
  };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function searchMatches(item, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.title, item.subtitle, item.description, item.projection, item.layout, ...item.tags]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}
