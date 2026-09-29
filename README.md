# ProjectAVR

A streaming platform for flat, 180°, 360° and fisheye video — with a browse
experience in the browser, WebXR playback in a headset, a creator portal for
publishing, and feeds that the native VR player apps can read.

Built on the [PlayCanvas](https://playcanvas.com) engine.

> **The product is called LustXR; the codebase is called ProjectAVR.** That is
> deliberate and not a half-finished rename. Every string a visitor, a creator
> or a headset can read comes from [`brand.js`](brand.js); the repository, the
> npm package, the Docker image, the `AVR_*` environment variables and the
> `avr://` wire identifiers keep the codebase name, because the last three are
> a protocol contract with a client that is not built from this tree.

---

## What it is

**A web app.** Billboard hero, horizontal shelves, hover-expanding cards, detail
modal, search, resume position. Flat titles play in a normal `<video>`;
immersive titles render on a PlayCanvas surface you can drag to look around, or
step into with WebXR.

**A creator portal.** Sign up, upload a master, set projection and stereo layout
next to a live diagram of what those settings mean, and publish. Uploads are
probed with ffmpeg and packaged into an adaptive-bitrate HLS ladder.

**A compatibility layer.** The same library, exposed three more ways so native
headset players can read it:

| Player | How it connects |
| --- | --- |
| **DeoVR** | DeoVR JSON feed at `/deovr` |
| **Play'a** | DeoVR JSON feed at `/deovr` |
| **SkyBox VR Player** | DLNA/UPnP — appears as *LustXR Library* |
| **Pigasus VR Player** | DLNA/UPnP — appears as *LustXR Library* |
| **Whirligig** | M3U playlist at `/playlist.m3u`, or any direct file URL |

There is no per-player code path. All five read from one `buildLibrary()` call,
so a title published in the portal shows up everywhere at once and can never
describe itself differently to two different apps.

**A live stereoscopic pipeline.** A native iPhone app runs both rear cameras at
once and encodes one hardware stream per eye; the server composes them side by
side and packages HLS for headsets while relaying the raw streams to a ~200 ms
browser monitor for whoever is holding the camera. See
**[docs/LIVE.md](docs/LIVE.md)**.

The capture app is **no longer part of this repository**. It is a content-neutral
broadcasting tool in its own right — it ships no content, has no catalogue and
no default destination, and sends only to an address its operator configures —
so it now lives and ships on its own, as **VRecord**, in a separate repository
with its own brief, audit, test plan and App Store submission pack. Nothing here
imports it and nothing in it imports this; the only thing the two share is the
wire protocol described in **[docs/LIVE.md](docs/LIVE.md)**.

---

## Quick start

```bash
npm install
npm run dev
```

- App (HTTPS, needed for WebXR): <https://localhost:5173>
- Server and all compatibility endpoints: <http://localhost:8080>

```bash
npm run build && npm start        # production, single process
npm run start:cluster             # one worker per core
npm run worker                    # a transcoding worker
npm test                          # 444 unit + integration tests
```

For live broadcasting, install FFmpeg (`brew install ffmpeg`) and build the
VRecord capture app from its own repository. Everything else works without
either — and any client that speaks the ingest protocol in
[`docs/LIVE.md`](docs/LIVE.md) will do, the iPhone app being one such client
rather than a required component.

**The first account you register becomes an admin**, so a fresh install is
usable without a seeding step. After that, registration offers a checkbox for a
creator account, and existing viewers can upgrade from the account menu.

---

## Scaling

The request was "serve streams to an unlimited number of concurrent users." No
single process does that, and no amount of code makes one. What is achievable —
and what this is built for — is an architecture with **no per-node ceiling**, so
capacity is a function of how many machines you point at it.

### The one decision that matters

Video bytes must not pass through the application process.

```
  local storage (default)              object storage + CDN (AVR_STORAGE=s3)
  ───────────────────────              ─────────────────────────────────────
  viewer → Node → disk                 viewer → CDN edge → bucket
           ▲                                    ▲
           every concurrent stream              Node issued one 302 and
           holds a socket and file              is out of the data path
           handle on one machine                entirely
```

With `AVR_STORAGE=s3`, `/stream/*` returns a 302 to a CDN URL (or a presigned
bucket URL) and the app never touches the payload. Concurrency stops being your
problem and becomes the CDN's. Everything below only matters once this is true —
a perfectly stateless app tier still saturates if it is shipping the video
itself.

Presigning is implemented directly against the SigV4 spec in
[`server/storage/sigv4.js`](server/storage/sigv4.js) rather than pulling in the
AWS SDK, and is verified against AWS's published reference signature in
[`test/sigv4.test.js`](test/sigv4.test.js). It works with S3, Cloudflare R2,
Backblaze B2, MinIO, and GCS's S3-compatible endpoint.

### Adaptive bitrate

A 180° stereo master spends its pixels on a sphere the viewer sees a slice of,
so the files are enormous and progressive download stalls on anything but a
strong link. Uploads are packaged into an HLS ladder with a **1.6× bitrate
multiplier for stereo** — side-by-side and over-under pack two eyes into one
frame, so the same nominal resolution carries twice the information and looks
soft at flat-video bitrates.

Five rungs by default, **spread across the source's range rather than taken
from the top of it**. That distinction is the difference between an adaptive
ladder and a set of large files: the top four rungs of an 8K source run from 60
Mbps down to 10, so a viewer who could not hold 10 Mbps had nowhere to drop to
and simply buffered.

Each rung is also remuxed to a progressive MP4 with `-c copy`, which costs no
CPU and is what lets the surfaces that cannot speak HLS — DLNA, the M3U export,
direct download — serve a packaged rung instead of the original file. Which
rung a given client is offered comes from a
[device profile](docs/DELIVERY.md#device-profiles), because an 8K H.264 rung in
a Quest 2's quality menu is a menu item that plays black.

Full detail in [docs/DELIVERY.md](docs/DELIVERY.md).

### The watermark

Every packaged rendition carries a burned-in brand mark. It is composited
**once at source resolution before the ladder splits**, so one pass serves
every rung and there is no path from upload to delivery that skips it.

Stereo titles get **one mark per eye**. A single overlay on a packed SBS frame
lands in one eye only, and a headset cannot fuse an object one eye cannot see —
it floats at no fixed depth and gives people a headache. Immersive projections
put the mark at bottom-centre rather than in a corner, because the corners of an
equirectangular frame are the poles and the space behind the viewer.

### Stateless app tier

No sessions in memory, no catalog owned by a particular node, no upload state
only one machine knows about. Any request can be served by any node:

- **Access tokens are stateless JWTs.** Verifying one costs a signature check
  and no database round trip. Refresh tokens are stored hashed so sessions stay
  revocable — the property a bare JWT cannot give you.
- **The catalog is cached per node** with a 5-second TTL and single-flight
  computation, so a traffic burst on a cold key produces one rebuild rather than
  one per request. An earlier version rebuilt it on *every* request — a full
  `readdir` plus a `stat` per file, on the hot path — which is the kind of thing
  that caps you long before bandwidth does.
- **Anonymous visitors cost zero auth requests.** A readable `avr_session` hint
  cookie lets the client skip a refresh call that could only ever 401.
- **`/api/catalog` sets `s-maxage`**, so a reverse proxy or CDN absorbs most
  catalog traffic before it reaches Node.

### Deployment shape

```
                    ┌─────────────┐
   viewers ────────▶│ CDN / edge  │────▶ object storage   (all video bytes)
                    └─────────────┘
                    ┌─────────────┐
   API calls ──────▶│ load bal.   │────▶ app nodes ×N     (stateless, no video)
                    └─────────────┘           │
                                              ▼
                                         Postgres         (shared state)
                                              ▲
                    uploads ────▶ worker pool ×M          (scales on queue depth)
```

Run web nodes with `AVR_WORKER` unset and scale them on request load; run a
separate pool with `AVR_WORKER=1` and scale it on queue depth. Transcoding an 8K
master pins every core for hours, and doing that on a machine that is also
answering requests turns one upload into a site-wide latency spike.

`npm run start:cluster` forks one worker per core. That fills a single machine —
it is not a substitute for running several. It works at all only because the app
tier holds no per-process state.

### What is *not* unlimited

Being straight about the ceilings that remain in this repo:

| Component | Limit | What production needs |
| --- | --- | --- |
| **SQLite** | Single writer. WAL means readers never block, so the read-heavy browse path scales well, but concurrent writes serialise. | Postgres. Everything goes through the repositories in [`server/db/index.js`](server/db/index.js), so it is one file to reimplement. |
| **Job queue** | In-memory. Survives neither a restart nor a second node. | A real broker (SQS, Redis, NATS). Only `enqueue` and `drain` know how work is dispatched. |
| **Rate limiter** | Per-process, so each node enforces its own window. A brute-force speed bump, not a distributed limit. | A shared limiter (Redis) or the load balancer's. |
| **Local storage mode** | Every stream occupies a socket and file handle on one box. | `AVR_STORAGE=s3`. This is the big one. |
| **DLNA/SSDP** | Binds UDP 1900, which exactly one process can own; under cluster only worker 0 advertises. | Fine as-is — it is a LAN feature, not an internet-scale one. |

None of these are hidden behind an abstraction that pretends otherwise.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `AVR_DB` | `data/projectavr.db` | SQLite path |
| `AVR_JWT_SECRET` | dev file | **Required in production.** Must be ≥32 chars and identical on every node |
| `AVR_STORAGE` | `local` | `s3` to hand delivery to object storage |
| `S3_HOST`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Required when `AVR_STORAGE=s3` |
| `S3_PATH_PREFIX` | — | For path-style endpoints, e.g. `/my-bucket` (MinIO) |
| `CDN_BASE_URL` | — | Serve objects unsigned from an edge; without it, presigned origin URLs are used |
| `AVR_WORKER` | unset | `1` to transcode in this process |
| `AVR_WORKER_CONCURRENCY` | `1` | Parallel transcodes per worker |
| `AVR_WORKERS` | cores | Cluster worker count |
| `AVR_MAX_UPLOAD_BYTES` | 64 GB | Upload size cap |
| `AVR_DLNA` | on | `0` to disable SSDP |
| `AVR_TRUST_PROXY` | `1` | Express trust-proxy setting; wrong values break IP-keyed rate limiting |
| `AVR_LIVE` | on | `0` to disable live broadcasting entirely |
| `AVR_LIVE_PORT` | `8081` | TCP ingest port for the capture app |
| `AVR_LIVE_KEY` | random per boot | Pin the stream key so the phone survives a restart |
| `AVR_IDENTITY_ENFORCE` | off | `1` to require a face-checked per-creator grant to broadcast, instead of the shared key |
| `AVR_IDENTITY_PROVIDER` | `persona` if keyed, else `mock` | Identity provider. The mock approves everyone and is refused under enforcement |
| `AVR_PERSONA_API_KEY` | — | Persona API key |
| `AVR_PERSONA_ENROL_TEMPLATE_ID` | — | Persona template: government ID + selfie + liveness |
| `AVR_PERSONA_FACEAUTH_TEMPLATE_ID` | — | Persona template: selfie only, matched against the enrolled account |
| `AVR_VERIFICATION_DAYS` | `365` | How long a completed verification lasts before re-enrolment |
| `AVR_TRANSCODE` | on | `0` to skip HLS packaging; the low-latency relay keeps working |
| `AVR_TRANSCODE_LADDER` | `1080p@12M,540p@3.5M` | Live bitrate ladder; heights are **per eye** |
| `AVR_LADDER_RUNGS` | `5` | Rungs per uploaded title. Each is another full encode |
| `AVR_PACKAGE_CODECS` | `h264` | `h264,hevc` to package both. HEVC is what puts an 8K rung inside a standalone headset |
| `AVR_WATERMARK` | on | `0` to skip burning the brand mark |
| `AVR_WATERMARK_FILE` | `art/logo-symbol.png` | Mark image |
| `AVR_WATERMARK_OPACITY` | `0.62` | 0–1 |
| `AVR_DEVICE_PROFILES` | — | JSON overriding a headset's `maxHeight` / `maxBitrateKbps` |
| `AVR_DLNA_PROFILE` | `quest2` | Which ceiling DLNA browses apply — a Browse request carries no User-Agent to sniff |

The remaining live and transcode variables are in
[docs/LIVE.md](docs/LIVE.md#configuration); the packaging and delivery ones are
explained in [docs/DELIVERY.md](docs/DELIVERY.md#configuration-summary).

`AVR_JWT_SECRET` is enforced in production: the server refuses to start without
it, rather than silently generating a per-node secret that would make tokens
minted by one node fail on another.

---

## Accounts

Three roles, ranked so `requireRole('creator')` also admits admins:

- **viewer** — browse, play, resume position and My List synced across devices
- **creator** — everything above, plus Creator Studio
- **admin** — everything, and can act on any title

**Security posture.** Passwords are scrypt with cost parameters stored inside
each hash, so they can be raised later and existing hashes upgrade on next
login. Unknown emails are verified against a dummy hash so login timing does not
reveal whether an account exists. Access tokens live in memory only — never
localStorage — so an XSS bug cannot steal a durable credential; the refresh
token is httpOnly and rotates on every use, so a stolen one is usable at most
once. Cross-tenant access returns 404 rather than 403, so title ids cannot be
probed for existence.

**Identity.** Creators prove who they are with a government document and a face
match before they can broadcast, and confirm their face again at every
broadcast sign-in. No face image, template or document scan is ever stored by
LustXR — see [docs/IDENTITY.md](docs/IDENTITY.md).

---

## How playback works

### One video element, three surfaces

There is exactly one `HTMLVideoElement` in the app. The DOM player and the WebXR
renderer both read from it, so entering VR is a change of *presentation*, not a
reload — you can drop into a headset mid-scene and come back out without losing
your place, and two decoders never compete for one stream.

### Projection is geometry, stereo is a shader

Each projection is a purpose-built mesh with UVs baked in: an equirectangular
sphere for 360, a half-sweep dome for 180, a radial dome for fisheye lenses, a
gently curved cinema screen for flat.

Stereo is the hard part. WebXR renders both eyes through a single PlayCanvas
camera, so you cannot swap layers or materials between eyes — by the time a draw
call is issued, "which eye am I?" is not something JavaScript can observe.

The engine does set the built-in `view_position` uniform once per view, from
`XrView.positionData` (the per-eye world position). So the shader identifies its
own eye by asking which of the two eye positions it is standing at:

```glsl
float dl = distance(view_position, uEyeLeft);
float dr = distance(view_position, uEyeRight);
float eye = dl <= dr ? 0.0 : 1.0;
```

Exact rather than heuristic — no reliance on frustum asymmetry, IPD sign, or the
multiview extension — and it degrades to the left eye when there is only one
view. See [`src/player/stereo-material.js`](src/player/stereo-material.js).

### Colour is left alone

The camera runs `GAMMA_NONE` and `TONEMAP_NONE`. A video player's job is to put
the decoded frame on screen unchanged; a gamma or tonemap pass would re-grade
footage someone already graded.

---

## Connecting a headset

Click the cast icon in the header for the exact URLs, or:

**DeoVR / Play'a** — enter `http://<lan-ip>:8080/deovr` in the player's built-in
browser, or add it as a custom site. Creators get a private tokenised feed at
`/deovr/u/<token>` from Studio → Headset feed, which also includes their own
unpublished titles — that is how you check a title in a headset before anyone
else sees it.

**SkyBox / Pigasus** — open the app's DLNA or UPnP section and pick *LustXR
Library*, which is `DLNA_FRIENDLY_NAME` in [`brand.js`](brand.js). Byte-range
seeking is advertised via `DLNA.ORG_OP=01`, so scrubbing works instead of
re-downloading from zero.

**Whirligig** — open `http://<lan-ip>:8080/playlist.m3u` as a URL.

For players with no metadata channel, every file is also served under a
conventional name at `/media/by-name/<id>/<Name_180x180_3dh_LR.mp4>`, so a file
called `clip1.mp4` still announces its layout without being renamed. Each
packaged rung gets that name regenerated at its own height, because SkyBox,
Pigasus and Whirligig read the layout from the last path segment and from
nowhere else.

**What each player is offered.** DeoVR gets a quality menu, DLNA gets several
`<res>` elements, and the M3U gets exactly one URL because the format has no
notion of alternatives — so that choice is made server-side from a device
profile. Append `?device=quest2` to any of those URLs to see what a particular
headset would be served, and `GET /delivery/profiles.json` lists the profiles
and reports which one was detected for you. See
[docs/DELIVERY.md](docs/DELIVERY.md#what-each-surface-does-with-this).

**WebXR needs HTTPS.** `localhost` qualifies; a LAN IP does not. `npm run dev`
serves over HTTPS with a self-signed cert — accept the warning once on the
headset and *Watch in VR* lights up.

---

## Self-hosting without the portal

Drop files into `public/media/` and they are picked up on the next request. Name
them the way the VR players expect and projection is detected automatically:

```
Reef Dive_8K_180x180_3dh_LR.mp4     180° dome,   side-by-side 3D
City Rooftops_360x180_MONO.mp4      360° sphere, monoscopic
Lens Test_MKX200.mp4                200° fisheye, side-by-side 3D
Documentary S01E02 1080p.mp4        flat, 2D
```

Add metadata by editing `public/catalog.json`, keyed by the filename slug.
Explicit metadata always beats what the filename implies.

Both the flat player and the in-headset panel have projection and stereo cycle
buttons, so a mislabelled download can be corrected in two clicks. It is also
the easiest way to see the 180/360 rendering paths if you have no VR footage —
play any flat title and cycle it to 360.

---

## Project layout

```
src/
  catalog/media-format.js    projection + stereo vocabulary, filename sniffing
  app/engine.js              PlayCanvas bootstrap, camera rig, drag-to-look
  player/projections.js      mesh builders per projection
  player/stereo-material.js  per-eye shader
  player/video-source.js     the shared <video> and its GPU texture
  ui/browse.js               billboard, shelves, detail modal, account menu
  ui/vr-ui.js                in-headset panel + controller rays
  ui/creator/portal.js       Creator Studio
  api/client.js              API client, token refresh, upload with progress
server/
  db/                        schema + repositories (the Postgres swap point)
  auth/                      scrypt, JWT, middleware, routes
  identity/                  document + face verification, broadcast grants
  storage/                   local + S3, SigV4 presigning
  media/                     ffmpeg probing, HLS packaging, watermark, job queue
  delivery/profiles.js       what each headset can actually decode
  routes/                    creator + viewer APIs
  library.js                 catalog assembly (single source of truth)
  dlna.js                    SSDP + ContentDirectory
  cluster.js                 multi-core supervisor
  live/                      TCP ingest, session registry, WebSocket relay
  transcode/                 FFmpeg supervision, stereo alignment, HLS ladder
```

---

## Testing

```bash
npm test                      # 444 unit + integration tests
node test/smoke.mjs           # browser: browse, WebXR, shader compile
node test/smoke-portal.mjs    # browser: register, upload, transcode, publish
```

The unit tests pin the filename conventions the native players depend on —
including the ordering trap where `360x180` must not read as 180 — and verify
SigV4 against AWS's published reference signature.

The API tests are mostly authorisation boundaries: cross-tenant reads and
writes, `alg=none` token forgery, refresh-token replay after rotation, and path
traversal. Most of what goes wrong in a multi-tenant portal is one account
reaching another's rows, and no unit test of a repository function catches that.

The browser tests cover what neither can reach: that PlayCanvas initialises,
that the stereo shader compiles on a real GL context, and that a file dragged
into Studio actually becomes a published, playable HLS title.

The live tests drive the real thing rather than a mock: `live-transcode.test.js`
builds two H.264 clips with visibly different content, pushes them through a
real `LiveSession` and a real FFmpeg, and then measures the average luma of each
half of a resulting segment — proving the side-by-side frame holds two genuinely
different eyes rather than one duplicated. It skips itself where FFmpeg is
absent.

---

## Status and caveats

**Verified here.** Browse UI, catalog merge, format detection, registration and
login, role enforcement, cross-tenant isolation, token rotation, a real upload
transcoded to an HLS ladder and published, the DeoVR feed shape, SSDP discovery
and DLNA `Browse`, byte-range seeking, cluster mode across 4 workers with even
load distribution and stateless auth, and 200 concurrent requests served
without error.

**Not verified on real hardware.** The per-eye shader, controller raycasting and
in-headset panel are built against documented WebXR and PlayCanvas behaviour but
have not run in an actual headset. DLNA has not been browsed from SkyBox or
Pigasus on a real network — only driven directly over SOAP. Expect to tune panel
distance and recentre feel on first contact with a device.

**The live pipeline has only been exercised against one phone, once.** Capture,
encode, ingest and the browser monitor worked end to end from a VRecord build on
an iPhone 16 Pro Max against a local server, but that is the whole of it: no
long broadcast, no thermal soak, no second device. The contribution client now
lives in its own repository, so what this repository can still claim is narrower
— that the ingest, relay and monitor ends of that one run behaved — and the
capture end is that project's to prove.

**Live has sound but no recording.** One AAC-LC track travels alongside the
eyes, decoded in the browser and copied onto every HLS rung; nothing mixes it,
meters it, or synchronises the picture to it. Segments are deleted as they age
out of the playlist, so a broadcast is not archived to the library. HLS latency
is about 3 seconds and cannot be tuned below it — FFmpeg's HLS muxer has no Low-Latency
partial segment support, which is why the WebSocket relay exists alongside it.

**A live session is pinned to one process**, unlike everything else in the app
tier. It exists because a socket is open to that node and the FFmpeg writing its
segments is a child of it. Live sessions are therefore absent from
`buildLibrary()` and have their own endpoints.

**The container image has not been built.** Docker is not installed on the
machine this was developed on, so [`Dockerfile`](Dockerfile) is written against
the verified local behaviour rather than tested. The FFmpeg invocation inside it
is byte-for-byte the one exercised by `live-transcode.test.js`.

**Not verified against real object storage.** The SigV4 signing is correct
against AWS's reference vector, but the S3 storage path has not been run against
a live bucket. Expect to shake out endpoint and CORS configuration.

**No load testing at scale.** 200 concurrent local requests is a smoke test, not
a benchmark. The architecture removes the per-node ceiling; it does not prove
any particular throughput number.

`XrView.positionData` is a runtime getter absent from PlayCanvas's published
type definitions. It is the exact array the renderer feeds into `view_position`,
so it is the right thing to match against, with a `viewInvOffMat` fallback.

`node:sqlite` is still flagged experimental in Node 22 and prints a warning on
startup.

---

## Licence

**Proprietary. All rights reserved.** See [LICENSE](LICENSE). Reading this
repository is not permission to run, deploy or fork it; commercial licences are
available on request.

Three things sit outside that, and the third is deliberate rather than an
oversight:

- npm dependencies stay under their own licences.
- The seeded demo titles are Creative Commons films from the Blender
  Foundation — sample data, not part of the software.
- **The ingest protocol in [docs/LIVE.md](docs/LIVE.md) may be implemented by
  anyone, without permission or royalty.** The ingest end is specified so that
  it accepts any conforming client rather than one particular app, and a
  licence that forbade third-party implementations would quietly reverse that.
  What is reserved is this implementation, not the protocol.

`package.json` carries `"private": true` alongside the licence field, so an
accidental `npm publish` fails rather than pushing the platform to the public
registry.
