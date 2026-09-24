/**
 * Regenerate `qr.json` from an independent QR implementation.
 *
 * Not part of the test run and not a dependency of anything. It exists so the
 * fixtures can be rebuilt rather than trusted, and so the thing they were built
 * from is written down. See the note at the bottom of `test/qr.test.js`.
 *
 *   npm install --no-save uqr@0.1.3
 *   node test/fixtures/qr-generate.mjs
 *   npm uninstall uqr
 *
 * `uqr` is handed a byte array, not a string. Given a string it segments into
 * numeric and alphanumeric modes where it can; this encoder is byte-mode only,
 * so comparing against its string path would compare two different encodings.
 */

import { encode } from 'uqr';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = 'zC7Qm1xTb9Lf0YvK4sHnRdP2eWgA6uJ8';
const PIN = encodeURIComponent('sha256/K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=');
const LINK = `avr://pair?host=live.example.com&port=8081&key=${KEY}&name=Rig%201&tls=1&pin=${PIN}`;

/** Deterministic filler, so a long fixture is a number rather than a wall of text. */
const filler = (n) => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_.~';
    return Array.from({ length: n }, (_, i) => alphabet[(i * 7) % 40]).join('');
};

const cases = [
    { text: 'hello', ec: 'M' },
    { text: '', ec: 'L' },
    { text: `avr://pair?host=192.168.1.110&port=8081&key=${KEY}&name=Studio+A`, ec: 'M' },
    ...['L', 'M', 'Q', 'H'].map((ec) => ({ text: LINK, ec })),
    // Multi-byte UTF-8, because the destination name is free text.
    { text: 'Café — Scène 1', ec: 'H' },
    // Inputs another encoder would segment as numeric or alphanumeric. This one
    // must not, and these fixtures are what says so.
    { text: '1234567890', ec: 'H' },
    { text: 'HTTP://EXAMPLE.COM/ABC', ec: 'L' }
];

// One fixture per version per level: the shortest payload that lands on each
// version, found by asking the reference rather than by consulting the tables
// under test. Both of the tables in `src/ui/qr.js` are indexed by version and
// level, and a wrong row there is invisible from every other row - which is how
// the version 8 level H entry survived being typed in wrong. Every cell of both
// tables has to be exercised, so every cell gets a fixture.
const CAPACITY = { L: 2953, M: 2331, Q: 1663, H: 1273 };

for (const ec of ['L', 'M', 'Q', 'H']) {
    let seen = 0;

    for (let n = 1; n <= CAPACITY[ec]; n++) {
        const { size } = encode(Array.from(new TextEncoder().encode(filler(n))), { ecc: ec, border: 0 });
        if (size === seen) continue;

        seen = size;
        cases.push({ filler: n, ec });
    }
}

const out = cases.map((c) => {
    const text = c.text ?? filler(c.filler);
    const ref = encode(Array.from(new TextEncoder().encode(text)), { ecc: c.ec, border: 0 });
    const grid = Array.from({ length: ref.size }, (_, y) =>
        Array.from(ref.data[y], (m) => (m ? '#' : '.')).join('')
    );

    return {
        ...c,
        size: ref.size,
        sha256: crypto.createHash('sha256').update(grid.join('\n')).digest('hex'),
        // Small codes are kept whole so a failure shows up as a readable diff.
        // Keeping the large ones too would be a megabyte of fixture for no
        // information the digest does not already carry.
        ...(ref.size <= 25 ? { matrix: grid } : {})
    };
});

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qr.json');
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

console.log(`${out.length} fixtures written to ${target}`);
