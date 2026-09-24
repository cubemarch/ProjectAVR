import Foundation

/// The handful of bits that tell a decoder what an AAC bitstream is.
///
/// Raw AAC access units carry no description of themselves — no sample rate, no
/// channel count, nothing. `AudioSpecificConfig` (ISO/IEC 14496-3, 1.6.2.1) is
/// the out-of-band blob that supplies them, and it is exactly what a browser's
/// `AudioDecoder` wants in `AudioDecoderConfig.description`. Without it the
/// browser cannot configure a decoder at all, which is the audio equivalent of
/// the SPS/PPS problem `NALUnit` solves for video.
///
/// **Why this is synthesised rather than read from the encoder.** AudioToolbox
/// will hand back a `kAudioConverterCompressionMagicCookie`, but on Apple
/// platforms that cookie is an MPEG-4 *ES descriptor* — a nested, length-
/// prefixed descriptor tree — with the config buried inside it under tag 0x05.
/// Extracting it means hand-writing a descriptor walker whose failure mode is
/// producing a plausible-looking blob that decodes to the wrong thing.
///
/// Every input to the config below is instead something this app chose and can
/// read back from the converter: AAC-LC because ``AudioEncoder`` asks for
/// `kAudioFormatMPEG4AAC` and nothing else, the sample rate and channel count
/// because it reads the converter's settled output format. There is nothing
/// left for the encoder to disagree with us about, and the result is a pure
/// function that a test can check against known-good values.
enum AudioSpecificConfig {
    /// Audio object type 2. The only profile this app produces — see the type
    /// comment on ``AudioEncoder`` for why.
    static let aacLowComplexity = 2

    /// The sampling frequencies that have a four-bit index, in index order.
    /// Anything else has to be written out in full; see ``make(sampleRate:channels:)``.
    static let samplingFrequencies: [Double] = [
        96000, 88200, 64000, 48000, 44100, 32000,
        24000, 22050, 16000, 12000, 11025, 8000, 7350
    ]

    /// The four-bit index for a rate, or `nil` if it is not one of the
    /// thirteen that have one.
    static func frequencyIndex(for sampleRate: Double) -> Int? {
        samplingFrequencies.firstIndex { abs($0 - sampleRate) < 1 }
    }

    /// Build the config for an AAC-LC stream.
    ///
    /// - Parameter channels: Maps straight onto `channelConfiguration`, which
    ///   is why 0 is rejected: zero means "described separately in the
    ///   bitstream", and this app never produces that.
    /// - Returns: Two bytes for the common rates, five for an unusual one.
    ///   `nil` when the arguments could not describe a stream at all.
    static func make(sampleRate: Double, channels: Int) -> Data? {
        guard sampleRate > 0, (1...7).contains(channels) else { return nil }

        var bits = BitWriter()
        bits.write(aacLowComplexity, bits: 5)

        if let index = frequencyIndex(for: sampleRate) {
            bits.write(index, bits: 4)
        } else {
            // The escape code, followed by the rate written out in full. A
            // capture device is very unlikely to pick a rate off the table, but
            // refusing to encode at all would be a worse answer than four extra
            // bytes.
            guard sampleRate < Double(1 << 24) else { return nil }
            bits.write(15, bits: 4)
            bits.write(Int(sampleRate.rounded()), bits: 24)
        }

        bits.write(channels, bits: 4)

        // GASpecificConfig: frameLengthFlag (0 = 1024 samples per frame, which
        // is what `AudioEncoder` feeds the converter), dependsOnCoreCoder,
        // extensionFlag. All zero for plain AAC-LC.
        bits.write(0, bits: 3)

        return bits.bytes
    }
}

/// Big-endian bit packing, which is what every MPEG bitstream is written in.
///
/// Small enough to live here rather than earn a file. The only subtlety is that
/// a partially filled final byte is zero-padded, which is what the spec calls
/// for — the trailing bits of an `AudioSpecificConfig` are not significant.
struct BitWriter {
    private var complete = Data()
    private var partial: UInt8 = 0
    private var filled = 0

    mutating func write(_ value: Int, bits count: Int) {
        precondition(count > 0 && count <= 32, "bit count out of range")

        for shift in stride(from: count - 1, through: 0, by: -1) {
            let bit = UInt8((value >> shift) & 1)
            partial = (partial << 1) | bit
            filled += 1

            if filled == 8 {
                complete.append(partial)
                partial = 0
                filled = 0
            }
        }
    }

    /// Everything written so far, with any partial final byte left-aligned and
    /// zero-padded. The only accessor, so there is no way to read a buffer that
    /// is still missing its last few bits.
    var bytes: Data {
        guard filled > 0 else { return complete }
        return complete + [partial << (8 - filled)]
    }
}
