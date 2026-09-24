import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { sessions as defaultRegistry } from '../live/sessions.js';
import { rooms } from '../live/rooms.js';
import { TranscodePipeline } from './pipeline.js';
import { probe, ladder, encoderName, FFMPEG_PATH } from './ffmpeg.js';

/**
 * The transcode tier.
 *
 * Every live session gets an FFmpeg process that turns the phone's
 * contribution feed into a side-by-side HLS ladder. This is the half of the
 * system designed to be lifted onto AWS: nothing in `server/transcode` touches
 * a socket, a camera or a platform API, and the FFmpeg invocation is the same
 * one a Linux container would run. Deploying it means running this module
 * beside (or instead of) the app tier and pointing `AVR_TRANSCODE_DIR` at a
 * shared volume or an S3-backed mount.
 *
 * Why HLS and not just the existing WebSocket relay: the relay delivers each
 * eye as a separate WebCodecs stream with about 200 ms of latency, which is
 * ideal for the person holding the camera and useless for everyone else -
 * WebCodecs is not available in Safari's immersive path, on Vision Pro, or in
 * DeoVR, and a relay fans out linearly from one server. HLS is slower (see the
 * latency note below) but plays everywhere and puts a CDN between the server
 * and the audience. Both run at once, from one ingest.
 *
 * On latency, honestly: this produces roughly `segment length x playlist
 * length / 2` of delay, which at the defaults is about 3 seconds. FFmpeg's HLS
 * muxer does not implement Low-Latency HLS partial segments, so sub-second HLS
 * is not available by tuning these numbers - it would need a different
 * packager. Three seconds is normal for live HLS and is why the relay is still
 * there for the operator.
 */

const ENABLED = process.env.AVR_TRANSCODE !== '0';

/** Where segments are written. Ephemeral by design - nothing here is archived. */
const OUTPUT_ROOT = process.env.AVR_TRANSCODE_DIR || path.join(os.tmpdir(), 'avr-live-hls');

const SEGMENT_SECONDS = Number(process.env.AVR_TRANSCODE_SEGMENT || 1);
const PLAYLIST_LENGTH = Number(process.env.AVR_TRANSCODE_WINDOW || 6);

/** @type {Map<string, TranscodePipeline>} */
const pipelines = new Map();

let registry = defaultRegistry;
let available = false;
let unavailableReason = 'not started';
let version = null;
let attached = false;

/**
 * Serve the HLS output and report transcode state.
 *
 * @param {import('express').Express} app
 */
export function mountTranscode(app, { registry: injected } = {}) {
    if (injected) registry = injected;

    const router = express.Router();

    // Playlists must never be cached - they are rewritten every segment - but
    // segments are immutable once written, so they can be cached hard. Getting
    // this backwards is the classic cause of a live stream that plays the same
    // four seconds forever.
    router.use(
        '/hls',
        express.static(OUTPUT_ROOT, {
            index: false,
            fallthrough: false,
            setHeaders(res, filePath) {
                if (filePath.endsWith('.m3u8')) {
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                } else {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }

                // A headset browser reaching this from a different origin - or
                // from a DeoVR shell - needs CORS. The content is already on
                // the LAN and behind a stream key at ingest.
                res.setHeader('Access-Control-Allow-Origin', '*');
            }
        })
    );

    router.get('/transcode', (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({
            enabled: ENABLED,
            available,
            reason: available ? null : unavailableReason,
            ffmpeg: { path: FFMPEG_PATH, version },
            encoder: encoderName(),
            outputRoot: OUTPUT_ROOT,
            segmentSeconds: SEGMENT_SECONDS,
            playlistLength: PLAYLIST_LENGTH,
            approximateLatencySeconds: Math.round((SEGMENT_SECONDS * PLAYLIST_LENGTH) / 2),
            ladder: ladder(),
            sessions: [...pipelines.values()].map((pipeline) => pipeline.summary())
        });
    });

    router.get('/transcode/:sessionId', (req, res) => {
        const pipeline = pipelines.get(String(req.params.sessionId).toUpperCase());
        if (!pipeline) return res.status(404).json({ error: 'no transcode for that session' });

        res.set('Cache-Control', 'no-store');
        res.json(pipeline.summary());
    });

    app.use('/live', router);
}

