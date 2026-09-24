# AVR Capture

The iPhone end of ProjectAVR Live. Runs both rear cameras at once, crops them to
a shared field of view, encodes one hardware H.264/HEVC stream per eye, and
pushes them to a ProjectAVR server over TCP.

See [`docs/LIVE.md`](../docs/LIVE.md) for the whole pipeline. This file is about
building and running the app. The rest of the iOS documentation:

| | |
| --- | --- |
| [`docs/IOS_BRIEF.md`](../docs/IOS_BRIEF.md) | The requirements this app is built against |
| [`docs/IOS_AUDIT.md`](../docs/IOS_AUDIT.md) | Architecture, capability and codec matrices, destination schema, threat model, privacy inventory, and the ranked risk register |
| [`docs/IOS_TESTING.md`](../docs/IOS_TESTING.md) | The physical-device test plan. Everything the simulator cannot check |
| [`docs/APP_STORE.md`](../docs/APP_STORE.md) | Submission checklist, listing drafts, and Notes for Review |

---

## Requirements

| | |
| --- | --- |
| Device | iPhone XS or later (A12+). Multi-camera capture does not exist before that, and **not at all in the simulator** — there are no cameras to open. |
| iOS | 17.0 |
| Xcode | 15 or later |

The app has **no third-party dependencies**. AVFoundation, VideoToolbox, Network
and SwiftUI all ship with the system.

---

## Building

### With XcodeGen

```sh
brew install xcodegen
cd ios
cp Local.xcconfig.example Local.xcconfig   # then put your team id in it
xcodegen generate
open AVRCapture.xcodeproj
```

Find your team id with:

```sh
security find-certificate -c "Apple Development" -p \
  | openssl x509 -noout -subject | tr ',' '\n' | grep OU=
```

A free Apple ID works — add it in *Xcode › Settings › Accounts* and it becomes a
Personal Team. Builds signed that way expire after seven days.

Signing deliberately lives in `Local.xcconfig` rather than in `project.yml`.
`DEVELOPMENT_TEAM` is a per-developer value, and anything in `project.yml` is
regenerated — so a team selected in Xcode's Signing pane is wiped by the next
`xcodegen generate`, and the build starts failing again with nothing obvious to
point at. An xcconfig is read at build time and survives regeneration.

The `.xcodeproj` is generated, not committed: an Xcode project file is a
merge-hostile blob full of absolute paths, and [`project.yml`](project.yml) says
the same thing in thirty readable lines.

The app icon and the launch screen's logo are generated too, by
[`Tools/make-launch-logo.swift`](Tools/make-launch-logo.swift), from the same
`camera.aperture` system symbol the startup screen shows. They are committed, so
this only needs re-running after a change of symbol, weight or size:

```sh
swift ios/Tools/make-launch-logo.swift
```

### Running the tests

```sh
cd ios
xcodebuild -project AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

71 tests covering destination validation, import parsing and rejection, log
redaction, the destination store's split between profile and credential, the
Keychain wrapper, and the gates in front of going live. The capture graph itself
needs cameras and is covered by the manual plan in
[`docs/IOS_TESTING.md`](../docs/IOS_TESTING.md) instead.

**Do not add `CODE_SIGNING_ALLOWED=NO`.** It is a reasonable habit for a build
on a machine with no signing identity, and it breaks the tests in a way that
looks like a bug in the app: an unsigned bundle in the simulator gets no
`application-identifier` entitlement, so every `SecItem` call returns `-34018`
(`errSecMissingEntitlement`) and eighteen keychain and store tests fail. The
same flag is fine for a plain `build`.

Console noise during the run — `capture session runtime error … code -11800`
and a missing `eligibility.plist` — is the simulator having no cameras. It is
expected and does not fail anything.

### Without XcodeGen

If you would rather not install another tool, the project is small enough to
recreate by hand in about two minutes:

1. **File › New › Project › iOS › App.** Name it `AVRCapture`, interface
   SwiftUI, language Swift. Save it inside `ios/`.
2. Delete the `ContentView.swift`, `AVRCaptureApp.swift` and `Assets.xcassets`
   Xcode generated. This directory has its own asset catalog with the app icon
   and the launch screen's logo in it, and two catalogs in one target is a build
   error.
3. Drag the `AVRCapture` folder from this directory into the project navigator.
   Choose **Create groups**, and tick the `AVRCapture` target.
4. In *Build Settings*, set **Info.plist File** to `AVRCapture/Info.plist` and
   **Generate Info.plist File** to `No`. The bundled plist carries the camera
   and local-network usage strings, and a generated one will not.
5. Set the deployment target to **iOS 17.0** and device family to **iPhone**.
6. Set your development team.

---

## Pairing with a server

Start the server (`npm start`) and read the banner:

```
  Live ingest  tcp://192.168.1.110:8081  (iPhone capture app)
  Stream key   7f3a9c21e04b8d56
