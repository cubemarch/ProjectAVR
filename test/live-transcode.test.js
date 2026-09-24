import test from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ladder, buildArgs, probe } from '../server/transcode/ffmpeg.js';
import { ADTS_HEADER_BYTES, SAMPLE_RATES, adtsHeader, sampleRateIndex, wrapAdts } from '../server/transcode/adts.js';
import { StereoAligner } from '../server/transcode/aligner.js';
import { TranscodePipeline } from '../server/transcode/pipeline.js';
import { LiveSession } from '../server/live/sessions.js';
import { FRAME_TYPE, FLAG, TRACK, encodeFrame } from '../src/live/protocol.js';

const execFileAsync = promisify(execFile);

/**
 * The transcode tier is the part destined for AWS, so these tests are written
 * against the FFmpeg contract rather than against our wrapper: the argument
 * vector, the shape of the output tree, and - in the end-to-end case - the
 * actual pixels, checked by measuring that the two halves of the composited
 * frame are different images. That last one exists because every other check
 * here would pass just as happily if both eyes were the left camera.
 */

/* ------------------------------------------------------------- the ladder -- */

test('the default ladder is ordered tallest first', () => {
    const rungs = ladder(undefined);

    assert.ok(rungs.length >= 1);
    for (let i = 1; i < rungs.length; i += 1) {
        assert.ok(rungs[i - 1].height > rungs[i].height);
    }
});

test('a ladder spec is parsed, and a broken one falls back rather than throwing', () => {
    const rungs = ladder('720p@6M,1080p@12M,540@3.5M');

    assert.deepEqual(
        rungs.map((r) => r.height),
        [1080, 720, 540],
        'sorted tallest first regardless of input order'
    );
    assert.equal(rungs[0].bitrate, 12_000_000);
    assert.equal(rungs[2].bitrate, 3_500_000);

    // A typo in an environment variable must not take the server down.
    assert.deepEqual(ladder('nonsense'), ladder(undefined));
    assert.deepEqual(ladder(''), ladder(undefined));
});

/* -------------------------------------------------------------- arguments -- */

test('stereo input uses two pipes, mono uses one', () => {
    const base = { outputDir: '/tmp/x', rungs: [{ name: '540p', height: 540, bitrate: 1e6 }] };

    const stereo = buildArgs({ ...base, stereo: true }).join(' ');
    assert.match(stereo, /-i pipe:3/);
    assert.match(stereo, /-i pipe:4/);
    assert.match(stereo, /hstack=inputs=2/);

    const mono = buildArgs({ ...base, stereo: false }).join(' ');
    assert.match(mono, /-i pipe:3/);
    assert.doesNotMatch(mono, /pipe:4/);
    assert.doesNotMatch(mono, /hstack/);
});

test('timestamps come from the wallclock, not from an assumed frame rate', () => {
    // If this ever regresses to letting FFmpeg synthesise timestamps, a single
    // frame dropped on one eye offsets that eye for the rest of the broadcast.
    const args = buildArgs({ outputDir: '/tmp/x' }).join(' ');

    assert.match(args, /-use_wallclock_as_timestamps 1/);
    assert.match(args, /fps=30/, 'and the fps filter fills the resulting gaps');
});

test('the side-by-side frame is twice the per-eye width', () => {
    const args = buildArgs({
        stereo: true,
        sourceWidth: 1920,
        sourceHeight: 1080,
        outputDir: '/tmp/x',
        rungs: [{ name: '1080p', height: 1080, bitrate: 1e7 }]
    }).join(' ');

    assert.match(args, /scale=3840:1080/);

    const mono = buildArgs({
        stereo: false,
        sourceWidth: 1920,
        sourceHeight: 1080,
        outputDir: '/tmp/x',
        rungs: [{ name: '1080p', height: 1080, bitrate: 1e7 }]
    }).join(' ');

    assert.match(mono, /scale=1920:1080/);
});

