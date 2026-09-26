import fs from 'node:fs';

import express from 'express';

import { recordings, recordingSales, credits } from '../db/index.js';
import { getStorage } from '../storage/index.js';
import { requireAuth, requireRole, loadFullUser } from '../auth/middleware.js';
import { requireAgeAssurance } from '../identity/age.js';
import { STEREO } from '../../src/catalog/media-format.js';

/**
 * The recording marketplace.
 *
 * What is on sale here is the creator's own recording of a 1:1 - a file made
 * on this server by an FFmpeg attached to the live session, containing what
 * the phone sent and nothing else. The viewer's recording of the same
 * conversation is made in their browser and never arrives, which is why there
 * is no route here that could list one: a file with a paying customer's voice
 * in it is not the seller's to sell. See `server/live/recording.js`.
 *
 * A purchase is an ordinary `credits.transfer` between two accounts, so a sale
 * and a watched minute settle through the same ledger and the same invariants
 * hold over both. Nothing here touches a payment processor; credits were
 * bought upstream.
 *
 * The **2D** and **3D** tag is read off the recording row, which got it from
 * what the session was actually carrying when the file was finalised. A
 * creator cannot type it, and a broadcast whose second camera dropped out is
 * tagged 2D however it was configured - the tag is a promise about the file.
 */

/** A listing price a person can reason about, in credits. */
const MIN_PRICE = 1;
const MAX_PRICE = 100_000;
const MAX_TITLE = 120;

/** What everybody may see about a recording. No storage key, ever. */
export function recordingView(row, { owned = false } = {}) {
    if (!row) return null;

    return {
        id: row.id,
        title: row.title ?? null,
        price: row.price ?? null,
        tag: row.stereo && row.stereo !== STEREO.MONO ? '3d' : '2d',
        durationMs: row.duration_ms ?? 0,
        sizeBytes: row.size_bytes ?? 0,
        status: row.status,
        failureReason: row.failure_reason ?? null,
        listed: Boolean(row.listed_at && !row.unlisted_at),
        createdAt: row.created_at,
        creatorName: row.creator_name ?? undefined,
        sales: row.sales ?? undefined,
        owned
    };
}

