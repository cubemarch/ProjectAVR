import AVFoundation
import Combine
import CoreMedia
import Foundation
import UIKit
import os

/// Capture → rectify → encode → socket, and the state the UI renders.
///
/// The pipeline runs on two queues. Frames arrive on the capture queue, are
/// cropped and handed to the encoders there, and come back out on a single
/// shared output queue — shared deliberately, so the two eyes reach the socket
/// in a deterministic order instead of racing. Only the published properties
/// touch the main actor, and only once a second.
@MainActor
final class BroadcastController: ObservableObject {
    enum Status: Equatable {
        case idle
        case preparing
        case connecting
        case reconnecting(attempt: Int, of: Int)
        case live(sessionId: String?)
        case error(String)

        var isLive: Bool {
            if case .live = self { return true }
            return false
        }

        var isBusy: Bool {
            switch self {
            case .preparing, .connecting, .reconnecting: return true
            default: return false
            }
        }

        /// The broadcast is on air or trying to get back on air — which is the
        /// distinction the "are you sure you want to leave" prompt cares about.
        var isActive: Bool { isLive || isBusy }
    }

    struct Telemetry {
        var framesEncoded: UInt64 = 0
        var framesDropped: UInt64 = 0
        var megabitsPerSecond: Double = 0
        var bufferedKilobytes: Int = 0
        var thermal: ProcessInfo.ThermalState = .nominal
        var bitrate: Int = 0
        /// Wall clock since the current broadcast was started, including any
        /// time spent reconnecting.
        var elapsed: TimeInterval = 0
        /// How many times the link dropped and came back during this broadcast.
        var reconnections: Int = 0
        /// `nil` in mono. Otherwise the state of the right eye, which is the
        /// one thing about a stereo broadcast that can fail while everything
        /// else keeps reporting success.
        var stereoSync: StereoSync?

        enum StereoSync: Equatable {
            case paired
            case starved(String)

            var isHealthy: Bool { self == .paired }
        }

        /// What is happening to sound.
        ///
        /// `off` and `unavailable` look identical from a viewer's end — silence
        /// — and are completely different things to the operator, so they are
        /// never collapsed into one "no audio" state.
        var audio: Audio = .off

        enum Audio: Equatable {
            /// The operator turned sound off.
            case off
            /// A microphone is attached and packets are going out.
            case live
            /// Sound was asked for and is not happening. Carries why.
            case unavailable(String)
        }
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var telemetry = Telemetry()

    /// Servers that answered a discovery probe. Candidates, not destinations —
    /// saving one is an explicit act in the UI.
    @Published private(set) var discovered: [DestinationImport.Candidate] = []
    @Published private(set) var permissionDenied = false

    /// Sound was asked for and iOS said no.
    ///
    /// Separate from ``permissionDenied``, which is fatal: a refused microphone
    /// costs the broadcast its sound and nothing else, so it is a row in
    /// Settings rather than a wall the operator cannot get past.
    @Published private(set) var microphoneDenied = false

    @Published var notice: String?

    /// The current capture interruption — a phone call, another app taking the
    /// camera, Split View — or `nil`. Not an error, and it does not arrive as
    /// one: without this the viewfinder simply freezes while the app carries on
    /// saying "Live".
    @Published private(set) var interruption: StereoCaptureSession.Interruption?

    /// Whether the destination is talking back, and whether it can be heard.
    ///
    /// `.stopped` covers both "the operator has this switched off" and "the
    /// broadcast is not running", which are the same thing from the screen's
    /// point of view: no indicator.
    @Published private(set) var returnAudio: ReturnAudioPlayer.State = .stopped

    /// The capture graph is built and running, so a preview layer attached to it
    /// will actually receive frames.
    ///
    /// The UI must not mount the viewfinder before this is true.
    /// ``StereoCaptureSession/configure(quality:frameRate:stereo:)`` begins by
    /// tearing down *every* connection on the session, so a preview attached
    /// beforehand is removed again and stays black for the life of the app —
    /// with no error anywhere to explain it.
    @Published private(set) var isCameraReady = false

    /// Can this device run the wide and ultra-wide together at all?
    ///
    /// Asked of the device's own supported multi-cam sets rather than of
    /// `isMultiCamSupported`, which only says two cameras can run at once —
    /// not that *these* two can.
    var supportsStereo: Bool { capabilities.supportsWideAndUltraWideTogether }

    let capture = StereoCaptureSession()

    /// What this particular phone can do, asked of the system once at launch.
    let capabilities = DeviceCapabilityService.report()

    private let config: CaptureConfig
    private let destinations: DestinationStore
    private let client = IngestClient()

    /// Built once and kept for the life of the app, so the ingest client's
    /// per-packet callback can hold it directly rather than hopping to the main
    /// actor twenty-five times a second to find out whether it exists. It opens
    /// nothing until ``startReturnAudioIfWanted()`` starts it.
    private let returnAudioPlayer = ReturnAudioPlayer()
    private let discovery = Discovery()
    private let log = Logger(subsystem: "com.projectavr.capture", category: "broadcast")

    /// Encoder output lands here. One queue for both eyes; see the type comment.
    private let outputQueue = DispatchQueue(label: "com.projectavr.capture.output", qos: .userInitiated)

    private var leftEncoder: VideoEncoder?
    private var rightEncoder: VideoEncoder?
    private var audioEncoder: AudioEncoder?
    private var wideRectifier: PixelRectifier?
    private var ultraRectifier: PixelRectifier?

