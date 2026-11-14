import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { DEFAULT_STYLE, STYLES, TAGS } from './panels.js';
import { makePage, runOnBox } from './make.js';
import { OPENAI_MODEL, chatJSON, enhancePrompts } from './openai.js';

/**
 * A Lusty X page from one line of story.
 *
 *   node comic/new.js "Lusty and Mira test the VR camera on a rooftop; the wind keeps winning"
 *   node comic/new.js "<idea>" --style ink --seed 77 --yes
 *   node comic/new.js "<idea>" --script-only
 *   node comic/new.js --from comic/drafts/new/<name>.json   draw a saved (or edited) script
 *
 * A language model writes the strip: four panels, dialogue, captions, and a
 * short tag prompt per panel for the image model. You read it and approve it.
 * Then the panels are drawn by `server/render.py` on the GPU box (Animagine
 * XL 4.0 and Lusty's LoRA) and lettered by `make.js`. No language model
 * draws anything.
 *
 * Then, unless `--no-enhance`, OpenAI rewrites each panel's drawing prompt
 * from its art direction (see `openai.js`), and those are what the A100 draws.
 *
 * Three writers, chosen with `--writer`:
 *   openai  (default) the OpenAI model the site already uses for performer
 *           biographies, `AVR_OPENAI_MODEL` (gpt-4o unless set).
 *   local   Qwen2.5-14B-Instruct on the GPU box, via
 *           `server/write.py`. Apache-2.0, billed as GPU time like the GIF
 *           service. Added on 2026-11-14, when Vertex refused Claude calls
 *           over an unpaid balance on the project's billing account.
 *   claude  Claude Opus 5.5 on Vertex, with structured output. Better
 *           writing; needs the billing account in good standing.
 *
 * The script is saved beside the page in `comic/drafts/new/`, shaped like a
 * `strips.js` entry plus its `panels.js` prompts, so a strip worth keeping
 * can be copied into the season.
 *
 * Claude runs on Vertex AI in project cubemarch-507617. Credentials are
 * Google application-default credentials when they exist, and otherwise the
 * signed-in gcloud user's access token.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'drafts', 'new');

const VERTEX = { projectId: 'cubemarch-507617', region: 'global' };
const MODEL = 'claude-opus-5-5';
const LOCAL_MODEL = 'Qwen/Qwen2.5-14B-Instruct';

const INSERT_TYPES = ['chyron', 'doc', 'label', 'note', 'badge'];

/** The strip Claude must return. Validated again in `check`, which also counts the panels. */
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'arc', 'look', 'summary', 'setting', 'panels', 'after'],
    properties: {
        title: { type: 'string', description: 'Two to four words.' },
        arc: { type: 'string', description: 'Footer lettering: the story arc, a few words.' },
        look: { type: 'string', description: 'Lusty’s wardrobe: A, B or C, optionally with a short note.' },
        summary: { type: 'string', description: 'One sentence describing the strip, used as alt text.' },
        setting: { type: 'string', description: 'Where and when, and who is present, for the artist.' },
        panels: {
            type: 'array',
            description: 'Exactly four panels.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['art', 'prompt', 'lines', 'inserts'],
                properties: {
                    art: { type: 'string', description: 'Art direction for a human reader.' },
                    prompt: { type: 'string', description: 'Comma-separated tags for the image model, under 45 words.' },
                    lines: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['speaker', 'text'],
                            properties: { speaker: { type: 'string' }, text: { type: 'string' } }
                        }
                    },
                    inserts: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['type', 'text'],
                            properties: { type: { type: 'string', enum: INSERT_TYPES }, text: { type: 'string' } }
                        }
                    }
                }
            }
        },
        after: { type: 'string', description: 'Continuity after the strip: what is now true.' }
    }
};

