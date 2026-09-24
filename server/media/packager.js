import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { STEREO } from '../../src/catalog/media-format.js';

/**
 * ffmpeg probing and HLS packaging.
 *
 * Adaptive bitrate matters more for VR than for flat video: a 180° stereo title
 * spends its pixel budget on a sphere the viewer only sees a slice of, so the
 * source files are enormous and a fixed-bitrate progressive download stalls on
 * anything but a strong connection. An HLS ladder lets the player drop a rung
 * instead of buffering.
 *
 * Packaging is CPU-bound and slow. It must not run on a machine that is also
 * serving requests - see `AVR_WORKER` in the README.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** @returns {Promise<boolean>} */
export async function ffmpegAvailable() {
    try {
        await run(FFPROBE, ['-version'], { timeoutMs: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read duration, dimensions and stream layout from a media file.
 *
 * Inspects every stream rather than just `v:0`, because whether the source has
 * an audio track changes how the HLS variant map has to be built - and getting
 * that wrong makes ffmpeg fail outright rather than silently.
 *
 * @param {string} filePath
 * @returns {Promise<{duration: number, width: number, height: number, codec: string|null,
 *                    bitrate: number|null, hasAudio: boolean}>}
 */
export async function probe(filePath) {
    const { stdout } = await run(
        FFPROBE,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeoutMs: 60_000 }
    );

    const parsed = JSON.parse(stdout || '{}');
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video') ?? {};
    const format = parsed.format ?? {};

    return {
        duration: Number(format.duration) || 0,
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        codec: video.codec_name ?? null,
        bitrate: Number(format.bit_rate) || null,
        hasAudio: streams.some((s) => s.codec_type === 'audio')
    };
}

/**
 * Choose an ABR ladder.
 *
 * Rungs are picked from the source height and never upscale. Stereo sources get
 * a bitrate multiplier: side-by-side and over-under pack two eyes into one
 * frame, so the same nominal resolution carries twice the information and looks
 * soft at flat-video bitrates.
 *
 * @param {{width: number, height: number}} source
 * @param {object} format - Resolved media format.
 * @returns {Array<{height: number, bitrate: number, name: string}>}
 */
export function buildLadder(source, format) {
    const stereoFactor = format?.stereo && format.stereo !== STEREO.MONO ? 1.6 : 1;

    const rungs = [
        { height: 4320, bitrate: 60_000 },
        { height: 2880, bitrate: 32_000 },
        { height: 2160, bitrate: 18_000 },
        { height: 1440, bitrate: 10_000 },
        { height: 1080, bitrate: 6000 },
        { height: 720, bitrate: 3000 },
        { height: 480, bitrate: 1400 }
    ];

    const sourceHeight = source.height || 1080;

    const selected = rungs
        .filter((rung) => rung.height <= sourceHeight)
        // Keep the ladder short; each extra rung is another full transcode.
        .slice(0, 4)
        .map((rung) => ({
            height: rung.height,
            bitrate: Math.round(rung.bitrate * stereoFactor),
            name: `${rung.height}p`
        }));

    // A source shorter than the lowest rung still needs one variant.
    return selected.length ? selected : [{ height: sourceHeight, bitrate: Math.round(2000 * stereoFactor), name: `${sourceHeight}p` }];
}

/**
 * Transcode into an HLS ABR ladder.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath
 * @param {string} opts.outputDir
 * @param {object} opts.format - Resolved media format.
 * @param {{width: number, height: number}} [opts.probed]
 * @param {(pct: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{masterPath: string, variants: object[], duration: number}>}
 */
export async function packageHls({ sourcePath, outputDir, format, probed, onProgress, signal }) {
    const info = probed ?? (await probe(sourcePath));
    const ladder = buildLadder(info, format);

    await fs.mkdir(outputDir, { recursive: true });

    const args = ['-hide_banner', '-y', '-i', sourcePath];
    const filters = [];
    const varStreamMap = [];

    // Silent sources are common for VR - drone and 360 rig footage often has no
    // usable audio track. Declaring `a:0` in the variant map when no audio
    // stream exists makes ffmpeg abort with "Unable to map stream at a:0", so
    // the map has to match what is actually being encoded.
    const hasAudio = info.hasAudio ?? false;

    ladder.forEach((rung, i) => {
        // -2 keeps width even and preserves aspect, which H.264 requires.
        filters.push(`[0:v]scale=-2:${rung.height}[v${i}]`);

        args.push('-map', `[v${i}]`);
        args.push(`-c:v:${i}`, 'libx264');
        args.push(`-b:v:${i}`, `${rung.bitrate}k`);
        args.push(`-maxrate:v:${i}`, `${Math.round(rung.bitrate * 1.15)}k`);
        args.push(`-bufsize:v:${i}`, `${rung.bitrate * 2}k`);
        args.push(`-preset:v:${i}`, process.env.AVR_X264_PRESET || 'veryfast');
        args.push(`-profile:v:${i}`, 'high');
        args.push(`-g:v:${i}`, '48', `-keyint_min:v:${i}`, '48', `-sc_threshold:v:${i}`, '0');

        varStreamMap.push(hasAudio ? `v:${i},a:${i},name:${rung.name}` : `v:${i},name:${rung.name}`);
    });

    if (hasAudio) {
        // One audio rendition per video rung, because HLS variant streams pair
        // them one-to-one.
        ladder.forEach((_, i) => {
            args.push('-map', 'a:0');
            args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, '128k', `-ac:a:${i}`, '2');
        });
    }

    args.push('-filter_complex', filters.join(';'));
    args.push('-f', 'hls');
    args.push('-hls_time', '6');
    args.push('-hls_playlist_type', 'vod');
    args.push('-hls_flags', 'independent_segments');
    args.push('-hls_segment_filename', path.join(outputDir, 'v%v', 'seg_%05d.ts'));
    args.push('-master_pl_name', 'master.m3u8');
    args.push('-var_stream_map', varStreamMap.join(' '));
    args.push(path.join(outputDir, 'v%v', 'index.m3u8'));

    // `%v` in the segment path expands to the rung's `name:`, not its index, so
    // these are the directories that actually get written. Creating them up
    // front keeps this working on ffmpeg builds that will not mkdir for you.
    for (const rung of ladder) {
        await fs.mkdir(path.join(outputDir, `v${rung.name}`), { recursive: true });
    }

    await run(FFMPEG, args, {
        signal,
        // Transcoding an 8K master is measured in hours, not minutes.
        timeoutMs: Number(process.env.AVR_PACKAGE_TIMEOUT_MS) || 6 * 3600 * 1000,
        onStderr: (chunk) => {
            if (!onProgress || !info.duration) return;
            const match = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(chunk);
            if (!match) return;

            const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
            onProgress(Math.min(99, Math.round((seconds / info.duration) * 100)));
        }
    });

    return {
        masterPath: path.join(outputDir, 'master.m3u8'),
        variants: ladder,
        duration: info.duration
    };
}

/**
 * Extract a poster frame.
 *
 * Seeks 10% in rather than to zero, because the first frame of almost anything
 * is black.
 */
export async function extractPoster(sourcePath, outputPath, { duration = 0 } = {}) {
    const at = duration > 0 ? Math.min(duration * 0.1, 60) : 3;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await run(
        FFMPEG,
        ['-hide_banner', '-y', '-ss', String(at), '-i', sourcePath, '-frames:v', '1', '-q:v', '3', outputPath],
        { timeoutMs: 120_000 }
    );

    return outputPath;
}

/* ------------------------------------------------------------------ runner -- */

function run(command, args, { timeoutMs = 30_000, onStderr, signal } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            child.kill('SIGKILL');
            reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const onAbort = () => {
            child.kill('SIGKILL');
            reject(new Error(`${command} aborted`));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (d) => {
            stdout += d;
        });

        child.stderr.on('data', (d) => {
            const text = String(d);
            // ffmpeg is extremely chatty; keep only a tail for error reporting.
            stderr = (stderr + text).slice(-8000);
            onStderr?.(text);
        });

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            fn(value);
        };

        child.on('error', (err) =>
            finish(reject, new Error(`${command} failed to start: ${err.message}. Is it installed and on PATH?`))
        );

        child.on('close', (code) => {
            if (code === 0) finish(resolve, { stdout, stderr });
            else finish(reject, new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`));
        });
    });
}
