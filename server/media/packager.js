import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { STEREO } from '../../src/catalog/media-format.js';
import { watermarkFilters, watermarkSource } from './watermark.js';

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

/** Every rung we know how to make, highest first. */
const RUNGS = [
    { height: 4320, bitrate: 60_000 },
    { height: 2880, bitrate: 32_000 },
    { height: 2160, bitrate: 18_000 },
    { height: 1440, bitrate: 10_000 },
    { height: 1080, bitrate: 6000 },
    { height: 720, bitrate: 3000 },
    { height: 480, bitrate: 1400 }
];

/** How many rungs a ladder gets. Each one is another full encode of the source. */
const LADDER_SIZE = Math.max(1, Number(process.env.AVR_LADDER_RUNGS) || 5);

/**
 * Choose an ABR ladder.
 *
 * Rungs are picked from the source height and never upscale. Stereo sources get
 * a bitrate multiplier: side-by-side and over-under pack two eyes into one
 * frame, so the same nominal resolution carries twice the information and looks
 * soft at flat-video bitrates.
 *
 * The rungs are *spread* across the available range rather than taken from the
 * top of it. That distinction is the difference between an adaptive ladder and
 * a set of large files: taking the top four rungs of an 8K source produced
 * 4320/2880/2160/1440, a range of 60 Mbps down to 10 Mbps, so a viewer whose
 * link could not hold 10 Mbps had nothing to fall back to and simply buffered.
 * A ladder has to reach the bottom of the range or it cannot adapt, and the
 * bottom rung is the one that decides whether a title plays at all on a hotel
 * connection.
 *
 * @param {{width?: number, height: number}} source
 * @param {object} format - Resolved media format.
 * @param {{count?: number}} [opts]
 * @returns {Array<{height: number, width: number|null, bitrate: number, name: string}>}
 */
export function buildLadder(source, format, { count = LADDER_SIZE } = {}) {
    const stereoFactor = format?.stereo && format.stereo !== STEREO.MONO ? 1.6 : 1;
    const sourceHeight = source?.height || 1080;
    const sourceWidth = source?.width || 0;

    const finish = (rung) => ({
        height: rung.height,
        // Carried so that surfaces which must state a resolution - DLNA's
        // `res@resolution`, DeoVR's quality menu - do not have to re-derive it
        // and disagree with each other. Even, because H.264 requires it and
        // `scale=-2` will round to the same value.
        width: sourceWidth && sourceHeight ? 2 * Math.round((rung.height * sourceWidth) / sourceHeight / 2) : null,
        bitrate: Math.round(rung.bitrate * stereoFactor),
        name: `${rung.height}p`
    });

    const candidates = RUNGS.filter((rung) => rung.height <= sourceHeight);

    // A source shorter than the lowest rung still needs one variant.
    if (!candidates.length) return [finish({ height: sourceHeight, bitrate: 2000 })];
    if (candidates.length <= count) return candidates.map(finish);

    // Evenly spaced by index, which keeps both ends: the top rung is what the
    // title is worth on a good link, the bottom one is what makes it playable
    // on a bad one, and neither is negotiable.
    const picked = new Set();
    for (let i = 0; i < count; i++) {
        picked.add(Math.round((i * (candidates.length - 1)) / (count - 1)));
    }

    return [...picked].sort((a, b) => a - b).map((i) => finish(candidates[i]));
}

/** Which codecs to package. H.264 alone by default; see `docs/DELIVERY.md`. */
export function packagedCodecs() {
    const raw = (process.env.AVR_PACKAGE_CODECS || 'h264')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'h264' || s === 'hevc');

    return raw.length ? [...new Set(raw)] : ['h264'];
}

/**
 * Encoder settings per codec.
 *
 * HEVC carries the same picture at roughly 60% of the bitrate, which is the
 * whole reason to offer it: it is what puts an 8K rung inside a standalone
 * headset's Wi-Fi budget. `hvc1` rather than the default `hev1` tag because
 * Apple's players - Safari, visionOS, AVFoundation - reject `hev1` in MP4 and
 * fall back to nothing.
 */
function codecSettings(codec) {
    if (codec === 'hevc') {
        return { encoder: 'libx265', factor: 0.6, mp4Tag: 'hvc1', profile: 'main' };
    }
    return { encoder: 'libx264', factor: 1, mp4Tag: null, profile: 'high' };
}

/**
 * Transcode into an HLS ABR ladder, with the brand mark burned in.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath
 * @param {string} opts.outputDir
 * @param {object} opts.format - Resolved media format.
 * @param {{width: number, height: number}} [opts.probed]
 * @param {string} [opts.codec] - `h264` (default) or `hevc`.
 * @param {(pct: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{masterPath: string, variants: object[], duration: number,
 *                    codec: string, watermarked: boolean}>}
 */
