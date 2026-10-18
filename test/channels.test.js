import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Channel names: `/<name>`, the one address a creator can hand to an audience.
 *
 * Everything else that identifies a broadcast here is temporary by
 * construction - a session id names a socket on one process, and a broadcast
 * grant is spent on the connection it opened. So the properties held here are
 * the ones that make a name worth printing:
 *
 *   - a name is checked for shape, for length, and for whether it is pretending
 *     to be one of the site's own routes - including by homoglyph, which is the
 *     attack the naive lowercase-and-compare check misses;
 *   - a name belongs to exactly one account, and losing the race for one is an
 *     ordinary 409 rather than an exception;
 *   - renaming keeps the old name working, because the alternative is breaking
 *     every link anybody saved;
 *   - an ordinary creator holds one name and a superuser holds as many as they
 *     like, and that difference is the only thing separating them here;
 *   - only a superuser can reserve a name or take a reserved one, and the
 *     built-in reservations cannot be released by anybody;
 *   - the address resolves to whoever is at it and to whatever they have on
 *     air - but never to a private broadcast, which is reported as offline for
 *     the same reason it is absent from the public session list.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-channels-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
// The role is set from the environment at boot, and a developer's `.env` names
// a real address. Cleared so the promotion under test is the one this file asks
// for and not one the machine happened to be configured with.
process.env.AVR_SUPERUSER_EMAIL = '';

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { channelSlugs, users } = await import('../server/db/index.js');
const { rooms, sessions } = await import('../server/live/index.js');
const { applySuperuser } = await import('../server/auth/superuser.js');
const { RESERVED_SLUGS, normaliseSlug, skeleton, suggestSlug, validateSlug } = await import(
    '../server/channels/slug.js'
);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let accountSeq = 0;

function makeAgent() {
    const jar = new Map();

    return {
        token: null,
        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });

            for (const raw of res.headers.getSetCookie?.() ?? []) {
                const [pair] = raw.split(';');
                const idx = pair.indexOf('=');
                jar.set(pair.slice(0, idx), pair.slice(idx + 1));
            }

            const text = await res.text();
            return { status: res.status, body: text ? JSON.parse(text) : null };
        },

        async register(role = 'creator', displayName) {
            accountSeq += 1;
            this.email = `chan${accountSeq}@example.test`;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: this.email,
                    password: 'correcthorsebattery',
                    displayName: displayName ?? `Person ${accountSeq}`,
                    role,
                    tagline: 'On air nightly',
                    acceptedTerms: TERMS_VERSION,
                    acceptedCreatorTerms: CREATOR_TERMS_VERSION
                })
            });
            this.token = res.body?.accessToken ?? null;
            this.id = res.body?.user?.id ?? null;
            return res;
        },

        /** Re-issue the access token, so a role change shows up in the claims. */
        async signIn() {
            const res = await this.fetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: this.email, password: 'correcthorsebattery' })
            });
            this.token = res.body?.accessToken ?? this.token;
            return res;
        }
    };
}

/* ------------------------------------------------------------- the string -- */

test('a name has to be a name', () => {
    const bad = {
        '': 'slug_required',
        ab: 'slug_too_short',
        ['a'.repeat(31)]: 'slug_too_long',
        '-leading': 'slug_shape',
        'trailing-': 'slug_shape',
        'has space': 'slug_shape',
        'UPPER?': 'slug_shape',
        'emoji🎥here': 'slug_shape',
        // `xn--` is the punycode prefix; a name carrying it can be rendered by
        // a resolver as characters nobody chose.
        'xn--fiq': 'slug_double_hyphen',
        'a--b': 'slug_double_hyphen',
        12345: 'slug_numeric'
    };

    for (const [input, code] of Object.entries(bad)) {
        const result = validateSlug(input);
        assert.equal(result.ok, false, `${JSON.stringify(input)} should be refused`);
        assert.equal(result.code, code, `${JSON.stringify(input)}`);
        assert.ok(result.error, 'and say why, in words a person can act on');
    }

    for (const good of ['abc', 'kate-plays', 'studio99', 'a1b', 'x'.repeat(30)]) {
        assert.equal(validateSlug(good).ok, true, good);
    }
});

