import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No playback until verified.
 *
 * David's call on 2026-10-21, and the reason is in `src/ui/video-gate.js`: a
 * mosaic is a real answer for a still and there is no equivalent for a
 * stream. The detector runs at a few frames a second on one server, the
 * material moves, and a cover that lags by half a second is not a cover. So
 * where an image gets covered and shown, a video does not get shown.
 *
 * Three surfaces reach a decoder — the catalogue player, a purchased
 * recording, and the partner's cam embed — and every one of them has to ask
 * first. None of these modules can be imported here (they pull in PlayCanvas
 * and a PNG, neither of which `node --test` will load), so this reads their
 * source the way `analytics.test.js` reads its call sites.
 *
 * **The assertions about ordering are the point.** A check that runs after
 * `load()` is theatre: the fetch has started and the first frames are already
 * decoded behind whatever is drawn over them.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MAIN = read('src/main.js');
const BROWSE = read('src/ui/browse.js');
const CAMS = read('src/ui/cams.js');
const GATE = read('src/ui/video-gate.js');

/**
 * The body of a function, from a unique anchor to the next close at its
 * indentation. Asserts the anchor appears exactly once first, because a
 * silently-wrong slice is how a source test passes by reading the wrong code.
 */
function body(src, anchor, indent = '    ') {
    const hits = src.split(anchor).length - 1;
    assert.equal(hits, 1, `expected exactly one ${JSON.stringify(anchor)}, found ${hits}`);

    const from = src.indexOf(anchor);
    const to = src.indexOf(`\n${indent}}`, from);
    assert.ok(to > from, `no close found after ${JSON.stringify(anchor)}`);

    return src.slice(from, to);
}

/** Assert `first` appears before `second`, with a message about why. */
function before(src, first, second, why) {
    const a = src.indexOf(first);
    const b = src.indexOf(second);

    assert.ok(a >= 0, `${first} is gone`);
    assert.ok(b >= 0, `${second} is gone`);
    assert.ok(a < b, why);
}

/* ---------------------------------------------------- the catalogue player -- */

test('a title asks before it loads, not after', () => {
    const fn = body(MAIN, 'async function playItem(item, opts = {}) {');

    assert.match(fn, /allowPlayback\('title'\)/, 'the catalogue player no longer asks');
    before(
        fn,
        "allowPlayback('title')",
        'video.load(',
        'the gate runs after load(), by which point the video is already decoding'
    );
});

test('a refused title does not fall through to play()', () => {
    const fn = body(MAIN, 'async function playItem(item, opts = {}) {');

    assert.match(
        fn,
        /if \(!\(await allowPlayback\('title'\)\)\) return;/,
        'the answer is read but not acted on'
    );
});

/* ------------------------------------------------------------- recordings -- */

test('a purchased recording asks before its player is written', () => {
    const fn = body(BROWSE, 'async _openRecording(row) {');

    assert.match(fn, /allowPlayback\('recording'\)/, 'the recording player no longer asks');
    before(fn, 'allowPlayback(', '<video', 'the <video> is written before the gate is offered');
});

/* ---------------------------------------------------------- the cam embed -- */

test('the partner frame is built in exactly one place', () => {
    // Two call sites — the first open, and passing the gate from inside the
    // theatre — and one builder. Two copies of that sandbox attribute is how
    // one of them ends up missing `allow-top-navigation`'s absence.
    const built = (CAMS.match(/createElement\('iframe'\)/g) || []).length;
    assert.equal(built, 1, `the iframe is constructed in ${built} places`);
});

test('the stage is only framed when playback is allowed', () => {
    const fn = body(CAMS, '_openTheatre(room, anchor) {');

    assert.match(
        fn,
        /playbackAllowed\(\) \? camFrame\(room\) : this\._theatreGate\(room, stage\)/,
        'the theatre no longer chooses between the stream and the gate'
    );
});

test('the theatre still opens for a visitor who declines', () => {
    // `ui/image-gate.js` promises that cancelling the interstitial shows you
    // the page you clicked with the covering still on. For a cam card that
    // page is the theatre, so it has to open — covered, not refused.
    const fn = body(CAMS, '_openTheatre(room, anchor) {');

    assert.match(fn, /document\.body\.append\(el\)/, 'the theatre no longer opens');
    assert.ok(
        !/if \(!playbackAllowed\(\)\) return/.test(fn),
        'the theatre now refuses to open, which dead-ends the image interstitial'
    );
});

test('passing the gate inside the theatre swaps the stream in', () => {
    const fn = body(CAMS, '_theatreGate(room, stage) {');

    before(fn, "allowPlayback('cam')", 'camFrame(room)', 'the frame is appended before the answer');
    assert.match(fn, /if \(!stage\.isConnected\) return;/, 'a closed theatre still gets a stream');
    assert.match(fn, /event\.stopPropagation\(\)/, 'the verify click closes the dialog under it');
});

test('the covered still is the one the proxy already mosaiced', () => {
    const fn = body(CAMS, '_theatreGate(room, stage) {');

    // `room.thumb` is `/api/cams/thumb/...`, which is covered server-side.
    // `room.embed` is the partner's player and must never appear here.
    assert.match(fn, /room\.thumb/);
    assert.ok(!/room\.embed/.test(fn), 'the gate markup reaches for the stream URL');
});

/* ------------------------------------------------------------- the module -- */

test('the gate believes the shared state, not the dialog', () => {
    // `openAgeGate()` resolves false when dismissed, but a visitor who passed
    // in another tab while it was open comes back true, and `ageOk()` is the
    // copy every other module reads.
    const fn = body(GATE, 'export async function allowPlayback(surface) {', '');

    before(fn, 'await openAgeGate()', 'return ageOk()', 'the answer is read before it is asked for');
    assert.ok(!/return await openAgeGate/.test(fn), 'the dialog return value is used directly');
});

test('an already-verified visitor is never asked', () => {
    const fn = body(GATE, 'export async function allowPlayback(surface) {', '');

    before(
        fn,
        'if (ageOk()) return true;',
        'track(',
        'a verified visitor is reported as having been shown the gate'
    );
});

test('every surface reports itself separately', () => {
    for (const [name, src, surface] of [
        ['main.js', MAIN, 'title'],
        ['browse.js', BROWSE, 'recording'],
        ['cams.js', CAMS, 'cam']
    ]) {
        assert.match(src, new RegExp(`allowPlayback\\('${surface}'\\)`), name);
    }

    // One existing event with a new value for an existing parameter, rather
    // than a tenth GA4 event to register. See `test/analytics.test.js`.
    assert.match(GATE, /EVENTS\.AGE_GATE_SHOWN/);
    assert.ok(!/EVENTS\.VIDEO_/.test(GATE), 'the video gate has invented its own event');
});

test('the selfie camera is not gated, because it is the gate', () => {
    // `ui/selfie-capture.js` opens the front camera for the document check.
    // Asking it to verify first would be a loop with no way in.
    assert.ok(!/video-gate/.test(read('src/ui/selfie-capture.js')));
    assert.ok(!/video-gate/.test(read('src/ui/age-gate.js')));
});
