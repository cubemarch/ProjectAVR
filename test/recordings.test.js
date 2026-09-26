import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

/**
 * Recording a 1:1, and selling the result.
 *
 * Two halves, and they test different kinds of thing.
 *
 * The first is the marketplace, which is accounting: a sale moves credits out
 * of one account and into another, exactly once however many times the button
 * is pressed, and the file is delivered to the people who paid and refused to
 * everybody else. Those properties only ever fail in production, so they are
 * asserted against the running HTTP surface rather than against the functions
 * behind it.
 *
 * The second is the recorder, which is a real FFmpeg fed real frames. It is
 * skipped where FFmpeg is absent, and it checks the one thing unit tests
 * cannot: that the file exists, is playable, and has the duration and the
 * shape it claims. The tag on a listing is a promise about pixels, and a test
 * that only read the database would let that promise rot.
 *
 * What is deliberately not tested here is the viewer's recording, because
 * there is nothing on this server to test. It is made by `MediaRecorder` in
 * their browser and never arrives. What is tested is the consent record that
 * governs it.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-recordings-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_RECORDING_DIR = path.join(TMP, 'scratch');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.AVR_LIVE = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';
process.env.AVR_PAYMENTS_PROVIDER = 'stub';

const execFileAsync = promisify(execFile);

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { credits, recordings, recordingSales, creatorSettings } = await import('../server/db/index.js');
const { getStorage } = await import('../server/storage/index.js');
const { sessions } = await import('../server/live/sessions.js');
const { rooms } = await import('../server/live/rooms.js');
const { recorders, viewerConsent, RecordingPipeline } = await import('../server/live/recording.js');
const { LiveSession } = await import('../server/live/sessions.js');
const { probe, recordArgs } = await import('../server/transcode/ffmpeg.js');
const { FRAME_TYPE, FLAG, TRACK, encodeFrame } = await import('../src/live/protocol.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
    await recorders.stopAll('tests over');
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let accountSeq = 0;

function makeAgent() {
    return {
        token: null,
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

            return { status: res.status, body, headers: res.headers };
        },

        async register(role = 'viewer') {
            accountSeq += 1;
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: `rec${accountSeq}@example.test`,
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

        fund(amount) {
            credits.post({ userId: this.id, delta: amount, reason: 'purchase' });
            return this;
        }
    };
}

async function creator() {
    const agent = makeAgent();
    await agent.register('creator');
    return agent;
}

async function viewer(funded = 0) {
    const agent = makeAgent();
    await agent.register('viewer');
    if (funded) agent.fund(funded);
    return agent;
}

/**
 * A finished recording, without going near FFmpeg.
 *
 * The marketplace does not care how the bytes got there, and making every
 * pricing test spawn an encoder would turn a 200 ms file into a 90 second one.
 */
async function finishedRecording(creatorId, { stereo = 'mono', bytes = 'not really an mp4' } = {}) {
    const row = recordings.start({ creatorId, roomId: 'room-test', sessionId: 'SESSION', stereo });
    const key = `recording/${creatorId}/${row.id}/file.mp4`;

    await getStorage().putStream(key, Readable.from([Buffer.from(bytes)]));

    return recordings.finish(row.id, {
        storageKey: key,
        durationMs: 61_000,
        sizeBytes: Buffer.byteLength(bytes),
        stereo
    });
}

/** A live broadcast that has already gone private to one viewer. */
function privateTurn(creatorId, userId, { stereo = false } = {}) {
    const session = sessions.create({
        userId: creatorId,
        name: 'Test broadcast',
        mode: 'separate',
        stereo: stereo ? 'sbs' : 'mono'
    });

    const eye = (track) => {
        session.setConfig(track, { codec: 'avc1.640028', codedWidth: 320, codedHeight: 180 });
        session.publish(
            { track, payload: new Uint8Array(8), flags: FLAG.KEYFRAME, timestamp: 0 },
            new Uint8Array(0)
        );
    };

    eye(TRACK.LEFT);
    if (stereo) eye(TRACK.RIGHT);

    const room = rooms.takeOver(session, { creatorId, userId });
    return { session, room };
}