    private var statsTimer: Timer?
    private var lastBytesSent: UInt64 = 0
    private var lastStatsAt = Date()

    /// Consecutive one-second windows with drops, used to decide when to back
    /// the bitrate off. One bad second is a passing interference spike; three
    /// in a row is a link that cannot carry what is being produced.
    private var congestedWindows = 0
    private var cleanWindows = 0
    private var currentBitrate = 0

    /// Set once per start so both eyes' first frame is a keyframe at the same
    /// instant, rather than one eye showing up to two seconds before the other.
    private var needsKeyframe = true
    private var rightEyeStarved = false
    private var lensNotice: String?

    private var configObservers: Set<AnyCancellable> = []

    // MARK: - Reconnection and degradation state

    /// The operator has asked to be on air and has not asked to stop. Separate
    /// from `status`, because a dropped link means the app is off air while
    /// still being *meant* to be on air, and only that distinction says whether
    /// to reconnect or to give up.
    private var intendsToBroadcast = false

    /// A session reached `.live` at least once during this broadcast.
    ///
    /// Reconnection is deliberately only offered after that point. A failure on
    /// the very first attempt is a wrong address, a wrong key, or a server that
    /// is not running — none of which retrying fixes, and all of which produce
    /// a clearer outcome as a message the operator can act on than as a spinner
    /// that never resolves.
    private var hadLiveSession = false

    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private static let maxReconnectAttempts = 6

    private var startedAt: Date?

    /// Stereo was requested but the phone is too hot to carry two cameras.
    ///
    /// Latched for the rest of the broadcast rather than released when the
    /// phone cools. Going back would mean a second teardown and reconnect, and
    /// a device that reached `.critical` once under this load will reach it
    /// again — oscillating between one and two eyes is worse for a viewer than
    /// staying mono.
    ///
    /// Published because the status bar names what is actually going out, and
    /// a latch nothing observes would leave it reading Side-by-Side after the
    /// fallback notice had been dismissed.
    @Published private(set) var thermalMonoOverride = false
    private var criticalThermalWindows = 0

    init(config: CaptureConfig, destinations: DestinationStore) {
        self.config = config
        self.destinations = destinations

        // Lens matching is followed live rather than read once at `prepare()`,
        // because the whole point of the trim is to nudge it while watching the
        // two eyes side by side. Making the operator restart the broadcast
        // between each nudge would turn a ten-second adjustment into a chore.
        config.$matchLenses
            .sink { [weak self] in self?.capture.matchLenses = $0 }
            .store(in: &configObservers)

        config.$lensTrimStops
            .sink { [weak self] in self?.capture.lensTrimStops = $0 }
            .store(in: &configObservers)

        // Followed rather than read once, because turning sound on has to
        // attach a microphone to a session that is already running — and a
        // toggle that does nothing until the app is relaunched is a toggle that
        // reads as broken.
        config.$captureAudio
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in await self?.applyAudioSetting() }
            }
            .store(in: &configObservers)

        capture.onPreviewFailure = { [weak self] message in
            Task { @MainActor in self?.notice = message }
        }

        capture.onInterruption = { [weak self] interruption in
            Task { @MainActor in self?.apply(interruption) }
        }

        discovery.onResults = { [weak self] results in
            self?.discovered = results
        }

        client.onState = { [weak self] state in
            Task { @MainActor in self?.apply(state) }
        }

        client.onSessionId = { [weak self] id in
            Task { @MainActor in self?.status = .live(sessionId: id) }
        }

        // Straight to the player, off the ingest queue. Everything else on this
        // object crosses to the main actor first; a packet of speech every
        // 40 ms does not, because the main actor is drawing a viewfinder.
        client.onReturnAudio = { [player = returnAudioPlayer] payload in
            player.enqueue(payload)
        }

        returnAudioPlayer.onState = { [weak self] state in
            Task { @MainActor in self?.returnAudio = state }
        }

