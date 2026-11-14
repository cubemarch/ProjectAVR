/**
 * Panel art for the generator on `cubemarch-hyworld`: what the model is
 * asked to draw, and what is lettered over it afterwards.
 *
 * `strips.js` is written for a person, or for an image model that can letter.
 * The SDXL checkpoint behind `txt2img` is neither: CLIP reads the first 77
 * tokens of a prompt and ignores the rest, it draws tags far better than
 * sentences, and every word it is asked to write comes out as glyph soup. So
 * each panel here is a short tag prompt with the speaker first, and anything
 * the reader has to *read* inside the picture (a folder label, a chyron, a
 * contract clause) is an `insert`, set in type by `make.js` like the
 * balloons are. The balloons themselves always come from `strips.js`.
 *
 * Only strips with an entry here can be generated. Write one per strip
 * rather than deriving it from the script's prose, because which handful of
 * tags fit in 77 tokens is a judgment about what the panel is for.
 */

/**
 * The model, and the settings its card recommends.
 *
 * Animagine XL 4.0, chosen on licence first: CreativeML Open RAIL++-M, which
 * permits commercial use and claims no rights in output, and this comic is
 * published on a commercial site. The generator's own default (janku-v5, a
 * NoobAI merge) is not usable here: NoobAI-XL's card prohibits commercial use
 * of "model-generated products". Checked 14 November 2026.
 *
 * The card's settings: Euler a, 28 steps, CFG 5. 896x1152 is one of its
 * trained portrait sizes and the nearest to a panel's 0.81.
 */
export const MODEL = {
    id: 'cagliostrolab/animagine-xl-4.0',
    scheduler: 'euler_a',
    steps: 28,
    guidance: 5,
    width: 896,
    height: 1152,

    /**
     * Lusty's character LoRA, on the box. Trained by `server/train_lora.py`
     * on the 18 images in `server/dataset.json`: the LX VIS 001 sheet and
     * the pilot pages, nothing generated. `lustyx` in a prompt calls her up;
     * 0.9 rather than 1 leaves the style presets room to restyle her.
     */
    lora: '/opt/comic/lora/lustyx',
    loraScale: 0.6
};

/**
 * Drawing styles, chosen with `make.js --style`. Each is inserted straight
 * after a panel's first three tags (count, `original`, the rating), because
 * CLIP stops reading at 77 tokens and a style left at the end of a long panel
 * prompt is the part that gets cut. `QUALITY` goes last; it matters least.
 *
 * Styles are described, never named after an artist or a series. An artist
 * or title tag pulls the model toward that artist's actual characters and
 * compositions, which is the copyright problem a commercial comic cannot
 * carry; the visual qualities themselves belong to nobody.
 */
export const STYLES = {
    /** The bible's approved look: high-fashion manga, clean and bright. */
    fashion: 'manga style, clean lineart, flat color, muted colors, teal and copper accents',

    /**
     * Dark seinen ink in colour: heavy blacks, hatching, hard light. Short
     * on purpose: the first, longer version pushed every panel's setting
     * past the 77-token cut, and 07 came back with no bank and no laptop.
     */
    ink: 'seinen manga, heavy black ink, crosshatching, high contrast, dramatic shadows',

    /**
     * The same ink as a black-and-white manga page. The model treats
     * `greyscale` as a suggestion and the first run came back in colour, so
     * `make.js` also desaturates the art for this style (see `MONO_STYLES`).
     */
    inkmono: 'greyscale, seinen manga, heavy black ink, crosshatching, screentone, high contrast',

    /** A painted colour plate over detailed ink: the cover and splash look. */
    illustration: 'painterly illustration, ink and watercolor, detailed linework, dramatic lighting, muted earth tones'
};

export const DEFAULT_STYLE = 'fashion';

/** Styles whose art is forced to greyscale when the page is lettered. */
export const MONO_STYLES = new Set(['inkmono']);

export const QUALITY = 'masterpiece, high score, great score, absurdres';