/* --------------------------------------------------------------- listing -- */

test('a recording that is not ready cannot be listed', async () => {
    const agent = await creator();
    const row = recordings.start({ creatorId: agent.id, sessionId: 'S' });

    const res = await agent.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 200 })
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'recording_not_ready');
});

test('a listing needs a title and a whole number of credits', async () => {
    const agent = await creator();
    const row = await finishedRecording(agent.id);

    const list = (body) => agent.fetch(`/api/recordings/${row.id}/list`, { method: 'POST', body: JSON.stringify(body) });

    assert.equal((await list({ title: 'hi', price: 100 })).status, 400);
    assert.equal((await list({ title: 'An evening', price: 0 })).status, 400);
    assert.equal((await list({ title: 'An evening', price: 12.5 })).status, 400);
    assert.equal((await list({ title: 'An evening', price: -5 })).status, 400);

    const ok = await list({ title: 'An evening', price: 250 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.recording.price, 250);
    assert.equal(ok.body.recording.listed, true);
});

test('somebody else cannot list, unlist or see your recordings', async () => {
    const mine = await creator();
    const theirs = await creator();
    const row = await finishedRecording(mine.id);

    const listed = await theirs.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Not mine', price: 100 })
    });
    assert.equal(listed.status, 404, 'a recording belonging to someone else is not found, not forbidden');

    const unlisted = await theirs.fetch(`/api/recordings/${row.id}/unlist`, { method: 'POST', body: '{}' });
    assert.equal(unlisted.status, 404);

    const list = await theirs.fetch('/api/recordings/mine');
    assert.equal(list.body.recordings.some((r) => r.id === row.id), false);
});

/* ------------------------------------------------------------ the 2D/3D tag -- */

test('the tag comes from what was captured, and filters on it', async () => {
    const agent = await creator();

    const flat = await finishedRecording(agent.id, { stereo: 'mono' });
    const deep = await finishedRecording(agent.id, { stereo: 'sbs' });

    for (const row of [flat, deep]) {
        await agent.fetch(`/api/recordings/${row.id}/list`, {
            method: 'POST',
            body: JSON.stringify({ title: `Evening ${row.id.slice(0, 6)}`, price: 100 })
        });
    }

    const buyer = await viewer();

    const all = await buyer.fetch('/api/recordings/market');
    const byId = new Map(all.body.recordings.map((r) => [r.id, r]));
    assert.equal(byId.get(flat.id).tag, '2d');
    assert.equal(byId.get(deep.id).tag, '3d');

    const only3d = await buyer.fetch('/api/recordings/market?tag=3d');
    const ids = only3d.body.recordings.map((r) => r.id);
    assert.ok(ids.includes(deep.id));
    assert.ok(!ids.includes(flat.id), 'a 2D file appeared under a 3D filter');

    const only2d = await buyer.fetch('/api/recordings/market?tag=2d');
    assert.ok(only2d.body.recordings.map((r) => r.id).includes(flat.id));
});

test('a listing never carries the storage key', async () => {
    const agent = await creator();
    const row = await finishedRecording(agent.id);
    await agent.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 100 })
    });

    const buyer = await viewer();
    const market = await buyer.fetch('/api/recordings/market');

    // The key is the only thing standing between `/stream/*` and the file, so
    // it must not be in a response anybody can ask for.
    assert.ok(!JSON.stringify(market.body).includes(row.storage_key));
    assert.ok(!JSON.stringify((await agent.fetch('/api/recordings/mine')).body).includes(row.storage_key));
});

/* ---------------------------------------------------------------- buying -- */