test('an all-digit name is refused because ids are all digits', () => {
    // Nothing here mints numeric ids today, but `/12345` reads as one, and a
    // name that reads as an id is a name that will one day collide with one.
    assert.equal(validateSlug('12345').code, 'slug_numeric');
    assert.equal(validateSlug('1a345').ok, true, 'one letter is enough to not be a number');
});

test('a name is refused when it is pretending to be one of ours', () => {
    for (const impostor of ['admin', 'ADMIN', 'adm1n', 'adrnin', '4dm1n', 'ad-min', 'a-d-m-i-n']) {
        const result = validateSlug(impostor);
        assert.equal(result.ok, false, impostor);
        assert.equal(result.code, 'slug_reserved', impostor);
    }

    // The mechanism: confusables collapse to the same skeleton.
    assert.equal(skeleton('adrnin'), skeleton('admin'));
    assert.equal(skeleton('1ogin'), skeleton('login'));
    assert.notEqual(skeleton('kate'), skeleton('admin'));
});

test('ordinary names are not caught by the reserved list', () => {
    const real = [
        'kate-plays',
        'northlight',
        'studio-nine',
        'the-forge',
        'velvet-room',
        'aurora',
        'bluehour',
        'two-trees',
        'nightshift',
        'midnight-club'
    ];

    for (const name of real) {
        assert.equal(validateSlug(name).ok, true, `${name} is somebody's channel, not a route`);
    }
});

test('the reserved list covers the routes the site actually serves', () => {
    // Grounded in the router rather than imagined: if one of these stops being
    // reserved, `/<name>` can be claimed out from under a real page.
    for (const route of [
        'api',
        'live',
        'creator',
        'profile',
        'deovr',
        'dlna',
        'media',
        'stream',
        'identity',
        'delivery',
        'playlist',
        'unsubscribe',
        'art',
        'assets',
        'admin',
        'login'
    ]) {
        assert.ok(RESERVED_SLUGS.has(route), `${route} is a route and must stay reserved`);
    }

    for (const mailbox of ['postmaster', 'abuse', 'security', 'webmaster']) {
        assert.ok(RESERVED_SLUGS.has(mailbox), `${mailbox} is an RFC 2142 mailbox`);
    }

    // This tier keeps age-assurance and recordkeeping vocabulary out of the
    // namespace: `/2257` has to be the records page and nobody's channel.
    for (const term of ['age', '2257', 'kyc', 'takedown', 'csam', 'appeal']) {
        assert.ok(RESERVED_SLUGS.has(term), `${term} is compliance vocabulary`);
    }
});

test('a display name is turned into something claimable, or into nothing', () => {
    assert.equal(suggestSlug('Kate Plays'), 'kate-plays');
    assert.equal(suggestSlug('  Café  Nine  '), 'cafe-nine');
    assert.equal(suggestSlug('!!!'), null, 'rather than a name made of nothing');
    assert.equal(suggestSlug('Jo'), null, 'rather than one that would be refused');
    assert.equal(normaliseSlug('Ünïcödé Studio'), 'unicode-studio');
});

/* ------------------------------------------------------------- holding one -- */

test('a creator claims a name and is then found at it', async () => {
    const agent = makeAgent();
    await agent.register('creator', 'Kate Plays');

    const before = await agent.fetch('/api/profile/names');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.names, []);
    assert.equal(before.body.suggestion, 'kate-plays', 'offered from the display name');
    assert.equal(before.body.limit, 1);

    const made = await agent.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'kate-plays' })
    });

    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.claimed, 'kate-plays');
    assert.equal(made.body.primary, 'kate-plays', 'a first name is the canonical one');

    const found = await agent.fetch('/api/channels/kate-plays');
    assert.equal(found.status, 200);
    assert.equal(found.body.canonical, 'kate-plays');
    assert.equal(found.body.channel.name, 'Kate Plays');
    assert.equal(found.body.live, null, 'the address still means something off air');
});