const SYSTEM = `You write four-panel strips for Lusty X, a high-fashion manga mystery thriller published on an adult website's comic page. You write the script only; an image model draws it and a typesetter letters it.

THE SERIES
Lusty X (working age 24) is a genius and a newcomer to adult webcam work building a VR business in Miami, co-owner of Full Credit Studio LLC with Nessa and Mira. Copper-red hair, pale freckles, green eyes, Western boots. Wardrobe A (everyday): side braid, denim jacket, cognac floral boots. B (networking): copper waves, cream blouse, teal skirt, burgundy boots. C (studio/professional): high ponytail, black sleeveless mock-neck, black jeans, cherry-red boots, small X earrings. She is Jewish and keeps it private from her audience; her parents brought her from Eastern Europe at three or four and raised her on a Pennsylvania farm. Never use her heritage as a shortcut to authority, and never out her.
Mira Reyes, 29: technically exact, says "We don't know", round glasses, short curls, sage overshirt. Nessa Vale, 27: an established cam performer, short platinum curls, lilac suit; she controls her own records. Others may appear as new, original people.
Tone: contemporary Miami thriller. Lusty is observant and precise; her questions reveal more than speeches. Dark humour is a brief release, at most one dry line per strip, aimed at institutions or her own predicament, never at someone's fear or harm. End on an implication, a decision or a clue more often than a punchline. Sex work is work: treat it with respect, agency and labour, never as shame or spectacle.

LIMITS
Adult comic. Every character is an adult, 18 or over; tag them "mature female" or "mature male". Nudity and sexual framing are allowed and expected — write the strip the idea asks for rather than the safest version of it. Every character is original to this series: never use or imitate characters, logos or scenes from other comics, films, games or shows. A real public figure may appear only in a public role, on a screen or at a public event, never in panel 1, never connected to wrongdoing in the story; never name one in a panel's drawing tags, put the name in a chyron insert instead.

LETTERING
Four panels. Each panel has 0 to 3 lines; keep every balloon under 18 words. A line's speaker is the character's name, or "Caption" for a narration box, or "Screen" for text shown on a phone or laptop. Any other printed words in the picture (a document, a sign, a chyron, a label, a handwritten card, a LIVE badge) go in inserts, typed chyron, doc, label, note or badge.

DRAWING TAGS (each panel's "prompt")
Comma-separated tags in this order: the count tag, then "original, safe", then ONE character's tags, then action and setting, then light. Under 40 words; the model stops reading early.
Describe exactly one character per panel. Faces and outfits blend when one prompt describes two people, so a panel that shows two people still describes only the one facing us, and adds "other woman from behind" or "man in background" for the rest; the balloons say who they are. Use "1girl" for a panel built around one woman. Example for a panel where Lusty speaks to Mira: "1girl, original, safe, lustyx, mature female, copper hair, freckles, green eyes, side braid, denim jacket, white shirt, jeans, talking, other woman from behind, rooftop, night, city lights". Never include text, letters or speech bubbles in the tags. Use these exact character tags:
- Lusty wears ONE wardrobe for the whole strip, the one named in "look"; repeat its tags in every panel she appears in.
- Lusty: "${TAGS.lusty}", plus her wardrobe: A "${TAGS.lustyA}" or C "${TAGS.lustyC}", or describe B in the same way.
- Mira: "${TAGS.mira}"
- Nessa: "${TAGS.nessa}"
- For new characters, write a short tag description starting with their age group (mature female, old man, and so on).`;

/* ------------------------------------------------------------- claude -- */

/**
 * ADC when it works, else the signed-in gcloud user's token.
 *
 * The SDK's own `accessToken` option is accepted and then ignored: every
 * request goes through a Google auth client. So the fallback is an auth
 * client holding the gcloud token. It matters on this Mac, where an
 * application-default credentials file from October has a refresh token that
 * no longer works, and the SDK's default answer to that is `invalid_grant`.
 * Running `gcloud auth application-default login` once makes the first branch
 * work again.
 */
async function vertexAuth() {
    try {
        execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { stdio: 'ignore' });
        return {};
    } catch {
        const { OAuth2Client } = await import('google-auth-library');
        const authClient = new OAuth2Client();
        authClient.setCredentials({ access_token: execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim() });
        return { authClient };
    }
}

export async function writeScript(idea) {
    // Loaded here, not at the top: the comic service on the box runs only
    // the local writer and does not install the Vertex SDK.
    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
    const client = new AnthropicVertex({ ...VERTEX, ...(await vertexAuth()) });

    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Write a strip from this idea:\n\n${idea}` }]
    });

    if (response.stop_reason === 'refusal') {
        const why = response.stop_details?.explanation ?? 'no explanation given';
        throw new Error(`Claude declined to write this strip (${why}). Try rewording the idea.`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('the script was cut off at max_tokens; try a shorter idea');

    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Claude returned no script');
    return check(JSON.parse(text));
}

/** The OpenAI writer: the same prompt and schema as the others, checked the same way. */
export async function writeScriptOpenAI(idea, attempts = 2) {
    const system =
        `${SYSTEM}\n\nOUTPUT\nReply with one JSON object matching this JSON Schema exactly, with exactly four panels:\n` +
        JSON.stringify(SCHEMA);
    for (let attempt = 1; ; attempt++) {
        try {
            return check(await chatJSON(system, `Write a strip from this idea:\n\n${idea}`, { temperature: 0.8 }));
        } catch (err) {
            if (attempt >= attempts) throw err;
            console.error(`OpenAI's script did not validate (${err.message}); asking again`);
        }
    }
}

