import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Stream setup checks, and the picture they are about.
 *
 * The property under test is that a passed check corresponds to something that
 * happened. Until the preview existed, `POST /api/live/checks/standard` was a
 * button press with no broadcast anywhere near it, and the page told the
 * creator to "look at the monitor" while showing them no monitor - so the two
 * halves tested here are: the endpoint that finds their own outgoing picture,
 * and the refusals that stop a confirmation being recorded when there was
 * nothing to confirm.
 *
 * The one thing deliberately *not* asserted is whether the picture is correct.
 * A swapped stereo pair is a valid, well-formed, entirely wrong stream, and no
 * assertion here or anywhere else detects it - which is the whole reason the
 * check ends in a human pressing a button rather than in a probe.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-checks-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.AVR_LIVE = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { sessions } = await import('../server/live/sessions.js');
const { previewableSession } = await import('../server/live/readiness.js');
const { TRACK, FLAG } = await import('../src/live/protocol.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let accountSeq = 0;

function makeAgent() {
    return {
        token: null,
        id: null,

        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };
            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });
            const text = await res.text();

            let body = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }

            return { status: res.status, body };
        },

        async register(role = 'creator') {
            accountSeq += 1;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: `check${accountSeq}@example.test`,
                    password: 'correcthorsebattery',
                    displayName: `Person ${accountSeq}`,
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

        confirm(kind) {
            return this.fetch(`/api/live/checks/${kind}`, {
                method: 'POST',
                body: JSON.stringify({ confirmed: true })
            });
        }
    };
}

/**
 * A phone, as far as the registry is concerned.
 *
 * `creatorId: null` is the shared stream key: a real broadcast from a real
 * camera that the server cannot attribute to anybody.
 */
function broadcast({ creatorId = null, eyes = ['left'], stereo = 'mono', mode = 'separate' } = {}) {
    const session = sessions.create({ userId: creatorId, name: 'Test broadcast', mode, stereo });

    for (const eye of eyes) {
        const track = { left: TRACK.LEFT, right: TRACK.RIGHT, packed: TRACK.PACKED }[eye];
        session.setConfig(track, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
        session.publish(
            { track, payload: new Uint8Array(8), flags: FLAG.KEYFRAME, timestamp: 0 },
            new Uint8Array(0)
        );
    }

    return session;
}

/** Nothing else may be running, or the fallback rules are being tested twice. */
function clearSessions() {
    sessions.closeAll('test cleanup');
}

// The very first account on a fresh install becomes an admin, and an admin
// outranks a creator - so one is burned here rather than accidentally being
// the account a role test depends on.
await makeAgent().register('creator');

/* ------------------------------------------------------ which broadcast -- */

test('a creator is shown their own broadcast, and it is marked as theirs', () => {
    const mine = { live: true, creatorId: 'me', startedAt: 10 };
    const theirs = { live: true, creatorId: 'someone-else', startedAt: 20 };

    const found = previewableSession([theirs, mine], { creatorId: 'me', allowUnattributed: true });

    assert.equal(found.session, mine);
    assert.equal(found.attributed, true);
});

test("another creator's broadcast is never offered, even with nothing else running", () => {
    const theirs = { live: true, creatorId: 'someone-else', startedAt: 20 };

    assert.equal(previewableSession([theirs], { creatorId: 'me', allowUnattributed: true }), null);
});

test('on the shared stream key an unattributed broadcast is offered, and flagged as unproven', () => {
    const shared = { live: true, creatorId: null, startedAt: 5 };

    const found = previewableSession([shared], { creatorId: 'me', allowUnattributed: true });

    assert.equal(found.session, shared);
    assert.equal(found.attributed, false, 'the page has to be able to say it cannot prove whose camera this is');
});

test('under identity enforcement an unattributed broadcast is not offered at all', () => {
    const shared = { live: true, creatorId: null, startedAt: 5 };

    assert.equal(previewableSession([shared], { creatorId: 'me', allowUnattributed: false }), null);
});

test("somebody else's 1:1 is not offered as an unattributed broadcast", () => {
    const shared = { live: true, creatorId: null, startedAt: 5 };

    const found = previewableSession([shared], {
        creatorId: 'me',
        allowUnattributed: true,
        isPrivate: () => true
    });

    assert.equal(found, null);
});

test('the newest broadcast wins, and an ended one is not a broadcast', () => {
    const old = { live: true, creatorId: 'me', startedAt: 10 };
    const recent = { live: true, creatorId: 'me', startedAt: 30 };
    const ended = { live: false, creatorId: 'me', startedAt: 99 };

    assert.equal(previewableSession([old, ended, recent], { creatorId: 'me' }).session, recent);
});

/* --------------------------------------------------- two eyes, or claimed -- */

test('a stereo pair is counted from frames that arrived, not from what the phone announced', () => {
    clearSessions();

    const oneEye = broadcast({ stereo: 'sbs', eyes: ['left'] });
    assert.equal(
        oneEye.carryingStereo,
        false,
        'a rig whose second camera never started announces sbs and sends one eye - the exact failure the check exists for'
    );

    const pair = broadcast({ stereo: 'sbs', eyes: ['left', 'right'] });
    assert.equal(pair.carryingStereo, true);

    clearSessions();
});

test('a described eye that has sent nothing does not count', () => {
    clearSessions();

    const session = sessions.create({ userId: null, name: 'x', stereo: 'sbs' });
    session.setConfig(TRACK.LEFT, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
    session.setConfig(TRACK.RIGHT, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    assert.equal(session.carryingStereo, false);

    clearSessions();
});

test('a packed broadcast carries the pair in one track, and mono packed does not', () => {
    clearSessions();

    assert.equal(broadcast({ mode: 'packed', stereo: 'sbs', eyes: ['packed'] }).carryingStereo, true);
    assert.equal(broadcast({ mode: 'packed', stereo: 'mono', eyes: ['packed'] }).carryingStereo, false);

    clearSessions();
});

/* ------------------------------------------------------------- the route -- */

test('the preview is creator-only', async () => {
    const anon = makeAgent();
    assert.equal((await anon.fetch('/api/live/checks/preview')).status, 401);

    const viewer = makeAgent();
    await viewer.register('viewer');
    assert.equal((await viewer.fetch('/api/live/checks/preview')).status, 403);
});

test('with no camera connected the preview says so rather than 404ing', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');

    const { status, body } = await agent.fetch('/api/live/checks/preview');

    assert.equal(status, 200);
    assert.equal(body.preview, null);
    assert.equal(body.reason, 'no_broadcast');
    assert.ok(body.pollAfterMs > 0, 'and tells the page when to ask again');
});

test('the preview carries the session to open and whether two eyes are arriving', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');
    const session = broadcast({ creatorId: agent.id, stereo: 'sbs', eyes: ['left', 'right'] });

    const { body } = await agent.fetch('/api/live/checks/preview');

    assert.equal(body.preview.sessionId, session.id);
    assert.equal(body.preview.attributed, true);
    assert.equal(body.preview.carryingStereo, true);
    assert.equal(body.preview.relayPath, `/live/ws/${session.id}`);

    clearSessions();
});

/* ---------------------------------------------------- confirming anything -- */

test('a confirmation with nothing broadcasting is refused', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');

    const { status, body } = await agent.confirm('standard');

    assert.equal(status, 409);
    assert.equal(body.code, 'no_broadcast');
    assert.equal((await agent.fetch('/api/live/checks')).body.checks.standard, false, 'and nothing was recorded');
});

