/**
 * Lusty X: every strip, published and not, in one list.
 *
 * This is the script and the publishing schedule at once. `server/comic.js`
 * reads it and shows a strip from 06:00 New York time on its `date`, and only
 * once its art is in `comic/art/` as `NN.jpg` (or `.png`, `.webp`). A strip
 * with a date but no art stays unpublished, so art can be delivered weeks
 * ahead and still release on the day, and a late drawing never leaves a hole.
 *
 * Nothing in this file is served. The page renders a published strip's
 * `summary` and its dialogue as the transcript; future strips, `art`,
 * `setting`, `after`, `figures` and `verify` never leave the server.
 *
 * ## Canon
 *
 * Strips 01–04 are the pilots from the series bible (LX BIB 001 v0.5). Their
 * `lines` are what is lettered on the art that exists, because the transcript
 * has to describe the picture: 01 and 03 carry the earlier comedy dialogue the
 * bible says the v03 scripts supersede, and 02 has no art yet, so its lines
 * are LX SCR 002 v03. See `docs/COMIC.md` for the decisions this season makes
 * that the bible left open.
 *
 * Header lettering on every strip: "LUSTY X", then "NN TITLE". Footer
 * lettering: the arc name. Thriller lighting from the bible applies
 * throughout; daylight scenes stay ordinary daylight.
 *
 * ## Real public figures
 *
 * `figures` lists every real person a strip depicts. They appear only in their
 * public role and in a political setting, never in a scene with sexual
 * content, never as a customer or viewer of adult work, never connected to
 * the payout case, and the comic page says none of them endorsed it. Each
 * panel that shows one also works if the art renders them as a TV image or
 * from behind with a caption naming them, because most image generators will
 * not draw a recognisable politician.
 *
 * Never in panel 1. The front page's card crops the latest strip to its first
 * panel, and a real person there is a real person promoting the site.
 */

/** @typedef {[speaker: string, text: string]} Line */
/** @typedef {{ art: string, lines: Line[] }} Panel */
/**
 * @typedef {object} Strip
 * @property {number} n
 * @property {string} title
 * @property {string} date      ISO date, New York time.
 * @property {string} arc       Footer lettering.
 * @property {string} [canon]   Bible id this strip covers.
 * @property {string} look      Wardrobe A, B or C (LX VIS 001 v02), or a note.
 * @property {string} summary   One sentence. The image's alt text and the page description.
 * @property {string} setting
 * @property {Panel[]} panels
 * @property {string} [after]   Continuity after the strip.
 * @property {string[]} [figures]
 * @property {string[]} [verify] Facts to check against the week's news before the art is final.
 */

