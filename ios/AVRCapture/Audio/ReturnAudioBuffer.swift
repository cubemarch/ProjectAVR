import Foundation

/// What to do with one packet of return audio, decided without an audio device.
///
/// Split out from ``ReturnAudioPlayer`` so the part with rules in it can be
/// tested on a machine with no speaker, which in practice means all of CI. The
/// player owns `AVAudioEngine` and has no policy; this has all the policy and
/// no AVFoundation.
///
/// The rules are the ones the brief asks of every queue in this app: bounded,
/// with deliberate backpressure, and biased towards dropping stale audio rather
/// than accumulating latency. A return feed that is two seconds behind is worse
/// than one with a gap in it — the person on the other end has already repeated
/// themselves by then.
struct ReturnAudioBuffer {
    enum Decision: Equatable {
        /// Hand these samples to the engine.
        case play

        /// Not speech this app can play. The socket is shared with the
        /// broadcast, so a malformed packet is dropped rather than treated as a
        /// reason to tear anything down.
        case reject(Reason)

        /// Well-formed, but there is already more audio queued than is worth
        /// keeping. Dropped so the queue drains back towards live.
        case dropStale
    }

    enum Reason: Equatable {
        case empty
        case oversized
        case partialSample
    }

    /// Packets to keep in flight before dropping. Twelve 40 ms packets is
    /// roughly half a second — enough to ride out ordinary jitter on a phone's
    /// network, short enough that a listener would call it immediate.
    static let maximumQueuedPackets = 12

    private(set) var queued = 0
    private(set) var played: UInt64 = 0
    private(set) var dropped: UInt64 = 0
    private(set) var rejected: UInt64 = 0

    /// Decide, and record the decision.
    mutating func admit(packetBytes: Int) -> Decision {
        if packetBytes == 0 {
            rejected += 1
            return .reject(.empty)
        }

        if packetBytes > Wire.ReturnAudio.maximumPacketBytes {
            rejected += 1
            return .reject(.oversized)
        }

        // Whole 16-bit samples or nothing. A trailing half sample means this is
        // not the format it claims to be, and reading it as if it were would
        // put a sample's worth of noise in and shift everything after it.
        if packetBytes % Wire.ReturnAudio.bytesPerSample != 0 {
            rejected += 1
            return .reject(.partialSample)
        }

        if queued >= Self.maximumQueuedPackets {
            dropped += 1
            return .dropStale
        }

        queued += 1
        played += 1
        return .play
    }

    /// One queued packet finished playing.
    mutating func finished() {
        queued = max(0, queued - 1)
    }

    /// Everything queued is gone — the engine stopped, or the link dropped.
    mutating func flush() {
        queued = 0
    }

    /// Roughly how much audio is waiting, for the diagnostics screen.
    var queuedMilliseconds: Int {
        Int((Double(queued * Wire.ReturnAudio.samplesPerPacket) / Wire.ReturnAudio.sampleRate) * 1000)
    }
}
