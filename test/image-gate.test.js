import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coveredPicture, imageUrl, isPlainLeftClick } from '../src/ui/covered-image.js';

/**
 * The overlay offering the age gate when a covered picture is clicked.
 *
 * Two halves, tested two ways. The matching rule — *is this element a picture
 * the server covered?* — is real code run against stub elements below. The
 * overlay itself cannot be imported here at all: it reaches the brand lockup
 * through `ui/age-gate.js`, which imports a PNG that `node --test` will not
 * load, so the handful of its properties that must not drift are pinned
 * against its source, the way `analytics.test.js` pins its call sites.
 *
 * The property this file exists for is the one a later tidy-up is most likely
 * to "fix": **this gate is not a wall.** Cancelling goes through to wherever
 * the picture led, with the covering still on. A visitor who declines keeps
 * browsing a censored site. Making it dismissible-only-by-verifying would
 * collect identity by attrition from visitors no statute asks us to check —
 * the twenty-seven states that do require a verified adult are handled
 * server-side in `server/identity/visitor-gate.js`, where a dialog cannot be
 * dismissed past.
 */

const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'image-gate.js'),
    'utf8'
);

/* ------------------------------------------------------------------ stubs --
   Four methods is everything `covered-image.js` touches, which is the reason
   it takes its nodes as arguments instead of reaching for `document`. */

/** One element. `spec` is `tag.class.class`; `attrs` are what `getAttribute` sees. */
function node(spec, attrs = {}) {
    const [tag, ...classes] = spec.split('.');

    return {
        tagName: (tag || 'div').toUpperCase(),
        classes: new Set(classes),
        parentElement: null,
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        closest(selector) {
            const parts = selector.split(',').map((s) => s.trim());
            for (let el = this; el; el = el.parentElement) {
                if (parts.some((part) => matches(el, part))) return el;
            }
            return null;
        }
    };
}

function matches(el, part) {
    const [tag, ...classes] = part.split('.');
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    return classes.every((c) => el.classes.has(c));
}

/** Link elements outermost-first. Returns them all, so a test can name any one. */
function nest(...els) {
    els.forEach((el, i) => {
        el.parentElement = els[i - 1] ?? null;
    });
    return els;
}

/** A background-image the way `ui/browse.js` writes it. */
const bg = (url) => ({ style: `background-image: url('${url}'); border-radius: 4px` });

/* ------------------------------------------------------------ what matches -- */

test('artwork from the covering proxy is a covered picture', () => {
    const img = node('img', { src: '/api/media?k=abc&sig=def' });
    assert.equal(coveredPicture(img, null), img);
});

test('a cam tile is a covered picture', () => {
    const img = node('img', { src: '/api/cams/thumb/somebody.jpg' });
    assert.equal(coveredPicture(img, null), img);
});

test('the logo, an icon and anything else of ours is not', () => {
    for (const src of ['/assets/logo-symbol.png', '/favicon.ico', '/api/profiles/7/avatar']) {
        assert.equal(coveredPicture(node('img', { src }), null), null, src);
    }
});

test('a path that merely starts with the covered one is not covered', () => {
    // `/api/media` is a prefix of plenty of things that could be added later
    // and are not covered bytes. The word boundary is load-bearing.
    assert.equal(coveredPicture(node('img', { src: '/api/mediakit/press-pack.jpg' }), null), null);
});

test('an absolute partner URL is not a covered picture', () => {
    // A verified visitor gets the partner's own URL in the JSON and an
    // unverified one gets `/api/media`. So an absolute URL on the page means
    // the server already decided this visitor may see it uncovered, and
    // asking them to verify in front of it would be asking twice.
    const img = node('img', { src: 'https://partner.example/covers/1.jpg' });
    assert.equal(coveredPicture(img, null), null);
});

test('a card wearing its art as a background is found from the badge on top of it', () => {
    // The click lands on whatever is painted last. On a cam tile that is the
    // viewer count; on a film card it is the duration. Neither has a picture.
    const [card, badge] = nest(node('div.card', bg('/api/media?k=xyz')), node('span.badge'));

    assert.equal(coveredPicture(badge, null), card);
});

test('the walk stops where it is told to', () => {
    // `document.body` in the real caller. If the stop element itself matched,
    // one covered background on a container would make the entire page a
    // target, including its empty margins.
    const [body, child] = nest(node('body', bg('/api/media?k=xyz')), node('div'));

    assert.equal(coveredPicture(child, body), null);
});

