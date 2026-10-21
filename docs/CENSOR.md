# Covering what an unverified visitor may not see

The rule is one sentence: **unless a visitor is age-verified, they do not see
genitals.** This is how that is enforced on artwork the site does not own.

## Why there is anything to do here

`AFFILIATES_ONLY` turned the front page into a directory, and a directory has
to show something. Two partner surfaces reach a signed-out visitor:

| Surface | Before | Now |
| --- | --- | --- |
| Cam shelf | withheld entirely (`rooms: []`) | **covered and shown**, outside the twenty-seven |
| Bang / AEBN / star artwork | shown uncovered | unchanged — see [below](#what-is-not-covered) |

The cam change is a *relaxation*, and that is the point. A blank row protects
nobody and persuades nobody: a visitor who is shown nothing has no reason to
pass a gate they cannot see the value of. A visitor shown a real shelf with
the explicit regions pixelated knows exactly what verifying buys them.

## The jurisdiction split

[`docs/STATE-AGE-LAWS.md`](STATE-AGE-LAWS.md) lists twenty-seven states that
require a verified adult; everywhere else a button is enough.
`server/identity/visitor-gate.js` already reports which of the two a visitor
is in, as `gate.owes`, and the cam route reads it directly:

- **`owes === 'verification'`** — one of the twenty-seven. **Still withheld.**
  Those statutes judge material as a whole and by its appeal, not pixel by
  pixel. A live broadcast with the explicit parts covered is still a live
  broadcast, and nothing in the table says a mosaic satisfies it. Covering is
  not a substitute for verifying there.
- **`owes === 'attestation'`** — everywhere else. **Covered and shown.** No
  statute requires more, and the visitor owes a click rather than a document.

This is the same reasoning `visitor-gate.js` sets out for itself: the smallest
thing that satisfies each state's own minimum, rather than one rule applied
everywhere.

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
| `AVR_CENSOR_ENDPOINT` unset | cam row withheld, as before the feature existed |
| Inference service down / timing out | placeholder tile |
| Model failed to load in the container | whole frame mosaiced |
| Detector threw on an image | whole frame mosaiced |
| Model confident but cannot localise | whole frame mosaiced |
| Image undecodable | placeholder tile |
| Unknown room name | placeholder tile |

The first row is the one that matters most. If the censor is unavailable the
route reverts to *withholding* the row, not to showing it — the branch is in
`server/routes/cams.js` and it is the most important four lines in this
feature.

## Two things that would quietly undo it

**The embed.** A card's `embed` field is the white-label player: a real, live,
entirely uncovered broadcast inside our page. A covered card ships
`embed: null`, and the client falls through to the outbound link instead of
opening the theatre. Pixelating the thumbnail of a card that opens an
uncensored stream on click is decoration, not a gate.

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

## What is not covered

Bang, AEBN and performer artwork is still shown uncovered to signed-out
visitors. That is the standing decision recorded at
`server/routes/bang.js` and at the head of `src/catalog/affiliates.js`
(David, 2026-10-18): boxcover art is not a live broadcast.

The machinery is generic — `censor(url)` takes any image URL — so extending
it is a route, not a rewrite. What it would need first is the SSRF answer the
cam route already has: `/thumb/:username` is safe because the username is an
index into a feed we already hold, not a URL a caller supplies. Any new
surface needs its own version of that, not a `?url=` parameter.

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
