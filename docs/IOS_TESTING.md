# Physical-device test plan

Written for whoever has an A12-or-later iPhone with two rear cameras and an
hour. Everything here needs hardware — the simulator has no cameras, so the
capture graph, the thermal policy, and the reconnection path are all untested by
the automated suite.

The automated tests are the other half and they run in seconds:

```sh
cd ios
xcodebuild -project AVRCapture.xcodeproj -scheme AVRCapture \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

**Do not add `CODE_SIGNING_ALLOWED=NO`.** An unsigned simulator bundle has no
`application-identifier` entitlement, every `SecItem` call returns `-34018`, and
eighteen tests fail in a way that looks like an app bug.

---

## What you need

- An iPhone 11 or later (A12+, wide + ultra-wide). An XR or SE will run the app
  but cannot do stereo, which is itself worth one test — see T2.
- A machine running `npm start`, on the same Wi-Fi.
- A browser for the viewer.
- Optional but valuable: a second phone or a stopwatch, a tape measure,
  something at a known distance to check convergence against, and a metronome —
  a steady, visible beat is the only practical way to judge whether sound and
  picture are drifting apart (T12).

Record the device model, iOS version, and app build for every run. A result
without them is not reproducible.

---

## T1 — First launch, cold

1. Delete the app if it is installed. Install and launch.
2. **Expect:** the camera permission prompt, showing the string *"AVR Capture
   uses the camera to record and broadcast live video. On devices that support
   it, both rear cameras are used together to produce a stereoscopic picture."*
3. Allow. **Expect:** a live viewfinder within about two seconds, status `idle`,
   and no destination configured.
4. Tap the broadcast button. **Expect:** it refuses with a message naming the
   missing destination — *not* a crash, and not a silent no-op.

**Fails if:** the permission string mentions any other product; the viewfinder
stays black (see `ios/README.md` troubleshooting); the app asks for the local
network before you have opened the Destinations screen.

---

## T2 — Capability detection is honest

1. Settings → About → **Diagnostics**.
2. **Expect:** every physical rear camera listed with its real device type, and
   a **Simultaneous combinations** section listing at least
   `Back Wide + Back Ultra Wide` on a capable device.
3. On a single-rear-camera device (XR, SE): **expect** the combinations list to
   be empty, the Mode control to explain *why* stereo is unavailable in words,
   and mono to work normally.
4. Tap the share button and send the export to yourself.

**Fails if:** the export contains a destination name, a host, or a key — it must
be hardware-only. `BroadcastLifecycleTests.testCapabilityReportIsHardwareOnly`
asserts this, but confirm it on the real export too.

---

## T3 — Destination handling and the confirmation gate

1. Destinations → **Add manually**. Enter the host and port from the server
   banner and the stream key. Save.
2. **Test Connection.** Expect success, and expect the server log to show a
   connection that **did not** contain a stream key — the test is
   reachability-only.
3. Try to save each of these and confirm each is rejected with a specific
   message, not a generic one:
   - `0177.0.0.1` — octal-looking loopback
   - `1.2.3.4.5` — five dotted parts
   - `999.1.1.1`
   - port `0` and port `70000`
   - a six-character key
4. **Paste a link.** Copy `avr://pair?host=…&port=…&key=…` from the server
   banner into Safari and open it.
   **Expect:** a confirmation sheet showing Address, Protocol, Network
   (Local/Public), whether a stream key came with it, and Source. **Expect
   nothing to be saved until you tap the confirm button.** Cancel, and confirm
   the destination list is unchanged.
5. **Scan a code.** In the creator portal, press Create a destination link and
   leave the QR code on screen. In the app: Destinations → **Scan a code**.
   - First run expects a camera permission prompt raised *at this point*, not
     earlier. Allow it.
   - Point the phone at the browser. **Expect** the same confirmation sheet as
     step 4, with Source reading **Scanned code**, and **expect nothing saved
     until you tap the confirm button**.
   - Cancel out of the scanner without scanning. Return to the viewfinder and
     start a broadcast. **Expect** the camera to work — a scanner that did not
     release the session takes the encoder's camera with it.
   - Scan something that is not a destination link (any QR code will do — a
     Wi-Fi join code is a good one). **Expect** a specific refusal, not a
     saved destination and not a crash.
   - Deny camera access in Settings and reopen the scanner. **Expect** an
     explanation and a route to Settings, not a black rectangle.
