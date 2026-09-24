import Foundation

/// AVR Live wire protocol, phone side.
///
/// The authoritative description of this format lives in
/// `src/live/protocol.js`, which both the relay and the browser import. This
/// file is the other half of that contract, and the two are pinned together by
/// `test/live-protocol.test.js` — if a field moves here, that suite fails.
///
/// Layout, little-endian throughout:
///
///     offset  size  field
///     0       4     length      bytes following this field (= 16 + payload)
///     4       1     type
///     5       1     track
///     6       2     flags
///     8       8     timestamp   capture time, microseconds
///     16      4     sequence
///     20      N     payload
enum Wire {
    static let protocolName = "avr-live"
    static let protocolVersion = 1
    static let headerBytes = 20

    enum FrameType: UInt8 {
        case hello = 1
        case ready = 2
        case config = 3
        case video = 4
        case audio = 5
        case stats = 6
        case bye = 7
        case ping = 8
        case pong = 9
    }

    enum Track: UInt8 {
        case left = 0
        case right = 1
        case audio = 2
        case packed = 3

        /// Return audio from the destination — the one track that arrives
        /// rather than leaves.
        ///
        /// A separate track from ``audio`` because they travel in opposite
        /// directions and carry different formats: the broadcast's own sound is
        /// AAC going out, and this is linear PCM coming in. Never sent by this
        /// app.
        case talkback = 4
    }

    /// The format of return audio. Fixed by the protocol, not negotiated.
    ///
    /// Mirrors `TALKBACK` in `src/live/protocol.js`. Linear PCM so that the
    /// capture app needs no decoder for it — there is a hardware encoder busy
    /// with the picture, and a return feed is not worth contending for it.
    enum ReturnAudio {
        static let sampleRate = 16_000.0
        static let channels: UInt32 = 1
        static let bytesPerSample = 2

        /// 40 ms per packet, which is what the server sends. Only used as a
        /// sanity bound: a packet of any whole number of samples plays.
        static let samplesPerPacket = 640

        /// Refuse anything implausible for speech before it reaches the audio
        /// engine. Two seconds of it, which no well-behaved sender will exceed.
        static let maximumPacketBytes = Int(sampleRate) * bytesPerSample * 2
    }

    struct Flags: OptionSet {
        let rawValue: UInt16

        static let keyframe = Flags(rawValue: 1 << 0)
        static let discontinuity = Flags(rawValue: 1 << 1)
    }

    /// Serialise one frame.
    static func frame(
        type: FrameType,
        track: Track = .left,
        flags: Flags = [],
        timestamp: UInt64 = 0,
        sequence: UInt32 = 0,
        payload: Data = Data()
    ) -> Data {
        var out = Data(capacity: headerBytes + payload.count)

        out.appendLE(UInt32(16 + payload.count))
        out.append(type.rawValue)
        out.append(track.rawValue)
        out.appendLE(flags.rawValue)
        out.appendLE(timestamp)
        out.appendLE(sequence)
        out.append(payload)

        return out
    }

    /// Serialise a frame whose payload is JSON.
    ///
    /// `JSONSerialization` rather than `Codable`: the payloads are small, open
    /// dictionaries that differ per frame type, and defining a struct per
    /// variant would be more ceremony than the format deserves.
    static func jsonFrame(
        type: FrameType,
        track: Track = .left,
        timestamp: UInt64 = 0,
        body: [String: Any]
    ) -> Data {
        let payload = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
        return frame(type: type, track: track, timestamp: timestamp, payload: payload)
    }
}

// MARK: - Inbound framing

extension Wire {
    struct IncomingFrame {
        let type: FrameType
        let track: UInt8
        let flags: UInt16
        let timestamp: UInt64
        let sequence: UInt32
        let payload: Data

        /// Decode the payload as a JSON object, if it is one.
        var json: [String: Any]? {
            try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        }
    }

    /// Reassembles frames arriving from the server.
    ///
    /// The phone receives very little — a READY at the handshake and the odd
    /// PONG — but TCP still offers no message boundaries, so the same buffering
    /// the server does for the uplink is needed here for the downlink.
    struct FrameReader {
        private var buffer = Data()

        mutating func push(_ chunk: Data) -> [IncomingFrame] {
            buffer.append(chunk)

            var frames: [IncomingFrame] = []

            while buffer.count >= 4 {
                let length = Int(buffer.readLE(at: 0) as UInt32)
                let total = 4 + length

                guard length >= 16, buffer.count >= total else { break }

                let payloadLength = length - 16
                let rawType: UInt8 = buffer[buffer.startIndex + 4]

                if let type = FrameType(rawValue: rawType) {
                    let payloadStart = buffer.startIndex + headerBytes
                    frames.append(
                        IncomingFrame(
                            type: type,
                            track: buffer[buffer.startIndex + 5],
                            flags: buffer.readLE(at: 6),
                            timestamp: buffer.readLE(at: 8),
                            sequence: buffer.readLE(at: 16),
                            payload: Data(buffer[payloadStart ..< payloadStart + payloadLength])
                        )
                    )
                }

                buffer.removeFirst(total)
            }

            return frames
        }

        mutating func reset() {
            buffer.removeAll(keepingCapacity: true)
        }
    }
}

// MARK: - Little-endian helpers

private extension Data {
    /// `Swift.` is load-bearing: inside an extension on `Data`, the unqualified
    /// name resolves to `Data.withUnsafeBytes`, which views the *buffer* rather
    /// than the integer being passed in.
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }

    /// Read a little-endian integer at a byte offset from the start of the data.
    ///
    /// `Data` slices keep their parent's indices, so every access is relative
    /// to `startIndex` rather than zero — getting that wrong reads garbage
    /// after the first `removeFirst`.
    func readLE<T: FixedWidthInteger>(at offset: Int) -> T {
        let start = startIndex + offset
        var value: T = 0

        Swift.withUnsafeMutableBytes(of: &value) { destination in
            // Discarded: `copyBytes` returns the count, which is by
            // construction `MemoryLayout<T>.size`.
            _ = copyBytes(to: destination, from: start ..< start + MemoryLayout<T>.size)
        }

        return T(littleEndian: value)
    }
}
