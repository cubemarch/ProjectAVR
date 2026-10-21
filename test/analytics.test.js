import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EVENTS, regionOf, track } from '../src/analytics.js';

/**
 * What the site reports, and what it must never report.
 *
 * Analytics is the one kind of code that fails silently in both directions. A
 * broken call sends nothing and looks exactly like a quiet week; a careless
 * one sends something it should not and looks exactly like a working report.
 * Neither shows up in a browser, so both are pinned here.
 *
 * The rule the second half of this file exists for: **no parameter sent from
 * this site may identify anybody.** Not a user id, not an email, not a
 * performer's name, not the title of a film one person opened. That is a
 * promise the privacy policy makes in `public/legal/privacy.html` — Analytics
 * is "configured for aggregate measurement — we read it as totals, not as a
 * record of what any one person watched" — and it is the same reasoning that
 * keeps the identity provider's inquiry id out of the gate's response body in
 * `server/identity/visitor-gate.js`.
 *
 * The temptation is real and specific: every outbound call site here is
 * holding a performer's name or a room's username at the moment it fires, and
 * adding one would make the report more interesting and the promise false.
 */

const analyticsSource = readFileSync(new URL('../src/analytics.js', import.meta.url), 'utf8');
const gateSource = readFileSync(new URL('../src/ui/age-gate.js', import.meta.url), 'utf8');
const browseSource = readFileSync(new URL('../src/ui/browse.js', import.meta.url), 'utf8');
const camsSource = readFileSync(new URL('../src/ui/cams.js', import.meta.url), 'utf8');

const callSites = [
    ['age-gate.js', gateSource],
    ['browse.js', browseSource],
    ['cams.js', camsSource]
];

/**
 * Every `track(EVENTS.X, …)` / `report(EVENTS.X, …)` in one file, with the
 * parameters resolved.
 *
 * Two forms have to be understood rather than skipped, because a scan that
 * silently misses a call site is worse than no scan: it reports a clean sweep
 * over the calls it happened to recognise. A bare identifier — `track(E, where)`
 * — is looked up, and a spread of one — `{ ...where, method }` — is expanded.
 */
function calls(src) {
    const found = [...src.matchAll(/\b(?:track|report)\(\s*EVENTS\.([A-Z_]+)\s*,\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)/g)];

    assert.ok(found.length, 'the scan found no calls at all, which means the pattern has rotted');

    return found.map((m) => ({ event: m[1], params: resolve(m[2], src) }));
}

/** An object literal's inner text, following one level of name or spread. */
function resolve(arg, src) {
    const body = arg.startsWith('{') ? arg.slice(1, -1) : lookup(arg, src);

    return body.replace(/\.\.\.([A-Za-z_$][\w$]*)/g, (_, name) => lookup(name, src));
}

function lookup(name, src) {
    const found = new RegExp(`\\bconst ${name} = \\{([^}]*)\\}`).exec(src);
    assert.ok(found, `a call passes \`${name}\`, which is not a local object literal this scan can read`);
    return found[1];
}

/**
 * The same text with every string literal blanked.
 *
 * The rule below is about what is *read off an object* — `item.title`,
 * `room.name` — and never about a literal. Without this, a parameter whose
 * value is the word `'title'` meaning "this card was a film" reads as a film's
 * title and fails.
 */
function withoutLiterals(text) {
    return text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
}

/** A method body, bounded by the next method rather than the end of the file. */
function methodBody(name, src) {
    const open = new RegExp(`\\n {4}(?:async )?${name}\\(`);
    const found = open.exec(src);

    assert.ok(found, `${name} moved or was renamed`);
    assert.ok(!open.test(src.slice(found.index + found[0].length)), `${name} is defined more than once`);

    const after = found.index + found[0].length;
    const next = src.slice(after).search(/\n {4}(?:async )?[_a-zA-Z]+\(/);

    return next === -1 ? src.slice(found.index) : src.slice(found.index, after + next);
}

/* ------------------------------------------------------------------ track -- */

test('track does nothing at all without a tag on the page', () => {
    // Node has no `window`, which is also every test run and every server-side
    // import of a module that happens to call this.
    assert.equal(globalThis.window, undefined, 'the environment is the assertion');
    assert.doesNotThrow(() => track(EVENTS.AGE_GATE_PASSED, { method: 'stored' }));
});

test('track reports the event and drops the empty parameters', () => {
    const sent = [];
    globalThis.window = { gtag: (...args) => sent.push(args) };

    try {
        track(EVENTS.AFFILIATE_CLICK, {
            partner: 'AEBN',
            program: undefined,
            card: null,
            label: '',
            count: 0,
            flagged: false
        });
    } finally {
        delete globalThis.window;
    }

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], [
        'event',
        'affiliate_click',
        // `0` and `false` survive: they are answers. Only absent is absent.
        { partner: 'AEBN', count: 0, flagged: false }
    ]);
});

