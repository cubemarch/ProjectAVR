import AudioToolbox
import CoreMedia
import Foundation
import os

/// Microphone PCM in, AAC-LC access units out.
///
/// The counterpart to ``VideoEncoder``, and much the smaller problem: audio is
/// three orders of magnitude less data and the hardware encoder is a single
/// AudioToolbox object rather than a session with a lifecycle. What makes it
/// fiddly is not the compression, it is the arithmetic around it.
///
/// **AAC works in fixed blocks of 1024 frames and the microphone does not.** A
/// capture callback delivers whatever the audio unit had ready, which is
/// usually but by no means always 1024. So PCM accumulates in ``pending`` and
/// is drawn off a block at a time; the remainder waits for the next callback.
///
/// **Each block needs a timestamp the video can be matched against.** Both come
/// off the same `AVCaptureSession` clock, so they are directly comparable — but
/// only if the audio clock is advanced by the samples actually consumed rather
/// than by the arrival time of the buffer they came in. ``pendingStartMicros``
/// tracks the capture time of the frame at the head of ``pending`` and moves
/// forward exactly one block at a time. A gap in the input — an interruption, a
/// route change — is detected by comparing the incoming buffer's timestamp
/// against where the clock had got to, and re-anchors rather than letting every
/// subsequent packet inherit the drift.
///
/// **AAC-LC and nothing else.** `kAudioFormatMPEG4AAC` is decoded by every
/// browser that implements WebCodecs at all; HE-AAC is not, and the bandwidth
/// it saves is a rounding error next to two 1080p video tracks.
final class AudioEncoder {
    /// Emitted once, before any packet, and again if the encoder is rebuilt.
    struct Config {
        let codecString: String
        /// The `AudioSpecificConfig`. Goes on the wire base64-encoded, because
        /// CONFIG frames are JSON.
        let description: Data
        let sampleRate: Int
        let channels: Int
    }

    struct Packet {
        let data: Data
        let timestampMicroseconds: UInt64
        /// True when a gap preceded this packet, so the wire frame can be
        /// flagged and the far end can stop trying to play through it.
        let discontinuity: Bool
    }

    enum EncoderError: Error, CustomStringConvertible {
        case converterCreation(OSStatus)
        case convert(OSStatus)
        case unsupportedInput(String)
        case indescribableOutput(Double, Int)

        var description: String {
            switch self {
            case let .converterCreation(status):
                return "could not create an AAC encoder (\(status))"
            case let .convert(status):
                return "AAC encode failed (\(status))"
            case let .unsupportedInput(detail):
                return "the microphone delivered audio this app cannot read: \(detail)"
            case let .indescribableOutput(rate, channels):
                return "cannot describe \(Int(rate)) Hz, \(channels) channel audio to a decoder"
            }
        }
    }

    /// Frames per AAC access unit. Fixed by the format, not a choice.
    static let framesPerPacket = 1024

    /// Per channel. 64 kbit/s of AAC-LC is transparent enough for speech and
    /// room tone, which is what a camera microphone produces, and it is
    /// invisible beside an 8 Mbit/s video track.
    static let bitratePerChannel = 64_000

    /// Called on `outputQueue`, the same queue the video encoders emit on, so
    /// audio and video reach the socket in a deterministic order.
    var onConfig: ((Config) -> Void)?
    var onPacket: ((Packet) -> Void)?
    var onError: ((Error) -> Void)?

    private let outputQueue: DispatchQueue
    private let log = Logger(subsystem: "com.projectavr.capture", category: "audio")

    /// Serialises everything below. The capture callback arrives on the audio
    /// output's queue while `teardown()` comes from the main actor.
    private let lock = NSLock()

    private var converter: AudioConverterRef?
    private var sampleRate: Double = 0
    private var channels = 0
    private var announced = false

    /// Interleaved 16-bit PCM waiting to make up a whole block.
    private var pending: [Int16] = []

    /// Capture time of the frame at the head of ``pending``, or `nil` when it
    /// is empty and the clock has nothing to anchor to.
    private var pendingStartMicros: UInt64?

    /// Set when a gap is detected, consumed by the next packet emitted.
    private var gapPending = false

