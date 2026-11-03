# Covering what an unverified visitor may not see

The rule is one sentence: **unless a visitor is age-verified, they do not see
genitals.** This is how that is enforced on every image the site displays.

## Why there is anything to do here

`AFFILIATES_ONLY` turned the front page into a directory, and a directory has
to show something. Until 2026-10-20 the age gate was a blocking interstitial,
so that was a narrow problem — nothing rendered at all until a visitor was
through it. Now the gate is a banner over a browsable page, and every surface
on it reaches a signed-out visitor:

| Surface | Before | Now |
| --- | --- | --- |
| Cam shelf | withheld entirely (`rooms: []`) | **covered and shown**, everywhere |
| Bang scenes, stills and cast | shown uncovered | **covered and shown** |
| AEBN movies, stars and pitch slider | shown uncovered | **covered and shown** |
| Our own posters and backdrops | shown uncovered | **covered and shown** |
| Creator avatars, on profiles and channel pages | shown uncovered | **covered and shown** |
| Video playback, anywhere | played | **withheld** — see [below](#video-is-withheld-not-covered) |
| Ad slots | shown | **adult zones withheld**, SFW zones shown — see [below](#ads-cannot-be-covered) |

The cam change is a *relaxation*, and that is the point. A blank row protects
nobody and persuades nobody: a visitor who is shown nothing has no reason to
pass a gate they cannot see the value of. A visitor shown a real shelf with
the explicit regions pixelated knows exactly what verifying buys them.

### Ours goes through the same model as theirs

Rows four and five were added on 2026-10-21 and they are the ones with no
argument behind them worth preserving. A poster is a frame a creator picked
out of their own film and an avatar is a photograph a creator uploaded;
nothing has looked at either, and the fact that it is ours makes no difference
to the viewer and none to the statutes. The original scope said *artwork the
site does not own*, which was a description of where the work had got to
rather than a principle, and David's instruction closed it: **"this should
apply to all images on the website and videos. Any image that's loaded and
displayed."**

Our own objects reach the same `/api/media` route by a second parameter,
`?k=`, signed over `storage:<key>` so a signature minted for an object can
never be presented as one for a partner URL. The route still serves exactly
one thing — a covered image or the placeholder — which is what keeps a signed
key from being a download link for the bucket. See
[below](#catalogue-artwork-and-the-ssrf-answer-it-needed).

Covering happens on the way out, not in the item shape:
`buildLibrary()` is cached once per process and cannot know who is asking, so
`coverOwnArtwork` in `server/library.js` runs over the response at
`/api/catalog`. It also deletes `posterKey` and `backdropKey` from the covered
copy — under `CDN_BASE_URL` a delivery URL is the base and the key with
nothing in between, so a key left in the payload is the uncovered picture
written out a second time.

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

## Video is withheld, not covered

Everything above is about stills. Video gets the other answer, and the reason
is arithmetic rather than policy: **a mosaic works for a still and not for a
stream.** The detector runs at a few frames a second on one server. A cover
that lags half a second is not a cover, and there is no version of this that
scales to covering every frame of every concurrent stream.

So `playbackAllowed()` in `src/ui/video-gate.js` is `ageOk()`, and three call
sites ask before anything decodes:

| Surface | Call site | `surface` |
| --- | --- | --- |
| A catalogue title | `playItem` in `src/main.js`, before `video.load()` | `title` |
| A past broadcast | `_openRecording` in `src/ui/browse.js` | `recording` |
| A live cam room | `_openTheatre` in `src/ui/cams.js`, before the iframe exists | `cam` |

The check is before `load()` in every case, which is the whole point: `load()`
starts the fetch and decodes the first frames, so a check after it is a cover
over a video that is already playing.

The cam theatre still *opens* for a visitor who declines — it shows the room's
own thumbnail, blurred, with a verify button where the player would be. That
is deliberate and it is what keeps the interstitial below honest: cancelling
is supposed to show you the page, censored, rather than nothing.

## Clicking a covered picture asks

A pixelated thumbnail with no way to act on it is a dead end. So a plain
left-click on any covered image opens an interstitial offering the gate
(`src/ui/image-gate.js`), and **cancelling is a supported outcome**: the
visitor continues to the linked page and sees it covered. There is no close
cross, because a dialog with three ways out and one of them unlabelled is a
dialog people dismiss without reading the choice.

Which images count is `coveredPicture` in `src/ui/covered-image.js` — a walk
up from the click target looking for a `/api/media` or `/api/cams/thumb/` URL,
in `src` or in an inline `background-image`. It is a separate, dependency-free
module for a boring reason worth knowing before you move it back: `node --test`
cannot import anything that reaches `src/assets/`, so logic left inside
`image-gate.js` cannot be tested at all.

Ad slots are excluded from the interstitial. They are already withheld
entirely for an unverified visitor, so the exclusion is belt-and-braces — but
an ad is a paid click going somewhere else and interposing a dialog on it is
both useless and a billing problem.

The three overlays stack in a fixed order, asserted in `test/ads.test.js`
because getting it wrong is invisible until somebody is looking at the wrong
thing: **age gate (95) > interstitial (94) > banner (93)**, then everything
else below.

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
                                                    ├─ again per window,
                                                    │  if the frame is wide
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
| `AVR_CENSOR_ENDPOINT` unset | cam row withheld; all other artwork, ours and theirs, placeholder |
| Inference service down / timing out | placeholder tile |
| Model failed to load in the container | whole frame mosaiced |
| Detector threw on an image | whole frame mosaiced |
| Model confident but cannot localise | whole frame mosaiced |
| Model neither placed a box nor cleared the image | whole frame mosaiced |
| Image undecodable | placeholder tile |
| Unknown room name | placeholder tile |
| Signature missing, forged, or re-used on another URL | placeholder tile |
| A `?u=` signature presented as `?k=`, or the reverse | placeholder tile |
| Storage object missing, oversized, or not an image | placeholder tile |
| Partner serves artwork from a host not in the allowlist | image dropped; a gap in the row |
| Any of the above, while video is involved | nothing plays; the gate is asked for instead |

### The one response that is not covered

Everything above is a failure mode. There is exactly one success mode that
puts a partner's own pixels in front of somebody who has not verified their
age, and it is worth stating on its own because the rest of this document is
about the cases where that cannot happen:

> The detector ran, placed no box **at its class's own bar**, and scored
> below half of `CONF` on every censorable class.

That image is re-encoded and handed back. Nothing else is. Above that floor
and below a placed box, the frame is mosaiced entirely — the model declining
to commit is not the model saying no.

The floor lives in `WHOLE_TILE` in `services/censor/src/detect.js` and is
written as `CONF / 2` rather than a number so the two move together — which
with `CONF` at 0.15 puts it at **0.075**.

Measured over the 51 boxcovers on the three Bang shelves, 2026-10-20, under
the flat 0.18 this replaced:

| | confidence |
| --- | --- |
| Images that produced a box (24) | 0.221 – 0.884 |
| Images the model cleared (25) | 0.002 – 0.088 |
| Covered as uncertain (2) | 0.110, 0.152 |

The populations do not overlap and the gap is wide, so anywhere between
0.09 and 0.22 would split this sample identically. The floor sits below the
gap rather than inside it, because 51 images of one kind is not enough to put
a threshold in a gap and the two mistakes do not cost the same: too high shows
a photograph, too low mosaics a clothed cover.

Both of the closest calls were checked by eye rather than by score — the
highest-scoring pass-through, at 0.088, is a performer in a crop top and
underwear. `X-Censor-Confidence` is on every response so this stays
checkable without re-deriving it.

Read that table against the current numbers and the change is visible: at
0.075 the 0.088 cover is now mosaiced as uncertain rather than shown, and the
cleared population shrinks to the 24 images under the floor. That is the
intended direction. What the table no longer establishes is where the
*box-placing* boundary sits, because `CONF` moved to 0.15 and the genital
classes to 0.03 and then 0.015 — the sample has not been re-scored at those
numbers, and the comparisons that were run instead are in the next two
sections.

### The split threshold

One bar cannot do both jobs, and the evidence for that is in the docstring on
`GENITAL_CONF`. Sampling 30 live cam thumbnails on 2026-10-20 and looking at
the output rather than the box count, four showed uncovered genitals; probing
those regions, the model had scored them **0.022 and 0.024**. Not close to the
old 0.18, not close to the whole-frame fallback either. On the same images
breasts and buttocks scored in the tenths. The detector is not uniformly weak
— it is weak on exactly the part the one-sentence rule names.

Lowering the single threshold to reach them was measured and rejected:

| thresholds | cam boxes | covers shown | mean cam area |
| --- | --- | --- | --- |
| 0.18 flat (was) | 42 | 25 | 17% |
| **0.15 / 0.03** | **67** | **24** | **21%** |
| 0.08 flat | 58 | 19 | – |

A flat 0.08 costs six of the 51 catalogue boxcovers — clothed promotional art,
mosaiced, for every unverified visitor. Splitting costs one, because the low
bar applies to three of the eighteen classes and those three almost never fire
on a clothed photograph.

The area column is the one that matters. A threshold low enough to scatter
boxes everywhere would cover the frame while reporting that it placed boxes,
and a count alone cannot tell that apart from good recall. Four points of
extra area for three fifths more boxes is boxes landing on things.

### Three bars, and the measurement mistake that found the third

On 2026-10-21 the bars were lowered again, and the interesting part is not the
new numbers but why the previous ones were wrong.

The sweep that set `0.15 / 0.03` moved both numbers **together**. It reported
that going lower covered dozens more pictures and that most of them were
clothed, and the obvious reading — the low bar is as low as it can go — was
wrong. `WHOLE_TILE` defaults to `CONF / 2`, so every step down in `CONF` had
also been dropping the whole-frame fallback, and the clothed false positives
were whole-frame mosaics fired by that, not boxes placed by either bar. The
rig could not see this because it never held one number still.

Re-run over **518 uncovered partner images** with each bar moved alone and
`WHOLE_TILE` pinned whenever `CONF` moved — `services/censor/scripts/sweep-thresholds.js`,
which drives the real `decode` rather than a copy of its arithmetic — the
picture is different:

- **`CONF` is not the lever.** Dropping it from 0.15 to 0.06 places 71 more
  buttocks boxes and covers **zero** images that were not already covered. It
  adds mosaic to frames that are already mosaiced. It stays at 0.15.
- **The genital bar goes to 0.015.** At 0.015 it covers five more images, all
  underwear and swimwear crotches. At 0.01 it starts covering men's headshots.
- **Breasts get a bar of their own, at 0.03.** This is the biggest single
  lever on this corpus and it did not exist before: 17 more images covered —
  sheer tops, lingerie, topless — and it is the part of the rule that was
  least well served. At 0.02 the additions include a man in a white
  button-down and a woman in a plain t-shirt, so 0.03 is the floor.
- **Buttocks stay on `CONF`.** Not in the rule, most often fired by a pair of
  jeans, and the sweep says moving them buys nothing.

| setting | boxes | whole-frame | shown uncovered | mean area |
| --- | --- | --- | --- | --- |
| 0.18 flat (was deployed) | 1078 | 10 | 130 | 12.2% |
| 0.15 / 0.03 | 1360 | 7 | 123 | 13.0% |
| **0.15 / 0.015 / 0.03** | **1747** | **2** | **101** | **13.3%** |

Two columns are worth reading twice. **Whole-frame covers went down**, from
seven to two: a whole-frame mosaic is what this service does when it is sure
something is there and cannot say where, so a bar low enough to place the box
is a bar that stops it having to destroy the picture instead. And **mean
covered area moved three tenths of a point while 22 more images became
covered** — the extra boxes are landing on things. Scattering would have shown
up here as area climbing with nothing changing hands.

There is no ground truth corpus here, so none of this is precision or recall
and the script does not pretend otherwise. What it reports is the delta, and
the decisive artifact is the contact sheet of newly-covered images that a
person opens and looks at. Forty more covered images is good if they are forty
pictures of genitals and bad if they are forty clothed box covers, and only
eyes can tell those apart.

### A wide picture is read in pieces, because no threshold reaches thirty pixels

Lowering bars was the wrong tool for the failure that came next, and it took a
screenshot to see why.

On 2026-10-21, with all three bars at the numbers above, the AEBN pitch banner
on the shelf came back with **one** mosaic over the leftmost DVD cover and
four more covers of plainly exposed breasts untouched beside it. A second
banner came back with the base of a penis covered and the rest of it not.

Nothing was wrong with the thresholds. The banner is **1366x400**, and the
detector letterboxes a whole frame into a 320x320 square — so a 3.4:1 picture
lands as a 320x94 strip with **71% of the model's input filled with grey
padding**, and each of the five covers inside it is about thirty pixels tall
by the time anything looks at it. A threshold is a question you ask about a
signal. There was no signal left to ask about.

So a lopsided frame is now read more than once: the whole frame first, as
before, then square windows stepped along its long axis, each letterboxed to
the full 320x320 on its own, with the boxes mapped back into frame
coordinates and merged by the same NMS that already collapses one part seen
twice. The whole-frame pass always runs, so tiling can only ever add.

Three constants in `services/censor/src/detect.js` govern it, and all three
are in the `/health` fingerprint:

| | | |
| --- | --- | --- |
| `TILE_ASPECT` | 1.2 | how lopsided before a second look. A waste threshold, not a content one |
| `TILE_OVERLAP` | 0.2 | guarantees any region under 80px on the banner falls *inside* some window rather than across two |
| `MAX_TILES` | 6 | so an aspect ratio cannot become a fan-out. Past it windows get longer, not more numerous |

**The bars were re-measured underneath it and left alone.** This was the real
risk: each window gets its own 2100 anchors and its own look at all eighteen
classes, so 518 images became 1413 windows and the number of chances the
model has to fire on one picture roughly tripled — and a bar is a per-chance
quantity. Bars placed against a single pass could easily scatter under
several. Sweeping all three **upward** through the tiled pipeline says they
do not: no raise covered a single image that was not already covered, which a
raise cannot do, and every raise uncovered images that are covered today — up
to 24 of them at `0.15 / 0.05 / 0.08`.

Tiling does add some false positives; the contact sheets show mosaics landing
on faces, a mouth, and one opaque white tank top. They stay. They are
over-covering, which is the direction this whole document says to fail in,
and the measured price of removing them is two dozen images of uncovered
skin.

What it costs is CPU. Cam thumbnails are `image_url_360x270` — 4:3, over the
trigger — so the highest-volume path in the service went from one inference
per image to three. The corpus averages 2.73. That is known rather than
discovered, and it is the thing to watch on the bill; see **Cost** in
`services/censor/README.md`.

### Fail-closed is not free, and the first time it fired it cost three fifths of a page

The table above is the design working. It is worth reading the other way
round too, because on 2026-10-20 it did exactly what it promises and the
result still had to be fixed.

`fetchImage` refused anything whose `Content-Type` did not begin `image/`.
Bang serves its boxcovers from `i.bang.com` and labels **31 of the 51** on
the three shelves `application/octet-stream`; the other 20 come back
`image/jpeg`. All 51 are byte-for-byte the same kind of file — Exif-prefixed
JPEG, `ffd8ffe1` — so the header was not describing older uploads or a
different encoder, it was simply inconsistent. Nothing leaked: every one of
the 31 fell through to the placeholder. But a signed-out visitor opened the
page and found most of the catalogue reading "Verify your age to view", which
looks like a broken site rather than a gate, and 17 of those 31 did in fact
have between one and four regions that needed covering.

The fix reads the magic number and discards the declared type. That is
*tighter* than what it replaced, which is the part worth keeping in mind: a
partner answering a login page with `200 image/jpeg` no longer gets those
bytes forwarded to the decoder. Covering went 20/51 → **51/51**, p50 527ms,
max 1.2s against the 4s timeout.

The general lesson is in the last column of the table. Every row there is a
visible failure, and that is deliberate — but "fail-closed" only describes
what the visitor is protected from, not whether anybody will notice. The
thing that found this was a screenshot, not a test and not an alarm.

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

**And it still does not establish that anything was covered.** Everything
above this line is a measurement of the detector. The same afternoon, this
service was returning every one of those images uncovered: `blocky` chained
two `sharp` resizes on one pipeline, `sharp` takes one resize per pipeline
and the second replaced the first, so the "mosaic" was the original at its
own dimensions and every patch was cut from it. Box counts were right.
Latencies were right. Content types were right. The covered file was
*smaller* than the source, which read as evidence the mosaic was working.

A screenshot found it. So the rule this document is now written under:
**a box count is a claim about the detector and never about the cover.**
The only evidence that an image was covered is decoding the output and
comparing pixels, which is what `services/censor/test/mosaic.test.js` does
and the only thing it is allowed to do.

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

### Two kinds of reference, one route

Our own posters, backdrops and avatars arrive at the same endpoint by a
different parameter, because there is no URL to sign — the object lives in our
bucket and its address depends on whether a CDN is configured:

| | names | signed over | verified by |
| --- | --- | --- | --- |
| `?u=` | a partner's URL | the URL | `verifyMediaUrl` + host allowlist |
| `?k=` | a storage key | `` `storage:${key}` `` | `verifyStorageUrl` + traversal check |

**The prefix is the whole point.** Both parameters are attacker-supplied and
both are checked against the same HMAC key, so if each signed the bare value a
signature handed out for one would verify as the other — `?k=` would become a
reader for any partner URL, or `?u=` a way to name an object in the bucket.
Domain-separating them means the only thing keeping the namespaces apart is
not that the route happens to read `u` before `k`.
`test/media-proxy.test.js` asserts the crossing in both directions.

**And `?k=` is still not a file reader.** It is tempting to let a verified
visitor use the same URL and skip the covering, which would turn this into a
signed download endpoint for any object whose key has ever been minted, with
the HMAC as the only thing between it and the source video. The covering is
load-bearing: it is what makes a leaked link worth a pixelated avatar. A
verified visitor gets the real delivery URL in the JSON and never comes here.

Three things follow, and they are what make covering a whole catalogue
affordable:

- **The route serves one thing.** Every answer is a covered image or the
  placeholder. There is no branch returning the original bytes and no
  parameter that asks for them — a verified visitor is handed the real URL
  in the JSON and never comes here.
- **The covered image is cacheable forever.** A boxcover is the same boxcover
  tomorrow, so inference runs once per image ever, not once per viewer. Unlike
  a cam thumbnail, which changes every nine seconds — hence the two TTLs in
  [Tuning](#tuning).
- **A response that differs by visitor is never shared-cacheable.** Whether
  the artwork in a payload is covered depends on a cookie, so `viewFor` in
  `server/media/view.js` returns the covering decision and the
  `Cache-Control` header together and every route that covers sets both from
  that one call. Getting them apart is how a covered catalogue reaches a
  proxy and is handed to everybody — or, worse, an uncovered one. It is
  `private, no-store` rather than a short TTL so passing the gate redraws the
  page immediately instead of a few minutes later.
- **The feeds had to move server-side to make any of it possible.** AEBN's
  three were read straight from the browser until 2026-10-20; artwork this
  server never sees is artwork it cannot cover. `server/routes/aebn.js` reads
  them now and rewrites every partner image it finds — walking the whole
  payload rather than naming fields, because a list of field names is a list
  that goes stale the first time a partner adds an image size, and it goes
  stale silently and in the wrong direction.

## What this does not reach

Everything above is the website. Two surfaces are outside it and a mosaic
would not help either one, which is worth stating plainly rather than leaving
to be discovered:

**`GET /deovr`, the headset feed.** Unauthenticated, cookieless by design —
DeoVR and Play'a have no login flow — and it returns the published catalogue
with poster thumbnails *and* the video URLs in the same response. Covering the
thumbnails there would be the embed mistake from the section above, in its
purest form: a pixelated picture next to a playable file. The gate this needs
is the route requiring a feed token like `/deovr/u/:token` already does, which
would break any headset pointed at the bare address. Not done, named here.

**DLNA.** Same shape, LAN-scoped, and the protocol has nowhere to put a gate.

Both predate this work. Neither is reachable from a browser session, so
neither is what the one-sentence rule at the top was written about — but
neither is covered, and "the site covers everything" would be the wrong thing
to carry away from this document.

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

So the enforceable equivalent is to withhold the adult zones entirely. For an
unverified visitor, all three markup functions in `src/ads/juicyads.js` refuse
to build an adult zone, and `fillAdSlots` refuses to queue one even if it
reaches the page. Withholding is the default rather than something a caller
opts into — `verified` defaults to `ageOk()`, so a new call site that forgets
the parameter emits no adult zone.

### SFW zones, since 2026-11-02

A placement may also name an `sfw` pair in `src/ads/zones.js`: zones created
in the JuicyAds dashboard to serve SFW creatives only. An unverified visitor is
served those, and nothing else. The first is the leaderboard, `1130677`
(728x102, desktop only; phones get nothing).

This is the one place where covering is not ours. What keeps genitals out of
those slots is the network's category review of its advertisers, not the
detector, so a miscategorised creative would get through. It is bounded to the
zones named as `sfw`, and a placement without one draws nothing for an
unverified visitor, as before.

## Tuning

All in `services/censor/src/`:

| | | |
| --- | --- | --- |
| `CONF` | `0.15` | box threshold for fourteen of the eighteen classes; low on purpose, recall over precision |
| `BREAST_CONF` | `0.03` | and for `FEMALE_BREAST_EXPOSED` alone, which at `CONF` walked past sheer tops |
| `GENITAL_CONF` | `0.015` | and for the three in `GENITAL_IDS`, which the model is measurably weak on |
| `WHOLE_TILE` | `CONF / 2` | confident-but-unplaceable → cover everything |
| `PAD` | `1.22` | margin on every box before drawing |
| `ELLIPSE_FIT` | `√2` | so a circle *circumscribes* its box instead of fitting inside it |
| `BLOCKS` | `26` | mosaic blocks across the long edge |

The asymmetry to keep in mind while tuning: a false positive mosaics a
shoulder, and a false negative is the thing this exists to prevent.

Do not change one of the three bars by reasoning about it. Run
`scripts/sweep-thresholds.js` over a few hundred real images, move **one**
number at a time — pinning `WHOLE_TILE` by hand if the one you are moving is
`CONF` — and open the contact sheet it writes. Skipping that is how breasts
spent a day on the wrong threshold.

Two caching numbers in `server/media/censor.js` rather than the service:

| | | |
| --- | --- | --- |
| `TTL_MS` | `6_000` | a cam thumbnail, which changes every nine seconds |
| `STATIC_TTL_MS` | `6h` | a poster, a boxcover or an avatar, which does not change at all |

The second was the first's bug. Everything went through the six-second cache,
including artwork that is the same artwork tomorrow, so a catalogue page
re-ran inference on every image every six seconds for as long as anybody was
looking at it. The two share one `through(cacheKey, ttlMs, work)` helper, so
the only difference between them is the number.
