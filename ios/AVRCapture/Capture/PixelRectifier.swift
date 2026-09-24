import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os

/// Makes two mismatched cameras look like a stereo pair.
///
/// The back cameras on an iPhone are not a stereo rig. They sit at different
/// points on the body, they have different fields of view, and on most models
/// they have different sensors. The ultra-wide sees roughly 106–120° where the
/// wide sees 71–77°, so a naïve side-by-side of their raw output is not a
/// stereo image at all — it is two different photographs, and the eye reads the
/// mismatch as discomfort within seconds.
///
/// The fix is to crop the wider camera down to the narrower one's field of view
/// and scale the result back up. That throws away real resolution from the
/// ultra-wide, which is the correct trade: matched geometry at lower detail is
/// comfortable, mismatched geometry at full detail is not.
///
/// What this deliberately does **not** do is rectify for the vertical offset
/// between the lenses, correct their differing distortion profiles, or colour
/// match the two sensors. Those need per-device calibration data this app has
/// no way to obtain, and the honest description of the output is "a usable
/// stereo effect", not "a calibrated stereo pair". See `docs/LIVE.md`.
final class PixelRectifier {
    struct Geometry {
        /// Horizontal field of view the output should represent, in degrees.
        let targetFovDegrees: Double
        /// Horizontal field of view this camera actually has, in degrees.
        let sourceFovDegrees: Double
        let outputWidth: Int
        let outputHeight: Int

        /// Fraction of the source width that survives the crop.
        ///
        /// Field of view is an angle but the sensor is a plane, so the ratio
        /// runs through the tangents rather than the degrees. At 120° source
        /// and 73° target the difference matters: the tangent ratio gives 0.43
        /// where a naive 73/120 would give 0.61, and the eyes would still not
        /// agree.
        var cropFactor: Double {
            guard sourceFovDegrees > targetFovDegrees else { return 1 }

            let target = tan(targetFovDegrees * .pi / 360)
            let source = tan(sourceFovDegrees * .pi / 360)

            guard source > 0 else { return 1 }

            return min(1, target / source)
        }
    }

    private let log = Logger(subsystem: "com.projectavr.capture", category: "rectifier")

    private var session: VTPixelTransferSession?
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private var poolFormat: OSType = 0

    private let geometry: Geometry

    init?(geometry: Geometry) {
        self.geometry = geometry

        var created: VTPixelTransferSession?
        let status = VTPixelTransferSessionCreate(
            allocator: kCFAllocatorDefault,
            pixelTransferSessionOut: &created
        )

        guard status == noErr, let created else {
            log.error("could not create a pixel transfer session: \(status)")
            return nil
        }

        // Crop to the clean aperture set on each incoming buffer, then scale
        // the remainder to fill the destination.
        VTSessionSetProperty(
            created,
            key: kVTPixelTransferPropertyKey_ScalingMode,
            value: kVTScalingMode_CropSourceToCleanAperture
        )

        // The crop can be aggressive, so the resample quality is visible.
        VTSessionSetProperty(
            created,
            key: kVTPixelTransferPropertyKey_DownsamplingMode,
            value: kVTDownsamplingMode_Average
        )

        session = created
    }

    deinit {
        if let session {
            VTPixelTransferSessionInvalidate(session)
        }
    }

    /// True when this camera's field of view already matches the target and the
    /// transfer would only be a resize.
    var isIdentityCrop: Bool {
        geometry.cropFactor > 0.999
    }

    /// Crop and scale one frame.
    ///
    /// - Returns: A new buffer from the internal pool, or `nil` if the transfer
    ///   failed. A `nil` here drops one frame rather than sending a mismatched
    ///   eye, which is the right way round: a dropped frame is a brief judder,
    ///   a mismatched eye is nausea.
    func rectify(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        guard let session else { return nil }

        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        let format = CVPixelBufferGetPixelFormatType(source)

        applyCleanAperture(to: source, width: sourceWidth, height: sourceHeight)

        guard let pool = pool(for: format) else { return nil }

        var destination: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &destination)

        guard status == kCVReturnSuccess, let destination else {
            log.error("pixel buffer pool exhausted: \(status)")
            return nil
        }

        let transfer = VTPixelTransferSessionTransferImage(session, from: source, to: destination)

        guard transfer == noErr else {
            log.error("pixel transfer failed: \(transfer)")
            return nil
        }

        return destination
    }

    /// Tag the source with the region the transfer session should keep.
    ///
    /// The clean aperture is expressed as a size plus an offset *from the
    /// centre*, not as an origin — so a centred crop has offsets of zero
    /// regardless of how much is being removed.
    private func applyCleanAperture(to buffer: CVPixelBuffer, width: Int, height: Int) {
        let factor = geometry.cropFactor

        guard factor < 0.999 else {
            CVBufferRemoveAttachment(buffer, kCVImageBufferCleanApertureKey)
            return
        }

        // Crop both axes by the same factor: cropping only the width would
        // change the aspect ratio, and the scale back up would stretch the
        // image relative to the other eye.
        let cropWidth = (Double(width) * factor).rounded(.down)
        let cropHeight = (Double(height) * factor).rounded(.down)

        let aperture: [CFString: Any] = [
            kCVImageBufferCleanApertureWidthKey: cropWidth,
            kCVImageBufferCleanApertureHeightKey: cropHeight,
            kCVImageBufferCleanApertureHorizontalOffsetKey: 0,
            kCVImageBufferCleanApertureVerticalOffsetKey: 0
        ]

        CVBufferSetAttachment(
            buffer,
            kCVImageBufferCleanApertureKey,
            aperture as CFDictionary,
            .shouldPropagate
        )
    }

    private func pool(for format: OSType) -> CVPixelBufferPool? {
        if let pool, poolWidth == geometry.outputWidth, poolHeight == geometry.outputHeight,
           poolFormat == format {
            return pool
        }

        let poolAttributes: [CFString: Any] = [
            // Enough for the encoder to hold a couple of frames in flight
            // without the capture queue blocking on an empty pool.
            kCVPixelBufferPoolMinimumBufferCountKey: 6
        ]

        let bufferAttributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: format,
            kCVPixelBufferWidthKey: geometry.outputWidth,
            kCVPixelBufferHeightKey: geometry.outputHeight,
            // Without an IOSurface the encoder cannot take the buffer by
            // reference and the frame is copied through the CPU on its way to
            // hardware that could have read it directly.
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
        ]

        var created: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttributes as CFDictionary,
            bufferAttributes as CFDictionary,
            &created
        )

        guard status == kCVReturnSuccess, let created else {
            log.error("could not create a pixel buffer pool: \(status)")
            return nil
        }

        pool = created
        poolWidth = geometry.outputWidth
        poolHeight = geometry.outputHeight
        poolFormat = format

        return created
    }
}
