import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rateLimit } from '../auth/middleware.js';
import { AFFILIATE_PROGRAMS, fetchAffiliateRow } from '../../src/catalog/affiliates.js';

/**
 * Performer biographies for the Top Stars row.
 *
 * The row itself is a partner feed and needs nothing from this server — see
 * `src/catalog/affiliates.js`. What needs a server is the hover card, because
 * writing it costs an OpenAI call and an OpenAI call needs a key.
 *
 * **The key is the entire reason this file exists.** The obvious implementation
 * is a `fetch` to `api.openai.com` from the browser, and it cannot be done: a
 * key in front-end code is in the bundle, in the network tab and in view-source
 * on a public site, which means it is spent by somebody else by the end of the
 * week. So the browser asks this route, this route holds the key, and the key
 * never leaves the process. `AVR_OPENAI_KEY` belongs in `.env`, which is
 * gitignored, and nowhere else.
 *
 * Three things follow from putting a paid API behind a public URL, and all
 * three are load-bearing rather than defensive habit:
 *
 *   - **The star id is checked against the live feed before anything is spent.**
 *     Without that, this is a free OpenAI endpoint with an attacker-chosen
 *     prompt in it — the classic way a hosted key gets drained. The allowlist
 *     is the ten ids AEBN is currently charting and nothing else, and it comes
 *     from the same module the browser renders from, so the set that is
 *     answerable here is by construction the set that is hoverable there.
 *   - **Answers are cached on disk.** Ten performers, each written once, ever.
 *     A hover is free after the first, a redeploy does not re-buy the same ten
 *     paragraphs, and a visitor sweeping the row does not cost ten calls.
 *   - **It is rate limited.** The cache handles honest traffic; the limiter is
 *     for the case where the chart rotates and somebody notices.
 *
 * **On accuracy.** These are real people and a language model will write
 * confident sentences about anyone, including ones it has made up. That risk
 * is not fully solvable here, so it is bounded instead: the model is asked for
 * career facts only, told to decline rather than guess, and its refusal is
 * respected — `known: false` renders as "no profile available", not as an
 * empty card to be filled with something. The UI labels the result as
 * AI-written. Anything stronger than that means a human-edited biography
 * table, which is a different feature.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CACHE_PATH = process.env.AVR_STAR_BIO_CACHE || path.join(ROOT, 'data', 'star-bios.json');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.AVR_OPENAI_MODEL || 'gpt-4o';
const TIMEOUT_MS = Number(process.env.AVR_OPENAI_TIMEOUT_MS) || 20_000;

/** How long the allowlist is trusted before the chart is read again. */
const FEED_TTL_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------- allowlist -- */

let feed = { at: 0, byId: new Map() };
let inFlight = null;

/**
 * The star ids this route will answer for, and the name to write about.
 *
 * Reads the same program registry the browser renders from rather than a
 * second copy of the endpoint, so the two cannot drift. A failed refresh keeps
 * serving the previous allowlist: the chart changes a few times a month and a
 * CloudFront blip is not a reason to stop answering for performers that were
 * valid a minute ago.
 */
async function starAllowlist() {
    if (Date.now() - feed.at < FEED_TTL_MS && feed.byId.size) return feed.byId;

    // Collapse concurrent refreshes. Ten cards can be hovered before the first
    // response lands, and ten simultaneous reads of the same JSON is silly.
    if (!inFlight) {
        const program = AFFILIATE_PROGRAMS.find((p) => p.kind === 'stars');

        inFlight = (async () => {
            if (!program) return feed.byId;

            try {
                // Straight to the partner, not through `/api/aebn/stars`.
                // That path is this server and a root-relative URL is not
                // something `fetch` can resolve here; it would also mean this
                // process making a request to itself to read a feed it is
                // about to cache anyway. There is no visitor on this call, so
                // there is no gate to apply and nothing to cover — all it
                // takes from the payload is the ten ids and their names.
                const items = await fetchAffiliateRow(program, { upstream: true });
                const byId = new Map(
                    items.filter((i) => i.starId > 0).map((i) => [i.starId, i.title])
                );
                if (byId.size) feed = { at: Date.now(), byId };
            } catch {
                // Keep whatever we had. See above.
            }

            return feed.byId;
        })().finally(() => {
            inFlight = null;
        });
    }

    return inFlight;
}

/* ----------------------------------------------------------------- cache -- */

let cache = null;

function loadCache() {
    if (cache) return cache;

    try {
        cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
        // Missing or corrupt. Either way the recovery is the same and costs
        // ten API calls, so there is nothing here worth reporting.
        cache = {};
    }

    return cache;
}

/**
 * Write-through, via a temporary file.
 *
 * A half-written cache is worse than no cache: it parses as corrupt on the
 * next boot and throws the lot away. Rename is atomic on the same filesystem,
 * so a reader sees either the old file or the new one.
 */
function saveCache() {
    try {
        fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
        const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
        fs.renameSync(tmp, CACHE_PATH);
    } catch (err) {
        // A read-only data directory costs money per hover but still serves
        // pages, so this is a warning and not a failure.
        console.warn(`[stars] could not persist biography cache: ${err.message}`);
    }
}

/* ----------------------------------------------------------------- model -- */