test('nothing inside an ad slot is ever a target', () => {
    // Belt and braces: an ad creative is served by the advertiser and so is
    // never on these endpoints in the first place. This is here because the
    // cost of being wrong is one-sided — an interstitial in front of a click
    // we were paid for is us taking the advertiser's money and then standing
    // in the doorway.
    for (const slot of ['div.ad-slot', 'ins.adsbyjuicy']) {
        const [, , img] = nest(
            node(slot),
            node('div'),
            node('img', { src: '/api/media?k=abc' })
        );
        assert.equal(coveredPicture(img, null), null, slot);
    }
});

test('a click on nothing is not a click on a picture', () => {
    assert.equal(coveredPicture(null, null), null);
});

/* -------------------------------------------------------------- the URL -- */

test('an image is read from src, and a container from its inline background', () => {
    assert.equal(imageUrl(node('img', { src: '/api/media?k=1' })), '/api/media?k=1');
    assert.equal(imageUrl(node('div', bg('/api/media?k=2'))), '/api/media?k=2');
    assert.equal(imageUrl(node('div', { style: 'color: red' })), '');
    assert.equal(imageUrl(node('div')), '');
});

test('the background is read however it was quoted', () => {
    for (const style of [
        'background-image:url(/api/media?k=1)',
        "background-image: url('/api/media?k=1')",
        'background-image:  url( "/api/media?k=1" )',
        'BACKGROUND-IMAGE: URL(/api/media?k=1)'
    ]) {
        assert.equal(imageUrl(node('div', { style })), '/api/media?k=1', style);
    }
});

/* --------------------------------------------------------- which clicks -- */

test('only a plain left click asks us anything', () => {
    assert.equal(isPlainLeftClick({ button: 0 }), true);

    // Middle-click and ctrl-click are "open in a new tab". Cancelling one
    // would eat an interaction the browser was going to handle, and the
    // visitor has not asked us a question by making it.
    assert.equal(isPlainLeftClick({ button: 1 }), false);
    assert.equal(isPlainLeftClick({ button: 2 }), false);

    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
        assert.equal(isPlainLeftClick({ button: 0, [key]: true }), false, key);
    }
});

/* ------------------------------------------------------------ the overlay -- */

test('the overlay has no close cross, because closing is an outcome and not an escape', () => {
    // Every way out is labelled. A cross implies "never mind", and there is
    // no never-mind here: the click is going through either way, covered or
    // not, so both buttons say which.
    assert.ok(
        !/image-gate-close|aria-label="Close"|&times;/.test(SRC),
        'the image interstitial has grown a close cross'
    );
});

test('every way out of the overlay continues the click', () => {
    // Four exits — Escape, the backdrop, the decline button and returning
    // from the age gate — and all of them land on the same function, which
    // replays the click. Three call sites, because the backdrop and the
    // button are wired by one loop over `[data-continue]`. If any of them
    // grew its own exit it would be a dead end: an overlay that vanished and
    // left the visitor where they started, having answered for nothing.
    const go = (SRC.match(/\bgo\(\)/g) || []).length;
    assert.ok(go >= 3, `expected Escape, [data-continue] and verify to call go(); saw ${go}`);

    const hooks = (SRC.match(/data-continue/g) || []).length;
    assert.ok(hooks >= 3, `expected the backdrop, the button and the query; saw ${hooks}`);

    assert.match(SRC, /querySelectorAll\('\[data-continue\]'\)/, 'the two exits are no longer wired together');
    assert.match(SRC, /'Escape'/, 'Escape no longer dismisses');
});

test('declining is offered in words, not buried', () => {
    assert.match(SRC, /Continue without verifying/);
    assert.match(SRC, /images stay covered/);
});

test('the replayed click does not re-open the overlay', () => {
    // The visitor's click is cancelled and re-fired once they have answered.
    // Without the guard the same delegated listener catches the replay and
    // asks again, forever.
    assert.match(SRC, /if \(replaying \|\| ageOk\(\)\) return;/);
    assert.match(SRC, /replaying = true;[\s\S]{0,200}?replaying = false;/);
});

test('a visitor already through the gate never sees it', () => {
    assert.match(SRC, /ageOk\(\)/, 'the overlay no longer checks whether the visitor is verified');
});