6. **Duplicate** a destination. Expect the copy to carry the address and **not**
   the key.
7. Settings → **Erase stored data**. Expect every destination gone, the rights
   acknowledgement withdrawn, and the next broadcast attempt to re-ask.

**Fails if:** any import path applies without a tap; a stored key is ever
displayed; editing a name wipes the key; the scanner survives its own
dismissal.

The scan steps are the reason this test cannot move to the simulator. There are
no cameras there, so `DestinationScannerView` has never been run against a real
one — the unit tests cover the parser it feeds and nothing below it.

---

## T4 — Discovery

1. With the server running, open Destinations and let the discovery section
   search.
2. **Expect:** the server appears with its address, and **no key**. Selecting it
   opens the same confirmation sheet, with the key field empty for you to fill.
3. Turn the server off and search again. Expect an empty list, not a stale entry
   and not a spinner that never ends.

**Fails if:** a discovered entry arrives with a key already populated.

---

## T5 — First stereo broadcast

1. With a destination configured, tap broadcast.
2. **Expect:** the rights acknowledgement, once. Read it. Accept.
3. **Expect:** `connecting` → `live` within a couple of seconds, and the server
   log to show a `hello` with `mode: separate` and two tracks.
4. Open the viewer in a browser. **Expect** two eyes, both moving, correct
   left/right order.
5. Cover the **left** lens with a finger. **Expect** the left eye in the viewer
   to go dark. If the right one does, toggle **Swap eyes** in Settings and note
   it — the physical lens order differs by model.
6. Let it run five minutes. Watch the status bar: elapsed time, Mbps, dropped
   frames, and the reconnect count.

**Record:** steady-state Mbps against the configured bitrate, dropped-frame
count after five minutes, and the thermal badge state at the end.

**Fails if:** the two eyes drift apart in time visibly; dropped frames climb
continuously rather than sitting near zero; the stream is live but both eyes
show the same camera (see `ios/README.md`).

---

## T6 — Stereo geometry

With the broadcast live and the viewer in a headset if you have one:

1. Stand at 2 m from a subject with clear vertical edges. Check the two eyes for
   **vertical** disparity — there should be none. Horizontal disparity is the
   point; vertical disparity is a defect and causes eye strain within a minute.
2. Check convergence at 1 m, 2 m, and 5 m. The built-in wide and ultra-wide have
   a fixed baseline of roughly 10–15 mm depending on model, so depth will be
   subtle. **This is expected** and is the honest limit of using two built-in
   lenses rather than a stereo rig.
3. Confirm **Lens matching** is on, then compare the two eyes for brightness and
   colour cast. The ultra-wide is a smaller sensor and will be noisier; it
   should not be visibly *warmer* or a stop darker. If it is, trim with **Lens
   trim** and record the value that worked.
4. Set Projection to **180° dome** with no lens attachment. **Expect** the
   viewer to warp the rectilinear picture onto a hemisphere and look wrong, and
   expect the app to have told you that in the setting's description. This
   confirms projection is declared metadata, not a transform.

---

## T7 — Interruptions are not failures

Each of these, with a broadcast live:

| Do this | Expect |
|---|---|
| Take a phone call | Status shows the interruption in words; the broadcast is **not** torn down; it resumes when the call ends |
| Swipe up to the home screen, wait 10 s, return | Interruption, then resume |
| Open Control Centre and start the camera | Interruption naming another app using the camera; resume on return |
| Lock the screen, unlock | Resume |

**Fails if:** any of these ends the broadcast, or leaves the status stuck on an
interruption that has ended.

---

## T8 — Reconnection

1. Live and stable. Turn Wi-Fi off on the **server** machine, or pull its cable.
2. **Expect:** status goes to `reconnecting (1 of 6)`, then 2, with the delay
   roughly doubling — about 1, 2, 4, 8, 16, 16 seconds.
3. Restore the network within the window. **Expect** the broadcast to come back,
   the reconnect counter in the status bar to be non-zero, and the viewer to
   recover on the next keyframe.
