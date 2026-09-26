import SwiftUI

/// What this phone can do, and what the capture graph is currently doing.
///
/// Exists because "stereo is unavailable" and "the right eye is black" are both
/// answerable from the device, and answering them on the device is enormously
/// cheaper than answering them over email. The export is plain text and
/// contains no destination address, no stream key and no broadcast name, so it
/// can be sent to anyone without the operator having to audit it first.
struct DiagnosticsView: View {
    @EnvironmentObject private var broadcast: BroadcastController

    private var report: DeviceCapabilityReport { broadcast.capabilities }

    var body: some View {
        Form {
            summarySection
            camerasSection
            combinationsSection
            captureSection
            returnAudioSection
            shareSection
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var summarySection: some View {
        Section {
            LabeledContent("App", value: SupportLinks.version)
            LabeledContent("Device", value: report.deviceModel)
            LabeledContent("System", value: report.systemName)
            LabeledContent("Thermal", value: DeviceCapabilityReport.thermalLabel(ProcessInfo.processInfo.thermalState))
            LabeledContent("Two cameras at once", value: report.multiCamSupported ? "Supported" : "Not supported")
            LabeledContent("H.264 encoder", value: report.h264HardwareEncode ? "Hardware" : "Unavailable")
            LabeledContent("HEVC encoder", value: report.hevcHardwareEncode ? "Hardware" : "Unavailable")

            if let reason = report.stereoUnavailableReason {
                Label(reason, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("This device")
        }
    }

    private var camerasSection: some View {
        Section("Cameras") {
            ForEach(report.cameras) { camera in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(camera.position) \(camera.deviceType)")
                        .font(.subheadline.weight(.medium))

                    Text("\(camera.maxDimensions) at up to \(Int(camera.maxFrameRate)) fps · \(String(format: "%.0f", camera.maxFieldOfView))° · \(camera.supportsHDR ? "HDR" : "no HDR")")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Text("\(camera.multiCamFormatCount) of \(camera.totalFormatCount) formats work in a two-camera session")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var combinationsSection: some View {
        Section {
            if report.supportedMultiCamSets.isEmpty {
                Text("None — this device runs one camera at a time.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(report.supportedMultiCamSets) { pair in
                    Text(pair.names.joined(separator: " + "))
                        .font(.footnote.monospaced())
                }
            }
        } header: {
            Text("Simultaneous combinations")
        } footer: {
            // The reason this list is shown at all, rather than reduced to a
            // yes/no: which pairs are permitted is a per-model fact that no
            // amount of reasoning from the spec sheet will produce.
            Text("Reported by the system, not inferred from the model. Stereo Side-by-Side needs the wide and ultra-wide pair to appear here.")
        }
    }

    @ViewBuilder
    private var captureSection: some View {
        let diagnostics = broadcast.capture.diagnostics

        Section {
            LabeledContent("Side-by-Side requested", value: diagnostics.stereoRequested ? "Yes" : "No")
            LabeledContent("Ultra-wide connected", value: diagnostics.ultraWideConnected ? "Yes" : "No")
            LabeledContent("Preview connected", value: diagnostics.previewConnected ? "Yes" : "No")
            LabeledContent("Wide buffers", value: "\(diagnostics.wideBuffersSeen)")
            LabeledContent("Ultra-wide buffers", value: "\(diagnostics.ultraWideBuffersSeen)")
            LabeledContent("Pairs emitted", value: "\(diagnostics.pairsEmitted)")
            LabeledContent("Single-camera fallbacks", value: "\(diagnostics.monoFallbacks)")
            LabeledContent("Interruptions", value: "\(diagnostics.interruptions)")

            // Three rows rather than one, because "the broadcast was silent"
            // has three different causes and they need different fixes:
            // the setting is off, the microphone would not attach, or it
            // attached and is delivering nothing.
            LabeledContent("Sound requested", value: diagnostics.audioRequested ? "Yes" : "No")
            LabeledContent("Microphone connected", value: diagnostics.audioConnected ? "Yes" : "No")
            LabeledContent("Sound buffers", value: "\(diagnostics.audioBuffersSeen)")

            if let skew = diagnostics.closestSkewSeconds {
                LabeledContent("Closest eye skew", value: String(format: "%.1f ms", skew * 1000))
            }

            if let error = diagnostics.runtimeError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        } header: {
            Text("Current session")
        } footer: {
            Text("Counted since the camera was started. Ultra-wide buffers at zero means that camera is not delivering frames at all, which is a different fault from frames arriving unpaired.")
        }
    }

    /// Only drawn once return audio has actually been opened. A row of zeroes
    /// on a screen full of real numbers reads as a fault in a feature the
    /// operator is not using.
    @ViewBuilder
    private var returnAudioSection: some View {
        let stats = broadcast.returnAudioStats

        if stats.isRunning || stats.packetsPlayed > 0 {
            Section {
                LabeledContent("Open", value: stats.isRunning ? "Yes" : "No")
                LabeledContent("Packets played", value: "\(stats.packetsPlayed)")
                LabeledContent("Dropped (behind)", value: "\(stats.packetsDropped)")
                LabeledContent("Rejected (malformed)", value: "\(stats.packetsRejected)")
                LabeledContent("Buffered", value: "\(stats.queuedMilliseconds) ms")
            } header: {
                Text("Return audio")
            } footer: {
                Text("Audio the destination sent back. Dropped means it arrived faster than it could be played and the oldest was discarded to stay live; rejected means it was not the format this app plays.")
            }
        }
    }

    private var shareSection: some View {
        Section {
            ShareLink(item: report.exportText()) {
                Label("Share diagnostics", systemImage: "square.and.arrow.up")
            }
        } footer: {
            Text("Hardware details only. No destination address, no stream key, no broadcast name.")
        }
    }
}