test('scaled dimensions are always even', () => {
    // 4:2:0 chroma is subsampled by two in each direction, so an odd dimension
    // is rejected outright by the encoder.
    const args = buildArgs({
        sourceWidth: 1919,
        sourceHeight: 1079,
        outputDir: '/tmp/x',
        rungs: [{ name: '541p', height: 541, bitrate: 1e6 }]
    }).join(' ');

    const [, width, height] = /scale=(\d+):(\d+)/.exec(args);
    assert.equal(Number(width) % 2, 0);
    assert.equal(Number(height) % 2, 0);
});

test('every segment starts with a keyframe', () => {
    // Otherwise a player cannot switch rendition without a visible glitch.
    const args = buildArgs({
        frameRate: 30,
        segmentSeconds: 2,
        outputDir: '/tmp/x',
        rungs: [{ name: '540p', height: 540, bitrate: 1e6 }]
    }).join(' ');

    assert.match(args, /-g:v:0 60/);
    assert.match(args, /-keyint_min:v:0 60/);
    assert.match(args, /-sc_threshold:v:0 0/, 'scene cuts must not insert keyframes elsewhere');
});

test('the variant map uses a colon for name, which is the syntax ffmpeg accepts', () => {
    // `name=540p` is silently different and fails at header-write time with
    // "Invalid keyval", which is a long way from where the mistake was made.
    const args = buildArgs({
        outputDir: '/tmp/x',
        rungs: [
            { name: '1080p', height: 1080, bitrate: 1e7 },
            { name: '540p', height: 540, bitrate: 1e6 }
        ]
    });

    const map = args[args.indexOf('-var_stream_map') + 1];
    assert.equal(map, 'v:0,name:1080p v:1,name:540p');
});

test('playlists are short-lived and segments are cleaned up', () => {
    const args = buildArgs({ outputDir: '/tmp/x' }).join(' ');

    assert.match(args, /delete_segments/, 'a long broadcast must not fill the disk');
    assert.match(args, /temp_file/, 'a player must not read a half-written segment');
});

test('sound is a third pipe, copied onto every rung', () => {
    const rungs = [
        { name: '1080p', height: 1080, bitrate: 1e7 },
        { name: '540p', height: 540, bitrate: 1e6 }
    ];

    const args = buildArgs({ outputDir: '/tmp/x', stereo: true, rungs, audio: true });
    const joined = args.join(' ');

    assert.match(joined, /-f aac -i pipe:5/, 'ADTS on its own pipe, after both eyes');

    // Input 2, because the eyes are inputs 0 and 1. Getting this wrong maps a
    // video stream into the audio slot and FFmpeg fails at header-write time.
    assert.match(joined, /-map 2:a:0 -c:a:0 copy/);
    assert.match(joined, /-map 2:a:0 -c:a:1 copy/);
    assert.doesNotMatch(joined, /-c:a:\d aac/, 're-encoding costs CPU and gives back generation loss');

    const map = args[args.indexOf('-var_stream_map') + 1];
    assert.equal(map, 'v:0,a:0,name:1080p v:1,a:1,name:540p');
});

test('a mono broadcast with sound reads it from input 1', () => {
    const args = buildArgs({
        outputDir: '/tmp/x',
        stereo: false,
        rungs: [{ name: '540p', height: 540, bitrate: 1e6 }],
        audio: true
    }).join(' ');

    assert.match(args, /-map 1:a:0 -c:a:0 copy/);
});

test('a silent broadcast declares no audio anywhere', () => {
    // Mapping an audio stream that will never carry a packet leaves the HLS
    // muxer waiting on it, and the playlist never gets written.
    const args = buildArgs({
        outputDir: '/tmp/x',
        rungs: [{ name: '540p', height: 540, bitrate: 1e6 }]
    });
    const joined = args.join(' ');

    assert.doesNotMatch(joined, /pipe:5/);
    assert.doesNotMatch(joined, /:a:/);
    assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0,name:540p');
});

