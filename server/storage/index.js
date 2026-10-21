import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { presignUrl } from './sigv4.js';

/**
 * Object storage abstraction.
 *
 * The single most important scaling decision in this app lives here: whether a
 * video byte ever passes through the Node process.
 *
 *   LocalStorage  - files on disk, streamed by Express. Fine for development
 *                   and a single-box self-host. Throughput is bounded by that
 *                   one machine's disk and NIC, and every concurrent stream
 *                   occupies an event-loop-adjacent file handle.
 *
 *   S3Storage     - files in an S3-compatible bucket, delivered by presigned
 *                   URL or a CDN in front of it. The app returns a redirect and
 *                   is then out of the data path entirely. Concurrency becomes
 *                   the CDN's problem, which is what "scales without limit"
 *                   actually means in practice.
 *
 * Configure with AVR_STORAGE=s3 plus the S3_* variables. Anything else falls
 * back to local.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Reject traversal and absolute paths before a key ever reaches the disk. */
function assertSafeKey(key) {
    const value = String(key ?? '');

    if (!value || value.length > 1024) throw new Error('Invalid storage key');
    if (value.includes('..') || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
        throw new Error('Invalid storage key');
    }

    return value;
}

/**
 * Build a storage key for an uploaded asset.
 *
 * Keys are content-addressed by a random id rather than the original filename,
 * so two creators uploading `final.mp4` never collide and a key can never be
 * guessed from a title.
 */
export function buildKey(creatorId, titleId, filename, kind = 'source') {
    const ext = path.extname(filename || '').toLowerCase().slice(0, 12) || '.mp4';
    const nonce = crypto.randomBytes(8).toString('hex');
    return `${kind}/${creatorId}/${titleId}/${nonce}${ext}`;
}

/* ------------------------------------------------------------------- local -- */

class LocalStorage {
    constructor(root = process.env.AVR_MEDIA_DIR || path.join(ROOT, 'data', 'media')) {
        this.root = root;
        this.isRemote = false;
        fs.mkdirSync(this.root, { recursive: true });
    }

    _pathFor(key) {
        return path.join(this.root, assertSafeKey(key));
    }

    async putStream(key, stream, { onProgress } = {}) {
        const target = this._pathFor(key);
        await fsp.mkdir(path.dirname(target), { recursive: true });

        let bytes = 0;
        if (onProgress) {
            stream.on('data', (chunk) => {
                bytes += chunk.length;
                onProgress(bytes);
            });
        }

        // Write to a temp name and rename, so a failed or aborted upload never
        // leaves a truncated file that looks complete.
        const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
        try {
            await pipeline(stream, fs.createWriteStream(temp));
            await fsp.rename(temp, target);
        } catch (err) {
            await fsp.rm(temp, { force: true });
            throw err;
        }

        const { size } = await fsp.stat(target);
        return { key, size };
    }

    async exists(key) {
        try {
            await fsp.access(this._pathFor(key));
            return true;
        } catch {
            return false;
        }
    }

    async stat(key) {
        try {
            const s = await fsp.stat(this._pathFor(key));
            return { size: s.size, mtime: s.mtime };
        } catch {
            return null;
        }
    }

    async remove(key) {
        await fsp.rm(this._pathFor(key), { force: true });
    }

    localPath(key) {
        return this._pathFor(key);
    }

    /**
     * The whole object as a Buffer, or `null` if it is not there.
     *
     * Bounded, because the one caller is the censor and the one thing it
     * covers is a picture. Without the cap this is a way to ask the process
     * to hold a video in memory.
     */
    async readObject(key, { maxBytes = 8 * 1024 * 1024 } = {}) {
        try {
            const target = this._pathFor(key);
            const { size } = await fsp.stat(target);

            if (size > maxBytes) return null;

            return await fsp.readFile(target);
        } catch {
            return null;
        }
    }

    /** Local delivery goes back through the app, which is the whole limitation. */
    deliveryUrl(key) {
        return `/stream/${encodeKey(key)}`;
    }

    uploadUrl() {
        return null; // No direct-to-storage path; uploads are proxied.
    }
}

/* ---------------------------------------------------------------------- s3 -- */

class S3Storage {
    constructor(config) {
        this.config = config;
        this.isRemote = true;
    }

    _sign(method, key, expiresIn, extraQuery) {
        const { host, region, accessKeyId, secretAccessKey, sessionToken, pathPrefix, protocol } = this.config;

        return presignUrl({
            method,
            host,
            key: assertSafeKey(key),
            region,
            accessKeyId,
            secretAccessKey,
            sessionToken,
            pathPrefix,
            protocol,
            expiresIn,
            extraQuery
        });
    }

