import XCTest
@testable import AVRCapture

/// The `AudioSpecificConfig` is two bytes that the browser's `AudioDecoder`
/// takes entirely on trust. Get a field wrong and the decoder still starts —
/// it just produces the wrong number of channels, or plays back at the wrong
/// rate, or emits silence. There is no error to catch, which is exactly why
/// these bytes are checked against known-good vectors rather than against
/// whatever the code currently produces.
final class AudioSpecificConfigTests: XCTestCase {
    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Known vectors

    func testFortyEightKilohertzStereo() {
        // 00010 0011 0010 000 → 0001 0001 1001 0000
        //  AAC-LC  48k  2ch  GASpecificConfig
        let config = AudioSpecificConfig.make(sampleRate: 48_000, channels: 2)
        XCTAssertEqual(config.map(hex), "1190")
    }

    func testFortyFourPointOneKilohertzMono() {
        // 00010 0100 0001 000 → 0001 0010 0000 1000
        let config = AudioSpecificConfig.make(sampleRate: 44_100, channels: 1)
        XCTAssertEqual(config.map(hex), "1208")
    }

    func testFortyEightKilohertzMono() {
        let config = AudioSpecificConfig.make(sampleRate: 48_000, channels: 1)
        XCTAssertEqual(config.map(hex), "1188")
    }

    /// Every entry in the table, not just the three the hardware is likely to
    /// pick. The index is positional and an insertion in the wrong place would
    /// shift everything below it — silently, and only for the rates nobody
    /// tests on.
    func testEveryTabulatedRateIsTwoBytes() {
        for rate in AudioSpecificConfig.samplingFrequencies {
            let config = AudioSpecificConfig.make(sampleRate: rate, channels: 2)
            XCTAssertEqual(config?.count, 2, "\(rate) Hz should pack into two bytes")
        }
    }

    func testFrequencyIndexMatchesTheTable() {
        XCTAssertEqual(AudioSpecificConfig.frequencyIndex(for: 96_000), 0)
        XCTAssertEqual(AudioSpecificConfig.frequencyIndex(for: 48_000), 3)
        XCTAssertEqual(AudioSpecificConfig.frequencyIndex(for: 44_100), 4)
        XCTAssertEqual(AudioSpecificConfig.frequencyIndex(for: 8_000), 11)
        XCTAssertNil(AudioSpecificConfig.frequencyIndex(for: 37_000))
    }

    // MARK: - The escape code

    /// A rate outside the table is written as index 15 followed by the rate in
    /// 24 bits, which pushes the config to five bytes. Unlikely from Apple
    /// hardware, but "unlikely" is not "impossible" with an external interface
    /// attached, and the alternative is a config that silently claims a rate
    /// the audio is not at.
    func testUntabulatedRateUsesTheEscapeCode() {
        guard let config = AudioSpecificConfig.make(sampleRate: 37_000, channels: 1) else {
            return XCTFail("37 kHz should be describable via the escape code")
        }

        XCTAssertEqual(config.count, 5)

        // 00010 1111 000000001001000010001000 0001 000
        //  LC   esc   37000 (0x009088)         1ch  GASC
        XCTAssertEqual(hex(config), "1780484408")
    }

    func testEscapedRateRoundTrips() {
        // Read the 24-bit field back out of the bit stream and check it is the
        // rate that went in: an off-by-one in the bit packer would still
        // produce five plausible-looking bytes.
        guard let config = AudioSpecificConfig.make(sampleRate: 37_000, channels: 1) else {
            return XCTFail("37 kHz should be describable via the escape code")
        }

        let bits = config.flatMap { byte in (0..<8).map { (byte >> (7 - $0)) & 1 } }
        let rate = bits[9..<33].reduce(0) { ($0 << 1) | Int($1) }

        XCTAssertEqual(rate, 37_000)
    }

    // MARK: - Refusals

    func testRejectsImpossibleChannelCounts() {
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: 48_000, channels: 0))
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: 48_000, channels: 8))
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: 48_000, channels: -1))
    }

    func testRejectsImpossibleRates() {
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: 0, channels: 2))
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: -48_000, channels: 2))
        // Beyond what the 24-bit escape field can hold.
        XCTAssertNil(AudioSpecificConfig.make(sampleRate: 20_000_000, channels: 2))
    }

    // MARK: - Bit packing

    func testBitWriterPacksBigEndian() {
        var bits = BitWriter()
        bits.write(1, bits: 1)
        bits.write(0, bits: 1)
        bits.write(0b111111, bits: 6)
        XCTAssertEqual(hex(bits.bytes), "bf")
    }

    /// A trailing partial byte is left-aligned and zero-filled, which is what
    /// MPEG expects. Right-aligning it would shift every field in the last byte.
    func testBitWriterPadsTheFinalByteOnTheRight() {
        var bits = BitWriter()
        bits.write(0b101, bits: 3)
        XCTAssertEqual(hex(bits.bytes), "a0")
    }

    func testBitWriterSpansByteBoundaries() {
        var bits = BitWriter()
        bits.write(0xABCD, bits: 16)
        XCTAssertEqual(hex(bits.bytes), "abcd")

        var offset = BitWriter()
        offset.write(0, bits: 4)
        offset.write(0xABCD, bits: 16)
        XCTAssertEqual(hex(offset.bytes), "0abcd0")
    }

    func testBitWriterIsEmptyUntilWrittenTo() {
        XCTAssertEqual(BitWriter().bytes, Data())
    }
}
