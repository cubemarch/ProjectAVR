import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { STEREO } from '../../src/catalog/media-format.js';
import { recordings as recordingRows, creatorSettings } from '../db/index.js';
import { getStorage, buildKey } from '../storage/index.js';
import { TranscodePipeline, codecFamily, frameRateOf } from '../transcode/pipeline.js';
import { recordArgs, probe } from '../transcode/ffmpeg.js';

/**
 * Recording a 1:1, from the creator's side.
 *
 * The recorder is a second FFmpeg attached to the same live session as the
 * transcoder, as an ordinary subscriber. That placement is the whole design:
 * what arrives at a subscriber is what the phone sent, so the recording
 * contains the creator's picture and the creator's voice and cannot contain
 * the viewer's. Talkback travels the other way up the pipeline and is not
 * filtered out here - it is never in reach of this code at all.
 *
 * That is what makes the file sellable. A recording that could contain the
 * paying viewer would be a recording of a named person who is not the seller,
 * and listing it would need their consent at the moment of listing rather than
 * their consent to being recorded. This one needs nobody's but the creator's.
 *
 * The viewer's recording is the other artifact the product calls for, and it
 * is deliberately not here: it is made by `MediaRecorder` in their browser,
 * mixes their own microphone with what they are hearing, and is saved to their
 * disk. It never reaches this server, so there is nothing to govern, nothing
 * to leak and nothing to subpoena. `creator_settings.recording_policy` gates
 * that side, because that is the side that captures somebody who is not the
 * person deciding.
 *
 * Nothing public is recorded. A recorder is started when a private turn opens
 * and stopped when it closes; a public broadcast has an audience, and an
 * audience is not a conversation two people agreed to keep.
 */

/** Files are written here first, then handed to the storage layer whole. */
const SCRATCH_ROOT = process.env.AVR_RECORDING_DIR || path.join(os.tmpdir(), 'avr-recordings');

/**
 * One FFmpeg, one MP4.
 *
 * Almost everything is inherited: the frame intake, the stereo aligner, the
 * ADTS wrapping, the backpressure the session reads back, and the SIGINT
 * shutdown that lets FFmpeg write its index. Only the destination differs, so
 * only the three destination seams are overridden.
 */
export class RecordingPipeline extends TranscodePipeline {
    constructor({ session, filePath }) {
        super({ session, rootDir: path.dirname(filePath) });

        this.filePath = filePath;

        // The parent builds a ladder for HLS. There is no ladder here - one
        // file, at whatever the phone sent - and `summary()` is overridden
        // below so nothing advertises rungs that do not exist.
        this.rungs = [];
    }

    async _prepareOutput() {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    }

    _buildArgs(config, audio) {
        return recordArgs({
            inputCodec: codecFamily(config.codec),
            stereo: this.stereo,
            frameRate: frameRateOf(this.session),
            sourceWidth: config.codedWidth || 1920,
            sourceHeight: config.codedHeight || 1080,
            outputFile: this.filePath,
            audio
        });
    }

    /**
     * A recording is ready the moment FFmpeg is running.
     *
     * There is no playlist to wait for, and waiting for the file to appear
     * would say nothing useful: an MP4 is not playable until it is closed.
     */
    _watchForReady() {
        if (this._announcedReady) return;
        this._announcedReady = true;
        this.emit('ready', this);
    }

    /**
     * A dead FFmpeg ends the recording. It does not restart it.
     *
     * The parent restarts because a live broadcast outlives any one transcode
     * and a fresh segment directory costs nothing. Here the output is a single
     * file opened with `-y`: respawning would truncate everything recorded so
     * far, turning a partial loss into a total one. And the partial file is
     * not salvageable either - an MP4 whose process died has no `moov` atom
     * and no index - so the honest outcome is to fail the whole recording and
     * say why.
     */
    _restart() {
        if (this._stopped) return;

        this.error = this.error ?? 'ffmpeg stopped unexpectedly';
        this.emit('warning', `recording abandoned: ${this.error}`);
        this.stop(this.error, false);
    }

    /** Never delete the output. That is the one thing this pipeline is for. */
    stop(reason = 'stopped', cleanup = false) {
        super.stop(reason, cleanup);
    }

    /**
     * Resolves when FFmpeg has actually exited, so the file can be read.
     *
     * `_process` is not the thing to wait on: `_kill()` nulls it the moment
     * SIGINT is sent, and FFmpeg is still writing its index for some
     * milliseconds after that. Reading the file then gets a truncated MP4 with
     * no `moov` atom - the exact failure this whole shutdown path exists to
     * avoid. The child handle is kept separately for that reason.
     */
    finished(timeoutMs = 10_000) {
        const child = this._child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

        return new Promise((resolve) => {
            const done = setTimeout(resolve, timeoutMs);
            done.unref?.();
            child.once('exit', () => {
                clearTimeout(done);
                resolve();
            });
        });
    }