/* ------------------------------------------------------------------ adts -- */

test('an ADTS header describes 48 kHz stereo exactly', () => {
    // Byte-for-byte, because every field in here is wrong in a way that is
    // inaudible until it is not: the wrong rate index plays at half speed, the
    // wrong length makes the demuxer lose frame sync.
    const header = adtsHeader({ payloadLength: 100, sampleRate: 48000, channels: 2 });

    assert.equal(header.length, ADTS_HEADER_BYTES);
    assert.equal(header.toString('hex'), 'fff14c800d7ffc');
});

test('an ADTS header describes 44.1 kHz mono exactly', () => {
    const header = adtsHeader({ payloadLength: 1, sampleRate: 44100, channels: 1 });

    assert.equal(header.toString('hex'), 'fff15040011ffc');
});

test('the rate index agrees with the table the phone uses', () => {
    assert.equal(sampleRateIndex(96000), 0);
    assert.equal(sampleRateIndex(48000), 3);
    assert.equal(sampleRateIndex(44100), 4);
    assert.equal(sampleRateIndex(8000), 11);
    assert.equal(sampleRateIndex(7350), SAMPLE_RATES.length - 1);

    // An untabulated rate has no ADTS representation at all. The phone can
    // express one with an escape code in its AudioSpecificConfig; this cannot.
    assert.equal(sampleRateIndex(37000), -1);
});

test('the frame length spans all three of its bytes', () => {
    // 13 bits split 2/8/3 across bytes 3, 4 and 5. A header that only ever
    // carries short frames will not notice the top two bits being dropped.
    const header = adtsHeader({ payloadLength: 0x1fff - ADTS_HEADER_BYTES, sampleRate: 48000, channels: 2 });

    const length = ((header[3] & 0x03) << 11) | (header[4] << 3) | (header[5] >> 5);
    assert.equal(length, 0x1fff);
});

test('a frame that cannot be described is refused rather than mislabelled', () => {
    const ok = { payloadLength: 100, sampleRate: 48000, channels: 2 };

    assert.equal(adtsHeader({ ...ok, sampleRate: 37000 }), null, 'untabulated rate');
    assert.equal(adtsHeader({ ...ok, sampleRate: 0 }), null);
    assert.equal(adtsHeader({ ...ok, channels: 0 }), null);
    assert.equal(adtsHeader({ ...ok, channels: 8 }), null, 'needs a program config element');
    assert.equal(adtsHeader({ ...ok, payloadLength: 0 }), null);
    assert.equal(adtsHeader({ ...ok, payloadLength: -1 }), null);
    assert.equal(adtsHeader({ ...ok, payloadLength: 0x2000 }), null, 'longer than the length field');
});

test('wrapping prefixes the payload without altering it', () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const wrapped = wrapAdts(payload, { sampleRate: 48000, channels: 2 });

    assert.equal(wrapped.length, ADTS_HEADER_BYTES + payload.length);
    assert.deepEqual(wrapped.subarray(ADTS_HEADER_BYTES), payload);
    assert.equal(wrapped[0], 0xff, 'and the syncword is where a demuxer looks for it');
    assert.equal(wrapAdts(payload, { sampleRate: 37000, channels: 2 }), null);
});

/* --------------------------------------------------------------- aligner -- */

function unit(timestamp, tag = 0, keyframe = false) {
    return { timestamp, payload: Buffer.from([tag]), keyframe };
}

test('the aligner emits matched pairs in order', () => {
    const pairs = [];
    const aligner = new StereoAligner({ onPair: (l, r) => pairs.push([l[0], r[0]]) });

    aligner.pushLeft(unit(1000, 1));
    assert.equal(pairs.length, 0, 'a lone eye is never emitted');

    aligner.pushRight(unit(1000, 11));
    aligner.pushLeft(unit(2000, 2));
    aligner.pushRight(unit(2000, 12));

    assert.deepEqual(pairs, [
        [1, 11],
        [2, 12]
    ]);
});

