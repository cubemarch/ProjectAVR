import AVFoundation
import CoreMedia
import Foundation
import os

/// Runs both back cameras at once and hands out matched frame pairs.
///
/// `AVCaptureMultiCamSession` is the only way to get two cameras running
/// simultaneously on iOS, and it comes with real constraints: it needs an A12
/// or later, it will not accept a `sessionPreset`, and the formats each camera
/// can use are a restricted subset of what it offers on its own. So every
/// format here is chosen explicitly from the `isMultiCamSupported` list rather
/// than by asking for a preset and hoping.
///
/// The pairing is what makes this a stereo source rather than two videos. An
/// `AVCaptureDataOutputSynchronizer` holds each camera's frame until its
/// partner arrives and delivers both with the same presentation timestamp,
/// which is what lets the browser match the eyes back up by timestamp alone at
/// the far end of a network.
final class StereoCaptureSession: NSObject {
    /// A matched pair, straight from the sensors and not yet rectified.
    struct FramePair {
        let wide: CVPixelBuffer
        /// `nil` in mono mode, or when the ultra-wide dropped this frame.
        let ultraWide: CVPixelBuffer?
        let presentationTime: CMTime
    }

    struct Optics {
        let wideFovDegrees: Double
        let ultraWideFovDegrees: Double
        /// Physical separation of the two lenses, if it can be established.
        /// Informational only — the renderer does not use it.
        let baselineMillimetres: Double?
    }

    enum CaptureError: LocalizedError {
        case multiCamUnsupported
        case cameraUnavailable(String)
        case noCompatibleFormat(String)
        case connectionRefused(String)

        var errorDescription: String? {
            switch self {
            case .multiCamUnsupported:
                return "This device cannot run two cameras at once. Stereo capture needs an iPhone XS or later."
            case let .cameraUnavailable(name) where name == "microphone":
                return "No microphone is available on this device."
            case let .cameraUnavailable(name):
                return "The \(name) camera is not available on this device."
            case let .noCompatibleFormat(name):
                return "The \(name) camera has no format that works in multi-camera mode at this quality."
            case let .connectionRefused(detail):
                return "The capture session refused a connection: \(detail)."
            }
        }
    }

    /// What the graph actually ended up as, for the handshake to report.
    ///
    /// A multi-camera session has a large number of ways to come up degraded
    /// while reporting success — a format the system quietly substitutes, a
    /// hardware cost over budget, a runtime error delivered by notification
    /// long after `configure()` returned. None of them throw, and the symptom
    /// is always the same: one camera streams and the other never appears. This
    /// is sent in HELLO so the failure is legible in the server log instead of
    /// needing a device attached to Xcode.
    struct Diagnostics: Sendable {
        var multiCamSupported = AVCaptureMultiCamSession.isMultiCamSupported
        var stereoRequested = false
        var wideFormat: String?
        var ultraWideFormat: String?
        var hardwareCost: Float = 0
        var systemPressureCost: Float = 0
        var connectionCount = 0
        var ultraWideConnected = false
        var previewConnected = false
        var runtimeError: String?

        /// The operator asked for sound on this broadcast.
        var audioRequested = false
        /// A microphone is attached to the graph. False with
        /// ``audioRequested`` true is the diagnosis for a silent broadcast.
        var audioConnected = false
        /// Buffers the microphone has delivered since the graph was built.
        var audioBuffersSeen = 0
        /// Buffers the ultra-wide output has delivered since `start()`. Zero
        /// here with a healthy wide count is the whole diagnosis.
        var ultraWideBuffersSeen = 0
        var wideBuffersSeen = 0

        /// Times the system took the cameras away since the graph was built.
        var interruptions = 0

        /// Stereo pairs actually handed downstream.
        var pairsEmitted = 0
        /// Wide frames sent with no partner, because none arrived in time.
        var monoFallbacks = 0

        /// Closest the two cameras' timestamps have ever come, in seconds.
        ///
        /// Buffers arriving on both outputs while `pairsEmitted` stays at zero
        /// means the frames are fine and the *clocks* disagree. This is the
        /// number that says so, and says by how much.
        var closestSkewSeconds: Double?

