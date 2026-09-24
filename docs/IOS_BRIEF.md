# AVR Capture — product and compliance brief

Standing requirements for the iOS application in [`ios/`](../ios). This is the
specification the app is audited against; [`IOS_AUDIT.md`](IOS_AUDIT.md) records
how far it currently conforms, and [`APP_STORE.md`](APP_STORE.md) holds the
submission material derived from it.

Read this before changing anything in `ios/`. Several of the constraints below
look like ordinary product preferences and are not — they are the difference
between an app that can be submitted and one that cannot.

---

## Mission

Develop the iPhone application into a production-quality, general-purpose live
video broadcasting tool supporting ordinary 2D video and stereoscopic/spatial
video.

The application is for creators, educators, performers, event producers, sports
broadcasters, real-estate presenters, training providers and other lawful
publishers. Users must be able to transmit to destinations they control.

A separate, genuine, continuously available general-audience web platform is
being developed for ordinary live events and will be available to App Review. It
must not be a temporary reviewer-only façade.

Some consenting adult creators may independently use the same content-neutral
broadcasting technology with a lawful adult-oriented web platform. The iOS
application itself must not contain, display, promote, sell, discover, or link
to adult content.

The objective is legitimate App Store compliance, not evasion. Never introduce
reviewer detection, Apple-IP allowlists, hidden modes, misleading metadata,
dormant features, secret gestures, special reviewer accounts, remote code, or
review-specific behaviour.

Apple approval cannot be guaranteed. If the actual implementation or business
model would make the app primarily an adult-content service, that is a material
App Store risk to be identified, not concealed.

---

## Product definition

A neutral professional broadcasting application. Its core functions are:

- Capture video and microphone audio.
- Broadcast to a user-selected destination.
- Record locally when requested.
- Support standard monoscopic video.
- Support stereoscopic side-by-side video on devices where simultaneous
  rear-camera capture is actually available and stable.
- Import or manually configure destination profiles.
- Display objective technical diagnostics.
- Handle failures, interruption, overheating and network changes safely.
- Play a return audio line from the destination — the talkback a camera operator
  has to the gallery — under all of the following, which are conditions of it
  existing at all:
  - Off by default, switched on by the operator, and visibly indicated while it
    is playing.
  - Sound only, one-way into the app. No text, no names, no roster, no
    notifications, no reply path, no per-speaker anything.
  - Raw PCM, no decoder, bounded queue, and nothing else parseable on that
    channel.
  - Described in the Notes for Review and demonstrable in the review
    environment, or not shipped. See risk **H4** in [`IOS_AUDIT.md`](IOS_AUDIT.md),
    which records why this is a line worth watching rather than a settled one:
    in a deployment where the voice belongs to a paying viewer, a reviewer may
    read it as the viewer interaction excluded below.

### Do not add

- A content feed, creator directory, viewer catalogue, discovery interface,
  comments, messaging, random matching, dating, tipping, fan subscriptions,
  explicit-content controls, or an embedded general web browser.
- Adult branding, terminology, screenshots, imagery, sample streams,
  destinations, presets, links or promotional copy.
- A remote configuration flag that turns the application into a different
  product.
- A web view that exposes either the general-audience or the adult viewing
  platform.
- Purchases, payout management, creator earnings, external purchase calls to
  action, or paid-content unlocking, unless a separate App Store payment review
  is deliberately undertaken.
- Downloaded executable code or server-driven UI that materially changes native
  functionality.

A camera preview and the broadcaster's own stream status are allowed. The
application must not provide destination-side playback or browse the content
being distributed. The return audio line above is the single exception to
"messaging", and it is an exception only while every one of its conditions
holds: the moment it acquires a name, a reply, a list, or a second direction, it
has become the thing this list excludes.

---

## Destination configuration

Destination handling is an ordinary professional broadcasting feature.

- On first launch the destination may be unset.
- The app must still be useful without a server: camera testing, stereo
  capability testing, local recording, diagnostics.
- Present a neutral action such as "Connect a Destination."
- Allow manual entry of display name, protocol, ingest URL or host, stream key
  or publishing token, optional port, optional latency/encryption settings.
- Support import by QR code, universal link or configuration file where that
  suits the architecture. A QR code may configure a destination; it must never
  unlock paid native functionality.
