import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import { FRAME_TYPE, FLAG, TRACK, decodeFrame, decodeJson } from '../../src/live/protocol.js';
import { StereoAligner } from './aligner.js';
import { wrapAdts } from './adts.js';
import { FFMPEG_PATH, buildArgs, ladder, encoderName } from './ffmpeg.js';

/**
 * One FFmpeg process, transcoding one broadcast into an HLS ladder.
 *
 * The pipeline attaches to a `LiveSession` as an ordinary subscriber, which is
 * worth more than it sounds: it inherits the keyframe gating, the cached CONFIG
 * replay and the slow-consumer protection that were already built and tested
 * for browsers. From the session's point of view the transcoder is just another
 * viewer that happens to be a local process.
 *
 * It also means the WebSocket relay is entirely unaffected. The sub-second
 * per-eye path the camera operator monitors on keeps running exactly as before;
 * this is a second, independent consumer of the same frames, producing the
 * compatible-but-slower output for everyone else.
 *
 * @fires TranscodePipeline#ready   first playlist written
 * @fires TranscodePipeline#exit
 * @fires TranscodePipeline#warning
 */
export class TranscodePipeline extends EventEmitter {
    /**
     * @param {object} options
     * @param {import('../live/sessions.js').LiveSession} options.session
     * @param {string} options.rootDir - Parent directory for all sessions' output.
     */
    constructor({ session, rootDir, segmentSeconds = 1, playlistLength = 6 }) {
        super();

        this.session = session;
        this.outputDir = path.join(rootDir, session.id);
        this.segmentSeconds = segmentSeconds;
        this.playlistLength = playlistLength;
        this.rungs = ladder();

        /** `separate` means two camera tracks; anything else is a single frame. */
        this.stereo = session.mode === 'separate';

        this.state = 'idle';
        this.error = null;
        this.startedAt = null;
        this.restarts = 0;
        this.speed = null;
        this.encoder = encoderName();

        this._process = null;
        this._subscriber = null;
        this._restartTimer = null;
        this._stopped = false;
        this._stderr = '';
        this._readyWatch = null;
        this._announcedReady = false;
        this._startTimer = null;

        /**
         * Sound format from the audio track's CONFIG, or `null` while the
         * broadcast is silent. Sound is optional in a way the picture is not:
         * the operator can switch it off, deny the microphone, or be on a
         * device without one, and none of those should hold up the transcode.
         */
        this._audioFormat = null;
        /** Whether the *running* FFmpeg was spawned with an audio input. */
        this._startedWithAudio = false;
        /** Counted so a silent broadcast can be told from a broken one. */
        this._audioDropped = 0;

        /** @type {Map<number, object>} track -> CONFIG payload */
        this._configs = new Map();

        this._aligner = new StereoAligner({
            stereo: this.stereo,
            onPair: (left, right) => this._writePair(left, right)
        });
    }

    get playlistUrl() {
        return `/live/hls/${this.session.id}/master.m3u8`;
    }

    /**
     * Attach to the session and wait for enough configuration to start.
     *
     * FFmpeg is not spawned here. It cannot be: its arguments depend on the
     * codec and frame size the phone chose, and those only arrive in the CONFIG
     * frames. Spawning on a guess and restarting when the guess is wrong would
     * cost a few seconds of every broadcast.
     */
    attach() {
        if (this._subscriber) return;

        const pipeline = this;

        this._subscriber = this.session.addSubscriber({
            send: (bytes) => pipeline._onFrame(bytes),
            close: () => pipeline.stop('session closed'),

            // Reported back to the session so that if FFmpeg ever stalls, the
            // same backpressure logic that protects the server from a slow
            // browser protects it from a slow transcode.
            get bufferedAmount() {
                return pipeline._bufferedBytes();
            }
        });

        this.state = 'waiting';
    }

    _bufferedBytes() {
        if (!this._process) return 0;

        const [, , , left, right, audio] = this._process.stdio;
        return (
            (left?.writableLength ?? 0) +
            (right?.writableLength ?? 0) +
            (audio?.writableLength ?? 0)
        );
    }

    // MARK: - Frame intake

    _onFrame(bytes) {
        let frame;

        try {
            frame = decodeFrame(bytes);
        } catch {
            return;
        }

        if (frame.type === FRAME_TYPE.CONFIG) {
            this._onConfig(frame);
            return;
        }

        if (frame.type === FRAME_TYPE.AUDIO) {
            this._writeAudio(frame);
            return;
        }

        if (frame.type !== FRAME_TYPE.VIDEO) return;
        if (this.state !== 'running') return;

        const unit = {
            timestamp: frame.timestamp,
            payload: Buffer.from(frame.payload),
            keyframe: (frame.flags & FLAG.KEYFRAME) !== 0
        };

        if (frame.track === TRACK.LEFT || frame.track === TRACK.PACKED) {
            this._aligner.pushLeft(unit);
        } else if (frame.track === TRACK.RIGHT) {
            this._aligner.pushRight(unit);
        }
    }