        mutating func observeSkew(_ skew: Double) {
            closestSkewSeconds = Swift.min(closestSkewSeconds ?? .greatestFiniteMagnitude, skew)
        }
    }

    /// Delivered on `sampleQueue`.
    var onFramePair: ((FramePair) -> Void)?
    var onError: ((Error) -> Void)?

    /// One buffer of microphone PCM, delivered on `audioQueue`.
    ///
    /// A queue of its own rather than `sampleQueue`, because the video path on
    /// that queue does the rectification and submits to two hardware encoders.
    /// Audio behind that is audio arriving in bursts whenever the encoders have
    /// a slow frame, and a gap in sound is far more noticeable than a gap in
    /// picture.
    var onAudioSample: ((CMSampleBuffer) -> Void)?

    /// The viewfinder could not be wired up. Not fatal — the broadcast does not
    /// go through the preview layer — but it must be said, because a black
    /// viewfinder is indistinguishable from a camera that has stopped.
    var onPreviewFailure: ((String) -> Void)?

    /// The system took the cameras away, or gave them back.
    ///
    /// Delivered with a value when an interruption begins and `nil` when it
    /// ends. Called on an arbitrary queue — the notification centre's — so the
    /// receiver hops to the main actor itself.
    var onInterruption: ((Interruption?) -> Void)?

    /// Why the cameras stopped, in terms the operator can act on.
    ///
    /// Every case here is the system doing something legitimate, not a fault:
    /// a phone call arrived, another app asked for the camera, the phone got
    /// too hot, or the app was put into Split View. What they have in common is
    /// that frames stop arriving and nothing throws, so without this the
    /// broadcast keeps reporting "Live" over a frozen picture.
    struct Interruption: Equatable, Sendable {
        let reason: AVCaptureSession.InterruptionReason
        let message: String
        /// Whether waiting is likely to fix it. A backgrounded app gets its
        /// cameras back on return; a device that is too hot does not, until it
        /// cools.
        let resumesAutomatically: Bool

        init(reason: AVCaptureSession.InterruptionReason) {
            self.reason = reason

            switch reason {
            case .videoDeviceNotAvailableInBackground:
                message = "Capture paused because the app is in the background."
                resumesAutomatically = true
            case .audioDeviceInUseByAnotherClient:
                message = "Another app is using the microphone."
                resumesAutomatically = true
            case .videoDeviceInUseByAnotherClient:
                message = "Another app has taken the camera."
                resumesAutomatically = true
            case .videoDeviceNotAvailableWithMultipleForegroundApps:
                message = "The camera is unavailable while another app shares the screen. Close Split View or Slide Over."
                resumesAutomatically = true
            case .videoDeviceNotAvailableDueToSystemPressure:
                message = "The camera stopped because the phone is too hot. It will resume once it cools down."
                resumesAutomatically = false
            @unknown default:
                message = "Capture was interrupted by the system."
                resumesAutomatically = true
            }
        }
    }

    /// Populated once the session is configured; read by the handshake so the
    /// receiver knows what geometry it is being sent.
    private(set) var optics: Optics?
    private(set) var isRunning = false

    /// Guarded by `diagnosticsLock`: written from the capture queue and the
    /// notification centre, read from the main actor at handshake time.
    private var _diagnostics = Diagnostics()
    private let diagnosticsLock = NSLock()

    var diagnostics: Diagnostics {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _diagnostics
    }

    private func mutateDiagnostics(_ change: (inout Diagnostics) -> Void) {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        change(&_diagnostics)
    }

    let session: AVCaptureMultiCamSession
    let sampleQueue = DispatchQueue(label: "com.projectavr.capture.samples", qos: .userInitiated)
    let audioQueue = DispatchQueue(label: "com.projectavr.capture.audio", qos: .userInitiated)

    private let log = Logger(subsystem: "com.projectavr.capture", category: "capture")
    private let configurationQueue = DispatchQueue(label: "com.projectavr.capture.session")