test('a measurement failure never reaches the page', () => {
    // The ordinary case is an ad blocker replacing `gtag` with something
    // hostile. A click handler that lets it through stops a paid link working.
    globalThis.window = {
        gtag: () => {
            throw new Error('blocked');
        }
    };

    try {
        assert.doesNotThrow(() => track(EVENTS.STOREFRONT_CLICK, { partner: 'AEBN' }));
    } finally {
        delete globalThis.window;
    }
});

test('a jurisdiction becomes one groupable string and never anything finer', () => {
    assert.equal(regionOf({ country: 'US', region: 'TX' }), 'US-TX');
    assert.equal(regionOf({ country: 'US', region: null }), 'US', 'an unresolved region is still worth counting');
    assert.equal(regionOf({ country: null, region: 'TX' }), 'TX');
    assert.equal(regionOf(null), undefined);
    assert.equal(regionOf(undefined), undefined);
    assert.equal(regionOf({}), undefined, 'absent, not an empty string that would read as a real bucket');
});

/* --------------------------------------------------------------- inventory -- */

test('every event fired is one the inventory declares', () => {
    for (const [file, src] of callSites) {
        for (const { event } of calls(src)) {
            assert.ok(EVENTS[event], `${file} fires EVENTS.${event}, which does not exist`);
        }
    }
});

test('every event the inventory declares is actually fired', () => {
    const fired = new Set(callSites.flatMap(([, src]) => calls(src).map((c) => c.event)));

    for (const name of Object.keys(EVENTS)) {
        assert.ok(fired.has(name), `EVENTS.${name} is declared but nothing sends it`);
    }
});

test('the event names are shaped the way GA4 requires', () => {
    for (const [key, name] of Object.entries(EVENTS)) {
        assert.match(name, /^[a-z][a-z0-9_]*$/, `${key} is not snake_case`);
        assert.ok(name.length <= 40, `${key} is longer than GA4 allows`);
    }
});

/* ---------------------------------------------------------- the hard rule -- */

test('nothing reported can identify a person', () => {
    // Each of these is in scope at one or more of the call sites, which is
    // exactly why the list is worth having. `username` and `name` are on a cam
    // room, `title` on a film, `starId` on a performer card, and the auth and
    // identity fields on anything that can reach `api.user`.
    const forbidden =
        /\b(?:username|email|user(?:_?id|_?name)?|account|sub|token|inquiry|session_?id|star_?id|ip|title|name|href|subject)\b/i;

    for (const [file, src] of callSites) {
        for (const { event, params } of calls(src)) {
            const read = withoutLiterals(params);
            assert.doesNotMatch(read, forbidden, `${file} sends something identifying with ${event}: ${params}`);
        }
    }
});

test('the one parameter carrying what somebody typed is there on purpose', () => {
    // `search_term` is the exception to the rule above and the only one. It is
    // GA4's own parameter for its own search report, it is what a visitor
    // asked a catalogue for rather than anything about them, and it arrives
    // with nothing attached that could say who asked. Pinned so that removing
    // it is a decision and adding a second one like it is a conversation.
    //
    // `text` is in the pattern on purpose and catches `textContent` — reading
    // a parameter out of the rendered page is the shape this file is policing,
    // whether or not the particular string is harmless today.
    const content = callSites.flatMap(([file, src]) =>
        calls(src)
            .filter(({ params }) => /search_term|query|typed|text/.test(withoutLiterals(params)))
            .map(({ event }) => `${file}:${event}`)
    );

    assert.deepEqual(content, ['cams.js:SEARCH']);
});

test('the module says why, so the next person does not have to guess', () => {
    assert.match(analyticsSource, /aggregate measurement/, 'it cites the promise the policy makes');
    assert.match(analyticsSource, /visitor-gate\.js/, 'and the server-side rule it matches');
});

/* --------------------------------------------------------------- age gate -- */