- Use a documented, versioned configuration schema.
- Validate imported data and require user confirmation before saving or
  connecting.
- Never put secrets in universal-link URLs, analytics, crash reports, console
  logs or screenshots.
- Store secrets in the Keychain with an appropriate accessibility class. Store
  non-secret preferences separately.
- Provide edit, duplicate, test and delete.
- Provide a clear "Test Connection" where the protocol allows it.
- Never silently substitute or redirect a destination.
- Apply identical functionality and UI to every destination. No
  content-category-specific behaviour of any kind.

If the app supports both a company account and arbitrary destinations, keep the
concepts separate. Signing in may retrieve authorised destination profiles;
manual configuration remains a genuine professional feature. Avoid requiring
login unless account-backed functionality truly needs it. If account creation
exists, implement in-app account deletion. If third-party social login is used,
evaluate Guideline 4.8 and add an equivalent privacy-preserving option where
required.

The general-audience service must be a real production environment, not an App
Review-only endpoint. It may provide App Review with a stable demo account and a
non-adult sample destination.

---

## Capture architecture

Public Apple APIs only.

Maintain clear boundaries resembling `CaptureEngine`, `DeviceCapabilityService`,
`StereoFrameSynchronizer`, `StereoCompositor`, `VideoEncoder`,
`AudioCaptureEngine`, `BroadcastTransport`, `StreamSessionCoordinator`,
`DestinationProfileStore`, `RecordingService`, `ThermalAndNetworkMonitor`,
`DiagnosticsStore`. Do not force this structure where the repository already has
a sound equivalent.

### Monoscopic mode

A robust standard camera mode on all supported devices: front/rear selection;
resolution, frame rate, bitrate, orientation, focus, exposure and stabilisation
controls where supported; correct audio-session setup; predictable landscape and
portrait behaviour; local recording and/or streaming; graceful interruption
handling for calls, alarms, camera loss, route changes and lifecycle
transitions.

### Stereo mode

Treat live stereo as a custom dual-camera pipeline unless verified public APIs
provide another supported approach. Investigate runtime support with public
AVFoundation capability checks; never assume two physical rear lenses permit
simultaneous access to the required pair.

Where supported: use `AVCaptureMultiCamSession` or its public successor; select
the best compatible rear pair; capture both streams with timestamps; synchronise
on presentation timestamps within a bounded tolerance; track dropped, duplicated
and out-of-sync frames; correct orientation and mirror state; align, crop and
scale consistently; composite to standard side-by-side using Metal or another
performant public framework; encode with VideoToolbox; keep audio synchronised
to the output timeline.

Do not call the live output "MV-HEVC" unless the app truly emits a verified
multiview HEVC stream. Do not call ordinary rectilinear stereo "VR180."
User-facing terminology is **Standard**, **Stereo Side-by-Side**, and **Spatial
Recording** only where technically accurate.

If live MV-HEVC is not reliably supported through the complete ingest, CDN,
playback and target-player path, use side-by-side H.264 or HEVC.

Fall back to monoscopic automatically when the required camera combination is
unavailable, the device is thermally constrained, synchronisation cannot be
maintained, or the selected resolution/frame rate exceeds hardware capacity.
Never fabricate stereo by duplicating one camera. Tell the user when stereo is
unavailable and why.

### Device support

Capability detection, not model-name assumptions. Record diagnostics for
available camera devices and formats, supported simultaneous combinations,
maximum practical dimensions and frame rates, active colour formats, HDR
support, encoder availability, thermal state and estimated bandwidth.

Optimise first for the current development device, but retain runtime checks and
graceful fallback.

---

## Live transport and player compatibility

The iPhone app is the contribution/uplink client. A server handles ingest,
optional transcoding, packaging, authentication, distribution and viewer
playback URLs. The intended viewer ecosystem includes PLAY'A and other VR-capable
players or browsers.

Preferred architecture: contribution over SRT, RTMP/RTMPS or WHIP depending on
what is implemented and what the backend supports; server-side validation,
recording, optional transcoding and packaging; viewer delivery over
authenticated HLS, WebRTC or another player-supported format; documented
side-by-side layout metadata for stereo signalling.

