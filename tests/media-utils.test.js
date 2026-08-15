import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeoVrPayload,
  buildM3u,
  buildPlayaDetailPayload,
  buildPortableMetadata,
  filenameHint,
  formatTime,
  hasCredentialHints,
  inferStreamType,
  normalizeMediaItem,
  safeMediaUrl,
  searchMatches
} from '../src/media-utils.js';

const vr180 = normalizeMediaItem({
  id: 'demo',
  title: 'Demo VR180',
  url: 'https://cdn.example.test/media/demo.mp4',
  projection: '180',
  layout: 'sbs'
});

test('safeMediaUrl accepts HTTP(S) and rejects executable protocols', () => {
  assert.equal(safeMediaUrl('https://example.test/video.mp4'), 'https://example.test/video.mp4');
  assert.throws(() => safeMediaUrl('javascript:alert(1)'), /HTTP\(S\)/);
  assert.throws(() => safeMediaUrl('data:text/html,hello'), /HTTP\(S\)/);
});

test('credential hints identify URLs that should not be persisted', () => {
  assert.equal(hasCredentialHints('https://cdn.example.test/video.mp4'), false);
  assert.equal(hasCredentialHints('https://user:secret@example.test/video.mp4'), true);
  assert.equal(hasCredentialHints('https://cdn.example.test/video.mp4?X-Amz-Signature=abc'), true);
  assert.equal(hasCredentialHints('https://cdn.example.test/video.mp4?token=abc'), true);
});

test('stream type is inferred without query-string confusion', () => {
  assert.equal(inferStreamType('https://example.test/live/master.m3u8?token=x'), 'hls');
  assert.equal(inferStreamType('https://example.test/manifest.mpd#quality'), 'dash');
  assert.equal(inferStreamType('https://example.test/movie.mp4'), 'file');
  assert.equal(inferStreamType('https://example.test/movie.mp4', 'hls'), 'hls');
});

test('normalization keeps explicit projection metadata', () => {
  assert.equal(vr180.projection, '180');
  assert.equal(vr180.layout, 'sbs');
  assert.equal(vr180.streamType, 'file');
});

test('portable filename uses shared 180/360 and LR/TB tokens', () => {
  assert.equal(filenameHint(vr180), 'Demo_VR180_180_LR.mp4');
  assert.equal(filenameHint({ ...vr180, projection: '360', layout: 'tb' }), 'Demo_VR180_360_TB.mp4');
});

test('M3U output contains only a sanitized title and direct URL', () => {
  assert.equal(buildM3u({ ...vr180, title: 'Demo,\nVR' }), '#EXTM3U\n#EXTINF:-1,Demo  VR\nhttps://cdn.example.test/media/demo.mp4\n');
  assert.throws(() => buildM3u({ ...vr180, url: 'blob:local' }), /HTTP\(S\)/);
});

test('DeoVR adapter maps 180 SBS to documented dome/sbs values', () => {
  const payload = buildDeoVrPayload(vr180, { resolution: 4096, numericId: 7 });
  assert.equal(payload.screenType, 'dome');
  assert.equal(payload.stereoMode, 'sbs');
  assert.equal(payload.is3d, true);
  assert.equal(payload.encodings[0].name, 'Original');
  assert.equal(payload.encodings[0].videoSources[0].resolution, 4096);
});

test('DeoVR adapter does not invent codec or resolution metadata', () => {
  const payload = buildDeoVrPayload(vr180);
  assert.equal(payload.encodings[0].name, 'Original');
  assert.equal('resolution' in payload.encodings[0].videoSources[0], false);
});

test('PLAY’A adapter maps projection and eye order', () => {
  const payload = buildPlayaDetailPayload({ ...vr180, layout: 'sbs-reverse' });
  const link = payload.data.details[0].links[0];
  assert.equal(link.projection, '180');
  assert.equal(link.stereo, 'RL');
  assert.equal(link.is_stream, true);
  assert.equal('quality_order' in link, false);
  assert.equal('preview_image' in payload.data, false);
  assert.equal('release_date' in payload.data, false);
});

test('portable metadata preserves normalized projection and stereo semantics', () => {
  const metadata = buildPortableMetadata(vr180);
  assert.deepEqual(metadata.projection, { kind: 'equirectangular', fov: 180 });
  assert.deepEqual(metadata.stereo, { layout: 'side-by-side', order: 'left-first', packing: 'half' });
});

test('search spans titles, tags, projection, and layout', () => {
  const item = { ...vr180, tags: ['nature'] };
  assert.equal(searchMatches(item, 'nature'), true);
  assert.equal(searchMatches(item, 'side'), false);
  assert.equal(searchMatches(item, 'sbs'), true);
});

test('time formatting handles short, long, and invalid durations', () => {
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(Number.NaN), '0:00');
});