test('buying moves the price from one account to the other', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 300 })
    });

    const buyer = await viewer(1000);
    const earnedBefore = credits.account(seller.id).earned;

    const bought = await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });

    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    assert.equal(bought.body.sale.price, 300);
    assert.equal(bought.body.balance, 700);
    assert.equal(credits.balance(seller.id), 300);
    assert.equal(credits.account(seller.id).earned - earnedBefore, 300);

    // Both halves of the transfer point at the sale, which is what makes a
    // statement line say what it was for.
    const [entry] = credits.history(buyer.id);
    assert.equal(entry.ref_type, 'recording_sale');
    assert.equal(entry.ref_id, bought.body.sale.id);
    assert.equal(entry.reason, 'recording_purchase');
});

test('pressing buy twice buys it once', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 400 })
    });

    const buyer = await viewer(1000);

    const first = await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });
    const second = await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });

    assert.equal(first.body.sale.applied, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.sale.applied, false, 'the second press reported a fresh sale');
    assert.equal(second.body.sale.id, first.body.sale.id);

    assert.equal(credits.balance(buyer.id), 600, 'charged twice');
    assert.equal(recordingSales.forRecording(row.id).length, 1);
});

test('a buyer who cannot pay is told so and owes nothing', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 900 })
    });

    const buyer = await viewer(100);
    const res = await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });

    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'insufficient_credits');
    assert.equal(credits.balance(buyer.id), 100);

    // And no half-written entitlement was left behind by the refusal.
    assert.equal(recordingSales.byPair(row.id, buyer.id), null);
    assert.equal(recordingSales.forRecording(row.id).length, 0);
});

test('the price charged is the listed one, not one the buyer posted', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 500 })
    });

    const buyer = await viewer(1000);
    const res = await buyer.fetch(`/api/recordings/${row.id}/buy`, {
        method: 'POST',
        body: JSON.stringify({ price: 1 })
    });

    assert.equal(res.body.sale.price, 500);
    assert.equal(credits.balance(buyer.id), 500);
});

test('an unlisted recording cannot be bought, and a creator cannot buy their own', async () => {
    const seller = await creator();
    seller.fund(1000);

    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 100 })
    });

    const own = await seller.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });
    assert.equal(own.status, 409);
    assert.equal(own.body.error, 'your_own_recording');

    await seller.fetch(`/api/recordings/${row.id}/unlist`, { method: 'POST', body: '{}' });

    const buyer = await viewer(1000);
    const gone = await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });
    assert.equal(gone.status, 404);
});

/* ------------------------------------------------------------- delivery -- */

test('the file goes to the buyer and the creator, and to nobody else', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id, { bytes: 'pretend this is an mp4' });
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 100 })
    });

    const stranger = await viewer(1000);
    const refused = await stranger.fetch(`/api/recordings/${row.id}/file`);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.error, 'not_purchased');

    await stranger.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });

    const bought = await stranger.fetch(`/api/recordings/${row.id}/file`);
    assert.equal(bought.status, 200);
    assert.equal(bought.body, 'pretend this is an mp4');

    const own = await seller.fetch(`/api/recordings/${row.id}/file`);
    assert.equal(own.status, 200, 'a creator cannot reach their own recording');

    const anonymous = await fetch(`${base}/api/recordings/${row.id}/file`, { redirect: 'manual' });
    assert.equal(anonymous.status, 401);
});

test('unlisting does not take back what somebody bought', async () => {
    const seller = await creator();
    const row = await finishedRecording(seller.id);
    await seller.fetch(`/api/recordings/${row.id}/list`, {
        method: 'POST',
        body: JSON.stringify({ title: 'An evening', price: 100 })
    });

    const buyer = await viewer(1000);
    await buyer.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });

    await seller.fetch(`/api/recordings/${row.id}/unlist`, { method: 'POST', body: '{}' });

    assert.equal((await buyer.fetch(`/api/recordings/${row.id}/file`)).status, 200);

    const shelf = await buyer.fetch('/api/recordings/purchased');
    assert.equal(shelf.body.recordings.some((r) => r.id === row.id), true);

    const market = await buyer.fetch('/api/recordings/market');
    assert.equal(market.body.recordings.some((r) => r.id === row.id), false);
});

/* --------------------------------------------------- the viewer's consent -- */