const SYSTEM_PROMPT = [
    'You write short factual profiles of adult-film performers for a video',
    'catalogue, in the register of an encyclopedia entry rather than',
    'promotional copy.',
    '',
    'Rules, in order of importance:',
    '1. Only state what is widely and publicly documented about this performer’s',
    '   career. If you are not confident the person is someone you have reliable',
    '   information about, set "known" to false and leave the other fields empty.',
    '   A refusal is a correct answer here. An invented one is not.',
    '2. Career information only: when they began working, studios and series',
    '   they are associated with, industry awards and nominations, directing or',
    '   producing work, mainstream crossover, other notable professional facts.',
    '3. No sexual or explicit content, and no physical descriptions.',
    '4. Nothing private: no legal name unless they perform under it, no address,',
    '   no family, no health, no relationships, no financial detail.',
    '5. Neutral tone. No second person, no sales language, no superlatives you',
    '   cannot source.',
    '',
    'Reply with JSON only: {"known": boolean, "bio": string, "highlights":',
    'string[]}. "bio" is two to four sentences. "highlights" is at most four',
    'entries, each a short noun phrase such as "AVN Award winner, 2019" or',
    '"Directing since 2021" — omit the array entirely rather than padding it.'
].join('\n');

/**
 * Ask the model for one performer.
 *
 * The name comes from the allowlist, not from the request, so there is no path
 * by which a caller writes part of this prompt.
 */
async function writeBio(name, key) {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
            model: MODEL,
            // Low rather than zero: this is a factual task, and sampling
            // variety buys nothing when the answer is cached forever anyway.
            temperature: 0.2,
            max_tokens: 500,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `Performer: ${name}` }
            ]
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        const err = new Error(`OpenAI answered ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
    }

    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content;

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error('OpenAI did not return JSON');
    }

    // A model that declines mid-sentence still produces a `bio`, so an empty
    // one is treated as a decline rather than shipped as a blank card.
    const bio = String(parsed?.bio ?? '').trim();
    if (parsed?.known !== true || !bio) return { known: false };

    return {
        known: true,
        bio,
        highlights: Array.isArray(parsed.highlights)
            ? parsed.highlights.map((h) => String(h).trim()).filter(Boolean).slice(0, 4)
            : []
    };
}

/* ---------------------------------------------------------------- routes -- */

export function mountStars(app) {
    const router = express.Router();

    /**
     * Every profile already written, in one request.
     *
     * This exists so the browser can fill the whole row before the first
     * hover instead of paying a round trip and showing a spinner on each of
     * ten performers. Doing that against the route below would be ten
     * requests out of a budget of thirty a minute, which a visitor would
     * exhaust by reloading three times.
     *
     * **It reads the cache and never writes it.** A performer with no profile
     * yet is absent from the response rather than commissioned, so this
     * endpoint cannot spend a penny no matter how it is called — and a page
     * load can never cost ten OpenAI calls. The route below remains the only
     * thing that buys anything, which is what keeps the allowlist, the delay
     * and the limiter meaningful.
     *
     * No allowlist check, deliberately. Everything here is already public one
     * id at a time, filtering would mean a feed fetch on a path that runs on
     * every page load, and the browser only ever looks up ids it has drawn.
     */
    router.get('/bios', rateLimit({ windowMs: 60_000, max: 60 }), (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ bios: loadCache() });
    });

    /**
     * One performer's profile.
     *
     * Public and unauthenticated, because the row it belongs to is: a hover
     * card that needed an account would be a hover card nobody sees. The
     * spend is bounded by the allowlist and the cache rather than by a login.
     *
     * Cached hard at the edge as well as here. The content is written once and
     * never revised, so a day in a CDN costs nothing and removes this server
     * from the hover path entirely for repeat visitors.
     */
    router.get(
        '/:starId/bio',
        rateLimit({ windowMs: 60_000, max: 30 }),
        async (req, res) => {
            const starId = Number(req.params.starId);

            if (!Number.isInteger(starId) || starId <= 0) {
                res.status(400).json({ error: 'bad star id', code: 'bad_star_id' });
                return;
            }

            const allowed = await starAllowlist();
            const name = allowed.get(starId);

            if (!name) {
                res.status(404).json({ error: 'not a charted performer', code: 'unknown_star' });
                return;
            }

            const store = loadCache();
            const hit = store[starId];

            if (hit) {
                res.set('Cache-Control', 'public, max-age=86400');
                res.json(hit);
                return;
            }

            const key = process.env.AVR_OPENAI_KEY;

            if (!key) {
                // The normal state in development and on any deployment that
                // has not bought into this feature. The row still works; the
                // hover card just does not appear.
                res.set('Cache-Control', 'no-store');
                res.status(503).json({ error: 'biographies not configured', code: 'no_provider' });
                return;
            }

            let bio;
            try {
                bio = await writeBio(name, key);
            } catch (err) {
                console.warn(`[stars] biography for ${starId} failed: ${err.message}`);
                res.set('Cache-Control', 'no-store');
                res.status(502).json({ error: 'biography unavailable', code: 'provider_failed' });
                return;
            }

            // Declines are cached too. A model that does not know this
            // performer will not know them on the next hover either, and
            // paying to be told that ten times a minute is the whole problem
            // this cache exists to avoid.
            bio = { ...bio, name, source: 'openai', model: MODEL };
            store[starId] = bio;
            saveCache();

            res.set('Cache-Control', 'public, max-age=86400');
            res.json(bio);
        }
    );

    app.use('/api/stars', router);
}
