import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLadder } from '../server/media/packager.js';
import { eyeRects, placementIn, watermarkFilters } from '../server/media/watermark.js';
import {
    profileById,
    profileFor,
    selectRenditions,
    preferredRendition,
    bestCodec,
    resetProfiles
} from '../server/delivery/profiles.js';
import { PROJECTION, STEREO } from '../src/catalog/media-format.js';

/**
 * Delivery: what gets built, what gets marked, and who gets offered what.
 *
 * These three things are one subject. A ladder that does not reach the bottom
 * of its range cannot adapt; a mark drawn into one eye of a stereo frame is
 * worse than no mark at all; and a rung offered to a headset that cannot decode
 * it is a menu entry that plays black. Each failure is invisible on the machine
 * that produced it and obvious in a headset, which is why they are pinned here.
 */

/* ------------------------------------------------------------------ ladder -- */

test('the ladder spans its range instead of clustering at the top', () => {
    const rungs = buildLadder({ width: 15_360, height: 4320 }, { stereo: STEREO.SBS });
    const heights = rungs.map((r) => r.height);

    assert.equal(heights[0], 4320, 'the best rung is what the title is worth');
    assert.equal(heights.at(-1), 480, 'the worst rung is what makes it play at all');

    // The bug this replaces: `.slice(0, 4)` took 4320/2880/2160/1440 and
    // stopped, so the whole ladder lived between 60 and 10 Mbps and a viewer
    // who could not hold 10 Mbps had nowhere to drop to.
    const ratio = rungs[0].bitrate / rungs.at(-1).bitrate;
    assert.ok(ratio > 20, `top-to-bottom bitrate ratio was only ${ratio.toFixed(1)}x`);

    assert.deepEqual(
        [...heights].sort((a, b) => b - a),
        heights,
        'rungs come out highest first'
    );
});

test('the ladder never upscales and always has at least one rung', () => {
    for (const height of [4320, 2160, 1080, 720, 480, 360, 240]) {
        const rungs = buildLadder({ width: height * 2, height }, {});
        assert.ok(rungs.length >= 1, `${height} produced nothing`);
        assert.ok(
            rungs.every((r) => r.height <= height),
            `${height} produced an upscale`
        );
    }
});

test('stereo rungs get more bitrate at the same height', () => {
    const mono = buildLadder({ width: 3840, height: 2160 }, { stereo: STEREO.MONO });
    const sbs = buildLadder({ width: 3840, height: 2160 }, { stereo: STEREO.SBS });

    // Two eyes in one raster is twice the information at the same pixel count.
    assert.ok(sbs[0].bitrate > mono[0].bitrate);
});

test('each rung carries the width it will actually be encoded at', () => {
    const rungs = buildLadder({ width: 3840, height: 1920 }, {});

    for (const rung of rungs) {
        // `scale=-2` rounds to even, and the surfaces that must print a
        // resolution have to print the same one ffmpeg produced.
        assert.equal(rung.width % 2, 0, `${rung.name} width is odd`);
        assert.equal(rung.width, 2 * Math.round((rung.height * 2) / 2));
    }
});

/* --------------------------------------------------------------- watermark -- */

test('a packed stereo frame is split into two eyes', () => {
    assert.deepEqual(eyeRects(4096, 2048, STEREO.SBS), [
        { x: 0, y: 0, width: 2048, height: 2048 },
        { x: 2048, y: 0, width: 2048, height: 2048 }
    ]);

    assert.deepEqual(eyeRects(4096, 2048, STEREO.TB), [
        { x: 0, y: 0, width: 4096, height: 1024 },
        { x: 0, y: 1024, width: 4096, height: 1024 }
    ]);

    assert.equal(eyeRects(4096, 2048, STEREO.MONO).length, 1);
});

test('the mark is drawn into every eye, never just one', () => {
    for (const stereo of [STEREO.MONO, STEREO.SBS, STEREO.TB]) {
        const built = watermarkFilters({
            width: 4096,
            height: 2048,
            format: { projection: PROJECTION.DOME180, stereo }
        });

        const overlays = built.filters.filter((f) => f.includes('overlay='));
        const expected = eyeRects(4096, 2048, stereo).length;

        // One eye marked and the other not is the failure that matters: a
        // headset cannot fuse an object only one eye can see, so it floats in
        // front of the scene at no fixed depth and gives people a headache.
        assert.equal(overlays.length, expected, `${stereo} drew ${overlays.length} marks for ${expected} eyes`);
    }
});

test('each eye gets its own copy of the mark, because a filter output feeds one consumer', () => {
    const built = watermarkFilters({
        width: 4096,
        height: 2048,
        format: { projection: PROJECTION.FLAT, stereo: STEREO.SBS }
    });

    assert.ok(
        built.filters.some((f) => f.includes('split=2')),
        'without a split the second overlay has no input and ffmpeg refuses the graph'
    );
});

test('the mark lands inside the eye it belongs to', () => {
    const [left, right] = eyeRects(4000, 2000, STEREO.SBS);

    const flatLeft = placementIn(left, false);
    const flatRight = placementIn(right, false);

    // Bottom-right of each half: the left eye's mark must finish before the
    // midline, or it bleeds into the right eye's picture.
    assert.equal(flatLeft.x, '1930-w');
    assert.equal(flatRight.x, '3930-w');
    assert.equal(flatLeft.y, flatRight.y, 'the two eyes must agree vertically or the mark has depth');
});