```

Then either:

- **Discovery** — *Settings › Find a server › Search the network*. A UDP probe
  finds every ProjectAVR on the subnet. It returns an address but deliberately
  **never the stream key**; discovery tells you a door exists, pairing gives you
  the key.
- **Pairing link** — `GET /api/live/pairing` (creator role) returns an
  `avr://pair?host=…&port=…&key=…` URL that fills in everything at once. Paste it
  into the field under the discovery list, or open it on the device.
- **By hand** — type the address, port and key.

### If the app crashes on launch, or shows a black screen

Almost always the `Info.plist`. Check the one that actually shipped, not the one
in the repo:

```sh
/usr/libexec/PlistBuddy -c "Print :NSCameraUsageDescription" \
  ~/Library/Developer/Xcode/DerivedData/AVRCapture-*/Build/Products/Debug-iphoneos/AVRCapture.app/Info.plist
```

- **Missing `NSCameraUsageDescription`** → the system kills the app the instant
  it asks for the camera. No prompt, no catchable error; it reads as a launch
  crash.
- **Missing `UILaunchScreen`** → iOS runs the app in a legacy compatibility
  mode, letterboxed to an older screen size, which on a modern iPhone looks like
  a blank screen rather than a layout bug.

If either is absent, the target is using a generated plist instead of the
checked-in one. Set **Info.plist File** to `AVRCapture/Info.plist` and
**Generate Info.plist File** to `No`, and make sure `project.yml` has no `info:`
block — in XcodeGen that key means *generate a plist at this path*, and it will
overwrite the real one with a near-empty default.

### If the phone's viewfinder is black

`AVCaptureVideoPreviewLayer` has two ways to be attached to a session, and a
multi-cam session only accepts one of them. Setting `layer.session` asks the
session to build the connection itself, which `AVCaptureMultiCamSession` will
not do — every connection in a multi-cam session is made by hand. The layer must
instead be told which session it belongs to *without* a connection:

```swift
layer.setSessionWithNoConnection(session)                       // then, and only then
session.addConnection(AVCaptureConnection(inputPort: port, videoPreviewLayer: layer))
```

Miss the first line and there is no error and no picture. This is the same class
of trap as the missing right eye below, and it cost the same afternoon.

The app now reports the failure rather than showing a black rectangle: the
handshake carries `previewConnected`, which the server log prints and warns
about, and a failed attach puts a sentence on the phone's screen.

### If the stream is live but both eyes show the same camera

Run the track watcher while broadcasting:

```sh
python3 -u test/watch-live-tracks.py
```

If `left` climbs and `right` stays at zero, the ultra-wide is not reaching the
encoder. The app now says so on screen too, naming which stage dropped it.

Two traps, both of which caused this once already:

**`AVCaptureDataOutputSynchronizer` does not pair two cameras.** It is built for
several outputs of *different kinds* on one camera — video plus depth, say — and
with two video data outputs on two cameras it hands back `nil` for the
non-master output on every single callback. The wide camera then streams
perfectly while the ultra-wide is silently dropped, and nothing errors. It is
gone from this codebase; the pairing is done by hand in
`StereoCaptureSession`'s delegate.

**Pairing has to buffer both sides.** The cameras interleave as wide(t0),
ultra(t0), wide(t1), ultra(t1), so a scheme that holds only the ultra-wide and
emits when the wide arrives is always comparing a frame-interval-stale buffer
against a half-frame tolerance, and nothing ever pairs. Whichever camera arrives
second must be the one that completes the pair.

