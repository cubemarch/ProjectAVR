# Lusty X, the comic

Our own comic, published at `/comic` three times a week. The scripts and the
schedule are [`comic/strips.js`](../comic/strips.js); the page, the art route
and the release rule are [`server/comic.js`](../server/comic.js). The series
bible (LX BIB 001 v0.5) lives outside this repository and is the authority on
character; this file records what the site does with it and which bible
decisions the first season takes.

## Publishing a strip is dropping in its art

A strip is published from **06:00 New York time on its `date`, once
`comic/art/NN.jpg` exists** (`.png` and `.webp` also work; `NN` is the
two-digit number). Both conditions are needed, so:

- Art can be committed and deployed weeks ahead and still wait for its day.
  Production bakes the app into a Docker image, so deliver art in batches
  rather than three deploys a week.
- A strip whose art is late does not come out, and the page and sitemap show
  the strips before it rather than a gap. On every start the server logs each
  strip due within seven days that has no art.
- Nothing about an unpublished strip is served: not its page, its art, its
  title or its dialogue. `test/comic.test.js` renders the page on the morning
  of strip 10 and fails if any later strip's line appears in it.

`comic/PROMPTS.md` holds the prompts for strips 07–25, ready to paste. It is
generated, and a test fails if it falls behind the scripts: after changing a
strip, run `node comic/prompts.js 7-25 --write`. `node comic/prompts.js 5`
(or `5-10`) prints the image-generator prompt for
a strip, built from `strips.js`: layout, lettering, the cast it uses, Lusty's
wardrobe, each panel with its exact words, and a fallback for any real public
figure. Attach the LX VIS 001 character sheet and the latest finished strip as
references. A test fails if a prompt drops or changes a line of dialogue.

Art is drawn at 1086×1448 (3:4), four panels, "LUSTY X / NN TITLE" in the
header and the arc name in the footer, as the pilots are. Export JPEG at about
quality 80. The front-page card crops the first panel using two offsets in
`netflix.css` (`--panel-x`, `--panel-y`); art drawn to a different grid needs
only those.

## Where it appears

Conspicuous enough to find, never in the way of a shelf or an ad slot:

| Surface | What |
| --- | --- |
| Front page | A small card at the very end of the column, after the guide card and below every shelf and ad slot. It shows the latest strip's first panel, title and date; there is no button. Filled from `/api/comic/latest`. |
| Footer | "Lusty X comic", after the headset guide. |
| `<noscript>` | A short paragraph and a footer link, to match the rendered page (`SEARCH.md` §5). |
| Headset guide | Its footer. |
| Sitemap | `/comic` and each published strip, once published. |

`comic`, `comics`, `lustyx` and `lusty-x` are reserved channel names.

## The art goes through the censor

`CENSOR.md`'s rule covers every image on the site, ours included, so
`/comic/art/:n` answers the way the catalogue does: the file to a verified
visitor, and to everyone else the covered copy from `censorBytes`, or the
placeholder if the censor is unreachable. The strips are not explicit, so the
covered copy looks like the original, but when the censor is down an
unverified reader sees the placeholder in place of the strip. The transcript
is on the page either way.

## Season one: 17 November to 31 December 2026

Tuesday, Thursday and Saturday, twenty strips to the climax on New Year's Eve,
plus a one-strip epilogue on 2 January.

| Week | Arc | Strips | Real-world hooks |
| --- | --- | --- | --- |
| 17–21 Nov | Constituents, Day One | 05–07 | Lobby day in DC during the lame-duck session; FOSTA's 97–2 vote. Then home to found Full Credit Studio LLC, a bank refusal for "reputational risk" beside the "Fair Banking" order, and Lusty's first live show |
| 24–28 Nov | Fine Print (E005) | 08–10 | Thanksgiving on the farm; Small Business Saturday |
| 1–5 Dec | Blind Angle (E006) | 11–13 | Giving Tuesday and World AIDS Day; first night of Hanukkah on a Friday |
| 8–12 Dec | Borrowed Time (E007) | 14–16 | Human Rights Day |
| 15–19 Dec | Quiet Hours (E008) | 17–19 | International Day to End Violence Against Sex Workers |
| 22–26 Dec | Original Files (E009) | 20–22 | Christmas Eve Chinese food; offices closed for the holidays |
| 29–31 Dec | Midnight | 23–24 | Year-end close; New Year's Eve |
| 2 Jan | Morning After (E010) | 25 | |

### The solution the season commits to

The bible leaves the perpetrator and the method open. This season answers them,
and every clue appears on the page before Lusty explains it:

