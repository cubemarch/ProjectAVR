# Delivery

How an upload becomes something a headset can actually play, and how each of
the five delivery surfaces decides what to hand a given client.

Three things are really one subject here, which is why they share a document:

- the **ladder** — how many versions of a title get made, and at what sizes;
- the **watermark** — the brand mark burned into every one of them;
- the **device profiles** — which of those versions a particular headset is
  told about.

A ladder that does not reach the bottom of its range cannot adapt. A mark drawn
into one eye of a stereo frame is worse than no mark at all. A rung offered to a
headset that cannot decode it is a menu entry that plays black. Each of those
failures is invisible on the machine that produced the file and obvious in a
headset, which is why they are all pinned by tests in
[`test/delivery.test.js`](../test/delivery.test.js) and
[`test/delivery-surfaces.test.js`](../test/delivery-surfaces.test.js).

---

## The pipeline

```
upload ──▶ probe ──▶ [ burn watermark ] ──▶ split into rungs ──▶ HLS (TS segments)
                                                                     │
                                                              -c copy │  (no re-encode)
                                                                     ▼
                                                                progressive MP4
```

One pass. The mark is composited **once, at source resolution, before the
ladder splits**, and every rung is encoded from the marked frame. Three
consequences worth being explicit about:

1. One overlay pass serves the whole ladder rather than one per rung.
2. Every rung's mark is proportionally the same size, because it was scaled
   with the picture rather than applied after.
3. **No rung can be published unmarked.** There is no code path from source to
   delivery that skips the overlay, which is the only way a watermark is worth
   having.

The progressive MP4s cost essentially no CPU: `-c copy` lifts the
already-encoded packets out of the TS segments and rewraps them. That is what
makes a per-rung MP4 affordable, and it is what closed the hole where DLNA, the
M3U export and direct download were being handed the **unmarked source file**
while only the browser player got the packaged ladder.

Two flags matter on that remux and are easy to lose:

| Flag | Why |
| --- | --- |
| `-bsf:a aac_adtstoasc` | ADTS headers belong to MPEG-TS and have no place in MP4. Without it the file plays **silence** — and plays, so it looks fine until someone turns the volume up. |
| `-movflags +faststart` | Moves the index to the front. Without it a headset must fetch the tail of a 12 GB file before it can seek. |

A rung that fails to remux is warned about and skipped, not fatal. A title with
an HLS ladder and no MP4s is degraded; a title with neither is broken.

---

## The ladder

Rungs are chosen from this table, never upscaling past the source:

| Height | Base bitrate |
| --- | --- |
| 4320 | 60 Mbps |
| 2880 | 32 Mbps |
| 2160 | 18 Mbps |
| 1440 | 10 Mbps |
| 1080 | 6 Mbps |
| 720 | 3 Mbps |
| 480 | 1.4 Mbps |

**Stereo gets ×1.6.** Side-by-side and over-under pack two eyes into one frame,
so the same nominal height carries twice the information and looks soft at
flat-video bitrates.

`AVR_LADDER_RUNGS` (default **5**) sets how many are made. Each one is another
full encode of the source, so this is the main lever on packaging cost.

### Rungs are spread, not taken from the top

When there are more candidates than rungs, they are picked at evenly spaced
indices, keeping **both ends**. This is the difference between an adaptive
ladder and a set of large files.

Taking the top four rungs of an 8K source produced 4320/2880/2160/1440 — a
range from 60 Mbps down to 10 Mbps. A viewer whose link could not hold 10 Mbps
had nowhere to drop to and simply buffered, on a title that had four renditions
available. The top rung is what the title is worth on a good link; the bottom
rung is what decides whether it plays at all on a hotel connection. Neither end
is negotiable.

---

## The watermark

Implemented in [`server/media/watermark.js`](../server/media/watermark.js).
The source image is `art/logo-text.png`.

### One mark per eye, always

