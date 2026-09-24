import XCTest
@testable import AVRCapture

/// Return audio, in the parts that do not need a speaker.
///
/// The player itself is `AVAudioEngine` against whatever output device the
/// machine has, which a test host does not reliably have. What can be tested
/// everywhere is the part with the rules in it: what counts as a playable
/// packet, and what happens when audio arrives faster than it can be played.
/// That is deliberately all in ``ReturnAudioBuffer``.
final class ReturnAudioTests: XCTestCase {
    /// One 40 ms packet at the protocol's format.
    private let packet = Wire.ReturnAudio.samplesPerPacket * Wire.ReturnAudio.bytesPerSample

    // MARK: - What is playable

    func testOrdinaryPacketPlays() {
        var buffer = ReturnAudioBuffer()

        XCTAssertEqual(buffer.admit(packetBytes: packet), .play)
        XCTAssertEqual(buffer.queued, 1)
        XCTAssertEqual(buffer.played, 1)
    }

    func testEmptyPacketIsRejected() {
        var buffer = ReturnAudioBuffer()

        XCTAssertEqual(buffer.admit(packetBytes: 0), .reject(.empty))
        XCTAssertEqual(buffer.queued, 0)
        XCTAssertEqual(buffer.rejected, 1)
    }

    /// A trailing half sample means this is not the format it claims to be.
    /// Reading it as if it were shifts every sample after it by a byte.
    func testOddLengthPacketIsRejected() {
        var buffer = ReturnAudioBuffer()

        XCTAssertEqual(buffer.admit(packetBytes: 641), .reject(.partialSample))
        XCTAssertEqual(buffer.queued, 0)
    }

    func testImplausiblyLargePacketIsRejected() {
        var buffer = ReturnAudioBuffer()

        XCTAssertEqual(
            buffer.admit(packetBytes: Wire.ReturnAudio.maximumPacketBytes + 2),
            .reject(.oversized)
        )
    }

    /// The bound is two seconds of speech, and a packet exactly that long is
    /// odd but not malformed.
    func testPacketAtTheSizeLimitPlays() {
        var buffer = ReturnAudioBuffer()

        XCTAssertEqual(buffer.admit(packetBytes: Wire.ReturnAudio.maximumPacketBytes), .play)
    }

    // MARK: - Backpressure

    func testQueueIsBoundedAndDropsRatherThanGrows() {
        var buffer = ReturnAudioBuffer()

        for _ in 0 ..< ReturnAudioBuffer.maximumQueuedPackets {
            XCTAssertEqual(buffer.admit(packetBytes: packet), .play)
        }

        // Everything past the bound is discarded. The point is that `queued`
        // stops growing: a live return feed that keeps queueing is a return
        // feed that ends up minutes behind the conversation.
        for _ in 0 ..< 50 {
            XCTAssertEqual(buffer.admit(packetBytes: packet), .dropStale)
        }

        XCTAssertEqual(buffer.queued, ReturnAudioBuffer.maximumQueuedPackets)
        XCTAssertEqual(buffer.played, UInt64(ReturnAudioBuffer.maximumQueuedPackets))
        XCTAssertEqual(buffer.dropped, 50)
    }

    func testPlayingAPacketMakesRoomForAnother() {
        var buffer = ReturnAudioBuffer()

        for _ in 0 ..< ReturnAudioBuffer.maximumQueuedPackets {
            _ = buffer.admit(packetBytes: packet)
        }
        XCTAssertEqual(buffer.admit(packetBytes: packet), .dropStale)

        buffer.finished()

        XCTAssertEqual(buffer.admit(packetBytes: packet), .play)
    }

    func testMalformedPacketsDoNotConsumeTheQueue() {
        var buffer = ReturnAudioBuffer()

        for _ in 0 ..< 100 {
            _ = buffer.admit(packetBytes: 7)
        }

        XCTAssertEqual(buffer.queued, 0, "a rejected packet was never queued")
        XCTAssertEqual(buffer.admit(packetBytes: packet), .play)
    }

    func testFinishedNeverGoesNegative() {
        var buffer = ReturnAudioBuffer()

        buffer.finished()
        buffer.finished()

        XCTAssertEqual(buffer.queued, 0)
    }

    func testFlushEmptiesTheQueueButKeepsTheCounters() {
        var buffer = ReturnAudioBuffer()

        _ = buffer.admit(packetBytes: packet)
        _ = buffer.admit(packetBytes: packet)
        buffer.flush()

        XCTAssertEqual(buffer.queued, 0)
        XCTAssertEqual(buffer.played, 2, "what was played is still true after a flush")
    }

    func testQueuedMillisecondsReportsTheDepthInTime() {
        var buffer = ReturnAudioBuffer()

        for _ in 0 ..< 5 { _ = buffer.admit(packetBytes: packet) }

        XCTAssertEqual(buffer.queuedMilliseconds, 200, "five 40 ms packets")
    }

    // MARK: - The wire

    /// Return audio arrives on its own track, never on the one the broadcast's
    /// own sound goes out on. A single number keeps the two apart, so it is
    /// worth a test of its own.
    func testTalkbackIsNotTheBroadcastAudioTrack() {
        XCTAssertEqual(Wire.Track.talkback.rawValue, 4)
        XCTAssertNotEqual(Wire.Track.talkback, Wire.Track.audio)
    }

    /// The format is fixed by the protocol; `src/live/protocol.js` holds the
    /// other copy of these numbers.
    func testReturnAudioFormatMatchesTheProtocol() {
        XCTAssertEqual(Wire.ReturnAudio.sampleRate, 16_000)
        XCTAssertEqual(Wire.ReturnAudio.channels, 1)
        XCTAssertEqual(Wire.ReturnAudio.bytesPerSample, 2)
        XCTAssertEqual(Wire.ReturnAudio.samplesPerPacket, 640)
    }

    /// An inbound talkback frame has to survive the same reassembly every other
    /// frame goes through, including arriving in pieces.
    func testFrameReaderDeliversATalkbackFrameSplitAcrossReads() {
        var reader = Wire.FrameReader()

        let payload = Data(repeating: 0x11, count: packet)
        let frame = Wire.frame(
            type: .audio,
            track: .talkback,
            flags: [.keyframe],
            timestamp: 40_000,
            payload: payload
        )

        let split = frame.count / 3
        XCTAssertTrue(reader.push(frame.prefix(split)).isEmpty, "half a frame is not a frame")

        let frames = reader.push(frame.suffix(from: split))

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.type, .audio)
        XCTAssertEqual(frames.first?.track, Wire.Track.talkback.rawValue)
        XCTAssertEqual(frames.first?.payload, payload)
    }
}