export function mountRecordings(app) {
    const router = express.Router();
    const json = express.json({ limit: '4kb' });

    /**
     * The catalogue is adult material in this product, so it sits behind the
     * same age gate as the rest of it. Under the mock provider the gate is a
     * pass-through; see `requireAgeAssurance` for why that is deliberate.
     */
    const adult = [requireAuth, loadFullUser, requireAgeAssurance];

    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    /* ------------------------------------------------------- the creator's -- */

    /** Everything this creator has recorded, listed or not, failed included. */
    router.get('/mine', requireRole('creator'), (req, res) => {
        res.json({ recordings: recordings.forCreator(req.auth.sub).map((row) => recordingView(row)) });
    });

    /**
     * Put one on sale.
     *
     * The price is set here rather than on the recording, because it is a
     * decision about a listing and a creator may take one down and put it back
     * at a different number. Only a `ready` recording can be listed: a failed
     * or in-progress one has no file behind it, and a marketplace entry that
     * cannot be played is worse than no entry.
     */
    router.post('/:id/list', requireRole('creator'), json, (req, res) => {
        const row = recordings.byId(req.params.id);

        if (!row || row.creator_id !== req.auth.sub) {
            res.status(404).json({ error: 'no such recording' });
            return;
        }

        if (row.status !== 'ready') {
            res.status(409).json({ error: 'recording_not_ready' });
            return;
        }

        const errors = [];
        const title = String(req.body?.title ?? '').trim();
        const price = Number(req.body?.price);

        if (title.length < 3 || title.length > MAX_TITLE) {
            errors.push(`title must be between 3 and ${MAX_TITLE} characters`);
        }
        if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE || price !== Math.trunc(price)) {
            errors.push(`price must be a whole number of credits between ${MIN_PRICE} and ${MAX_PRICE}`);
        }

        if (errors.length) {
            res.status(400).json({ errors });
            return;
        }

        res.json({ recording: recordingView(recordings.list(row.id, { title, price })) });
    });

    /**
     * Take it down.
     *
     * Buyers keep what they bought. Unlisting removes it from the marketplace
     * and changes nothing about an entitlement somebody already paid for -
     * revoking those would be taking back a sale, which is a refund and a
     * different act with different consequences for the ledger.
     */
    router.post('/:id/unlist', requireRole('creator'), json, (req, res) => {
        const row = recordings.byId(req.params.id);

        if (!row || row.creator_id !== req.auth.sub) {
            res.status(404).json({ error: 'no such recording' });
            return;
        }

        res.json({ recording: recordingView(recordings.unlist(row.id)) });
    });

    /* --------------------------------------------------------- the market -- */

    /**
     * What is for sale, optionally only in one dimension.
     *
     * `?tag=3d` is a filter on what was captured, not on what was claimed, so
     * a headset user filtering for 3D gets files with two eyes in them.
     */
    router.get('/market', adult, (req, res) => {
        const tag = req.query.tag === '3d' ? '3d' : req.query.tag === '2d' ? '2d' : null;
        const rows = recordings.listed({ stereo: tag });

        // One query for what this account already owns, rather than one per
        // row: the shelf and the shop are the same page and a "you own this"
        // badge should not cost a query per tile.
        const mine = new Set(recordingSales.forBuyer(req.auth.sub, 200).map((s) => s.recording_id));

        res.json({
            recordings: rows.map((row) => recordingView(row, { owned: mine.has(row.id) })),
            tag
        });
    });

    /** The buyer's shelf. */
    router.get('/purchased', requireAuth, (req, res) => {
        const rows = recordingSales.forBuyer(req.auth.sub);

        res.json({
            recordings: rows.map((sale) => ({
                ...recordingView(
                    {
                        id: sale.recording_id,
                        title: sale.title,
                        stereo: sale.stereo,
                        duration_ms: sale.duration_ms,
                        status: sale.status,
                        created_at: sale.created_at,
                        creator_name: sale.creator_name
                    },
                    { owned: true }
                ),
                paid: sale.price,
                boughtAt: sale.created_at
            }))
        });
    });

    /**
     * Buy it.
     *
     * The price charged is the one on the row at this moment, never one posted
     * by the client: a price in a request body is a price the buyer chose.
     */
    router.post('/:id/buy', adult, json, (req, res) => {
        const row = recordings.byId(req.params.id);
        const listed = row && row.listed_at && !row.unlisted_at && row.status === 'ready';

        if (!listed) {
            res.status(404).json({ error: 'no such listing' });
            return;
        }

        if (row.creator_id === req.auth.sub) {
            res.status(409).json({ error: 'your_own_recording' });
            return;
        }

        try {
            const { sale, applied } = recordingSales.buy({ recording: row, buyerId: req.auth.sub });

            res.json({
                sale: { id: sale.id, price: sale.price, applied },
                balance: credits.account(req.auth.sub).balance,
                recording: recordingView(row, { owned: true })
            });
        } catch (err) {
            if (err.code === 'insufficient_credits') {
                res.status(402).json({ error: 'insufficient_credits', balance: credits.account(req.auth.sub).balance });
                return;
            }
            throw err;
        }
    });

    /**
     * The bytes, to the people entitled to them.
     *
     * Deliberately not a `/stream/` URL. That path serves any key it is given
     * and the key would then be the entitlement - forwardable, cacheable and
     * permanent. Here the entitlement is checked per request against the sale,
     * and the storage key is never in a response body.
     *
     * With remote storage this becomes a short-lived signed redirect, so the
     * app is out of the data path for the download itself while the decision
     * about who may have it stays here.
     */
    router.get('/:id/file', adult, (req, res) => {
        const row = recordings.byId(req.params.id);

        if (!row || row.status !== 'ready' || !row.storage_key) {
            res.status(404).json({ error: 'no such recording' });
            return;
        }

        const entitled =
            row.creator_id === req.auth.sub || Boolean(recordingSales.byPair(row.id, req.auth.sub));

        if (!entitled) {
            res.status(402).json({ error: 'not_purchased' });
            return;
        }

        const storage = getStorage();

        if (storage.isRemote) {
            res.redirect(302, storage.deliveryUrl(row.storage_key, { signed: true, expiresIn: 3600 }));
            return;
        }

        const file = storage.localPath(row.storage_key);

        if (!file || !fs.existsSync(file)) {
            res.status(404).json({ error: 'no such recording' });
            return;
        }

        // Range support matters here for the same reason it does in the
        // library: a player that cannot seek in a purchased file is a player
        // that re-downloads it to scrub.
        res.sendFile(file, { acceptRanges: true });
    });

    app.use('/api/recordings', router);
}