test('a channel page is public, and an empty one is a 404 rather than a blank', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'open-house' }) });

    // No token, no cookies. An address you need an account to look at is not an
    // address you can hand to anybody.
    const anon = await fetch(`${base}/api/channels/open-house`);
    assert.equal(anon.status, 200);
    assert.equal((await anon.json()).canonical, 'open-house');

    const missing = await fetch(`${base}/api/channels/nobody-is-here`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'no_such_channel');
});

test('two creators cannot hold one name', async () => {
    const first = makeAgent();
    await first.register('creator');
    const second = makeAgent();
    await second.register('creator');

    assert.equal(
        (await first.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'the-forge' }) }))
            .status,
        201
    );

    const lost = await second.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'the-forge' })
    });

    assert.equal(lost.status, 409);
    assert.equal(lost.body.code, 'slug_taken');
});

test('an ordinary creator holds exactly one name', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'one-name' }) });

    const second = await agent.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'another-name' })
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'name_limit');
    assert.match(second.body.error, /Change it instead/, 'and is told what to do instead');
});

test('renaming keeps the old name working', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'old-handle' }) });

    const renamed = await agent.fetch('/api/profile/names', {
        method: 'PATCH',
        body: JSON.stringify({ slug: 'new-handle' })
    });

    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.primary, 'new-handle');

    // The whole point. A card printed last year still works, and says so.
    const old = await agent.fetch('/api/channels/old-handle');
    assert.equal(old.status, 200);
    assert.equal(old.body.slug, 'old-handle');
    assert.equal(old.body.canonical, 'new-handle', 'so the page can correct its own URL');

    assert.equal((await agent.fetch('/api/channels/new-handle')).body.canonical, 'new-handle');

    // And the alias does not count against the one-name limit, because the
    // creator did not choose to collect it.
    const again = await agent.fetch('/api/profile/names', {
        method: 'PATCH',
        body: JSON.stringify({ slug: 'newer-handle' })
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('a creator cannot release their last name', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'only-one' }) });

    const gone = await agent.fetch('/api/profile/names/only-one', { method: 'DELETE' });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.code, 'last_name');
    assert.equal((await agent.fetch('/api/channels/only-one')).status, 200);
});

test('the availability check answers before the form is submitted', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'taken-name' }) });

    const other = makeAgent();
    await other.register('creator');

    const free = await other.fetch('/api/profile/names/available?name=quite-free');
    assert.equal(free.body.available, true);

    const taken = await other.fetch('/api/profile/names/available?name=taken-name');
    assert.equal(taken.body.available, false);
    assert.equal(taken.body.mine, false);

    const own = await agent.fetch('/api/profile/names/available?name=taken-name');
    assert.equal(own.body.mine, true, 'so the field can say "that is already yours"');

    const reserved = await other.fetch('/api/profile/names/available?name=admin');
    assert.equal(reserved.body.available, false);
    assert.equal(reserved.body.code, 'slug_reserved');

    // Signed out, this endpoint does not exist. It enumerates the namespace.
    assert.equal((await fetch(`${base}/api/profile/names/available?name=quite-free`)).status, 401);
});

/* ------------------------------------------------------------------ on air -- */

test('the address resolves to whatever is live on it', async (t) => {
    const agent = makeAgent();
    await agent.register('creator', 'Nightshift');
    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'nightshift' }) });

    // A broadcast as the ingest path would create it, minus the socket.
    const session = sessions.create({
        name: 'On air',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        userId: agent.id
    });
    t.after(() => session.close('test over'));

    const open = await agent.fetch('/api/channels/nightshift');
    assert.equal(open.body.live?.sessionId, session.id, 'which is the whole reason the address exists');
    assert.ok(open.body.live.relayPath, 'described exactly as the session list describes it');
});

test('a private broadcast is reported as offline, not as a target', async (t) => {
    const agent = makeAgent();
    await agent.register('creator', 'Backroom');
    await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'backroom' }) });

    const session = sessions.create({
        name: 'Just for you',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        userId: agent.id
    });
    t.after(() => session.close('test over'));

    const room = rooms.takeOver(session, { creatorId: agent.id, userId: 'the-one-admitted' });
    t.after(() => rooms.close(room, 'test over'));

    // The relay's admission secret is the control. This is about not
    // advertising the target: a channel page is public, so a 1:1 appearing on
    // it with its session id next to it would announce both that it exists and
    // what to aim at.
    const hidden = await agent.fetch('/api/channels/backroom');
    assert.equal(hidden.status, 200, 'the channel is still there');
    assert.equal(hidden.body.live, null, 'the broadcast is not');

    // And the public list agrees, because two shapes for one fact is two
    // things to keep in step.
    const listed = await agent.fetch('/api/live/sessions');
    assert.ok(
        !listed.body.sessions.some((s) => s.sessionId === session.id),
        'the channel page and /api/live/sessions report the same broadcast the same way'
    );
});