    private var wideInput: AVCaptureDeviceInput?
    private var ultraWideInput: AVCaptureDeviceInput?
    private var microphoneInput: AVCaptureDeviceInput?
    private let wideOutput = AVCaptureVideoDataOutput()
    private let ultraWideOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private var stereo = true

    private var lensMatcher: LensMatcher?

    /// Extra exposure for the right eye, in stops. Applied to the matcher
    /// whenever it changes, and remembered so a rebuilt graph keeps it.
    var lensTrimStops: Double = 0 {
        didSet { lensMatcher?.trimStops = lensTrimStops }
    }

    /// How far short of a match the right eye is, in stops. Zero when matched,
    /// or when there is nothing to match.
    var lensShortfallStops: Double { lensMatcher?.shortfallStops ?? 0 }

    /// How far the left eye has been brought down to meet the right, in stops.
    var lensWideBiasStops: Double { lensMatcher?.wideBiasStops ?? 0 }

    /// Whether the ultra-wide is held to the wide camera's exposure and white
    /// balance. Off leaves both cameras on their own auto loops, which is only
    /// useful for seeing what the matching is doing.
    var matchLenses = true {
        didSet {
            guard matchLenses != oldValue, isRunning else { return }
            matchLenses ? lensMatcher?.start() : lensMatcher?.stop()
        }
    }

    /// Pairing state. Only ever touched on `sampleQueue`, which is serial.
    private var pendingWide: (buffer: CVPixelBuffer, time: CMTime)?
    private var pendingUltraWide: (buffer: CVPixelBuffer, time: CMTime)?
    private var pairingTolerance: Double = 1.0 / 60

    override init() {
        session = AVCaptureMultiCamSession()
        super.init()

        // A multi-cam session reports most of its real failures here rather
        // than by throwing — exceeding the hardware cost budget among them —
        // and with no observer they are simply never seen.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionRuntimeError(_:)),
            name: .AVCaptureSessionRuntimeError,
            object: session
        )