test('recording is a property of a 1:1 and of nothing else', async () => {
    const agent = await creator();
    const session = sessions.create({ userId: agent.id, name: 'Public', mode: 'separate', stereo: 'mono' });

    const res = await agent.fetch(`/api/live/watch/${session.id}/recording`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'not_private');

    session.close('test over');
});

test('a stranger cannot see or steer a recording in somebody else’s room', async () => {
    const owner = await creator();
    const guest = await viewer();
    const outsider = await viewer();

    const { session } = privateTurn(owner.id, guest.id);

    const peek = await outsider.fetch(`/api/live/watch/${session.id}/recording`);
    assert.equal(peek.status, 403);

    const start = await outsider.fetch(`/api/live/watch/${session.id}/recording/start`, {
        method: 'POST',
        body: '{}'
    });
    assert.equal(start.status, 403, 'a viewer started a recording on a broadcast they are not in');

    session.close('test over');
});

test('the default is to ask, and the creator answers', async () => {
    const owner = await creator();
    const guest = await viewer();
    const { session } = privateTurn(owner.id, guest.id);

    const before = await guest.fetch(`/api/live/watch/${session.id}/recording`);
    assert.equal(before.body.viewer.policy, 'ask', 'silence is not consent');
    assert.equal(before.body.viewer.allowed, false);

    const asked = await guest.fetch(`/api/live/watch/${session.id}/recording/consent`, {
        method: 'POST',
        body: '{}'
    });
    assert.equal(asked.body.viewer.state, 'asked');

    const creatorSees = await owner.fetch(`/api/live/watch/${session.id}/recording`);
    assert.equal(creatorSees.body.asked.userId, guest.id);

    await owner.fetch(`/api/live/watch/${session.id}/recording/consent/answer`, {
        method: 'POST',
        body: JSON.stringify({ allow: true })
    });

    const after = await guest.fetch(`/api/live/watch/${session.id}/recording`);
    assert.equal(after.body.viewer.allowed, true);
    assert.equal(after.body.viewer.state, 'granted');

    viewerConsent.clear(session.id);
    session.close('test over');
});

test('never means the question is not put, and always means it is not asked', async () => {
    const owner = await creator();
    const guest = await viewer();

    creatorSettings.update(owner.id, { recordingPolicy: 'never' });
    const refused = privateTurn(owner.id, guest.id);

    const asked = await guest.fetch(`/api/live/watch/${refused.session.id}/recording/consent`, {
        method: 'POST',
        body: '{}'
    });
    assert.equal(asked.status, 403);
    assert.equal(asked.body.error, 'recording_not_permitted');
    refused.session.close('test over');

    creatorSettings.update(owner.id, { recordingPolicy: 'always' });
    const allowed = privateTurn(owner.id, guest.id);

    const state = await guest.fetch(`/api/live/watch/${allowed.session.id}/recording`);
    assert.equal(state.body.viewer.allowed, true);
    assert.equal(state.body.viewer.state, 'granted');

    // Nothing was put to the creator, because nothing needed to be.
    const creatorSees = await owner.fetch(`/api/live/watch/${allowed.session.id}/recording`);
    assert.equal(creatorSees.body.asked, null);

    allowed.session.close('test over');
});

test('consent does not survive the turn it was given in', async () => {
    const owner = await creator();
    const guest = await viewer();
    const first = privateTurn(owner.id, guest.id);

    await guest.fetch(`/api/live/watch/${first.session.id}/recording/consent`, { method: 'POST', body: '{}' });
    await owner.fetch(`/api/live/watch/${first.session.id}/recording/consent/answer`, {
        method: 'POST',
        body: JSON.stringify({ allow: true })
    });

    const ended = await owner.fetch(`/api/live/watch/${first.session.id}/private/end`, {
        method: 'POST',
        body: '{}'
    });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));

    // A second conversation is a second agreement. Being recorded once is not
    // being recorded from now on.
    const second = privateTurn(owner.id, guest.id);
    const state = await guest.fetch(`/api/live/watch/${second.session.id}/recording`);
    assert.equal(state.body.viewer.allowed, false);

    first.session.close('test over');
    second.session.close('test over');
});