    _onConfig(frame) {
        const config = decodeJson(frame);
        if (!config?.codec) return;

        if (frame.track === TRACK.AUDIO) {
            this._onAudioConfig(config);
            return;
        }

        const previous = this._configs.get(frame.track);
        this._configs.set(frame.track, config);

        // A changed codec or frame size invalidates the running FFmpeg's
        // arguments entirely, so the only correct response is to rebuild it.
        if (previous && this.state === 'running' && !sameFormat(previous, config)) {
            this.emit('warning', 'source format changed, restarting transcode');
            this._restart();
            return;
        }

        if (this.state === 'waiting' && this._haveEnoughConfig()) {
            this._startWhenSettled();
        }
    }

    /**
     * Start, but give sound a moment to announce itself first.
     *
     * An input cannot be added to a running FFmpeg, so a broadcast whose audio
     * CONFIG lands a few milliseconds after its video CONFIG would otherwise
     * start silent and immediately restart — on essentially every broadcast,
     * since the phone builds both encoders at once and whichever produces its
     * first frame first wins the race. Half a second of patience up front is
     * cheaper than a process restart, and it is spent on the HLS path, which is
     * already several segments behind the relay the operator monitors on.
     */
    _startWhenSettled() {
        if (this._startTimer) return;

        if (this._audioFormat) {
            this._start().catch((err) => this._fail(err));
            return;
        }

        this._startTimer = setTimeout(() => {
            this._startTimer = null;
            this._start().catch((err) => this._fail(err));
        }, AUDIO_GRACE_MS);

        this._startTimer.unref?.();
    }

    /**
     * Sound arrived, or changed.
     *
     * Deliberately not part of {@link _haveEnoughConfig}: waiting for an audio
     * CONFIG before starting would stall every silent broadcast forever, and
     * "the operator turned sound off" is a normal state, not a fault. So the
     * transcode starts on video alone and picks sound up when it appears —
     * which costs a restart, because an input cannot be added to a running
     * FFmpeg. In practice the phone sends both configs within a frame or two of
     * each other and the restart happens before a segment has been written.
     */
    _onAudioConfig(config) {
        const sampleRate = Number(config.sampleRate);
        const channels = Number(config.numberOfChannels);

        if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
        if (!Number.isInteger(channels) || channels < 1) return;

        const previous = this._audioFormat;
        if (previous && previous.sampleRate === sampleRate && previous.channels === channels) return;

        this._audioFormat = { sampleRate, channels };

        // Still inside the grace window: start now rather than waiting it out.
        if (this._startTimer) {
            clearTimeout(this._startTimer);
            this._startTimer = null;
            this._start().catch((err) => this._fail(err));
            return;
        }

        if (this.state === 'running') {
            this.emit(
                'warning',
                previous
                    ? 'sound format changed, restarting transcode'
                    : 'sound started, restarting transcode to carry it'
            );
            this._restart();
        }
    }

    _haveEnoughConfig() {
        if (!this.stereo) return this._configs.has(TRACK.LEFT) || this._configs.has(TRACK.PACKED);
        return this._configs.has(TRACK.LEFT) && this._configs.has(TRACK.RIGHT);
    }

    // MARK: - Process lifecycle

    async _start() {
        if (this._stopped || this._process) return;

        const config = this._configs.get(TRACK.LEFT) ?? this._configs.get(TRACK.PACKED);
        if (!config) return;

        const audio = this._audioFormat !== null;

        await this._prepareOutput();
        const args = this._buildArgs(config, audio);

        // stdin is closed, the two eyes get file descriptors 3 and 4, and sound
        // gets 5. Using extra descriptors rather than, say, named pipes on disk
        // keeps the whole thing in memory and gives the child's death the same
        // semantics as any other pipe: the reads end, and FFmpeg finalises the
        // playlist.
        const child = spawn(FFMPEG_PATH, args, {
            stdio: [
                'ignore',
                'ignore',
                'pipe',
                'pipe',
                this.stereo ? 'pipe' : 'ignore',
                audio ? 'pipe' : 'ignore'
            ]
        });

        this._process = child;
        this._startedWithAudio = audio;
        this.state = 'running';
        this.startedAt = Date.now();
        this.error = null;
        this._stderr = '';
        this._aligner.reset();

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => this._onStderr(chunk));