        // Interruptions are not errors and do not arrive as errors. Without
        // these two the app shows a frozen viewfinder and keeps telling the
        // server it is live, for as long as the phone call lasts.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionWasInterrupted(_:)),
            name: .AVCaptureSessionWasInterrupted,
            object: session
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionInterruptionEnded(_:)),
            name: .AVCaptureSessionInterruptionEnded,
            object: session
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func sessionRuntimeError(_ note: Notification) {
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
        let text = error.map { "\($0.localizedDescription) (code \($0.code))" } ?? "unknown"

        log.error("capture session runtime error: \(text, privacy: .public)")
        mutateDiagnostics { $0.runtimeError = text }

        if let error { onError?(error) }
    }

    @objc private func sessionWasInterrupted(_ note: Notification) {
        // The reason arrives as a boxed `Int`. An absent or unrecognised value
        // is still an interruption — frames have stopped either way — so it
        // falls back to the most benign case rather than being ignored.
        let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
        let reason = raw.flatMap(AVCaptureSession.InterruptionReason.init(rawValue:))
            ?? .videoDeviceNotAvailableInBackground

        let interruption = Interruption(reason: reason)
        log.notice("capture interrupted: \(interruption.message, privacy: .public)")

        mutateDiagnostics { $0.interruptions += 1 }
        onInterruption?(interruption)
    }

    @objc private func sessionInterruptionEnded(_ note: Notification) {
        log.notice("capture interruption ended")
        onInterruption?(nil)
    }

    // MARK: - Configuration

    /// Build the graph. Safe to call again to change quality; the session is
    /// stopped and rebuilt.
    ///
    /// - Parameter stereo: When false only the wide camera runs, which is a
    ///   great deal cheaper and is the right mode for framing a shot.
    /// - Parameter audio: When false no microphone input is added at all.
    ///   Deliberately not "add it and discard the samples": iOS lights the
    ///   orange recording indicator and lists the app under Settings › Privacy
    ///   for as long as a microphone is attached, and an app that does that
    ///   while sending no sound is claiming access it is not using.
    func configure(quality: CaptureConfig.Quality, frameRate: Int, stereo: Bool, audio: Bool) throws {
        guard AVCaptureMultiCamSession.isMultiCamSupported || !stereo else {
            throw CaptureError.multiCamUnsupported
        }

        self.stereo = stereo

        session.beginConfiguration()
        defer { session.commitConfiguration() }

        teardownGraph()

        let wideDevice = try device(.builtInWideAngleCamera, name: "wide")
        let wideFormat = try format(for: wideDevice, quality: quality, frameRate: frameRate, name: "wide")
        try apply(wideFormat, frameRate: frameRate, to: wideDevice)

        wideInput = try attach(wideDevice, output: wideOutput, name: "wide")

        var ultraFov: Double?
        var baseline: Double?
        var ultraFormatDescription: String?

        if stereo {
            let ultraDevice = try device(.builtInUltraWideCamera, name: "ultra-wide")
            let ultraFormat = try format(
                for: ultraDevice, quality: quality, frameRate: frameRate, name: "ultra-wide"
            )
            try apply(ultraFormat, frameRate: frameRate, to: ultraDevice)

            ultraWideInput = try attach(ultraDevice, output: ultraWideOutput, name: "ultra-wide")

            ultraFov = Double(ultraFormat.videoFieldOfView)
            ultraFormatDescription = Self.describe(ultraFormat)
            baseline = Self.baseline(wide: wideDevice, ultraWide: ultraDevice)

            // Built here rather than in `init` because it needs both devices,
            // and which devices those are is only settled once a format has
            // been chosen for each.
            lensMatcher = LensMatcher(
                wide: wideDevice,
                ultraWide: ultraDevice,
                queue: configurationQueue
            )
            lensMatcher?.trimStops = lensTrimStops

            // Both outputs deliver independently and are paired by timestamp in
            // `captureOutput(_:didOutput:from:)`.
            //
            // This used to be an `AVCaptureDataOutputSynchronizer`, which reads
            // as the obvious tool and did not work: with a correct graph - two
            // active connections, valid matched formats, hardware cost at half
            // budget, no runtime error - it delivered the master output's
            // frames and `nil` for the ultra-wide on every single callback.
            // Apple's own multi-camera sample code pairs two video data outputs
            // by hand for the same reason. The synchroniser is built for
            // outputs of *different* kinds on one camera, such as video plus
            // depth, rather than two cameras' video.
            wideOutput.setSampleBufferDelegate(self, queue: sampleQueue)
            ultraWideOutput.setSampleBufferDelegate(self, queue: sampleQueue)

            // Half a frame interval. Wide and ultra-wide are driven from the
            // same clock and normally land within a millisecond of each other;
            // this is loose enough to absorb jitter and tight enough that a
            // genuinely stale frame is never paired into a stereo image.
            pairingTolerance = 0.5 / Double(frameRate)
        } else {
            wideOutput.setSampleBufferDelegate(self, queue: sampleQueue)
        }

        // After the cameras, so a microphone that cannot be attached does not
        // cost the operator the picture as well. A broadcast without sound is
        // a degraded broadcast; a broadcast without video is not one.
        let audioConnected = audio ? attachMicrophone() : false

        optics = Optics(
            wideFovDegrees: Double(wideFormat.videoFieldOfView),
            ultraWideFovDegrees: ultraFov ?? Double(wideFormat.videoFieldOfView),
            baselineMillimetres: baseline
        )

        // Above 1.0 the system will start throttling frame rates on its own.
        // Surfacing it is more useful than letting the operator discover it as
        // an unexplained stutter twenty minutes into a shoot.
        if session.hardwareCost > 1 || session.systemPressureCost > 1 {
            log.warning(
                "capture cost over budget: hardware \(self.session.hardwareCost), pressure \(self.session.systemPressureCost)"
            )
        }

        let ultraConnected = session.connections.contains { connection in
            connection.output === ultraWideOutput && connection.isEnabled && connection.isActive
        }

        mutateDiagnostics {
            $0.stereoRequested = stereo
            $0.wideFormat = Self.describe(wideFormat)
            $0.ultraWideFormat = stereo ? ultraFormatDescription : nil
            $0.hardwareCost = session.hardwareCost
            $0.systemPressureCost = session.systemPressureCost
            $0.connectionCount = session.connections.count
            $0.ultraWideConnected = ultraConnected
            // `teardownGraph()` dropped every connection, the preview's
            // included, so it is not connected again until the view re-attaches.
            $0.previewConnected = false
            $0.ultraWideBuffersSeen = 0
            $0.wideBuffersSeen = 0
            $0.pairsEmitted = 0
            $0.monoFallbacks = 0
            $0.interruptions = 0
            $0.closestSkewSeconds = nil
            $0.audioRequested = audio
            $0.audioConnected = audioConnected
            $0.audioBuffersSeen = 0
        }

        log.info("""
            graph built: stereo=\(stereo, privacy: .public) \
            wide=\(Self.describe(wideFormat), privacy: .public) \
            ultra=\(ultraFormatDescription ?? "none", privacy: .public) \
            audio=\(audioConnected, privacy: .public) \
            cost=\(self.session.hardwareCost, privacy: .public) \
            connections=\(self.session.connections.count, privacy: .public) \
            ultraConnected=\(ultraConnected, privacy: .public)
            """)
    }

    /// Add the microphone, by hand, like everything else on this session.
    ///
    /// - Returns: Whether sound will actually be captured. Never throws: every
    ///   way this can fail leaves a working silent broadcast, and turning one
    ///   of them into a thrown error would mean a phone with a blocked
    ///   microphone cannot go on air at all.
    private func attachMicrophone() -> Bool {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            log.notice("microphone access not granted; broadcasting without sound")
            return false
        }

        guard let device = AVCaptureDevice.default(for: .audio) else {
            log.notice("no microphone on this device")
            return false
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)

            guard session.canAddInput(input) else {
                log.error("the session refused the microphone input")
                return false
            }
            session.addInputWithNoConnections(input)

            guard session.canAddOutput(audioOutput) else {
                log.error("the session refused the microphone output")
                session.removeInput(input)
                return false
            }
            session.addOutputWithNoConnections(audioOutput)

            // The microphone has no position, so the precise lookup the cameras
            // use does not apply; there is exactly one audio port on this input.
            guard let port = input.ports.first(where: { $0.mediaType == .audio }) else {
                log.error("the microphone input has no audio port")
                session.removeOutput(audioOutput)
                session.removeInput(input)
                return false
            }

            let connection = AVCaptureConnection(inputPorts: [port], output: audioOutput)

            guard session.canAddConnection(connection) else {
                log.error("the session refused the microphone connection")
                session.removeOutput(audioOutput)
                session.removeInput(input)
                return false
            }
            session.addConnection(connection)

            audioOutput.setSampleBufferDelegate(self, queue: audioQueue)
            microphoneInput = input

            log.info("microphone connected: \(device.localizedName, privacy: .public)")
            return true
        } catch {
            log.error("microphone unavailable: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// `1920x1080@60 binned` — enough to spot a substituted format.
    private static func describe(_ format: AVCaptureDevice.Format) -> String {
        let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let rate = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0

        var text = "\(size.width)x\(size.height)@\(Int(rate))"
        if format.isVideoBinned { text += " binned" }
        if !format.isMultiCamSupported { text += " NOT-MULTICAM" }
        return text
    }

    private func device(_ type: AVCaptureDevice.DeviceType, name: String) throws -> AVCaptureDevice {
        guard let device = AVCaptureDevice.default(type, for: .video, position: .back) else {
            throw CaptureError.cameraUnavailable(name)
        }
        return device
    }

    /// Pick the smallest multi-cam format that covers the requested size.
    ///
    /// Smallest rather than largest: a bigger sensor readout costs power and
    /// thermal headroom for detail that is thrown away at the encoder's output
    /// resolution anyway, and thermal headroom is what decides whether a
    /// broadcast survives past ten minutes.
    private func format(
        for device: AVCaptureDevice,
        quality: CaptureConfig.Quality,
        frameRate: Int,
        name: String
    ) throws -> AVCaptureDevice.Format {
        let wanted = quality.size

        let candidates = device.formats.filter { candidate in
            guard candidate.isMultiCamSupported || !stereo else { return false }

            let dimensions = CMVideoFormatDescriptionGetDimensions(candidate.formatDescription)
            guard dimensions.width >= Int32(wanted.width), dimensions.height >= Int32(wanted.height) else {
                return false
            }

            guard candidate.videoSupportedFrameRateRanges.contains(where: {
                $0.maxFrameRate >= Double(frameRate) - 0.1
            }) else {
                return false
            }

            // Binned formats read fewer sensor lines: cooler, and at these
            // output sizes visually indistinguishable.
            return CMFormatDescriptionGetMediaSubType(candidate.formatDescription)
                == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        }

        let best = candidates.min { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return Int(da.width) * Int(da.height) < Int(db.width) * Int(db.height)
        }

        guard let best else { throw CaptureError.noCompatibleFormat(name) }

        return best
    }

    private func apply(_ format: AVCaptureDevice.Format, frameRate: Int, to device: AVCaptureDevice) throws {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }

        device.activeFormat = format

        // Pinning both the min and max duration holds the frame rate steady.
        // Left to itself the camera drops the rate in dim light, which on a
        // live stream reads as the stream breaking up rather than as an
        // exposure decision — and would desynchronise the two eyes.
        let duration = CMTime(value: 1, timescale: CMTimeScale(frameRate))
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
    }

    private func attach(
        _ device: AVCaptureDevice,
        output: AVCaptureVideoDataOutput,
        name: String
    ) throws -> AVCaptureDeviceInput {
        let input = try AVCaptureDeviceInput(device: device)

        // `addInput` would wire up connections automatically and, with two
        // cameras present, wire them up wrongly — both outputs can end up fed
        // by the same camera. Adding without connections and building each one
        // by hand is the only way to be certain which sensor feeds which eye.
        guard session.canAddInput(input) else {
            throw CaptureError.connectionRefused("\(name) input")
        }
        session.addInputWithNoConnections(input)

        // Each output is delivered to on its own, so dropping late frames is
        // the right behaviour: it stops latency accumulating when the encoder
        // falls behind. The pairing logic holds at most one ultra-wide buffer,
        // which is not enough to starve the pool.
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ]

        guard session.canAddOutput(output) else {
            throw CaptureError.connectionRefused("\(name) output")
        }
        session.addOutputWithNoConnections(output)

        guard let port = input.ports(
            for: .video,
            sourceDeviceType: device.deviceType,
            sourceDevicePosition: device.position
        ).first else {
            throw CaptureError.connectionRefused("\(name) port")
        }

        let connection = AVCaptureConnection(inputPorts: [port], output: output)

        guard session.canAddConnection(connection) else {
            throw CaptureError.connectionRefused("\(name) connection")
        }
        session.addConnection(connection)

        // The app is landscape-locked, so the sensor's native orientation is
        // already the one wanted and no rotation is applied. Rotating here
        // would also cost a full-frame copy per eye per frame.
        if connection.isVideoRotationAngleSupported(0) {
            connection.videoRotationAngle = 0
        }

        connection.isVideoMirrored = false

        return input
    }

    /// Attach a preview layer to one of the cameras.
    ///
    /// - Parameter useUltraWide: Which sensor to show. In stereo mode this is
    ///   the wide camera, because its field of view is what the broadcast will
    ///   actually cover once the ultra-wide has been cropped to match it.
    func attachPreview(_ layer: AVCaptureVideoPreviewLayer, useUltraWide: Bool = false) {
        // Required, and the reason the viewfinder was black. Setting
        // `layer.session` would make the *session* build a connection, which a
        // multi-cam session refuses to do — so the layer has to be told which
        // session it belongs to without one, and then be given a connection by
        // hand below. Skip this and `canAddConnection` rejects the connection,
        // or accepts it and renders nothing; either way there is no error and
        // no frames.
        //
        // Called here rather than on `configurationQueue` because it touches a
        // `CALayer`, and `attachPreview` is called from `makeUIView`, on main.
        layer.setSessionWithNoConnection(session)

        configurationQueue.async { [weak self] in
            guard let self else { return }

            guard let input = useUltraWide ? self.ultraWideInput : self.wideInput else {
                self.log.error("preview attached before the graph was built")
                self.onPreviewFailure?("The viewfinder was attached before the cameras were ready.")
                return
            }

            // The same precise lookup the data outputs use, and for the same
            // reason. `input.ports.first(where: video)` is not equivalent: a
            // multi-camera input can vend several video ports, and the first
            // one is not reliably the sensor this input was created for. The
            // connection is then made against a port that produces nothing and
            // the viewfinder stays black, with no error anywhere.
            guard let port = input.ports(
                for: .video,
                sourceDeviceType: input.device.deviceType,
                sourceDevicePosition: input.device.position
            ).first else {
                self.log.error("no video port for the preview")
                self.onPreviewFailure?("The viewfinder could not find a camera to show.")
                return
            }

            self.session.beginConfiguration()
            defer { self.session.commitConfiguration() }

            // SwiftUI can rebuild the representable, and a stale connection to
            // a discarded layer still counts against the session's budget.
            // Connections to *this* layer are left alone: re-adding one the
            // layer already has would drop the live viewfinder to add it back.
            for existing in self.session.connections {
                guard let existingLayer = existing.videoPreviewLayer else { continue }
                if existingLayer === layer { return }
                self.session.removeConnection(existing)
            }

            let connection = AVCaptureConnection(inputPort: port, videoPreviewLayer: layer)
            guard self.session.canAddConnection(connection) else {
                // Says nothing about why, and the symptom is a black rectangle
                // that looks like a dead camera, so it goes on screen too.
                self.log.error("the session refused the preview connection")
                self.onPreviewFailure?("The viewfinder could not be connected. The broadcast is unaffected.")
                return
            }
            self.session.addConnection(connection)

            self.mutateDiagnostics { $0.previewConnected = true }
            self.log.info("preview connected to \(input.device.localizedName, privacy: .public)")
        }
    }

    private func teardownGraph() {
        // Before the devices go away, so the ultra-wide is handed back its own
        // auto-exposure rather than staying locked to a stale reading.
        lensMatcher?.stop()
        lensMatcher = nil

        wideOutput.setSampleBufferDelegate(nil, queue: nil)
        ultraWideOutput.setSampleBufferDelegate(nil, queue: nil)
        audioOutput.setSampleBufferDelegate(nil, queue: nil)

        // Drop held frames on the queue that owns them, so a rebuild cannot
        // pair a buffer from the previous graph into the new one.
        sampleQueue.sync {
            pendingWide = nil
            pendingUltraWide = nil
        }

        // And wait out any microphone buffer already in flight, for the same
        // reason: the encoder it would be handed to is about to be replaced.
        audioQueue.sync {}

        for connection in session.connections {
            session.removeConnection(connection)
        }
        for output in session.outputs {
            session.removeOutput(output)
        }
        for input in session.inputs {
            session.removeInput(input)
        }

        wideInput = nil
        ultraWideInput = nil
        microphoneInput = nil
    }

    // MARK: - Running

    func start() {
        configurationQueue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
            self.isRunning = self.session.isRunning

            // Only once the session is running: the wide camera has no exposure
            // to copy until it has metered a scene.
            if self.isRunning, self.matchLenses { self.lensMatcher?.start() }
        }
    }

    func stop() {
        lensMatcher?.stop()

        configurationQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
            self.isRunning = false
        }
    }

    // MARK: - Optics

    /// Estimate the lens separation from the camera extrinsics, where iOS will
    /// provide them.
    ///
    /// Only some device/format combinations expose an extrinsic matrix, so this
    /// returns `nil` more often than not. It is reported to the receiver purely
    /// as metadata — nothing downstream depends on having it.
    private static func baseline(wide: AVCaptureDevice, ultraWide: AVCaptureDevice) -> Double? {
        guard
            let data = AVCaptureDevice.extrinsicMatrix(from: ultraWide, to: wide)
        else {
            return nil
        }

        // A 4x3 row-major matrix of Float32: three rows of rotation, then a
        // translation column in millimetres.
        let floats = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        guard floats.count >= 12 else { return nil }

        let x = Double(floats[9])
        let y = Double(floats[10])
        let z = Double(floats[11])

        let distance = (x * x + y * y + z * z).squareRoot()

        // Sanity bound: the lenses are centimetres apart at most, so anything
        // outside this means the matrix was not what was assumed.
        return (distance > 0 && distance < 100) ? distance : nil
    }
}

