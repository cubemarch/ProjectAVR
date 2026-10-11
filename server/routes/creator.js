import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { titles, uploads, analytics, users } from '../db/index.js';
import { requireAuth, requireRole, loadFullUser } from '../auth/middleware.js';
import { atLeast } from '../../src/auth/roles.js';
import { getStorage, buildKey } from '../storage/index.js';
import { enqueueProcessing, queueStats } from '../media/jobs.js';
import { invalidateCatalog } from '../library.js';
import { PROJECTION, STEREO, detectFormatFromName } from '../../src/catalog/media-format.js';

/**
 * Creator portal API.
 *
 * Two upload paths, and which one is used is a scaling decision:
 *
 *   direct    - when object storage is configured, the browser gets a presigned
 *               PUT and sends the file straight to the bucket. A 40 GB master
 *               never touches this process.
 *   proxied   - local storage only. The file streams through Node to disk,
 *               which is fine for a self-host and is the thing you must not do
 *               at scale.
 *
 * Ownership is enforced on every mutating route by loading the title and
 * comparing `creator_id`, rather than trusting an id in the request body.
 */

const VALID_PROJECTIONS = new Set(Object.values(PROJECTION));
const VALID_STEREO = new Set(Object.values(STEREO));
const VALID_VISIBILITY = new Set(['public', 'unlisted', 'private']);

const MAX_UPLOAD_BYTES = Number(process.env.AVR_MAX_UPLOAD_BYTES) || 64 * 1024 * 1024 * 1024;