/**
 * The local model, on the box. It has no structured output, so the schema is
 * written into the prompt, the reply is searched for its JSON object, and
 * `check` does the validating; a reply that fails is asked for once more.
 */
export async function writeScriptLocal(idea, attempts = 2) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-write-'));
    const job = {
        model: LOCAL_MODEL,
        system:
            `${SYSTEM}\n\nOUTPUT\nReply with one JSON object and nothing else: no prose before or after, no code fences. ` +
            `It must match this JSON Schema exactly, with exactly four panels:\n${JSON.stringify(SCHEMA)}`,
        user: `Write a strip from this idea:\n\n${idea}`,
        max_new_tokens: 3000,
        temperature: 0.7
    };
    fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job));
    fs.copyFileSync(path.join(HERE, 'server', 'write.py'), path.join(tmp, 'write.py'));

    for (let attempt = 1; ; attempt++) {
        const { out } = runOnBox(
            [path.join(tmp, 'job.json'), path.join(tmp, 'write.py')],
            (dir) => `sudo bash -c 'set -a; . /opt/animatediff/.env; set +a; /opt/animatediff-venv/bin/python ${dir}/write.py ${dir}/job.json'`
        );
        try {
            const reply = /-----BEGIN SCRIPT-----\n([\s\S]*?)\n-----END SCRIPT-----/.exec(out)?.[1] ?? '';
            const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
            return check(JSON.parse(json));
        } catch (err) {
            if (attempt >= attempts) throw new Error(`the local model's script did not validate: ${err.message}`);
            console.error(`the local model's script did not validate (${err.message}); asking again`);
        }
    }
}

/**
 * Everything a script must be before GPU time is spent on it. Structured
 * output guarantees the shape from Claude, not the panel count; the local
 * model guarantees nothing, so this checks it all.
 */
function check(script) {
    for (const key of ['title', 'arc', 'look', 'summary', 'setting', 'after']) {
        if (typeof script[key] !== 'string') throw new Error(`"${key}" is missing`);
    }
    if (!Array.isArray(script.panels) || script.panels.length !== 4) {
        throw new Error(`the script has ${script.panels?.length ?? 0} panels, not 4`);
    }
    for (const [i, p] of script.panels.entries()) {
        if (typeof p.art !== 'string' || typeof p.prompt !== 'string') throw new Error(`panel ${i + 1} has no art or prompt`);
        if (!Array.isArray(p.lines) || !p.lines.every((l) => typeof l?.speaker === 'string' && typeof l?.text === 'string')) {
            throw new Error(`panel ${i + 1}'s lines are malformed`);
        }
        p.inserts = (Array.isArray(p.inserts) ? p.inserts : []).filter((ins) => {
            const ok = INSERT_TYPES.includes(ins?.type) && typeof ins?.text === 'string';
            if (!ok) console.error(`note: dropped an unusable insert in panel ${i + 1}`);
            return ok;
        });

        const described = ['lustyx', 'round eyewear', 'platinum blonde'].filter((t) => p.prompt.includes(t)).length;
        if (described > 1) console.error(`note: panel ${i + 1}'s tags describe ${described} characters; their faces may blend`);

        const words = p.prompt.split(/[\s,]+/).filter(Boolean).length;
        if (words > 55) console.error(`note: panel ${i + 1}'s tags are ${words} words; the model may not read the end`);
        if (p.lines.length > 3) console.error(`note: panel ${i + 1} has ${p.lines.length} balloons and may be crowded`);
    }
    return script;
}

/* --------------------------------------------------------------- page -- */