// MARK: - Delivery
//
// Both cameras call in here on `sampleQueue`, which is serial, so the pairing
// state below needs no lock of its own. The microphone calls in on `audioQueue`
// and touches none of it.
//
// One method serves both delegate protocols because they declare the same
// selector; which output a buffer came from is established by identity rather
// than by media type, since that is the only thing that distinguishes the two
// cameras from each other anyway.

extension StereoCaptureSession: AVCaptureVideoDataOutputSampleBufferDelegate,
                                AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        if output === audioOutput {
            mutateDiagnostics { $0.audioBuffersSeen += 1 }
            onAudioSample?(sampleBuffer)
            return
        }

        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        if output === ultraWideOutput {
            mutateDiagnostics { $0.ultraWideBuffersSeen += 1 }
            deliverUltraWide(buffer, at: time)
        } else if output === wideOutput {
            mutateDiagnostics { $0.wideBuffersSeen += 1 }
            deliverWide(buffer, at: time)
        }
    }

    /// Both sides are buffered, because either camera can arrive first.
    ///
    /// Holding only the ultra-wide and emitting on the wide's arrival cannot
    /// work: when the cameras interleave as wide(t0), ultra(t0), wide(t1),
    /// ultra(t1), the held ultra-wide is always a full frame behind the wide
    /// being matched against it — 33 ms at 30 fps, against a tolerance that has
    /// to stay under a frame interval to mean anything. Nothing ever pairs, and
    /// the right eye is silently never sent.
    private func deliverWide(_ buffer: CVPixelBuffer, at time: CMTime) {
        if let pending = pendingUltraWide, pairs(pending.time, time) {
            pendingUltraWide = nil
            emit(wide: buffer, ultraWide: pending.buffer, at: time)
            return
        }

        // No partner yet. Flush a wide frame that has been waiting since last
        // time, so a stalled ultra-wide degrades to mono rather than freezing
        // the broadcast outright.
        if let stale = pendingWide {
            mutateDiagnostics { $0.monoFallbacks += 1 }
            emit(wide: stale.buffer, ultraWide: nil, at: stale.time)
        }

        pendingWide = (buffer, time)
    }

    private func deliverUltraWide(_ buffer: CVPixelBuffer, at time: CMTime) {
        if let pending = pendingWide, pairs(pending.time, time) {
            pendingWide = nil
            // The wide camera's timestamp is the pair's timestamp, so the
            // stream's clock never depends on which eye arrived second.
            emit(wide: pending.buffer, ultraWide: buffer, at: pending.time)
            return
        }

        pendingUltraWide = (buffer, time)
    }

    private func pairs(_ a: CMTime, _ b: CMTime) -> Bool {
        let skew = abs(CMTimeGetSeconds(CMTimeSubtract(a, b)))
        mutateDiagnostics { $0.observeSkew(skew) }
        return skew <= pairingTolerance
    }

    private func emit(wide: CVPixelBuffer, ultraWide: CVPixelBuffer?, at time: CMTime) {
        if ultraWide != nil { mutateDiagnostics { $0.pairsEmitted += 1 } }
        onFramePair?(FramePair(wide: wide, ultraWide: ultraWide, presentationTime: time))
    }
}