/* ------------------------------------------------------- the argument vector -- */

test('a recording is one file, not a ladder', () => {
    const args = recordArgs({ outputFile: '/tmp/x.mp4', stereo: true }).join(' ');

    assert.match(args, /-i pipe:3/);
    assert.match(args, /-i pipe:4/);
    assert.match(args, /hstack=inputs=2/);
    assert.match(args, /-f mp4/);
    assert.match(args, /\/tmp\/x\.mp4/);

    assert.doesNotMatch(args, /-f hls/, 'a recording is not a delivery format');
    assert.doesNotMatch(args, /var_stream_map/);

    // Without this the index is written last and a browser cannot start
    // playing a purchased file until the whole thing has downloaded.
    assert.match(args, /-movflags \+faststart/);
});

test('sound is taken as it arrives rather than re-encoded', () => {
    const args = recordArgs({ outputFile: '/tmp/x.mp4', stereo: false, audio: true }).join(' ');

    assert.match(args, /-f aac -i pipe:5/);
    assert.match(args, /-c:a copy/);

    assert.doesNotMatch(recordArgs({ outputFile: '/tmp/x.mp4' }).join(' '), /pipe:5/);
});

/* --------------------------------------------------------------- end to end -- */

const ffmpeg = await probe();

test(
    'a private turn is recorded into a playable file, stored, and listable',
    { skip: ffmpeg.available ? false : `ffmpeg unavailable: ${ffmpeg.error}`, timeout: 90_000 },
    async (t) => {
        await recorders.probeFfmpeg();

        const seller = await creator();
        const guest = await viewer(1000);

        const clip = await sourceClip(TMP, 'source', 'testsrc2');

        const session = new LiveSession({
            name: 'recording test',
            mode: 'single',
            projection: 'flat',
            stereo: 'mono'
        });
        session.creatorId = seller.id;

        const started = await recorders.start({ session, creatorId: seller.id, roomId: 'room-e2e' });
        assert.equal(started.ok, true, JSON.stringify(started));
        t.after(() => recorders.stop(session.id, 'test over'));

        session.setConfig(TRACK.LEFT, { codec: 'avc1.42C015', codedWidth: 320, codedHeight: 180 });

        await waitFor(() => recorders.stateFor(session.id).state === 'running', 10_000, 'ffmpeg to start');

        await feed(session, clip);

        const stopped = await recorders.stop(session.id, 'test over');
        assert.equal(stopped.ok, true, JSON.stringify(stopped));

        const row = stopped.recording;
        assert.equal(row.status, 'ready');
        assert.equal(row.stereo, 'mono', 'one eye arrived, so the file is 2D whatever was configured');
        assert.ok(row.size_bytes > 1024, `the file is ${row.size_bytes} bytes`);
        assert.ok(row.duration_ms > 0);

        // The scratch file is gone and the bytes are in storage under a key.
        const scratch = path.join(process.env.AVR_RECORDING_DIR, `${row.id}.mp4`);
        assert.equal(fs.existsSync(scratch), false, 'the working file was left behind');

        const stored = getStorage().localPath(row.storage_key);
        assert.ok(fs.existsSync(stored));

        // Playable, and actually containing the picture that was fed in.
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0',
            stored
        ]);
        const [width, height] = stdout.trim().split(',').map(Number);
        assert.equal(width, 320);
        assert.equal(height, 180);

        // The index is at the front, which is what makes a purchased file
        // start playing before it has finished downloading.
        const head = await fsp.readFile(stored, { encoding: 'latin1', flag: 'r' });
        assert.ok(head.indexOf('moov') < head.indexOf('mdat'), 'faststart did not move the index');

        // And it reaches the marketplace, tagged by what was captured.
        const listed = await seller.fetch(`/api/recordings/${row.id}/list`, {
            method: 'POST',
            body: JSON.stringify({ title: 'A recorded evening', price: 150 })
        });
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        assert.equal(listed.body.recording.tag, '2d');

        await guest.fetch(`/api/recordings/${row.id}/buy`, { method: 'POST', body: '{}' });
        const file = await fetch(`${base}/api/recordings/${row.id}/file`, {
            headers: { Authorization: `Bearer ${guest.token}` }
        });
        assert.equal(file.status, 200);
        assert.equal(Number(file.headers.get('content-length')), row.size_bytes);

        session.close('test over');
    }
);

