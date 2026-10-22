import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEEN_KEY, WELCOME_TEXT, shouldGreet } from '../src/ui/welcome-modal.js';

/**
 * The greeting a browser meets once, on its first visit.
 *
 * Two halves, tested two ways, the way `image-gate.test.js` does it. The
 * decision — *does this browser still owe a greeting?* — is real code run
 * against a stub store. The drawing needs a DOM that `node --test` does not
 * have, so the properties of it that must not drift are pinned against the
 * source.
 *
 * The property worth stating outright, because it is the one a later tidy-up
 * would most plausibly undo: **this box is not an age surface.** It draws
 * under the gate, under the gate's banner and under the image interstitial,
 * it takes no consent, and closing it changes nothing about what the visitor
 * is shown. If it ever ends up on top of the gate, the greeting is covering
 * the one dialog on this site that exists for a legal reason.
 */

const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'welcome-modal.js'),
    'utf8'
);

const CSS = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'netflix.css'),
    'utf8'
);

const MAIN = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js'),
    'utf8'
);

/** A `localStorage` that works. */
function store(initial = {}) {
    const map = new Map(Object.entries(initial));

    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        map
    };
}

/* ------------------------------------------------------------- decision -- */

test('a browser that has never been greeted is greeted', () => {
    assert.equal(shouldGreet(store()), true);
});

test('a browser that has been greeted is not greeted again', () => {
    assert.equal(shouldGreet(store({ [SEEN_KEY]: '1' })), false);
});

test('storage that throws is read as "not greeted yet"', () => {
    // Private mode, or a browser with storage switched off. Showing it again
    // is the right way round: a greeting seen twice is an annoyance, one that
    // silently never appears is invisible until somebody asks where it went.
    const hostile = {
        getItem() {
            throw new Error('SecurityError');
        }
    };

    assert.equal(shouldGreet(hostile), true);
    assert.equal(shouldGreet(null), true, 'and so is no storage at all');
});

test('any value other than the flag means not yet greeted', () => {
    // Guards the upgrade path. A key left behind by some earlier shape of
    // this — `'true'`, `'0'`, an empty string — must not read as "seen".
    for (const v of ['', '0', 'true', 'yes']) {
        assert.equal(shouldGreet(store({ [SEEN_KEY]: v })), true, `'${v}' suppressed the greeting`);
    }
});

/* -------------------------------------------------------------- drawing -- */

test('the text is the one that was asked for', () => {
    assert.equal(WELCOME_TEXT, 'Hello WeCamgirls');
});

test('it is closeable, by all three of the usual routes', () => {
    assert.match(SRC, /\[data-close\][\s\S]{0,80}addEventListener\('click', close\)/, 'no close button');
    assert.match(SRC, /event\.key === 'Escape'/, 'Escape does not close it');
    assert.match(SRC, /if \(event\.target === root\) close\(\)/, 'a click on the backdrop does not close it');

    // And the backdrop click is tested rather than merely heard. A click on
    // the box bubbles to the root too, so an untested handler would make the
    // box dismiss itself the moment somebody read it.
    assert.doesNotMatch(
        SRC,
        /root\.addEventListener\('click', close\)/,
        'the box closes itself when clicked, because the backdrop click is untested'
    );
});

test('the text is assigned rather than interpolated into markup', () => {
    assert.match(SRC, /\.textContent = text/, 'the greeting is built by string concatenation into innerHTML');
    assert.doesNotMatch(SRC, /innerHTML[\s\S]{0,200}\$\{text\}/, 'the caller’s text reaches innerHTML');
});

test('the greeting is remembered on dismissal, not on display', () => {
    // A visitor who closed the tab without ever seeing it has not been
    // greeted, and should be when they come back.
    const close = SRC.slice(SRC.indexOf('function close()'));

    assert.match(close.slice(0, 300), /remember\(storage, key\)/, 'closing does not remember');

    // Exactly one call site, and it is the one inside `close`. Matched on the
    // call's own argument names rather than on `remember(`, which would also
    // find the declaration above it.
    assert.equal(
        SRC.split('remember(storage, key)').length - 1,
        1,
        'it is remembered somewhere other than on dismissal'
    );
});

test('it is drawn once, however many times it is called', () => {
    assert.match(SRC, /getElementById\(ROOT_ID\)\) return null/, 'a second call stacks a second box');
});

/* ------------------------------------------------- not an age surface -- */

test('every age surface draws above the greeting', () => {
    // The one property this file exists for. `.age-gate` is 95, the image
    // interstitial 94 and `.age-banner` 93; this must be under all three.
    const block = CSS.slice(CSS.indexOf('.welcome-modal {'));
    const z = block.match(/z-index:\s*(\d+)/);

    assert.ok(z, '.welcome-modal has no z-index, so its stacking is incidental');
    assert.ok(
        Number(z[1]) < 93,
        `.welcome-modal is at ${z[1]}, which is not under every age surface`
    );
});

test('the greeting takes no consent and gates nothing', () => {
    // It is a greeting. If it ever starts reading the age state or calling
    // the gate, it has become a second age surface that nobody designed.
    for (const forbidden of ['ageOk', 'age-state', 'openAgeGate', 'attest', 'setAgeState']) {
        assert.ok(!SRC.includes(forbidden), `the greeting touches ${forbidden}`);
    }
});

test('it is actually wired up', () => {
    // The module existing and being called are two different claims.
    assert.match(MAIN, /import \{ initWelcomeModal \}/, 'main.js does not import it');
    assert.match(MAIN, /^\s*initWelcomeModal\(\);/m, 'main.js never calls it');

    // After the gate, so the banner is already behind it on a first visit.
    assert.ok(
        MAIN.indexOf('initWelcomeModal()') > MAIN.indexOf('initImageGate()'),
        'the greeting is drawn before the age surfaces it must sit behind'
    );
});