    async _start() {
        await super._start();
        this._child = this._process;
    }

    summary() {
        return {
            sessionId: this.session.id,
            state: this.state,
            encoder: this.encoder,
            error: this.error,
            speed: this.speed,
            stereo: this.stereo,
            startedAt: this.startedAt,
            file: this.filePath
        };
    }
}

/**
 * The recorders that are running, and the rows behind them.
 *
 * Keyed by session id, because that is what both ends of a private turn have
 * in hand: the relay knows it, `PrivateTurns.end` knows it, and the room that
 * owns it does not survive a restart.
 */
export class RecordingRegistry {
    constructor({ storage = null, rows = recordingRows } = {}) {
        this._storage = storage;
        this._rows = rows;

        /** @type {Map<string, {pipeline: RecordingPipeline, id: string, startedAt: number}>} */
        this._active = new Map();

        this.available = false;
        this.reason = 'not probed';
    }

    get storage() {
        return this._storage ?? getStorage();
    }

    /** Probed once at boot, the same way the transcoder is. */
    async probeFfmpeg() {
        const result = await probe();
        this.available = result.available;
        this.reason = result.error ?? null;
        return result;
    }

    isRecording(sessionId) {
        return this._active.has(sessionId);
    }

    stateFor(sessionId) {
        const entry = this._active.get(sessionId);
        if (!entry) return { recording: false };

        return {
            recording: true,
            id: entry.id,
            startedAt: entry.startedAt,
            state: entry.pipeline.state,
            error: entry.pipeline.error
        };
    }

    /**
     * Begin recording a private turn.
     *
     * The row is written before FFmpeg is spawned, so a crash between the two
     * leaves evidence that a recording was attempted rather than nothing at
     * all. It is marked `failed` rather than deleted if the spawn does not take.
     *
     * @param {object} input
     * @param {object} input.session
     * @param {string} input.creatorId
     * @param {string|null} [input.roomId]
     * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
     */
    async start({ session, creatorId, roomId = null }) {
        if (!this.available) return { ok: false, reason: 'recording_unavailable' };
        if (!session?.live) return { ok: false, reason: 'not_live' };
        if (this._active.has(session.id)) return { ok: false, reason: 'already_recording' };

        // What is arriving, not what the phone announced. Read again at the
        // end, because a second camera can drop out mid-conversation and the
        // tag has to describe the file rather than the intention.
        const stereo = session.carryingStereo ? STEREO.SBS : STEREO.MONO;
        const row = this._rows.start({ creatorId, roomId, sessionId: session.id, stereo });

        const filePath = path.join(SCRATCH_ROOT, `${row.id}.mp4`);
        const pipeline = new RecordingPipeline({ session, filePath });

        pipeline.on('warning', (message) => {
            console.warn(`  Recording  ${row.id}: ${message}`);
        });

        this._active.set(session.id, { pipeline, id: row.id, startedAt: Date.now(), creatorId });

        // The session closing under the recorder has to finish the file, not
        // just drop the process - otherwise a creator who hangs up rather than
        // pressing stop loses the recording they made.
        pipeline.once('stopped', () => {
            if (this._active.get(session.id)?.id === row.id) {
                this.stop(session.id, 'broadcast ended').catch(() => {});
            }
        });

        pipeline.attach();

        return { ok: true, id: row.id };
    }

    /**
     * Stop, finalise, store, and write the row.
     *
     * The order matters. FFmpeg is asked to exit and waited for, because the
     * MP4 index is written on the way out; only then is the file read. If any
     * of it fails the row is marked `failed` with the reason, which is more
     * useful to the creator than a recording that silently never appears.
     *
     * @returns {Promise<{ok: true, recording: object} | {ok: false, reason: string}>}
     */
    async stop(sessionId, reason = 'stopped') {
        const entry = this._active.get(sessionId);
        if (!entry) return { ok: false, reason: 'not_recording' };

        this._active.delete(sessionId);

        const { pipeline, id, startedAt } = entry;
        const durationMs = Date.now() - startedAt;

        pipeline.stop(reason, false);
        await pipeline.finished();

        try {
            const stat = await fsp.stat(pipeline.filePath);

            // An empty or near-empty file is a failed recording however
            // cleanly FFmpeg exited. Storing it would put something unplayable
            // in a creator's list with no explanation attached.
            if (stat.size < 1024) throw new Error('nothing was recorded');

            const key = buildKey(entry.creatorId, id, 'recording.mp4', 'recording');
            await this.storage.putStream(key, fs.createReadStream(pipeline.filePath));

            const recording = this._rows.finish(id, {
                storageKey: key,
                durationMs,
                sizeBytes: stat.size,
                stereo: pipeline.session.carryingStereo ? STEREO.SBS : STEREO.MONO
            });

            await fsp.rm(pipeline.filePath, { force: true });

            return { ok: true, recording };
        } catch (err) {
            this._rows.fail(id, pipeline.error ?? err.message);
            await fsp.rm(pipeline.filePath, { force: true }).catch(() => {});

            return { ok: false, reason: pipeline.error ?? err.message };
        }
    }