/** @type {readonly Strip[]} */
export const STRIPS = Object.freeze([
    /* ---------------------------------------------------------- pilots -- */
    {
        n: 1,
        title: 'Depth Check',
        date: '2026-11-13',
        arc: 'Pilot 01',
        canon: 'LX P001',
        look: 'A',
        summary:
            'Lusty rehearses her first VR set while Mira tests the playback, and a backdrop meant to hide the laundry ends up covering one of the camera’s two lenses.',
        setting: 'Lusty’s apartment, an offline VR rehearsal. Art exists (comedy dialogue).',
        panels: [
            { art: 'Lusty on set; Mira in the headset at the desk, laptop reads OFFLINE TEST.', lines: [['Lusty', 'Does it feel immersive?'], ['Mira', 'I’m standing in your laundry.']] },
            { art: 'The two views on the laptop.', lines: [['Mira', 'Then fold the product.'], ['Lusty', 'Intimacy is the product.']] },
            { art: 'Lusty sweeps the teal backdrop across.', lines: [['Lusty', 'Behold. A boutique studio.']] },
            { art: 'The backdrop’s corner covers one lens.', lines: [['Mira', 'You’ve covered one lens.'], ['Lusty', 'Luxury is mostly deciding what people don’t get to see.']] }
        ]
    },
    {
        n: 2,
        title: 'Boots on Deck',
        date: '2026-11-13',
        arc: 'Pilot 02',
        canon: 'LX P002',
        look: 'B',
        summary:
            'At a yacht mixer in Miami, an organizer offers Lusty a VR project and says ownership can be discussed afterward.',
        setting: 'A moored yacht at a creator event, sunset. Lusty is Nessa’s plus-one. LX SCR 002 v03; no art yet.',
        panels: [
            { art: 'Approaching the deck; small venue cameras visible.', lines: [['Nessa', 'Invitation only. No recordings.'], ['Lusty', 'Does that include the people paying for the cameras?']] },
            { art: 'The organizer approaches. Lusty listens before selling herself.', lines: [['Organizer', 'Our platform needs someone who understands VR.'], ['Lusty', 'What exactly would I be building?']] },
            { art: 'The organizer’s hand offers a card; Lusty’s still expression.', lines: [['Organizer', 'Bring a proposal. We’ll discuss ownership afterward.']] },
            { art: 'A quieter part of the deck. In the background by the bar, a small standing card with a QR code (strip 19 needs it).', lines: [['Nessa', 'Still interested?'], ['Lusty', 'Now I want to read the contract.']] }
        ]
    },
    {
        n: 3,
        title: 'Full Credit',
        date: '2026-11-13',
        arc: 'Pilot 03',
        canon: 'LX P003',
        look: 'C',
        summary:
            'A showcase wants Lusty and Nessa’s VR demo but not the words “cam model” in their biography, so they put both titles in and send their terms.',
        setting: 'Nessa’s studio. Art exists (comedy dialogue).',
        panels: [
            { art: 'Nessa at the laptop; Lusty celebrating.', lines: [['Nessa', 'They want our VR demo.'], ['Lusty', 'Our first showcase!']] },
            { art: 'Close on both.', lines: [['Nessa', 'But ‘cam model’ comes out of the bio.']] },
            { art: 'Lusty, firm.', lines: [['Lusty', 'Cam model. VR creator. Put both.']] },
            { art: 'Nessa types; Lusty writes in a notebook.', lines: [['Nessa', 'I’ll send our terms.'], ['Lusty', 'And an invoice.']] }
        ]
    },
    {
        n: 4,
        title: 'Second Statement',
        date: '2026-11-13',
        arc: 'Pilot 04',
        canon: 'LX P004',
        look: 'C',
        summary:
            'Nessa’s payout provider sends a corrected statement that drops a $480 deduction but keeps the same closing balance, and an anonymous message tells her to delete the original.',
        setting: 'Lusty’s apartment at night. Art exists (thriller treatment).',
        panels: [
            { art: 'Two statements on the table, laptop light.', lines: [['Nessa', 'They called it an error. Sent a new statement.'], ['Lusty', 'And the money?']] },
            { art: 'ORIGINAL and REVISED side by side.', lines: [['Screen', 'Original: Adjustment −$480.00. Closing balance $1,440.00. Revised: closing balance $1,440.00.'], ['Lusty', 'Same closing balance. They removed the line, not the charge.']] },
            { art: 'Lusty saves both files.', lines: [['Nessa', 'Can you prove it?'], ['Lusty', 'Keep both files. We need the ledger.']] },
            { art: 'Business inbox: UNKNOWN.', lines: [['Screen', 'Unknown: Delete the first statement.'], ['Lusty', 'Someone prefers the revised edition.']] }
        ]
    },

    /* ----------------------------------------- week 1: Constituents -- */
    {
        n: 5,
        title: 'Carry-On',
        date: '2026-11-17',
        arc: 'Constituents',
        look: 'B, with a thrifted camel coat over it; burgundy boots. Nessa in the lilac suit and a long coat.',
        summary:
            'Lusty and Nessa fly to Washington for a sex worker lobby day with the original statement on a drive, and the anonymous sender already knows they are there.',
        setting:
            'Miami airport at dawn, then the Capitol Visitor Center. November grey. Mira appears only on a phone screen; she stays in Miami.',
        panels: [
            {
                art: 'Departure gate, dawn. Nessa holds two lanyards that read SEX WORKER LOBBY DAY. Lusty clips a small USB drive labelled ORIGINAL inside her coat.',
                lines: [['Nessa', 'Twelve offices. Ten minutes each.'], ['Lusty', 'And one statement nobody gets to revise.']]
            },
            {
                art: 'Mira on a video call on Lusty’s phone, at her desk in Miami.',
                lines: [['Mira', 'Three backups. The sender’s address is a dead end.'], ['Lusty', 'Somebody built the dead end.']]
            },
            {
                art: 'Through the plane window, the Capitol dome over the Potomac on the approach to DCA.',
                lines: [['Caption', 'Washington. Lame-duck week.'], ['Nessa', 'Half of them just found out they’re losing their jobs.'], ['Lusty', 'Then they know how an unexpected statement feels.']]
            },
            {
                art: 'Capitol Visitor Center hall. A TV on the wall shows Speaker Mike Johnson at a podium, chyron LAME-DUCK SESSION RESUMES. Nessa holds her phone out; Lusty’s face is controlled.',
                lines: [['Screen', 'Unknown: Enjoy Washington.'], ['Lusty', 'Who knew we’d be here?'], ['Nessa', 'Forty thousand followers. I posted the lanyard.']]
            }
        ],
        after:
            'The message is unsettling, but where they are was public, so it identifies nobody. Lusty now carries the original statement on a drive; Mira holds three backups.',
        figures: ['Mike Johnson, Speaker of the House: on a TV in the background of panel 4. No dialogue; the chyron only.'],
        verify: ['The House is in session the week of 16 November and Johnson is still Speaker (Speaker for the 120th Congress is TBD; it convenes 3 January 2027). Not yet checked: the lame-duck calendar.']
    },
    {
        n: 6,
        title: 'Ninety-Seven to Two',
        date: '2026-11-19',
        arc: 'Constituents',
        look: 'B with the coat.',
        summary:
            'In a Senate office Lusty reminds a staffer how fast FOSTA passed, then hands a page on payment discrimination to Senator Elizabeth Warren in a hallway.',
        setting:
            'A cramped Senate staff office, then the Hart Building atrium with Calder’s black Mountains and Clouds sculpture overhead. Jules, a trans woman from the coalition, is with them: sharp blazer, coalition lanyard.',
        panels: [
            {
                art: 'A tired staffer in their twenties with a notepad. Lusty, Nessa and Jules on a small couch.',
                lines: [['Staffer', 'The Senator supports studying the issue.']]
            },
            {
                art: 'Close on Lusty. The staffer’s pen has stopped.',
                lines: [['Lusty', 'FOSTA passed the Senate ninety-seven to two. Nobody needed a study for that vote.']]
            },
            {
                art: 'Nessa slides a one-page sheet across: PAYMENT DISCRIMINATION — CASE NOTES.',
                lines: [['Nessa', 'Banks and payout companies close our accounts and change our statements. There’s no appeal.'], ['Staffer', 'That’s the Banking Committee.']]
            },
            {
                art: 'Hart atrium under the Calder. Senator Elizabeth Warren walks past with two aides and takes the sheet from Lusty without breaking stride.',
                lines: [['Warren', 'Payment processors? Get it to my Banking staff. In writing.'], ['Lusty', 'We have it in writing. Twice.']]
            }
        ],
        after:
            'The sheet goes to a Banking Committee office; nobody promises anything. Nessa decided what the case notes say, and they name no company.',
        figures: [
            'Elizabeth Warren, US Senator: panel 4, one line consistent with her public role on the Banking Committee. Shown taking a page in a public hallway; no other interaction.'
        ],
        verify: [
            'The Senate passed FOSTA-SESTA 97–2 on 21 March 2018.',
            'Warren’s Banking Committee role (ranking member since January 2025). Democrats take the Senate in January, so she may be chair-designate; no source checked says so yet. “Banking staff” is true either way.'
        ]
    },
    {
        n: 7,
        title: 'Reputational Risk',
        date: '2026-11-21',
        arc: 'Day One',
        look: 'C',
        summary:
            'Back in Miami, Lusty, Nessa and Mira open their own studio, a bank turns the company down as a reputational risk, and Lusty goes live anyway.',
        setting:
            'Miami, the first day of Full Credit Studio LLC, the company Lusty, Nessa and Mira have formed together (named for the bio they refused to cut in strip 03). A bank branch in the morning; Lusty’s apartment that night. Lusty is new to camming as a business; Nessa is the experienced performer; Mira runs the technology.',
        panels: [
            {
                art: 'A bright bank branch. A polite branch manager behind a desk. Lusty, Nessa and Mira opposite, Mira holding a folder labelled FULL CREDIT STUDIO LLC — ARTICLES OF ORGANIZATION. No TV in this panel.',
                lines: [['Caption', 'Miami. Day one.'], ['Banker', 'And the nature of the business?'], ['Nessa', 'Adult webcam performance. And VR production.']]
            },
            {
                art: 'The banker closes the folder and slides it back, smiling apologetically. Lusty very still.',
                lines: [['Banker', 'I’m afraid that’s a reputational risk for the bank.'], ['Lusty', 'Whose? We haven’t done anything yet.']]
            },
            {
                art: 'Walking out through the lobby. A TV on the lobby wall shows President Trump holding up a signed order; chyron GUARANTEEING FAIR BANKING FOR ALL AMERICANS. Mira glances up at it.',
                lines: [['Mira', 'Fair banking for all Americans.'], ['Lusty', 'Terms and conditions apply.']]
            },
            {
                art: 'Night, Lusty’s apartment. A ring light, the teal backdrop, a laptop showing LIVE and 12 WATCHING. Lusty, fully dressed, smiling at the webcam. Nessa just out of frame with a thumbs-up; Mira at the desk watching the stream health. The stereo camera sits switched off on its tripod.',
                lines: [['Lusty', 'Hi. I’m Lusty X. First night.'], ['Nessa', 'Twelve viewers. Rent’s due in nine days.']]
            }
        ],
        after:
            'Full Credit Studio LLC exists and is co-owned by Lusty, Nessa and Mira. It has no business bank account yet, so each performer is still paid into her own account. Lusty’s first live shows are ordinary flat webcam; VR stays an experiment. The bank’s refusal is the season’s first instance of financial exclusion and accuses nobody of anything.',
        figures: ['Donald Trump, President: on a lobby TV in panel 3, holding up a signed order. No dialogue; the chyron is the executive order’s title.'],
        verify: ['Executive order “Guaranteeing Fair Banking for All Americans”, August 2025, which told regulators to stop citing reputational risk. Swap the chyron for that week’s debanking headline if there is a newer one.']
    },

    /* --------------------------------------------- week 2: Fine Print -- */
    {
        n: 8,
        title: 'Fine Print',
        date: '2026-11-24',
        arc: 'Fine Print',
        canon: 'LX E005',
        look: 'A',
        summary:
            'Nessa’s lawyer finds that signing up for a VR interest list quietly enrolled creators in an advance that is repaid from their pay.',
        setting:
            'NEW CHARACTER, Ana Lucía Ferrer, 40s, the lawyer Nessa chose: a small Coral Way office, reading glasses pushed up into dark hair, files everywhere. Then Lusty’s kitchen at night.',
        panels: [
            {
                art: 'Ferrer behind her desk; Nessa and Lusty opposite.',
                lines: [['Ferrer', 'Nessa hired me, Lusty. I don’t work for you.'], ['Lusty', 'Good. Then you’ll tell her when I’m wrong.']]
            },
            {
                art: 'Close on the contract: “7.3 Creators who join the Partner VR Interest List are enrolled in the Creator Advance Program. Advances are recouped from future payouts.” A pre-ticked box beside it.',
                lines: [['Ferrer', 'An interest list that signs you up for a loan.']]
            },
            {
                art: 'Nessa, remembering.',
                lines: [['Nessa', 'I joined it on the yacht. A QR code by the bar.'], ['Ferrer', 'Then the question is who received the advance.'], ['Lusty', 'Not you.']]
            },
            {
                art: 'Lusty’s kitchen at night, contract pages across the counter. On the fridge, a handwritten recipe card headed “Challah”, unremarked. She texts Mira.',
                lines: [['Lusty', 'Who’s the partner in partner advance?'], ['Screen', 'Mira: Pryor’s company is the obvious answer.'], ['Lusty', 'Obvious answers are cheap.']]
            }
        ],
        after:
            'The advance clause is unfair terms, not proof of theft. Nobody yet knows where the advance money went. The challah card follows the bible’s hint plan for E005.'
    },
    {
        n: 9,
        title: 'Scale Ticket',
        date: '2026-11-26',
        arc: 'Fine Print',
        look: 'A, braid; a barn coat by the door.',
        summary:
            'At Thanksgiving on her parents’ Pennsylvania farm, her father’s story about a grain elevator shows Lusty how the $480 disappeared.',
        setting:
            'The farmhouse kitchen and dining room, Thanksgiving. First frost outside. Dad, 60s, weathered, flannel shirt; Mom, 60s, warm and sharp-eyed. A small kitchen TV. Whether her parents know about her work stays open: nothing here settles it.',
        panels: [
            {
                art: 'The table, the turkey, Lusty between her parents. The kitchen TV chyron: AFTER THE BLUE WAVE: WHAT CHANGES IN JANUARY.',
                lines: [['Dad', 'Everything changes in January, they say.'], ['Mom', 'And your camera business?'], ['Lusty', 'Someone’s changing a friend’s numbers now.']]
            },
            {
                art: 'Dad takes two yellowed grain-elevator scale tickets out of a kitchen drawer.',
                lines: [['Dad', 'The elevator did that to me once. Same check. Lighter scale ticket.']]
            },
            {
                art: 'Close on the two tickets side by side: GROSS WEIGHT differs; the deductions line is identical.',
                lines: [['Lusty', 'They didn’t hide the deduction. They changed the weight.']]
            },
            {
                art: 'The dark mudroom, phone light on Lusty’s face. On screen, Nessa’s screenshot: EARNED THIS PERIOD $1,920.00, beside the revised statement: GROSS $1,440.00. A balloon from the kitchen.',
                lines: [['Lusty', 'Light by four-eighty.'], ['Mom', 'Pie!']]
            }
        ],
        after:
            'The deduction was not removed. The revised statement understates Nessa’s gross earnings by the same $480, which her platform dashboard contradicts. That is a discrepancy in a record, not yet a person.',
        verify: ['Checked 14 Nov against Wikipedia (not primary sources): Democrats won the House (257 seats, 9 uncalled) and the Senate (8 gains, Alaska uncalled), and outlets widely call it a blue wave. Re-check the chyron against final calls.']
    },
    {
        n: 10,
        title: 'Page One',
        date: '2026-11-28',
        arc: 'Fine Print',
        look: 'C',
        summary:
            'Lusty sends Rowan Pryor her VR proposal with ownership on page one and no interest list, and Pryor’s answer about the advances is not an answer.',
        setting:
            'Lusty’s apartment, morning. Video call with Rowan Pryor, the organizer from the yacht, now LX CH 004: 40s, linen suit, silver rings, unhurried; they/them. Their call background is the SALTGLASS VR logo. Mira on the couch with a laptop, off camera.',
        panels: [
            {
                art: 'Caption box. Lusty at her desk; Pryor on the laptop.',
                lines: [['Caption', 'Small Business Saturday.'], ['Lusty', 'My proposal. Ownership is on page one.'], ['Pryor', 'Everyone else signed our standard terms.']]
            },
            {
                art: 'Lusty, still.',
                lines: [['Lusty', 'Including the interest list?'], ['Pryor', 'The advance is a perk. Seed money for creators.']]
            },
            {
                art: 'Pryor, smooth, a hand open.',
                lines: [['Lusty', 'Who received the seed money?'], ['Pryor', 'Our payments partner runs it. I never see accounts.'], ['Lusty', 'That answers a different question.']]
            },
            {
                art: 'Call ended. Mira looks up from the couch.',
                lines: [['Mira', 'Evasive isn’t guilty.'], ['Lusty', 'I know. That’s what makes Pryor the easy answer.']]
            }
        ],
        after:
            'The P002 proposal is now sent, on Lusty’s terms. Pryor has not accepted. Pryor is the obvious suspect and the story is about to make Lusty forget her own warning.'
    },

    /* ----------------------------------------- week 3: Blind Angle -- */
    {
        n: 11,
        title: 'Rent Fund',
        date: '2026-12-01',
        arc: 'Blind Angle',
        canon: 'LX E006',
        look: 'A',
        summary:
            'At a Giving Tuesday mutual-aid table, Nessa receives a photo of a front door with the words “Delete it.”',
        setting:
            'A community room in Little Haiti. A folding table, a hand-lettered sign SEX WORKER MUTUAL AID — RENT FUND, red ribbons in a bowl for World AIDS Day. NEW CHARACTER, Dani Kwan, 31, who runs the fund: Korean American, buzzed black hair, olive bomber jacket, silver septum ring. A former chargebacks analyst, now a cam performer. She is counting envelopes.',
        panels: [
            {
                art: 'The table, volunteers and workers.',
                lines: [['Caption', 'Giving Tuesday. World AIDS Day.'], ['Dani', 'Eleven workers with frozen payouts. Rent’s due Friday.']]
            },
            {
                art: 'Nessa reads her phone. The colour drains from her face.',
                lines: []
            },
            {
                art: 'The phone: a photo of an apartment door, taken that morning. Unit number visible: 4B.',
                lines: [['Screen', 'Unknown: Delete it.']]
            },
            {
                art: 'Lusty steps between Nessa and the room, calm. Dani is already on her phone arranging a ride.',
                lines: [['Lusty', 'You’re not going home alone tonight.'], ['Nessa', 'I’m not deleting anything.'], ['Lusty', 'Then nobody goes anywhere alone.']]
            }
        ],
        after:
            'A credible threat. Nessa stays with Lusty. No one confronts anyone or goes looking for the sender in person. Show the safe exit, not tactics.',
        verify: ['Giving Tuesday and World AIDS Day are both 1 December 2026.']
    },
    {
        n: 12,
        title: 'Blind Angle',
        date: '2026-12-03',
        arc: 'Blind Angle',
        look: 'C',
        summary:
            'The door in the threatening photo is Nessa’s old apartment, and only one record still has that address.',
        setting: 'Lusty’s apartment at night, the blinds down. Mira at the laptop; Nessa wrapped in a blanket. The brass candlesticks on a shelf, out of frame of anything that matters.',
        panels: [
            {
                art: 'Mira scrolling people-search sites.',
                lines: [['Mira', 'Your address isn’t online. I checked every people-search site.'], ['Nessa', 'Fans get a P.O. box.']]
            },
            {
                art: 'Nessa looks at the photo again, properly this time.',
                lines: [['Nessa', 'That’s 4B. I moved up to 7A in September.']]
            },
            {
                art: 'Mira and Lusty exchange a look across the laptop.',
                lines: [['Mira', 'So whoever sent it has an address you stopped using.'], ['Lusty', 'Who still has 4B?']]
            },
            {
                art: 'Nessa, quiet. The dark window behind them.',
                lines: [['Nessa', 'My tax form. At the platform.'], ['Mira', 'Which tells us where to look. Not who.']]
            }
        ],
        after:
            'The threat came from someone with access to an outdated record held by Nessa’s cam platform, or to a copy of it. Pryor’s company would not normally hold that form, which Lusty does not yet weigh.'
    },
    {
        n: 13,
        title: 'First Light',
        date: '2026-12-05',
        arc: 'Blind Angle',
        look: 'A, hair loose.',
        summary:
            'On the first night of Hanukkah, which falls on a Friday, Lusty lights the candles and Nessa, staying with her, learns something the audience doesn’t know.',
        setting:
            'Lusty’s apartment, Friday before sunset, the bay going gold. A small brass menorah on the windowsill; the two worn brass candlesticks on the table; a round challah. The work set is struck and the stereo camera is off.',
        panels: [
            {
                art: 'Lusty lights the first Hanukkah candle with the helper candle. Nessa on the couch under a blanket, watching.',
                lines: [['Caption', 'Friday, before sunset.'], ['Nessa', 'I didn’t know.'], ['Lusty', 'Not many people do.']]
            },
            {
                art: 'Lusty lights the two Shabbat candles in the old candlesticks.',
                lines: []
            },
            {
                art: 'Her hands over her eyes for the blessing, candlelight on her freckles. Nessa looks away to give her the moment.',
                lines: []
            },
            {
                art: 'The two of them at the small table with the challah. Lusty’s phone lies face down.',
                lines: [['Nessa', 'Does the audience know?'], ['Lusty', 'The audience knows my boots.'], ['Nessa', 'And now I know.'], ['Lusty', 'And now you do.']]
            }
        ],
        after:
            'Nessa now knows that Lusty is Jewish, because Lusty chose to let her see it. Nothing here is a clue to the case. The candles take the first lighting from E008 onto the first night of Hanukkah.',
        verify: ['Hanukkah 2026 begins at sundown Friday 4 December. On a Friday the Hanukkah candles are lit before the Shabbat candles.']
    },

    /* --------------------------------------- week 4: Borrowed Time -- */
    {
        n: 14,
        title: 'Sixty-One Days',
        date: '2026-12-08',
        arc: 'Borrowed Time',
        canon: 'LX E007',
        look: 'A',
        summary:
            'Dani tells Lusty she was drinking when she first reported her missing pay, and shows her the notebook she kept anyway.',
        setting: 'Early morning. Dani comes out of a church hall (a small sign: TUESDAY 7 AM). Then a Cuban café window counter, two cafecitos.',
        panels: [
            {
                art: 'Dani on the church hall steps; Lusty waiting with two coffees.',
                lines: [['Dani', 'I came from a meeting. Sixty-one days.'], ['Lusty', 'Congratulations.']]
            },
            {
                art: 'At the café counter. Dani looks at her coffee, not at Lusty.',
                lines: [['Dani', 'In August I wasn’t sober. That’s when I reported the missing money. Support closed it: “customer confused.”']]
            },
            {
                art: 'Dani opens a battered notebook: dated rows of payouts, each ticked against a bank deposit. One August row is circled: PTR-ADV RECOUP −$310.00.',
                lines: [['Dani', 'I was a mess. I still wrote everything down.'], ['Lusty', 'Habit from chargebacks?'], ['Dani', 'Habit from not trusting anyone.']]
            },
            {
                art: 'Lusty holds Dani’s banking app beside the notebook. The figures match to the cent.',
                lines: [['Lusty', 'Your bank agrees with you. Their statement doesn’t.'], ['Dani', 'So I wasn’t confused.'], ['Lusty', 'You were right before anyone listened.']]
            }
        ],
        after:
            'First corroboration: a second worker’s deduction, recorded with a code (PTR-ADV) before anyone revised it. Dani’s records are independent of the statements and corroborate her. Her recovery is hers: she chose to tell Lusty, and it is not evidence of anything. No family or heritage hint in this arc.'
    },
    {
        n: 15,
        title: 'Reliability',
        date: '2026-12-10',
        arc: 'Borrowed Time',
        look: 'C',
        summary:
            'The platform’s lawyers question Dani’s reliability, and Dani decides exactly what she will and won’t disclose.',
        setting: 'Ferrer’s office, afternoon. Dani, Lusty, Ferrer.',
        panels: [
            {
                art: 'Ferrer reads a letter; its letterhead is cropped out of frame, because the platform is not named until strip 19.',
                lines: [['Caption', 'December 10. Human Rights Day.'], ['Ferrer', 'They say Ms. Kwan’s account history “raises questions of reliability.”']]
            },
            {
                art: 'Dani, rigid in her chair.',
                lines: [['Dani', 'They mean August.'], ['Ferrer', 'They mean they’d rather argue about you than about their ledger.']]
            },
            {
                art: 'Ferrer slides a consent form across: separate boxes for PAYOUT RECORDS, BANK STATEMENTS, NOTEBOOK, HEALTH INFORMATION.',
                lines: [['Ferrer', 'You decide what we disclose. We answer with your bank records, not your medical history.']]
            },
            {
                art: 'Dani ticks three boxes and leaves HEALTH INFORMATION empty. Lusty watches and does not lean in.',
                lines: [['Dani', 'Records, yes. My story, no.'], ['Lusty', 'Your call.']]
            }
        ],
        after: 'Dani has chosen to disclose records only. Lusty respects it without argument, which is the habit the season is teaching her.',
        verify: ['Human Rights Day is 10 December.']
    },
    {
        n: 16,
        title: 'Partner 0417',
        date: '2026-12-12',
        arc: 'Borrowed Time',
        look: 'C',
        summary:
            'Three workers’ deductions share the same partner number, and Lusty decides it must be Pryor before Mira can stop her.',
        setting: 'Nessa’s studio at night, a whiteboard wheeled in. Nessa, Lusty, Mira, Dani.',
        panels: [
            {
                art: 'Dani writes PTR-ADV-0417 on the whiteboard.',
                lines: [['Dani', 'PTR-ADV. Partner advance, recouped. The full code has a partner number, and Nessa’s has it too.']]
            },
            {
                art: 'Close on the small print of Nessa’s original statement: PTR-ADV-0417.',
                lines: [['Mira', 'A third worker sent hers tonight. Same number.']]
            },
            {
                art: 'Lusty tapes Pryor’s business card from the yacht beside the number and draws an arrow.',
                lines: [['Lusty', 'Partner 0417 is Pryor.'], ['Mira', 'We don’t know that.']]
            },
            {
                art: 'Lusty, tired eyes, too sure. Mira quiet, arms folded.',
                lines: [['Lusty', 'Pryor ran the interest list. Pryor offered the advance. Who else?'], ['Mira', 'That’s a question. Not an answer.']]
            }
        ],
        after:
            'Three of the workers who chose to share have the same partner code. Lusty’s theory has outrun the evidence, and the friction with Mira is unresolved.'
    },

    /* ----------------------------------------- week 5: Quiet Hours -- */
    {
        n: 17,
        title: '3:12 A.M.',
        date: '2026-12-15',
        arc: 'Quiet Hours',
        canon: 'LX E008',
        look: 'An oversized sleep shirt; the boots are by the door.',
        summary:
            'At three in the morning Lusty drafts a public accusation, finds a deadline, and deletes the post because it isn’t hers to make.',
        setting: 'Lusty’s apartment, dark but for the laptop. The unlit candlesticks on the shelf behind her.',
        panels: [
            {
                art: 'Lusty hunched at the laptop. On screen, a draft post: “THREAD: Saltglass VR is skimming creators’ pay —”',
                lines: [['Caption', '3:12 A.M.']]
            },
            {
                art: 'Her phone, a text exchange.',
                lines: [['Screen', 'Lusty: Ready to go public? Nessa: No. And go to sleep.']]
            },
            {
                art: 'The payout portal open in another tab. A yellow banner across the top.',
                lines: [['Screen', 'Superseded statements will be archived at year-end close: December 31, 11:59 PM ET.'], ['Lusty', 'Sixteen days. Then only our copies exist.']]
            },
            {
                art: 'Lusty deletes the draft. She lies on the floor beside the couch, eyes open.',
                lines: [['Lusty', 'Not my statement. Not my call.']]
            }
        ],
        after:
            'The deadline is set: superseded statements leave the portal at year-end close. The draft accusation was never posted. Lusty has not slept properly in days.'
    },
    {
        n: 18,
        title: 'Red Umbrellas',
        date: '2026-12-17',
        arc: 'Quiet Hours',
        look: 'C',
        summary:
            'At a vigil on the International Day to End Violence Against Sex Workers, Mira shows Lusty the assumption her theory rested on.',
        setting: 'Bayfront Park at dusk. A crowd under red umbrellas, candles in paper cups. Nessa at a small microphone reading names.',
        panels: [
            {
                art: 'Wide: red umbrellas, the bay behind. Lusty holds one, exhausted.',
                lines: [['Caption', 'December 17. International Day to End Violence Against Sex Workers.']]
            },
            {
                art: 'Mira beside her, phone showing the payout processor’s public developer documentation.',
                lines: [['Mira', 'Can I say something you won’t like?'], ['Lusty', 'You will anyway.']]
            },
            {
                art: 'Close on the docs: “Payout files are submitted by the platform. partner_id: assigned by the platform.”',
                lines: [['Mira', 'The platform sends the payout file. The platform assigns partner numbers.'], ['Lusty', 'So 0417 isn’t Pryor’s number.'], ['Mira', 'It’s whoever the platform calls a partner. We don’t know who.']]
            },
            {
                art: 'Lusty lowers the umbrella a little. Nessa’s voice from the stage in a jagged balloon.',
                lines: [['Nessa', '…and the ones we couldn’t name.'], ['Lusty', 'I can keep looking. I don’t think I should do it alone.'], ['Mira', 'Good. You’re not.']]
            }
        ],
        after:
            'The missed assumption: Lusty treated the statement as the processor’s arithmetic, and the partner as whoever she already distrusted. The platform, not the processor and not Pryor, writes the numbers.',
        verify: ['17 December is the International Day to End Violence Against Sex Workers; red umbrellas are its usual symbol.']
    },
    {
        n: 19,
        title: 'Quiet Hours',
        date: '2026-12-19',
        arc: 'Quiet Hours',
        look: 'B',
        summary:
            'After a night’s sleep and a Friday dinner with friends, a photo from the yacht shows who partner 0417 is.',
        setting:
            'Lusty’s apartment, Friday at sunset. The two brass candlesticks lit on the table. Mira, Nessa and Dani at dinner, a challah half gone.',
        panels: [
            {
                art: 'Lusty, rested, hair down, at the head of the table, the two candles lit.',
                lines: [['Caption', 'Friday, before sunset.'], ['Dani', 'You slept.'], ['Lusty', 'Eleven hours. Mira’s orders.']]
            },
            {
                art: 'Later, plates cleared. Nessa scrolling her camera roll: a selfie on the yacht, a QR card on the bar behind her.',
                lines: [['Nessa', 'The QR code from the yacht. It’s still in my photos.']]
            },
            {
                art: 'Mira’s laptop has read the code from the photo. The address: velura.live/partners/vr-interest?mgr=0417',
                lines: [['Mira', 'It’s Velura’s own website. The platform. “mgr” is manager.']]
            },
            {
                art: 'The four of them around the laptop, candles low behind them.',
                lines: [['Lusty', '0417 isn’t Pryor. It’s someone inside Velura.'], ['Dani', 'Someone who runs advances, reads support tickets…'], ['Nessa', '…and still has my old address.']]
            }
        ],
        after:
            'The platform is named for the first time: Velura Live, Nessa’s cam platform. Partner 0417 is a Velura partner manager. Pryor’s pre-ticked enrolment made the scheme possible and is unfair, but Pryor is no longer the suspect.'
    },

    /* --------------------------------------- week 6: Original Files -- */
    {
        n: 20,
        title: 'Original Files',
        date: '2026-12-22',
        arc: 'Original Files',
        canon: 'LX E009',
        look: 'C',
        summary:
            'Seven workers share their original statements, two deductions turn out to be legitimate, and Lusty predicts what the other five will show.',
        setting:
            'Nessa’s studio, a long table of laptops. Seven workers, visibly different lives: a parent with a child’s drawing taped to the laptop lid, a student with textbooks, Jules from the lobby day, Dani.',
        panels: [
            {
                art: 'Wide on the table.',
                lines: [['Caption', 'Seven workers. Seven decisions.'], ['Nessa', 'Nobody’s here because they owe us anything.']]
            },
            {
                art: 'Dani sorts printouts into two piles: PTR-ADV-0417 and CHARGEBACK RESERVE.',
                lines: [['Dani', 'These two are real chargebacks. Annoying. Disclosed. Legal.']]
            },
            {
                art: 'Mira with a spreadsheet: five rows highlighted.',
                lines: [['Mira', 'Five with 0417. All five scanned the yacht QR.'], ['Lusty', 'And all five revised statements show a lighter gross.']]
            },
            {
                art: 'Lusty at the whiteboard, marker raised.',
                lines: [['Lusty', 'If one manager controls 0417, the advances were all paid into one account.'], ['Mira', 'Which we can’t see.'], ['Lusty', 'Velura can. Once someone makes them look.']]
            }
        ],
        after:
            'Two cases were ordinary chargeback reserves: an honest system working badly, not a crime. Five share the pattern. Lusty has made a testable prediction.'
    },
    {
        n: 21,
        title: 'Christmas Eve',
        date: '2026-12-24',
        arc: 'Original Files',
        look: 'B',
        summary:
            'Over Christmas Eve Chinese food, the five workers vote on who will be named, and Dani chooses not to be.',
        setting:
            'A nearly empty Chinese restaurant in North Miami, paper lanterns, a tiny tinsel tree by the register. Lusty, Mira and Dani with dumplings. Nessa is with her family.',
        panels: [
            {
                art: 'The three at a round table.',
                lines: [['Caption', 'Christmas Eve.'], ['Dani', 'I didn’t know this was a tradition.'], ['Lusty', 'Family tradition.']]
            },
            {
                art: 'A group chat named ORIGINAL FILES (5). Votes: NAMED ✓ ✓ ✓, ANONYMOUS ✓. Nessa’s message has a photo of her family’s tree.',
                lines: [['Screen', 'Nessa: Named. Merry Christmas, nerds.'], ['Mira', 'Three named. One anonymous. One left.']]
            },
            {
                art: 'Dani, thumb hovering.',
                lines: [['Dani', 'If I’m named, they bring up August.'], ['Lusty', 'Then don’t be. Your records count either way.']]
            },
            {
                art: 'Dani taps ANONYMOUS, then cracks a fortune cookie. The slip reads KEEP THE ORIGINAL.',
                lines: [['Mira', 'That’s a little on the nose.']]
            }
        ],
        after: 'Three workers will be named in the complaint and two will not. Ferrer will file the records of all five, as each of them agreed.'
    },
    {
        n: 22,
        title: 'Out of Office',
        date: '2026-12-26',
        arc: 'Original Files',
        look: 'A',
        summary:
            'Ferrer sends Velura a demand to preserve the records, and Velura’s legal team is out until after the statements are archived.',
        setting: 'Ferrer’s office on the day after Christmas, a paper crown from someone’s cracker on her desk lamp. Nessa and Lusty.',
        panels: [
            {
                art: 'Ferrer typing.',
                lines: [['Ferrer', 'A preservation letter. It tells Velura not to destroy anything relevant to a dispute.'], ['Nessa', 'The originals in the portal?'], ['Ferrer', 'Especially those.']]
            },
            {
                art: 'Her screen: To: Velura Live — Legal. Her cursor on SEND.',
                lines: []
            },
            {
                art: 'An instant auto-reply.',
                lines: [['Screen', 'Our offices are closed until January 4. We will respond on our return.'], ['Lusty', 'The archive runs December 31.']]
            },
            {
                art: 'Ferrer takes off her reading glasses.',
                lines: [['Ferrer', 'Then we find someone at Velura who works New Year’s Eve.'], ['Lusty', 'Compliance. Somebody always has to close the year.']]
            }
        ],
        after: 'The preservation demand is sent and on record, and nobody has read it yet. The deadline holds.'
    },

    /* ----------------------------------------------- week 7: Midnight -- */
    {
        n: 23,
        title: 'Year-End Close',
        date: '2026-12-29',
        arc: 'Midnight',
        look: 'C',
        summary:
            'Dani calls a former colleague in Velura’s compliance team, and one careful sentence tells Lusty who 0417 is.',
        setting:
            'Night. A stairwell in Nessa’s building, then the studio with a phone on speaker. NEW CHARACTER, Priya Nand, Velura’s head of payments compliance: late 30s, cardigan, lit by monitors in an empty office.',
        panels: [
            {
                art: 'Dani in the stairwell, phone to her ear. Split panel: Priya at her desk.',
                lines: [['Dani', 'Priya. It’s Dani Kwan, from chargebacks.'], ['Priya', 'Dani. It’s December twenty-ninth.'], ['Dani', 'That’s why I’m calling.']]
            },
            {
                art: 'The studio: Ferrer, Nessa, Lusty, Mira around the speakerphone.',
                lines: [['Ferrer', 'We’ve sent Velura a preservation demand. Your legal team is away.'], ['Priya', 'I’m not legal. I’m compliance. I close the year.']]
            },
            {
                art: 'Everyone looks at Nessa. It is her record to give.',
                lines: [['Priya', 'Give me a partner number and I’ll tell you if I can look.'], ['Nessa', '0417.']]
            },
            {
                art: 'Priya’s face, close, lit by her monitor. A long beat. Then Lusty, quiet.',
                lines: [['Priya', '…I can’t discuss an employee.'], ['Lusty', 'She just did.']]
            }
        ],
        after:
            'Partner 0417 is a Velura employee, not an outside partner. Priya has said nothing improper; she declined to discuss one. Whether she acts before the archive runs is open.'
    },
    {
        n: 24,
        title: 'Midnight',
        date: '2026-12-31',
        arc: 'Midnight',
        look: 'C, Rodeo Noir: black mock-neck, cherry-red boots, X earrings.',
        summary:
            'On New Year’s Eve, minutes before the archive runs, Velura’s compliance team freezes it and finds that every advance was paid into one account.',
        setting:
            'The roof of Nessa’s building, New Year’s Eve, Biscayne Bay below. Lusty, Nessa, Mira, Dani (sparkling cider) and Ferrer. Fireworks build across the four panels.',
        panels: [
            {
                art: 'The five on the roof, city lights, the first early fireworks. Ferrer reading her phone.',
                lines: [['Caption', 'December 31. 11:41 P.M.'], ['Ferrer', 'Velura’s compliance team froze the archive. The originals stay.']]
            },
            {
                art: 'Close on the email from Priya Nand.',
                lines: [
                    ['Screen', 'Year-end archive suspended pending review. Advances under partner 0417 were paid to a single account. The employee’s access has been suspended.'],
                    ['Mira', 'One account. You predicted it.'],
                    ['Lusty', 'The ledger did. I read it.']
                ]
            },
            {
                art: 'Nessa opens the old UNKNOWN thread (“Delete the first statement.”), types one word and sends it.',
                lines: [['Screen', 'Nessa: No.']]
            },
            {
                art: 'Midnight. The sky over the bay erupts. The five of them, lit in teal and copper.',
                lines: [['Caption', '12:00.'], ['Nessa', 'Did we win?'], ['Lusty', 'We kept the originals. Winning starts in the morning.']]
            }
        ],
        after:
            'Climax. The originals are preserved and Velura’s own records confirm a single destination account. The employee is suspended, not convicted; repayment is not yet agreed. Nessa has answered the sender herself.'
    },
    {
        n: 25,
        title: 'Morning After',
        date: '2027-01-02',
        arc: 'Morning After',
        canon: 'LX E010',
        look: 'A',
        summary:
            'Velura offers to repay all five workers, Pryor rewrites their terms, and Lusty checks both lenses before her first VR show.',
        setting: 'Ferrer’s office, then Lusty’s apartment. Daylight again.',
        panels: [
            {
                art: 'Ferrer with a letter; Nessa and Dani opposite.',
                lines: [['Ferrer', 'Velura offers repayment to all five, corrected statements, and a real appeal process.'], ['Nessa', 'And the employee?'], ['Ferrer', 'Fired. Whether it’s a crime is someone else’s case.']]
            },
            {
                art: 'Pryor on Lusty’s laptop.',
                lines: [['Pryor', 'We’ve removed the interest-list enrollment.'], ['Lusty', 'And ownership?'], ['Pryor', 'Page one.']]
            },
            {
                art: 'Lusty’s set, the teal backdrop, the stereo camera. Mira checks both lenses with a penlight.',
                lines: [['Mira', 'Both lenses clear.'], ['Lusty', 'Check again.']]
            },
            {
                art: 'Lusty’s phone in her hand.',
                lines: [['Screen', 'Mom: Friday dinner?'], ['Screen', 'Lusty: Yes. Can I bring friends?']]
            }
        ],
        after:
            'Remedy offered, not yet paid. The Pryor deal is back under negotiation on Lusty’s terms. Her first public VR broadcast is next season’s milestone, not this one’s.'
    }
]);