The handshake carries a `capture` block for exactly this: the server log prints
`buffers=<wide>/<ultra>`, `pairs=`, and `closestSkew=` on every connect, which
separates "the camera is not producing frames" from "the frames are not being
paired" without guessing.

### If one eye is darker, or warmer, than the other

*Settings › Lens matching* should be on; it is by default. It holds the
ultra-wide to the wide camera's exposure and white balance, and compensates for
the aperture difference between the two lenses.

What it cannot compensate for is the part nobody publishes: lens transmission
and sensor sensitivity also differ between the two modules, and the residual is
per-model — on the phones this has run on it is larger than the aperture
difference, because the ultra-wide's pixels are smaller as well. **Right eye
trim** is that residual, in stops, and it goes up to +4 for that reason. Set it
once by eye against a flat, evenly lit surface; it persists, and it can be moved
while live.

If the trim stops making a difference, the ultra-wide has run out of gain. Three
things then happen in order, and the app says which:

1. **ISO first.** Noise in one eye fuses; motion blur in one eye does not.
2. **Then exposure time**, up to one frame interval and no further — a longer
   exposure makes the camera drop its frame rate, and a right eye at half the
   left eye's rate is worse than a dark one. Indoors there is usually no
   headroom here at all.
3. **Then the left eye comes down to meet the right**, by biasing the wide
   camera's auto-exposure target (never more than three stops). The shot gets
   darker, both eyes equally, which is the point: a matched dim pair is
   watchable and a mismatched bright one is not. The app posts *"Left eye pulled
   down N stops"* when this is happening, so the dimming is not a mystery.

When even that is not enough, the notice reads *"Eyes are N stops apart"* and
the trim genuinely cannot fix it — the scene is too dark for the ultra-wide.

### If connecting fails immediately

iOS blocks LAN access until the user grants it, and there is no API to request
that permission — the prompt appears on the first local connection attempt. If
it was ever declined, connections fail with `EPERM` and **no prompt is shown
again**, which looks exactly like the server being down.
`IngestClient.describe(_:)` translates that case into a sentence pointing at
*Settings › Privacy & Security › Local Network*.

---

## How it fits together

```
StereoCaptureSession ──▶ PixelRectifier ──▶ VideoEncoder ──▶ IngestClient
  AVCaptureMultiCam        crop to the        VideoToolbox      TCP, 20-byte
  two cameras, paired      narrower lens'     one per eye       framed protocol
  by timestamp by hand     field of view
        │
        ├── LensMatcher: hold the ultra-wide to the wide camera's exposure
        │
        └── AVCaptureAudioDataOutput ──▶ AudioEncoder ──▶ IngestClient
              attached only with           AudioConverter    track 2
              Sound on, own queue          to AAC-LC
```

`BroadcastController` owns all of it and is the only thing the UI talks to.

A few decisions worth knowing before changing anything:

- **The two eyes are cropped to a common field of view, not resized to it.** The
  ultra-wide sees far more than the wide, and the crop factor is a ratio of
  *tangents*, not of degrees — cropping 120° down to 73° means keeping 43% of the
  width, not 61%. `PixelRectifier` does this with `VTPixelTransferSession` and a
  clean aperture, so it costs no CPU.
- **Only the wide camera's auto-exposure is allowed to run.** Two cameras each
  hunting on their own schedule do not merely start apart, they drift apart, and
  a stereo pair whose eyes disagree about brightness reads as fatigue rather
  than as an obvious fault. `LensMatcher` copies the wide camera's exposure and
  white balance onto the ultra-wide four times a second. Two details make it a
  match rather than a coincidence: ISO is scaled by the square of the aperture
  ratio (f/2.2 against f/1.78 is about 1.5x the light), and white balance goes
  via temperature and tint because raw channel gains are defined against one
  sensor's colour filters and mean something different on the other.
- **Matching is closed-loop, and the loop runs backwards when it has to.** If
  the ultra-wide cannot be raised far enough, the wide camera's exposure target
  is biased *down* until it can. That feedback path is damped on purpose — it
  applies 35% of the correction per tick, because the wide's auto-exposure takes
  a few hundred milliseconds to respond and re-applying the full error four
  times a second would overshoot and hunt. Release is slower still, and only
  after two seconds clean, since releasing re-creates the shortfall that caused
  the bias.