export async function packageHls({ sourcePath, outputDir, format, probed, codec = 'h264', onProgress, signal }) {
    const info = probed ?? (await probe(sourcePath));
    const ladder = buildLadder(info, format);
    const settings = codecSettings(codec);

    await fs.mkdir(outputDir, { recursive: true });

    const args = ['-hide_banner', '-y', '-i', sourcePath];
    const filters = [];
    const varStreamMap = [];

    // Silent sources are common for VR - drone and 360 rig footage often has no
    // usable audio track. Declaring `a:0` in the variant map when no audio
    // stream exists makes ffmpeg abort with "Unable to map stream at a:0", so
    // the map has to match what is actually being encoded.
    const hasAudio = info.hasAudio ?? false;

    // The mark goes on once, at full resolution, ahead of the split - so every
    // rung inherits it and no rung can be published without it.
    const markPath = watermarkSource();
    const mark = markPath
        ? watermarkFilters({ width: info.width, height: info.height, format, inputIndex: 1 })
        : null;

    let source = '0:v';
    if (mark) {
        args.push('-i', markPath);
        filters.push(...mark.filters);
        source = mark.outLabel;
    }

    // `[0:v]` would be auto-split by ffmpeg; a label produced inside the graph
    // has to be split by hand or the second rung fails to find its input.
    if (ladder.length > 1 && source !== '0:v') {
        filters.push(`[${source}]split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')}`);
    }

    ladder.forEach((rung, i) => {
        const input = source === '0:v' ? '0:v' : ladder.length > 1 ? `s${i}` : source;

        // -2 keeps width even and preserves aspect, which H.264 requires.
        filters.push(`[${input}]scale=-2:${rung.height}[v${i}]`);

        const bitrate = Math.round(rung.bitrate * settings.factor);

        args.push('-map', `[v${i}]`);
        args.push(`-c:v:${i}`, settings.encoder);
        args.push(`-b:v:${i}`, `${bitrate}k`);
        args.push(`-maxrate:v:${i}`, `${Math.round(bitrate * 1.15)}k`);
        args.push(`-bufsize:v:${i}`, `${bitrate * 2}k`);
        args.push(`-preset:v:${i}`, process.env.AVR_X264_PRESET || 'veryfast');
        args.push(`-profile:v:${i}`, settings.profile);
        args.push(`-g:v:${i}`, '48', `-keyint_min:v:${i}`, '48', `-sc_threshold:v:${i}`, '0');

        // Recorded at what was actually asked for, not at the table value, so
        // the HEVC discount reaches the manifest the players read.
        rung.bitrate = bitrate;
        rung.codec = codec;

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
        duration: info.duration,
        codec,
        watermarked: !!mark
    };
}

/**
 * Remux each HLS rung into a standalone progressive MP4.
 *
 * Not every client speaks HLS. SkyBox and Pigasus browse by DLNA and expect a
 * file they can byte-range; Whirligig takes a URL from an M3U and does the
 * same; a plain download is a file or it is nothing. Those surfaces used to be
 * handed the *source* - which is the one file on the server with no brand mark
 * on it and no bitrate choice behind it.
 *
 * This costs no CPU. The rungs have already been encoded; `-c copy` lifts the
 * same packets out of the MPEG-TS segments and writes them into MP4, so the
 * only expense is reading and writing the bytes once. `+faststart` then moves
 * the index to the front of the file, without which a headset seeking in a
 * 30 GB file over Wi-Fi has to fetch the tail before it can show a frame.
 *
 * A rung that fails to remux is skipped rather than fatal: the HLS ladder is
 * the primary delivery path and is already written by the time this runs.
 *
 * @param {object} opts
 * @param {string} opts.outputDir - The directory `packageHls` wrote into.
 * @param {object[]} opts.variants - Its returned `variants`.
 * @param {boolean} [opts.hasAudio]
 * @param {string} [opts.codec]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{name: string, file: string, bytes: number}>>}
 */
export async function packageProgressive({ outputDir, variants, hasAudio = true, codec = 'h264', signal }) {
    const mp4Dir = path.join(outputDir, 'mp4');
    await fs.mkdir(mp4Dir, { recursive: true });

    const { mp4Tag } = codecSettings(codec);
    const made = [];

    for (const rung of variants) {
        const playlist = path.join(outputDir, `v${rung.name}`, 'index.m3u8');
        const target = path.join(mp4Dir, `${rung.name}.mp4`);

        const args = ['-hide_banner', '-y', '-i', playlist, '-c', 'copy'];

        // AAC comes out of MPEG-TS with ADTS headers, which MP4 has no place
        // for. Without this the file is written and plays silence.
        if (hasAudio) args.push('-bsf:a', 'aac_adtstoasc');
        if (mp4Tag) args.push('-tag:v', mp4Tag);

        args.push('-movflags', '+faststart', target);

        try {
            await run(FFMPEG, args, { signal, timeoutMs: Number(process.env.AVR_REMUX_TIMEOUT_MS) || 3600 * 1000 });
            const stat = await fs.stat(target);
            made.push({ name: rung.name, file: target, bytes: stat.size });
        } catch (err) {
            console.warn(`[packager] progressive remux failed for ${rung.name}: ${err.message}`);
        }
    }

    return made;
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
