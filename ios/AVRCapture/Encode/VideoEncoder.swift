import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os

/// One hardware encoder. A stereo broadcast runs two of these — one per eye.
///
/// This is the reason the "encoder server" in the original design is a relay
/// instead: two uncompressed 1080p30 streams are about 1.5 Gbps, which no Wi-Fi
/// link is going to carry. Compression has to happen before the bytes leave the
/// phone, and the phone has dedicated silicon for exactly that.
///
/// Every setting below is chosen for latency over efficiency. The two that
/// matter most are `RealTime`, which tells VideoToolbox to return a frame in
/// bounded time rather than to use its whole budget, and
/// `AllowFrameReordering: false`, which forbids B-frames. B-frames would buy a
/// useful chunk of bitrate but they require the decoder to hold frames back
/// waiting for a future reference, which adds a fixed delay to every frame in
/// a live stream.
final class VideoEncoder {
    struct Configuration {
        var codec: NALUnit.Codec = .h264
        var width: Int = 1920
        var height: Int = 1080
        var frameRate: Int = 30
        var bitrate: Int = 8_000_000
        /// Seconds between keyframes. Also the worst-case wait for a viewer
        /// who opens the monitor mid-broadcast.
        var keyframeInterval: Double = 2
    }

    /// Emitted whenever the format description changes, which in practice means
    /// once at the start and again if the encoder is reset.
    struct Config {
        let codecString: String
        let parameterSets: Data
        let width: Int
        let height: Int
    }

    struct Sample {
        let data: Data
        let timestampMicroseconds: UInt64
        let isKeyframe: Bool
    }

    enum EncoderError: Error, CustomStringConvertible {
        case sessionCreation(OSStatus)
        case property(String, OSStatus)
        case encode(OSStatus)

        var description: String {
            switch self {
            case let .sessionCreation(status):
                return "could not create a compression session (\(status))"
            case let .property(key, status):
                return "encoder rejected \(key) (\(status))"
            case let .encode(status):
                return "encode failed (\(status))"
            }
        }
    }

    /// Called on `outputQueue`. Both eyes share one queue so their frames reach
    /// the socket in a deterministic order rather than racing.
    var onConfig: ((Config) -> Void)?
    var onSample: ((Sample) -> Void)?
    var onError: ((Error) -> Void)?

    private let label: String
    private let outputQueue: DispatchQueue
    private let log = Logger(subsystem: "com.projectavr.capture", category: "encoder")

    private var session: VTCompressionSession?
    private var configuration: Configuration
    private var nalLengthSize = 4
    private var lastFormatDescription: CMFormatDescription?

    /// Guards `session` and the format-description cache. The encode call comes
    /// from the capture queue while the output handler runs on a VideoToolbox
    /// thread, so the two genuinely overlap.
    private let lock = NSLock()

    init(label: String, configuration: Configuration, outputQueue: DispatchQueue) {
        self.label = label
        self.configuration = configuration
        self.outputQueue = outputQueue
    }

    deinit {
        teardown()
    }

    // MARK: - Lifecycle

    func prepare() throws {
        lock.lock()
        defer { lock.unlock() }

        try createSession()
    }

    /// Tear the session down and build a fresh one.
    ///
    /// Needed after `kVTInvalidSessionErr`, which the system raises when it
    /// reclaims the encoder — most commonly when the app is backgrounded and
    /// returns, or when another process takes the hardware.
    func reset() {
        lock.lock()
        defer { lock.unlock() }

        destroySession()
        lastFormatDescription = nil

        do {
            try createSession()
        } catch {
            outputQueue.async { [onError] in onError?(error) }
        }
    }

    func teardown() {
        lock.lock()
        defer { lock.unlock() }

        destroySession()
    }

