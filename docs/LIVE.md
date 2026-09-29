# ProjectAVR Live

Live stereoscopic 3D video, from a content creator's iPhone to a headset.

Three tiers, and the boundary between the first two is the only architectural
decision in here that is not negotiable:

| Tier | Runs on | Job |
| --- | --- | --- |
| **Contribution encode** | the iPhone | One high-bitrate, low-latency stream per eye |
| **Transcode and packaging** | a Mac today, AWS later | Compose side-by-side, build a bitrate ladder, segment HLS |
| **Delivery** | the same server | A ~200 ms WebSocket relay *and* HLS, from one ingest |

---

## Why the phone encodes

The obvious design is to send raw frames to a server and do all the work there,
where there is power and cooling and no battery. It does not survive contact
with arithmetic.

Two 1080p30 streams of 4:2:0 8-bit video are

```
1920 × 1080 × 1.5 bytes × 30 fps × 2 eyes ≈ 1.5 Gbps
```

That is ten times what good Wi-Fi delivers in practice and roughly a hundred
times what a phone's uplink to a cloud region will carry. There is no encoder
placement that fixes it and no compression scheme that is not, itself, an
encoder. So the phone encodes. It has dedicated silicon for exactly this, and
using it costs almost nothing in battery compared to keeping the radio saturated.

What the phone produces is a **contribution feed**: one stream per eye, higher
bitrate and lower latency than anything a viewer would receive, encoded for
re-encoding rather than for watching. Turning that into what viewers actually
get — several renditions, composed, segmented, cacheable — is the *transcode*,
and that is the part that belongs on a server and scales by adding machines.

This is the same split AWS Elemental MediaLive and Amazon IVS use. Moving
`server/transcode/` onto either is a deployment change, not a redesign.

---

## The pipeline end to end

```
 iPhone                             Server                        Viewers
 ──────                             ──────                        ───────
 AVCaptureMultiCamSession
   wide + ultra-wide,
   matched by PTS
        │
        ▼
 PixelRectifier                  TCP :8081
   crop both eyes to      ──────▶ ingest ──▶ LiveSession ──┬──▶ WS /live/ws/:id
   a common FOV                   handshake,   registry     │      the operator's
        │                         framing                   │      monitor, ~200 ms
        ▼                                                   │
 VideoToolbox × 2                                           ▼
   one hardware encoder                              TranscodePipeline
   per eye, no B-frames                                StereoAligner
   AudioEncoder → AAC-LC                               ADTS wrap
        │                                                   │
        ▼                                                   ▼
 IngestClient                                         ffmpeg (fd 3, 4, 5)
   20-byte framed TCP                                   hstack → ladder
                                                        → HLS
                                                            │
                                                            ▼
                                                   GET /live/hls/:id/master.m3u8
                                                     DeoVR, Safari, Quest,
                                                     Vision Pro — ~3 s
```