/* -------------------------------------------------------------- superuser -- */

test('the superuser is set by the environment and by nothing else', async () => {
    const agent = makeAgent();
    await agent.register('creator');

    // There is no route for this. The only lever is the variable.
    assert.equal(users.byId(agent.id).role, 'creator');

    applySuperuser(agent.email);
    assert.equal(users.byId(agent.id).role, 'superuser');

    // Idempotent, and a demotion when the variable moves on.
    applySuperuser(agent.email);
    assert.equal(users.byId(agent.id).role, 'superuser');

    applySuperuser('');
    assert.equal(users.byId(agent.id).role, 'admin', 'clearing the variable has to actually clear it');
});

test('the address is matched however it was typed', async () => {
    // The variable is typed by a person, into a deployment config, on a
    // different day from the signup. A capital letter must not silently cost
    // somebody the role.
    const agent = makeAgent();
    await agent.register('creator');

    applySuperuser(agent.email.toUpperCase());
    assert.equal(users.byId(agent.id).role, 'superuser');

    applySuperuser('');
});

test('an email that has not signed up yet is not an error', () => {
    // A deployment sets the variable before the account exists. Nothing is
    // promoted and nothing refuses to boot.
    assert.deepEqual(applySuperuser('nobody-yet@example.test'), { promoted: null, demoted: [] });
});

test('the operator signing up is a superuser from their first request', async (t) => {
    // The gap the boot pass leaves: the variable is set, the account is not
    // there yet, and nobody knows to restart once it is.
    const previous = process.env.AVR_SUPERUSER_EMAIL;
    process.env.AVR_SUPERUSER_EMAIL = `chan${accountSeq + 1}@example.test`;
    t.after(() => {
        process.env.AVR_SUPERUSER_EMAIL = previous;
        applySuperuser('');
    });

    const agent = makeAgent();
    const made = await agent.register('viewer');

    assert.equal(made.body.user.role, 'superuser', 'and the token it was issued says so');
    assert.equal(users.byId(agent.id).role, 'superuser');

    // Not a self-service route: the same signup with any other address is an
    // ordinary account.
    const mortal = makeAgent();
    await mortal.register('viewer');
    assert.equal(users.byId(mortal.id).role, 'viewer');

    // The console the role unlocks is reachable without a restart.
    assert.equal((await agent.fetch('/api/superuser/reserved')).status, 200);
});

test('a superuser holds as many names as they like, including reserved ones', async () => {
    const agent = makeAgent();
    await agent.register('creator');
    applySuperuser(agent.email);
    await agent.signIn();

    const names = await agent.fetch('/api/profile/names');
    assert.equal(names.body.limit, null, 'no ceiling, rendered as no ceiling');
    assert.equal(names.body.canReserve, true);

    for (const slug of ['launch-night', 'the-campaign', 'lustxr-official']) {
        const made = await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug }) });
        assert.equal(made.status, 201, `${slug}: ${JSON.stringify(made.body)}`);
    }

    // A reserved name, which everybody else is refused.
    const reserved = await agent.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'support' })
    });
    assert.equal(reserved.status, 201, JSON.stringify(reserved.body));

    assert.equal(channelSlugs.forUser(agent.id).length, 4);
    assert.equal(channelSlugs.forUser(agent.id).filter((n) => n.isPrimary).length, 1, 'exactly one canonical');

    // All four resolve, and all four say which one is canonical.
    for (const slug of ['launch-night', 'the-campaign', 'lustxr-official', 'support']) {
        const found = await agent.fetch(`/api/channels/${slug}`);
        assert.equal(found.status, 200, slug);
        assert.equal(found.body.canonical, 'launch-night', slug);
    }

    // Even a superuser does not get to break the shape rules.
    const shaped = await agent.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'not a name' })
    });
    assert.equal(shaped.status, 400);
    assert.equal(shaped.body.code, 'slug_shape');

    applySuperuser('');
});

