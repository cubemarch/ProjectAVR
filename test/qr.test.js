import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { qrMatrix, qrSvg } from '../src/ui/qr.js';

/**
 * The QR encoder, against an independent implementation.
 *
 * This is the only module in the tree where "it works on my machine" is a
 * completely worthless result. A QR code with the wrong mask, an interleave off
 * by one block or a mistyped row in the error-correction tables still *renders*
 * — it produces a plausible square of black and white that a generous decoder
 * on a bright screen may well read, and that a phone in a dim room will not.
 * There is no failure mode that looks like a failure.
 *
 * So the fixtures in `fixtures/qr.json` were generated from `uqr`, a separate
 * implementation, which was installed for that purpose and then removed: the
 * shipped bundle takes no dependency, the dependency tree stays clean, and the
 * test still proves byte-for-byte agreement with code nobody here wrote. The
 * generator is recorded at the bottom of this file so the fixtures can be
 * regenerated rather than trusted.
 *
 * One of these caught a real transcription error on the first run — a single
 * wrong entry in the error-correction block table, at version 8 level H, which
 * every other version and level passed straight over.
 */

const FIXTURES = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'qr.json'), 'utf8')
);

/** The deterministic filler the fixtures use in place of long literal strings. */
function filler(n) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_.~';
    return Array.from({ length: n }, (_, i) => alphabet[(i * 7) % 40]).join('');
}

const render = (m) =>
    Array.from({ length: m.size }, (_, y) => Array.from(m.modules[y], (bit) => (bit ? '#' : '.')).join(''));

test('every fixture encodes to the same matrix as the reference implementation', () => {
    let full = 0;

    for (const fixture of FIXTURES) {
        const text = fixture.text ?? filler(fixture.filler);
        const label = `${fixture.ec}, ${fixture.filler ? `${fixture.filler} bytes of filler` : JSON.stringify(text.slice(0, 40))}`;

        const mine = qrMatrix(text, fixture.ec);
        const grid = render(mine);

        // Size first: a version chosen one too small or one too large makes the
        // digest mismatch uninformative, and version selection is its own bug.
        assert.equal(mine.size, fixture.size, `wrong version for ${label}`);

        if (fixture.matrix) {
            // Row by row while the code is small enough to read in a diff,
            // because "digest differs" tells you nothing about where.
            assert.deepEqual(grid, fixture.matrix, `matrix differs for ${label}`);
            full++;
        }

        assert.equal(
            crypto.createHash('sha256').update(grid.join('\n')).digest('hex'),
            fixture.sha256,
            `matrix differs for ${label}`
        );
    }

    assert.ok(FIXTURES.length >= 160, 'the fixture set shrank');
    assert.ok(full >= 8, 'no fixture is small enough to be compared row by row');
});

test('the fixtures cover every version and every error-correction level', () => {
    const versions = new Set();
    const levels = new Set();

    for (const fixture of FIXTURES) {
        versions.add((fixture.size - 17) / 4);
        levels.add(fixture.ec);
    }

    // Not decoration. The tables are indexed by version and level, and a wrong
    // row is invisible from every other row - which is exactly how the version
    // 8 level H entry survived being typed in wrong.
    assert.deepEqual([...levels].sort(), ['H', 'L', 'M', 'Q']);
    for (let v = 1; v <= 40; v++) assert.ok(versions.has(v), `no fixture reaches version ${v}`);
});

test('a destination link fits in a code a phone can hold still for', () => {
    const link =
        'avr://pair?host=live.example.com&port=8081' +
        '&key=zC7Qm1xTb9Lf0YvK4sHnRdP2eWgA6uJ8&name=Rig%201&tls=1' +
        '&pin=' + encodeURIComponent('sha256/K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=');

    const { version } = qrMatrix(link, 'M');

    // Version is module density, and module density is how close the phone has
    // to get. A pinned TLS destination is the longest link this issues, and if
    // it ever pushes past the mid-twenties the answer is a shorter payload -
    // not a bigger code, which only moves the problem to the camera.
    assert.ok(version <= 15, `a full destination link needs version ${version}`);
});

