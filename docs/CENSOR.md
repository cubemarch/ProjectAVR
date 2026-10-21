# Covering what an unverified visitor may not see

The rule is one sentence: **unless a visitor is age-verified, they do not see
genitals.** This is how that is enforced on artwork the site does not own.

## Why there is anything to do here

`AFFILIATES_ONLY` turned the front page into a directory, and a directory has
to show something. Until 2026-10-20 the age gate was a blocking interstitial,
so that was a narrow problem — nothing rendered at all until a visitor was
through it. Now the gate is a banner over a browsable page, and every partner
surface on it reaches a signed-out visitor:

| Surface | Before | Now |
| --- | --- | --- |
| Cam shelf | withheld entirely (`rooms: []`) | **covered and shown**, everywhere |
| Bang scenes, stills and cast | shown uncovered | **covered and shown** |
| AEBN movies, stars and pitch slider | shown uncovered | **covered and shown** |
| Ad slots | shown | **withheld** — see [below](#ads-cannot-be-covered) |

The cam change is a *relaxation*, and that is the point. A blank row protects
nobody and persuades nobody: a visitor who is shown nothing has no reason to
pass a gate they cannot see the value of. A visitor shown a real shelf with
the explicit regions pixelated knows exactly what verifying buys them.

## One rule, everywhere

[`docs/STATE-AGE-LAWS.md`](STATE-AGE-LAWS.md) lists twenty-seven states that
require a verified adult; everywhere else a button is enough. Covering does
**not** follow that split: a visitor who has not verified sees covered artwork
whether they are in Texas or Oregon (David, 2026-10-20).

This reverses an earlier design in which the twenty-seven were withheld
entirely rather than covered. It rests on a legal judgment, stated plainly
because it is the kind of thing that should be re-examined rather than
inherited: **a fully pixelated thumbnail is not material harmful to minors.**
What the statutes gate is the material; a mosaic that removes it is not a
lesser version of it.

The split has not disappeared, only moved. It still decides what *passing*
costs — a click outside the twenty-seven, a verified document inside them,
which is `gate.owes` and is enforced unchanged in
`server/identity/visitor-gate.js`. What it no longer decides is what an
unverified visitor is shown in the meantime.

If that judgment is ever retracted, the branch to restore is in
`server/routes/cams.js`, where the old `owes === 'verification'` test is named
in the comment above the covering check. The artwork routes would need the
same treatment and do not currently have a withholding path at all.

## The pipeline

```
browser            application server              inference service
                   (server/media/censor.js)        (services/censor/)

<img src=
 /api/cams/thumb/x>  ──►  room lookup
                          │
                          ├─ 6s shared cache ──► hit, done
                          │
                          ├─ fetch partner CDN
                          │
                          └─ POST /scan ─────────►  letterbox to 320²
                                                    NudeNet v3 ONNX
                                                    decode + NMS
                                                    ellipse mosaic
                             covered JPEG ◄────────  re-encode
```

Three things make this cheap enough to be real-time:

**The work is per room, not per viewer.** The covered thumbnail for a room is
byte-identical for everyone who sees it, so the six-second cache in
`server/media/censor.js` means a hundred concurrent visitors cost one scan.
Load scales with *rooms being looked at*, not with traffic.

**Only visible tiles refresh.** `src/ui/cams.js` already gates refresh behind
an `IntersectionObserver` — sixty cards in the shelf, about five on screen,
one refresh each per nine seconds.

**The latency is already absorbed.** `_swapFrame` preloads into an offscreen
`Image` and only swaps on decode, so a proxy slower than a CDN means a card
holds its previous frame a moment longer. The client required no change for
any of this.

## Fail-closed

Every failure covers more, never less. There is no path anywhere in this
system that answers a request with the original image.

| What breaks | What the visitor sees |
| --- | --- |
| `AVR_CENSOR_ENDPOINT` unset | cam row withheld; catalogue artwork all placeholder |
| Inference service down / timing out | placeholder tile |
| Model failed to load in the container | whole frame mosaiced |
| Detector threw on an image | whole frame mosaiced |
| Model confident but cannot localise | whole frame mosaiced |
| Image undecodable | placeholder tile |
| Unknown room name | placeholder tile |
| Signature missing, forged, or re-used on another URL | placeholder tile |
| Partner serves artwork from a host not in the allowlist | image dropped; a gap in the row |

The first row is the one that matters most. If the censor is unavailable the
cam route reverts to *withholding* the row, not to showing it — the branch is
in `server/routes/cams.js` and it is the most important four lines in this
feature.

The artwork routes reach the same place by a different means, and the
difference is worth noticing: `server/routes/bang.js` and
`server/routes/aebn.js` contain no "is the censor up" branch at all. They mint
a signed URL unconditionally, and `/api/media` is what decides — so an outage
costs the artwork without either route needing to know it happened. There is
no code path in which a missing censor produces an uncovered picture, because
there is no code path from those routes to the partner's bytes.

The last row is the one that is easy to get backwards. A partner image the
proxy will not sign is emitted as `null` and the card is dropped, rather than
passed through as the original — which is what a naive rewrite does, and it
fails open. AEBN serve all three feeds' artwork from `pic.aebn.net`; the
hostname that looks right is `aebn.com`, which is their API, and an allowlist
written from the domain that looks right covers nothing at all.

## Three things that would quietly undo it

**The embed.** A card's `embed` field is the white-label player: a real, live,
entirely uncovered broadcast inside our page. A covered card ships
`embed: null`, and the client falls through to the outbound link instead of
opening the theatre. Pixelating the thumbnail of a card that opens an
uncensored stream on click is decoration, not a gate.

**A feed read from the browser.** Every program in
`src/catalog/affiliates.js` is now `proxied: true`, and that flag is not a
performance note — a partner feed the browser fetches is artwork this server
never sees and therefore cannot cover. Adding a partner by pasting their
public JSON URL into `api` is the natural thing to do, it works perfectly, and
it puts uncovered artwork on the page for every signed-out visitor. The
registry's own docstring says so, and `test/affiliates.test.js` asserts that
*every* program carries the flag — so a browser-direct partner fails the suite
and has to be argued for rather than arrived at by not thinking about it.

**The class order.** `services/censor/src/labels.js` transcribes one specific
model's training order, and the model returns scores as bare positional
numbers. Transposed, the service still runs, still returns boxes, still
reports success — and covers faces while genitals stay on screen. Run
`npm run verify` once per model file. It is the only failure here that looks
completely healthy from the outside.

### What was checked, 2026-10-20

The weights in the Dockerfile are `320n.onnx` from NudeNet's `v3.4-weights`
release, 12,150,158 bytes, SHA-256 `c15d8273…11f0f`, now pinned in the build.
Three things were established against that exact file:

| | |
| --- | --- |
| Shape | It emits `[1, 22, 2100]` — four box channels plus eighteen classes, and the 2100 anchors `detect.js` asserts for a 320px input |
| Transcription | All eighteen names diffed position by position against `nudenet/nudenet.py` upstream — identical |
| Behaviour | Faces came back at mean y=0.287 of frame height and feet at y=0.880, over a batch of ordinary photographs |

The third is the one that matters, because the first two only prove the list
matches their *source*. The weights carry no class names — the ONNX export
stripped the metadata — so the mapping has to be checked against something
outside the code. Faces are near the top of a photograph and feet are near
the bottom, and those two sit at indices 1 and 12 against 7 and 9, far
enough apart that a shifted list scrambles the ordering. Nobody has to label
anything by hand.

That is also why `decode()` takes `all`. In production it returns only the
five classes on the censor list, which is everything the service needs and
precisely the wrong set for this check — it would leave `npm run verify`
able to see only the classes under suspicion.

One number worth knowing before tuning: on sixty ordinary stock photographs,
two picked up a censor box at 0.25–0.29, just over the 0.18 threshold. That
is the deliberate recall bias showing up as a false positive on about three
per cent of benign images. On a shelf of cam thumbnails a spurious mosaic is
invisible; on anything else it would not be.

Then the same checks against the **deployed** service, because a model that
verifies on a laptop and a container that answers on Cloud Run are two
claims. Ten real images off the live feeds — six AEBN boxcovers, four
`bodyLarge` performer stills:

| | |
| --- | --- |
| Boxcovers | 0, 2, 1, 0, 0, 6 regions |
| Performer stills | 3, 3, 3, 3 regions |
| Latency | 109–217ms end to end, including the fetch from `pic.aebn.net` |

The two zeros are clothed covers, which is the right answer rather than a
miss. That distinction is the reason this check was worth running twice: the
very first scan after deploy also returned zero boxes, and zero boxes on a
single image proves only that the service decoded and re-encoded it. A
container with a corrupt model returns zero boxes on everything and reports
itself healthy — see the Dockerfile's note on the download that silently
fetched a login page. Nine non-zero results out of ten is what separates
"the detector runs" from "the detector detects".

## Catalogue artwork, and the SSRF answer it needed

The cam route is safe from request forgery structurally: `/thumb/:username`
takes a room name, so the only addresses it can fetch are ones that arrived in
a feed we already hold. The parameter is an index into our own data rather
than an instruction.

That does not generalise to a catalogue of 164,595 scenes, paged and searched.
There is no short stable list to index into, and the obvious `?url=` is the
hole the cam route was shaped to avoid — a proxy that fetches whatever it is
handed reads `169.254.169.254` on the instance's behalf for anybody who asks.

So the URL travels, and a signature travels with it:

```
server builds a payload          browser                    /api/media
                                 
signedMediaUrl(partnerUrl)  ──►  <img src=/api/media   ──►  recompute HMAC
  HMAC-SHA256, 128 bits          ?u=…&s=…>                  re-check allowlist
  + host allowlist                                          censor(url)
```

Two bounds rather than one, both re-checked on the way in. The signature is
the real one; the allowlist in `server/media/proxy.js` is what keeps a leaked
key worth an attacker making us pixelate arbitrary pictures rather than worth
reading our metadata endpoint. Removing a host from it invalidates every URL
already minted for that host, rather than waiting for caches to lapse.

There is no expiry, deliberately: the capability granted is "fetch a public
partner image and pixelate it", which is not worth time-bounding, and an
expiry would fill a page left open in a tab with broken tiles.

Three things follow, and they are what make covering a whole catalogue
affordable:

- **The route serves one thing.** Every answer is a covered image or the
  placeholder. There is no branch returning the partner's bytes and no
  parameter that asks for them — a verified visitor is handed the partner URL
  in the JSON and never comes here.
- **The covered image is cacheable forever.** A boxcover is the same boxcover
  tomorrow, so inference runs once per image ever, not once per viewer. Unlike
  a cam thumbnail, which changes every nine seconds.
- **The feeds had to move server-side to make any of it possible.** AEBN's
  three were read straight from the browser until 2026-10-20; artwork this
  server never sees is artwork it cannot cover. `server/routes/aebn.js` reads
  them now and rewrites every partner image it finds — walking the whole
  payload rather than naming fields, because a list of field names is a list
  that goes stale the first time a partner adds an image size, and it goes
  stale silently and in the wrong direction.

## Ads cannot be covered

An ad slot is the one surface here that cannot go through any of this, and it
is worth writing down why rather than rediscovering it. Four reasons, each on
its own sufficient:

- There is no URL to sign. JuicyAds' `jads.js` replaces the `<ins>` element
  with its own children client-side; we never hold the bytes and never learn
  the address before the browser does.
- The creative is chosen by an auction at display time, so there is nothing to
  scan ahead of the impression.
- Many creatives are iframes or video, which is not an image the detector
  takes.
- Interposing would break the impression count, which is the advertiser's
  billing event. Filing impressions a network cannot verify is invalid traffic,
  and it is the category publisher accounts in this vertical get closed over.

So the enforceable equivalent is to withhold the slots entirely:
`adsEnabled()` in `src/ads/juicyads.js` returns false for an unverified
visitor, and all three markup functions return an empty string. Withholding is
the default rather than something a caller opts into — `verified` defaults to
`ageOk()`, so a new call site that forgets the parameter emits no ad.

## Tuning

All in `services/censor/src/`:

| | | |
| --- | --- | --- |
| `CONF` | `0.18` | box threshold; low on purpose, recall over precision |
| `WHOLE_TILE` | `0.30` | confident-but-unplaceable → cover everything |
| `PAD` | `1.22` | margin on every box before drawing |
| `ELLIPSE_FIT` | `√2` | so a circle *circumscribes* its box instead of fitting inside it |
| `BLOCKS` | `26` | mosaic blocks across the long edge |

The asymmetry to keep in mind while tuning: a false positive mosaics a
shoulder, and a false negative is the thing this exists to prevent.
