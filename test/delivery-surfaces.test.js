import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The five surfaces, against a real server and a real packaged title.
 *
 * `README.md` claims there is no per-player code path and that all five read
 * one `buildLibrary()` call. That is still true, and the ladder is exactly the
 * thing that would break it: five places each deciding for themselves which
 * rung to hand over is five places that can disagree. These tests are here to
 * catch that disagreement, and to catch the surface-specific traps - DLNA's
 * `bitrate` being in bytes, DeoVR's quality menu being driven off the length of
 * `videoSources` - that unit tests of the profile table cannot see.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-delivery-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';

const { app } = await import('../server/index.js');
const { users, titles } = await import('../server/db/index.js');
const { invalidateCatalog } = await import('../server/library.js');
const { DlnaServer } = await import('../server/dlna.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the fixture -- */

const creator = users.create({
    email: 'ladder@example.test',
    passwordHash: 'x',
    displayName: 'Ladder',
    role: 'creator'
});

const RENDITIONS = [
    { name: '4320p', height: 4320, width: 8640, bitrate: 96_000, codec: 'h264', hlsKey: 'h/4320.m3u8', mp4Key: 'm/4320.mp4', bytes: 40_000_000_000 },
    { name: '2160p', height: 2160, width: 4320, bitrate: 28_800, codec: 'h264', hlsKey: 'h/2160.m3u8', mp4Key: 'm/2160.mp4', bytes: 12_000_000_000 },
    { name: '1080p', height: 1080, width: 2160, bitrate: 9600, codec: 'h264', hlsKey: 'h/1080.m3u8', mp4Key: 'm/1080.mp4', bytes: 4_000_000_000 },
    { name: '480p', height: 480, width: 960, bitrate: 2240, codec: 'h264', hlsKey: 'h/480.m3u8', mp4Key: 'm/480.mp4', bytes: 900_000_000 }
];

const title = titles.create({
    creatorId: creator.id,
    slug: 'reef-dive',
    title: 'Reef Dive',
    projection: 'dome180',
    stereo: 'sbs',
    visibility: 'public'
});

titles.update(title.id, {
    sourceKey: 'src/reef.mp4',
    hlsKey: 'h/master.m3u8',
    duration: 600,
    width: 8640,
    height: 4320,
    renditions: JSON.stringify({ version: 1, watermarked: true, renditions: RENDITIONS })
});

titles.setStatus(title.id, 'published');
invalidateCatalog();

const quest2 = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/28.0' };
const pcvr = { 'user-agent': 'Whirligig/5.8' };

/* ------------------------------------------------------------------- deovr -- */

test('the DeoVR quality menu has every rung the headset can play, not one', async () => {
    const res = await fetch(`${base}/deovr/video/reef-dive`, { headers: quest2 });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.stereoMode, 'sbs');
    assert.equal(body.screenType, 'dome');

    const sources = body.encodings.flatMap((e) => e.videoSources);

    // The bug this replaces: a title packaged into four rungs was offered at
    // exactly one, so a headset on a weak access point had nothing to drop to.
    assert.ok(sources.length > 1, 'a ladder with one entry is not a ladder');
    assert.ok(
        sources.every((s) => s.resolution <= 2160),
        'an 8K H.264 rung on a Quest 2 is a quality-menu entry that plays black'
    );
    assert.ok(
        sources.every((s) => s.url.startsWith('http')),
        'DeoVR needs absolute URLs; it has no page to resolve a relative one against'
    );
});

test('the same title offers more to a client that can take more', async () => {
    const forQuest = await (await fetch(`${base}/deovr/video/reef-dive`, { headers: quest2 })).json();
    const forDesktop = await (await fetch(`${base}/deovr/video/reef-dive`, { headers: pcvr })).json();

    const heights = (body) => body.encodings.flatMap((e) => e.videoSources).map((s) => s.resolution);

    assert.equal(Math.max(...heights(forDesktop)), 4320);
    assert.ok(Math.max(...heights(forQuest)) < Math.max(...heights(forDesktop)));
});

test('?device= reaches the feed too, so a creator can check a headset from a desk', async () => {
    const body = await (await fetch(`${base}/deovr/video/reef-dive?device=quest2`)).json();
    const heights = body.encodings.flatMap((e) => e.videoSources).map((s) => s.resolution);

    assert.ok(Math.max(...heights) <= 2160);
});

/* -------------------------------------------------------------------- dlna -- */

