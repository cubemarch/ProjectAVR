import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AFFILIATES_ONLY, COMING_SOON_SHELVES } from '../src/site-mode.js';
import { PROJECTION_LABELS, STEREO_LABELS } from '../src/catalog/media-format.js';

/**
 * The placeholder rows that stand in for our own content.
 *
 * These exist because the page would otherwise be nothing but paid partner
 * rows, and they are the easiest thing on the site to make dishonest: a
 * placeholder is one edit away from a fake listing, and a fake listing on an
 * affiliate page is a specific kind of problem rather than a general one.
 *
 * So the rules in `site-mode.js` are pinned here rather than left as a
 * comment. The copy is free to change; what it may not become is inventory.
 */

test('a coming-soon shelf is a heading, a sentence and some shapes', () => {
    assert.ok(COMING_SOON_SHELVES.length > 0, 'the rows exist at all');

    for (const s of COMING_SOON_SHELVES) {
        assert.ok(s.title?.length, 'every shelf is named');
        assert.ok(s.blurb?.length > 40, `${s.title}: the blurb is a sentence, not a label`);

        const countOk = Number.isInteger(s.cards) && s.cards > 0;
        const listOk = Array.isArray(s.cards) && s.cards.length > 0 && s.cards.every((c) => c);
        assert.ok(countOk || listOk, `${s.title}: cards is a positive count or a list of labels`);
    }
});

test('no coming-soon copy promises a date', () => {
    // "Coming Soon!" is the whole commitment. A month, a quarter or a year
    // in here turns a placeholder into a announcement nobody agreed to make,
    // and it will still be on the page after the date passes.
    const dated =
        /\b(january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|20\d\d|next (week|month|year)|soon as|by the end of)\b/i;

    for (const s of COMING_SOON_SHELVES) {
        assert.doesNotMatch(s.blurb, dated, `${s.title}: the blurb names a date`);
        assert.doesNotMatch(s.title, dated, `${s.title}: the heading names a date`);
    }
});

test('no coming-soon shelf invents inventory', () => {
    // A placeholder that reads as a listing is a claim about what is on the
    // site. Counts are the usual way it happens — "1,200 titles", "40
    // creators online" — so no digit may appear in a blurb except inside a
    // format name, which is a fact about the pipeline.
    const formats = new Set([...Object.values(PROJECTION_LABELS), ...Object.values(STEREO_LABELS)]);

    for (const s of COMING_SOON_SHELVES) {
        let prose = s.blurb;
        for (const f of formats) prose = prose.split(f).join('');

        // 2D and 3D are the marketplace axis, named in `media-format.js`, and
        // are descriptions rather than counts.
        prose = prose.replace(/\b[23]D\b/g, '');

        assert.doesNotMatch(prose, /\d/, `${s.title}: a number in the copy reads as a count`);
    }
});

test('labelled placeholder cards use the vocabulary the product already has', () => {
    // `media-format.js` exists because this product once had four names for
    // 180° across four screens. A placeholder inventing a fifth would be the
    // same bug with a nicer excuse.
    const known = new Set([...Object.values(PROJECTION_LABELS), ...Object.values(STEREO_LABELS)]);

    const labelled = COMING_SOON_SHELVES.filter((s) => Array.isArray(s.cards));
    assert.ok(labelled.length > 0, 'at least one shelf labels its cards');

    for (const s of labelled) {
        for (const label of s.cards) {
            assert.ok(
                known.has(label),
                `${s.title}: "${label}" is not a name from PROJECTION_LABELS or STEREO_LABELS`
            );
        }
    }
});

test('the placeholder rows and the real rows are never both drawn', () => {
    // They carry the same headings. Two "Live Creators" rows on one page is
    // worse than either state this flag exists to choose between, and the
    // ternary in the template is the only thing preventing it.
    const browse = readFileSync(new URL('../src/ui/browse.js', import.meta.url), 'utf8');

    const uses = browse.match(/AFFILIATES_ONLY \? this\._comingSoonHtml\(\) : this\._ownContentHtml\(\)/g);
    assert.equal(uses?.length, 1, 'the two render through one exclusive choice');

    // And the placeholders claim none of the ids the real renderers write to.
    const soon = browse.slice(
        browse.indexOf('\n    _comingSoonHtml('),
        browse.indexOf('\n    _ownContentHtml(')
    );
    assert.ok(soon.length > 0, '_comingSoonHtml moved or was renamed');

    for (const id of ['live-creators', 'recordings-shelf', 'creator-row', 'recording-row']) {
        assert.doesNotMatch(soon, new RegExp(`id="${id}"`), `the placeholder claims #${id}`);
    }
});

test('the coming-soon rows are only reachable in the mode they were written for', () => {
    // Not a behaviour test — a reminder in executable form. If this fails,
    // `AFFILIATES_ONLY` has been turned off and `COMING_SOON_SHELVES` plus
    // `_comingSoonHtml` plus the CSS block should go with it.
    if (!AFFILIATES_ONLY) {
        assert.equal(
            COMING_SOON_SHELVES.length,
            0,
            'affiliate-only mode is off: delete the placeholder shelves, they are now duplicates'
        );
    }
});

test('no coming-soon copy leaks an internal path', () => {
    // A draft of the format blurb ended "What the headset gets is in
    // docs/DELIVERY.md" — true, internal, and meaningless to a visitor.
    for (const s of COMING_SOON_SHELVES) {
        assert.doesNotMatch(s.blurb, /\.md\b|\bdocs\/|\bsrc\/|\.js\b/, `${s.title}: a repo path in public copy`);
    }
});