test('version selection takes the smallest code that fits, at each level', () => {
    // One byte more than a version holds must step up exactly one version, and
    // never two. An off-by-one here is silent: the code still scans, it is just
    // needlessly dense.
    for (const ec of ['L', 'M', 'Q', 'H']) {
        let previous = 0;

        for (let n = 1; n <= 400; n++) {
            const { size } = qrMatrix(filler(n), ec);
            assert.ok(size >= previous, 'a longer payload chose a smaller version');
            previous = size;
        }
    }
});

test('more error correction never yields a smaller code', () => {
    const text = filler(120);
    const sizes = ['L', 'M', 'Q', 'H'].map((ec) => qrMatrix(text, ec).size);

    for (let i = 1; i < sizes.length; i++) {
        assert.ok(sizes[i] >= sizes[i - 1], `level ${'LMQH'[i]} produced a smaller code than ${'LMQH'[i - 1]}`);
    }
});

test('a payload too long for any version fails loudly', () => {
    // 2953 bytes is the ceiling, at level L. Silently truncating would produce
    // a code that scans perfectly and yields half a credential.
    assert.throws(() => qrMatrix(filler(3000), 'L'), /does not fit/);
    assert.throws(() => qrMatrix('x', 'Z'), /unknown error-correction level/);
});

test('the finder patterns are where a scanner looks for them', () => {
    const { size, modules } = qrMatrix('avr://pair?host=example.com&port=8081&key=abc', 'M');

    for (const [ox, oy] of [
        [0, 0],
        [size - 7, 0],
        [0, size - 7]
    ]) {
        assert.equal(modules[oy][ox], 1, 'finder corner is light');
        assert.equal(modules[oy + 3][ox + 3], 1, 'finder centre is light');
        assert.equal(modules[oy + 1][ox + 1], 0, 'finder inner ring is dark');
    }

    // The dark module. Fixed, carries nothing, and its absence is the
    // difference between a QR code and a picture of one.
    assert.equal(modules[size - 8][8], 1);
});

test('the SVG carries a four-module quiet zone and one path', () => {
    const svg = qrSvg('avr://pair?host=example.com&port=8081&key=abc', { title: 'Destination link' });
    const { size } = qrMatrix('avr://pair?host=example.com&port=8081&key=abc', 'M');

    assert.match(svg, new RegExp(`viewBox="0 0 ${size + 8} ${size + 8}"`), 'the quiet zone is missing or wrong');

    // One path, not one rect per module: a version 11 code is over three
    // thousand modules and the panel re-renders on every countdown tick.
    assert.equal(svg.match(/<path/g).length, 1);
    assert.equal(svg.match(/<rect/g).length, 1);

    // White behind, black on top. A dark-themed QR code inside a dark panel is
    // the classic way to ship one that previews well and does not scan.
    assert.match(svg, /<rect[^>]*fill="#fff"/);
    assert.match(svg, /<path[^>]*fill="#000"/);

    assert.match(svg, /aria-label="Destination link"/);
    assert.match(qrSvg('x'), /aria-hidden="true"/);
});

test('the SVG escapes its accessible label', () => {
    // The label is caller-supplied and the destination name reaches it.
    const svg = qrSvg('x', { title: '"><script>alert(1)</script>' });
    assert.ok(!svg.includes('<script>'), 'the label was interpolated raw');
    assert.match(svg, /&quot;&gt;&lt;script&gt;/);
});

/*
 * Regenerating the fixtures.
 *
 * Only needed if the fixture set itself changes. Do not regenerate them from
 * this encoder - that turns the test into a tautology and is how a subtly wrong
 * implementation becomes the specification. Install the reference, run the
 * generator, uninstall it:
 *
 *   npm install --no-save uqr@0.1.3
 *   node test/fixtures/qr-generate.mjs
 *   npm uninstall uqr
 *
 * `uqr` is passed a byte array rather than a string, which forces byte mode.
 * Given a string it segments into numeric and alphanumeric modes where it can,
 * and this encoder deliberately does not - see the header of src/ui/qr.js.
 */
