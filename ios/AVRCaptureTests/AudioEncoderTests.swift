import AudioToolbox
import CoreMedia
import XCTest
@testable import AVRCapture

/// Capture cannot run in the simulator, but everything between the microphone
/// and the socket can: ``AudioEncoder/append(_:sampleRate:channels:timestampMicroseconds:)``
/// and ``AudioEncoder/interleavedInt16(from:format:)`` are both reachable
/// without a camera, and they are where the arithmetic mistakes live.
final class AudioEncoderTests: XCTestCase {
    private let queue = DispatchQueue(label: "test.audio.output")

    /// 1024 frames at 48 kHz.
    private let blockMicros: UInt64 = 21_333

    // MARK: - PCM normalisation

    private func asbd(
        format: AudioFormatID = kAudioFormatLinearPCM,
        flags: AudioFormatFlags,
        bitsPerChannel: UInt32,
        channels: UInt32
    ) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: format,
            mFormatFlags: flags,
            mBytesPerPacket: 0,
            mFramesPerPacket: 1,
            mBytesPerFrame: 0,
            mChannelsPerFrame: channels,
            mBitsPerChannel: bitsPerChannel,
            mReserved: 0
        )
    }

    /// Builds a heap `AudioBufferList` and frees it once the body has run.
    private func withBufferList<T>(
        _ buffers: [[UInt8]],
        channelsPerBuffer: UInt32,
        _ body: (UnsafeMutableAudioBufferListPointer) -> T
    ) -> T {
        let list = AudioBufferList.allocate(maximumBuffers: buffers.count)
        defer { free(list.unsafeMutablePointer) }

        var storage: [UnsafeMutableRawPointer] = []
        defer { storage.forEach { $0.deallocate() } }

        for (index, bytes) in buffers.enumerated() {
            let memory = UnsafeMutableRawPointer.allocate(byteCount: max(1, bytes.count), alignment: 16)
            bytes.withUnsafeBytes { memory.copyMemory(from: $0.baseAddress!, byteCount: bytes.count) }
            storage.append(memory)

            list[index] = AudioBuffer(
                mNumberChannels: channelsPerBuffer,
                mDataByteSize: UInt32(bytes.count),
                mData: memory
            )
        }

        return body(list)
    }

    private func bytes<T>(of values: [T]) -> [UInt8] {
        values.withUnsafeBytes { Array($0) }
    }

    func testInterleavedInt16PassesThroughUnchanged() {
        let samples: [Int16] = [0, 1, -1, 32767, -32768, 1234]
        let format = asbd(
            flags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            bitsPerChannel: 16,
            channels: 2
        )

        let result = withBufferList([bytes(of: samples)], channelsPerBuffer: 2) {
            AudioEncoder.interleavedInt16(from: $0, format: format)
        }

        XCTAssertEqual(result, samples)
    }

    func testInterleavedFloatIsScaledAndClamped() {
        // The last two overshoot full scale, which a hot preamplifier does
        // produce. Wrapping them would turn a moment of clipping into a click.
        let samples: [Float] = [0, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0]
        let format = asbd(
            flags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            bitsPerChannel: 32,
            channels: 1
        )

        let result = withBufferList([bytes(of: samples)], channelsPerBuffer: 1) {
            AudioEncoder.interleavedInt16(from: $0, format: format)
        }

        XCTAssertEqual(result, [0, 16383, -16383, 32767, -32767, 32767, -32768])
    }

    /// What the built-in microphone actually delivers: one buffer per channel.
    func testNonInterleavedFloatIsInterleaved() {
        let left: [Float] = [0.0, 0.25, 0.5]
        let right: [Float] = [-0.25, -0.5, -0.75]

        let format = asbd(
            flags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved,
            bitsPerChannel: 32,
            channels: 2
        )

        let result = withBufferList([bytes(of: left), bytes(of: right)], channelsPerBuffer: 1) {
            AudioEncoder.interleavedInt16(from: $0, format: format)
        }

        guard let result else { return XCTFail("two float planes should normalise") }

        XCTAssertEqual(result.count, 6)
        // L R L R L R, not L L L R R R.
        XCTAssertEqual(result[0], 0)
        XCTAssertEqual(result[1], -8191)
        XCTAssertEqual(result[2], 8191)
        XCTAssertEqual(result[3], -16383)
        XCTAssertEqual(result[4], 16383)
        XCTAssertEqual(result[5], -24575)
    }

    /// `nil`, not silence. A format this cannot read is something the operator
    /// has to be told about, and a stream of zeroes tells nobody anything.
    func testUnreadableFormatsAreRefused() {
        let twentyFourBit = asbd(
            flags: kAudioFormatFlagIsSignedInteger,
            bitsPerChannel: 24,
            channels: 1
        )
        let compressed = asbd(
            format: kAudioFormatMPEG4AAC,
            flags: 0,
            bitsPerChannel: 0,
            channels: 2
        )
        let zeroChannels = asbd(
            flags: kAudioFormatFlagIsSignedInteger,
            bitsPerChannel: 16,
            channels: 0
        )

        let payload = bytes(of: [Int16](repeating: 0, count: 8))

        for format in [twentyFourBit, compressed, zeroChannels] {
            let result = withBufferList([payload], channelsPerBuffer: 1) {
                AudioEncoder.interleavedInt16(from: $0, format: format)
            }
            XCTAssertNil(result, "should refuse \(format.shortDescription)")
        }
    }

    /// A plane count that disagrees with the channel count is a buffer list
    /// this code does not understand, not one to read the first plane of.
    func testMissingPlanesAreRefused() {
        let format = asbd(
            flags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved,
            bitsPerChannel: 32,
            channels: 2
        )

        let result = withBufferList([bytes(of: [Float](repeating: 0, count: 4))], channelsPerBuffer: 1) {
            AudioEncoder.interleavedInt16(from: $0, format: format)
        }

        XCTAssertNil(result)
    }

    // MARK: - Encoding

    /// Drives `append` and collects what comes back out on the output queue.
    private final class Sink {
        private let lock = NSLock()
        private var configs: [AudioEncoder.Config] = []
        private var packets: [AudioEncoder.Packet] = []
        private var errors: [Error] = []

        func attach(to encoder: AudioEncoder) {
            encoder.onConfig = { [self] in lock.lock(); configs.append($0); lock.unlock() }
            encoder.onPacket = { [self] in lock.lock(); packets.append($0); lock.unlock() }
            encoder.onError = { [self] in lock.lock(); errors.append($0); lock.unlock() }
        }

        func drain(_ queue: DispatchQueue) -> (
            configs: [AudioEncoder.Config],
            packets: [AudioEncoder.Packet],
            errors: [Error]
        ) {
            queue.sync {}
            lock.lock()
            defer { lock.unlock() }
            return (configs, packets, errors)
        }
    }

    /// A quiet sine, so the encoder is given something with structure rather
    /// than digital silence — which some encoders special-case.
    private func tone(frames: Int, channels: Int, startingAt phase: Int = 0) -> [Int16] {
        (0..<(frames * channels)).map { index in
            let frame = phase + index / channels
            return Int16(8000 * sin(Double(frame) * 2 * .pi * 440 / 48_000))
        }
    }

    func testAnnouncesAacLowComplexityBeforeAnyPacket() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append(tone(frames: 4096, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)

        let (configs, packets, errors) = sink.drain(queue)

        XCTAssertTrue(errors.isEmpty, "\(errors)")
        XCTAssertEqual(configs.count, 1)
        XCTAssertEqual(configs.first?.codecString, "mp4a.40.2")
        XCTAssertEqual(configs.first?.sampleRate, 48_000)
        XCTAssertEqual(configs.first?.channels, 2)
        XCTAssertEqual(configs.first?.description, Data([0x11, 0x90]))
        XCTAssertFalse(packets.isEmpty, "4096 frames is four blocks and should produce packets")
    }

    func testConfigIsAnnouncedOnlyOnce() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        for block in 0..<4 {
            encoder.append(
                tone(frames: 1024, channels: 2, startingAt: block * 1024),
                sampleRate: 48_000,
                channels: 2,
                timestampMicroseconds: UInt64(block) * blockMicros
            )
        }

        XCTAssertEqual(sink.drain(queue).configs.count, 1)
    }

    /// The whole point of accumulating: the microphone does not deliver 1024
    /// frames at a time, and a partial block must wait rather than be padded.
    func testPartialBlocksAccumulate() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        // 512 frames, well short of a block.
        encoder.append(tone(frames: 512, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        XCTAssertTrue(sink.drain(queue).packets.isEmpty)

        // Six more of the same is 3.5 blocks in total.
        for chunk in 1...6 {
            encoder.append(
                tone(frames: 512, channels: 2, startingAt: chunk * 512),
                sampleRate: 48_000,
                channels: 2,
                timestampMicroseconds: UInt64(chunk) * blockMicros / 2
            )
        }

        let (_, packets, errors) = sink.drain(queue)
        XCTAssertTrue(errors.isEmpty, "\(errors)")
        XCTAssertFalse(packets.isEmpty)
        // Three whole blocks at most, never four: the half block is still held.
        XCTAssertLessThanOrEqual(packets.count, 3)
    }

    /// Timestamps come from frames consumed, not from when the buffer arrived.
    /// Getting this wrong drifts audio against video by the accumulated
    /// scheduling jitter, which is inaudible for a minute and obvious after ten.
    func testTimestampsAdvanceByExactlyOneBlock() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        let anchor: UInt64 = 5_000_000

        for block in 0..<8 {
            encoder.append(
                tone(frames: 1024, channels: 2, startingAt: block * 1024),
                sampleRate: 48_000,
                channels: 2,
                // Deliberately jittered by up to 2 ms, well under the resync
                // threshold: the output must not inherit any of it.
                timestampMicroseconds: anchor + UInt64(block) * blockMicros + UInt64(block % 3) * 700
            )
        }

        let packets = sink.drain(queue).packets
        XCTAssertGreaterThanOrEqual(packets.count, 2)

        for (previous, next) in zip(packets, packets.dropFirst()) {
            XCTAssertEqual(next.timestampMicroseconds - previous.timestampMicroseconds, blockMicros)
        }

        // The first packet is anchored to the first buffer, give or take the
        // blocks the encoder swallows while priming.
        let first = packets[0].timestampMicroseconds
        XCTAssertGreaterThanOrEqual(first, anchor)
        XCTAssertEqual((first - anchor) % blockMicros, 0)
    }

    func testTimestampsFollowTheSampleRate() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        // 1024 frames at 44.1 kHz is 23220 µs, not 21333.
        encoder.append(tone(frames: 8192, channels: 1), sampleRate: 44_100, channels: 1, timestampMicroseconds: 0)

        let (configs, packets, _) = sink.drain(queue)
        XCTAssertEqual(configs.first?.description, Data([0x12, 0x08]))
        XCTAssertGreaterThanOrEqual(packets.count, 2)

        for (previous, next) in zip(packets, packets.dropFirst()) {
            XCTAssertEqual(next.timestampMicroseconds - previous.timestampMicroseconds, 23_220)
        }
    }

    /// A gap longer than the resync threshold re-anchors the clock and says so,
    /// rather than stamping everything after it early by the size of the gap.
    func testAGapReanchorsAndIsFlagged() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append(tone(frames: 4096, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        let before = sink.drain(queue).packets.count
        XCTAssertGreaterThan(before, 0)

        // Five seconds later: an interruption, not jitter.
        let resumeAt: UInt64 = 5_000_000
        encoder.append(
            tone(frames: 4096, channels: 2),
            sampleRate: 48_000,
            channels: 2,
            timestampMicroseconds: resumeAt
        )

        let packets = sink.drain(queue).packets
        let after = Array(packets.dropFirst(before))

        XCTAssertFalse(after.isEmpty)
        XCTAssertGreaterThanOrEqual(after[0].timestampMicroseconds, resumeAt)
        XCTAssertTrue(after[0].discontinuity, "the first packet after a gap must be flagged")
        XCTAssertFalse(after.dropFirst().contains { $0.discontinuity }, "only the first")
    }

    /// A route change — a headset unplugged mid-broadcast — arrives as a
    /// different rate on the same encoder. The far end has to be told.
    func testAFormatChangeReannounces() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append(tone(frames: 2048, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        encoder.append(tone(frames: 2048, channels: 1), sampleRate: 48_000, channels: 1, timestampMicroseconds: 1_000_000)

        let configs = sink.drain(queue).configs
        XCTAssertEqual(configs.count, 2)
        XCTAssertEqual(configs[0].channels, 2)
        XCTAssertEqual(configs[0].description, Data([0x11, 0x90]))
        XCTAssertEqual(configs[1].channels, 1)
        XCTAssertEqual(configs[1].description, Data([0x11, 0x88]))
    }

    func testEmptyAndDegenerateInputAreIgnored() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append([], sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        encoder.append(tone(frames: 64, channels: 1), sampleRate: 0, channels: 1, timestampMicroseconds: 0)
        encoder.append(tone(frames: 64, channels: 1), sampleRate: 48_000, channels: 0, timestampMicroseconds: 0)

        let (configs, packets, errors) = sink.drain(queue)
        XCTAssertTrue(configs.isEmpty)
        XCTAssertTrue(packets.isEmpty)
        XCTAssertTrue(errors.isEmpty)
    }

    /// Every access unit is a keyframe as far as the wire is concerned, which
    /// is only true if each one is a whole, independently decodable block. A
    /// zero-length or absurdly large packet would mean it is not.
    func testPacketsAreWholeAccessUnits() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append(tone(frames: 8192, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)

        let packets = sink.drain(queue).packets
        XCTAssertGreaterThan(packets.count, 3)

        for packet in packets {
            XCTAssertGreaterThan(packet.data.count, 0)
            XCTAssertLessThanOrEqual(packet.data.count, 768 * 2)
        }
    }

    /// `finish()` drops the residue rather than padding it with silence, and
    /// leaves the encoder able to start again.
    func testFinishDiscardsTheResidue() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)
        defer { encoder.teardown() }

        encoder.append(tone(frames: 1500, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        let before = sink.drain(queue).packets.count

        encoder.finish()
        XCTAssertEqual(sink.drain(queue).packets.count, before, "finish must not emit a padded block")

        encoder.append(tone(frames: 2048, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 9_000_000)
        let after = sink.drain(queue).packets
        XCTAssertGreaterThan(after.count, before)
        XCTAssertGreaterThanOrEqual(after[before].timestampMicroseconds, 9_000_000)
    }

    func testTeardownIsIdempotentAndSafeAfterUse() {
        let encoder = AudioEncoder(outputQueue: queue)
        let sink = Sink()
        sink.attach(to: encoder)

        encoder.append(tone(frames: 2048, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 0)
        encoder.teardown()
        encoder.teardown()

        // And nothing arriving late gets through to a disposed converter.
        encoder.append(tone(frames: 2048, channels: 2), sampleRate: 48_000, channels: 2, timestampMicroseconds: 1_000_000)
        XCTAssertTrue(sink.drain(queue).errors.isEmpty)
    }
}