test(
    'a recorder that loses FFmpeg fails the recording rather than truncating it',
    { skip: ffmpeg.available ? false : `ffmpeg unavailable: ${ffmpeg.error}`, timeout: 30_000 },
    async () => {
        const session = new LiveSession({ name: 'restart test', mode: 'single', stereo: 'mono' });
        const filePath = path.join(TMP, 'abandoned.mp4');

        const pipeline = new RecordingPipeline({ session, filePath });
        const stops = [];
        pipeline.on('stopped', (reason) => stops.push(reason));

        pipeline.attach();
        session.setConfig(TRACK.LEFT, { codec: 'avc1.42C015', codedWidth: 320, codedHeight: 180 });

        await waitFor(() => pipeline.state === 'running', 10_000, 'ffmpeg to start');

        // Killed outright, which is what a crashed or OOM-killed encoder looks
        // like from here. The parent pipeline would respawn, and for a single
        // output file opened with `-y` that means losing everything recorded
        // so far - a partial loss turned into a total one.
        pipeline._process.kill('SIGKILL');

        await waitFor(() => pipeline.state === 'stopped', 10_000, 'the recorder to give up');

        assert.equal(pipeline.restarts, 0, 'the recorder restarted FFmpeg over its own output');
        assert.equal(stops.length, 1);
        assert.match(pipeline.error, /ffmpeg exited/);

        await fsp.rm(filePath, { force: true });
        session.close('test over');
    }
);

/* ----------------------------------------------------------------- helpers -- */

async function sourceClip(dir, name, pattern) {
    const file = path.join(dir, `${name}.h264`);

    await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `${pattern}=size=320x180:rate=30:duration=2`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0',
        '-f', 'h264', file
    ]);

    return accessUnits(await fsp.readFile(file));
}

/** Split an Annex B stream into access units, one picture each. */
function accessUnits(buffer) {
    const boundaries = [];

    for (let i = 0; i + 3 < buffer.length; i += 1) {
        if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;

        if (buffer[i + 2] === 1) boundaries.push({ at: i, header: 3 });
        else if (buffer[i + 2] === 0 && buffer[i + 3] === 1) boundaries.push({ at: i, header: 4 });
    }

    const units = [];
    let start = 0;
    let sawVcl = false;
    let keyframe = false;

    for (let n = 0; n < boundaries.length; n += 1) {
        const { at, header } = boundaries[n];
        const type = buffer[at + header] & 0x1f;
        const isVcl = type >= 1 && type <= 5;

        if (isVcl && sawVcl) {
            units.push({ payload: buffer.subarray(start, at), keyframe });
            start = at;
            sawVcl = false;
            keyframe = false;
        }

        if (isVcl) sawVcl = true;
        if (type === 5) keyframe = true;
    }

    if (sawVcl) units.push({ payload: buffer.subarray(start), keyframe });

    return units;
}

/** Publish one eye through the session at roughly 30 fps. */
async function feed(session, units) {
    for (let i = 0; i < units.length; i += 1) {
        const au = units[i];
        const flags = au.keyframe ? FLAG.KEYFRAME : 0;
        const timestamp = i * 33_333;

        const raw = encodeFrame({
            type: FRAME_TYPE.VIDEO,
            track: TRACK.LEFT,
            flags,
            timestamp,
            sequence: i,
            payload: au.payload
        });

        session.publish({ type: FRAME_TYPE.VIDEO, track: TRACK.LEFT, flags, timestamp, payload: au.payload }, raw);
        await sleep(33);
    }
}

async function waitFor(condition, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(100);
    }

    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