- **Both video encoders share one output queue**, so the eyes reach the socket
  in a deterministic order rather than racing each other frame by frame. Sound
  has its own queue, because `AVCaptureAudioDataOutput` delivers on its own
  schedule and putting it behind two 60 fps video callbacks would add latency to
  the one track that cannot absorb any.
- **Sound is off or it is absent — never muted.** With the Sound switch off the
  app attaches no audio input to the session, so iOS never shows a recording
  indicator, the app never appears under Settings › Privacy › Microphone, and
  the permission is never requested. Muting a live input would look identical to
  the operator and be completely different to the person in front of the camera.
- **Audio timestamps are counted, not measured.** An AAC-LC access unit is
  exactly 1024 frames, so the encoder advances its clock by the frames it has
  consumed from an anchor taken at the first buffer, rather than by when a
  buffer happened to arrive. Drift of more than 60 ms against the capture clock
  re-anchors and flags a discontinuity. Deriving the timestamps from arrival
  time instead is the classic way to get audio that is perfectly fine for a
  minute and a second and a half out after twenty.
- **The `AudioSpecificConfig` is synthesised, not read from the encoder.**
  `AudioConverter`'s magic cookie on Apple platforms is a nested MPEG-4
  elementary-stream descriptor, not the two bytes a decoder wants. Parsing it
  wrongly produces a plausible blob that configures a decoder into noise, so
  `AudioSpecificConfig.swift` builds the bits from the sample rate and channel
  count and is tested against known vectors.
- **`handle(_:)` runs on the capture queue** and reads a set of
  `nonisolated(unsafe)` mirrors rather than hopping to the main actor 60 times a
  second. They are published before the frame callback is installed and
  withdrawn — with a synchronous hop onto the capture queue — before the
  encoders are torn down.
- **Parameter sets are prepended to every keyframe**, not sent once, so a viewer
  joining mid-broadcast can decode from the next keyframe.
- **Backpressure is handled by dropping non-keyframes**, never keyframes: above
  512 KB in flight the client sheds P-frames, and only a sustained 2 MB backlog
  drops anything a decoder needs.

---

## What this does not do

Stated plainly, because each of these looks like an oversight otherwise:

- **No audio mixing, monitoring or metering.** There is one microphone input,
  encoded and sent; nothing mixes it, no level meter shows it, and there is no
  way to listen to it on the phone. The receiving page is the monitor.
- **No on-device side-by-side packing.** The protocol has `TRACK.PACKED` and the
  browser monitor understands it, but the app always sends separate eyes. The
  server composites.
- **No vertical-offset rectification and no distortion correction.** The crop to
  a common field of view is the whole of the geometric correction.
- **Lens matching is a control match, not a colour calibration.** The two
  cameras are driven to the same exposure and the same white point, which is
  enough to stop the eyes disagreeing. It does not correct the difference in the
  sensors' actual colour response — that needs a per-model profile measured
  against a chart, which this app has no way to produce. The residual is left to
  a manual trim in stops.
- **The eye order default is a guess.** Which physical lens is the left eye
  depends on the model *and* on which way the phone is turned. `swapEyes` is
  persisted for exactly this reason. Check it through a headset before a real
  shoot — reversed eyes invert the depth of the scene and read as mildly
  uncomfortable rather than obviously broken.
- **Only lightly run on real hardware.** Capture, encode, ingest and the
  browser monitor have been exercised end to end on an iPhone 16 Pro Max against
  a local server. Nothing beyond that is proven: no long broadcast, no thermal
  soak, no headset check of the stereo geometry, and no device other than that
  one. The destination, reconnection, thermal and interruption work added since
  then has **only** been run in the simulator and under the unit tests —
  [`docs/IOS_TESTING.md`](../docs/IOS_TESTING.md) is the plan for closing that
  gap and has not been run.
- **Swift 6 strict concurrency is not clean.** The target is pinned to Swift 5
  language mode, where it compiles without warnings. Under
  `-strict-concurrency=complete` it produces about fifty warnings, nearly all of
  them AVFoundation types that are not yet `Sendable`.