function slugify(value) {
    return String(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

/** Append a numeric suffix until the slug is free. */
function uniqueSlug(base) {
    const root = slugify(base) || 'untitled';
    if (!titles.slugExists(root)) return root;

    for (let i = 2; i < 500; i++) {
        const candidate = `${root}-${i}`;
        if (!titles.slugExists(candidate)) return candidate;
    }

    return `${root}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Normalise and validate a metadata patch.
 *
 * Returns only keys that were actually present, so a partial update cannot
 * blank out fields the client did not send.
 */
function sanitiseMetadata(body, { partial = false } = {}) {
    const errors = [];
    const patch = {};

    const str = (key, max, target = key) => {
        if (body[key] === undefined) return;
        const value = String(body[key]).trim();
        if (value.length > max) {
            errors.push(`${key} must be at most ${max} characters`);
            return;
        }
        patch[target] = value || null;
    };

    if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (title.length < 1 || title.length > 200) errors.push('Title must be 1-200 characters.');
        else patch.title = title;
    } else if (!partial) {
        errors.push('Title is required.');
    }

    str('synopsis', 4000);
    str('genre', 60);
    str('studio', 120);

    if (body.year !== undefined && body.year !== null && body.year !== '') {
        const year = Number(body.year);
        if (!Number.isInteger(year) || year < 1880 || year > 2200) errors.push('Year looks wrong.');
        else patch.year = year;
    }

    if (body.projection !== undefined) {
        if (!VALID_PROJECTIONS.has(body.projection)) errors.push('Unknown projection.');
        else patch.projection = body.projection;
    }

    if (body.stereo !== undefined) {
        if (!VALID_STEREO.has(body.stereo)) errors.push('Unknown stereo layout.');
        else patch.stereo = body.stereo;
    }

    if (body.fisheyeFov !== undefined && body.fisheyeFov !== null && body.fisheyeFov !== '') {
        const fov = Number(body.fisheyeFov);
        if (!Number.isFinite(fov) || fov < 100 || fov > 360) errors.push('Fisheye FOV must be 100-360°.');
        else patch.fisheyeFov = Math.round(fov);
    }

    if (body.lens !== undefined) patch.lens = body.lens ? String(body.lens).slice(0, 40) : null;

    if (body.visibility !== undefined) {
        if (!VALID_VISIBILITY.has(body.visibility)) errors.push('Unknown visibility.');
        else patch.visibility = body.visibility;
    }

    return { patch, errors };
}

/** Load a title and confirm the caller owns it (admins bypass). */
function ownedTitle(req, res) {
    const title = titles.byId(req.params.id);

    if (!title) {
        res.status(404).json({ error: 'Title not found.' });
        return null;
    }

    if (title.creator_id !== req.user.id && !atLeast(req.user.role, 'admin')) {
        // 404 rather than 403: a creator should not be able to probe for the
        // existence of other people's ids.
        res.status(404).json({ error: 'Title not found.' });
        return null;
    }

    return title;
}

/**
 * @param {import('express').Express} app
 */
export function mountCreator(app) {
    const router = express.Router();

    // No face gate here.
    //
    // Studio used to demand a face check before it would render, and that has
    // moved to the one action it is actually about: going on air. See
    // `POST /api/identity/broadcast/destination`, which still refuses without
    // a live check. The trade is deliberate and worth stating - a password now
    // protects what Studio *shows* (titles, view counts, a stream key that has
    // not been issued yet), and a face protects what Studio *does*. Nothing
    // reachable through these routes puts anybody on camera.
    router.use(requireAuth, requireRole('creator'), loadFullUser);

    /* ------------------------------------------------------------ dashboard -- */

    router.get('/overview', (req, res) => {
        const rows = analytics.forCreator(req.user.id);

        res.json({
            titles: rows,
            daily: analytics.dailyForCreator(req.user.id, 30),
            totals: {
                titles: rows.length,
                published: rows.filter((r) => r.status === 'published').length,
                views: rows.reduce((sum, r) => sum + r.views, 0),
                hoursWatched: rows.reduce((sum, r) => sum + r.seconds_watched, 0) / 3600
            },
            queue: queueStats(),
            storage: { remote: getStorage().isRemote }
        });
    });

    /* --------------------------------------------------------------- titles -- */

    router.get('/titles', (req, res) => {
        res.json({ titles: titles.listByCreator(req.user.id).map(publicTitle) });
    });

    router.get('/titles/:id', (req, res) => {
        const title = ownedTitle(req, res);
        if (title) res.json({ title: publicTitle(title) });
    });

    router.post('/titles', express.json({ limit: '64kb' }), (req, res) => {
        const { patch, errors } = sanitiseMetadata(req.body ?? {});

        if (errors.length) {
            res.status(400).json({ error: errors[0], errors });
            return;
        }

        const created = titles.create({
            creatorId: req.user.id,
            slug: uniqueSlug(patch.title),
            ...patch
        });

        res.status(201).json({ title: publicTitle(created) });
    });

    router.patch('/titles/:id', express.json({ limit: '64kb' }), (req, res) => {
        const title = ownedTitle(req, res);
        if (!title) return;

        const { patch, errors } = sanitiseMetadata(req.body ?? {}, { partial: true });

        if (errors.length) {
            res.status(400).json({ error: errors[0], errors });
            return;
        }

        const updated = titles.update(title.id, patch);
        invalidateCatalog();

        res.json({ title: publicTitle(updated) });
    });

    router.post('/titles/:id/publish', express.json({ limit: '4kb' }), (req, res) => {
        const title = ownedTitle(req, res);
        if (!title) return;

        if (!title.source_key && !title.hls_key) {
            res.status(409).json({ error: 'Upload a video file before publishing.' });
            return;
        }

        if (title.status === 'processing') {
            res.status(409).json({ error: 'Still processing. Try again when packaging finishes.' });
            return;
        }

        if (title.status === 'failed') {
            res.status(409).json({ error: `Processing failed: ${title.status_detail ?? 'unknown error'}` });
            return;
        }

        // Publishing is two independent facts: the pipeline finished (status)
        // and the creator wants an audience (visibility). Both have to be true
        // for a title to reach the public catalog.
        titles.update(title.id, {
            visibility: req.body?.visibility && VALID_VISIBILITY.has(req.body.visibility)
                ? req.body.visibility
                : title.visibility === 'private'
                  ? 'public'
                  : title.visibility
        });

        const updated = titles.setStatus(title.id, 'published');
        invalidateCatalog();

        res.json({ title: publicTitle(titles.byId(updated.id)) });
    });

    router.post('/titles/:id/unpublish', (req, res) => {
        const title = ownedTitle(req, res);
        if (!title) return;

        const updated = titles.setStatus(title.id, 'draft');
        invalidateCatalog();

        res.json({ title: publicTitle(updated) });
    });

    router.delete('/titles/:id', async (req, res) => {
        const title = ownedTitle(req, res);
        if (!title) return;

        const storage = getStorage();

        // Best-effort asset cleanup; a missing object must not block the delete.
        for (const key of [title.source_key, title.poster_key, title.backdrop_key]) {
            if (key) await storage.remove(key).catch(() => {});
        }

        titles.remove(title.id);
        invalidateCatalog();

        res.status(204).end();
    });

    /* -------------------------------------------------------------- uploads -- */

    /**
     * Begin an upload.
     *
     * With remote storage this hands back a presigned PUT and the browser talks
     * to the bucket directly. With local storage it returns the proxied
     * endpoint below.
     */
    router.post('/titles/:id/upload', express.json({ limit: '16kb' }), (req, res) => {
        const title = ownedTitle(req, res);
        if (!title) return;

        const filename = String(req.body?.filename ?? 'upload.mp4');
        const size = Number(req.body?.size) || null;

        if (size && size > MAX_UPLOAD_BYTES) {
            res.status(413).json({ error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1e9)} GB limit.` });
            return;
        }

        const storage = getStorage();
        const key = buildKey(req.user.id, title.id, filename, 'source');

        const upload = uploads.create({
            titleId: title.id,
            creatorId: req.user.id,
            storageKey: key,
            originalName: filename,
            bytesExpected: size
        });

        // Offer a format guess from the filename so the creator does not have to
        // set projection and stereo by hand for a conventionally-named file.
        const guess = detectFormatFromName(filename);

        const directUrl = storage.isRemote ? storage.uploadUrl(key, { expiresIn: 6 * 3600 }) : null;

        res.json({
            uploadId: upload.id,
            storageKey: key,
            mode: directUrl ? 'direct' : 'proxy',
            url: directUrl ?? `/api/creator/uploads/${upload.id}/data`,
            guess,
            maxBytes: MAX_UPLOAD_BYTES
        });
    });

    /**
     * Proxied upload body (local storage only).
     *
     * Streamed straight to disk - never buffered - so memory stays flat
     * regardless of file size. This is still the wrong shape at scale, which is
     * exactly why the direct path above exists.
     */
    router.put('/uploads/:uploadId/data', async (req, res) => {
        const upload = uploads.byId(req.params.uploadId);

        if (!upload || upload.creator_id !== req.user.id) {
            res.status(404).json({ error: 'Upload not found.' });
            return;
        }

        if (upload.status !== 'pending') {
            res.status(409).json({ error: 'Upload already finalised.' });
            return;
        }

        const storage = getStorage();

        if (storage.isRemote) {
            res.status(400).json({ error: 'Use the presigned URL for direct upload.' });
            return;
        }

        try {
            const { size } = await storage.putStream(upload.storage_key, req);
            uploads.complete(upload.id, size);
            res.json({ ok: true, bytes: size });
        } catch (err) {
            uploads.abort(upload.id);
            res.status(500).json({ error: `Upload failed: ${err.message}` });
        }
    });

    /**
     * Finish an upload: attach the object to the title and queue processing.
     */
    router.post('/uploads/:uploadId/complete', express.json({ limit: '16kb' }), async (req, res) => {
        const upload = uploads.byId(req.params.uploadId);

        if (!upload || upload.creator_id !== req.user.id) {
            res.status(404).json({ error: 'Upload not found.' });
            return;
        }

        const storage = getStorage();

        if (!(await storage.exists(upload.storage_key))) {
            uploads.abort(upload.id);
            res.status(409).json({ error: 'No uploaded object found for this key.' });
            return;
        }

        const stat = await storage.stat(upload.storage_key);
        uploads.complete(upload.id, stat?.size ?? 0);

        titles.update(upload.title_id, {
            sourceKey: upload.storage_key,
            sizeBytes: stat?.size ?? null
        });

        // Local storage gives the worker a real path; remote uploads need a
        // download step, which belongs in the worker rather than here.
        const localPath = storage.localPath?.(upload.storage_key);

        let queued = { queued: false, workerEnabled: false };
        if (localPath && fs.existsSync(localPath)) {
            queued = enqueueProcessing({ titleId: upload.title_id, sourcePath: localPath });
        } else {
            titles.setStatus(upload.title_id, 'processing', 'Awaiting worker pickup');
        }

        invalidateCatalog();

        res.json({ title: publicTitle(titles.byId(upload.title_id)), processing: queued });
    });

    /* ----------------------------------------------------------- feed token -- */

    router.get('/feed', (req, res) => {
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        const base = `${proto}://${req.get('host')}`;

        res.json({
            deovr: `${base}/deovr/u/${req.user.feed_token}`,
            playlist: `${base}/playlist.m3u?token=${req.user.feed_token}`
        });
    });

    app.use('/api/creator', router);
}

/** Row shape sent to the portal. Storage keys stay server-side. */
function publicTitle(row) {
    if (!row) return null;

    const storage = getStorage();

    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        synopsis: row.synopsis,
        genre: row.genre,
        studio: row.studio,
        year: row.year,
        projection: row.projection,
        stereo: row.stereo,
        fisheyeFov: row.fisheye_fov,
        lens: row.lens,
        duration: row.duration,
        width: row.width,
        height: row.height,
        sizeBytes: row.size_bytes,
        status: row.status,
        statusDetail: row.status_detail,
        visibility: row.visibility,
        hasSource: !!row.source_key,
        hasHls: !!row.hls_key,
        poster: row.poster_key ? storage.deliveryUrl(row.poster_key) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        publishedAt: row.published_at
    };
}

export { sanitiseMetadata, uniqueSlug, slugify };