        for (const fd of [3, 4, 5]) {
            child.stdio[fd]?.on('error', (err) => {
                // EPIPE is what a dead FFmpeg looks like from this side; the
                // exit handler is already dealing with it.
                if (err.code !== 'EPIPE') this.emit('warning', `pipe ${fd}: ${err.message}`);
            });
        }

        child.on('error', (err) => this._fail(err));
        child.on('exit', (code, signal) => this._onExit(code, signal));

        this._watchForReady();
        this.emit('started', this);
    }

    /*
     * The three seams a subclass needs.
     *
     * Everything above and below this point - the frame intake, the aligner,
     * the backpressure accounting, the restart backoff, the SIGINT shutdown -
     * is the same work whether the frames end up in a segment directory or a
     * single file. Only the destination differs, so only the destination is
     * overridable. See `RecordingPipeline` in `server/live/recording.js`.
     */

    /** Make whatever the output needs to exist before FFmpeg opens it. */
    async _prepareOutput() {
        await fs.mkdir(this.outputDir, { recursive: true });
        await Promise.all(
            this.rungs.map((rung) => fs.mkdir(path.join(this.outputDir, rung.name), { recursive: true }))
        );
    }

    /**
     * @param {object} config - The video track's CONFIG payload.
     * @param {boolean} audio - Whether this spawn carries sound.
     */
    _buildArgs(config, audio) {
        return buildArgs({
            inputCodec: codecFamily(config.codec),
            stereo: this.stereo,
            frameRate: frameRateOf(this.session),
            sourceWidth: config.codedWidth || 1920,
            sourceHeight: config.codedHeight || 1080,
            outputDir: this.outputDir,
            rungs: this.rungs,
            segmentSeconds: this.segmentSeconds,
            playlistLength: this.playlistLength,
            audio
        });
    }

    /** Decide when the output is usable and emit `ready`. */
    _watchForReady() {
        this._watchForPlaylist();
    }

    /**
     * One AAC access unit onto pipe 5, with an ADTS header in front of it.
     *
     * Dropped rather than queued when the transcode has no audio input: the
     * restart that adds one is already scheduled, and a few hundred
     * milliseconds of sound is not worth holding frames in memory for.
     */
    _writeAudio(frame) {
        const child = this._process;
        if (!child || !this._startedWithAudio || !this._audioFormat) return;

        const wrapped = wrapAdts(frame.payload, this._audioFormat);

        if (!wrapped) {
            // A format ADTS cannot express. Counted rather than logged per
            // frame, which at 47 frames a second would be a log flood.
            this._audioDropped += 1;
            return;
        }

        child.stdio[5]?.write(wrapped);
    }

    _writePair(left, right) {
        const child = this._process;
        if (!child) return;

        // Written together and in this order every time, so the two elementary
        // streams stay in lockstep at the byte level as well as the timestamp
        // level.
        child.stdio[3]?.write(left);
        if (right) child.stdio[4]?.write(right);
    }

    /**
     * Read FFmpeg's `-progress` output.
     *
     * `speed` is the number worth watching: below 1.0 the transcode is slower
     * than real time, which on a live stream is not a quality problem but an
     * unbounded latency problem. It is surfaced rather than logged because the
     * fix - fewer rungs, a faster preset, or hardware acceleration - is a
     * decision for whoever is running the broadcast.
     */
    _onStderr(chunk) {
        this._stderr = (this._stderr + chunk).slice(-4000);

        const speed = /speed=\s*([\d.]+)x/.exec(chunk);
        if (speed) {
            this.speed = Number(speed[1]);

            if (this.speed < 0.95 && this.state === 'running') {
                this.emit(
                    'warning',
                    `transcode is running at ${this.speed}x real time - latency will grow. ` +
                        'Reduce AVR_TRANSCODE_LADDER or set AVR_TRANSCODE_HWACCEL=1.'
                );
            }
        }

    }

    /**
     * Wait for the master playlist to appear on disk.
     *
     * Polling the filesystem rather than parsing FFmpeg's output, because the
     * line that announces it is only emitted at verbose log levels and raising
     * the log level to find out would mean parsing every frame's worth of
     * chatter to catch one event.
     */
    _watchForPlaylist() {
        clearInterval(this._readyWatch);

        const master = path.join(this.outputDir, 'master.m3u8');

        this._readyWatch = setInterval(async () => {
            if (this._stopped || this._announcedReady) {
                clearInterval(this._readyWatch);
                return;
            }

            try {
                await fs.access(master);
                this._announcedReady = true;
                clearInterval(this._readyWatch);
                this.emit('ready', this);
            } catch {
                /* not yet */
            }
        }, 250);

        this._readyWatch.unref?.();
    }

    _onExit(code, signal) {
        this._process = null;

        if (this._stopped) {
            this.state = 'stopped';
            this.emit('exit', { code, signal });
            return;
        }

        // A clean exit while the broadcast is still live means FFmpeg gave up
        // on its own, which is still a failure from here.
        this.error = `ffmpeg exited (${signal || code})`;
        this.emit('exit', { code, signal, stderr: this._stderr });

        this._restart();
    }

    _restart() {
        if (this._stopped || this._restartTimer) return;

        this._kill();

        // Backoff, capped. A persistently failing transcode should keep trying
        // - the phone is still broadcasting and the relay still works - but it
        // should not spawn a process per second while doing so.
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
        this.restarts += 1;
        this.state = 'restarting';

        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this._announcedReady = false;
            this._start().catch((err) => this._fail(err));
        }, delay);

        this._restartTimer.unref?.();
    }

    _fail(err) {
        this.error = err.message;
        this.state = 'failed';
        this.emit('warning', err.message);
    }

    _kill() {
        const child = this._process;
        if (!child) return;

        this._process = null;

        // SIGINT rather than SIGKILL: FFmpeg finalises the playlist with an
        // EXT-X-ENDLIST on the way out, which is what tells a player the
        // broadcast finished rather than that the network failed.
        try {
            child.stdio[3]?.end();
            child.stdio[4]?.end();
            child.stdio[5]?.end();
            child.kill('SIGINT');
        } catch {
            /* already gone */
        }

        const deadline = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        }, 3000);

        deadline.unref?.();
        child.once('exit', () => clearTimeout(deadline));
    }

    /**
     * Detach and shut down.
     *
     * @param {string} reason
     * @param {boolean} cleanup - Remove the segment directory. Left in place
     *   for a short grace period in practice, so a viewer mid-segment is not
     *   handed a 404 the instant the phone hangs up.
     */
    stop(reason = 'stopped', cleanup = true) {
        if (this._stopped) return;

        this._stopped = true;
        this.state = 'stopped';
        this.error = this.error ?? null;

        clearTimeout(this._restartTimer);
        clearTimeout(this._startTimer);
        clearInterval(this._readyWatch);
        this._restartTimer = null;
        this._startTimer = null;

        if (this._subscriber) {
            this.session.removeSubscriber(this._subscriber);
            this._subscriber = null;
        }

        this._kill();

        if (cleanup) {
            setTimeout(() => {
                fs.rm(this.outputDir, { recursive: true, force: true }).catch(() => {});
            }, 30_000).unref?.();
        }

        this.emit('stopped', reason);
    }

    summary() {
        return {
            sessionId: this.session.id,
            state: this.state,
            encoder: this.encoder,
            error: this.error,
            speed: this.speed,
            restarts: this.restarts,
            stereo: this.stereo,
            startedAt: this.startedAt,
            audio: this._audioFormat
                ? { ...this._audioFormat, carried: this._startedWithAudio, dropped: this._audioDropped }
                : null,
            playlist: this.state === 'running' ? this.playlistUrl : null,
            rungs: this.rungs.map((rung) => ({
                name: rung.name,
                height: rung.height,
                bitrate: rung.bitrate,
                playlist: `/live/hls/${this.session.id}/${rung.name}/stream.m3u8`
            })),
            alignment: this._aligner.summary()
        };
    }
}

/**
 * How long to hold the transcode back waiting for an audio CONFIG that may
 * never come. Long enough to cover the gap between the phone's two encoders
 * producing their first output, short enough that a silent broadcast does not
 * notice it.
 */
const AUDIO_GRACE_MS = 500;

/** `avc1.640028` -> `h264`; `hvc1.1.6.L93.B0` -> `hevc`. */
export function codecFamily(codec) {
    return String(codec).startsWith('hvc1') || String(codec).startsWith('hev1') ? 'hevc' : 'h264';
}

function sameFormat(a, b) {
    return a.codec === b.codec && a.codedWidth === b.codedWidth && a.codedHeight === b.codedHeight;
}

/**
 * The phone does not announce its frame rate, so it is inferred from what the
 * session has actually been receiving and snapped to a sane value.
 */
export function frameRateOf(session) {
    const measured = session.stats.get(TRACK.LEFT)?.rates().fps ?? 0;

    if (measured >= 50) return 60;
    if (measured >= 40) return 48;
    if (measured >= 20) return 30;
    return 30;
}