    /// Change the target bitrate mid-broadcast without a reset.
    ///
    /// The network layer drives this: sustained backpressure means the link
    /// cannot carry what we are producing, and lowering quality keeps the
    /// stream live where dropping frames would make it stutter.
    func setBitrate(_ bitrate: Int) {
        lock.lock()
        defer { lock.unlock() }

        configuration.bitrate = bitrate
        guard let session else { return }

        setProperty(session, kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
        setDataRateLimits(session, bitrate: bitrate)
    }

    // MARK: - Encoding

    /// Submit one frame.
    ///
    /// - Parameters:
    ///   - pixelBuffer: Already rectified to the output dimensions.
    ///   - presentationTime: The capture timestamp, shared with the other eye.
    ///   - forceKeyframe: Used to align the two eyes' first keyframe so a
    ///     viewer does not sit with one eye black waiting for the other.
    func encode(
        _ pixelBuffer: CVPixelBuffer,
        presentationTime: CMTime,
        duration: CMTime = .invalid,
        forceKeyframe: Bool = false
    ) {
        lock.lock()
        guard let session else {
            lock.unlock()
            return
        }
        lock.unlock()

        let properties: CFDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
            : nil

        // The block form rather than a C output callback: the callback variant
        // needs an unmanaged pointer to self whose lifetime has to outlive a
        // session that VideoToolbox may still be draining, and getting that
        // wrong is a use-after-free rather than a visible bug.
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: duration,
            frameProperties: properties,
            infoFlagsOut: nil
        ) { [weak self] status, flags, sampleBuffer in
            self?.handleOutput(status: status, flags: flags, sampleBuffer: sampleBuffer)
        }

        if status == kVTInvalidSessionErr {
            log.error("\(self.label, privacy: .public) encoder invalidated, rebuilding")
            reset()
        } else if status != noErr {
            outputQueue.async { [onError] in onError?(EncoderError.encode(status)) }
        }
    }

    /// Flush anything in flight. Called when the broadcast stops.
    func finish() {
        lock.lock()
        let session = self.session
        lock.unlock()

        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    }