        // Followed live. Turning return audio off mid-broadcast has to actually
        // stop the sound coming out of the phone — a setting that waits for the
        // next broadcast is the wrong answer for this one in particular.
        config.$returnAudio
            .removeDuplicates()
            .sink { [weak self] wanted in
                Task { @MainActor in self?.applyReturnAudioSetting(wanted) }
            }
            .store(in: &configObservers)
    }

    // MARK: - Return audio

    /// Open the return feed if the operator wants it and there is a link to
    /// carry it. Called on the transition to live, including after a reconnect.
    private func startReturnAudioIfWanted() {
        guard config.returnAudio else { return }

        client.acceptsReturnAudio = true
        returnAudioPlayer.start()
    }

    /// Counters for the diagnostics screen. Read on demand, not published:
    /// nothing on screen needs them twenty-five times a second.
    var returnAudioStats: ReturnAudioPlayer.Stats { returnAudioPlayer.snapshot() }

    private func applyReturnAudioSetting(_ wanted: Bool) {
        client.acceptsReturnAudio = wanted

        guard wanted else {
            returnAudioPlayer.stop()
            return
        }

        // Only worth opening an output while something could arrive on it.
        if status.isLive { returnAudioPlayer.start() }
    }

    // MARK: - Permissions

    /// Ask for the camera, and warm up the preview.
    ///
    /// Local network access is not requested here because iOS has no API for
    /// it — the prompt appears the first time a UDP broadcast or LAN
    /// connection is attempted, which is during discovery or connect. That is
    /// why ``IngestClient`` translates `EPERM` into a sentence about Settings
    /// rather than showing the raw error.
    func prepare() async {
        guard !isCameraReady else { return }

        status = .preparing

        guard await requestCameraAccess() else {
            permissionDenied = true
            status = .error("AVR Capture needs the camera.")
            return
        }

        permissionDenied = false

        // Asked for here rather than at launch, and only when sound is
        // switched on: two prompts back to back at first run is how an operator
        // learns to dismiss both without reading either.
        let audio = config.captureAudio ? await requestMicrophoneAccess() : false

        do {
            try capture.configure(
                quality: config.quality,
                frameRate: config.frameRate,
                stereo: effectiveStereo,
                audio: audio
            )
            capture.start()

            // Only now may the viewfinder be mounted — see ``isCameraReady``.
            isCameraReady = true
            status = .idle
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    /// Rebuild the graph after the sound setting changed.
    ///
    /// A microphone cannot be added to or removed from a running capture
    /// session without reconfiguring it, and reconfiguring it tears down every
    /// connection including the viewfinder's. Doing that under a live broadcast
    /// would cost the audience several seconds of black for a setting the
    /// operator can perfectly well apply at the next one.
    private func applyAudioSetting() async {
        guard isCameraReady else { return }

        guard !status.isActive else {
            notice = config.captureAudio
                ? "Sound will be on from the next broadcast."
                : "Sound will be off from the next broadcast."
            return
        }

        let audio = config.captureAudio ? await requestMicrophoneAccess() : false

        do {
            try capture.configure(
                quality: config.quality,
                frameRate: config.frameRate,
                stereo: effectiveStereo,
                audio: audio
            )
            capture.start()
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    /// Is this broadcast actually going out with two eyes?
    ///
    /// Three things have to agree: the operator asked for stereo, the hardware
    /// can run two cameras at once, and the phone is not too hot to. Every
    /// decision downstream — how many encoders to build, what the handshake
    /// declares, whether a missing right eye is a fault — reads this rather
    /// than `config.mode`.
    var effectiveStereo: Bool {
        config.mode == .separate
            && capabilities.supportsWideAndUltraWideTogether
            && !thermalMonoOverride
    }

    /// Why stereo is not available on this device, or `nil` when it is.
    var stereoUnavailableReason: String? { capabilities.stereoUnavailableReason }

    /// Try again after a failure the operator may have just fixed, such as
    /// granting camera access in Settings.
    func retryPrepare() async {
        isCameraReady = false
        status = .idle
        await prepare()
    }

    private func requestCameraAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video)
        default:
            return false
        }
    }

    private func requestMicrophoneAccess() async -> Bool {
        let granted: Bool

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            granted = true
        case .notDetermined:
            granted = await AVCaptureDevice.requestAccess(for: .audio)
        default:
            granted = false
        }

        microphoneDenied = !granted
        return granted
    }

    func search() {
        discovered = []
        discovery.search()
    }

    // MARK: - Capture interruptions

    /// A phone call, another app taking the camera, or Split View.
    ///
    /// These arrive as notifications rather than errors and nothing else in the
    /// pipeline notices them: the session stops vending buffers, the socket
    /// stays open, and the app goes on saying "Live" over a frozen viewfinder.
    /// The broadcast is deliberately *not* torn down — most interruptions end
    /// by themselves within seconds and dropping the session would cost the
    /// audience the stream over a notification the operator did not choose.
    private func apply(_ interruption: StereoCaptureSession.Interruption?) {
        self.interruption = interruption

        guard let interruption else {
            if notice?.hasPrefix("Camera paused") == true { notice = nil }
            return
        }

        notice = "Camera paused: \(interruption.message)"
        log.notice("capture interrupted: \(interruption.message, privacy: .public)")
    }

    // MARK: - Broadcast

    func start() {
        guard !status.isActive else { return }

        // The rights acknowledgement gates going on air rather than launching
        // the app, so the operator can set the phone up, frame the shot and
        // read the terms once, at the moment they actually become true.
        guard config.hasAcknowledgedRights else {
            status = .error("Confirm the broadcasting terms before going live.")
            return
        }

        guard let destination = destinations.readyDestination else {
            status = .error(
                destinations.selected == nil
                    ? "Choose a destination first."
                    : "That destination has no stream key yet."
            )
            return
        }

        intendsToBroadcast = true
        hadLiveSession = false
        reconnectAttempt = 0
        thermalMonoOverride = false
        criticalThermalWindows = 0
        startedAt = Date()
        telemetry = Telemetry()

        connectAttempt(to: destination)
    }

    /// Build the pipeline and open the socket. Shared by `start()` and by each
    /// reconnection, which differ only in what they do beforehand.
    private func connectAttempt(to destination: (profile: DestinationProfile, key: String)) {
        status = reconnectAttempt == 0
            ? .connecting
            : .reconnecting(attempt: reconnectAttempt, of: Self.maxReconnectAttempts)

        needsKeyframe = true
        congestedWindows = 0
        cleanWindows = 0
        currentBitrate = config.bitrate

        do {
            try buildPipeline()
        } catch {
            status = .error(error.localizedDescription)
            intendsToBroadcast = false
            return
        }

        // Said once, when the operator goes live, rather than every second from
        // `sampleStats()`: a broadcast going out silent is the one fault that
        // cannot be heard from behind the camera, and it is not something a
        // reconnection is going to change.
        if reconnectAttempt == 0, case .unavailable(let why) = telemetry.audio {
            notice = why
        }

        client.connect(
            host: destination.profile.host,
            port: UInt16(clamping: destination.profile.port),
            // Decided by the address, not by a preference. A private or
            // link-local address is not reachable over cellular anyway, and a
            // public one is unreachable *without* it on a phone with no Wi-Fi.
            allowsCellular: !destination.profile.isLocalNetwork,
            security: TransportSecurity(profile: destination.profile),
            hello: helloBody(key: destination.key)
        )

        startStatsTimer()
    }

    func stop() {
        intendsToBroadcast = false
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        hadLiveSession = false
        startedAt = nil

        teardownPipeline()

        client.disconnect()
        status = .idle
        telemetry = Telemetry()
    }

    /// Tear the encoders down without touching the intent to broadcast, so a
    /// reconnection can rebuild them.
    private func teardownPipeline() {
        statsTimer?.invalidate()
        statsTimer = nil

        // Return audio belongs to the connection, not to the app. Off air is
        // off air, and a player left running would hold the audio session open
        // for nothing.
        returnAudioPlayer.stop()

        // Detach the callbacks first, then drop the mirrors, so nothing on the
        // capture queue can reach an encoder that is being torn down.
        capture.onFramePair = nil
        capture.onAudioSample = nil
        retirePipelineHandles()

        leftEncoder?.finish()
        rightEncoder?.finish()
        audioEncoder?.finish()
        leftEncoder?.teardown()
        rightEncoder?.teardown()
        audioEncoder?.teardown()
        leftEncoder = nil
        rightEncoder = nil
        audioEncoder = nil
    }

    private func apply(_ state: IngestClient.State) {
        switch state {
        case .live:
            // Frames start flowing here, not in `buildPipeline()`.
            attachCaptureFeed()
            startReturnAudioIfWanted()
            hadLiveSession = true
            reconnectAttempt = 0
            if case .live = status { return }
            status = .live(sessionId: nil)

        case .connecting, .handshaking:
            if case .reconnecting = status { return }
            status = .connecting

        case let .failed(message):
            if shouldReconnect {
                scheduleReconnect(because: message)
            } else {
                stop()
                // After `stop()`, which resets to `.idle`: the operator needs
                // the reason on screen, not a shutter that quietly came back up.
                status = .error(message)
            }

        case let .rejected(message):
            // No `shouldReconnect` check — that is the whole point of the case.
            // A refusal the server has classified as terminal survives a
            // reconnection, so the ladder would only delay this same message by
            // a minute.
            log.error("broadcast refused: \(message, privacy: .public)")
            stop()
            status = .error(message)

        case .idle:
            if status.isActive {
                if shouldReconnect {
                    scheduleReconnect(because: "The connection closed.")
                } else {
                    stop()
                }
            }
        }
    }

    // MARK: - Reconnection

    private var shouldReconnect: Bool {
        intendsToBroadcast
            && hadLiveSession
            && config.autoReconnect
            && reconnectAttempt < Self.maxReconnectAttempts
    }

    /// Wait, then try the same destination again.
    ///
    /// Exponential backoff capped at 16 seconds and at six attempts — roughly a
    /// minute of trying. Past that the link is not coming back on its own and a
    /// phone silently retrying forever is worse than one that says so: the
    /// operator can see the shot is off air and decide whether to move, switch
    /// networks, or stop.
    private func scheduleReconnect(because reason: String) {
        teardownPipeline()

        reconnectAttempt += 1
        telemetry.reconnections += 1

        let delay = min(16.0, pow(2.0, Double(reconnectAttempt - 1)))
        status = .reconnecting(attempt: reconnectAttempt, of: Self.maxReconnectAttempts)
        notice = "\(reason) Reconnecting (\(reconnectAttempt) of \(Self.maxReconnectAttempts))…"
        log.notice("reconnect \(self.reconnectAttempt) in \(delay)s: \(reason, privacy: .public)")

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }

            await MainActor.run {
                guard let self, self.intendsToBroadcast else { return }

                guard let destination = self.destinations.readyDestination else {
                    self.status = .error("The destination is no longer available.")
                    self.intendsToBroadcast = false
                    return
                }

                self.connectAttempt(to: destination)
            }
        }
    }

    /// Give up two eyes to keep the broadcast alive.
    ///
    /// A thermally constrained multi-cam session does not fail — it starts
    /// missing frames on whichever camera loses the race, which produces a
    /// stereo pair with a stuttering right eye. That is more uncomfortable to
    /// watch than clean mono, and it is invisible from everywhere except inside
    /// a headset. Switching means a new handshake, because the layout the
    /// viewer is told to expect has changed, so it runs through the same
    /// reconnect path as a dropped link.
    private func degradeToMono() {
        guard effectiveStereo, config.thermalFallbackToMono, intendsToBroadcast else { return }

        thermalMonoOverride = true
        criticalThermalWindows = 0
        log.notice("thermal fallback to mono")

        // Read before the rebuild: `configure` overwrites the diagnostics, and
        // dropping a camera is no reason to also drop the sound.
        let audio = capture.diagnostics.audioRequested

        teardownPipeline()
        client.disconnect()

        Task { @MainActor in
            do {
                try capture.configure(
                    quality: config.quality,
                    frameRate: config.frameRate,
                    stereo: false,
                    audio: audio
                )
                capture.start()
            } catch {
                status = .error(error.localizedDescription)
                intendsToBroadcast = false
                return
            }

            guard intendsToBroadcast, let destination = destinations.readyDestination else { return }

            notice = "The phone is too hot for two cameras — switched to one for the rest of this broadcast."
            reconnectAttempt = 0
            connectAttempt(to: destination)
        }
    }

    // MARK: - Pipeline

    private func buildPipeline() throws {
        let stereo = effectiveStereo
        let size = config.quality.size

        guard let optics = capture.optics else {
            throw StereoCaptureSession.CaptureError.noCompatibleFormat("wide")
        }

        // The wide camera defines the field of view the broadcast covers, so
        // the ultra-wide is cropped down to it rather than the other way
        // round. Cropping the wide up is not possible — there is no image
        // outside its frame — and letting the eyes differ is not an option.
        let target = min(optics.wideFovDegrees, optics.ultraWideFovDegrees)

        wideRectifier = PixelRectifier(
            geometry: .init(
                targetFovDegrees: target,
                sourceFovDegrees: optics.wideFovDegrees,
                outputWidth: size.width,
                outputHeight: size.height
            )
        )

        if stereo {
            ultraRectifier = PixelRectifier(
                geometry: .init(
                    targetFovDegrees: target,
                    sourceFovDegrees: optics.ultraWideFovDegrees,
                    outputWidth: size.width,
                    outputHeight: size.height
                )
            )
        }

        let settings = VideoEncoder.Configuration(
            codec: config.codec.nalCodec,
            width: size.width,
            height: size.height,
            frameRate: config.frameRate,
            bitrate: config.bitrate
        )

        let left = VideoEncoder(label: "left", configuration: settings, outputQueue: outputQueue)
        wire(left, to: .left)
        try left.prepare()
        leftEncoder = left

        if stereo {
            let right = VideoEncoder(label: "right", configuration: settings, outputQueue: outputQueue)
            wire(right, to: .right)
            try right.prepare()
            rightEncoder = right
        }

        // Built from what the graph actually came up with, not from the
        // preference: the operator may have sound switched on while the
        // microphone is refused, unavailable, or held by another app.
        if capture.diagnostics.audioConnected {
            let audio = AudioEncoder(outputQueue: outputQueue)
            wire(audio)
            audioEncoder = audio
            telemetry.audio = .live
        } else {
            telemetry.audio = config.captureAudio
                ? .unavailable(microphoneDenied
                    ? "Microphone access is off, so this broadcast has no sound. Turn it on in Settings › Privacy & Security › Microphone."
                    : "No microphone is available, so this broadcast has no sound.")
                : .off
        }

        // Must happen before the frame callback is installed: `handle(_:)` reads
        // only the mirrors, so a frame arriving first would be silently dropped.
        publishPipelineHandles()

        // The frame callback is deliberately *not* installed here. See
        // `attachCaptureFeed()` — encoding before the handshake finishes loses
        // the one CONFIG message the decoder needs.
    }

    /// Start feeding the encoders. Called only once the socket is live.
    ///
    /// This cannot happen in ``buildPipeline()``. `VideoEncoder` emits its
    /// `onConfig` exactly once, when the format description first appears on
    /// frame one, and `IngestClient.sendConfig` drops anything queued before the
    /// handshake completes. Encoding early therefore burned the only CONFIG the
    /// stream will ever produce against a socket that was still in
    /// `.handshaking`, and the browser — handed video it had no codec string to
    /// configure a decoder with — showed two black eyes on an otherwise healthy
    /// session.
    private func attachCaptureFeed() {
        guard capture.onFramePair == nil else { return }

        // First frame through must be a keyframe: it carries the parameter sets
        // and is the first thing a subscriber can decode from.
        needsKeyframe = true
        pendingKeyframe = true

        capture.onFramePair = { [weak self] pair in
            self?.handle(pair)
        }

        // Same reasoning as the frame callback: `AudioEncoder` emits its CONFIG
        // on the first buffer it sees, and a CONFIG produced before the socket
        // is live is the only one the broadcast will ever have.
        capture.onAudioSample = { [weak self] sampleBuffer in
            self?.handle(audio: sampleBuffer)
        }
    }

    /// Runs on the capture session's audio queue.
    private nonisolated func handle(audio sampleBuffer: CMSampleBuffer) {
        audioEncoderRef?.encode(sampleBuffer)
    }

    private func wire(_ encoder: VideoEncoder, to track: Wire.Track) {
        encoder.onConfig = { [weak self] config in
            self?.client.sendConfig(
                track: track,
                body: [
                    "codec": config.codecString,
                    "codedWidth": config.width,
                    "codedHeight": config.height
                ]
            )
        }

        encoder.onSample = { [weak self] sample in
            guard let self else { return }

            self.client.sendVideo(
                track: track,
                data: sample.data,
                timestampMicroseconds: sample.timestampMicroseconds,
                isKeyframe: sample.isKeyframe
            )

            Task { @MainActor in self.telemetry.framesEncoded += 1 }
        }

        encoder.onError = { [weak self] error in
            Task { @MainActor in
                self?.notice = "Encoder: \(error.localizedDescription)"
            }
        }
    }

    private func wire(_ encoder: AudioEncoder) {
        encoder.onConfig = { [weak self] config in
            self?.client.sendConfig(
                track: .audio,
                body: [
                    "codec": config.codecString,
                    "sampleRate": config.sampleRate,
                    "numberOfChannels": config.channels,
                    // Raw AAC access units describe nothing about themselves,
                    // so this is not optional metadata — it is the only thing
                    // a decoder can be configured from. Base64 because CONFIG
                    // frames are JSON.
                    "description": config.description.base64EncodedString()
                ]
            )
        }

        encoder.onPacket = { [weak self] packet in
            self?.client.sendAudio(
                data: packet.data,
                timestampMicroseconds: packet.timestampMicroseconds,
                discontinuity: packet.discontinuity
            )
        }

        encoder.onError = { [weak self] error in
            Task { @MainActor in
                // Named, because "Encoder:" on its own sends the operator
                // looking at the picture for a fault that is in the sound.
                self?.notice = "Audio: \(error.localizedDescription)"
            }
        }
    }

    /// Runs on the capture queue.
    private nonisolated func handle(_ pair: StereoCaptureSession.FramePair) {
        let force = forceKeyframeIfNeeded()

        // Rectify each buffer with the rectifier built for *its own lens*, and
        // only then decide which eye it is. The crop factor is derived from one
        // specific lens' field of view, so running the wide through the
        // ultra-wide's rectifier - which is what happened when `swapEyes` was on
        // and the assignment was made first - crops a frame that needed no
        // cropping to 43% and blows it back up, while the ultra-wide passes
        // through uncropped. The two eyes then cover different fields of view,
        // which is exactly what rectification exists to prevent.
        guard let wide = wideRectifierRef?.rectify(pair.wide) else {
            countRightEyeMiss(.wideRectifyFailed)
            return
        }

        guard let ultraSource = pair.ultraWide else {
            // Mono, by configuration or because the ultra-wide dropped this
            // frame. One eye is better than a stalled stream.
            countRightEyeMiss(.noUltraWideFrame)
            leftEncoderRef?.encode(wide, presentationTime: pair.presentationTime, forceKeyframe: force)
            return
        }

        guard let ultra = ultraRectifierRef?.rectify(ultraSource) else {
            countRightEyeMiss(.ultraRectifyFailed)
            leftEncoderRef?.encode(wide, presentationTime: pair.presentationTime, forceKeyframe: force)
            return
        }

        // Which sensor is the left eye depends on how the phone is being held,
        // so the assignment is made here rather than baked into the graph.
        let (left, right) = swapEyesFlag ? (ultra, wide) : (wide, ultra)

        leftEncoderRef?.encode(left, presentationTime: pair.presentationTime, forceKeyframe: force)
        rightEncoderRef?.encode(right, presentationTime: pair.presentationTime, forceKeyframe: force)
    }

    /// Why a frame reached the socket with only one eye on it.
    ///
    /// A stereo broadcast that quietly degrades to mono is the worst failure
    /// this pipeline has, because every layer downstream keeps reporting
    /// success: the session is live, frames and bytes climb, and the viewer
    /// shows a perfectly good picture — the same picture in both eyes. Nothing
    /// distinguishes it from working except looking through a headset. So each
    /// path that can drop the right eye is counted and surfaced.
    enum RightEyeMiss {
        /// The wide rectifier failed, so there is no frame at all this tick.
        case wideRectifyFailed
        /// The synchroniser delivered no ultra-wide buffer — mono session, or a
        /// dropped frame on that output.
        case noUltraWideFrame
        /// The ultra-wide rectifier failed: no transfer session, or an
        /// exhausted buffer pool.
        case ultraRectifyFailed
    }

    private nonisolated func countRightEyeMiss(_ reason: RightEyeMiss) {
        missLock.lock()
        defer { missLock.unlock() }
        rightEyeMisses += 1
        lastRightEyeMiss = reason
    }

    private nonisolated func drainRightEyeMisses() -> (count: Int, reason: RightEyeMiss?) {
        missLock.lock()
        defer { missLock.unlock() }
        let drained = (rightEyeMisses, lastRightEyeMiss)
        rightEyeMisses = 0
        return drained
    }

    private nonisolated func forceKeyframeIfNeeded() -> Bool {
        keyframeLock.lock()
        defer { keyframeLock.unlock() }

        guard pendingKeyframe else { return false }
        pendingKeyframe = false
        return true
    }

    // MARK: - Cross-actor pipeline handles
    //
    // `handle(_:)` is called from the capture queue and cannot touch the main
    // actor without hopping, which at 30–60 fps would be both a cost and a
    // reordering hazard. These mirrors are written on the main actor while the
    // pipeline is stopped and only read while it is running.

    private nonisolated(unsafe) var leftEncoderRef: VideoEncoder?
    private nonisolated(unsafe) var rightEncoderRef: VideoEncoder?
    private nonisolated(unsafe) var audioEncoderRef: AudioEncoder?
    private nonisolated(unsafe) var wideRectifierRef: PixelRectifier?
    private nonisolated(unsafe) var ultraRectifierRef: PixelRectifier?
    private nonisolated(unsafe) var swapEyesFlag = false
    private nonisolated(unsafe) var pendingKeyframe = true
    private nonisolated let keyframeLock = NSLock()

    private nonisolated(unsafe) var rightEyeMisses = 0
    private nonisolated(unsafe) var lastRightEyeMiss: RightEyeMiss?
    private nonisolated let missLock = NSLock()

    /// Publish the main-actor state the capture queue needs. Called from
    /// ``start()`` before any frame can arrive.
    private func publishPipelineHandles() {
        leftEncoderRef = leftEncoder
        rightEncoderRef = rightEncoder
        audioEncoderRef = audioEncoder
        wideRectifierRef = wideRectifier
        ultraRectifierRef = ultraRectifier
        swapEyesFlag = config.swapEyes
        pendingKeyframe = true
    }

    /// Withdraw them again, before the encoders are torn down.
    ///
    /// Clearing the callback is not by itself enough: a frame handed to the
    /// capture queue a moment earlier may still be inside ``handle(_:)``. The
    /// synchronous hop onto that same serial queue waits for it to finish, so
    /// the encoders are never deallocated underneath a call into them.
    ///
    /// Two queues, because sound is delivered on its own: see
    /// ``StereoCaptureSession/audioQueue``.
    private func retirePipelineHandles() {
        capture.sampleQueue.sync {
            leftEncoderRef = nil
            rightEncoderRef = nil
            wideRectifierRef = nil
            ultraRectifierRef = nil
        }
        capture.audioQueue.sync {
            audioEncoderRef = nil
        }
    }

    // MARK: - Handshake

    /// - Parameter key: Passed in rather than read from a property, so the
    ///   credential exists in exactly one place for exactly as long as the
    ///   handshake takes. It is never logged, never printed in a notice, and
    ///   never stored anywhere but the Keychain.
    private func helloBody(key: String) -> [String: Any] {
        var body: [String: Any] = [
            "protocol": Wire.protocolName,
            "version": Wire.protocolVersion,
            "key": key,
            "name": config.displayName,
            "device": UIDevice.current.model,
            "mode": effectiveStereo ? CaptureConfig.Mode.separate.rawValue : CaptureConfig.Mode.mono.rawValue,
            "projection": config.projection.rawValue,
            "stereo": effectiveStereo ? "sbs" : "mono"
        ]

        if let optics = capture.optics {
            body["hfovDeg"] = min(optics.wideFovDegrees, optics.ultraWideFovDegrees)

            if let baseline = optics.baselineMillimetres {
                body["baselineMm"] = baseline
            }
        }

        if config.projection == .fisheye {
            body["fisheyeFov"] = 180
        }

        // Sent so a degraded capture graph shows up in the server log. A
        // multi-cam session that comes up with one camera missing does not
        // throw and does not look wrong from anywhere else in the pipeline.
        let diagnostics = capture.diagnostics
        var capture_: [String: Any] = [
            "multiCamSupported": diagnostics.multiCamSupported,
            "stereoRequested": diagnostics.stereoRequested,
            "hardwareCost": Double(diagnostics.hardwareCost),
            "systemPressureCost": Double(diagnostics.systemPressureCost),
            "connections": diagnostics.connectionCount,
            "ultraWideConnected": diagnostics.ultraWideConnected,
            // A black viewfinder on the phone is invisible from the server,
            // and the operator reporting it usually cannot say whether the
            // camera or the connection is at fault. This answers that.
            "previewConnected": diagnostics.previewConnected,
            "matchLenses": config.matchLenses,
            "lensTrimStops": config.lensTrimStops,
            "lensShortfallStops": (capture.lensShortfallStops * 100).rounded() / 100,
            "lensWideBiasStops": (capture.lensWideBiasStops * 100).rounded() / 100,
            // Counted since the graph was built, which is app launch — so by
            // the time this handshake goes out both should be well into the
            // hundreds. `ultraWideBuffers` at zero means the camera is not
            // vending frames at all, as opposed to vending them unpaired.
            "wideBuffers": diagnostics.wideBuffersSeen,
            "ultraWideBuffers": diagnostics.ultraWideBuffersSeen,
            "pairsEmitted": diagnostics.pairsEmitted,
            "monoFallbacks": diagnostics.monoFallbacks,
            // A broadcast that arrives silent is the one fault an operator
            // cannot hear from behind the camera. These three separate the
            // three reasons: the setting is off, the microphone would not
            // attach, or it attached and is vending nothing.
            "audioRequested": diagnostics.audioRequested,
            "audioConnected": diagnostics.audioConnected,
            "audioBuffers": diagnostics.audioBuffersSeen
        ]
        if let skew = diagnostics.closestSkewSeconds {
            capture_["closestSkewMs"] = (skew * 100_000).rounded() / 100
        }
        if let wide = diagnostics.wideFormat { capture_["wideFormat"] = wide }
        if let ultra = diagnostics.ultraWideFormat { capture_["ultraWideFormat"] = ultra }
        if let error = diagnostics.runtimeError { capture_["runtimeError"] = error }
        body["capture"] = capture_

        return body
    }

    // MARK: - Telemetry and adaptation

    private func startStatsTimer() {
        lastBytesSent = 0
        lastStatsAt = Date()

        statsTimer?.invalidate()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleStats() }
        }
    }

    private func sampleStats() {
        let snapshot = client.snapshot()
        let now = Date()
        let elapsed = max(0.001, now.timeIntervalSince(lastStatsAt))

        let delta = snapshot.bytesSent >= lastBytesSent ? snapshot.bytesSent - lastBytesSent : 0
        lastBytesSent = snapshot.bytesSent
        lastStatsAt = now

        let dropDelta = snapshot.framesDropped > telemetry.framesDropped
            ? snapshot.framesDropped - telemetry.framesDropped
            : 0

        telemetry.framesDropped = snapshot.framesDropped
        telemetry.megabitsPerSecond = Double(delta) * 8 / elapsed / 1_000_000
        telemetry.bufferedKilobytes = snapshot.inFlightBytes / 1024
        telemetry.thermal = ProcessInfo.processInfo.thermalState
        telemetry.bitrate = currentBitrate
        telemetry.elapsed = startedAt.map { now.timeIntervalSince($0) } ?? 0

        reportRightEyeMisses()
        reportLensShortfall()
        adapt(dropped: dropDelta)
        considerThermalFallback()
    }

    /// Two consecutive critical windows before giving up the second camera.
    ///
    /// One is not enough: `.critical` is reached momentarily by things that
    /// have nothing to do with this app — charging in the sun, a background
    /// restore — and a fallback that costs a teardown, a reconnect and the
    /// stereo picture is too expensive to spend on a transient.
    private func considerThermalFallback() {
        guard config.thermalFallbackToMono, effectiveStereo, status.isLive else {
            criticalThermalWindows = 0
            return
        }

        guard telemetry.thermal == .critical else {
            criticalThermalWindows = 0
            return
        }

        criticalThermalWindows += 1
        if criticalThermalWindows >= 2 { degradeToMono() }
    }

    /// Say so, on the operator's screen, when the right eye is not going out.
    ///
    /// Only meaningful for a stereo broadcast: in mono the right eye is absent
    /// by design and saying so every second would be noise.
    /// Say what matching the lenses is costing.
    ///
    /// Two different things can happen once the ultra-wide runs out of gain,
    /// and neither is self-explanatory from the picture. Either the left eye is
    /// brought down to meet it — the whole shot dims, for no visible reason —
    /// or even that is not enough and the eyes stay mismatched while the trim
    /// slider does nothing, which reads as a broken control.
    private func reportLensShortfall() {
        // A third of a stop either way. Below that nobody can see it, and
        // narrating a difference nobody can see is worse than silence.
        let shortfall = capture.lensShortfallStops
        let pulledDown = -capture.lensWideBiasStops

        let message: String? = if shortfall > 0.33 {
            String(
                format: "Eyes are %.1f stops apart — the ultra-wide is at its limit, even wide open.",
                shortfall
            )
        } else if pulledDown > 0.33 {
            String(
                format: "Left eye pulled down %.1f stops so the two match. The shot is darker for it.",
                pulledDown
            )
        } else {
            nil
        }

        guard message != lensNotice else { return }

        // Only ever clears a notice this method put up. The right-eye-starved
        // messages are about frames not arriving at all, which matters more.
        if lensNotice != nil, notice == lensNotice { notice = nil }
        lensNotice = message
        if let message { notice = message }
    }

    private func reportRightEyeMisses() {
        let (count, reason) = drainRightEyeMisses()

        guard rightEncoder != nil else {
            telemetry.stereoSync = nil
            return
        }

        guard count > 0 else {
            telemetry.stereoSync = .paired
            if rightEyeStarved {
                rightEyeStarved = false
                if notice?.hasPrefix("Right eye") == true { notice = nil }
            }
            return
        }

        rightEyeStarved = true
        let message = switch reason {
        case .noUltraWideFrame:
            "Right eye: the ultra-wide is not delivering frames — both eyes are the wide camera."
        case .ultraRectifyFailed:
            "Right eye: the ultra-wide crop is failing, so only the wide camera is going out."
        case .wideRectifyFailed, nil:
            "Dropping frames: the wide camera's crop is failing."
        }

        telemetry.stereoSync = .starved(message)
        notice = message
    }

    /// Track the link, and give ground before the picture falls apart.
    ///
    /// Dropping frames keeps latency bounded but it looks like stuttering.
    /// Lowering the bitrate looks like softness. Softness is the better
    /// failure, so sustained drops buy a quality reduction rather than being
    /// allowed to continue.
    private func adapt(dropped: UInt64) {
        let floor = config.quality.defaultBitrate / 4
        let ceiling = config.bitrate

        if dropped > 0 || telemetry.thermal == .serious || telemetry.thermal == .critical {
            cleanWindows = 0
            congestedWindows += 1

            guard congestedWindows >= 3, currentBitrate > floor else { return }

            congestedWindows = 0
            currentBitrate = max(floor, Int(Double(currentBitrate) * 0.75))
            setBitrate(currentBitrate)
            notice = "Link is congested — dropped to \(currentBitrate / 1_000_000) Mbps."
            return
        }

        congestedWindows = 0
        cleanWindows += 1

        // Recover slowly. Climbing back as fast as we fell would oscillate.
        guard cleanWindows >= 15, currentBitrate < ceiling else { return }

        cleanWindows = 0
        currentBitrate = min(ceiling, Int(Double(currentBitrate) * 1.2))
        setBitrate(currentBitrate)
    }

    private func setBitrate(_ bitrate: Int) {
        leftEncoder?.setBitrate(bitrate)
        rightEncoder?.setBitrate(bitrate)
    }
}
