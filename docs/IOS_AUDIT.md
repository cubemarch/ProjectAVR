# iOS capture app — audit, architecture, and risk register

Companion to [`IOS_BRIEF.md`](IOS_BRIEF.md), which states the requirements this
document audits against. Written for whoever maintains, reviews, or submits the
`ios/` target.

Everything below describes the app **as it is in the repository**, not as it is
intended to become. Where something is unimplemented it says so, and where a
claim depends on hardware nobody has tested on, it says that too.

- [1. What was found](#1-what-was-found)
- [2. Architecture and data flow](#2-architecture-and-data-flow)
- [3. Device capability matrix](#3-device-capability-matrix)
- [4. Streaming protocol and codec matrix](#4-streaming-protocol-and-codec-matrix)
- [5. Destination profile schema](#5-destination-profile-schema)
- [6. Security and threat model](#6-security-and-threat-model)
- [7. Privacy and data inventory](#7-privacy-and-data-inventory)
- [8. Guideline conformance](#8-guideline-conformance)
- [9. Risk register](#9-risk-register)
- [10. Decisions taken, and what they cost](#10-decisions-taken-and-what-they-cost)
- [11. Next three actions](#11-next-three-actions)

---

## 1. What was found

The app that existed before this pass worked, and the capture and encode halves
of it were the good part: a hand-built `AVCaptureMultiCamSession`, a VideoToolbox
encoder per eye, a length-framed TCP client, and a lens matcher. Those were kept
almost intact.

What it did not have was anything between the operator and the network. There
was one destination, stored as four loose `UserDefaults` keys — **including the
stream key, in the clear**. A pairing link was applied the instant it arrived,
with no confirmation and no validation, so any web page could silently
repoint the phone at a server of its choosing. There was no consent gate, no
privacy manifest, no test target, and the camera usage string described a
product the app is not.

Findings, in the order they mattered:

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Stream key stored in `UserDefaults` in the clear | Critical | Fixed — Keychain, `WhenUnlockedThisDeviceOnly`, with a one-way migration that deletes the old key |
| 2 | `avr://pair` links applied without confirmation | Critical | Fixed — parse → validate → show → explicit confirm |
| 3 | Stream keys reachable in logs and in the diagnostics export | High | Fixed — `Redact`, plus a test asserting the export contains no host, name, or key |
| 4 | No record-consent / rights acknowledgement (2.5.14, and the substantive reason) | High | Fixed — versioned one-time gate in front of the first broadcast |
| 5 | No `PrivacyInfo.xcprivacy` — a hard rejection since May 2024 | High | Fixed |
| 6 | Single destination, no way to see or erase what was stored | High | Fixed — profile list, editor, and "Erase stored data" |
| 7 | Camera usage string mentioned the sibling web product | Medium | Fixed — content-neutral, describes only what the camera is for |
| 8 | Capture interruptions treated as fatal; no thermal policy | Medium | Fixed — interruptions are surfaced, not fatal; two consecutive `.critical` windows latch a fallback to mono |
| 9 | No reconnection: a dropped Wi-Fi frame ended the broadcast | Medium | Fixed — capped backoff, and only after a session has been live once |
| 10 | Discovery replies trusted as a destination *including a key* | Medium | Fixed — a UDP responder can contribute an address and nothing else |
| 11 | No tests of any kind | Medium | Fixed — 132 tests |
| 12 | Octal/leading-zero IPv4 (`0177.0.0.1`) accepted as an address | Low | Fixed — see §6 |
| 13 | No audio capture at all | Medium | Fixed — optional AAC-LC on track 2. With Sound off no microphone is attached at all |
| 14 | No local recording | Low | **Open** |
| 15 | One transport only | Low | **Open, and deliberately so** — see §10 |
| 16 | Contribution link was cleartext TCP | High | Fixed — TLS, with certificate pinning for destinations no CA can issue for. See §6 T8 |
| 17 | Privacy-policy and support URLs blank | High | Fixed — pages written and linked; the **domain is still a placeholder**, see §9 H2 |
| 18 | Status bar read "Ready" with no destination configured, and nothing ever asked for one | Medium | Fixed — first-run "Connect a destination" prompt, and "Ready" is green only when a profile *and* its Keychain key exist |
| 19 | No return audio: a director at the destination had no way to be heard by the operator | Low | **Implemented this pass** — one-way talkback, off by default. Carries a compliance judgement, see §9 **H4** |

**Verification as this was last written.** Xcode 16.4, iOS 18 SDK, from a clean
`xcodegen generate`:

```
xcodebuild -project ios/AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
** BUILD SUCCEEDED **

xcodebuild -project ios/AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
Executed 132 tests, with 0 failures (0 unexpected)
** TEST SUCCEEDED **
```

Fourteen of those 132 are `AVRCaptureTests/ReturnAudioTests.swift`, added with
finding 19. They cover the admission rules (`ReturnAudioBuffer`) and the wire,
not the speaker: `AVAudioEngine` against a real output device is not something a
simulator test host reliably has, which is why the rules were split out of
`ReturnAudioPlayer` into a value type in the first place. What is therefore
still untested anywhere is playback itself — see risk M1.

---

## 2. Architecture and data flow

Four stages, each in its own directory, each ignorant of the next beyond a
callback.

```
 AVCaptureMultiCamSession                  Capture/StereoCaptureSession.swift
   ├── wide      ──► AVCaptureVideoDataOutput ─┐
   └── ultra-wide ──► AVCaptureVideoDataOutput ─┤   paired by hand in the
                                                │   delegate, by presentation
                                                │   timestamp
                                                ▼
 PixelRectifier         crop / scale to the declared frame size
 LensMatcher            exposure + white balance trim, ultra-wide to wide
   │
   ▼
 VideoEncoder × 2       Encode/VideoEncoder.swift
   VTCompressionSession per eye, H.264 or HEVC, Annex-B → AVCC
   │
   │      ┌─ AVCaptureAudioDataOutput ──► AudioEncoder
   │      │    attached only with Sound     Encode/AudioEncoder.swift
   │      │    on; its own queue            AudioConverter → AAC-LC
   │◄─────┘
   ▼
 BroadcastController    the state machine and every policy decision
   │
   ▼
 IngestClient           Net/IngestClient.swift
   NWConnection, one TCP socket, length-framed
   │
   ▼
 server/live/*          relay → WebSocket to browsers, and HLS

 and back up the same socket, when Return audio is on:

 server/live/*  ──► IngestClient ──► ReturnAudioPlayer   Audio/ReturnAudioPlayer.swift
   audio frames on track 4          AVAudioEngine → the speaker or the headset
   linear PCM, 16 kHz, mono         admission rules in ReturnAudioBuffer.swift
```

`BroadcastController` is the only object that knows about more than one stage.
It holds `nonisolated(unsafe)` mirrors of the settings the frame path reads, so
`handle(_:)` never hops to the main actor at 30–60 fps; everything a view binds
to is `@Published` and main-actor.

**What crosses a process boundary, and when**

| Leaves the device | When | To where | Contains |
|---|---|---|---|
| `hello` frame | Once, at connect | The configured destination only | Stream key, declared layout, codec, resolution, frame rate, optional broadcast name |
| `config` frame | After `ready` | Same | SPS/PPS or VPS/SPS/PPS per video track; for audio, the codec string and an `AudioSpecificConfig` |
| `video` frames | Continuously | Same | Encoded picture data |
| `audio` frames | Continuously, **only with Sound on** | Same | Encoded AAC-LC. With Sound off no microphone is attached and none are produced |
| `stats` frames | Every few seconds | Same | Frames encoded, frames dropped, measured bitrate |
| `bye` | On a clean stop | Same | Nothing |
| Discovery probe | Only while the Destinations screen is searching | UDP broadcast, local subnet | A fixed probe string. No key, no name, no identifier |

**What enters the device.** Until this pass the socket was write-only above the
transport: `ready`, `ping`/`pong` and errors came back and nothing else was
acted on. It now has one inbound media path.

| Enters the device | When | Contains | Refused unless |
|---|---|---|---|
| `config` frame on track 4 | Once, when the destination opens a return feed | A codec string, sample rate and channel count | — it is read whether or not the feature is on, and a codec that is not `pcm-s16le` at 16 kHz mono latches every later packet on that track off |
| `audio` frames on track 4 | While someone at the destination is speaking | Linear PCM, 16 kHz, mono, signed 16-bit little-endian, 40 ms per packet | **Return audio** is on in Settings, the declared format was understood, the length is even, non-zero and under two seconds, and fewer than 12 packets are already queued |

Nothing inbound can change a setting, a destination, or a key: the only frames
the phone acts on are `ready`, `pong`, and track-4 audio, and a track-4 frame
reaches nothing but an audio buffer. There is no decoder in that path — PCM was
chosen over Opus precisely so that a hostile payload has nowhere to go but the
speaker.

There is no analytics SDK, no crash reporter, no remote configuration, and no
network call to anywhere the operator did not type in. The only other
outbound traffic the binary can produce is `SFSafariViewController` opening the
privacy-policy or support URL when the operator taps it.

---

## 3. Device capability matrix

The app **never** consults a model-name table. Everything below is read at
runtime from `AVCaptureMultiCamSession.isMultiCamSupported`,
`AVCaptureDevice.DiscoverySession.supportedMultiCamDeviceSets`, and
`VTCopySupportedPropertyDictionaryForEncoder` at 1920×1080
(`Capture/DeviceCapability.swift`). The table is what that detection is
*expected* to report; the app believes the device, not the table.

| Class | Multi-cam | Wide + ultra-wide together | Stereo | Notes |
|---|---|---|---|---|
| A11 and earlier (iPhone X and older) | No | No | No | `UIRequiredDeviceCapabilities` does not exclude these; they run, in mono |
| A12–A13, single or dual rear camera | Yes | Only if both lenses exist | Depends | An iPhone XR has one rear camera and cannot pair anything |
| A12+, wide + ultra-wide present (11, 12, 13, 14, 15, 16, and Pro variants) | Yes | Yes | **Yes** | The intended configuration |
| Any iPad | — | — | — | Not shipped. `TARGETED_DEVICE_FAMILY = 1` |
| Simulator | No cameras | No | No | Everything but capture is testable; capture is not |

When the pair is unavailable, `stereoUnavailableReason` returns the specific
reason and the UI says it in words rather than disabling a control with no
explanation. Mono is a first-class mode, not a degraded one.

**Encoder support** is detected, not assumed. Every A12+ device has hardware
H.264 and HEVC, but the check is cheap and the alternative is a stream that
encodes in software at 4 fps and looks like a network problem.

**Hardware assumptions that have not been verified on a device.** Nobody has run
this pass's changes on physical hardware. Specifically unverified: that the
thermal fallback path produces a clean re-handshake mid-broadcast; that two
1080p30 encodes plus Wi-Fi sustain below `.serious` on a non-Pro phone; and the
real-world stereo pairing tolerance between the two outputs. [`IOS_TESTING.md`](IOS_TESTING.md)
is the plan for closing that gap.

---

## 4. Streaming protocol and codec matrix

One contribution transport is implemented: **AVR Live**, length-framed TCP,
defined in [`LIVE.md`](LIVE.md), with the phone's half in
`Net/WireProtocol.swift` and the server's in `src/live/protocol.js`. The two are
pinned together by `test/live-protocol.test.js`.

```
offset  size  field
0       4     length      bytes following this field (= 16 + payload)
4       1     type        hello 1, ready 2, config 3, video 4, audio 5,
                          stats 6, bye 7, ping 8, pong 9
5       1     track       left 0, right 1, audio 2, packed 3,
                          talkback 4 — the only track that travels
                          towards the phone
6       2     flags       keyframe 1<<0, discontinuity 1<<1
8       8     timestamp   capture time, microseconds
16      4     sequence
20      N     payload
```

Little-endian throughout.

| Codec | Container on the wire | Encode | Browser decode | Default |
|---|---|---|---|---|
| H.264 | AVCC length-prefixed NALUs, `avcC` in the `config` frame | Hardware, A12+ | Everywhere | **Yes** |
| HEVC | AVCC length-prefixed NALUs, `hvcC` in the `config` frame | Hardware, A12+ | Safari yes; Chrome and Firefox partial | No |
| AAC-LC | Bare access units, `AudioSpecificConfig` in the `config` frame | `AudioConverter`, any device | Everywhere | **Yes**, unless Sound is switched off |
| Linear PCM, 16 kHz mono (inbound only) | Bare signed 16-bit little-endian samples on track 4, 640 per packet | — | — | Played only with **Return audio** on |
| MV-HEVC | — | Not implemented | — | — |

Every audio access unit carries the `keyframe` flag. That is literally true —
every AAC frame is a sync sample — and it has to be set, because the relay's
late-joiner gate and its backpressure trim were both written for video and would
otherwise hold sound back or discard it.

**MV-HEVC is not implemented and the phrase does not appear in the UI.** The app
sends two ordinary single-view streams, one per eye, matched by timestamp at the
server. That is a correct way to deliver stereo and it is not multiview HEVC,
and calling it that in a store listing would be a false claim about a technical
capability. The user-facing vocabulary is fixed at **Standard**, **Stereo
Side-by-Side**, and **Spatial Recording** only where literally accurate.

| Setting | Values | Default |
|---|---|---|
| Quality | 720p (4 Mbps), 1080p (8 Mbps) | 1080p |
| Frame rate | 24–60 | 30 |
| Mode | Stereo Side-by-Side (both cameras), Standard (one) | Stereo Side-by-Side, if the hardware offers the pair. The status bar names the mode actually going out, which a thermal fallback can make the other one |
| Sound | On, Off | **On** — a broadcasting tool that goes out silent unless configured otherwise is a fault waiting to happen, and silence is the one fault nobody behind the camera can hear |
| Return audio | On, Off | **Off** — it is the only setting that makes the phone produce sound the operator did not record, and with no headset the microphone will send it straight back out |
| Projection | Flat, 180° dome, Fisheye | Flat |

Projection is **declared metadata for the viewer, not a transform**. The
built-in lenses are rectilinear; the other two settings exist for lens
attachments, and choosing one without the attachment produces a warped picture.
The UI says so. Nothing here is labelled "VR180", because ordinary rectilinear
stereo is not VR180.

---

## 5. Destination profile schema

Stored as a JSON array under `destinations.v1` in `UserDefaults`. **The key is
never in this record** — it lives in the Keychain under the profile's UUID, and
`DestinationStoreTests` asserts the serialised blob does not contain it.

```swift
struct DestinationProfile: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var name: String        // 1…60 chars, control characters stripped
    var transport: Transport   // "avr-live" — the only implemented case
    var host: String        // ≤253 chars; IPv4 literal, IPv6 literal, or hostname
    var port: Int           // 1…65535
    var createdAt: Date
    var updatedAt: Date
    var usesTLS: Bool          // refuse to connect without TLS
    var certificatePin: String?   // base64 SHA-256 of the server's certificate
}
```

| Field | Rule | Why |
|---|---|---|
| `name` | Non-empty, ≤60, sanitised | It is displayed; a control character in a label is either a mistake or an attempt |
| `host` | Valid IPv4 / IPv6 / hostname. Leading-zero IPv4 parts rejected | See §6 |
| `port` | 1…65535 | |
| `usesTLS` | Boolean; when set the connection fails rather than falling back | A silent downgrade is worse than a refusal |
| `certificatePin` | 32 base64 bytes or absent; a pin that will not decode fails every connection rather than silently demoting to the trust store | A private address can never have a CA-issued certificate, so the pin replaces the trust store entirely. See §6 |
| key | 8…512 chars, no whitespace, not in this struct | Some providers issue long signed tokens; 8 is the floor below which it is a typo |

**Import sources.** Four, and none of them writes anything without a
confirmation screen that shows the address, the transport, whether it is local
or public, and whether a key came with it:

| Source | Carries a key? | Trust |
|---|---|---|
| `avr://pair?host=…&port=…&key=…` link | Yes | The operator opened it deliberately, but the page that served it is unknown — so it is a *candidate* |
| A QR code read with the camera | Yes | Same, and slightly less: a camera can be pointed at a code by somebody else. The confirmation sheet says "Scanned code" for exactly that reason |
| `.json` configuration file via the document picker | Yes | Same |
| UDP discovery on the local Wi-Fi | **No, by construction** | A responder on the Wi-Fi has proved nothing about itself. It may contribute an address; the operator types the key |

**The scanner has no parser.** `DestinationScannerView` decodes a string with
`AVCaptureMetadataOutput` and hands it to `DestinationImport.candidate(fromText:)` —
the same function a pasted link goes through, with the same validation and the
same confirmation sheet. Two things follow, and both are asserted in
`DestinationImportTests`: a scan and a paste of the same link produce identical
candidates, and rubbish from a camera is refused exactly as rubbish from the
paste field is. The decoded string is never logged, truncated or otherwise,
because it routinely carries a key.

`AVCaptureMetadataOutput` rather than Vision, deliberately. The barcode
detector hands back pixel buffers; the metadata output never surfaces an image
at all. A pixel buffer of a screen displaying a credential is a thing this app
would then be responsible for not keeping, and the cheapest way to hold that
responsibility is not to acquire it. The scanner also cannot run while a
broadcast is live — the destinations screen is disabled during one, and the
session is stopped on dismissal — because the encoder wants the same camera.

This is [IOS_BRIEF.md](IOS_BRIEF.md) §"Destination configuration": *"Support
import by QR code … A QR code may configure a destination; it must never unlock
paid native functionality."* It configures a destination and does nothing else.

**Interface policy is derived from the address, never from a setting.** Private,
link-local, loopback, CGNAT, and `.local` destinations get
`prohibitedInterfaceTypes = [.cellular]`, because sending a local address over
cellular reaches a stranger's network, not yours. Public hosts must be allowed
cellular, because that is the whole point of broadcasting from a field.

**"Test Connection" is reachability-only.** It opens a socket, confirms
something is listening, and closes it. It does not send the key — the button is
pressed while editing an address that may have been mistyped, and sending the
key would hand it to whatever answered at the wrong one.

---

## 6. Security and threat model

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Credential theft from an unencrypted backup or a filesystem dump | Keychain, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Excluded from iCloud Keychain and from backups restored onto another phone | A jailbroken, unlocked device with the app running |
| T2 | Credential theft from logs or a shared diagnostics export | `Redact.secret` / `.url` / `.endpoint`; the diagnostics export is hardware-only and is tested to contain no host, name, or key | None known |
| T3 | Malicious `avr://` link silently repointing the phone | Parse → validate → confirmation sheet → explicit tap. Never auto-applied | Operator confirms without reading |
| T4 | Hostile UDP responder posing as a server | Replies capped at 4 KB, parsed with the same validator as a link, and **cannot supply a key** | Operator manually types a real key into a rogue address they chose |
| T5 | Disguised loopback / SSRF-flavoured address (`0177.0.0.1`, `1.2.3.4.5`) | Leading-zero IPv4 parts rejected by hand *before* `inet_pton`, which on Darwin accepts them and reads them as decimal while most server-side parsers read them as octal. All-numeric final labels rejected as hostnames | |
| T6 | Local address leaked onto cellular | Address-derived `prohibitedInterfaceTypes` | |
| T7 | Key exposed in a URL the app itself constructs | The app constructs no such URL. `helloBody(key:)` takes the key as a parameter and never stores it as a property | |
| T8 | Traffic interception on the contribution link | TLS on the ingest socket. A public host validates against the system trust store; a private host — which no CA will ever issue for — presents a self-signed certificate whose base64 SHA-256 the pairing link pins, and the pin then *is* the trust decision. There is deliberately no "encrypted but trust anything" case | A destination the operator chose to leave cleartext, which is labelled as such wherever it is shown |
| T11 | A pin imported from a hostile page, pinning an attacker's certificate | The link goes through the same parse → validate → confirm path as everything else, and the sheet says whether the destination is pinned and to what | Operator confirms a destination they did not expect |
| T9 | Supply-chain compromise via a dependency | No third-party dependencies. Everything is a system framework | |
| T10 | Remote code / dormant behaviour | None. No remote configuration, no downloaded code, no feature flags, no build-time hidden modes | |
| T11 | Hostile destination abusing the new inbound path | The only inbound media the phone acts on is track-4 audio, and only with **Return audio** switched on. There is no decoder to attack: the payload is raw PCM copied into a fixed-size buffer after its length is checked for evenness, plausibility and queue depth. An oversized, odd-length or empty packet is counted and dropped, and the count is visible in Diagnostics | A destination that is trusted with the video can make noise out of the speaker while the operator is live. That is the feature |

The last row is a design commitment, not just an observation: there is no
reviewer detection, no IP allowlist, no special account, and no code path that
behaves differently during review. If that ever changes it is a 2.3.1 problem
and a 2.5.2 problem at the same time.

---

## 7. Privacy and data inventory

`PrivacyInfo.xcprivacy` declares `NSPrivacyTracking = false`, no tracking
domains, and **no collected data types**, because the app collects none.

| Data | Where it lives | Leaves the device? | Deletable in-app |
|---|---|---|---|
| Camera frames | Memory, and the encoder | Only to the configured destination, only while live | N/A — never written to disk |
| QR scanner frames | Never leave `AVCaptureMetadataOutput`; the app receives a decoded string, not an image | No | N/A — never written to disk |
| Microphone samples | Memory, and the AAC encoder | Only to the configured destination, only while live, and only with Sound on | N/A — never written to disk |
| Return audio received from the destination | Memory, and the playback queue — at most twelve 40 ms packets | Played out loud and discarded. Never written to disk, never re-encoded, never sent anywhere | N/A — nothing is retained |
| Stream keys | Keychain, this-device-only | Only in the `hello` frame to the configured destination | Yes |
| Destination profiles | `UserDefaults`, app container | No | Yes |
| Capture settings | `UserDefaults` | No | Yes |
| Rights acknowledgement (a version integer) | `UserDefaults` | No | Yes |
| Diagnostics export | Generated on demand, shared only where the operator sends it | Operator's choice | N/A |
| Location, contacts, photos, identifiers, advertising | Not accessed | — | — |

Required-reason APIs declared: `UserDefaults` (`CA92.1`), file timestamp
(`C617.1`), system boot time (`35F9.1`).

Settings → **Erase stored data** removes every profile, every Keychain item the
app owns, and withdraws the rights acknowledgement. There is no account, so
there is nothing server-side to delete and no 5.1.1(v) account-deletion
requirement.

---

## 8. Guideline conformance

| Guideline | Position |
|---|---|
| 1.1.4 (overtly sexual material) | The binary contains and displays none. It has no catalogue, no directory, no store, no default destination, and no content of its own |
| 1.2 (user-generated content) | Rights acknowledgement before the first broadcast; prohibited-content terms stated; operator-reporting is the destination platform's responsibility, and where the operator's destination is the sibling web product, that product has its own moderation and verification — see [`IDENTITY.md`](IDENTITY.md). **This is the app's weakest guideline; see risk C1** |
| 1.2, return audio | Return audio is a one-way monitor feed: sound in, nothing back, no text, no names, no list of who is there, no reply path, and off unless the operator switches it on. The app cannot tell whose voice it is playing. **Whether a reviewer reads it that way depends on the destination, not on the code — see risk H4** |
| 2.1 (completeness) | No placeholder UI, no stub screens, no unimplemented controls |
| 2.3 / 2.3.1 (accurate metadata, no hidden features) | `Transport` has exactly one case because exactly one transport is implemented. No hidden modes, no gestures, no remote configuration |
| 2.5.1 (public APIs only) | AVFoundation, VideoToolbox, AudioToolbox, CoreMedia, Network, Security, CryptoKit, SwiftUI. Nothing else |
| 2.5.2 (no downloaded code) | None |
| 2.5.14 (recording consent) | Gate before the first broadcast, versioned so new wording re-asks |
| 3.1 / 3.1.3(f) | No purchases of any kind in the binary |
| 4.8 (sign in with Apple) | No third-party sign-in, so not triggered |
| 5.1.1 (privacy) | Purpose strings are specific and name only what the hardware is used for; privacy manifest present; privacy-policy and support URLs are populated and the pages exist in [`public/legal/`](../public/legal/). **Both currently point at the `example.com` placeholder and must be repointed at the real domain before submission** |

---

## 9. Risk register

### Critical

*None outstanding. C1 was addressed in this pass; what it leaves behind is a
business decision rather than a defect, and is recorded below.*

**C1 — The surrounding product is not content-neutral on its face.** *(Addressed
— residual is commercial, not technical.)* The iOS binary always was neutral.
The repository around it was not: `server/deovr.js` implements the DeoVR/Play'a
feed format, the viewer is a VR video library, and
[`IDENTITY.md`](IDENTITY.md) describes creator age and ID verification — a
document that exists because adult platforms need it. Guideline 1.2 weighs the
*service*, not only the bundle.

What changed is that the two are now genuinely separate products rather than two
faces of one. Age and identity verification happens **only in the web product**,
in the creator's browser, and the capture app has no part in it: the phone never
handles a face, never calls a verification provider, and links to nothing. The
coupling is a single opaque string. A creator who wants to broadcast verifies in
the browser — an age check at signup, a document-and-selfie enrolment as a
creator, and a face check on each entry to the creator portal — and the browser
hands them a **destination link** whose key is a single-use, short-lived
**broadcast grant**. They scan it off the screen with the camera, or paste it,
into a destination like any other key. The app cannot tell a grant from a shared
key and does not try. Nothing in the binary knows a verification exists.

The app asks for that destination on first launch, in a sheet that says only
that a destination is needed and offers to do it later. It suggests nothing,
fills in nothing, contacts nothing, and what gets pasted goes through the same
parse → validate → confirm path as a tapped link. This is the only place the two
products touch, and it touches them the way any broadcasting tool touches any
server: an address and a key, typed in by the operator.

That is the whole of the technical answer, and it is deliberately not presented
as more than that. **If the business behind the destination is primarily an
adult-content service, none of this fixes 1.1.4**, and concealing it would be a
2.3.1 violation on top of the original problem. The honest options remain (a)
submit with a genuinely general-audience platform as the app's stated
destination and be able to demonstrate it to a reviewer, which is what
[`APP_STORE.md`](APP_STORE.md) prepares, or (b) accept that an adult-oriented
positioning is very unlikely to pass and distribute outside the App Store. It is
not a technical decision and no amount of engineering will make it one.

### High

**H1 — Contribution traffic is cleartext TCP.** *(Fixed.)* The ingest socket is
TLS, and a destination configured for it refuses to connect without it rather
than falling back. Because most destinations are bare private addresses that no
certificate authority will ever issue for, a pairing link may carry a pin of the
server's certificate, and that pin then replaces the trust store entirely. There
is no "encrypted but trust anything" setting, since one would make interception
undetectable while the UI said "Encrypted". See §6 T8 and
[`server/live/tls.js`](../server/live/tls.js). Residual: a destination the
operator deliberately leaves cleartext, which is labelled as such everywhere it
appears.

**H2 — Privacy-policy and support URLs are empty.** *(Fixed, with one thing left
to do.)* Both pages are written —
[`public/legal/privacy.html`](../public/legal/privacy.html) and
[`support.html`](../public/legal/support.html) — and `AVRPrivacyPolicyURL` and
`AVRSupportURL` point at them. **They point at `capture.example.com`**, which is
an RFC 2606 placeholder and not a real host. Substituting the real domain is a
one-line change in `Info.plist` and a deploy; submitting before it is made is
still a 5.1.1 rejection.

**H3 — No audio.** *(Fixed.)* An `AVCaptureAudioDataOutput` joins the multi-cam
session and an `AudioConverter` produces AAC-LC on track 2, described to the
browser by a synthesised `AudioSpecificConfig` and to FFmpeg by ADTS headers.
Sound is on by default, because a broadcast that goes out silent is the one
fault that cannot be heard from behind the camera — so the microphone prompt
appears the first time an operator goes live, which is what
`NSMicrophoneUsageDescription` is for and where a broadcasting tool should ask.
Switching Sound off detaches the input entirely rather than muting it: no
recording indicator, no entry under Settings › Privacy › Microphone, nothing
captured. See [`LIVE.md`](LIVE.md#the-audio-track).

**H4 — Return audio is talkback in the binary and viewer interaction in the
deployment.** *(New this pass. Implemented, and flagged rather than hidden.)*

The feature as built is the ordinary broadcast one. Every professional camera
channel has a return path — IFB, talkback, the director's line — and this is
that: the destination can send speech to the phone, 16 kHz mono PCM on its own
track, and the phone plays it. It is **off by default**. It is one-way; there is
no reply path, no text, no names, no roster, no indication of how many people
are at the other end. The app cannot tell whether the voice is a director, a
producer, or an automated cue, **and nothing in the protocol would let it find
out**. The status bar shows a "Return" indicator whenever it is open, so sound
the operator did not record is never a surprise, and Settings says in plain
words that it is one-way and that not every destination sends it.

That is an accurate description of the binary. It is not the whole picture, and
the brief requires the whole picture.

In *this* deployment the voice on track 4 is a paying viewer in a 1:1 private
session, because that is what the web product was built to sell (see
[`MONETISATION.md`](MONETISATION.md)). A reviewer who is shown the web product,
or who reads the marketing, can reasonably characterise the pair as **viewer
interaction with the broadcaster** — which is the thing
[`IOS_BRIEF.md`](IOS_BRIEF.md)'s "Do not add" list excludes, alongside comments
and messaging, and which under 1.1.4 and 1.2 is materially worse when the
platform is adult-oriented. The fact that the binary cannot distinguish a
director from a customer is a genuine technical property, not a defence: it is
exactly the argument a reviewer is entitled to disbelieve if the service around
the app makes the answer obvious.

So this is recorded as an **open High risk**, not a solved problem:

- It does not change the C1 calculus. If the destination business is primarily
  an adult service, return audio makes the 1.1.4 problem worse and nothing in
  the implementation repairs that.
- If the submission goes forward on the general-audience positioning that
  [`APP_STORE.md`](APP_STORE.md) prepares, the review environment must
  demonstrate return audio *as talkback* — an operator on a phone and a director
  at a desk — because a demonstration is the only thing that makes the neutral
  reading the natural one.
- The cheapest way to remove the risk entirely is to remove the feature: it is
  self-contained (`Audio/ReturnAudioPlayer.swift`, `Audio/ReturnAudioBuffer.swift`,
  one `IngestClient` case, one setting), and deleting it costs the phone nothing
  it had before this pass. That is a product call, and it is the user's to make.

### Medium

**M1 — Nothing in this pass has run on physical hardware.** Stereo capture,
thermal behaviour, and reconnection are all unexercised outside the simulator.
Return audio joins them, and it is the most likely of the lot to behave
differently on a phone: the playback session shares `AVAudioSession` with the
capture session, and whether starting playback mid-broadcast disturbs the
microphone input is a question only a device can answer.

**M2 — Backend dependency.** The app is useless without a reachable AVR Live
server. A reviewer given no working destination sees an app that cannot
demonstrate its function — which is why the review environment in
[`APP_STORE.md`](APP_STORE.md) must be live, public, and reachable over
cellular, not a LAN demo.

**M3 — Thermal fallback is untested under real load** and latches for the rest
of the broadcast by design. If the latch triggers too eagerly, operators lose
stereo for a whole session over a transient spike.

### Low

**L1 — No local recording**, so a dropped connection loses the take.
**L2 — One transport.** Correct today (see §10), but it limits the addressable
use cases to servers running this project's software.
**L3 — Discovery is UDP broadcast**, which does not cross subnets; on segmented
venue Wi-Fi the operator must type the address.

---

## 10. Decisions taken, and what they cost

**One `Transport` case.** A picker offering SRT, RTMP, and WHIP that cannot
connect is a dormant feature under 2.3.1 and a support burden shaped like a
product. The field exists in the schema so adding a case is additive; the case
gets added when the code behind it does.

**Reconnection only after the session has been live once.** A first-attempt
failure is a wrong address, a wrong key, or a server that is not running, and
retrying fixes none of them — it just delays the error message. Backoff is
`min(16, 2^(n-1))` seconds, capped at six attempts, because a phone that retries
forever is worse than one that admits it is off air.

**Thermal fallback latches.** Oscillating between one eye and two mid-broadcast
is worse for a viewer than staying mono, and the declared layout changed, so the
fallback goes through a full re-handshake. It needs two consecutive `.critical`
windows, not one.

**The status bar names the mode being sent, not the mode that was selected.**
The notice that announces a fallback is dismissible and the Settings row goes on
reading **Stereo Side-by-Side**, so before this the only lasting evidence that
one eye had been dropped was on the Diagnostics screen. The bar now carries the
effective mode beside the destination, in orange when it is not what was asked
for. `BroadcastController.thermalMonoOverride` is `@Published` for this reason —
a latch nothing observes would leave the badge stale after the notice was
dismissed.

**Capture interruptions do not end the broadcast.** A phone call or a control
centre camera grab is not an error and most of them end by themselves within
seconds. They are surfaced in the status bar and the pipeline is left standing.

**Discovery cannot supply a key.** Accepting one would mean anything on the café
Wi-Fi could hand the phone a complete working destination.

**The app does not know who is watching, and the binary did not change when the
web product learned to.** The web product now lets a creator open a broadcast
for one named viewer who is waiting. The obvious implementation prints a viewer
id into the destination link, and the app would then be carrying — and
displaying, and storing — an identifier for an audience member on a viewing
platform it is not part of. That is the shape of thing the "no dormant
features" line in [`IOS_BRIEF.md`](IOS_BRIEF.md) exists to catch, and 2.3.1 asks
about. Instead the pairing is bound to the grant, server-side: the app scans the
same `avr://pair?host=…&port=…&key=…` it always has and nothing about the
feature is expressed in the binary. See [`LIVE.md`](LIVE.md).

**The web product grew a paid layer and the binary did not change at all.** The
site now has credits, per-minute creator pricing, viewer and creator profiles,
and a "Live Creators" row. None of it is reachable from the app and none of it
is represented in it: the app holds no balance, shows no price, names no
creator, and offers no purchase of any kind — so there is no 3.1.1 in-app
purchase question to answer, because there is nothing to buy. The one place the
two products touch is the streaming setup confirmation, which is a creator
pressing a button *in the browser* to say their stream arrived; the phone's side
of that is the broadcast it was already sending. The check kinds are named
`standard` and `spatial` server-side to stay inside the vocabulary "One
vocabulary across all three products" in [`LIVE.md`](LIVE.md) fixes, even though
the web UI says 2D and 3D to viewers.

**Return audio is PCM, and there is no echo canceller.** Two decisions, both
paid for in something.

Linear PCM at 16 kHz costs 256 kbit/s downstream, which is roughly a hundred
times what Opus would need for speech. It was chosen anyway, because the
alternative is a decoder: a third-party codec is a dependency and an attack
surface, and `AudioToolbox`'s own Opus support would still mean parsing
attacker-supplied frames on the phone. With PCM the length check *is* the parse.
A 40 ms packet is 1280 bytes and the whole feed is inaudible against a 8 Mbit/s
video uplink in the other direction.

No echo cancellation, because the only way to get it on iOS is
`setVoiceProcessingEnabled(true)` on the *capture* input — which would put every
broadcast through a voice-processing chain tuned for telephony, whether or not
return audio is on. Degrading the recorded sound of every broadcast to solve a
problem that headphones solve completely is the wrong trade for a broadcasting
tool. The UI says to use a headset, and `.defaultToSpeaker` only decides where
sound goes when there is no headset attached.

**Return audio plays at most half a second behind, and drops the rest.** A
return feed that queues is a return feed that ends up a conversation behind. The
bound is twelve 40 ms packets; past that the newest packet is discarded and
counted, and the count is on the Diagnostics screen so "they could not hear me"
has an answer. Nothing about the feature retries, buffers to disk, or catches up.

The business-model risk this layer creates is real and belongs to the web
product, not to the binary: see the closing section of
[`MONETISATION.md`](MONETISATION.md). It is recorded here because App Review
judges the whole product, and the defence is that the app is genuinely a
content-neutral capture tool — which is only true for as long as nothing from
that layer is allowed into it.

---

## 11. Next three actions

**1. Replace `capture.example.com` with the real domain, and stand up the
general-audience review environment.** The pages exist; the host does not.
Nothing else on this list matters if the submission cannot clear 5.1.1 and
cannot be demonstrated. Checklist in [`APP_STORE.md`](APP_STORE.md). Blocked on
a hosting decision, not on code.

**2. Run [`IOS_TESTING.md`](IOS_TESTING.md) on a physical A12+ device with both
rear cameras.** Every stereo, thermal, and reconnection claim in this document
is currently a claim about code, not about a phone — and sound has now joined
them. The audio path is covered by unit tests against a synthetic buffer list,
which proves the encoder and the timestamps, and proves nothing about what a
real microphone sounds like alongside a two-camera session, under thermal
pressure, or across a phone call. This is the cheapest way to find out which
claims are wrong. Return audio now needs the same treatment and one test of its
own: switch it on mid-broadcast and confirm the capture input keeps delivering
buffers — the two share an `AVAudioSession` and nothing outside a device proves
they coexist.

**3. Local recording via `AVAssetWriter`** (risk L1), as insurance against a
dropped connection: today a broadcast that loses the link loses the take
outright, which is the failure an operator in the field can do least about.

Then **a second transport** — SRT first, since it is the one that makes the app
useful against infrastructure this project does not own.