test('an unmatched frame is discarded instead of shifting the pairing', () => {
    // This is the failure that matters: pairing frame N against frame N+1
    // gives a stereo image that is subtly wrong for the rest of the broadcast.
    const pairs = [];
    const aligner = new StereoAligner({ onPair: (l, r) => pairs.push([l[0], r[0]]) });

    // One frame apart at 30 fps. Frames closer together than the matching
    // tolerance are, correctly, treated as the same instant.
    aligner.pushLeft(unit(33_333, 1));
    aligner.pushLeft(unit(66_666, 2));
    aligner.pushRight(unit(66_666, 12));
    aligner.pushLeft(unit(99_999, 3));
    aligner.pushRight(unit(99_999, 13));

    assert.deepEqual(pairs, [
        [2, 12],
        [3, 13]
    ]);
    assert.equal(aligner.unmatched, 1);
});

test('near-identical timestamps still match', () => {
    const pairs = [];
    const aligner = new StereoAligner({ onPair: (l, r) => pairs.push([l[0], r[0]]) });

    aligner.pushLeft(unit(1_000_000, 1));
    aligner.pushRight(unit(1_000_900, 11));

    assert.equal(pairs.length, 1);
});

test('a stalled eye does not grow the heap', () => {
    const aligner = new StereoAligner({ onPair: () => {} });

    // The right camera has stopped entirely and thirty seconds of left frames
    // arrive with no possible partner.
    for (let i = 0; i < 1000; i += 1) aligner.pushLeft(unit(i * 33_333, 1));

    const summary = aligner.summary();

    // Bounded by the skew window long before the hard queue cap is reached,
    // so only a few frames are ever held.
    assert.ok(summary.pendingLeft <= 120, `held ${summary.pendingLeft} frames`);
    assert.ok(summary.unmatched + summary.overflowed > 900, 'the rest were discarded');
});

test('mono passes frames straight through', () => {
    const pairs = [];
    const aligner = new StereoAligner({ stereo: false, onPair: (l, r) => pairs.push([l[0], r]) });

    aligner.pushLeft(unit(1000, 1));
    aligner.pushRight(unit(1000, 11));

    assert.deepEqual(pairs, [[1, null]]);
});

/* ----------------------------------------------------------- end to end -- */

const ffmpeg = await probe();

test(
    'a live session is transcoded into a playable HLS ladder with both eyes',
    { skip: ffmpeg.available ? false : `ffmpeg unavailable: ${ffmpeg.error}`, timeout: 90_000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avr-transcode-test-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));

        // Two visibly different sources, so the composite can be checked for
        // actually containing two images rather than one duplicated.
        const [left, right] = await Promise.all([
            sourceClip(root, 'left', 'testsrc2'),
            sourceClip(root, 'right', 'smptebars')
        ]);

        const session = new LiveSession({
            name: 'transcode test',
            mode: 'separate',
            projection: 'flat',
            stereo: 'sbs'
        });

        const pipeline = new TranscodePipeline({
            session,
            rootDir: root,
            segmentSeconds: 1,
            playlistLength: 4
        });

        const warnings = [];
        pipeline.on('warning', (message) => warnings.push(message));
        t.after(() => pipeline.stop('test over', false));

        pipeline.attach();
        assert.equal(pipeline.state, 'waiting', 'nothing is spawned before the codec is known');

        const config = { codec: 'avc1.42C015', codedWidth: 320, codedHeight: 180 };
        session.setConfig(TRACK.LEFT, config);
        session.setConfig(TRACK.RIGHT, config);

        await waitFor(() => pipeline.state === 'running', 10_000, 'ffmpeg to start');

        // Fed at roughly real time, because the pipeline stamps arrival time.
        await feed(session, left, right);

        await waitFor(
            () => exists(path.join(root, session.id, 'master.m3u8')),
            30_000,
            'the master playlist'
        );

        const master = await fs.readFile(path.join(root, session.id, 'master.m3u8'), 'utf8');
        const rungs = ladder();

        for (const rung of rungs) {
            assert.match(master, new RegExp(`${rung.name}/stream\\.m3u8`), `${rung.name} in the master`);
        }

        // The composite is 2x wide, and the master advertises that honestly -
        // a player choosing a rendition needs the real frame size.
        assert.match(master, /RESOLUTION=\d+x\d+/);

        const rung = rungs[rungs.length - 1].name;
        await waitFor(() => hasSegment(path.join(root, session.id, rung)), 30_000, 'a media segment');

        const segment = await firstSegment(path.join(root, session.id, rung));
        const { width, height } = await dimensionsOf(segment);

        // 320x180 per eye stacked is 32:9, so the composite is always much
        // wider than tall - if this is 16:9 the stack did not happen.
        assert.ok(width / height > 3, `expected a stacked frame, got ${width}x${height}`);

        const [leftLuma, rightLuma] = await Promise.all([
            averageLuma(segment, 0, width / 2, height),
            averageLuma(segment, width / 2, width / 2, height)
        ]);

        assert.ok(
            Math.abs(leftLuma - rightLuma) > 5,
            `the two halves must be different images (left ${leftLuma}, right ${rightLuma}) - ` +
                'equal values mean one camera was composited against itself'
        );

        assert.equal(pipeline.restarts, 0, `ffmpeg restarted: ${warnings.join('; ')}`);
        assert.ok(pipeline.summary().alignment.paired > 10, 'frames were paired, not dropped');
    }
);