    private func handleOutput(status: OSStatus, flags: VTEncodeInfoFlags, sampleBuffer: CMSampleBuffer?) {
        guard status == noErr else {
            outputQueue.async { [onError] in onError?(EncoderError.encode(status)) }
            return
        }

        // A dropped frame is reported as success with no buffer. Under
        // sustained thermal pressure this is normal and not worth surfacing.
        guard !flags.contains(.frameDropped), let sampleBuffer,
              CMSampleBufferDataIsReady(sampleBuffer)
        else {
            return
        }

        let keyframe = NALUnit.isKeyframe(sampleBuffer)

        var config: Config?

        if let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) {
            lock.lock()
            let changed = lastFormatDescription.map { !CMFormatDescriptionEqual($0, otherFormatDescription: formatDescription) } ?? true
            if changed {
                lastFormatDescription = formatDescription
                nalLengthSize = NALUnit.nalLengthSize(of: formatDescription, codec: configuration.codec)
            }
            let lengthSize = nalLengthSize
            let codec = configuration.codec
            lock.unlock()

            if changed {
                config = makeConfig(formatDescription, codec: codec)
            }

            emit(sampleBuffer, keyframe: keyframe, lengthSize: lengthSize, codec: codec, config: config)
        }
    }

    private func makeConfig(_ formatDescription: CMFormatDescription, codec: NALUnit.Codec) -> Config? {
        guard
            let codecString = NALUnit.codecString(for: formatDescription, codec: codec),
            let parameterSets = NALUnit.parameterSets(from: formatDescription, codec: codec)
        else {
            return nil
        }

        let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)

        return Config(
            codecString: codecString,
            parameterSets: parameterSets,
            width: Int(dimensions.width),
            height: Int(dimensions.height)
        )
    }

    private func emit(
        _ sampleBuffer: CMSampleBuffer,
        keyframe: Bool,
        lengthSize: Int,
        codec: NALUnit.Codec,
        config: Config?
    ) {
        guard var payload = NALUnit.annexB(from: sampleBuffer, nalLengthSize: lengthSize) else { return }

        // Parameter sets ahead of every keyframe, not just the first. A viewer
        // who joins thirty seconds in has no other way to get them, and at two
        // seconds between keyframes this costs on the order of 20 bytes/second.
        if keyframe, let sets = currentParameterSets(codec: codec) {
            payload = sets + payload
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let microseconds = pts.isNumeric ? UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000)) : 0

        let sample = Sample(data: payload, timestampMicroseconds: microseconds, isKeyframe: keyframe)

        outputQueue.async { [onConfig, onSample] in
            if let config { onConfig?(config) }
            onSample?(sample)
        }
    }

    private func currentParameterSets(codec: NALUnit.Codec) -> Data? {
        lock.lock()
        let formatDescription = lastFormatDescription
        lock.unlock()

        guard let formatDescription else { return nil }
        return NALUnit.parameterSets(from: formatDescription, codec: codec)
    }

    // MARK: - Session construction

    private func createSession() throws {
        destroySession()

        // Low-latency rate control is a different algorithm, not a tuning knob:
        // it holds a tighter instantaneous bitrate so a keyframe does not
        // produce a burst the link cannot drain. Apple Silicon only, so a
        // failure here is not fatal — the session is retried without it.
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!
        ]

        var created: VTCompressionSession?
        var status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(configuration.width),
            height: Int32(configuration.height),
            codecType: configuration.codec.videoToolboxType,
            encoderSpecification: specification as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )

        if status != noErr {
            log.notice("\(self.label, privacy: .public) low-latency rate control unavailable, falling back")
            status = VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: Int32(configuration.width),
                height: Int32(configuration.height),
                codecType: configuration.codec.videoToolboxType,
                encoderSpecification: nil,
                imageBufferAttributes: nil,
                compressedDataAllocator: nil,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &created
            )
        }

        guard status == noErr, let created else {
            throw EncoderError.sessionCreation(status)
        }

        configure(created)
        VTCompressionSessionPrepareToEncodeFrames(created)

        session = created
    }

    private func configure(_ session: VTCompressionSession) {
        setProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        setProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        setProperty(session, kVTCompressionPropertyKey_AverageBitRate, configuration.bitrate as CFNumber)
        setProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, configuration.frameRate as CFNumber)

        let interval = max(1, Int(configuration.keyframeInterval * Double(configuration.frameRate)))
        setProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, interval as CFNumber)
        setProperty(
            session,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            configuration.keyframeInterval as CFNumber
        )

        setDataRateLimits(session, bitrate: configuration.bitrate)

        switch configuration.codec {
        case .h264:
            setProperty(
                session,
                kVTCompressionPropertyKey_ProfileLevel,
                kVTProfileLevel_H264_High_AutoLevel
            )
            setProperty(
                session,
                kVTCompressionPropertyKey_H264EntropyMode,
                kVTH264EntropyMode_CABAC
            )
        case .hevc:
            setProperty(
                session,
                kVTCompressionPropertyKey_ProfileLevel,
                kVTProfileLevel_HEVC_Main_AutoLevel
            )
        }
    }

    /// A hard ceiling over a one-second window, on top of the average target.
    ///
    /// Without this a keyframe can be several times the average frame size and
    /// arrive as a burst, which on a congested Wi-Fi link shows up as a
    /// periodic stall exactly at the keyframe interval.
    private func setDataRateLimits(_ session: VTCompressionSession, bitrate: Int) {
        let bytesPerSecond = Double(bitrate) / 8 * 1.5
        let limits = [bytesPerSecond, 1.0] as CFArray

        setProperty(session, kVTCompressionPropertyKey_DataRateLimits, limits)
    }

    @discardableResult
    private func setProperty(_ session: VTCompressionSession, _ key: CFString, _ value: CFTypeRef) -> Bool {
        let status = VTSessionSetProperty(session, key: key, value: value)

        if status != noErr {
            // Not fatal. Encoders differ in what they accept, and a rejected
            // tuning property still leaves a working session.
            log.notice("\(self.label, privacy: .public) rejected \(key as String, privacy: .public): \(status)")
        }

        return status == noErr
    }

    private func destroySession() {
        guard let session else { return }

        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }
}