test('only a superuser can reserve a name, and the built-in list is not editable', async () => {
    const mortal = makeAgent();
    await mortal.register('creator');

    assert.equal((await mortal.fetch('/api/superuser/reserved')).status, 403);
    assert.equal(
        (await mortal.fetch('/api/superuser/reserved', { method: 'POST', body: JSON.stringify({ slug: 'mine' }) }))
            .status,
        403
    );

    const boss = makeAgent();
    await boss.register('creator');
    applySuperuser(boss.email);
    await boss.signIn();

    const made = await boss.fetch('/api/superuser/reserved', {
        method: 'POST',
        body: JSON.stringify({ slug: 'winter-tour', reason: 'announced in March' })
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const listed = await boss.fetch('/api/superuser/reserved');
    const entry = listed.body.reserved.find((r) => r.slug === 'winter-tour');
    assert.equal(entry.reason, 'announced in March');
    assert.ok(entry.reservedBy, 'and who did it');

    // Now nobody else can take it.
    const refused = await mortal.fetch('/api/profile/names', {
        method: 'POST',
        body: JSON.stringify({ slug: 'winter-tour' })
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'slug_reserved');

    // Releasing a runtime reservation works; releasing a built-in one does not,
    // because a console that can release `api` can break the site from a text
    // field.
    assert.equal((await boss.fetch('/api/superuser/reserved/winter-tour', { method: 'DELETE' })).status, 204);
    assert.equal((await boss.fetch('/api/superuser/reserved/api', { method: 'DELETE' })).status, 404);
    assert.ok(RESERVED_SLUGS.has('api'), 'and it is still reserved');

    assert.equal(
        (await mortal.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'winter-tour' }) }))
            .status,
        201,
        'a released name is immediately claimable'
    );

    applySuperuser('');
});

/**
 * The status code on an address that was never real.
 *
 * The SPA answers unknown names with the catalogue, which is right: a mistyped
 * handle should land somewhere useful rather than on an error page. What was
 * wrong was doing it with a 200, because that made every string anybody could
 * invent a live page on this domain - `/<bank>/account/verify` included - and
 * that is the shape Safe Browsing reads as a host serving somebody else's
 * phishing kit. The body still boots; only the status tells the truth now.
 *
 * Skipped where there is no build to serve: the fallback is mounted only when
 * `dist/` exists, so without one there is no behaviour here to check.
 */
const HAS_DIST = fs.existsSync(path.join(import.meta.dirname, '..', 'dist', 'index.html'));

test('an address that was never real answers 404, and still boots', { skip: !HAS_DIST }, async () => {
    const agent = makeAgent();
    await agent.register('creator');
    assert.equal(
        (await agent.fetch('/api/profile/names', { method: 'POST', body: JSON.stringify({ slug: 'real-handle' }) }))
            .status,
        201
    );

    const status = async (p) => (await fetch(`${base}${p}`, { redirect: 'manual' })).status;

    // Addresses the site actually answers for.
    assert.equal(await status('/'), 200, 'the front page');
    assert.equal(await status('/creator'), 200, 'an app route');
    assert.equal(await status('/real-handle'), 200, 'a name somebody holds');

    // Everything else. A well-formed name nobody holds is as much a miss as a
    // path that could never have been a name at all - the first is the one the
    // old check got wrong, because it only ever looked at shape.
    assert.equal(await status('/no-such-handle'), 404, 'a name nobody holds');
    assert.equal(await status('/secure/paypal/login'), 404, 'multi-segment invention');
    assert.equal(await status('/update-your-billing-information'), 404, 'too long to be a name');
    assert.equal(await status('/api/does/not/exist'), 404, 'an API path that is not mounted');

    // The point of answering with `index.html` at all is that the page still
    // works, so a 404 that served an empty body would have missed it.
    const res = await fetch(`${base}/secure/paypal/login`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /browse-root/, 'the SPA still boots on a miss');
});
