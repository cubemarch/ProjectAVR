import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../vite.config.js';

/**
 * What the built files are called.
 *
 * On 2026-11-12 the code both pages share, and the main stylesheet with it,
 * shipped as `injectContentsquareScript-*` — named after the first module the
 * bundler met in the chunk, which was the analytics SDK. A content blocker
 * filtering on that vendor's name blocks a first-party chunk, and without it
 * the site never starts. See `chunkName` in `vite.config.js`.
 */

const output = config.build.rollupOptions.output;

test('a shared chunk is called shared, never after a module inside it', () => {
    for (const name of ['injectContentsquareScript', 'analytics', 'juicyads', 'rolldown-runtime']) {
        const file = output.chunkFileNames({ name, isDynamicEntry: false });

        assert.match(file, /^assets\/shared-/, `${name} named a shared chunk`);
        assert.doesNotMatch(file, new RegExp(name, 'i'));
    }
});

test('the vendored engines and dynamic imports keep their names', () => {
    // `[name]` is the bundler's placeholder, filled in with the chunk's own name.
    for (const chunk of [{ name: 'playcanvas' }, { name: 'hls' }, { name: 'talkback', isDynamicEntry: true }]) {
        assert.match(output.chunkFileNames(chunk), /^assets\/\[name\]-/, `${chunk.name} lost its name`);
    }
});

test('a shared stylesheet is called shared too, and the pages keep theirs', () => {
    assert.equal(output.assetFileNames({ names: ['injectContentsquareScript.css'] }), 'assets/shared-[hash][extname]');
    assert.equal(output.assetFileNames({ names: ['main.css'] }), 'assets/[name]-[hash][extname]');
    assert.equal(output.assetFileNames({ names: ['live.css'] }), 'assets/[name]-[hash][extname]');
    assert.equal(output.assetFileNames({ names: ['logo-symbol.png'] }), 'assets/[name]-[hash][extname]');
});