/**
 * Start watching the registry.
 *
 * Separate from `mountTranscode` because the probe is asynchronous and routes
 * have to be registered synchronously during app construction.
 */
export async function startTranscode() {
    if (!ENABLED) {
        unavailableReason = 'disabled by AVR_TRANSCODE=0';
        return { available: false, reason: unavailableReason };
    }

    const result = await probe();
    available = result.available;
    version = result.version ?? null;
    unavailableReason = result.error ?? null;

    if (!available) return { available: false, reason: unavailableReason };

    await fs.mkdir(OUTPUT_ROOT, { recursive: true });

    // Anything left behind is from a previous run. A live segment directory has
    // no meaning across a restart, and leaving them would leak disk steadily.
    await clearRoot();

    if (!attached) {
        registry.on('started', onSessionStarted);
        registry.on('ended', onSessionEnded);
        attached = true;
    }

    // Sessions that were already live when this started - only possible if the
    // transcoder is restarted independently, but cheap to handle.
    for (const session of registry.list()) onSessionStarted(session);

    return { available: true, version };
}

function onSessionStarted(session) {
    if (!available || pipelines.has(session.id)) return;

    // A broadcast a creator started for one chosen viewer gets no HLS mirror.
    // The segment directory is plain static files with `Access-Control-Allow-
    // Origin: *` on them - correct for a public LAN stream and a CDN in front
    // of it, and a way around the relay's admission check for a private one.
    // Not transcoding it at all is the only version of this that cannot be
    // got wrong later by someone adding a route.
    if (rooms.isPrivate(session)) return;

    const pipeline = new TranscodePipeline({
        session,
        rootDir: OUTPUT_ROOT,
        segmentSeconds: SEGMENT_SECONDS,
        playlistLength: PLAYLIST_LENGTH
    });

    pipelines.set(session.id, pipeline);

    pipeline.on('ready', () => {
        console.log(`  Transcode  ${session.id} -> ${pipeline.playlistUrl}`);
    });

    pipeline.on('warning', (message) => {
        console.warn(`  Transcode  ${session.id}: ${message}`);
    });

    pipeline.on('exit', ({ code, signal, stderr }) => {
        if (stderr) console.warn(`  Transcode  ${session.id} ffmpeg (${signal || code}):\n${stderr.trim()}`);
    });

    pipeline.attach();
}

function onSessionEnded(session) {
    const pipeline = pipelines.get(session.id);
    if (!pipeline) return;

    pipelines.delete(session.id);
    pipeline.stop('broadcast ended');
}

export function stopTranscode() {
    if (attached) {
        registry.off('started', onSessionStarted);
        registry.off('ended', onSessionEnded);
        attached = false;
    }

    for (const pipeline of pipelines.values()) pipeline.stop('server shutting down', false);
    pipelines.clear();
}

/** Playlist URL for a session, if its transcode is up. Used by the live API. */
export function playlistFor(sessionId) {
    const pipeline = pipelines.get(String(sessionId || '').toUpperCase());
    return pipeline?.state === 'running' ? pipeline.playlistUrl : null;
}

export function transcodeBanner() {
    if (!ENABLED) return [];

    // Padded to match the column the rest of the startup banner uses.
    const label = `  ${'Transcode'.padEnd(12)} `;
    const indent = ' '.repeat(label.length);

    if (!available) return [`${label}unavailable - ${unavailableReason}`];

    const rungs = ladder()
        .map((rung) => rung.name)
        .join(', ');

    return [
        `${label}ffmpeg ${version} via ${encoderName()} - HLS ladder ${rungs}`,
        `${indent}~${Math.round((SEGMENT_SECONDS * PLAYLIST_LENGTH) / 2)}s latency, segments in ${OUTPUT_ROOT}`
    ];
}

async function clearRoot() {
    try {
        const entries = await fs.readdir(OUTPUT_ROOT);
        await Promise.all(
            entries.map((entry) => fs.rm(path.join(OUTPUT_ROOT, entry), { recursive: true, force: true }))
        );
    } catch {
        /* nothing to clear */
    }
}

export { OUTPUT_ROOT };
