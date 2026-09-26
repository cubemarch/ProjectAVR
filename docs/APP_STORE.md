# App Store submission pack

Written for whoever prepares the App Store Connect listing and answers App
Review. Drafts are drafts — read them before pasting, and change anything that
is not true of the build you are actually submitting.

Read [`IOS_AUDIT.md`](IOS_AUDIT.md) first, and in particular
[risk C1](IOS_AUDIT.md#critical). If that risk is unresolved, nothing in this
document rescues the submission.

- [1. Blockers](#1-blockers)
- [2. The review environment](#2-the-review-environment)
- [3. Submission checklist](#3-submission-checklist)
- [4. Name and subtitle](#4-name-and-subtitle)
- [5. Description](#5-description)
- [6. Keywords](#6-keywords)
- [7. Screenshots](#7-screenshots)
- [8. Privacy policy checklist](#8-privacy-policy-checklist)
- [9. Support page checklist](#9-support-page-checklist)
- [10. Age rating](#10-age-rating)
- [11. Notes for Review](#11-notes-for-review)
- [12. Reviewer test script](#12-reviewer-test-script)
- [13. Responses to likely questions](#13-responses-to-likely-questions)

---

## 1. Blockers

Three things must be true before a build is uploaded. None is a code change.

| Blocker | Where | Guideline |
|---|---|---|
| `AVRPrivacyPolicyURL` in `ios/AVRCapture/Info.plist` points at `capture.example.com` | The page is written — [`public/legal/privacy.html`](../public/legal/privacy.html) — but `example.com` is an RFC 2606 reserved name and will never resolve. Substitute the real domain and deploy. Must be a live `https` page: non-https is rejected by `SupportLinks` at runtime and the row hides itself, so a wrong value fails silently | 5.1.1 |
| `AVRSupportURL` points at the same placeholder | Same, for [`public/legal/support.html`](../public/legal/support.html) | Expected for all apps |
| No public review destination exists | §2 | 2.1 |

---

## 2. The review environment

**The problem.** The app is a camera and a socket. Pointed at nothing it does
nothing, and a reviewer cannot see what it is for. A LAN-only demo is not an
option: App Review is not on your Wi-Fi.

**What is needed:** a publicly reachable AVR Live ingest endpoint and a viewer
page, both working over cellular, live for the whole review window and for any
appeal after it.

This is a **general-audience environment**. Not a special mode, not a separate
build, not a reviewer-only code path — the app has none of those and must not
acquire any. It is an ordinary deployment of this project's server that happens
to be the one you hand to a reviewer.

### Standing it up

1. Deploy `server/index.js` to a host with a public address and a TLS-terminated
   viewer origin. `npm start`, or the `Dockerfile` in the repository root.
2. Generate a stream key for the review destination. Rotate it after review.
3. Confirm the ingest port is reachable **from cellular**, not just from your
   office. Test on a phone with Wi-Fi off.
4. Publish the viewer at a stable URL on the same general-audience domain the
   listing points at.
5. Seed the viewer with two or three general-audience clips so a reviewer who
   arrives before you press Record still sees a working product — a rehearsal, a
   room walkthrough, a talk. Nothing adult, nothing borrowed without a licence.
6. Leave it running. If it is down when the reviewer opens it, that is a
   rejection that costs a week.
7. If the submitted build has **Return audio** in Settings, make sure the review
   destination can actually send some — a talkback control on the viewer page,
   reachable without an account. An unexercisable setting is worse than no
   setting: a reviewer who cannot try it is left to guess what it is for, and the
   guess available to them is the one recorded as risk H4 in
   [`IOS_AUDIT.md`](IOS_AUDIT.md).

### What the reviewer gets

A destination name, host, port, stream key, and viewer URL, pasted into Notes
for Review (§11). No account, no password, no app configuration — they type four
fields into the app the same way any user would.

---

## 3. Submission checklist

**Binary**

- [ ] Privacy policy and support URLs filled in and reachable over `https`
- [ ] `PrivacyInfo.xcprivacy` present — tracking `false`, no collected data
      types, three required-reason APIs declared
- [ ] Purpose strings describe only this app's use of the camera, the
      microphone and the local network, and name no other product
- [ ] Version and build number bumped
- [ ] Release build on a physical device, once, end to end
- [ ] `xcodebuild … test` green (see [`IOS_TESTING.md`](IOS_TESTING.md))
- [ ] `NSMicrophoneUsageDescription` present and specific — sound is sent with
      the broadcast, and the string says it can be turned off. Requesting audio
      access without the key terminates the process, so its absence is not a
      safe default
- [x] Encryption: `ITSAppUsesNonExemptEncryption = false`, set in `Info.plist`.
      The app uses TLS and a SHA-256 certificate pin, both from the operating
      system's own frameworks, and implements no cryptography of its own — which
      is the standard exemption. Revisit only if that stops being true

**Listing**

- [ ] Name, subtitle, description, keywords from §4–6
- [ ] Screenshots from §7 — general-audience scenarios only
- [ ] Age rating per §10
- [ ] Category: Photo & Video. Secondary: none
- [ ] Notes for Review from §11, with live credentials substituted
- [ ] Demo account: not applicable, and say so explicitly rather than leaving it
      blank

**Before you press submit**

- [ ] Open the privacy policy, the support page, and the viewer URL on a phone
      with Wi-Fi off
- [ ] Re-read [risk C1](IOS_AUDIT.md#critical) and decide, deliberately, that
      the answer is still yes
- [ ] Decide the same way about **Return audio** ([risk H4](IOS_AUDIT.md#high)):
      either the review destination demonstrates it as talkback and the Notes
      describe it, or it does not ship in this build. Shipping it undescribed is
      the one option that is not available

---

## 4. Name and subtitle

App name (30 characters max):

| Option | Chars | Note |
|---|---|---|
| **AVR Capture** | 11 | Matches the binary. Recommended |
| Stereo Live Camera | 18 | Describes the function to someone who has never heard of the project |
| AVR Live Broadcaster | 20 | |

Subtitle (30 characters max):

| Option | Chars |
|---|---|
| **Live stereo video broadcast** | 27 |
| Broadcast live from two lenses | 30 |
| Live camera to your own server | 30 |

Neither may contain "VR180", "spatial video", or "MV-HEVC" — the app produces
none of those and 2.3 covers metadata that overstates capability.

---

## 5. Description

> **Broadcast live video from your iPhone to a server you control.**
>
> AVR Capture turns an iPhone into a live contribution camera. Point it at a
> destination you configure, press one button, and what the camera sees goes out
> live. There is no account to create and nothing to subscribe to.
>
> On iPhone models with two rear cameras, AVR Capture can use both at once to
> send a stereoscopic picture — one encoded stream per eye, matched at the
> receiving end. On every other iPhone it broadcasts a standard single-camera
> picture.
>
> **What it does**
>
> • Live broadcast over Wi-Fi or cellular to an address you enter
> • Stereo capture using the wide and ultra-wide cameras together, on supported
>   models
> • Standard single-camera mode on any iPhone
> • H.264 or HEVC, 720p or 1080p, 24 to 60 fps, with an adjustable bitrate
> • Automatic exposure and white-balance matching between the two lenses
> • Multiple saved destinations, so a studio and a venue are two taps apart
> • Automatic reconnection when the network drops mid-broadcast
> • A diagnostics report you can send to whoever runs your server
>
> **Who it is for**
>
> Anyone who needs a camera at one end of a link and a server at the other:
> educators streaming a lab bench, performers sending a rehearsal to a remote
> director, event producers running a second angle, estate agents walking a
> property, trainers recording a procedure from the operator's point of view,
> sports clubs covering a fixture.
>
> **What you need**
>
> AVR Capture does not host anything. You supply the destination — a server
> running compatible receiving software, either your own or one your platform
> provides. Without one, the app has nowhere to send a broadcast.
>
> **Privacy**
>
> No account, no analytics, no tracking. Video goes to the destination you
> configure and nowhere else. Stream keys are stored in the iOS Keychain, on
> this device only, and can be erased from Settings at any time.
>
> **Requirements**
>
> Stereo capture needs an iPhone with two rear cameras and an A12 chip or later
> (iPhone 11 and newer, and iPhone XS/XS Max). Other models broadcast in
> standard single-camera mode.

Every claim in that text is implemented. If a feature is removed from the build,
remove the line.

---

## 6. Keywords

100 characters including commas. Do not repeat words from the app name or
subtitle — they are already indexed.

```
broadcast,stream,streaming,camera,stereoscopic,3d,rtmp alternative,encoder,studio,field,ingest
```

That is 99 characters. Drop `rtmp alternative` if you would rather not invite a
comparison the app cannot currently make — see
[risk L2](IOS_AUDIT.md#low) — and use the 16 characters for `live,production`.

Prohibited here: competitor names, `VR180`, `spatial`, and any adult term.

---

## 7. Screenshots

Six, 6.7" and 6.5", landscape (the app is landscape-only). Every scenario below
is general-audience by construction, and each one shows a real screen of the
app, not a mockup.

| # | Screen | Scene in the viewfinder | Caption |
|---|---|---|---|
| 1 | Live, status bar reading elapsed time, bitrate and **Stereo Side-by-Side** | A lecture bench with apparatus on it | Broadcast live in stereo |
| 2 | Destinations list, three saved entries | — | Save every destination you use |
| 3 | Import confirmation sheet | — | Nothing is saved until you confirm |
| 4 | Settings, capture section | — | H.264 or HEVC, 720p or 1080p, up to 60 fps |
| 5 | Diagnostics | — | Know exactly what your device can do |
| 6 | Live in Standard, reconnect indicator visible | A stage rehearsal, wide shot | Keeps going when the network wobbles |

Destination names in screenshots: `Main Studio`, `Lecture Hall B`, `Field Unit`.
Hosts: use `203.0.113.x` (RFC 5737 documentation range). **No real key visible in
any screenshot** — the app never displays a stored key, so this should be
automatic, but check before uploading.

No App Preview video for the first submission. A video of a live broadcasting
tool needs a live broadcast, and a staged one is more work than it is worth.

---

## 8. Privacy policy checklist

The page must be live, `https`, and reachable without a login. Required content:

- [ ] Who the publisher is, and a contact address
- [ ] **Camera:** used to capture video for broadcast; frames are sent only to
      the destination the user configures; nothing is stored on a server by the
      app
- [ ] **Microphone:** used to send sound with the broadcast, to the same
      destination and on the same terms as the video; can be switched off, and
      when it is, no microphone is attached at all
- [ ] **Stream keys:** stored in the iOS Keychain, this device only, excluded
      from iCloud and from backups restored to other devices; transmitted only
      to the configured destination
- [ ] **Destination profiles and settings:** stored locally in the app container
- [ ] **No analytics, no tracking, no advertising identifiers, no third-party
      SDKs**
- [ ] **No account**, therefore nothing to delete server-side
- [ ] How to erase everything: Settings → Erase stored data
- [ ] Local-network access: used only to find a receiving server on the current
      Wi-Fi, and only while the Destinations screen is searching
- [ ] That the operator of the destination server — which may not be the app's
      publisher — controls what happens to the broadcast once it arrives
- [ ] Children: the app is not directed at children and collects nothing
- [ ] Effective date, and how changes are announced

Keep it consistent with `PrivacyInfo.xcprivacy`. A policy claiming more
collection than the manifest declares, or less, is worse than either.

---

## 9. Support page checklist

- [ ] A working contact address, monitored
- [ ] What the app is, in two sentences, including that it needs a destination
      server
- [ ] How to configure a destination: manually, by link, by file, by discovery
- [ ] Which devices support stereo, and why others do not
- [ ] Troubleshooting: black viewfinder, connect fails, both eyes the same,
      one eye darker — the material in [`ios/README.md`](../ios/README.md)
      rewritten for someone who is not a developer
- [ ] How to send a diagnostics report, and that it contains no keys or
      addresses
- [ ] A statement of what the app does **not** do: no hosting, no account, no
      recording to the camera roll or anywhere else on the device

---

## 10. Age rating

**Recommended: 17+.**

Answer the questionnaire as follows, and be able to justify each answer:

| Question | Answer | Why |
|---|---|---|
| Unrestricted web access | **Yes** | The app opens the privacy and support URLs in a browser, and — more to the point — broadcasts to a destination the user chooses |
| User-generated content | **Yes** | Video the user captures |
| Frequent/intense mature themes, sexual content, violence, etc. | **No** | The app ships no content |
| Gambling, contests | No | |
| Chat, messaging, or other communication between users | **No, with a caveat to be stated rather than buried** | There is no messaging feature: no text, no names, no roster, no reply path. Return audio, when the operator switches it on, plays speech the destination sends — a talkback line, one-way into the app. If the questionnaire is read as covering *any* real-time communication, answer Yes; a rating that is one notch conservative costs nothing, and a communication feature discovered after a "No" is a 2.3.1 finding. See risk H4 in [`IOS_AUDIT.md`](IOS_AUDIT.md) |
| Medical/treatment information | No | |

The 17+ outcome is driven by unrestricted user-chosen destinations, not by
anything in the binary. Rating it lower to look friendlier would be a
misrepresentation, and a live camera pointed at an address the app cannot
inspect genuinely is a 17+ capability.

---

## 11. Notes for Review

Paste into App Store Connect, substituting the live values. Everything in it
must be true.

> **What this app is**
>
> AVR Capture is a live video contribution tool. It captures from the iPhone's
> cameras, encodes, and sends the result over the network to a destination the
> user configures. It is the camera end of a broadcast chain — comparable to a
> hardware field encoder — and it is content-neutral: it ships no video, has no
> catalogue, no directory, no store, no default destination, and no way to
> browse or discover anything.
>
> **It needs a destination to demonstrate anything.** Without a receiving
> server, the app can show its camera preview and its settings but cannot go
> live. We have provided a public test server below.
>
> On first launch the app says so directly: a sheet asks for a destination
> address, offers to set one up later, and proposes nothing of its own. Until a
> destination and its key are both present the status bar reads "No
> destination"; once they are, it reads a green "Ready".
>
> **Test destination**
>
> - Host: `[HOST]`
> - Port: `[PORT]`
> - Stream key: `[KEY]`
> - Viewer: `[https://…]`
>
> No account or password is required; there is no sign-in anywhere in the app.
>
> **Stereo capture**
>
> On iPhone models with two rear cameras and an A12 chip or later, the app can
> run the wide and ultra-wide cameras simultaneously and send one encoded stream
> per eye. On other models it broadcasts a standard single-camera picture and
> says so in Settings. The app detects this at runtime from
> `AVCaptureMultiCamSession` — it does not check the device model.
>
> The app does **not** produce MV-HEVC or spatial video, and does not describe
> itself as doing so.
>
> **Return audio (talkback)**
>
> The app can play speech the destination server sends back, so whoever is
> directing a shoot can talk to the person holding the camera. It is off by
> default; the operator switches it on in Settings, and the status bar shows an
> indicator whenever it is playing. It is one-way: the app sends nothing over
> that channel, and it carries no text, no names, no roster and no way to reply.
> The audio is raw PCM — the app contains no decoder for it and no other kind of
> data can arrive on that channel.
>
> **Permissions**
>
> - Camera: to capture the video being broadcast. Required.
> - Microphone: to send sound with the broadcast. Sound can be switched off in
>   Settings, and with it off the app attaches no audio input at all.
> - Local network: only to find a receiving server on the current Wi-Fi, and
>   only while the Destinations screen is open and searching. Declining it
>   leaves manual entry working normally.
> - The app does **not** request photos, location, or contacts.
>
> **Privacy**
>
> No account, no analytics, no tracking, no third-party SDKs, no advertising
> identifiers. Stream keys are held in the Keychain
> (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). Settings → Erase stored data
> removes everything the app has kept.
>
> **User-generated content and 2.5.14**
>
> Before the first broadcast the app presents a consent and rights
> acknowledgement covering permission from everyone on camera, permission to be
> in the location, ownership of what is broadcast, and a prohibition on
> unlawful, non-consensual, or exploitative content. It is shown again if the
> wording changes. The broadcast button does nothing until it is accepted — the
> reviewer will see it on the first tap.
>
> **No hidden or review-specific behaviour**
>
> The app contains no feature flags, no remote configuration, no downloaded
> code, no hidden modes, no gesture-activated screens, and no logic that behaves
> differently for any reviewer, network, or account. Every build behaves
> identically for everyone. The transport picker shows one protocol because one
> protocol is implemented.
>
> **Source**
>
> The full source of the app and of the receiving server is available at
> `[REPO URL]` if it would help to verify any of the above.

---

## 12. Reviewer test script

Short enough to follow in five minutes. Include it under the Notes.

> 1. Launch the app and allow camera access. The viewfinder appears, and a
>    sheet asks where broadcasts should go. It suggests nothing and contacts
>    nothing. Tap **Skip** — the fields below are easier to enter by hand.
> 2. Tap the settings icon, then **Destination** → **Add manually**.
> 3. Enter the host, port, and stream key from the Notes above. Give it any
>    name. Tap **Save**. The status bar now reads a green **Ready**, which means
>    a destination and its key are both present.
> 4. Tap **Test Connection**. It should report success. (This checks
>    reachability only; it does not start a broadcast.)
> 5. Go back to the camera screen and tap the broadcast button.
> 6. **The rights acknowledgement appears.** Read it and tap Accept. This is the
>    2.5.14 consent gate and appears once.
> 7. The status bar shows *connecting*, then *live*, with elapsed time and
>    bitrate, the destination it is going to, and whether it is sending
>    **Standard** or **Stereo Side-by-Side**. On a phone that cannot run two
>    cameras, or one that has got too hot to, the mode reads Standard in orange
>    while the setting still says Stereo Side-by-Side — the bar names what is
>    actually going out.
> 8. Open the viewer URL from the Notes in a browser. You should see the live
>    picture from the phone within a few seconds. On a two-rear-camera iPhone it
>    will be stereoscopic; on other models, a single image.
> 9. *(Only if the build ships Return audio.)* In Settings, switch **Return
>    audio** on, then use the talkback control on the viewer page. The phone
>    plays what is said and the status bar shows a **Return** indicator while it
>    does. This is a one-way monitor line from the person directing the shoot to
>    the person holding the camera — the app sends nothing back over it and
>    displays no text, no names, and no list of who is connected.
> 10. Tap the broadcast button again and confirm to stop.
>
> To see the app's device detection, open Settings → About → **Diagnostics**. It
> lists the cameras this device actually has and which combinations it can run
> together.

---

## 13. Responses to likely questions

Templates. Adapt, keep them short, and never assert anything that is not true of
the submitted build.

**"What is the app for? We cannot see what it does."**

> AVR Capture is the camera end of a live broadcast chain, like a hardware field
> encoder. It sends live video to a server the user configures, and it has no
> function without one. We have provided a public test server and a five-step
> script in the Notes for Review; step 8 shows the live picture in a browser. If
> the test server is unreachable, please tell us and we will confirm it is up —
> that would be our fault, not a limitation of the app.

**"The app requires third-party hardware or software to function." (2.4.1 / 2.1)**

> It requires a destination server, which is the nature of a contribution
> encoder: the same is true of any RTMP or SRT camera app. The receiving
> software is open source and is linked from our support page, so a user can run
> their own at no cost. Many users broadcast to a platform that provides the
> destination for them.

**"What is the stereoscopic feature, and does it work on our test device?"**

> It runs the wide and ultra-wide rear cameras simultaneously via
> `AVCaptureMultiCamSession` and sends one encoded stream per eye. It needs an
> A12 chip or later and two rear cameras. If your test device is an iPhone XR,
> SE, or older, the app will broadcast a standard single-camera picture and will
> say why in Settings — that is correct behaviour, not a failure. Settings →
> About → Diagnostics reports exactly what the device supports.

**"Does the app support adult content?" / "Is this related to an adult service?"**

> The app is a content-neutral broadcasting tool. It ships no content, has no
> catalogue, directory, store, feed, search, or default destination, and cannot
> display any video other than the live preview of the device's own camera. It
> imposes no restriction on what a user points a camera at, in the same way a
> camera app does not — and it presents a rights acknowledgement before the
> first broadcast that expressly prohibits unlawful, non-consensual, or
> exploitative material.
>
> Users choose their own destination server. Our general-audience platform is at
> `[URL]`. *(If there is a lawful adult platform in the surrounding business:
> say so here, plainly, in one sentence, with whatever verification and
> moderation it operates. Do not omit it. If it is discovered after a denial, it
> is a 2.3.1 problem on top of whatever the original question was.)*

**"What is Return audio? Does this let viewers talk to the broadcaster?"**

*Answer this one carefully and do not oversell it. What follows is true of the
binary; if the destination platform is one where the voice belongs to a paying
member of the audience, that is a fact about the service and it is
[risk H4](IOS_AUDIT.md#high). Saying only the first half and being found out is
a 2.3.1 problem on top of the original question.*

> Return audio is a talkback line — the intercom a camera operator has to the
> gallery on any professional shoot. The destination server can send speech to
> the phone so whoever is directing can give instruction while the operator is
> filming. It is off by default and the operator switches it on themselves.
>
> It is strictly one-way into the app and deliberately minimal: sound only, no
> text, no names, no roster, no notifications, no reply path, and no indication
> of who or how many people are at the other end. The app cannot determine the
> identity of a speaker and the protocol carries nothing that would let it. What
> plays is raw PCM audio; there is no decoder and no other kind of data on that
> channel. Step 9 of the test script exercises it.

**"Guideline 5.1.1 — the privacy policy link does not work."**

> Corrected in build `[N]`. The policy is at `[URL]` and is reachable without a
> login.

**"Guideline 2.5.14 — the app must obtain consent before recording."**

> The app presents a consent and rights acknowledgement before the first
> broadcast; the broadcast button performs no action until it is accepted. It is
> versioned, so it is shown again whenever the wording changes. Step 6 of the
> test script in the Notes for Review is this screen.

**"Guideline 2.3.1 — hidden or undocumented features."**

> There are none. The app contains no feature flags, remote configuration,
> downloaded code, hidden modes, gesture-activated screens, or logic conditional
> on reviewer, network, account, or build. The transport list shows one entry
> because one transport is implemented; others are not present in any form. The
> complete source is at `[REPO URL]` and we are happy to walk through any part
> of it.

**"Guideline 4.2 — minimum functionality."**

> The app performs simultaneous dual-camera capture, hardware H.264/HEVC
> encoding at up to 1080p60, per-eye stream multiplexing over a custom framed
> transport, automatic exposure and white-balance matching between two different
> sensors, thermal-aware degradation, and automatic reconnection. Settings →
> About → Diagnostics shows the runtime capability detection behind it. We would
> welcome specifics on what appeared insufficient.
