import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { STRIPS } from './strips.js';

/**
 * The image-generator prompt for a strip, built from `strips.js`.
 *
 *   node comic/prompts.js 5        one strip
 *   node comic/prompts.js 5-10     a run of them
 *   node comic/prompts.js 7-25 --write   the same, into comic/PROMPTS.md
 *
 * Generated rather than written out, so a line changed in the script is the
 * line lettered in the art. Paste the output into the generator together with
 * two reference images: the LX VIS 001 character sheet and the most recent
 * finished strip, which carries the page layout and the faces forward. Save
 * the result as `comic/art/NN.jpg` (see `docs/COMIC.md`).
 */

/** LX VIS 001 v02. A strip's `look` is one of these letters, maybe with a note. */
const LOOKS = {
    A: 'Look A (everyday): copper side braid, faded denim jacket over a white tee, dark jeans, cognac Western boots with floral stitching.',
    B: 'Look B (networking): loose copper waves, cream wrap blouse, teal midi skirt, burgundy Western boots, gold hoops.',
    C: 'Look C (Rodeo Noir): high copper ponytail, black sleeveless mock-neck, black jeans with a silver-buckle belt, cherry-red Western boots, small X-shaped earrings.'
};

/**
 * Everyone who recurs, as a model sheet in words. Only the people a strip
 * mentions are included, so a prompt never invites an extra face.
 */
const CAST = {
    Lusty: 'LUSTY X: adult woman, 24. Copper-red hair, pale skin with freckles, green eyes, voluptuous adult build. Always Western boots unless the script says otherwise.',
    Mira: 'MIRA REYES: woman, 29. Dark skin, short tight curls, round wire glasses, sage-green overshirt over a white tee.',
    Nessa: 'NESSA VALE: woman, 27. Medium-brown skin, short platinum-blonde curls, lilac tailored suit, gold hoop earrings.',
    Dani: 'DANI KWAN: Korean American woman, 31. Buzzed black hair, olive bomber jacket, silver septum ring.',
    Ferrer: 'ANA LUCÍA FERRER: Cuban American lawyer, 40s. Dark hair with reading glasses pushed up into it, navy blazer.',
    Pryor: 'ROWAN PRYOR: androgynous executive, 40s. Cream linen suit, silver rings, calm and unhurried.',
    Priya: 'PRIYA NAND: South Asian woman, late 30s. Grey cardigan, hair in a low bun, lit by monitors.',
    Jules: 'JULES: trans woman, 30s. Sharp black blazer, coalition lanyard.',
    Mom: 'MOM: Lusty’s mother, 60s. Warm, sharp-eyed, an apron over a sweater.',
    Dad: 'DAD: Lusty’s father, 60s. Weathered farmer, flannel shirt.',
    Staffer: 'STAFFER: tired congressional staffer in their twenties, lanyard, notepad.',
    Banker: 'BANKER: polite bank branch manager, 50s, grey suit, rimless glasses.',
    Organizer: 'ORGANIZER (Rowan Pryor): androgynous executive, 40s. Cream linen suit, silver rings, calm and unhurried.'
};

const STYLE = [
    'High-fashion manga-influenced comic art: clean confident ink linework, expressive faces, adult proportions, flat colour with soft shading on a warm cream paper texture. Teal and copper accents.',
    'Night and interior scenes use thriller lighting: deep ink shadows, humid dark windows, reflected city light. Daylight scenes stay ordinary daylight.',
    'Everyone is an adult. Fully clothed, non-explicit, never sexualised in distress.'
].join(' ');

const pad = (n) => String(n).padStart(2, '0');

function lookText(look) {
    const letter = /^[ABC]\b/.exec(look)?.[0];
    if (!letter) return `Lusty’s wardrobe: ${look}`;
    const rest = look.slice(1).replace(/^[\s,]+/, '');
    return `Lusty’s wardrobe, ${LOOKS[letter]}` + (rest ? ` Also: ${rest}` : '');
}

