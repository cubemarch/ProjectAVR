import CoreMedia
import Foundation
import VideoToolbox

/// Bitstream plumbing between VideoToolbox and WebCodecs.
///
/// VideoToolbox emits AVCC: each NAL unit prefixed with its big-endian length.
/// The browser is configured for Annex B — start codes, no `description` — and
/// the reason for choosing Annex B over handing WebCodecs an `avcC`/`hvcC`
/// blob is late joiners. With Annex B the parameter sets can be prepended to
/// every keyframe, so a viewer that opens the monitor mid-broadcast is
/// self-sufficient from the next keyframe onward rather than needing a config
/// that was sent before it arrived. (The relay caches the config too; this is
/// the belt to that's braces, and it costs about 40 bytes twice a second.)
enum NALUnit {
    static let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]

    enum Codec {
        case h264
        case hevc

        var videoToolboxType: CMVideoCodecType {
            switch self {
            case .h264: return kCMVideoCodecType_H264
            case .hevc: return kCMVideoCodecType_HEVC
            }
        }
    }

    // MARK: - Parameter sets

    /// Extract SPS/PPS (or VPS/SPS/PPS) as an Annex B blob.
    ///
    /// - Returns: The parameter sets, each preceded by a start code, or `nil`
    ///   if the format description carries none.
    static func parameterSets(from formatDescription: CMFormatDescription, codec: Codec) -> Data? {
        var count = 0

        let countStatus = getParameterSet(
            formatDescription, codec: codec, index: 0,
            pointer: nil, size: nil, count: &count, nalLength: nil
        )

        guard countStatus == noErr, count > 0 else { return nil }

        var out = Data()

        for index in 0 ..< count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0

            let status = getParameterSet(
                formatDescription, codec: codec, index: index,
                pointer: &pointer, size: &size, count: nil, nalLength: nil
            )

            guard status == noErr, let pointer else { return nil }

            out.append(contentsOf: startCode)
            out.append(pointer, count: size)
        }

        return out
    }

    /// Length in bytes of the AVCC size prefix on each NAL unit. Always 4 from
    /// VideoToolbox in practice, but reading it is free and assuming it is not.
    static func nalLengthSize(of formatDescription: CMFormatDescription, codec: Codec) -> Int {
        var nalLength: Int32 = 4
        var count = 0

        _ = getParameterSet(
            formatDescription, codec: codec, index: 0,
            pointer: nil, size: nil, count: &count, nalLength: &nalLength
        )

        return Int(nalLength)
    }

    /// Thin shim over the two near-identical C entry points.
    private static func getParameterSet(
        _ formatDescription: CMFormatDescription,
        codec: Codec,
        index: Int,
        pointer: UnsafeMutablePointer<UnsafePointer<UInt8>?>?,
        size: UnsafeMutablePointer<Int>?,
        count: UnsafeMutablePointer<Int>?,
        nalLength: UnsafeMutablePointer<Int32>?
    ) -> OSStatus {
        switch codec {
        case .h264:
            return CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: pointer,
                parameterSetSizeOut: size,
                parameterSetCountOut: count,
                nalUnitHeaderLengthOut: nalLength
            )
        case .hevc:
            return CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: pointer,
                parameterSetSizeOut: size,
                parameterSetCountOut: count,
                nalUnitHeaderLengthOut: nalLength
            )
        }
    }

    // MARK: - AVCC to Annex B

    /// Rewrite an encoded sample's length prefixes as start codes.
    ///
    /// - Parameter nalLengthSize: From ``nalLengthSize(of:codec:)``.
    static func annexB(from sampleBuffer: CMSampleBuffer, nalLengthSize: Int) -> Data? {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }

        let totalLength = CMBlockBufferGetDataLength(block)
        guard totalLength > 0 else { return nil }

        // Copy rather than walking the block buffer in place: it is not
        // guaranteed contiguous, and a copy is needed anyway to rewrite the
        // prefixes without mutating VideoToolbox's buffer.
        var source = [UInt8](repeating: 0, count: totalLength)
        let status = CMBlockBufferCopyDataBytes(
            block, atOffset: 0, dataLength: totalLength, destination: &source
        )
        guard status == kCMBlockBufferNoErr else { return nil }

        // When the prefix is already four bytes the output is the same size,
        // so reserve exactly once and let the common case be a straight swap.
        var out = Data(capacity: totalLength + (totalLength / 1024) * 4)
        var cursor = 0

        while cursor + nalLengthSize <= totalLength {
            var nalLength = 0
            for offset in 0 ..< nalLengthSize {
                nalLength = (nalLength << 8) | Int(source[cursor + offset])
            }

            cursor += nalLengthSize

            // A length running past the end means the sample is malformed;
            // emitting a truncated NAL would put the decoder into a worse
            // state than dropping the frame.
            guard nalLength > 0, cursor + nalLength <= totalLength else { return nil }

            out.append(contentsOf: startCode)
            source.withUnsafeBufferPointer { buffer in
                out.append(buffer.baseAddress! + cursor, count: nalLength)
            }

            cursor += nalLength
        }

        return out.isEmpty ? nil : out
    }

    /// True when the sample is an IDR/keyframe a decoder can start from.
    ///
    /// VideoToolbox marks this by the *absence* of `NotSync`, and the
    /// attachment array is empty for sync samples — so a missing attachment
    /// means keyframe, which is the opposite of how it reads.
    static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[CFString: Any]],
            let first = attachments.first
        else {
            return true
        }

        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    // MARK: - Codec strings

    /// Build the RFC 6381 codec string WebCodecs needs to configure a decoder.
    ///
    /// Derived from the actual bitstream rather than from the settings we
    /// asked for, because VideoToolbox is free to pick a different level than
    /// requested and a decoder configured for the wrong one may refuse the
    /// stream outright.
    static func codecString(for formatDescription: CMFormatDescription, codec: Codec) -> String? {
        switch codec {
        case .h264: return avcCodecString(formatDescription)
        case .hevc: return hevcCodecString(formatDescription)
        }
    }

    /// `avc1.PPCCLL` — profile_idc, constraint flags and level_idc, in hex.
    ///
    /// These are bytes 1–3 of the SPS, immediately after its one-byte NAL
    /// header, so no bitstream parsing is required.
    private static func avcCodecString(_ formatDescription: CMFormatDescription) -> String? {
        var pointer: UnsafePointer<UInt8>?
        var size = 0

        let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDescription,
            parameterSetIndex: 0,
            parameterSetPointerOut: &pointer,
            parameterSetSizeOut: &size,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
        )

        guard status == noErr, let sps = pointer, size >= 4 else { return nil }

        return String(format: "avc1.%02X%02X%02X", sps[1], sps[2], sps[3])
    }

    /// `hvc1.1.6.L93.B0` and friends.
    ///
    /// Assembled from the fixed-layout prefix of the `hvcC` atom, which is the
    /// only part of it with a stable offset — everything after byte 21 is a
    /// variable-length array of parameter sets.
    private static func hevcCodecString(_ formatDescription: CMFormatDescription) -> String? {
        guard
            let atoms = CMFormatDescriptionGetExtension(
                formatDescription,
                extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
            ) as? [String: Any],
            let hvcC = atoms["hvcC"] as? Data,
            hvcC.count >= 13
        else {
            return nil
        }

        let bytes = [UInt8](hvcC)

        let profileSpace = (bytes[1] & 0xC0) >> 6
        let tierFlag = (bytes[1] & 0x20) >> 5
        let profileIdc = bytes[1] & 0x1F

        var compatibility: UInt32 = 0
        for offset in 2 ... 5 {
            compatibility = (compatibility << 8) | UInt32(bytes[offset])
        }

        // The compatibility flags are written bit-reversed in the codec string.
        var reversed: UInt32 = 0
        for bit in 0 ..< 32 {
            reversed = (reversed << 1) | ((compatibility >> UInt32(bit)) & 1)
        }

        // Six constraint bytes, trailing zeros omitted.
        var constraints = Array(bytes[6 ... 11])
        while constraints.last == 0 { constraints.removeLast() }

        let spacePrefix = ["", "A", "B", "C"][Int(profileSpace)]
        let tier = tierFlag == 0 ? "L" : "H"

        var result = "hvc1.\(spacePrefix)\(profileIdc).\(String(reversed, radix: 16))"
        result += ".\(tier)\(bytes[12])"

        if !constraints.isEmpty {
            result += "." + constraints.map { String(format: "%02X", $0) }.joined(separator: ".")
        }

        return result
    }
}