    /// Handed to the converter's input callback. Allocated once and reused: the
    /// callback must hand out memory that stays put for the duration of the
    /// conversion, which a Swift `Array`'s storage does not promise to do.
    private var scratch: UnsafeMutableRawPointer?
    private var scratchBytes = 0
    private var scratchFramesAvailable = 0

    init(outputQueue: DispatchQueue) {
        self.outputQueue = outputQueue
    }

    deinit {
        // Not `teardown()`: taking a lock in `deinit` is a deadlock waiting for
        // a reentrant path, and by definition nothing else holds a reference.
        if let converter { AudioConverterDispose(converter) }
        if let scratch { scratch.deallocate() }
    }

    // MARK: - Intake

    /// Submit one buffer from `AVCaptureAudioDataOutput`.
    func encode(_ sampleBuffer: CMSampleBuffer) {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee
        else {
            report(EncoderError.unsupportedInput("no format description"))
            return
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let micros = pts.isNumeric ? UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000)) : 0

        // The buffer list is sized by asking first rather than by declaring one
        // on the stack. A stack `AudioBufferList` has room for a single buffer,
        // and non-interleaved audio — which is what the built-in microphone
        // actually delivers on iOS — needs one per channel. Passing the short
        // list does not truncate quietly, it fails, but only on the multi-
        // channel devices this project cannot put under test.
        var sizeNeeded = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &sizeNeeded,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: nil
        )

        guard status == noErr, sizeNeeded >= MemoryLayout<AudioBufferList>.size else {
            report(EncoderError.unsupportedInput("could not size the buffer list (\(status))"))
            return
        }

        let storage = UnsafeMutableRawPointer.allocate(
            byteCount: sizeNeeded,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { storage.deallocate() }

        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)

        // The retained-block-buffer variant, and the returned block buffer is
        // held for the whole of this scope on purpose: the buffer list points
        // into memory that block buffer owns, and letting it go before the
        // samples have been read is a use-after-free that presents as
        // intermittent noise.
        var blockBuffer: CMBlockBuffer?

        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: list,
            bufferListSize: sizeNeeded,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )

        guard status == noErr, blockBuffer != nil else {
            report(EncoderError.unsupportedInput("could not read the sample buffer (\(status))"))
            return
        }

        guard let samples = Self.interleavedInt16(
            from: UnsafeMutableAudioBufferListPointer(list),
            format: asbd
        ) else {
            report(EncoderError.unsupportedInput(asbd.shortDescription))
            return
        }

        append(samples, sampleRate: asbd.mSampleRate, channels: Int(asbd.mChannelsPerFrame), timestampMicroseconds: micros)
    }

    // MARK: - PCM normalisation

    /// Flatten any of the layouts capture can produce into interleaved 16-bit.
    ///
    /// The converter could be asked to do this itself, but then its input
    /// callback has to reproduce whichever layout the device chose — one buffer
    /// or several, float or integer — and the version of that code that runs is
    /// decided by hardware this project cannot put under test. One input format
    /// means one code path, and this function is a pure transformation that a
    /// unit test can drive with a synthetic buffer list.
    ///
    /// Sixteen bits costs nothing here: it is what an AAC encoder works in, and
    /// a microphone preamplifier does not resolve more.
    ///
    /// - Returns: `nil` for a format that is not recognised, rather than
    ///   silence, so the caller can say so.
    static func interleavedInt16(
        from buffers: UnsafeMutableAudioBufferListPointer,
        format: AudioStreamBasicDescription
    ) -> [Int16]? {
        let channels = Int(format.mChannelsPerFrame)
        guard channels > 0, format.mFormatID == kAudioFormatLinearPCM else { return nil }

        let isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isSignedInteger = format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0

        if format.isInterleaved {
            guard let first = buffers.first, let data = first.mData else { return nil }

            if isFloat, format.mBitsPerChannel == 32 {
                let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
                let source = data.bindMemory(to: Float.self, capacity: count)
                return (0..<count).map { clampToInt16(source[$0]) }
            }

            if isSignedInteger, format.mBitsPerChannel == 16 {
                let count = Int(first.mDataByteSize) / MemoryLayout<Int16>.size
                let source = data.bindMemory(to: Int16.self, capacity: count)
                return Array(UnsafeBufferPointer(start: source, count: count))
            }

            return nil
        }

        // Non-interleaved: one buffer per channel, all the same length.
        guard buffers.count == channels else { return nil }

        guard isFloat, format.mBitsPerChannel == 32 else { return nil }

        let framesPerChannel = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        guard framesPerChannel > 0 else { return [] }

        var out = [Int16](repeating: 0, count: framesPerChannel * channels)

        for channel in 0..<channels {
            guard let data = buffers[channel].mData,
                  Int(buffers[channel].mDataByteSize) / MemoryLayout<Float>.size >= framesPerChannel
            else {
                return nil
            }

            let source = data.bindMemory(to: Float.self, capacity: framesPerChannel)
            for frame in 0..<framesPerChannel {
                out[frame * channels + channel] = clampToInt16(source[frame])
            }
        }

        return out
    }

    /// Clamped rather than wrapped. A sample that overshoots ±1.0 — which a
    /// hot preamplifier does produce — would otherwise wrap to full-scale
    /// negative and arrive as a click, which is far more audible than the
    /// clipping it replaced.
    private static func clampToInt16(_ value: Float) -> Int16 {
        let scaled = value * 32767
        if scaled >= 32767 { return .max }
        if scaled <= -32768 { return .min }
        return Int16(scaled)
    }

    // MARK: - Encoding

    /// Accumulate PCM and drain whole blocks out of it.
    ///
    /// Separated from ``encode(_:)`` so it can be driven directly: capture
    /// cannot run in the simulator, but this can, and everything below this
    /// line is where the interesting mistakes are.
    func append(_ samples: [Int16], sampleRate: Double, channels: Int, timestampMicroseconds: UInt64) {
        guard !samples.isEmpty, channels > 0, sampleRate > 0 else { return }

        lock.lock()

        if self.sampleRate != sampleRate || self.channels != channels {
            // First buffer, or the route changed under us — a headset unplugged
            // mid-broadcast switches the built-in microphone back in at a
            // different rate. Either way the old converter cannot be reused and
            // whatever is half-accumulated belongs to the old clock.
            if converter != nil {
                log.notice("audio format changed to \(Int(sampleRate)) Hz / \(channels) ch, rebuilding")
            }

            disposeConverterLocked()
            self.sampleRate = sampleRate
            self.channels = channels
            pending.removeAll(keepingCapacity: true)
            pendingStartMicros = nil
            gapPending = true

            do {
                try makeConverterLocked()
            } catch {
                lock.unlock()
                report(error)
                return
            }
        }

        // Where the clock had got to. A buffer that does not continue from
        // there means samples were lost, and carrying on would put every
        // subsequent packet at a timestamp that is wrong by the size of the gap.
        if let start = pendingStartMicros {
            let expected = start + micros(forFrames: pending.count / channels)
            let drift = timestampMicroseconds > expected
                ? timestampMicroseconds - expected
                : expected - timestampMicroseconds

            if drift > Self.resyncThresholdMicros {
                log.notice("audio gap of \(drift / 1000) ms, resynchronising")
                pending.removeAll(keepingCapacity: true)
                pendingStartMicros = timestampMicroseconds
                gapPending = true
            }
        } else {
            pendingStartMicros = timestampMicroseconds
        }

        pending.append(contentsOf: samples)

        let config = announce()
        var packets: [Packet] = []

        while let packet = drainOneLocked() { packets.append(packet) }

        lock.unlock()

        guard config != nil || !packets.isEmpty else { return }

        outputQueue.async { [onConfig, onPacket] in
            if let config { onConfig?(config) }
            for packet in packets { onPacket?(packet) }
        }
    }

    /// How far the input may drift from the running clock before the clock is
    /// moved rather than trusted. Comfortably longer than one block (21 ms at
    /// 48 kHz) and far shorter than anything a listener would not notice.
    private static let resyncThresholdMicros: UInt64 = 60_000

    /// Flush whatever is left. Called when the broadcast stops.
    ///
    /// The residue is deliberately *discarded* rather than padded out to a full
    /// block with silence: at most 1023 frames, 21 milliseconds, against the
    /// cost of the last thing a listener hears being a fade into digital
    /// silence.
    func finish() {
        lock.lock()
        pending.removeAll(keepingCapacity: false)
        pendingStartMicros = nil
        lock.unlock()
    }

    func teardown() {
        lock.lock()
        disposeConverterLocked()
        pending.removeAll(keepingCapacity: false)
        pendingStartMicros = nil
        sampleRate = 0
        channels = 0
        announced = false
        lock.unlock()
    }

    /// Build the CONFIG the far end needs, once per converter. Caller holds the lock.
    private func announce() -> Config? {
        guard !announced, converter != nil else { return nil }

        guard let description = AudioSpecificConfig.make(sampleRate: sampleRate, channels: channels) else {
            // Nothing downstream can be configured from this, so there is no
            // point emitting packets it cannot decode.
            disposeConverterLocked()
            let failure = EncoderError.indescribableOutput(sampleRate, channels)
            outputQueue.async { [onError] in onError?(failure) }
            return nil
        }

        announced = true

        return Config(
            // The MPEG-4 audio object type, as an RFC 6381 codec string. `.2`
            // is AAC-LC and is what `AudioDecoder.configure` expects.
            codecString: "mp4a.40.2",
            description: description,
            sampleRate: Int(sampleRate.rounded()),
            channels: channels
        )
    }

    /// Encode exactly one block, if there is one. Caller holds the lock.
    private func drainOneLocked() -> Packet? {
        guard let converter, let start = pendingStartMicros else { return nil }

        let frames = Self.framesPerPacket
        let needed = frames * channels
        guard pending.count >= needed else { return nil }

        // Copy the block somewhere that will not move, and hand *that* to the
        // input callback. Reading `pending` from inside the callback would mean
        // the converter holding a pointer into an array this method is about to
        // mutate.
        let byteCount = needed * MemoryLayout<Int16>.size
        ensureScratchLocked(byteCount)

        guard let scratch else { return nil }

        pending.withUnsafeBytes { source in
            scratch.copyMemory(from: source.baseAddress!, byteCount: byteCount)
        }
        pending.removeFirst(needed)
        scratchFramesAvailable = frames

        var output = [UInt8](repeating: 0, count: Self.maxPacketBytes)
        var packetDescription = AudioStreamPacketDescription()
        var packetCount: UInt32 = 1

        let status = output.withUnsafeMutableBytes { buffer -> OSStatus in
            var list = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(
                    mNumberChannels: UInt32(channels),
                    mDataByteSize: UInt32(buffer.count),
                    mData: buffer.baseAddress
                )
            )

            return AudioConverterFillComplexBuffer(
                converter,
                audioConverterInputProc,
                Unmanaged.passUnretained(self).toOpaque(),
                &packetCount,
                &list,
                &packetDescription
            )
        }

        scratchFramesAvailable = 0

        guard status == noErr || status == Self.inputExhausted else {
            let failure = EncoderError.convert(status)
            outputQueue.async { [onError] in onError?(failure) }
            return nil
        }

        guard packetCount == 1 else {
            // The encoder swallowed the block. It does this while priming, so
            // it is expected once at the start and a fault if it persists — the
            // clock still has to advance either way, or everything after this
            // point is stamped early by one block.
            pendingStartMicros = start + micros(forFrames: frames)
            return nil
        }

        let size = Int(packetDescription.mDataByteSize)
        let offset = Int(packetDescription.mStartOffset)

        guard size > 0, offset >= 0, offset + size <= output.count else { return nil }

        pendingStartMicros = start + micros(forFrames: frames)

        let discontinuity = gapPending
        gapPending = false

        return Packet(
            data: Data(output[offset..<(offset + size)]),
            timestampMicroseconds: start,
            discontinuity: discontinuity
        )
    }

    /// Worst case for one AAC access unit is 768 bytes per channel. Rounded up
    /// generously — this is allocated per block, not per broadcast, and a
    /// truncated packet would be a decode error rather than a visible one.
    private static let maxPacketBytes = 8 * 768

    /// What the input callback returns when it has nothing left. Not an error:
    /// `AudioConverterFillComplexBuffer` propagates whatever the callback
    /// returned, and this is how the loop terminates.
    private static let inputExhausted: OSStatus = -1

    private func ensureScratchLocked(_ byteCount: Int) {
        guard scratchBytes < byteCount else { return }

        scratch?.deallocate()
        scratch = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 16)
        scratchBytes = byteCount
    }

    private func micros(forFrames frames: Int) -> UInt64 {
        guard sampleRate > 0 else { return 0 }
        return UInt64((Double(frames) * 1_000_000 / sampleRate).rounded())
    }

    /// Hand the copied block to the converter. Called synchronously from inside
    /// ``drainOneLocked()``, so the lock is already held and must not be taken.
    fileprivate func provideInput(
        packets: UnsafeMutablePointer<UInt32>,
        buffers: UnsafeMutablePointer<AudioBufferList>
    ) -> OSStatus {
        guard scratchFramesAvailable > 0, let scratch else {
            packets.pointee = 0
            return Self.inputExhausted
        }

        let frames = scratchFramesAvailable
        scratchFramesAvailable = 0

        packets.pointee = UInt32(frames)
        buffers.pointee.mNumberBuffers = 1
        buffers.pointee.mBuffers.mNumberChannels = UInt32(channels)
        buffers.pointee.mBuffers.mDataByteSize = UInt32(frames * channels * MemoryLayout<Int16>.size)
        buffers.pointee.mBuffers.mData = scratch

        return noErr
    }

    // MARK: - Converter

    /// Caller holds the lock.
    private func makeConverterLocked() throws {
        var input = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(2 * channels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(2 * channels),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 16,
            mReserved: 0
        )

        var output = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(Self.framesPerPacket),
            mBytesPerFrame: 0,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0,
            mReserved: 0
        )

        var created: AudioConverterRef?
        let status = AudioConverterNew(&input, &output, &created)

        guard status == noErr, let created else {
            throw EncoderError.converterCreation(status)
        }

        var bitrate = UInt32(Self.bitratePerChannel * channels)
        AudioConverterSetProperty(
            created,
            kAudioConverterEncodeBitRate,
            UInt32(MemoryLayout<UInt32>.size),
            &bitrate
        )

        // What the encoder settled on, which is not necessarily what it was
        // asked for — and the `AudioSpecificConfig` has to describe the former.
        var settled = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)

        if AudioConverterGetProperty(
            created,
            kAudioConverterCurrentOutputStreamDescription,
            &size,
            &settled
        ) == noErr, settled.mSampleRate > 0, settled.mChannelsPerFrame > 0 {
            sampleRate = settled.mSampleRate
            channels = Int(settled.mChannelsPerFrame)
        }

        converter = created
        announced = false

        log.info("AAC encoder ready: \(Int(self.sampleRate), privacy: .public) Hz, \(self.channels, privacy: .public) ch")
    }

    /// Caller holds the lock.
    private func disposeConverterLocked() {
        if let converter { AudioConverterDispose(converter) }
        converter = nil
        announced = false
    }

    private func report(_ error: Error) {
        outputQueue.async { [onError] in onError?(error) }
    }
}