/**
 * Everything the model must not draw. The first group is not a style
 * preference: the comic is non-explicit and every character in it is an
 * adult. Text and balloons are refused because `make.js` letters them, and
 * model lettering under real lettering is noise. The rest is the card's own.
 */
export const NEGATIVE = [
    'text, speech bubble, watermark, signature, username, logo, multiple views, comic, panel border',
    'lowres, bad anatomy, bad hands, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, blurry'
].join(', ');

/**
 * Each character as the fewest tags that still tell them apart.
 *
 * One face per panel where the script allows it. Three described women in
 * one prompt blend: in the first drafts Nessa and Mira became two men in 07,
 * and Lusty took Nessa's skin in 08. Others in the scene are drawn turned
 * away, and the balloons say who they are.
 */
export const TAGS = {
    lusty: 'lustyx, mature female, copper hair, freckles, green eyes',
    lustyA: 'side braid, denim jacket, white shirt, jeans',
    lustyC: 'high ponytail, black sleeveless turtleneck, black jeans',
    mira: 'dark-skinned female, short curly black hair, round eyewear, green shirt',
    nessa: 'dark-skinned female, short curly platinum blonde hair, purple suit, hoop earrings',
    ferrer: 'mature female, black hair, eyewear on head, blue blazer',
    banker: 'old man, grey suit, glasses'
};

const t = (...keys) => keys.map((k) => TAGS[k]).join(', ');

/**
 * Strip number → four panels.
 *
 * `prompt` is what the model draws, starting with its count tag (STYLE is
 * appended by `make.js`).
 * `inserts` are lettered over the art: `chyron` (a broadcast lower third),
 * `doc` (a printed page), `label` (a small printed tag), `note` (a
 * handwritten card) and `badge` (a screen indicator). A real public figure is
 * never prompted by name: the model draws a generic figure, and the
 * chyron says who it is, which is the fallback `strips.js` asks for.
 */
export const PANELS = {
    7: [
        {
            prompt: `1girl, 1boy, original, safe, ${t('lusty', 'lustyC')}, sitting at desk, ${t('banker')}, other women from behind, bank office, daylight`,
            inserts: [{ type: 'label', text: 'FULL CREDIT STUDIO LLC — ARTICLES OF ORGANIZATION' }]
        },
        {
            prompt: `1girl, original, safe, ${t('lusty', 'lustyC')}, serious, expressionless, close-up, sitting, bank office, daylight`
        },
        {
            prompt: `1girl, original, safe, ${t('mira')}, looking up, bank lobby, wall-mounted television, from distance, daylight`,
            inserts: [{ type: 'chyron', text: 'GUARANTEEING FAIR BANKING FOR ALL AMERICANS' }]
        },
        {
            prompt: `1girl, original, safe, ${t('lusty', 'lustyC')}, smile, looking at viewer, sitting at desk, laptop, ring light, teal curtain, night, apartment`,
            inserts: [{ type: 'badge', text: 'LIVE · 12 WATCHING' }]
        }
    ],
    8: [
        {
            prompt: `1girl, original, safe, ${t('ferrer')}, sitting behind desk, two women from behind in foreground, cluttered law office, files, daylight`
        },
        {
            prompt: 'no humans, original, safe, close-up, printed contract on wooden desk, paper, pen, reading glasses, office, daylight',
            inserts: [
                {
                    type: 'doc',
                    text: '7.3  Creators who join the Partner VR Interest List are enrolled in the Creator Advance Program. Advances are recouped from future payouts.',
                    check: 'Join the Partner VR Interest List'
                }
            ]
        },
        {
            prompt: `1girl, original, safe, ${t('nessa')}, thoughtful, looking away, upper body, law office, daylight`
        },
        {
            prompt: `1girl, original, safe, ${t('lusty', 'lustyA')}, holding phone, leaning on counter, papers, kitchen, refrigerator, night, dim warm light`,
            inserts: [{ type: 'note', text: 'Challah' }]
        }
    ]
};