test('immersive projections put the mark at the bottom centre, not in a corner', () => {
    const [eye] = eyeRects(4096, 2048, STEREO.MONO);

    const flat = placementIn(eye, false);
    const immersive = placementIn(eye, true);

    // The "corners" of an equirectangular frame are the poles and the space
    // directly behind the viewer. A mark placed there is smeared across the
    // sky and unreadable.
    assert.equal(immersive.x, '2048-w/2');
    assert.notEqual(immersive.x, flat.x);
    assert.ok(immersive.y.startsWith('1434-'));
});

test('a source with no dimensions gets no mark rather than a broken filter graph', () => {
    assert.equal(watermarkFilters({ width: 0, height: 0, format: {} }), null);
});

/* ---------------------------------------------------------------- profiles -- */

const LADDER = [
    { name: '4320p', height: 4320, width: 8640, bitrate: 96_000, codec: 'h264', hls: '/h/4320', mp4: '/m/4320' },
    { name: '2160p', height: 2160, width: 4320, bitrate: 28_800, codec: 'h264', hls: '/h/2160', mp4: '/m/2160' },
    { name: '1080p', height: 1080, width: 2160, bitrate: 9600, codec: 'h264', hls: '/h/1080', mp4: '/m/1080' },
    { name: '480p', height: 480, width: 960, bitrate: 2240, codec: 'h264', hls: '/h/480', mp4: '/m/480' }
];

test('a headset is never offered a rung it cannot decode', () => {
    const quest2 = profileById('quest2');
    const offered = selectRenditions(LADDER, quest2);

    assert.ok(
        offered.every((r) => r.height <= quest2.maxHeight.h264),
        'an 8K H.264 rung in a Quest 2 quality menu is a menu item that plays black'
    );
    assert.ok(offered.every((r) => r.bitrate <= quest2.maxBitrateKbps));
    assert.ok(offered.length >= 1);
});

test('PC VR gets the whole ladder', () => {
    assert.equal(selectRenditions(LADDER, profileById('pcvr')).length, LADDER.length);
});

test('a client under every ceiling still gets something', () => {
    const tiny = { ...profileById('generic'), maxHeight: { h264: 16 }, maxBitrateKbps: 1 };
    const offered = selectRenditions(LADDER, tiny);

    // An empty source list reads to DeoVR and SkyBox as a broken title, not as
    // an unsupported one. The smallest rung is a better answer.
    assert.equal(offered.length, 1);
    assert.equal(offered[0].name, '480p');
});

test('renditions come back best first', () => {
    const offered = selectRenditions(LADDER, profileById('pcvr'));
    assert.deepEqual(
        offered.map((r) => r.height),
        [4320, 2160, 1080, 480]
    );
    assert.equal(preferredRendition(LADDER, profileById('pcvr')).height, 4320);
});

test('a title packaged in two codecs is served in one of them, not a mixture', () => {
    const both = [
        ...LADDER,
        { name: '4320p', height: 4320, width: 8640, bitrate: 57_600, codec: 'hevc', hls: '/h5/4320', mp4: '/m5/4320' }
    ];

    const offered = selectRenditions(both, profileById('quest3'));

    // Every entry inside one `encodings` group has to be the same codec, and a
    // Quest 3 reaches 8K over HEVC and not over H.264.
    assert.ok(offered.every((r) => r.codec === 'hevc'));
    assert.equal(offered[0].height, 4320);
});

test('codec preference falls back to whatever was actually packaged', () => {
    assert.equal(bestCodec(profileById('quest3'), ['h264']), 'h264');
    assert.equal(bestCodec(profileById('quest3'), ['h264', 'hevc']), 'hevc');
});

test('an unpackaged title still resolves to one rendition', () => {
    const sole = [{ name: 'source', height: 0, width: null, bitrate: 0, codec: 'h264', hls: null, mp4: '/x.mp4' }];
    assert.equal(preferredRendition(sole, profileById('quest2')).mp4, '/x.mp4');
    assert.equal(preferredRendition([], profileById('quest2')), null);
});

/* -------------------------------------------------------------- detection -- */

test('headsets are recognised from their User-Agent', () => {
    const cases = [
        ['Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/32.0', 'quest3'],
        ['Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/28.0', 'quest2'],
        ['Mozilla/5.0 (Linux; Android 12; Pico 4) VRBrowser', 'pico4'],
        ['Mozilla/5.0 (Macintosh) AppleWebKit Version/2.0 Safari visionOS', 'visionpro'],
        ['Whirligig/5.8', 'pcvr'],
        ['curl/8.4.0', 'generic']
    ];

    for (const [ua, expected] of cases) {
        assert.equal(profileFor({ headers: { 'user-agent': ua }, query: {} }).id, expected, ua);
    }
});

test('an explicit ?device= overrides sniffing, and nonsense does not', () => {
    const quest = { headers: { 'user-agent': 'Quest 3' }, query: { device: 'quest2' } };
    assert.equal(profileFor(quest).id, 'quest2');

    const bogus = { headers: { 'user-agent': 'Quest 3' }, query: { device: 'not-a-headset' } };
    assert.equal(profileFor(bogus).id, 'quest3');
});

test('a deployment can raise a ceiling it has measured itself', (t) => {
    t.after(() => {
        delete process.env.AVR_DEVICE_PROFILES;
        resetProfiles();
    });

    process.env.AVR_DEVICE_PROFILES = JSON.stringify({ quest2: { maxHeight: 4320, maxBitrateKbps: 99_000 } });
    resetProfiles();

    assert.equal(selectRenditions(LADDER, profileById('quest2')).length, LADDER.length);
});
