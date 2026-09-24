import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * FFmpeg discovery and command construction.
 *
 * This is the piece that moves to AWS. Everything here is deliberately plain
 * FFmpeg with no macOS-specific codepaths: the same argument vector that runs
 * against Homebrew's build on a Mac runs against a Debian container on ECS,
 * which is the whole point of testing locally first. The one place that is
 * allowed to differ is the encoder name, and it is opt-in - see `AVR_TRANSCODE_HWACCEL`.
 *
 * On the division of labour: the phone performs the *contribution* encode, and
 * cannot be relieved of it. Two raw 1080p30 streams are about 1.5 Gbps and no
 * network between a phone and a server - LAN or AWS - will carry that. What
 * runs here is the *transcode*: taking that single high-quality contribution
 * feed and turning it into the several renditions that viewers actually
 * receive. That split is not a compromise, it is the same architecture AWS
 * Elemental MediaLive and IVS use, and moving this module to either of them is
 * a deployment change rather than a redesign.
 */

const execFileAsync = promisify(execFile);

export const FFMPEG_PATH = process.env.AVR_FFMPEG || 'ffmpeg';

/**
 * Rungs of the adaptive ladder, coarsest first.
 *
 * Heights are *per eye*: a 1080 rung is a 3840x1080 side-by-side frame. The
 * default is two rungs rather than the customary three or four because these
 * are very wide frames and the encode has to keep up with real time. A third
 * rung is a configuration change, not a code change - but check `speed=` in
 * the FFmpeg progress output stays above 1.0 before adding one.
 */
const DEFAULT_LADDER = [
    { name: '1080p', height: 1080, bitrate: 12_000_000 },
    { name: '540p', height: 540, bitrate: 3_500_000 }
];

/**
 * Parse `AVR_TRANSCODE_LADDER`, e.g. `1080p@12M,720p@6M,540p@3M`.
 *
 * @returns {{name: string, height: number, bitrate: number}[]}
 */
export function ladder(spec = process.env.AVR_TRANSCODE_LADDER) {
    if (!spec) return DEFAULT_LADDER;

    const rungs = [];

    for (const entry of String(spec).split(',')) {
        const match = /^\s*(\d+)p?@([\d.]+)([KMkm]?)\s*$/.exec(entry);
        if (!match) continue;

        const height = Number(match[1]);
        const scale = match[3].toLowerCase() === 'm' ? 1e6 : match[3].toLowerCase() === 'k' ? 1e3 : 1;
        const bitrate = Math.round(Number(match[2]) * scale);

        if (height > 0 && bitrate > 0) {
            rungs.push({ name: `${height}p`, height, bitrate });
        }
    }

    return rungs.length ? rungs.sort((a, b) => b.height - a.height) : DEFAULT_LADDER;
}

/**
 * Is FFmpeg present, and which version?
 *
 * @returns {Promise<{available: boolean, version?: string, error?: string}>}
 */
export async function probe() {
    try {
        const { stdout } = await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-version'], {
            timeout: 5000
        });

        const version = /^ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown';
        return { available: true, version };
    } catch (err) {
        return {
            available: false,
            error:
                err.code === 'ENOENT'
                    ? `ffmpeg not found at "${FFMPEG_PATH}". Install it (brew install ffmpeg) or set AVR_FFMPEG.`
                    : err.message
        };
    }
}

/**
 * Which encoder to use.
 *
 * `libx264` by default even on a Mac that has a perfectly good hardware
 * encoder, because the hardware path produces different output at different
 * speed and quality, and testing locally is only useful if it tests what will
 * actually be deployed. Set `AVR_TRANSCODE_HWACCEL=1` when you want throughput
 * on the Mac and are willing to accept that it is no longer a rehearsal.
 */
export function encoderName() {
    return process.env.AVR_TRANSCODE_HWACCEL === '1' ? 'h264_videotoolbox' : 'libx264';
}

/**
 * Build the argument vector for one session.
 *
 * @param {object} options
 * @param {'h264'|'hevc'} options.inputCodec - What the phone is sending.
 * @param {boolean} options.stereo - Two input pipes rather than one.
 * @param {number} options.frameRate
 * @param {number} options.sourceWidth - Per-eye width from the phone.
 * @param {number} options.sourceHeight
 * @param {string} options.outputDir - Already created, with a subdirectory per rung.
 * @param {{name: string, height: number, bitrate: number}[]} options.rungs
 * @param {number} options.segmentSeconds
 * @param {number} options.playlistLength
 * @param {boolean} options.audio - Whether a third pipe carries ADTS-wrapped
 *   AAC. Not a format: the sample rate and channel count are in the ADTS
 *   headers, so FFmpeg reads them off the stream rather than being told.
 * @returns {string[]}
 */
