import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end API tests against a real server on a scratch database.
 *
 * The point of these is the authorisation boundaries: most of what can go
 * wrong in a multi-tenant creator portal is one account reaching another
 * account's rows, and that is not something a unit test of a repository
 * function will catch.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-test-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
// The limiter keys on IP, and every request here comes from one; it gets its
// own focused test below instead of throttling all the others.
process.env.AVR_DISABLE_RATE_LIMIT = '1';

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

/** Minimal cookie-aware fetch, since sessions ride in an httpOnly cookie. */
function makeAgent() {
    const jar = new Map();

    return {
        token: null,
        async fetch(path, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${path}`, { ...options, headers, redirect: 'manual' });

            for (const raw of res.headers.getSetCookie?.() ?? []) {
                const [pair] = raw.split(';');
                const idx = pair.indexOf('=');
                jar.set(pair.slice(0, idx), pair.slice(idx + 1));
            }

            const text = await res.text();
            return { status: res.status, headers: res.headers, body: text ? safeJson(text) : null };
        },

        async register(email, role) {
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email,
                    password: 'correcthorsebattery',
                    displayName: 'Test User',
                    role,
                    tagline: role === 'creator' ? 'On air nightly' : '',
                    acceptedTerms: TERMS_VERSION,
                    acceptedCreatorTerms: CREATOR_TERMS_VERSION
                })
            });
            this.token = res.body?.accessToken ?? null;
            return res;
        }
    };
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/* -------------------------------------------------------------------- auth -- */

test('first registered account becomes admin', async () => {
    const agent = makeAgent();
    const res = await agent.register('first@example.com');

    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'admin');
});

test('subsequent accounts get the role they asked for', async () => {
    const viewer = makeAgent();
    const creator = makeAgent();

    assert.equal((await viewer.register('viewer@example.com')).body.user.role, 'viewer');
    assert.equal((await creator.register('creator@example.com', 'creator')).body.user.role, 'creator');
});

test('registration rejects weak input', async () => {
    const agent = makeAgent();

    const short = await agent.fetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: 'x@example.com', password: 'short', displayName: 'X' })
    });
    assert.equal(short.status, 400);

    const badEmail = await agent.fetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-email', password: 'correcthorsebattery', displayName: 'X' })
    });
    assert.equal(badEmail.status, 400);
});

test('duplicate email is rejected', async () => {
    const agent = makeAgent();
    const res = await agent.register('viewer@example.com');
    assert.equal(res.status, 409);
});

test('login is case-insensitive on email but not on password', async () => {
    const agent = makeAgent();

    const ok = await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'VIEWER@EXAMPLE.COM', password: 'correcthorsebattery' })
    });
    assert.equal(ok.status, 200);

    const wrongCase = await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'viewer@example.com', password: 'CORRECTHORSEBATTERY' })
    });
    assert.equal(wrongCase.status, 401);
});

test('the refresh token is httpOnly and scoped to the auth path', async () => {
    const agent = makeAgent();
    const res = await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'viewer@example.com', password: 'correcthorsebattery' })
    });

    const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('avr_refresh='));

    assert.ok(cookie, 'no refresh cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/api\/auth/i);
    assert.match(cookie, /SameSite=Lax/i);
});

test('refresh rotates the token and the old one stops working', async () => {
    const agent = makeAgent();
    await agent.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'viewer@example.com', password: 'correcthorsebattery' })
    });

    // Capture the current cookie, refresh once, then replay the captured value.
    const before = await agent.fetch('/api/auth/refresh', { method: 'POST' });
    assert.equal(before.status, 200);

    const stale = (before.headers.getSetCookie?.() ?? [])
        .find((c) => c.startsWith('avr_refresh='))
        ?.split(';')[0];

    await agent.fetch('/api/auth/refresh', { method: 'POST' });

    const replay = await fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: { Cookie: stale } });
    assert.equal(replay.status, 401, 'a rotated refresh token must not be reusable');
});

test('a garbage bearer token is treated as anonymous, not accepted', async () => {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not.a.jwt' } });
    assert.equal(res.status, 401);
});

test('an alg=none token is rejected', async () => {
    // Classic JWT confusion attack: unsigned token claiming admin.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
        JSON.stringify({ sub: 'anyone', role: 'admin', iss: 'projectavr', aud: 'projectavr', exp: 9e9 })
    ).toString('base64url');

    const res = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${header}.${payload}.` }
    });

    assert.equal(res.status, 401);
});

