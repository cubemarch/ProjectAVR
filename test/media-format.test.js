import test from 'node:test';
import assert from 'node:assert/strict';

import {
    detectFormatFromName,
    resolveFormat,
    buildConventionalFilename,
    toDeoVR,
    isImmersive,
    PROJECTION,
    STEREO
} from '../src/catalog/media-format.js';

/**
 * Filename sniffing is the only metadata channel SkyBox, Pigasus and Whirligig
 * have, so these cases are the compatibility contract in executable form.
 */

test('detects projection from common filename conventions', () => {
    const cases = [
        ['Reef Dive_8K_180x180_3dh_LR.mp4', PROJECTION.DOME180],
        ['City Walk_360x180_MONO.mp4', PROJECTION.SPHERE360],
        ['Skydive_4K_360_TB.mp4', PROJECTION.SPHERE360],
        ['Concert_180_LR.mp4', PROJECTION.DOME180],
        ['Lens Test_MKX200_alpha.mp4', PROJECTION.FISHEYE],
        ['Wide_RF52_LR.mp4', PROJECTION.FISHEYE],
        ['Documentary S01E02 1080p.mp4', PROJECTION.FLAT]
    ];

    for (const [name, expected] of cases) {
        assert.equal(detectFormatFromName(name).projection, expected, name);
    }
});

test('detects stereo layout independently of projection', () => {
    assert.equal(detectFormatFromName('a_360_TB.mp4').stereo, STEREO.TB);
    assert.equal(detectFormatFromName('a_360_LR.mp4').stereo, STEREO.SBS);
    assert.equal(detectFormatFromName('a_360_sbs.mp4').stereo, STEREO.SBS);
    assert.equal(detectFormatFromName('a_360_3dv.mp4').stereo, STEREO.TB);
    assert.equal(detectFormatFromName('a_360_MONO.mp4').stereo, STEREO.MONO);
});

test('360 without a stereo tag stays mono, but 180 defaults to side-by-side', () => {
    // 360 content is very often monoscopic; 180 essentially never is.
    assert.equal(detectFormatFromName('Tour_360.mp4').stereo, STEREO.MONO);
    assert.equal(detectFormatFromName('Tour_180.mp4').stereo, STEREO.SBS);
    assert.equal(detectFormatFromName('Tour_MKX200.mp4').stereo, STEREO.SBS);
});

test('an explicit mono tag always wins over the 180 default', () => {
    assert.equal(detectFormatFromName('Tour_180x180_MONO.mp4').stereo, STEREO.MONO);
    assert.equal(detectFormatFromName('Tour_180_2D.mp4').stereo, STEREO.MONO);
});

test('reads fisheye field of view from the lens name', () => {
    assert.equal(detectFormatFromName('x_MKX200.mp4').fisheyeFov, 200);
    assert.equal(detectFormatFromName('x_MKX220.mp4').fisheyeFov, 220);
    assert.equal(detectFormatFromName('x_RF52.mp4').fisheyeFov, 190);
    assert.equal(detectFormatFromName('x_fisheye190.mp4').fisheyeFov, 190);
});

test('360 is matched before 180 inside a combined tag', () => {
    // `360x180` contains "180"; ordering in the token table must prevent a
    // 360 file being served to players as a dome.
    assert.equal(detectFormatFromName('x_360x180_LR.mp4').projection, PROJECTION.SPHERE360);
});

test('tokens must be delimited, not substrings of other words', () => {
    assert.equal(detectFormatFromName('Studio1802 Recap.mp4').projection, PROJECTION.FLAT);
    assert.equal(detectFormatFromName('Flat360Vision Trailer.mp4').projection, PROJECTION.FLAT);
});

test('explicit catalog metadata overrides the filename', () => {
    const format = resolveFormat({
        src: '/media/mislabelled_360_LR.mp4',
        projection: PROJECTION.DOME180,
        stereo: STEREO.TB
    });

    assert.equal(format.projection, PROJECTION.DOME180);
    assert.equal(format.stereo, STEREO.TB);
});

test('resolveFormat only carries a fisheye fov for fisheye projections', () => {
    assert.equal(resolveFormat({ src: 'a_180_LR.mp4' }).fisheyeFov, null);
    assert.equal(resolveFormat({ src: 'a_MKX200.mp4' }).fisheyeFov, 200);
});

test('conventional filenames round-trip back to the same format', () => {
    const inputs = [
        { title: 'Reef Dive', projection: PROJECTION.DOME180, stereo: STEREO.SBS, fisheyeFov: null, lens: null },
        { title: 'City Walk', projection: PROJECTION.SPHERE360, stereo: STEREO.TB, fisheyeFov: null, lens: null },
        { title: 'Lens Test', projection: PROJECTION.FISHEYE, stereo: STEREO.SBS, fisheyeFov: 200, lens: 'mkx200' },
        { title: 'Plain Doc', projection: PROJECTION.FLAT, stereo: STEREO.MONO, fisheyeFov: null, lens: null }
    ];

    for (const { title, ...format } of inputs) {
        const filename = buildConventionalFilename(title, format, { height: 2880 });
        const detected = detectFormatFromName(filename);

        assert.equal(detected.projection, format.projection, filename);
        assert.equal(detected.stereo, format.stereo, filename);
    }
});

test('a mono 360 export keeps its MONO tag so players do not assume 3D', () => {
    const name = buildConventionalFilename('Tour', {
        projection: PROJECTION.SPHERE360,
        stereo: STEREO.MONO,
        fisheyeFov: null,
        lens: null
    });

    assert.match(name, /MONO/);
    assert.equal(detectFormatFromName(name).stereo, STEREO.MONO);
});

test('maps to the DeoVR schema that Play\'a also consumes', () => {
    assert.deepEqual(toDeoVR({ projection: PROJECTION.DOME180, stereo: STEREO.SBS }), {
        screenType: 'dome',
        stereoMode: 'sbs',
        is3d: true
    });

    assert.deepEqual(toDeoVR({ projection: PROJECTION.SPHERE360, stereo: STEREO.MONO }), {
        screenType: 'sphere',
        stereoMode: 'off',
        is3d: false
    });

    assert.deepEqual(toDeoVR({ projection: PROJECTION.FLAT, stereo: STEREO.TB }), {
        screenType: 'flat',
        stereoMode: 'tb',
        is3d: true
    });
});

test('named fisheye lenses keep their DeoVR profile', () => {
    assert.equal(toDeoVR({ projection: PROJECTION.FISHEYE, lens: 'mkx200', stereo: STEREO.SBS }).screenType, 'mkx200');
    assert.equal(toDeoVR({ projection: PROJECTION.FISHEYE, lens: 'rf52', stereo: STEREO.SBS }).screenType, 'rf52');
    assert.equal(toDeoVR({ projection: PROJECTION.FISHEYE, lens: null, stereo: STEREO.SBS }).screenType, 'fisheye');
});

test('flat stereo content still needs the 3D renderer', () => {
    assert.equal(isImmersive({ projection: PROJECTION.FLAT, stereo: STEREO.MONO }), false);
    assert.equal(isImmersive({ projection: PROJECTION.FLAT, stereo: STEREO.SBS }), true);
    assert.equal(isImmersive({ projection: PROJECTION.DOME180, stereo: STEREO.MONO }), true);
});