test('the standard check passes while a camera is connected', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');
    broadcast({ creatorId: agent.id });

    const { status, body } = await agent.confirm('standard');

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.checks.standard, true);

    clearSessions();
});

test('the 3D check is refused while only one eye is arriving', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');
    broadcast({ creatorId: agent.id, stereo: 'sbs', eyes: ['left'] });

    const { status, body } = await agent.confirm('spatial');

    assert.equal(status, 409);
    assert.equal(body.code, 'not_stereo');
    assert.equal((await agent.fetch('/api/live/checks')).body.checks.spatial, false);

    clearSessions();
});

test('the 3D check passes once both eyes are arriving', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');
    const session = broadcast({ creatorId: agent.id, stereo: 'sbs', eyes: ['left', 'right'] });

    const { status, body } = await agent.confirm('spatial');

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.checks.spatial, true);
    assert.equal(body.sessionId, session.id, 'the page is told which broadcast it just confirmed');

    clearSessions();
});

test('a creator cannot confirm against somebody else\'s broadcast', async () => {
    clearSessions();

    const broadcaster = makeAgent();
    await broadcaster.register('creator');
    broadcast({ creatorId: broadcaster.id, stereo: 'sbs', eyes: ['left', 'right'] });

    const bystander = makeAgent();
    await bystander.register('creator');

    assert.equal((await bystander.fetch('/api/live/checks/preview')).body.preview, null);
    assert.equal((await bystander.confirm('standard')).status, 409);

    clearSessions();
});

test('confirming still needs the word confirmed, and still only exists in two kinds', async () => {
    clearSessions();

    const agent = makeAgent();
    await agent.register('creator');
    broadcast({ creatorId: agent.id });

    assert.equal(
        (await agent.fetch('/api/live/checks/standard', { method: 'POST', body: JSON.stringify({}) })).status,
        400,
        'the refusals that do not depend on a broadcast come first'
    );
    assert.equal(
        (
            await agent.fetch('/api/live/checks/sideways', {
                method: 'POST',
                body: JSON.stringify({ confirmed: true })
            })
        ).status,
        404
    );

    clearSessions();
});