test('passing the age gate is reported once, with how it was passed', () => {
    const passes = calls(gateSource).filter((c) => c.event === 'AGE_GATE_PASSED');

    // Four since 2026-10-20, when the banner gave the dialog a second way in.
    // `openAgeGate` re-asks the server before drawing anything, so a visitor
    // who passed the gate in another tab and then clicked the banner here is
    // a pass that happens without the dialog ever being shown — distinct from
    // `again`'s recheck, which happens with it already on screen.
    assert.equal(
        passes.length,
        4,
        'already through, through the dialog, rechecked on opening, and rechecked while open'
    );

    for (const { params } of passes) {
        assert.match(params, /method/, 'every pass says which route it took');
    }

    // The dialog's own pass goes through `done`, which must be told. A `done()`
    // with no argument would report `method` as absent and quietly make the
    // largest bucket unattributable.
    assert.doesNotMatch(gateSource, /\bdone\(\)/, 'done is never called without a method');

    for (const method of ['attestation', 'selfie', 'document']) {
        assert.match(gateSource, new RegExp(`done\\('${method}'\\)`), `the ${method} route names itself`);
    }
});

test('the gate reports being shown and being walked away from', () => {
    const fired = calls(gateSource).map((c) => c.event);

    assert.ok(fired.includes('AGE_GATE_SHOWN'), 'without it there is no denominator');
    assert.ok(fired.includes('AGE_GATE_LEFT'), 'and no way to tell a bounce from a pass');
    assert.ok(fired.includes('AGE_GATE_FAILED'), 'nor a provider outage from a run of minors');
});

test('a gate event carries the jurisdiction, because that is the only question', () => {
    for (const { event, params } of calls(gateSource)) {
        assert.match(params, /region/, `${event} must be groupable by jurisdiction`);
    }
});

/* ------------------------------------------------- the paid links out --- */

test('the storefront link is measurable, which is what makes All Movies countable', () => {
    assert.match(browseSource, /data-storefront="\$\{escapeHtml\(s\.id\)\}"/, 'the pill names itself');
    assert.match(browseSource, /data-partner="\$\{escapeHtml\(s\.partner\)\}"/, 'and who it goes to');

    const outbound = browseSource.slice(browseSource.indexOf('_bindOutbound()'));
    assert.match(outbound, /data-storefront/, 'and the handler matches on it');
});

test('outbound measurement is bound where affiliate-only mode will reach it', () => {
    // `_render` returns early in affiliate-only mode before every other bind,
    // and that is the mode the site runs in. A handler installed down there
    // would measure nothing and look installed.
    assert.match(methodBody('constructor', browseSource), /this\._bindOutbound\(\);/, 'bound from the constructor');

    const render = methodBody('_render', browseSource);
    const earlyReturn = render.indexOf('if (AFFILIATES_ONLY) return;');

    assert.ok(earlyReturn > 0, 'the early return is still there');
    assert.doesNotMatch(render.slice(earlyReturn), /_bindOutbound/, 'and the bind is not behind it');
});

test('measuring a paid link never interferes with following it', () => {
    const outbound = methodBody('_bindOutbound', browseSource);

    assert.doesNotMatch(outbound, /preventDefault|return false/, "following the link is the browser's job");
    assert.doesNotMatch(outbound, /\bawait\b/, 'and nothing is waited on before it happens');
});

test('a cam opened on the page is not counted as a visit to the partner', () => {
    const fired = calls(camsSource).map((c) => c.event);

    assert.ok(fired.includes('CAM_OPEN'), 'the theatre is its own event');
    assert.ok(fired.includes('CAM_CLICK'), 'and leaving is another');

    for (const { params } of calls(camsSource).filter((c) => c.event === 'CAM_CLICK')) {
        assert.match(params, /from:/, 'a click out says whether it came from the card or the theatre');
    }
});

test('the cam search is reported once the box settles, not once per letter', () => {
    const requery = camsSource.slice(camsSource.indexOf('async _requery() {'));

    assert.match(requery, /EVENTS\.SEARCH/, 'reported from the debounced path');
    assert.match(requery, /asked !== this\.reported/, 'and not again for a term already counted');

    // The `input` listener is the per-keystroke one. Nothing may report there.
    const input = camsSource.slice(camsSource.indexOf("search.addEventListener('input'"));
    const listener = input.slice(0, input.indexOf('});'));

    assert.doesNotMatch(listener, /EVENTS\./, 'and never from the keystroke handler');
});

test('cams imports the reporter under a name its own locals do not shadow', () => {
    // `const track = this.mount.querySelector('.cam-track')` exists twice in
    // this file. Imported as `track`, every call inside those methods would
    // resolve to an element.
    assert.match(camsSource, /import \{ EVENTS, track as report \}/, 'aliased at the import');
    assert.ok(/const track = this\.mount\.querySelector\('\.cam-track'\)/.test(camsSource), 'because of these');
});