/* ----------------------------------------------------------------- creator -- */

test('viewers cannot reach creator routes', async () => {
    const viewer = makeAgent();
    await viewer.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'viewer@example.com', password: 'correcthorsebattery' })
    });
    viewer.token = (
        await viewer.fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'viewer@example.com', password: 'correcthorsebattery' })
        })
    ).body.accessToken;

    const res = await viewer.fetch('/api/creator/overview');
    assert.equal(res.status, 403);
});

test('anonymous requests to creator routes are 401, not 403', async () => {
    const res = await fetch(`${base}/api/creator/titles`);
    assert.equal(res.status, 401);
});

test('a creator can create and update their own title', async () => {
    const creator = makeAgent();
    creator.token = (
        await creator.fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'creator@example.com', password: 'correcthorsebattery' })
        })
    ).body.accessToken;

    const created = await creator.fetch('/api/creator/titles', {
        method: 'POST',
        body: JSON.stringify({ title: 'Reef Dive', projection: 'dome180', stereo: 'sbs' })
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.title.slug, 'reef-dive');
    assert.equal(created.body.title.status, 'draft');
    assert.equal(created.body.title.visibility, 'private');

    const updated = await creator.fetch(`/api/creator/titles/${created.body.title.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ synopsis: 'Down the wall.' })
    });

    assert.equal(updated.body.title.synopsis, 'Down the wall.');
    // A partial update must not blank fields it did not mention.
    assert.equal(updated.body.title.projection, 'dome180');
});

test('invalid metadata is rejected', async () => {
    const creator = makeAgent();
    creator.token = (
        await creator.fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'creator@example.com', password: 'correcthorsebattery' })
        })
    ).body.accessToken;

    const res = await creator.fetch('/api/creator/titles', {
        method: 'POST',
        body: JSON.stringify({ title: 'Bad', projection: 'hologram' })
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /projection/i);
});

test('one creator cannot read or modify another creator\'s title', async () => {
    const alice = makeAgent();
    await alice.register('alice@example.com', 'creator');

    const bob = makeAgent();
    await bob.register('bob@example.com', 'creator');

    const aliceTitle = (
        await alice.fetch('/api/creator/titles', {
            method: 'POST',
            body: JSON.stringify({ title: "Alice's Private Cut" })
        })
    ).body.title;

    // 404 rather than 403, so ids cannot be probed for existence.
    assert.equal((await bob.fetch(`/api/creator/titles/${aliceTitle.id}`)).status, 404);

    assert.equal(
        (
            await bob.fetch(`/api/creator/titles/${aliceTitle.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ title: 'Hijacked' })
            })
        ).status,
        404
    );

    assert.equal((await bob.fetch(`/api/creator/titles/${aliceTitle.id}`, { method: 'DELETE' })).status, 404);

    // And it really is untouched.
    assert.equal((await alice.fetch(`/api/creator/titles/${aliceTitle.id}`)).body.title.title, "Alice's Private Cut");
});

test('a title with no uploaded file cannot be published', async () => {
    const alice = makeAgent();
    alice.token = (
        await alice.fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'alice@example.com', password: 'correcthorsebattery' })
        })
    ).body.accessToken;

    const title = (
        await alice.fetch('/api/creator/titles', { method: 'POST', body: JSON.stringify({ title: 'Empty' }) })
    ).body.title;

    const res = await alice.fetch(`/api/creator/titles/${title.id}/publish`, { method: 'POST', body: '{}' });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /Upload a video/i);
});

test('slugs stay unique across creators', async () => {
    const bob = makeAgent();
    bob.token = (
        await bob.fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'bob@example.com', password: 'correcthorsebattery' })
        })
    ).body.accessToken;

    const res = await bob.fetch('/api/creator/titles', {
        method: 'POST',
        body: JSON.stringify({ title: 'Reef Dive' })
    });

    assert.equal(res.body.title.slug, 'reef-dive-2');
});