Do not assume a player supports a format merely because it can open a URL.
Maintain a compatibility matrix covering contribution protocol, video codec,
audio codec, stereo layout, resolution and frame rate, delivery protocol,
authentication mechanism, PLAY'A behaviour, other target players, tested
device/headset, result and known limitations.

Keep player-specific behaviour on the server or playback side. The capture app
emits a documented, standard stream.

---

## Stream lifecycle and user safety

Recording and broadcasting must be unmistakable.

- Request camera and microphone access contextually, with accurate purpose
  strings.
- Show a persistent, unambiguous LIVE or RECORDING state.
- Require an explicit user action to begin, and provide a prominent stop
  control.
- Show destination name, elapsed time, network state, dropped frames, bitrate,
  stereo-sync status and audio state.
- Confirm before leaving a screen while a stream is active.
- Stop or safely pause when the operating system requires it.
- Never attempt concealed background camera or microphone capture.
- Confirm that the broadcaster has the rights and consent to record and transmit
  everyone appearing in the production.
- Prohibit illegal, non-consensual, exploitative or underage content in the
  terms.
- No adult-specific language anywhere in the native workflow.

Comply with Guideline 2.5.14 on explicit consent and visible/audible recording
indication.

---

## Security and privacy

Implement or document: TLS for HTTP traffic; RTMPS, SRT encryption or equivalent
where supported; ATS-compliant networking; Keychain credential storage;
redaction of tokens and personal data from logs; no analytics collection of raw
video, audio, stream keys, destination URLs containing tokens or camera frames;
minimal telemetry with explicit disclosure; clear retention and deletion
behaviour; a privacy policy link in App Store metadata and inside the app; a
support/contact link inside the app; a privacy manifest covering first-party and
third-party API use; accurate App Privacy disclosures; in-app account deletion if
accounts exist; data export/deletion handling where legally required; a
dependency inventory with licensing, privacy-manifest and SDK signature status.