test('DLNA offers one res element per rung, with bitrate in bytes per second', async () => {
    const dlna = new DlnaServer({ port: 8080 });
    const { items } = await (await import('../server/library.js')).buildLibrary();
    const item = items.find((i) => i.id === 'reef-dive');

    const xml = dlna._itemXml(item, 'shelf:0');
    const res = [...xml.matchAll(/<res\s([^>]*)>([^<]*)<\/res>/g)];

    assert.ok(res.length > 1, 'DIDL-Lite has always allowed several, and it is the only choice a DLNA client gets');

    const first = res[0][1];
    const bitrate = Number(/bitrate="(\d+)"/.exec(first)[1]);
    const resolution = /resolution="(\d+)x(\d+)"/.exec(first);

    // UPnP defines res@bitrate in *bytes* per second. Eight times too large and
    // a client concludes every rung is beyond its link and refuses the lot.
    // 28,800 kbps is the 4K stereo rung; a Quest 2 clears it at 35 Mbps.
    assert.equal(bitrate, Math.round((28_800 * 1000) / 8), 'bitrate must be bytes/second');
    assert.equal(resolution[2], '2160', 'the best rung the default DLNA profile can take comes first');

    assert.ok(
        res.every(([, attrs]) => attrs.includes('DLNA.ORG_OP=01')),
        'without OP=01 players will not scrub'
    );
    assert.ok(
        res.every(([, , url]) => decodeURIComponent(url).includes('3dh_LR')),
        'SkyBox and Pigasus read the stereo layout from the filename and nowhere else'
    );

    // Every rung under its own name. The bug this replaces appended the rung to
    // a name that already carried the *source* height, producing
    // `Reef Dive_8K_..._1080p.mp4` - a file claiming to be both.
    const names = res.map(([, , url]) => decodeURIComponent(url).split('/').pop().split('?')[0]);
    assert.equal(new Set(names).size, names.length, 'two rungs sharing a filename is one rung a client cannot reach');
    assert.ok(
        names.every((n) => !/_\d+p_\d+p\.|8K.*_1080p|8K.*_2160p/.test(n)),
        `a rung named for two different resolutions: ${names.join(', ')}`
    );
});

/* --------------------------------------------------------------------- m3u -- */

test('the M3U picks a rendition per client and says which ceiling it used', async () => {
    const forQuest = await (await fetch(`${base}/playlist.m3u`, { headers: quest2 })).text();
    const forDesktop = await (await fetch(`${base}/playlist.m3u`, { headers: pcvr })).text();

    assert.match(forQuest, /# ProjectAVR - renditions selected for: Meta Quest 2/);

    // M3U carries one URL per entry and no notion of alternatives, so the
    // choice DeoVR makes in a menu has to be made here instead. The playlist
    // covers the whole library, so pick out the one title under test.
    const lineFor = (text) =>
        text.split('\n').find((l) => l.startsWith('http') && l.includes('/media/by-name/reef-dive/'));

    const questLine = lineFor(forQuest);
    const desktopLine = lineFor(forDesktop);

    assert.ok(questLine, 'the title under test is missing from the playlist entirely');
    assert.match(questLine, /rendition=2160p/, '4K is what a Quest 2 should be handed for an 8K stereo title');
    assert.match(desktopLine, /rendition=4320p/, 'a desktop has no ceiling to apply');
    assert.equal(
        forQuest.split('\n').filter((l) => l.includes('/media/by-name/reef-dive/')).length,
        1,
        'one entry per title, or the library appears to contain each title several times'
    );

    // Titles that were never packaged keep the plain URL they always had
    // rather than a rendition redirect that only points back at themselves.
    const unpackaged = forQuest.split('\n').filter((l) => l.startsWith('http') && !l.includes('reef-dive'));
    assert.ok(
        unpackaged.every((l) => !l.includes('rendition=')),
        'an unpackaged title was given a rendition URL'
    );
    assert.ok(
        unpackaged.every((l) => !/_(\d+p|[0-9]K)_\d+p\./.test(decodeURIComponent(l))),
        `a doubled resolution tag: ${unpackaged.join(', ')}`
    );
});

test('the profile table is published, because ?device= is useless if you cannot look it up', async () => {
    const body = await (await fetch(`${base}/delivery/profiles.json`, { headers: quest2 })).json();

    assert.equal(body.detected, 'quest2');
    assert.ok(body.profiles.some((p) => p.id === 'pcvr'));

    // JSON has no Infinity, and a profile with no ceiling has to round-trip as
    // something a client can read rather than as null-by-accident.
    const unlimited = body.profiles.find((p) => p.id === 'pcvr');
    assert.equal(unlimited.maxBitrateKbps, null);
    assert.equal(unlimited.maxHeight.h264, null);
});

/* ---------------------------------------------------------------- by-name -- */

test('a rendition URL redirects to that rung, and an unknown one 404s', async () => {
    const ok = await fetch(`${base}/media/by-name/reef-dive/Reef%20Dive_1080p.mp4?rendition=1080p`, {
        redirect: 'manual'
    });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('location'), /1080/);

    const missing = await fetch(`${base}/media/by-name/reef-dive/x.mp4?rendition=9999p`, { redirect: 'manual' });
    assert.equal(missing.status, 404);
});

test('the catalog records that the title was marked', async () => {
    const { items } = await (await import('../server/library.js')).buildLibrary();
    const item = items.find((i) => i.id === 'reef-dive');

    assert.equal(item.watermarked, true);
    assert.equal(item.renditions.length, RENDITIONS.length);
});