Both outputs run at once from one ingest. They are not alternatives. Sound, when
it is switched on, takes the same path on its own track — see
[The audio track](#the-audio-track).

Recording a 1:1 adds a third consumer on the same seam: `RecordingPipeline`
subclasses `TranscodePipeline` and attaches as an ordinary subscriber, writing
one MP4 instead of a ladder. Because it sits where every other subscriber sits,
it sees exactly what a viewer sees coming *down* from the camera — talkback goes
the other way and cannot reach it. See
[MONETISATION.md](MONETISATION.md#where-this-is-up-to).

---

## Why there are two delivery paths

The WebSocket relay hands each eye to the browser as a separate WebCodecs
stream, about 200 ms behind reality. That is fast enough for the person holding
the camera to use it as a monitor. It is also unusable as a distribution format:
WebCodecs is absent from Safari's immersive path, from Vision Pro and from
DeoVR, and a relay fans out linearly from one process.

HLS plays everywhere and puts a CDN between the server and the audience. It is
also slower, and the number is worth being precise about rather than optimistic:

> **Latency is roughly `segment length × playlist length ÷ 2`, about 3 seconds at
> the defaults.** FFmpeg's HLS muxer does not implement Low-Latency HLS partial
> segments, so sub-second HLS is not reachable by tuning `AVR_TRANSCODE_SEGMENT`
> — it would need a different packager. Three seconds is ordinary for live HLS.

Shortening the segments does help a little, and costs more overhead per segment.
It does not get you to a usable camera monitor, which is why the relay stays.

---

## The wire protocol

One framing for both hops — phone→ingest over TCP, ingest→browser over a binary
WebSocket — so a frame is parsed by exactly one piece of code. Defined once in
[`src/live/protocol.js`](../src/live/protocol.js) and mirrored in the capture
app's `WireProtocol.swift`, which is now in a separate repository — so this
section is a contract across a boundary, not an implementation detail. Changing
it breaks a codebase that will not fail this build.

Little-endian throughout:

```
offset  size  field
0       4     length      bytes after this field (= 16 + payload)
4       1     type        HELLO 1, READY 2, CONFIG 3, VIDEO 4, AUDIO 5,
                          STATS 6, BYE 7, PING 8, PONG 9,
                          BILLING 10, CHAT 11, PRIVATE 12
5       1     track       LEFT 0, RIGHT 1, AUDIO 2, PACKED 3, TALKBACK 4
6       2     flags       KEYFRAME 1, DISCONTINUITY 2
8       8     timestamp   capture time, microseconds
16      4     sequence    per-track, wraps at 2^32
20      N     payload
```

**What `LEFT` means.** Track 0 carries the image for the **viewer's left eye** —
the viewpoint displaced toward the viewer's left, which sees a near object
further to the *right* against a distant background than track 1 does. Track 1
is the right eye. This is normative and nothing downstream reinterprets it:
`LEFT` is the left half of every side-by-side composition this server produces,
and the left view of every headset it feeds.

The mapping from a physical sensor to an eye is the **contributor's** to make
and to get right. It depends on the device's lens geometry and on how the
operator is holding it, neither of which the server can see, so a client must
not assume a lens order and the server will not correct one. A client that gets
it backwards produces inverted depth on every surface at once; there is no
receiver-side setting that fixes it for anyone but the person who ticked it.

Length-prefixed with no per-frame magic number: both transports are ordered and
reliable, so there is nothing to resynchronise to, and four bytes of ceremony at
60 fps × 2 eyes is not free. The handshake *does* carry a protocol name and
version, which the server checks before trusting anything else on the socket.

Video payloads are Annex B. **Parameter sets are prepended to every keyframe**,
not sent once — otherwise a viewer who joins thirty seconds in has nothing to
configure a decoder with.

Types 10–12 exist only on the browser hop and carry JSON, not media: `BILLING`
is the running cost of the minute, `CHAT` is the room, `PRIVATE` is the state of
a 1:1 request. The phone has never been sent one and its reader ignores types it
does not know. `TALKBACK` is the one track that travels *towards* the camera —
see below.

---

## The relay is no longer one-way

For most of this project's life the WebSocket was a fan-out and nothing else:
anything arriving from a viewer was a bug or a probe, and was dropped without a
reply. Two things now travel back up it, and both are deliberately narrow.

**Chat.** A `CHAT` frame with `{text}` from a signed-in viewer who is in the
room. Rate-limited and length-limited, and the two refusals a person can act on
come back as a notice on their own socket — a message that silently fails to
appear reads as a broken page.

**Talkback** — speech from the viewer a broadcast is private to, all the way to
the phone:

```
 browser mic ──► AudioWorklet ──► WebSocket ──► relay ──► ingest socket ──► phone
  16 kHz mono    640-sample         AUDIO/         re-encoded      track 4,
                 Int16 packets      TRACK.TALKBACK  header         AVAudioEngine
```

The format is a constant rather than a negotiation:
`pcm-s16le`, 16 kHz, mono, 640 samples — 40 ms, 1280 bytes of payload, 1300 on
the wire, comfortably under the socket's `maxPayload`. Linear PCM because it
means **the capture app needs no decoder**: the only thing it parses is a length.

Four rules hold the path open safely, and each is enforced where it can be
enforced cheaply:

1. **Only the person the broadcast is private to.** Checked against the open
   room on every packet, so the floor is lost the instant the turn ends. Not a
   public viewer, not the creator, not somebody who was in a 1:1 a minute ago.
2. **The header is ours, the payload is theirs.** The relay re-encodes the frame
   with a type and track it chose, so nothing a viewer writes can reach the
   phone claiming to be video or configuration.
3. **Dropped, never queued** — at three independent points: the browser stops
   sending above 16 KB of `bufferedAmount`, the relay gives each socket a
   refilling 64 KB/s byte budget, and `sendUpstream` refuses when the ingest
   socket is already backed up. Late speech is worse than missing speech, and
   the socket it would queue on is the one carrying the broadcast.
4. **Off at both ends by default.** The viewer must press *Talk to them*, which
   is also the gesture that gets the microphone; the phone must have **Return
   audio** switched on in Settings, or the frames are read and discarded. The
   capture app plays at most half a second of it and drops the rest. The App
   Store judgement this feature carries is recorded in the capture app's own
   risk register, not here.

---

## The audio track

One track, `TRACK.AUDIO`, carrying **bare AAC-LC access units** — no ADTS, no
container. 1024 frames per unit, which is fixed by the format and is what makes
the timestamps derivable rather than measured: the encoder advances the clock by
the frames it has consumed, anchored on the first buffer, so jitter in when a
buffer arrives never becomes jitter in when it plays. A drift of more than 60 ms
against the capture clock re-anchors and flags `DISCONTINUITY`.

The CONFIG for the track carries the codec string `mp4a.40.2` and a base64
`AudioSpecificConfig` in `description`. That is not optional garnish: a WebCodecs
`AudioDecoder` has no in-band equivalent of the parameter sets the video path
relies on and cannot be configured without it. The phone *synthesises* the
`AudioSpecificConfig` from the rate and channel count rather than reading the
converter's magic cookie, because on Apple platforms that cookie is a nested
MPEG-4 elementary stream descriptor and parsing it wrongly yields a plausible
blob that decodes to noise.

**Every access unit is flagged `KEYFRAME`.** This is literally true — every AAC
frame is a sync sample — and it has to be set, because both the relay's
late-joiner gate and its keyframes-only backpressure trim were written for video
and would otherwise hold sound back or discard it. A late joiner gets the audio
CONFIG and then audio immediately, while the picture is still waiting for the
next video keyframe. Audio is about 1% of the bytes; a silent broadcast is not a
degraded broadcast, it is a broken one.

Two consumers, two shapes:

- **The browser** gets the access units as they are, and decodes them with
  `AudioDecoder`. Playback starts **muted** — an `AudioContext` is suspended
  until a user gesture, with no way to detect that in advance, so the monitor
  shows a sound control rather than silently failing. The player never delays
  the picture to match the sound; if audio falls behind it resynchronises by
  dropping.
- **FFmpeg** gets the same units wrapped in seven-byte ADTS headers by
  [`server/transcode/adts.js`](../server/transcode/adts.js), because `-f aac` on
  a pipe needs a self-describing stream. It arrives on **fd 5** (after the two
  eyes on 3 and 4) and is mapped onto every rung with `-c:a copy` — the audio is
  already AAC-LC at a rounding error of the video bitrate, so re-encoding would
  cost CPU and give back generation loss.

Adding an input means restarting FFmpeg, and the phone announces its video and
audio formats at nearly the same moment. Rather than restart the transcode on
essentially every broadcast, the pipeline waits 500 ms for an audio CONFIG before
spawning, and cancels that wait the instant one arrives.

---

## Running it locally

```sh
npm install
brew install ffmpeg      # the transcode tier; everything else still works without it
npm start
```

The banner tells you everything the phone needs:

```
  Live monitor http://192.168.1.110:8080/live
  Live ingest  tcp://192.168.1.110:8081  (iPhone capture app)
  Stream key   7f3a9c21e04b8d56
  Transcode    ffmpeg 8.1 via libx264 - HLS ladder 1080p, 540p
               ~3s latency, segments in /var/folders/.../T/avr-live-hls
```

Then build and run a contribution client. The reference one is the VRecord
iPhone app, in its own repository; pair it from its Destinations screen using
*Search this network*, or paste the `avr://pair?…` URL from
`GET /api/live/pairing`.

### Endpoints

| | |
| --- | --- |
| `GET /live` | Operator monitor, both eyes decoded in the browser |
| `GET /api/live/sessions` | What is broadcasting **that anyone may watch**, with `relayPath` and `hls` for each |
| `GET /api/live/pairing` | Address, port **and stream key**. Creator role only. |
| `POST /api/live/waiting` | Join the waiting list. Signed in only. Returns the admission secret, once. |
| `POST /api/live/waiting/:id` | Check in, and find out whether anybody has chosen you |
| `POST /api/live/waiting/:id/leave` | The tab is closing. `sendBeacon`-shaped; authorises on the secret alone. |
| `GET /api/live/waiting` | Who is waiting, for a creator about to choose. Creator role only. |
| `GET /api/live/rooms/:id` | Has the camera turned up yet. Only for the creator who opened it. |
| `GET /api/live/watch/:id` | What this broadcast costs this viewer, and whether a 1:1 is on offer. 404 for a private broadcast you are not the one it is private to |
| `POST /api/live/watch/:id/mode` | Switch yourself between 2D and 3D. Applies at the next minute boundary |
| `POST /api/live/watch/:id/private` | Ask this creator for a 1:1. Idempotent; 402 with no credits, 429 if you keep asking |
| `GET /api/live/watch/:id/private` | Where your own request stands, and the admission secret if it was taken |
| `POST /api/live/watch/:id/private/end` | End the turn. Either party, same route |
| `GET /api/live/broadcasts/:id/requests` | Everyone asking you for a 1:1 right now. Creator role only |
| `POST /api/live/private/:requestId/accept` | Take one, and empty the room. Creator role only |
| `POST /api/live/private/:requestId/decline` | Creator role only |
| `POST /api/live/private/:requestId/cancel` | The asker changing their mind |
| `GET /api/live/checks` | Whether this creator has confirmed their stream this sign-in. Creator role only. |
| `GET /api/live/checks/preview` | The creator's own live broadcast, for the setup check to decode and show them. `{preview: null}` until a camera connects; `attributed: false` on the shared stream key |
| `POST /api/live/checks/:kind` | Record a `standard` or `spatial` setup confirmation. 409 `no_broadcast` with nothing live, 409 `not_stereo` for a `spatial` check over one eye |
| `GET /api/creators/live` | Who is on air and who is ready, for the home page. Public sessions only. |
| `GET /live/transcode` | FFmpeg version, encoder, ladder, per-session state |
| `GET /live/hls/:id/master.m3u8` | The HLS ladder |
| `ws://…/live/ws/:id` | The relay. Media and `BILLING`/`CHAT`/`PRIVATE` down; chat and talkback up |

Discovery answers a UDP probe on `:8082` with an address and **never the stream
key**. Discovery tells you a door exists; pairing gives you the key.

### Broadcasting to one person: the waiting room

By default a broadcast is public: it appears in `GET /api/live/sessions` and
anybody who can reach the server can watch it. A creator can instead open one
for a single named person, and the direction of that is the opposite of what an
invitation link would do.

```
 Viewer's browser                  Server                    Creator's portal
 ────────────────                  ──────                    ────────────────
 opens /live signed in
        │  POST /api/live/waiting
        ▼
   WaitingViewer ─────────────▶ RoomRegistry ◀──────────── GET /api/live/waiting
     id + secret                  (in memory)                 names and screens
        │                              │                              │
        │                              │      clicks a name           │
        │                              ▼◀─────────────────────────────┘
        │                            Room ──── bound to the grant that is
        │                              │       minted in the same request
        │  POST /api/live/waiting/:id  │
        ▼◀─────────────────────────────┘                    avr://pair?… QR
   "live", sessionId                   ▲                            │
        │                              │                            ▼
        └──── ws://…/live/ws/:id?admit=…│ ◀── LiveSession ◀──── the phone scans
                                    session.grantId            and connects
```

Three properties hold this up, and each one is there to keep something out:

- **The destination link does not change.** The room and the chosen viewer are
  bound to the *grant*, server-side. The QR code the phone reads is the same
  `avr://pair?host=…&port=…&key=…` it has always been, so the capture app needs
  no notion of "end users" at all — which is the point.
- **Privacy is intrinsic, not a setting.** A session whose grant has a room is
  absent from the public list, answers 404 by id, is admission-checked at the
  relay, and is **never transcoded** — the HLS segments are plain static files
  served with `Access-Control-Allow-Origin: *`, so not producing them is the
  only version of this that a later route cannot undo.
- **The viewer proves admission with a secret, not with their own id.** The
  creator is shown viewer ids, so a viewer id cannot also be what opens the
  socket. A separate 32-byte `admitToken` is issued once, held in the page's
  memory, and compared in constant time. A wrong one gets a 404, not a 403.

Nothing here is persisted. The waiting list and the rooms live in
`server/live/rooms.js` for the same reason `sessions.js` does — a session exists
because a socket is open to *this* process — and they inherit the same
single-process constraint.

### The shared stream key identifies a device, not a person

Every phone presents the same `AVR_LIVE_KEY`, so an ingest session cannot be
attributed to a creator and revoking one device means re-pairing all of them.
That is fine for a LAN rehearsal and not fine for a platform.

Setting `AVR_IDENTITY_ENFORCE=1` replaces it: `HELLO.key` must then carry a
**broadcast grant**, issued in the creator's browser behind a face check, good
for one broadcast and a few minutes. The session then carries a `userId`, so it
is attributable to a person. See [IDENTITY.md](IDENTITY.md), which also records
why this is not a durable API key.

### One vocabulary across all three products

The portal, the capture app and the link between them name the same things the
same way. They did not always, and a creator reading one screen while typing
into the other had to translate.

| Term | Is | Not |
| --- | --- | --- |
| **Destination** | A saved place to send a broadcast | "profile", "target" |
| **Destination link** | The whole `avr://pair?…` string, scanned or pasted | "broadcast address", "pairing link" |
| **Name** | What the destination is called in the app's list | "label", "title" |
| **Address** | The ingest host | "server", "URL" |
| **Port** | The ingest TCP port | |
| **Stream key** | The credential in `HELLO.key`, as the creator sees it | "token", "secret" |
| **Encrypted** | Whether the link uses TLS, said as Yes or No on both sides | "TLS", "secure" |
| **Certificate pin** | The SHA-256 of the pinned certificate | "fingerprint" |
| **Standard** | One camera. What the 2D stream check confirms | "mono", "2D mode" |
| **Stereo Side-by-Side** | The wide and ultra-wide pair. What the 3D stream check confirms | "MV-HEVC", "VR180", "spatial" |

The two mode names come from the capture app's own Mode control, so the stream
checks on the profile page name the control the creator is reaching for rather
than describing it. The server's check kind for the second one is `spatial` —
an API and database value, like `grant` below, and not a word on either screen.

`avr://pair` itself is unchanged and stays that way: it is a wire format that
every issued link, every QR code the portal draws and the app's URL handler are
keyed on. Only the prose around it moved.

The server calls the same credential a **grant**, and that is deliberate rather
than a slip: `broadcast_grants`, `mintBroadcastGrant`, `grantId`. The server-side
name carries the properties that matter on that side — minted, spent once,
expiring — where "stream key" names the field the creator types into. Neither
word belongs on the other's screen.

### Encrypting the contribution link

The ingest socket carries the credential in its first frame and the broadcast
after it. Set `AVR_LIVE_TLS_CERT` and `AVR_LIVE_TLS_KEY` and the listener wraps
itself in TLS 1.2+; leave either unset and it stays cleartext, which is a
defensible choice on a studio LAN and nowhere else.

A public host should use a real certificate — the phone validates it against the
iOS trust store like any other. The awkward case is the normal one: a server on
`192.168.1.110`, which no authority will ever issue for. There the server
generates its own certificate and the phone is told, in the pairing link, exactly
which certificate to expect:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 825 -subj '/CN=avr-ingest' \
  -keyout ingest-key.pem -out ingest-cert.pem
chmod 600 ingest-key.pem

AVR_LIVE_TLS_CERT=$PWD/ingest-cert.pem AVR_LIVE_TLS_KEY=$PWD/ingest-key.pem npm start
```

On boot the server logs the pin it will advertise:

```
[live] ingest TLS enabled, pin sha256/kQ2h…
```

Nothing else needs configuring. The pin is the base64 SHA-256 of the
certificate, it goes into every pairing link the server issues, and the phone
then accepts that certificate and no other — the trust store is not consulted,
so `CN`, expiry and the absence of an issuer do not matter. Regenerating the
certificate invalidates saved destinations on phones that already imported one;
they import a new link.

The material is read once at startup. A certificate that changes under a running
process is a restart, not a reload. If either file is unreadable the server logs
it and keeps listening in the clear rather than refusing to boot, and pairing
links stop advertising TLS, so no phone is left expecting something the server
is not doing.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVR_LIVE` | on | `0` disables the whole live subsystem |
| `AVR_LIVE_PORT` | `8081` | TCP ingest port |
| `AVR_LIVE_KEY` | random per boot | Pin the stream key so the phone survives a restart |
| `AVR_IDENTITY_ENFORCE` | off | `1` requires a per-creator broadcast grant instead of the shared key |
| `AVR_LIVE_TLS_CERT` | off | PEM certificate for the ingest listener. Both this and the key must be set or the listener stays cleartext. |
| `AVR_LIVE_TLS_KEY` | off | PEM private key for the above |
| `AVR_PUBLIC_INGEST_HOST` | request host | The address to put in destination links, when the phone reaches ingest somewhere other than where the browser reaches the web app |
| `AVR_LIVE_DISCOVERY_PORT` | `8082` | UDP discovery |
| `AVR_LIVE_MAX_SESSIONS` | `8` | Concurrent broadcasts |
| `AVR_LIVE_MAX_VIEWERS` | `16` | Relay viewers per session (HLS viewers are unlimited) |
| `AVR_TRANSCODE` | on | `0` disables HLS; the relay keeps working |
| `AVR_FFMPEG` | `ffmpeg` | Path to the binary |
| `AVR_TRANSCODE_DIR` | `$TMPDIR/avr-live-hls` | Where segments are written |
| `AVR_TRANSCODE_LADDER` | `1080p@12M,540p@3.5M` | Rungs. Heights are **per eye** — 1080 means a 3840×1080 frame. |
| `AVR_TRANSCODE_SEGMENT` | `1` | Segment seconds |
| `AVR_TRANSCODE_WINDOW` | `6` | Playlist length |
| `AVR_TRANSCODE_PRESET` | `veryfast` | x264 preset |
| `AVR_TRANSCODE_HWACCEL` | off | `1` uses `h264_videotoolbox`. **macOS only**, and see below. |

`AVR_TRANSCODE_HWACCEL` is off by default even on a Mac that has a perfectly
good hardware encoder, because the point of running this locally is to rehearse
what will be deployed, and the hardware path produces different output at
different speed and quality. Turn it on when you want throughput and accept that
it is no longer a rehearsal. It does nothing on Linux.

Before adding a third ladder rung, check that `speed=` in the FFmpeg progress
output stays above 1.0. These are very wide frames.

---

## Two details that are easy to get wrong

### Eye drift

A raw Annex B stream carries no timestamps. Left to itself FFmpeg synthesises
them at a fixed rate, so one dropped frame on one eye shifts that eye forward by
a frame **permanently** — a stereo pair that slides apart over the course of a
broadcast. A one-frame offset does not look like a bug to a viewer; they get a
headache twenty minutes in.

Two mechanisms, both needed:

1. [`StereoAligner`](../server/transcode/aligner.js) only ever writes matched
   pairs to the two pipes, so they stay in lockstep byte for byte. An unmatched
   frame is **discarded** rather than paired with its neighbour — better a
   dropped frame than a shifted one.
2. `-use_wallclock_as_timestamps 1` plus a per-input `fps=N` filter, so a
   genuine gap is preserved as a gap and filled by duplication, instead of
   shifting everything after it.

### Field of view

The ultra-wide sees much more than the wide, and the two eyes must cover the
same scene. The crop factor is a ratio of **tangents**, not of degrees:

```
k = tan(target ÷ 2) ÷ tan(source ÷ 2)
```

Cropping 120° down to 73° keeps 43% of the width, not 61%. Using the degree
ratio produces a pair that is subtly mismatched in a way that is very hard to
diagnose by eye.

---

## Deploying to AWS

The [`Dockerfile`](../Dockerfile) builds the app tier and the transcode tier
into one image: Node 22 plus Debian's FFmpeg, no macOS-specific paths anywhere
in `server/transcode/`.

```sh
docker build -t projectavr .
docker run --rm -p 8080:8080 -p 8081:8081 \
  -e AVR_LIVE_KEY=$(openssl rand -hex 8) \
  -e AVR_JWT_SECRET=$(openssl rand -hex 32) \
  -v projectavr-data:/data \
  --tmpfs /tmp/avr-live-hls \
  projectavr
```

On ECS/Fargate:

- **Two ports, two listeners.** 8080 is HTTP and wants an ALB — it carries the
  WebSocket upgrade for the relay, so enable stickiness. 8081 is raw TCP and
  needs an **NLB**; an ALB cannot carry it. UDP discovery is not exposed at all,
  because it is a LAN convenience and inside a VPC the phone is told an address
  rather than shouting for one.
- **A live session is pinned to one task.** It exists because a socket is open
  to that specific process, and the FFmpeg writing its segments is a child of
  it. This is the one part of ProjectAVR that is not horizontally stateless.
  Scale it by running more tasks behind the NLB, not by expecting a session to
  survive a task replacement.
- **`AVR_TRANSCODE_DIR` should be ephemeral storage or a tmpfs**, not the
  container's writable layer. A running transcode rewrites it continuously and
  nothing in it matters for more than a few seconds. Fronting
  `/live/hls` with CloudFront is what makes the audience scale — the playlists
  already send `no-cache` and the segments `immutable`, which is the pairing a
  CDN needs.
- **Sizing.** Each rung is a full encode of a double-width frame. Two rungs at
  1080p per eye is roughly two vCPU of `libx264 -preset veryfast` per broadcast;
  `AVR_TRANSCODE_LADDER` and `AVR_TRANSCODE_PRESET` are the knobs. Watch
  `speed=` in the container logs — anything below 1.0 means the transcode is
  falling behind and latency will grow without bound.
- **`AVR_TRANSCODE_HWACCEL` has no effect on Linux** and should be left unset.
  Hardware transcoding on AWS means a different instance family and a different
  encoder name, not this flag.
- **`AVR_JWT_SECRET` must be set and identical on every task**, or a token
  minted by one is rejected by the next.

---

## What this does not do

- **No audio mixing, and no A/V sync loop.** There is exactly one sound track,
  taken straight from the phone; nothing mixes, ducks or gates it. The monitor
  plays sound as it arrives rather than presenting pictures against an audio
  clock — see the audio track section above for why.
- **No on-device side-by-side packing.** `TRACK.PACKED` exists and the monitor
  understands it, but the phone always sends separate eyes and the server
  composites.
- **No LL-HLS.** See the latency note above.
- **HLS segments are not kept.** They are deleted as they age out of the
  playlist. Archiving is a separate path — `server/live/recording.js` extends
  the transcode pipeline to write an MP4 — and a broadcast still does not land
  in the library on its own.
- **Eye order is the contributor's to establish, and no contributor has proved
  it against hardware.** The protocol is covered from both sides and the
  server-side chain from track byte to screen has been traced end to end with no
  lateral inversion on any of the four surfaces (`/live`, HLS, the recorded MP4,
  WebXR). What nothing here can check is the step before the wire: which
  physical lens a client labels `LEFT`. Inverted depth reported against this
  server should be diagnosed at the capture client first.
- **Live sessions are absent from the catalog.** Folding a node-local thing into
  `buildLibrary()` would break the property that any node can answer any catalog
  request, so they have their own endpoints instead.
- **No video or text from a viewer.** The return path is chat and one channel of
  speech from the one person a broadcast is private to, and nothing else. There
  is no viewer camera, no file upload, and no way for a public viewer to be
  heard at all.
- **No echo cancellation on the talkback path**, at either end. The browser asks
  `getUserMedia` for it, which handles the viewer's side; the phone deliberately
  does not enable voice processing, because the only switch for it degrades the
  captured sound of every broadcast. The capture app tells the operator to wear
  headphones.

---

## Tests

```sh
node --test test/live-protocol.test.js    # framing, handshake, partial reads
node --test test/live-relay.test.js       # fan-out, keyframe gating, backpressure, admission
node --test test/live-transcode.test.js   # ladder, aligner, and a real FFmpeg run
node --test test/rooms.test.js            # the waiting list and who may watch what
node --test test/chat.test.js             # the room, rate limits, who may post
node --test test/private-turn.test.js     # request, accept, decline, and the eviction
node --test test/talkback.test.js         # the upstream path, against a real relay
node --test test/talkback-client.test.js  # the AudioWorklet, and when the browser drops
node --test test/recordings.test.js       # recording a 1:1, and the marketplace over it
node --test test/recorder-client.test.js  # the viewer's own recording, in the browser
```

The last of those builds two H.264 clips with visibly different content, drives
a real `LiveSession` and `TranscodePipeline`, waits for `master.m3u8`, and then
measures the average luma of each half of a real segment to prove the
side-by-side frame contains **two different eyes** rather than one duplicated.
It skips itself if FFmpeg is not installed.