/** The script in the shapes `make.js` letters from. */
function shapes(script) {
    return {
        strip: {
            title: script.title,
            arc: script.arc,
            look: script.look,
            summary: script.summary,
            setting: script.setting,
            panels: script.panels.map((p) => ({ art: p.art, lines: p.lines.map((l) => [l.speaker, l.text]) })),
            after: script.after
        },
        spec: script.panels.map((p) => ({ prompt: p.prompt, ...(p.draft ? { draft: p.draft } : {}), inserts: p.inserts }))
    };
}

function printScript(script) {
    const out = [`\n${script.title.toUpperCase()}  ·  ${script.arc}  ·  look ${script.look}`, script.summary, ''];
    script.panels.forEach((p, i) => {
        out.push(`PANEL ${i + 1}: ${p.art}`);
        for (const l of p.lines) out.push(`   ${l.speaker}: ${l.text}`);
        for (const ins of p.inserts) out.push(`   [${ins.type}] ${ins.text}`);
        out.push(`   tags: ${p.prompt}`, '');
    });
    console.log(out.join('\n'));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* ---------------------------------------------------------------- cli -- */

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const args = process.argv.slice(2);
    const VALUED = ['--style', '--seed', '--writer', '--out', '--from'];
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const idea = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
    const from = flag('--from');

    if (!idea && !from) {
        console.error(
            'usage: node comic/new.js "<one line of story>" [--writer openai|local|claude] [--style fashion|ink|inkmono|illustration]\n' +
                '                         [--seed N] [--yes] [--script-only] [--no-enhance] [--out <path without extension>]\n' +
                '       node comic/new.js --from <script.json> [--style S] [--seed N]'
        );
        process.exit(1);
    }

    let saved = {};
    if (from) saved = JSON.parse(fs.readFileSync(from, 'utf8'));

    const writer = flag('--writer') ?? saved.writer ?? 'openai';
    if (!['openai', 'local', 'claude'].includes(writer)) {
        console.error(`unknown writer ${writer}; choose openai, local or claude`);
        process.exit(1);
    }
    const style = flag('--style') ?? saved.style ?? DEFAULT_STYLE;
    if (!Object.hasOwn(STYLES, style)) {
        console.error(`unknown style ${style}; choose ${Object.keys(STYLES).join(', ')}`);
        process.exit(1);
    }
    const seed = flag('--seed') !== undefined ? Number(flag('--seed')) : (saved.seed ?? Math.floor(Math.random() * 2 ** 31));

    let base, strip, spec;
    if (from) {
        // A saved script, perhaps edited by hand or in the web page: draw it as it stands.
        base = from.replace(/\.json$/, '');
        ({ strip, panels: spec } = saved);
        fs.writeFileSync(`${base}.json`, JSON.stringify({ ...saved, style, seed }, null, 2));
    } else {
        const writers = {
            openai: [`${OPENAI_MODEL} on OpenAI`, writeScriptOpenAI],
            local: [`${LOCAL_MODEL} on the GPU box`, writeScriptLocal],
            claude: [`${MODEL} on Vertex`, writeScript]
        };
        console.error(`writing the strip with ${writers[writer][0]}…`);
        const script = await writers[writer][1](idea);

        // The writer's tags are a draft; OpenAI rewrites them from the art
        // direction, and the draft is kept beside each one for comparison.
        if (!args.includes('--no-enhance')) {
            console.error(`enhancing the drawing prompts with ${OPENAI_MODEL}…`);
            const enhanced = await enhancePrompts(
                { setting: script.setting, look: script.look, panels: script.panels },
                script.panels.map((p) => p.prompt)
            );
            script.panels.forEach((p, i) => {
                p.draft = p.prompt;
                p.prompt = enhanced[i];
            });
        }
        printScript(script);

        fs.mkdirSync(OUT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
        base = flag('--out') ?? path.join(OUT_DIR, `${stamp}-${slug(script.title)}`);
        ({ strip, spec } = shapes(script));
        fs.writeFileSync(`${base}.json`, JSON.stringify({ idea, writer, style, seed, strip, panels: spec }, null, 2));
        console.error(`script saved to ${path.relative(process.cwd(), base)}.json`);

        if (args.includes('--script-only')) process.exit(0);

        if (!args.includes('--yes')) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question('Draw it? [y/N] ');
            rl.close();
            if (!/^y(es)?$/i.test(answer.trim())) process.exit(0);
        }
    }

    await makePage({ strip, spec, seed, style, out: `${base}.png` });
    console.error(`wrote ${path.relative(process.cwd(), base)}.png`);
}
