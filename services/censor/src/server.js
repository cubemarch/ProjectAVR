import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import { load, detect } from './detect.js';
import { pixelate } from './mosaic.js';

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.CENSOR_MODEL || '/app/model/320n.onnx';
const TOKEN = process.env.CENSOR_TOKEN || '';

/** Bigger than any thumbnail and smaller than anything worth a timeout. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Whether the model is loaded. Starts false and may stay false — see the
 * load handler at the foot of this file, which treats a missing model as a
 * reason to cover everything rather than a reason to stop.
 */
let ready = false;

const app = express();

app.disable('x-powered-by');

/**
 * Liveness, and the one route that is not authenticated.
 *
 * Reports whether the model actually loaded. Cloud Run will keep routing to a
 * container that is listening, so "up" has to mean "up and able to censor" or
 * the first thing a healthy-looking revision does is fail open.
 */
app.get('/health', (_req, res) => {
    res.json({ ok: ready, model: ready ? 'loaded' : 'missing' });
});

app.use((req, res, next) => {
    if (!TOKEN) {
        // Refusing rather than running open. This service exists to be called
        // by one caller over the public internet; unauthenticated it is a
        // free image-processing endpoint with our name on the bill.
        res.status(503).json({ error: 'CENSOR_TOKEN is not set' });
        return;
    }

    const given = Buffer.from(req.get('x-censor-token') || '');
    const want = Buffer.from(TOKEN);

    if (given.length !== want.length || !timingSafeEqual(given, want)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    next();
});

/**
 * One image in, the same image with anything explicit covered, out.
 *
 * Returns the finished JPEG rather than coordinates. The caller is a Node
 * server with no image stack and no model; keeping both on this side means
 * the only thing that has to move when this is re-hosted on AWS is a URL.
 *
 * ## Every failure covers more, never less
 *
 * There is no response from this route that means "I could not tell, here is
 * the original". A decode that works and a model that does not gets the whole
 * frame mosaiced; a decode that fails gets a 502 and no image at all, which
 * the caller turns into a placeholder. The caller cannot show something
 * uncensored by misreading this route, because this route never sends one.
 */
app.post(
    '/scan',
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_BYTES }),
    async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            res.status(400).json({ error: 'empty body' });
            return;
        }

        const started = process.hrtime.bigint();
        let verdict = { boxes: [], whole: true, confidence: null };

        try {
            verdict = ready
                ? await detect(req.body)
                : { boxes: [], whole: true, confidence: null };
        } catch (err) {
            // Detection broke. The image itself may still be perfectly
            // decodable, so the answer is the whole frame covered — not the
            // original, and not an error the caller might serve around.
            console.warn(`[censor] detect failed: ${err.message}`);
        }

        try {
            const out = await pixelate(req.body, verdict);
            const ms = Number(process.hrtime.bigint() - started) / 1e6;

            res.set('Content-Type', 'image/jpeg');
            res.set('X-Censor-Boxes', String(verdict.boxes.length));
            res.set('X-Censor-Whole', verdict.whole ? '1' : '0');
            res.set('X-Censor-Ms', ms.toFixed(1));
            res.send(out);
        } catch (err) {
            // Could not even re-encode it. Nothing safe to send.
            console.warn(`[censor] pixelate failed: ${err.message}`);
            res.status(502).json({ error: 'unprocessable image' });
        }
    }
);

load(MODEL)
    .then(() => {
        ready = true;
        console.log(`[censor] model loaded from ${MODEL}`);
    })
    .catch((err) => {
        // Deliberately not fatal. A container that exits cannot tell anyone
        // why, and a running one that covers every frame it is handed is both
        // safe and diagnosable — `/health` says `model: missing` and every
        // thumbnail on the site is visibly a mosaic.
        console.error(`[censor] MODEL FAILED TO LOAD (${err.message}).`);
        console.error('[censor] Serving whole-frame mosaic for every request.');
    });

app.listen(PORT, () => console.log(`[censor] listening on ${PORT}`));