    /**
     * URL the player should fetch.
     *
     * When a CDN is configured the object is served from the edge, unsigned -
     * appropriate for public catalog content, and the only arrangement that
     * gets you edge caching (a signed, unique-per-request URL is uncacheable).
     * Without a CDN, fall back to a presigned origin URL.
     */
    deliveryUrl(key, { expiresIn = 6 * 3600, signed = null } = {}) {
        const useSigned = signed ?? !this.config.cdnBaseUrl;

        if (!useSigned && this.config.cdnBaseUrl) {
            return `${this.config.cdnBaseUrl.replace(/\/$/, '')}/${encodeKey(key)}`;
        }

        return this._sign('GET', key, expiresIn);
    }

    /** Presigned PUT so the browser uploads straight to the bucket. */
    uploadUrl(key, { expiresIn = 3600 } = {}) {
        return this._sign('PUT', key, expiresIn);
    }

    /**
     * The whole object as a Buffer, or `null` if it cannot be had.
     *
     * A presigned GET and a `fetch`, rather than an SDK client: the bucket is
     * already reachable by URL from here and a second way to read the same
     * bytes is a second thing to configure wrong. `signed: true` forces the
     * origin even when a CDN is set, because the CDN may be serving a cached
     * copy and this read is the one that has to be current.
     *
     * Bounded, because the one caller is the censor and the one thing it
     * covers is a picture. Without the cap this is a way to ask the process
     * to hold a video in memory. Never throws: every failure is a `null` the
     * caller turns into the placeholder.
     */
    async readObject(key, { maxBytes = 8 * 1024 * 1024, timeoutMs = 4_000 } = {}) {
        try {
            const url = this.deliveryUrl(key, { expiresIn: 300, signed: true });
            const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

            if (!res.ok) return null;

            // The header first, so an oversized object is refused before it
            // is read rather than after.
            if (Number(res.headers.get('content-length') || 0) > maxBytes) return null;

            const body = Buffer.from(await res.arrayBuffer());

            return body.length && body.length <= maxBytes ? body : null;
        } catch {
            return null;
        }
    }

    async putStream(key, stream) {
        // Server-side writes use the same presigned PUT rather than a separate
        // signing path, so there is one code path to get wrong.
        const url = this.uploadUrl(key, { expiresIn: 900 });
        const res = await fetch(url, { method: 'PUT', body: stream, duplex: 'half' });

        if (!res.ok) {
            throw new Error(`Storage PUT failed: ${res.status} ${await res.text().catch(() => '')}`);
        }

        return { key, size: null };
    }

    async exists(key) {
        const res = await fetch(this._sign('GET', key, 60), { method: 'HEAD' });
        return res.ok;
    }

    async stat(key) {
        const res = await fetch(this._sign('GET', key, 60), { method: 'HEAD' });
        if (!res.ok) return null;
        return { size: Number(res.headers.get('content-length')) || 0, mtime: null };
    }

    async remove(key) {
        const res = await fetch(this._sign('DELETE', key, 300), { method: 'DELETE' });
        if (!res.ok && res.status !== 404) {
            throw new Error(`Storage DELETE failed: ${res.status}`);
        }
    }

    localPath() {
        return null;
    }
}

function encodeKey(key) {
    return String(key)
        .split('/')
        .map(encodeURIComponent)
        .join('/');
}

/* ------------------------------------------------------------------ factory -- */

let instance = null;

/** @returns {LocalStorage|S3Storage} */
export function getStorage() {
    if (instance) return instance;

    if ((process.env.AVR_STORAGE || 'local').toLowerCase() === 's3') {
        const required = ['S3_HOST', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
        const missing = required.filter((name) => !process.env[name]);

        if (missing.length) {
            throw new Error(`AVR_STORAGE=s3 requires: ${missing.join(', ')}`);
        }

        instance = new S3Storage({
            host: process.env.S3_HOST,
            region: process.env.S3_REGION,
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
            sessionToken: process.env.S3_SESSION_TOKEN,
            // Set for MinIO or any path-style endpoint, e.g. `/my-bucket`.
            pathPrefix: process.env.S3_PATH_PREFIX || '',
            protocol: process.env.S3_PROTOCOL || 'https',
            cdnBaseUrl: process.env.CDN_BASE_URL || null
        });
    } else {
        instance = new LocalStorage();
    }

    return instance;
}

/** Test seam. */
export function __setStorage(next) {
    instance = next;
}

export { LocalStorage, S3Storage, assertSafeKey };
