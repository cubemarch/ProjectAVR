import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { titles } from '../db/index.js';
import { getStorage } from '../storage/index.js';
import { invalidateCatalog } from '../library.js';
import { resolveFormat } from '../../src/catalog/media-format.js';
import { probe, packageHls, extractPoster, ffmpegAvailable } from './packager.js';

/**
 * Post-upload processing.
 *
 * Whether this runs at all is a deployment decision, not a code path:
 *
 *   AVR_WORKER=1  this process picks jobs off the queue and transcodes.
 *   unset         jobs are recorded and left for a dedicated worker fleet.
 *
 * That split matters. Transcoding an 8K stereo master pins every core for
 * hours; doing it on a machine that is also answering requests turns one upload
 * into a site-wide latency spike. Web nodes should run with `AVR_WORKER` unset
 * and scale on request load, while a separate pool scales on queue depth.
 *
 * The queue is in-memory, which is honest about its limits: it survives neither
 * a restart nor a second node. Swapping it for a real broker means
 * reimplementing `enqueue` and the loop in `drain` - deliberately the only two
 * places that know how work is dispatched.
 */

const WORKER_ENABLED = process.env.AVR_WORKER === '1';
const CONCURRENCY = Math.max(1, Number(process.env.AVR_WORKER_CONCURRENCY) || 1);

const queue = [];
const running = new Set();

let ffmpegChecked = null;

/**
 * @param {{titleId: string, sourcePath: string, cleanupSource?: boolean}} job
 */
export function enqueueProcessing(job) {
    queue.push(job);
    titles.setStatus(job.titleId, 'processing', 'Queued for processing');
    invalidateCatalog();

    if (WORKER_ENABLED) setImmediate(drain);
    return { queued: true, position: queue.length, workerEnabled: WORKER_ENABLED };
}

export function queueStats() {
    return { pending: queue.length, running: running.size, workerEnabled: WORKER_ENABLED, concurrency: CONCURRENCY };
}

function drain() {
    while (running.size < CONCURRENCY && queue.length) {
        const job = queue.shift();
        const promise = processTitle(job)
            .catch((err) => {
                console.error(`[jobs] ${job.titleId} failed:`, err.message);
                titles.setStatus(job.titleId, 'failed', err.message.slice(0, 500));
                invalidateCatalog();
            })
            .finally(() => {
                running.delete(promise);
                if (queue.length) setImmediate(drain);
            });

        running.add(promise);
    }
}

/**
 * Probe, package and publish one title.
 *
 * @param {{titleId: string, sourcePath: string, cleanupSource?: boolean}} job
 */
async function processTitle({ titleId, sourcePath, cleanupSource = false }) {
    const title = titles.byId(titleId);
    if (!title) return;

    ffmpegChecked ??= await ffmpegAvailable();

    const storage = getStorage();
    const format = resolveFormat({
        projection: title.projection,
        stereo: title.stereo,
        fisheyeFov: title.fisheye_fov,
        lens: title.lens,
        src: title.source_key ?? ''
    });

    // Probing is cheap and useful even without a transcode: it fills in the
    // duration and dimensions the browse UI and DeoVR feed both want.
    if (ffmpegChecked) {
        titles.setStatus(titleId, 'processing', 'Reading media metadata');

        const info = await probe(sourcePath);
        titles.update(titleId, {
            duration: info.duration,
            width: info.width,
            height: info.height
        });
    }

    if (!ffmpegChecked || process.env.AVR_SKIP_TRANSCODE === '1') {
        // No ffmpeg, or transcoding deliberately disabled: publish the original.
        // Progressive delivery still works, it just cannot adapt to bandwidth.
        titles.setStatus(titleId, 'ready', ffmpegChecked ? null : 'Ready (no HLS - ffmpeg unavailable)');
        invalidateCatalog();
        return;
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'avr-pkg-'));

    try {
        titles.setStatus(titleId, 'processing', 'Packaging HLS 0%');

        const probed = await probe(sourcePath);
        const { variants } = await packageHls({
            sourcePath,
            outputDir: workDir,
            format,
            probed,
            onProgress: (pct) => titles.setStatus(titleId, 'processing', `Packaging HLS ${pct}%`)
        });

        titles.setStatus(titleId, 'processing', 'Uploading renditions');

        const hlsPrefix = `hls/${title.creator_id}/${titleId}`;
        await uploadTree(storage, workDir, hlsPrefix);

        // Poster extraction is a nicety; a failure here must not fail the title.
        let posterKey = title.poster_key;
        try {
            const posterPath = path.join(workDir, 'poster.jpg');
            await extractPoster(sourcePath, posterPath, { duration: probed.duration });
            posterKey = `art/${title.creator_id}/${titleId}/poster.jpg`;
            await storage.putStream(posterKey, (await fs.open(posterPath)).createReadStream());
        } catch (err) {
            console.warn(`[jobs] poster extraction failed for ${titleId}: ${err.message}`);
        }

        titles.update(titleId, {
            hlsKey: `${hlsPrefix}/master.m3u8`,
            posterKey,
            duration: probed.duration,
            width: probed.width,
            height: probed.height
        });

        titles.setStatus(titleId, 'ready', `${variants.length} rendition(s)`);
        invalidateCatalog();
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
        if (cleanupSource) await fs.rm(sourcePath, { force: true });
    }
}

/** Recursively upload a packaged directory, preserving relative keys. */
async function uploadTree(storage, dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            await uploadTree(storage, full, `${prefix}/${entry.name}`);
            continue;
        }

        // The poster is uploaded separately under its own key.
        if (entry.name === 'poster.jpg') continue;

        const handle = await fs.open(full);
        try {
            await storage.putStream(`${prefix}/${entry.name}`, handle.createReadStream());
        } finally {
            await handle.close();
        }
    }
}

export { WORKER_ENABLED };
