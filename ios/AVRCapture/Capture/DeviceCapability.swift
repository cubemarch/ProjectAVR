import AVFoundation
import CoreMedia
import Foundation
import UIKit
import VideoToolbox

/// What this particular phone can actually do.
///
/// Every answer here is asked of the system at runtime. There is no model-name
/// table and there must never be one: "iPhone 15 Pro and later" is a marketing
/// fact, not a capability, and the set of cameras that can run *simultaneously*
/// is not derivable from the set of cameras that exist. A phone with three rear
/// lenses may permit exactly one pair of them in a multi-cam session, and which
/// pair is not something this app gets to assume.
///
/// The report is also the diagnostics export, which is the other reason it is a
/// value type rather than a pile of `if` statements spread through the capture
/// code: an operator with a stereo problem can send the whole thing.
struct DeviceCapabilityReport: Sendable {
    struct Camera: Identifiable, Sendable {
        var id: String { uniqueID }
        let uniqueID: String
        let localizedName: String
        let deviceType: String
        let position: String
        /// Widest field of view across the device's formats, in degrees.
        let maxFieldOfView: Float
        let maxDimensions: String
        let maxFrameRate: Double
        let supportsHDR: Bool
        /// Formats usable inside an `AVCaptureMultiCamSession`, which is a
        /// strict and much smaller subset of `formats`.
        let multiCamFormatCount: Int
        let totalFormatCount: Int
    }

    struct CameraPair: Identifiable, Sendable {
        var id: String { names.joined(separator: "+") }
        let names: [String]
    }

    let multiCamSupported: Bool
    let cameras: [Camera]
    /// Combinations the system will permit in one session. Empty on a device
    /// with no multi-cam support at all.
    let supportedMultiCamSets: [CameraPair]
    let h264HardwareEncode: Bool
    let hevcHardwareEncode: Bool
    let thermalState: ProcessInfo.ThermalState
    let systemName: String
    let deviceModel: String

    /// Can this device run the stereo pipeline as written — the wide and the
    /// ultra-wide, together?
    ///
    /// Not the same question as `multiCamSupported`. A device can support
    /// multi-cam and still not offer this specific pair.
    var supportsWideAndUltraWideTogether: Bool {
        guard multiCamSupported else { return false }
        return supportedMultiCamSets.contains { set in
            set.names.contains { $0.contains("UltraWide") } && set.names.contains { $0.contains("WideAngle") }
        }
    }

    /// Why stereo is unavailable, in one sentence, or `nil` when it is
    /// available. The UI shows this verbatim: "unavailable" without a reason is
    /// what makes people file bugs against working hardware.
    var stereoUnavailableReason: String? {
        if !multiCamSupported {
            return "This device cannot run two cameras at once. Stereo side-by-side needs an iPhone XS or later."
        }
        if !supportsWideAndUltraWideTogether {
            return "This device runs two cameras at once, but not the wide and ultra-wide pair that stereo side-by-side needs."
        }
        return nil
    }
}

enum DeviceCapabilityService {
    /// Every rear and front camera the system will hand out, in one pass.
    ///
    /// `.builtInWideAngleCamera` is listed explicitly alongside the virtual
    /// devices because a discovery session that asks only for virtual types
    /// silently returns nothing on a single-lens phone.
    private static let deviceTypes: [AVCaptureDevice.DeviceType] = [
        .builtInWideAngleCamera,
        .builtInUltraWideCamera,
        .builtInTelephotoCamera,
        .builtInDualCamera,
        .builtInDualWideCamera,
        .builtInTripleCamera,
        .builtInTrueDepthCamera
    ]

    static func report() -> DeviceCapabilityReport {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: deviceTypes,
            mediaType: .video,
            position: .unspecified
        )

        let cameras = discovery.devices.map(describe)

        let sets = discovery.supportedMultiCamDeviceSets.map { deviceSet in
            DeviceCapabilityReport.CameraPair(
                names: deviceSet.map { shortType($0.deviceType) }.sorted()
            )
        }

