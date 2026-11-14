import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAGS } from './panels.js';

/**
 * OpenAI for the comic: it writes scripts and sharpens what the image model is
 * asked to draw. The image model itself (Animagine XL 4.0 and the `lustyx`
 * LoRA) still runs on the A100; nothing here draws.
 *
 * Same API, key and model setting as the performer biographies in
 * `server/routes/stars.js`: Chat Completions, `AVR_OPENAI_KEY`, and
 * `AVR_OPENAI_MODEL` (default gpt-4o). On a Mac the key comes from the repo's
 * `.env`; on the box, from `/etc/comic.env`, which `deploy.sh` writes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.AVR_OPENAI_TIMEOUT_MS) || 120_000;

export const OPENAI_MODEL = process.env.AVR_OPENAI_MODEL || 'gpt-4o';

/** The key from the environment, or from the repo's `.env` when run by hand on a Mac. */
function openaiKey() {
    if (process.env.AVR_OPENAI_KEY) return process.env.AVR_OPENAI_KEY;
    try {
        const line = fs
            .readFileSync(path.join(HERE, '..', '.env'), 'utf8')
            .split('\n')
            .find((l) => l.startsWith('AVR_OPENAI_KEY='));
        if (line) return line.slice('AVR_OPENAI_KEY='.length).trim().replace(/^["']|["']$/g, '');
    } catch {}
    throw new Error('AVR_OPENAI_KEY is not set: add it to .env, or to /etc/comic.env on the box (deploy.sh does this)');
}

/** One Chat Completions call that must come back as a JSON object. */
export async function chatJSON(system, user, { temperature = 0.7, maxTokens = 4000 } = {}) {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey()}` },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const choice = (await res.json())?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('OpenAI ran out of tokens before finishing');
    if (choice?.message?.refusal) throw new Error(`OpenAI declined: ${choice.message.refusal}`);
    try {
        return JSON.parse(choice?.message?.content ?? '');
    } catch {
        throw new Error('OpenAI did not return JSON');
    }
}

/* ------------------------------------------------ the rating, and nothing else -- */

/**
 * The rating tag stamped onto every prompt. '' for none.
 *
 * `safe` was the floor, and it is also a rating bucket, so it pulls the model
 * back toward clothed. `explicit` is the other end of the same axis.
 * AVR_COMIC_RATING='' stops stamping anything.
 */
export const RATING = process.env.AVR_COMIC_RATING ?? 'explicit';

const COUNT = /^(\d+(girl|boy|other)s?|no humans)$/i;

/** Tags reordered for the pipeline. Nothing is removed any more. */
export function safePrompt(prompt) {
    const tags = String(prompt)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t.toLowerCase() !== 'original');

    const i = tags.findIndex((t) => COUNT.test(t));
    const count = i >= 0 ? tags.splice(i, 1)[0] : '1girl';
    return [count, 'original', RATING, ...tags].filter(Boolean).join(', ');
}

/* ------------------------------------------------------- enhancement -- */

const ENHANCE_SYSTEM = `You turn comic panel descriptions into prompts for Animagine XL 4.0, an anime-style SDXL image model. It reads comma-separated Danbooru-style tags, it stops reading after about 77 tokens, and it cannot draw text.

For every panel you are given, return one prompt, in this order:
1. a count tag: 1girl, 1boy, 1girl 1boy, or no humans
2. "original, NSFW, explicit"
3. exactly ONE character, using that character's tags from the cast list word for word, plus her wardrobe tags
4. expression and pose (e.g. narrowed eyes, hand on own chin, leaning on counter)
5. framing (close-up, upper body, cowboy shot, full body, from side, from below, over the shoulder)
6. setting, with two or three concrete objects that tell the story
7. light (night, neon, window light, desk lamp, dramatic shadows)

Rules:
- At most 40 words. Concrete visual tags only; no sentences, no abstractions, no emotions the camera cannot see.
- One described character per panel. Anyone else in the scene is "other woman from behind", "man in background" and similar, never described; faces blend when two people are described.
- Keep each character's wardrobe the same in every panel of the strip.
- Keep each character's wardrobe the same in every panel of the strip.
- Adult comic: every character is an adult, 18 or over — put "mature female" or "mature male" on them. Nudity and sexual framing are allowed; write the panel the art direction asks for.

Reply with JSON: {"panels": [{"prompt": "..."}]}, one entry per panel, in order.`;

/**
 * Better drawing prompts for a strip, one per panel, from its art direction.
 *
 * @param {object} strip  `setting`, `look`, and `panels[]` with `art` and `lines`.
 * @param {string[]} drafts  The prompts written so far; kept as hints and as the fallback.
 * @returns {Promise<string[]>} One prompt per panel, through `safePrompt`.
 */
export async function enhancePrompts(strip, drafts) {
    const cast = {
        Lusty: `${TAGS.lusty}; wardrobe A: ${TAGS.lustyA}; wardrobe C: ${TAGS.lustyC}; wardrobe B: copper waves, cream blouse, teal skirt, burgundy cowboy boots`,
        Mira: TAGS.mira,
        Nessa: TAGS.nessa,
        Ferrer: TAGS.ferrer
    };
    const panels = strip.panels.map((p, i) => ({
        art: p.art,
        dialogue: (p.lines ?? []).map((l) => (Array.isArray(l) ? `${l[0]}: ${l[1]}` : `${l.speaker}: ${l.text}`)),
        draft: drafts[i]
    }));

    const out = await chatJSON(
        ENHANCE_SYSTEM,
        JSON.stringify({ setting: strip.setting, lusty_wardrobe: strip.look, cast, panels }),
        { temperature: 0.4, maxTokens: 1500 }
    );

    const prompts = out?.panels?.map((p) => p?.prompt);
    if (!Array.isArray(prompts) || prompts.length !== panels.length || !prompts.every((p) => typeof p === 'string' && p.trim())) {
        throw new Error(`OpenAI returned ${prompts?.length ?? 0} panel prompts for ${panels.length} panels`);
    }
    return prompts.map(safePrompt);
}