- The interest list on the yacht (P002) quietly enrolled creators in a
  "Creator Advance" that is repaid from their pay (08). Signing creators up
  through Pryor's pre-ticked box is unfair, but it is not the theft.
- Revised statements kept the deduction and lowered the gross (09: the farm's
  scale ticket, checked against Nessa's dashboard).
- The threatening photo shows Nessa's *old* door, an address only her
  platform's tax file still holds (12).
- Lusty fixes on Pryor (16), and Mira breaks the assumption with the
  processor's public docs: the platform writes the payout file and assigns
  partner numbers (18). A QR code from the yacht, decoded from Nessa's photo,
  points at partner **0417, a manager at Velura Live**, Nessa's platform (19).
- Two of the seven workers' deductions are honest chargeback reserves (20).
  Lusty predicts the other five advances were all paid into one account, and
  Velura's compliance team confirms it at 11:41 pm on New Year's Eve (24).
- The remedy is repayment, corrected statements and an appeal process. The
  employee is fired, and whether that was a crime is "someone else's case" (25).

### Bible decisions this season takes, for approval

- **The business.** Lusty, Nessa and Mira co-own Full Credit Studio LLC from
  strip 07, named for the bio they would not cut in Pilot 03. Lusty is new to
  camming; Nessa stays the established performer the bible describes, and Mira
  stays technical. The company has no business bank account yet.
- **New cast.** Dani Kwan (LX CH 005, a former chargebacks analyst, now a cam
  performer in early recovery, introduced at the rent fund in strip 11), Ana Lucía Ferrer (CH 006, Nessa's lawyer),
  Priya Nand (CH 007, Velura compliance) and Jules (a lobby-day colleague).
  The P002 organizer returns as **Rowan Pryor, LX CH 004**, of Saltglass VR.
- **The first candle lighting moves** from E008 to strip 13, the first night of
  Hanukkah, which falls on a Friday. Nessa is there, so **Nessa now knows** that
  Lusty is Jewish, because Lusty lets her see. Strip 21 adds a quiet
  Christmas Eve hint, and E008's Friday candles stay in strip 19.
- **Her parents' knowledge of her work stays open.** Strip 09 avoids settling it.
- **Pilots 01 and 03 publish with their comedy dialogue**, because that is
  what the existing art says. The bible says the v03 scripts supersede it.
  Redraw both from v03 and replace `01.jpg`/`03.jpg` and the `lines` in
  `strips.js` to bring them into line. Pilot 02 has no art; the archive skips
  it until `02.jpg` exists.
- The LX VIS 001 sheet is lettered "AGE 28 FOR THIS STUDY". Canon is 24. It is
  not published.

## Real public figures

Three appear, all in the Washington week: Speaker Mike Johnson (05, on a TV,
chyron only), Senator Elizabeth Warren (06, one line about the Banking
Committee), and President Trump (07, on a TV, chyron giving his executive
order's title). The rules, which every later strip should keep:

- Public role, political setting. Never in a scene with sexual content, never
  as a customer or viewer of adult work, and never connected to the payout case.
- Their words are their public positions or mild, plainly fictional lines.
  TV chyrons state real events neutrally.
- Each such panel still reads if the figure is drawn from behind or on a TV
  with a caption, because most image generators refuse a recognisable
  politician. A human caricaturist is the dependable route.
- Never in panel 1. The front-page card crops the latest strip to its first
  panel, so a real person there would be promoting the site. A test enforces it.
- The comic page says the characters, companies and cases are invented and
  that no public figure endorsed or took part in it. Leave that line in.

Each strip lists its real people under `figures`, and a test checks the list
for 05–07.

## Check before the art is final

Each strip's `verify` list holds the facts it leans on. Re-check them the week
the art is drawn. This was written on 14 November 2026 without web search, so
in particular:

- **Midterm results.** Checked on 14 November against Wikipedia, not primary
  sources. Democrats won the House (257–169, nine uncalled) and the Senate
  (eight gains, Alaska uncalled), and outlets widely call it a blue wave, so
  strip 09's chyron stands. Warren's 2027 committee role and the lame-duck
  calendar are still unconfirmed. Strip 06's "Banking staff" is true either way.
- Dates: Hanukkah begins at sundown on 4 December 2026; 17 December, 10
  December and 1 December are the days named above.
- Fictional names (Velura Live, Saltglass VR, Rowan Pryor, Priya Nand and the
  rest) need a quick trademark and name search, because a real company that
  shares a name with this season's villain is a problem.