        return DeviceCapabilityReport(
            multiCamSupported: AVCaptureMultiCamSession.isMultiCamSupported,
            cameras: cameras,
            supportedMultiCamSets: sets,
            h264HardwareEncode: canEncode(kCMVideoCodecType_H264),
            hevcHardwareEncode: canEncode(kCMVideoCodecType_HEVC),
            thermalState: ProcessInfo.processInfo.thermalState,
            systemName: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            deviceModel: UIDevice.current.model
        )
    }

    private static func describe(_ device: AVCaptureDevice) -> DeviceCapabilityReport.Camera {
        var maxWidth: Int32 = 0
        var maxHeight: Int32 = 0
        var maxRate: Double = 0
        var maxFov: Float = 0
        var hdr = false
        var multiCamFormats = 0

        for format in device.formats {
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            if Int(size.width) * Int(size.height) > Int(maxWidth) * Int(maxHeight) {
                maxWidth = size.width
                maxHeight = size.height
            }

            maxRate = max(maxRate, format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0)
            maxFov = max(maxFov, format.videoFieldOfView)
            if format.isVideoHDRSupported { hdr = true }
            if format.isMultiCamSupported { multiCamFormats += 1 }
        }

        return .init(
            uniqueID: device.uniqueID,
            localizedName: device.localizedName,
            deviceType: shortType(device.deviceType),
            position: position(device.position),
            maxFieldOfView: maxFov,
            maxDimensions: "\(maxWidth)x\(maxHeight)",
            maxFrameRate: maxRate,
            supportsHDR: hdr,
            multiCamFormatCount: multiCamFormats,
            totalFormatCount: device.formats.count
        )
    }

    /// Is there an encoder for this codec at a realistic broadcast size?
    ///
    /// Asked at 1920x1080 rather than abstractly, because "the codec exists" and
    /// "the codec exists at the size we are about to ask for" are different
    /// answers on constrained hardware, and the second one is the one that
    /// matters an hour into a shoot.
    private static func canEncode(_ codec: CMVideoCodecType) -> Bool {
        var encoderID: CFString?
        var properties: CFDictionary?

        let status = VTCopySupportedPropertyDictionaryForEncoder(
            width: 1920,
            height: 1080,
            codecType: codec,
            encoderSpecification: nil,
            encoderIDOut: &encoderID,
            supportedPropertiesOut: &properties
        )

        return status == noErr && encoderID != nil
    }

    /// `AVCaptureDeviceTypeBuiltInUltraWideCamera` → `UltraWideCamera`.
    private static func shortType(_ type: AVCaptureDevice.DeviceType) -> String {
        type.rawValue
            .replacingOccurrences(of: "AVCaptureDeviceTypeBuiltIn", with: "")
            .replacingOccurrences(of: "AVCaptureDeviceType", with: "")
    }

    private static func position(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .back: return "Back"
        case .front: return "Front"
        default: return "Unspecified"
        }
    }
}

// MARK: - Export

extension DeviceCapabilityReport {
    /// Plain text, for the share sheet.
    ///
    /// Everything here is hardware description. No destination address, no
    /// stream key, no broadcast name, nothing identifying the operator — an
    /// export that cannot be shared without reading it first will not be
    /// shared, and then the support request arrives with no information in it.
    func exportText() -> String {
        var lines: [String] = []

        lines.append("AVR Capture diagnostics")
        lines.append("App          \(SupportLinks.version)")
        lines.append("Device       \(deviceModel), \(systemName)")
        lines.append("Thermal      \(Self.thermalLabel(thermalState))")
        lines.append("Multi-cam    \(multiCamSupported ? "supported" : "not supported")")
        lines.append("Stereo pair  \(supportsWideAndUltraWideTogether ? "wide + ultra-wide available" : (stereoUnavailableReason ?? "unavailable"))")
        lines.append("Encoders     H.264 \(h264HardwareEncode ? "yes" : "no"), HEVC \(hevcHardwareEncode ? "yes" : "no")")
        lines.append("")

        lines.append("Cameras")
        for camera in cameras {
            lines.append("  \(camera.position) \(camera.deviceType)")
            lines.append("    max        \(camera.maxDimensions) @ \(Int(camera.maxFrameRate))")
            lines.append("    fov        \(String(format: "%.1f", camera.maxFieldOfView))°")
            lines.append("    hdr        \(camera.supportsHDR ? "yes" : "no")")
            lines.append("    formats    \(camera.multiCamFormatCount) multi-cam of \(camera.totalFormatCount)")
        }

        lines.append("")
        lines.append("Simultaneous combinations")
        if supportedMultiCamSets.isEmpty {
            lines.append("  none")
        } else {
            for set in supportedMultiCamSets.sorted(by: { $0.id < $1.id }) {
                lines.append("  \(set.names.joined(separator: " + "))")
            }
        }

        return lines.joined(separator: "\n")
    }

    static func thermalLabel(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}
