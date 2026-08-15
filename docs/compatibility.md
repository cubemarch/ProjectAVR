# VR-player compatibility

ProjectAVR uses one normalized projection/stereo model and adapts it to each player’s documented vocabulary. Native-app behavior can change by operating system and release, so the table below describes integration surfaces rather than a blanket “works everywhere” guarantee.

## Common baseline

For the widest practical overlap, provide a fallback rendition with:

- MP4 container
- H.264/AVC, 8-bit 4:2:0 video
- AAC-LC stereo audio
- MP4 `moov` atom before media data (“fast start”)
- HTTPS delivery
- ranged `GET` responses (`206`, `Accept-Ranges`, and `Content-Range`), plus `HEAD` where a target player or delivery layer probes it
- stable direct URLs and correct MIME types
- CORS headers for browser/PlayCanvas texture playback

HEVC, AV1, MKV, HDR, high-order spatial audio, HLS, and DASH may be useful additional renditions, but should not be the only compatibility path unless the target device matrix has been tested.

## Shared filename hints

ProjectAVR generates conservative hints that overlap documented recognition in DeoVR, SKYBOX, and Pigasus:

```text
Title.mp4
Title_180.mp4
Title_360.mp4
Title_180_LR.mp4
Title_360_LR.mp4
Title_180_TB.mp4
Title_360_TB.mp4
```

`LR` means left/right side-by-side. `TB` means top/bottom (over-under). Reversed eye order, fisheye, cubemap/EAC, and full-width versus half-width stereo packing do not have one dependable naming vocabulary across all five players. Use explicit settings or a player-specific adapter.

## PLAY’A

PLAY’A documents a site integration API rooted at `/api/playa/v2`. The player first needs compatible version and config routes, then listing and detail routes. A downloaded JSON file alone is not the documented integration.

ProjectAVR exports the playable detail body with these mappings:

| ProjectAVR | PLAY’A |
|---|---|
| `flat` | `projection: "FLT"` |
| `180` | `projection: "180"` |
| `360` | `projection: "360"` |
| `mono` | `stereo: "MN"` |
| `sbs` | `stereo: "LR"` |
| `sbs-reverse` | `stereo: "RL"` |
| `tb` | `stereo: "TB"` |
| `tb-reverse` | `stereo: "BT"` |

Host the media with Range support. Downloads additionally need a nonzero `Content-Length`.

Primary sources: [PLAY’A API v2](https://github.com/Playa-vr/PLAYA-API-v2/blob/main/docs.md), [PLAY’A FAQ](https://playavr.com/faq).

## DeoVR

ProjectAVR exports DeoVR’s documented single-video JSON structure:

| ProjectAVR | DeoVR |
|---|---|
| `flat` | `screenType: "flat"` |
| `180` | `screenType: "dome"` |
| `360` | `screenType: "sphere"` |
| `mono` | `stereoMode: "off"` |
| `sbs` / reversed SBS | `stereoMode: "sbs"` |
| `tb` / reversed TB | `stereoMode: "tb"` |

DeoVR’s JSON does not carry ProjectAVR’s reversed-eye distinction, so users must correct eye order in the player when needed.

Host the JSON over HTTPS, then use:

```text
deovr://https://media.example.com/deovr/video.json
```

Primary source: [DeoVR App documentation](https://deovr.com/documentation).

## SKYBOX VR Player

Documented sources include local/USB media and network workflows such as SMB, DLNA, AirScreen, and WebDAV. SKYBOX documents filename recognition for 180°/360°, SBS, and over-under media. SKYBOX does not document direct HTTP(S)/HLS URL playback or a stable cross-platform browser deep-link/catalog API that ProjectAVR can call.

ProjectAVR therefore provides guidance rather than an in-app handoff: use its filename hint for a file you import or rename separately, or expose the media library through a SKYBOX-supported network source. The direct URL shown by ProjectAVR is not a SKYBOX launch mechanism.

Primary sources: [SKYBOX filename rules](https://forum.skybox.xyz/d/157-filename-rules-for-vr-format), [WebDAV release notes](https://forum.skybox.xyz/d/2460-skybox-vr-quest-v118-supported-webdav-and-airplay-casting), [direct-URL limitation discussion](https://forum.skybox.xyz/d/1102-how-to-play-vr-video-files-directly-from-a-url-hls-stream-like-m3u8).

## Pigasus VR Player

Pigasus documents local storage, UPnP/DLNA, and Samba sources, with naming options for flat, 180°/360°, SBS/OU, fisheye, and EAC content. It does not document a universal browser deep-link/catalog contract.

Use a local or LAN media source and the generated filename hint. Pigasus’s bundled playback does not support every audio format; its FAQ specifically lists EAC3, DTS, and MLP as unsupported because of licensing.

Primary sources: [Pigasus product page](https://hanginghatstudios.com/pigasus/), [Pigasus FAQ](https://hanginghatstudios.com/pigasus-faq/).

## Whirligig

Whirligig documents local file selection and several projections, including flat, side-by-side/over-under, equirectangular (“barrel”), fisheye, and custom formats. Its PC command-line interface accepts a media path and can select projection and eye order explicitly, but that CLI is not a browser launch protocol.

Open the original media locally, then set projection and stereo layout explicitly. ProjectAVR provides the source metadata as guidance; it does not launch Whirligig or claim a universal network-stream handoff.

Primary sources: [Whirligig official site](https://www.whirligig.xyz/), [command-line documentation](https://www.whirligig.xyz/command-line).

## What a future companion service could add

A backend or LAN companion can extend the static app with:

- Full PLAY’A API v2 routes
- Hosted DeoVR JSON and real `deovr://` launch links
- WebDAV for SKYBOX
- SMB and DLNA for SKYBOX and Pigasus
- Server-side probing, transcoding, spherical metadata injection, thumbnails, and alternate renditions

Those services are deliberately out of scope for this static repository.