    /**
     * Shut every recorder down, finishing each file.
     *
     * Awaited on the way out of the process so that stopping the server does
     * not cost somebody a recording. Anything still running after that is a
     * file the next start will find in the scratch directory and sweep.
     */
    async stopAll(reason = 'server shutting down') {
        await Promise.all([...this._active.keys()].map((id) => this.stop(id, reason).catch(() => {})));
    }

    /**
     * Delete scratch files with no live recorder behind them.
     *
     * Only safe at boot, when by definition nothing is recording: a `.mp4`
     * here after a crash is an unfinalised file with no index, and keeping it
     * would leak disk one crash at a time.
     */
    async sweepScratch() {
        try {
            const entries = await fsp.readdir(SCRATCH_ROOT);
            await Promise.all(entries.map((e) => fsp.rm(path.join(SCRATCH_ROOT, e), { force: true })));
        } catch {
            /* nothing there */
        }
    }
}

/**
 * Whether the viewer may record, and how they find out.
 *
 * This governs a recording made in somebody else's browser, which is not a
 * thing this server can enforce - a determined person can point a camera at
 * their own screen. It is a consent record, not a DRM scheme, and it is worth
 * having for exactly that reason: the creator's answer is asked for, written
 * down while the turn lasts, and honoured by the page.
 *
 * `never` and `always` are answered from the creator's profile without
 * interrupting anybody. `ask` - the default, because in an all-party-consent
 * jurisdiction silence is not agreement - puts the question to the creator
 * during the turn.
 *
 * Delivered by polling rather than by a new protocol frame. Both pages are
 * already polling their side of a 1:1 every couple of seconds, a permission
 * question is not a sub-second matter, and a frame would need the capture app's
 * protocol to grow a message that has nothing to do with capture.
 */
export class ViewerRecordingConsent {
    constructor({ settings = creatorSettings } = {}) {
        this._settings = settings;

        /** @type {Map<string, {userId: string, state: string, askedAt: number}>} */
        this._asked = new Map();
    }

    policyFor(creatorId) {
        const row = creatorId ? this._settings.byId(creatorId) : null;
        return row?.recording_policy ?? 'ask';
    }

    /** What the viewer's page needs to draw its record button. */
    stateFor(session, userId) {
        const policy = this.policyFor(session?.creatorId);
        const asked = this._asked.get(session?.id);
        const mine = asked && asked.userId === userId ? asked : null;

        return {
            policy,
            allowed: policy === 'always' || mine?.state === 'granted',
            state: policy === 'always' ? 'granted' : policy === 'never' ? 'denied' : (mine?.state ?? 'idle')
        };
    }

    /**
     * The viewer asks.
     *
     * Asking again while an answer stands returns that answer rather than
     * re-opening it, so a creator who said no once is not asked once a second
     * by a page with a retry loop in it.
     */
    ask(session, userId) {
        const policy = this.policyFor(session.creatorId);

        if (policy === 'never') return { ok: false, reason: 'recording_not_permitted' };
        if (policy === 'always') return { ok: true, state: this.stateFor(session, userId) };

        const existing = this._asked.get(session.id);
        if (!existing || existing.userId !== userId) {
            this._asked.set(session.id, { userId, state: 'asked', askedAt: Date.now() });
        }

        return { ok: true, state: this.stateFor(session, userId) };
    }

    /** What the creator's page shows: a question, or nothing. */
    pending(sessionId) {
        const asked = this._asked.get(sessionId);
        return asked?.state === 'asked' ? { userId: asked.userId, askedAt: asked.askedAt } : null;
    }

    answer(session, creatorId, allowed) {
        if (session.creatorId !== creatorId) return { ok: false, reason: 'not_yours' };

        const asked = this._asked.get(session.id);
        if (!asked) return { ok: false, reason: 'nothing_asked' };

        asked.state = allowed ? 'granted' : 'denied';
        return { ok: true };
    }

    /**
     * Forget the answer when the turn ends.
     *
     * Consent was given to being recorded in this conversation. Carrying it
     * into the next one would be a different agreement that nobody made.
     */
    clear(sessionId) {
        if (sessionId) this._asked.delete(sessionId);
        else this._asked.clear();
    }
}

export const recorders = new RecordingRegistry();
export const viewerConsent = new ViewerRecordingConsent();

export { SCRATCH_ROOT };