/** How one line of the script is lettered. */
function lettering([who, text]) {
    if (who === 'Caption') return `Caption box (cream rectangle, top left): “${text}”`;
    if (who === 'Screen') return `Text drawn on the screen or phone shown: “${text}”`;
    return `Speech balloon from ${who}: “${text}”`;
}

/** @param {import('./strips.js').Strip} strip */
export function promptFor(strip) {
    const mentioned = [strip.setting, ...strip.panels.flatMap((p) => [p.art, ...p.lines.map(([who]) => who)])].join(' ');
    const cast = Object.entries(CAST)
        .filter(([name]) => name === 'Lusty' || new RegExp(`\\b${name}\\b`, 'i').test(mentioned))
        .map(([, sheet]) => `- ${sheet}`);

    const panels = strip.panels.map((p, i) => {
        const words = p.lines.length ? p.lines.map((l) => `   ${lettering(l)}`).join('\n') : '   No words in this panel.';
        return `PANEL ${i + 1} (${['top left', 'top right', 'bottom left', 'bottom right'][i]}): ${p.art}\n${words}`;
    });

    const figures = (strip.figures ?? []).map((f) => {
        const name = f.split(',')[0];
        return `- ${f} If you cannot depict ${name}, draw a generic figure on the screen or from behind, at a distance, and keep any caption or chyron exactly as written.`;
    });

    return [
        `A single finished comic page, portrait 3:4 (1086×1448), in the style of the attached reference strip.`,
        '',
        `LAYOUT: At the top, the series title “LUSTY X” in heavy black italic serif capitals between thin double rules, with “${pad(strip.n)}  ${strip.title.toUpperCase()}” in small widely spaced serif capitals beneath. Below it, a 2×2 grid of four panels with thin black borders and narrow white gutters. At the bottom, “${strip.arc.toUpperCase()}” in small widely spaced serif capitals between thin rules.`,
        '',
        `LETTERING: Round white speech balloons with black italic serif lettering and a tail to the speaker. Letter exactly the words given below, spelled exactly, and no other words anywhere except the screen text, signs and captions described.`,
        '',
        `STYLE: ${STYLE}`,
        '',
        'CHARACTERS (match the attached character sheet):',
        ...cast,
        `- ${lookText(strip.look)}`,
        '',
        `SETTING: ${strip.setting}`,
        '',
        ...panels.flatMap((p) => [p, '']),
        ...(figures.length ? ['REAL PUBLIC FIGURES (public role only, as described, nothing else):', ...figures, ''] : [])
    ]
        .join('\n')
        .trim();
}

/** "5" or "5-10" into strips. */
export function select(arg, strips = STRIPS) {
    const [from, to = from] = String(arg).split('-').map(Number);
    return strips.filter((s) => s.n >= from && s.n <= to);
}

/** The prompts for a run of strips, as the Markdown file `--write` saves. */
export function promptsDocument(range) {
    const body = select(range)
        .map((s) => `## ${pad(s.n)} ${s.title} · ${s.date}\n\n\`\`\`text\n${promptFor(s)}\n\`\`\``)
        .join('\n\n');
    return (
        `<!-- Generated by \`node comic/prompts.js ${range} --write\` from comic/strips.js. ` +
        `Do not edit; change the script and run it again. test/comic.test.js fails if this file is stale. -->\n\n` +
        `# Lusty X art prompts, ${range}\n\n` +
        'Paste one prompt into the image generator with two references attached: the LX VIS 001 ' +
        'character sheet and the most recent finished strip. Save the result as `comic/art/NN.jpg`.\n\n' +
        body +
        '\n'
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [range = '', flag] = process.argv.slice(2);
    const chosen = select(range);
    if (!chosen.length) {
        console.error('usage: node comic/prompts.js <n> | <from>-<to> [--write]');
        process.exit(1);
    }
    if (flag === '--write') {
        fs.writeFileSync(new URL('./PROMPTS.md', import.meta.url), promptsDocument(range));
        console.log(`wrote comic/PROMPTS.md (${chosen.length} strips)`);
    } else {
        console.log(chosen.map((s) => `===== ${pad(s.n)} ${s.title} (${s.date}) =====\n\n${promptFor(s)}`).join('\n\n\n'));
    }
}