/// The C trampoline. Outside the class because a C function pointer cannot
/// capture, so the instance travels as the refcon instead.
private let audioConverterInputProc: AudioConverterComplexInputDataProc = {
    _, ioNumberDataPackets, ioData, outDataPacketDescription, inUserData in

    // The converter is told the input is packed LPCM, which needs no packet
    // descriptions. Leaving this alone is correct; writing to it is not.
    outDataPacketDescription?.pointee = nil

    guard let inUserData else {
        ioNumberDataPackets.pointee = 0
        return -1
    }

    let encoder = Unmanaged<AudioEncoder>.fromOpaque(inUserData).takeUnretainedValue()
    return encoder.provideInput(packets: ioNumberDataPackets, buffers: ioData)
}

extension AudioStreamBasicDescription {
    var isInterleaved: Bool {
        mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    }

    /// `48000 Hz 1ch f32 non-interleaved` — enough to identify a layout that
    /// was not handled, from a log line on someone else's phone.
    var shortDescription: String {
        let kind = mFormatFlags & kAudioFormatFlagIsFloat != 0 ? "f" : "i"
        let layout = isInterleaved ? "interleaved" : "non-interleaved"
        return "\(Int(mSampleRate)) Hz \(mChannelsPerFrame)ch \(kind)\(mBitsPerChannel) \(layout)"
    }
}