/* ----------------------------------------------------------------- helpers */

async function sourceClip(dir, name, pattern) {
    const file = path.join(dir, `${name}.h264`);

    await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `${pattern}=size=320x180:rate=30:duration=2`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0',
        '-f', 'h264', file
    ]);

    return accessUnits(await fs.readFile(file));
}

/**
 * Split an Annex B stream into access units.
 *
 * A new unit begins at the first VCL NAL after the previous unit already had
 * one, which keeps each unit's parameter sets attached to the picture they
 * describe - the same grouping the phone's encoder produces.
 */
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

/** Publish paired access units through the session at roughly 30 fps. */
async function feed(session, left, right) {
    const count = Math.min(left.length, right.length);
    let sequence = 0;

    for (let i = 0; i < count; i += 1) {
        const timestamp = i * 33_333;

        for (const [track, units] of [
            [TRACK.LEFT, left],
            [TRACK.RIGHT, right]
        ]) {
            const au = units[i];
            const flags = au.keyframe ? FLAG.KEYFRAME : 0;
            const raw = encodeFrame({
                type: FRAME_TYPE.VIDEO,
                track,
                flags,
                timestamp,
                sequence,
                payload: au.payload
            });

            session.publish({ type: FRAME_TYPE.VIDEO, track, flags, timestamp, payload: au.payload }, raw);
        }

        sequence += 1;
        await sleep(33);
    }
}

async function waitFor(condition, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(200);
    }

    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

async function hasSegment(dir) {
    try {
        return (await fs.readdir(dir)).some((name) => name.endsWith('.ts'));
    } catch {
        return false;
    }
}

async function firstSegment(dir) {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
    return path.join(dir, names[0]);
}

async function dimensionsOf(file) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        file
    ]);

    // ffprobe reports an MPEG-TS stream once per program, so there may be
    // several identical lines. The first is the one wanted.
    const [width, height] = stdout.trim().split('\n')[0].split(',').map(Number);
    return { width, height };
}

/** Mean luma of a cropped region of the first frame. */
async function averageLuma(file, x, width, height) {
    const { stderr } = await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'info',
        '-i', file,
        '-vf', `crop=${width}:${height}:${x}:0,signalstats,metadata=print`,
        '-frames:v', '1',
        '-f', 'null', '-'
    ]);

    return Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr)?.[1] ?? NaN);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