4. Repeat, but leave the network down. **Expect** it to give up after six
   attempts with a clear error, not retry forever.
5. **Now the important one:** with no server running at all, start a broadcast.
   **Expect it to fail once and stop** — no reconnection attempts. A first
   attempt failing is a wrong address, and retrying does not fix a wrong
   address.

---

## T9 — Thermal

This one takes time and a warm room. Budget 20 minutes.

1. 1080p60, stereo, direct sunlight or a warm room, screen at full brightness.
2. Watch for the **Hot** badge in the status bar as the thermal state climbs.
3. At sustained `.critical`, **expect** — if **Fall back to mono when hot** is
   on in Settings — a fallback to a single eye after **two consecutive**
   critical windows, via a brief reconnect and a new handshake, and **expect it
   to stay mono for the rest of the broadcast** rather than flipping back.
4. Turn the setting off and repeat. **Expect** stereo to be maintained and frame
   drops to rise instead.

**Record:** minutes to `.serious`, minutes to `.critical`, whether the fallback
triggered, and whether the phone stayed usable. If `.critical` arrives in under
ten minutes at 1080p60, that is a finding worth acting on — it means the default
should probably be 1080p30.

---

## T10 — Network interface policy

1. Configure a **private** destination (`192.168.x.x`). Turn Wi-Fi off, leave
   cellular on, and start a broadcast. **Expect** it to fail rather than attempt
   the connection over cellular.
2. Configure a **public** destination. Turn Wi-Fi off. **Expect** it to connect
   over cellular.

**Fails if:** a `192.168.x.x` destination is attempted over cellular — that
sends the broadcast into a stranger's network.

---

## T11 — Backgrounding and teardown

1. Live, then background the app for 30 seconds and return.
2. Force-quit while live. Relaunch. **Expect** `idle`, no stuck state, and the
   server to have noticed the socket close.
3. Stop a live broadcast with the button. **Expect** the confirmation dialog,
   and on confirming, a clean `bye` in the server log.

---

## T12 — Sound

Everything the unit tests cover here is synthetic: a buffer list built in
memory, fed to a real `AudioConverter`. They prove the encode and the
timestamps. They prove nothing about a microphone sharing a device with two
cameras.

1. Fresh install, first broadcast. **Expect** the microphone prompt, with the
   purpose string from `Info.plist`, and the broadcast to continue either way.
2. Allow it. In the viewer, click the sound control. **Expect** sound, and
   **expect** it to have been silent until that click — browsers do not start
   audio without a gesture, so a receiver that plays immediately means something
   has changed in `src/live/audio.js`.
3. Speak on a beat — a metronome app, or clapping — and watch the viewer.
   **Expect** the clap and the picture within a video frame or two of each
   other. **Record** the offset and whether it grows.
4. Let it run ten minutes with continuous sound. **Record** the offset again.
   This is the test that catches timestamps derived from arrival time; it looks
   perfect for the first minute.
5. Turn **Sound** off in Settings, mid-broadcast. **Expect** the iOS recording
   indicator to disappear, the viewer's sound control to go dead, and the
   picture not to glitch.
6. Go live with Sound off from cold, then check
   **Settings › Privacy & Security › Microphone**. **Expect** the app not to be
   listed as having used it.
7. Decline the permission (reset it in iOS Settings first). **Expect** a notice
   when going live saying the broadcast is silent, said once rather than
   repeating, and a row in the app's Settings that opens the iOS permission.
8. Take a phone call while live. **Expect** the broadcast to survive, and sound
   to return afterwards with a discontinuity rather than a permanent offset.

**Record:** A/V offset at one minute and at ten, whether Diagnostics' "Sound
buffers" advances steadily, and the behaviour on the interruption.

**Fails if:** the offset grows without bound; the recording indicator appears
with Sound off; the microphone prompt appears for an operator who never turned
sound on; sound never recovers from an interruption.

---

## Reporting

For each test: **pass / fail / not run**, with device, iOS version, build
number, and the recorded numbers where the test asks for them. A test that was
not run is reported as not run — it is not a pass.

New findings go into the risk register in
[`IOS_AUDIT.md`](IOS_AUDIT.md#9-risk-register), ranked the same way.