A single corner overlay on a packed SBS or TB frame appears in **one eye only**.
A headset cannot fuse an object only one eye can see: it floats in front of the
scene at no fixed depth, and it gives people a headache. So the frame is split
into eye rectangles and each one gets its own overlay at the matching position
within its half.

That needs an explicit `split` in the filter graph. A *filter output* label
feeds exactly one consumer — unlike an *input stream* label such as `[0:v]`,
which ffmpeg auto-splits. Without the split the second overlay has no input and
ffmpeg refuses the graph outright.

```
[1:v]scale=<w>:-1,format=rgba,colorchannelmixer=aa=<opacity>[wmsrc]
[wmsrc]split=2[wm0][wm1]
[0:v][wm0]overlay=x=..:y=..:eval=init[marked_0]
[marked_0][wm1]overlay=x=..:y=..:eval=init[marked]
```

`eval=init` computes the positions once rather than per frame.

### Placement depends on the projection

| Projection | Position | Why |
| --- | --- | --- |
| Flat | Bottom-right of each eye | The ordinary place for it. |
| 180°, 360°, fisheye | Bottom-centre of each eye, 70% down | The "corners" of an equirectangular frame are the **poles** and the space directly behind the viewer. A mark placed there is smeared across the sky and unreadable. |

Both eyes must agree vertically. If they do not, the mark itself acquires
stereo disparity and appears to float at the wrong depth.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVR_WATERMARK` | on | `0` to disable burning entirely |
| `AVR_WATERMARK_FILE` | `art/logo-text.png` | Source image; any format ffmpeg reads |
| `AVR_WATERMARK_OPACITY` | `0.62` | 0–1 |

If the file is missing the title is packaged **unmarked** rather than failing,
and the manifest records `watermarked: false`. A skipped mark should be visible
rather than assumed.

---

## Device profiles

[`server/delivery/profiles.js`](../server/delivery/profiles.js) holds the table.
`profileFor(req)` resolves one from `?device=`, then the User-Agent, then a
conservative default.

| id | Device | Max height (HEVC / H.264) | Sustained bitrate | Prefers |
| --- | --- | --- | --- | --- |
| `visionpro` | Apple Vision Pro | 4320 / 2160 | 80 Mbps | HLS |
| `quest3` | Meta Quest 3 / 3S | 4320 / 2160 | 60 Mbps | HLS |
| `quest2` | Meta Quest 2 / Quest Pro | 2880 / 2160 | 35 Mbps | HLS |
| `pico4` | Pico 4 / Pico 4 Ultra | 2880 / 2160 | 35 Mbps | HLS |
| `pcvr` | Whirligig, DeoVR desktop, SteamVR | no ceiling | no ceiling | progressive |
| `generic` | anything unrecognised | 2160 / 1440 | 16 Mbps | HLS |

### Why the ceilings are stated per codec

Because that is what they actually depend on. **A Quest 3 decodes 8K HEVC and
does not decode 8K H.264** — the limit is the H.264 decoder's, around 4096
pixels wide, not the SoC's.

Since the default ladder is H.264 only, the practical effect today is that
**every standalone headset is capped near 4K** and the 8K rungs are reachable
only by PC players. Setting `AVR_PACKAGE_CODECS=h264,hevc` is what lifts that,
at the cost of encoding the ladder twice. HEVC carries the same picture at
roughly 60% of the bitrate, which is the entire reason to offer it.

### How confident these numbers are

They are conservative judgement calls about other people's hardware, not
measurements. The bitrate figures in particular are sustained-over-Wi-Fi
estimates, and they are chosen so that the rung a device *should* be able to
play is reachable — a Quest 2 sits at 35 Mbps rather than 25 specifically so
that the 4K stereo rung, which encodes at about 29 Mbps, is not excluded from
the commonest headset there is.

`AVR_DEVICE_PROFILES` overrides any of it:

```sh
AVR_DEVICE_PROFILES='{"quest2":{"maxHeight":4320,"maxBitrateKbps":80000}}'
```

A self-hoster who has measured their own fleet on their own network knows
better than this file does. Malformed JSON is warned about and ignored rather
than taking the server down.

### Selection never returns nothing

If a client is under every ceiling, it is given the **smallest rung** rather
than an empty list. An empty source list reads to DeoVR and SkyBox as a broken
title, not as an unsupported one.

---

## What each surface does with this

All five read the same `buildLibrary()` call and the same `renditions` array on
each item. There is no per-player code path; what differs is only how many of
the selected renditions a given format can express.

| Surface | Expresses choice as | Notes |
| --- | --- | --- |
| **Browser player** | HLS master playlist | hls.js picks a rung per segment; the only truly adaptive one. |
| **DeoVR / Play'a** | `encodings[]` → `videoSources[]` | Every entry becomes a quality-menu item, so the ceiling has to be applied *here* rather than hoped about. Needs absolute URLs — there is no page to resolve a relative one against. |
| **DLNA** (SkyBox, Pigasus) | several `<res>` elements | The only quality choice a DLNA client gets. No User-Agent on a Browse request, so the profile is chosen by `AVR_DLNA_PROFILE` (default `quest2`) rather than sniffed. |
| **M3U** (Whirligig) | one URL, full stop | No notion of alternatives, so the choice is made server-side from the profile. The playlist carries a comment naming the profile it used, which is what makes a wrong-looking playlist diagnosable. |
| **Direct download** | one file | `?rendition=` picks a rung. |

### `res@bitrate` is in bytes

UPnP's ContentDirectory spec defines `<res bitrate>` in **bytes per second**,
not bits. A value eight times too large makes a client conclude every rung is
beyond its link and refuse the lot. `DLNA.ORG_OP=01` is what advertises
byte-range seeking; without it players will not scrub.

### Filenames carry the geometry

SkyBox, Pigasus and Whirligig read projection and stereo layout from the **last
path segment and from nowhere else**. So every rung goes out under the full
conventional name, regenerated at that rung's own height:

```
Reef Dive_4K_180x180_3dh_LR.mp4      ← the 2160p rung of an 8K master
```

Not `Reef Dive_8K_180x180_3dh_LR_1080p.mp4`, which claims to be two resolutions
at once, and not a bare `1080p.mp4`, which has lost the layout tags and will be
played flat and monoscopic.

### `?device=` and the profile list

`?device=quest2` overrides sniffing on every surface, so a creator can check
what a headset would be served without leaving their desk. `GET
/delivery/profiles.json` publishes the whole table plus the profile detected for
the caller — `?device=` is not much use to someone who cannot find out what to
put in it, and a creator whose headset is getting the wrong rung needs to be
able to see the ceiling that decided it.

---

## Configuration summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVR_LADDER_RUNGS` | `5` | Rungs per title. Each is another full encode. |
| `AVR_PACKAGE_CODECS` | `h264` | `h264,hevc` to package both; HEVC is what unlocks 8K on standalone headsets |
| `AVR_WATERMARK` | on | `0` to disable |
| `AVR_WATERMARK_FILE` | `art/logo-text.png` | Mark image |
| `AVR_WATERMARK_OPACITY` | `0.62` | 0–1 |
| `AVR_DEVICE_PROFILES` | — | JSON overriding any profile's `maxHeight` / `maxBitrateKbps` |
| `AVR_DLNA_PROFILE` | `quest2` | Which ceiling DLNA browses apply, since there is no UA to read |
| `AVR_REMUX_TIMEOUT_MS` | 1 hour | Per-rung progressive remux timeout |

---

## Titles that were never packaged

Files dropped into `public/media/`, entries hand-written into `catalog.json`,
and uploads that ran with `AVR_TRANSCODE=0` have exactly one thing to serve.
They get a single synthetic rendition so that every surface can iterate
renditions unconditionally and none of them needs a "what if there aren't any"
branch.

Those keep the plain URL they have always had rather than a rendition redirect
that would only point back at themselves, and `watermarked` stays `false` —
a portal upload that lands here is a title that skipped the brand mark, and
that should be visible rather than assumed.
