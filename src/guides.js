/**
 * The guide the front page features. See `_guideHtml` in `src/ui/browse.js`.
 *
 * Its own module so a test can read it without loading the browse UI, which
 * imports PlayCanvas.
 *
 * `updated` is the guide's own "Last updated" date, and `picks` are lines
 * from its "So which one?" — both are claims about that page, and
 * `test/seo.test.js` fails if either stops matching it.
 */
export const HEADSET_GUIDE = Object.freeze({
    href: '/guides/vr-headsets',
    title: 'Next-gen VR headsets, compared',
    updated: '3 November 2026',
    blurb:
        'Quest 3 and 3S, Steam Frame, Galaxy XR, Vision Pro, Bigscreen Beyond 2 and ' +
        'Meta’s new VR Glasses, and the five numbers that decide how VR video ' +
        'actually looks on each.',
    picks: [
        ['Most people', 'Meta Quest 3'],
        ['Tight budget', 'Meta Quest 3S'],
        ['Best picture', 'Bigscreen Beyond 2']
    ]
});
