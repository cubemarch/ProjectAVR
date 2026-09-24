# ProjectAVR — working notes

Three tiers: contribution encode on an iPhone, transcode and packaging on a
server, dual delivery over a WebSocket relay and HLS. `server/` and `src/` are
Node and browser JavaScript; `ios/` is a self-contained Swift app.

## Before changing anything under `ios/`

Read [`docs/IOS_BRIEF.md`](docs/IOS_BRIEF.md). It is the standing product and
App Store compliance specification for the capture app, and several of its
constraints are load-bearing rather than stylistic:

- The iOS binary is a **content-neutral professional broadcasting tool**. No
  feed, catalogue, chat, purchases, destination-side playback, adult
  terminology, or links to any viewing platform. See the "Do not add" list.
- **No reviewer-specific behaviour of any kind** — no IP allowlists, hidden
  modes, dormant features or remote configuration that changes what the app is.
- **Secrets go in the Keychain**, never `UserDefaults`, never a log line, never
  a URL the app generates.
- **Imported configuration is validated and confirmed** before it is saved or
  connected to.
- Terminology is **Standard** / **Stereo Side-by-Side** / **Spatial Recording**.
  Do not write "MV-HEVC" or "VR180" unless the code verifiably emits one.

[`docs/IOS_AUDIT.md`](docs/IOS_AUDIT.md) records current conformance, open risks
and the next actions. [`docs/APP_STORE.md`](docs/APP_STORE.md) holds the
submission material.

## Building and testing

```sh
npm test                                   # server and web, node --test
cd ios && xcodegen generate                # regenerate the (gitignored) project
xcodebuild -project ios/AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Capture cannot be exercised in the simulator — there are no cameras. Anything
touching `AVCaptureSession` needs a physical device; see
[`docs/IOS_TESTING.md`](docs/IOS_TESTING.md).

## Other docs

| | |
| --- | --- |
| [`docs/LIVE.md`](docs/LIVE.md) | The live pipeline end to end |
| [`docs/IDENTITY.md`](docs/IDENTITY.md) | Age assurance, creator enrolment, the portal face check, and how the pasteable destination URL is issued (web product only — the iOS app has no part in any of it) |
| [`docs/MONETISATION.md`](docs/MONETISATION.md) | Credits and the ledger, creator pricing, profiles, the stream setup checks and the 3D gate (web product only — the iOS app holds no balance and shows no price) |
| [`ios/README.md`](ios/README.md) | Building the app, and the traps that have already cost a day |