export function buildArgs({
    inputCodec = 'h264',
    stereo = true,
    frameRate = 30,
    sourceWidth = 1920,
    sourceHeight = 1080,
    outputDir,
    rungs = ladder(),
    segmentSeconds = 1,
    playlistLength = 6,
    audio = false
}) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:2', '-stats_period', '2'];

    // Timestamps are the whole problem with feeding raw elementary streams.
    // A bare Annex B stream carries none, so FFmpeg would invent them at a
    // fixed rate and any frame the phone dropped would shift that eye forward
    // by one frame *permanently* - a stereo pair that slides apart over the
    // course of a broadcast. Stamping each packet with the arrival wallclock
    // instead keeps a dropped frame as a real gap, and the `fps` filter below
    // fills the gap by duplication rather than by shifting everything after it.
    const input = (fd) => [
        '-use_wallclock_as_timestamps', '1',
        '-f', inputCodec,
        '-framerate', String(frameRate),
        '-i', `pipe:${fd}`
    ];

    args.push(...input(3));
    if (stereo) args.push(...input(4));

    // Sound, on its own pipe, from the same wallclock as the pictures. An ADTS
    // stream is self-describing, so there is nothing to declare but the format.
    if (audio) {
        args.push(
            '-use_wallclock_as_timestamps', '1',
            '-f', 'aac',
            '-i', 'pipe:5'
        );
    }

    const audioInput = stereo ? 2 : 1;

    args.push('-filter_complex', filterGraph({ stereo, frameRate, sourceWidth, sourceHeight, rungs }));

    const mapping = [];

    rungs.forEach((rung, index) => {
        args.push('-map', `[v${index}]`);
        args.push(...encoderArgs(index, rung, frameRate, segmentSeconds));

        // The same sound on every rung, remuxed rather than re-encoded. It is
        // already AAC-LC at a bitrate that is a rounding error beside the
        // video, so a second encode would cost CPU this process does not have
        // to spare and give back nothing but generation loss. Mapped once per
        // variant, immediately after its video, because `-var_stream_map` reads
        // output stream indices in the order they were mapped.
        if (audio) args.push('-map', `${audioInput}:a:0`, `-c:a:${index}`, 'copy');

        // `name:` uses a colon, unlike every other key-value pair in FFmpeg's
        // argument syntax. It is what makes `%v` expand to a readable directory
        // name rather than a bare stream index.
        mapping.push(audio ? `v:${index},a:${index},name:${rung.name}` : `v:${index},name:${rung.name}`);
    });

    args.push(
        '-f', 'hls',
        '-hls_time', String(segmentSeconds),
        '-hls_list_size', String(playlistLength),
        '-hls_delete_threshold', '2',
        '-hls_segment_type', 'mpegts',

        // `delete_segments` keeps the directory from growing without bound over
        // a long broadcast. `temp_file` means a player never reads a segment
        // that is still being written, which otherwise shows up as an
        // intermittent decode error that is very hard to attribute.
        // `program_date_time` is what lets a viewer's clock be compared against
        // the broadcast's, and is how latency gets measured rather than guessed.
        '-hls_flags', 'delete_segments+temp_file+independent_segments+program_date_time',

        '-hls_segment_filename', `${outputDir}/%v/seg_%05d.ts`,
        '-master_pl_name', 'master.m3u8',
        '-master_pl_publish_rate', '5',
        '-var_stream_map', mapping.join(' '),
        `${outputDir}/%v/stream.m3u8`
    );

    return args;
}

/**
 * Compose the two eyes and split into one branch per rung.
 *
 * The eyes are stacked horizontally into a single frame. That is what every
 * VR player expects of a stereo HLS stream - there is no standard for
 * delivering the eyes as separate HLS tracks, which is precisely why the
 * WebSocket relay exists alongside this and keeps them separate for the
 * monitor. Here, compatibility wins.
 */
function filterGraph({ stereo, frameRate, sourceWidth, sourceHeight, rungs }) {
    const parts = [];

    // `fps` before anything else: it converts each eye onto a common constant
    // frame rate, duplicating across gaps and dropping duplicates, so `hstack`
    // is always presented with two frames that belong to the same instant.
    parts.push(`[0:v]fps=${frameRate},setsar=1[l]`);

    if (stereo) {
        parts.push(`[1:v]fps=${frameRate},setsar=1[r]`);
        parts.push('[l][r]hstack=inputs=2,format=yuv420p[sbs]');
    } else {
        parts.push('[l]format=yuv420p[sbs]');
    }

    const eyes = stereo ? 2 : 1;
    const outputs = rungs.map((_, index) => `[s${index}]`).join('');
    parts.push(`[sbs]split=${rungs.length}${outputs}`);

    rungs.forEach((rung, index) => {
        // Width is derived from the source aspect so a non-16:9 capture is not
        // silently squashed, and rounded to an even number because 4:2:0 chroma
        // is subsampled by two in each direction.
        const perEye = even(Math.round((rung.height * sourceWidth) / sourceHeight));
        const width = perEye * eyes;
        const height = even(rung.height);

        parts.push(`[s${index}]scale=${width}:${height}:flags=bicubic[v${index}]`);
    });

    return parts.join(';');
}

function even(value) {
    return value % 2 === 0 ? value : value + 1;
}

function encoderArgs(index, rung, frameRate, segmentSeconds) {
    const encoder = encoderName();

    // Every segment must start with a keyframe or a player cannot switch
    // rendition without a visible glitch, so the GOP is pinned to the segment
    // length and scene-cut detection - which would insert keyframes at other
    // moments - is switched off.
    const gop = Math.max(1, Math.round(frameRate * segmentSeconds));

    const common = [
        `-b:v:${index}`, String(rung.bitrate),
        `-maxrate:v:${index}`, String(Math.round(rung.bitrate * 1.1)),
        `-bufsize:v:${index}`, String(rung.bitrate * 2),
        `-g:v:${index}`, String(gop),
        `-keyint_min:v:${index}`, String(gop),
        `-r:v:${index}`, String(frameRate)
    ];

    if (encoder === 'h264_videotoolbox') {
        return [`-c:v:${index}`, encoder, `-realtime:v:${index}`, '1', ...common];
    }

    return [
        `-c:v:${index}`, 'libx264',
        `-preset:v:${index}`, process.env.AVR_TRANSCODE_PRESET || 'veryfast',
        `-tune:v:${index}`, 'zerolatency',
        `-profile:v:${index}`, 'high',
        `-sc_threshold:v:${index}`, '0',
        ...common
    ];
}