Include only the permission strings actually needed, from
`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
`NSPhotoLibraryAddUsageDescription`, `NSPhotoLibraryUsageDescription`,
`NSLocalNetworkUsageDescription` and Bonjour service declarations. Purpose
strings must describe the actual use, not use generic wording.

---

## Adult-platform boundary

The lawful adult platform remains outside the native app. The app may transmit
to a destination its user configures, as any professional encoder can. However:

- Do not bundle, advertise or recommend an adult destination.
- Do not identify destination profiles by sexual-content category.
- Do not link to the adult platform.
- Do not include adult account creation, identity verification, discovery,
  payments, earnings, chat or viewer interaction.
- Do not fetch adult branding or promotional content into the app.
- Do not use a server response to activate adult-specific native UI.
- Do not show the resulting adult stream inside the app.
- Do not claim that neutral UI automatically makes an adult-primary product
  compliant.

The web platform — not the iOS app — handles content-specific obligations:
creator identity and age verification; verification that every depicted
participant is an adult; documented consent and withdrawal procedures;
performer/content records required by applicable jurisdictions; content
moderation and rapid takedown; reporting and appeals; blocking and account
enforcement; prevention of trafficking, coercion, non-consensual content and
content involving minors; geographic restrictions; payment-processor
requirements; viewer age gates; terms, privacy and community standards; legal
review in every served jurisdiction.

These are legal and trust-and-safety requirements, not App Store features. Flag
them for qualified legal counsel; do not invent legal conclusions.

---

## General-audience platform requirements

The non-adult platform presented to Apple must be a real part of the business:
publicly functional and maintained after approval; suitable for ordinary events,
education, performances, sports, training, real estate, tourism and similar;
supported by accurate public product information; equipped with real non-adult
test content; available during review; using the same app binary and the same
ordinary destination workflow as every other user; not activated only for Apple
accounts, review IP addresses, dates or device identifiers; not populated with
placeholder pages; not silently replaced after approval.

Provide App Review with a stable demo account if login is required; a sample
non-adult destination profile or QR code; a scheduled or continuously available
test stream workflow; exact steps to test standard capture, stereo capability,
local recording and broadcasting; any hardware requirements; and a contact who
can respond promptly during review.

---

## App Store positioning

Position the app truthfully as a professional live-production tool: live video
broadcaster, stereo video encoder, spatial production camera, remote event
contribution tool, professional streaming utility.

Do not claim "works with every VR headset" or "true VR180" without verified
evidence.

Draft and maintain: app name and subtitle options; description; keywords;
screenshot plan using ordinary non-adult scenarios; privacy-policy checklist;
support-page checklist; age-rating recommendation based on actual content and
capabilities; detailed Notes for Review; a reviewer test script; and a response
template for likely App Review questions. Metadata must accurately represent the
shipping binary.

---

## Required App Review disclosure

Review notes must transparently explain that the app is a professional video
capture and contribution client; that it supports local recording and
user-configured streaming destinations; that destination profiles carry
connection information and unlock no hidden features; that it contains no viewer
catalogue, social feed, chat, purchases or destination-side playback; that the
same functionality is available to the reviewer; how to use the provided
non-adult test destination; how stereo behaves on supported and unsupported
devices; why each permission is requested; any non-obvious QR or universal-link
behaviour; and any backend dependencies.

Do not state or imply anything untrue. If the developer operates both the
general-audience and the adult platform, or adult use is reasonably expected to
be the dominant use of the app, flag it for an explicit business/legal/App Review
decision. Do not silently omit a fact that would make the submission misleading.

---

## Relevant Apple rules

Review the current guidelines rather than relying on these summaries.

| Rule | Subject |
| --- | --- |
| 1.1.4 | Overtly sexual or pornographic material |
| 1.2 | User-generated content, moderation, services used primarily for pornography |
| 2.1 | Completeness, working backend, reviewer access, demo credentials, sample QR codes |
| 2.3, 2.3.1 | Accurate metadata; no hidden, dormant or undocumented features |
| 2.5.1 | Public APIs |
| 2.5.2 | No downloaded code that changes functionality |
| 2.5.14 | Explicit consent and visible/audible recording indication |
| 3.1 | Payments and feature unlocking |
| 3.1.3(f) | Free stand-alone companion apps |
| 4.8 | Login-service requirements |
| 5.1.1 | Privacy policy, data collection, purpose strings, retention/deletion, in-app account deletion |

<https://developer.apple.com/app-store/review/guidelines/>

If a current rule differs from this brief, report the difference and follow the
current rule.

---

## Testing requirements

Cover destination validation and secure persistence; configuration import
parsing and malicious-input rejection; stream lifecycle state transitions;
start/stop idempotency; camera and microphone permission states; stereo
capability fallback; timestamp synchronisation; orientation and left/right
ordering; interruption recovery; network loss and reconnection; authentication
expiration; thermal degradation; sensitive-data log redaction; account deletion
where applicable.

Where hardware behaviour cannot be unit tested, create protocols and test
doubles plus a documented physical-device test plan.

Run the Xcode build, unit tests, UI tests where practical, static analysis and
compiler warnings, and dependency/privacy-manifest checks. Never claim a test
passed unless it actually ran successfully.

---

## Performance requirements

Measure or expose capture frame rate, encoded frame rate, dropped frames, stereo
synchronisation offset, encoder latency, end-to-end contribution latency where
measurable, bitrate, CPU/GPU load where available, memory growth, thermal state,
battery impact and reconnection count.

Use bounded queues and deliberate backpressure. Never allow unbounded frame
accumulation. Prefer dropping stale video frames over runaway latency.

---

## Deliverables

Repository documentation for: architecture and data flow; device capability
matrix; streaming protocol and codec matrix; destination-profile schema;
security and threat model; privacy/data inventory; general-audience review
environment setup; App Store submission checklist; App Review notes and test
instructions; physical-device stereo test plan; remaining risks and decisions.

Each audit pass reports: repository state discovered; files changed; builds and
tests run with exact results; what is production-ready; what remains incomplete;
hardware-dependent assumptions; backend dependencies; App Store risks ranked
critical/high/medium/low; and the next three highest-value actions.

---

## Decision principles

When choosing between implementations, in order:

1. Truthful App Store representation.
2. User safety and consent.
3. Public APIs and platform compliance.
4. Stable standard-video broadcasting.
5. Secure credential handling.
6. Graceful capability detection and fallback.
7. Interoperable live stereo.
8. Low latency.
9. Advanced spatial formats.

Do not sacrifice a reliable standard broadcast path merely to label the
application "spatial."