/* ----------------------------------------------------------------- catalog -- */

test('unpublished titles never appear in the public catalog', async () => {
    const res = await fetch(`${base}/api/catalog`);
    const { items } = await res.json();

    assert.equal(items.some((i) => i.id === 'reef-dive'), false);
    assert.equal(items.some((i) => i.title === "Alice's Private Cut"), false);
});

/**
 * Shared-cacheable only once the artwork in it is the same for everybody.
 *
 * It used to be unconditional, and that was right while every item carried
 * the same poster for every visitor. Now an unverified visitor's posters are
 * covered, so an `s-maxage` copy of their catalogue is one a proxy would hand
 * to a verified one and the other way round — see `coverOwnArtwork` in
 * `server/library.js`.
 */
test('a covered catalog is never shared-cacheable', async () => {
    const res = await fetch(`${base}/api/catalog`);
    const cacheControl = res.headers.get('cache-control') ?? '';

    assert.doesNotMatch(cacheControl, /s-maxage/);
    assert.match(cacheControl, /no-store/);
});

test('the catalog is cacheable once the visitor is through the gate', async () => {
    const agent = makeAgent();
    const geo = { 'x-geo-country': 'US', 'x-geo-region': 'OR' };

    const gate = await agent.fetch('/api/identity/gate', { headers: geo });
    await agent.fetch('/api/identity/gate/attest', {
        method: 'POST',
        headers: geo,
        body: JSON.stringify({
            confirmed: true,
            version: gate.body?.jurisdiction?.attestation?.version
        })
    });

    const res = await agent.fetch('/api/catalog', { headers: geo });
    assert.match(res.headers.get('cache-control') ?? '', /s-maxage/);
});

/* ---------------------------------------------------------------- security -- */

test('storage keys cannot traverse out of the media root', async () => {
    // Percent-encoded, because fetch() resolves a literal `../` in the client
    // before the request is ever sent - only the encoded form reaches Express.
    const attempts = [
        '..%2f..%2f..%2fetc%2fpasswd',
        '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        'hls%2f..%2f..%2f..%2fetc%2fpasswd',
        '..%5c..%5cwindows%5cwin.ini'
    ];

    for (const attempt of attempts) {
        const res = await fetch(`${base}/stream/${attempt}`, { redirect: 'manual' });
        const body = await res.text();

        assert.equal(res.status, 400, `traversal not rejected: ${attempt} -> ${res.status}`);
        assert.ok(!/root:.*:0:0/.test(body), `traversal leaked file content: ${attempt}`);
    }
});

test('the auth rate limiter throttles a burst of logins', async () => {
    // The kill switch is read when the middleware is constructed, so clear it
    // just long enough to build a real limiter.
    const { rateLimit } = await import('../server/auth/middleware.js');

    delete process.env.AVR_DISABLE_RATE_LIMIT;
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    process.env.AVR_DISABLE_RATE_LIMIT = '1';

    const call = () => {
        let status = 200;
        const req = { ip: '198.51.100.7', socket: {} };
        const res = {
            set() { return this; },
            status(code) { status = code; return this; },
            json() { return this; }
        };
        let passed = false;
        limiter(req, res, () => { passed = true; });
        return { passed, status };
    };

    assert.equal(call().passed, true);
    assert.equal(call().passed, true);
    assert.equal(call().passed, true);

    const blocked = call();
    assert.equal(blocked.passed, false, 'fourth request should be throttled');
    assert.equal(blocked.status, 429);
});

test('an unknown feed token does not authorise a feed', async () => {
    const res = await fetch(`${base}/deovr/u/definitely-not-a-real-token`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).authorized, '0');
});

test('error responses do not leak internals', async () => {
    const res = await fetch(`${base}/api/creator/titles/../../etc`, { headers: { Authorization: 'Bearer x' } });
    const text = await res.text();

    assert.ok(!/\/Users\//.test(text), 'response leaked a filesystem path');
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(text), 'response leaked a stack trace');
});
