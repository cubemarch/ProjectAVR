import SwiftUI
import UIKit

/// The operator's screen.
///
/// Designed for someone holding a phone at arm's length, outdoors, who is
/// pointing a camera at something rather than looking at the UI. That drives
/// every layout decision here: the viewfinder is the whole screen, there is one
/// large control, and the numbers that matter during a broadcast are readable
/// without being tapped. Everything that is only set once lives behind the
/// settings sheet.
struct ContentView: View {
    @EnvironmentObject private var config: CaptureConfig
    @EnvironmentObject private var destinations: DestinationStore
    @EnvironmentObject private var broadcast: BroadcastController

    @State private var showingSettings = false
    @State private var showingRights = false
    @State private var importCandidate: DestinationImport.Candidate?
    @State private var importError: String?
    @State private var confirmingStop = false
    @State private var showingFirstRun = false

    var body: some View {
        ZStack {
            // Under everything, so there is never a frame of white while the
            // viewfinder is being brought up. The same value as the
            // `LaunchBackground` colour set, so the launch screen and the first
            // SwiftUI frame are literally the same colour and the handover is
            // invisible.
            Color(white: 0.043).ignoresSafeArea()

            if broadcast.isCameraReady {
                viewfinder
            } else {
                StartupView(
                    status: broadcast.status,
                    permissionDenied: broadcast.permissionDenied,
                    retry: { Task { await broadcast.retryPrepare() } }
                )
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
        .animation(.easeInOut(duration: 0.25), value: broadcast.isCameraReady)
        .sheet(isPresented: $showingSettings) {
            SettingsView()
                .environmentObject(config)
                .environmentObject(destinations)
                .environmentObject(broadcast)
        }
        .sheet(isPresented: $showingRights) {
            // Accepting carries straight on into the broadcast the operator
            // was already asking for, rather than making them press the
            // shutter a second time.
            RightsAcknowledgementView(onAccept: { broadcast.start() })
                .environmentObject(config)
        }
        .sheet(item: $importCandidate) { candidate in
            NavigationStack {
                ImportConfirmationView(candidates: [candidate]) { accepted in
                    for candidate in accepted { destinations.add(candidate) }
                }
                .environmentObject(destinations)
            }
        }
        // Asked on the first launch that has nowhere to send to. Recorded on
        // dismissal however it was dismissed — swiped away counts as answered,
        // because being asked twice is worse than not being asked again.
        .sheet(isPresented: $showingFirstRun, onDismiss: { config.hasSeenDestinationPrompt = true }) {
            FirstRunDestinationView { showingFirstRun = false }
                .environmentObject(destinations)
        }
        .alert("Cannot use that link", isPresented: importErrorBinding) {
            Button("OK", role: .cancel) { importError = nil }
        } message: {
            Text(importError ?? "")
        }
        .confirmationDialog(
            "Stop the broadcast?",
            isPresented: $confirmingStop,
            titleVisibility: .visible
        ) {
            Button("Stop broadcasting", role: .destructive) { broadcast.stop() }
            Button("Keep broadcasting", role: .cancel) {}
        } message: {
            Text("You are live\(destinations.selected.map { " to \($0.name)" } ?? ""). Viewers will see the stream end.")
        }
        .task {
            await broadcast.prepare()

            // Only go looking if there is nowhere to send to yet. A repeat
            // shoot at the same location should just work, and a probe nobody
            // asked for is a local-network permission prompt nobody asked for.
            if destinations.profiles.isEmpty {
                broadcast.search()

                // Ask outright, rather than leaving a new operator to find
                // Destinations on their own. After the camera is up, so the
                // permission prompt and this are not on screen together.
                if !config.hasSeenDestinationPrompt { showingFirstRun = true }
            }
        }
        .onOpenURL(perform: review)
    }

    /// Handle an `avr://pair?…` link.
    ///
    /// It opens a confirmation sheet. It does not save anything, does not
    /// select anything, and does not connect — a link is a suggestion from
    /// whoever sent it, and an app that repoints its camera at an address
    /// because a URL was tapped is a redirection primitive rather than a
    /// broadcasting tool.
    private func review(_ url: URL) {
        do {
            importCandidate = try DestinationImport.candidate(from: url)
        } catch let error as DestinationImport.ImportError {
            importError = error.description
        } catch {
            importError = error.localizedDescription
        }
    }

    private var importErrorBinding: Binding<Bool> {
        Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })
    }

    private var viewfinder: some View {
        ZStack {
            CameraPreview(session: broadcast.capture)
                .ignoresSafeArea()
                .transition(.opacity)

            // Gradients top and bottom so white text stays legible over a bright
            // sky or a white wall, which a plain overlay does not survive.
            VStack(spacing: 0) {
                LinearGradient(colors: [.black.opacity(0.65), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: 160)
                Spacer()
                LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 220)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)

            VStack(spacing: 0) {
                StatusBar(
                    status: broadcast.status,
                    telemetry: broadcast.telemetry,
                    destination: destinations.selected?.name,
                    ready: destinations.isReadyToBroadcast,
                    returnAudio: broadcast.returnAudio,
                    mode: broadcast.effectiveStereo ? .separate : .mono,
                    modeDegraded: config.mode == .separate && !broadcast.effectiveStereo
                )
                .padding(.horizontal, 20)
                .padding(.top, 8)

                Spacer()

                if let notice = broadcast.notice {
                    NoticeBanner(text: notice) { broadcast.notice = nil }
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                Controls(
                    status: broadcast.status,
                    ready: destinations.isReadyToBroadcast,
                    onToggle: toggle,
                    onSettings: { showingSettings = true }
                )
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: broadcast.notice)
        .animation(.easeInOut(duration: 0.2), value: broadcast.status)
    }

    private func toggle() {
        if broadcast.status.isActive {
            // Confirmed rather than immediate, and only when actually on air:
            // the shutter is a big target held at arm's length, and dropping a
            // live audience to a stray thumb is not recoverable.
            if broadcast.status.isLive {
                confirmingStop = true
            } else {
                broadcast.stop()
            }
        } else if !config.hasAcknowledgedRights {
            showingRights = true
        } else if destinations.isReadyToBroadcast {
            broadcast.start()
        } else {
            showingSettings = true
        }
    }
}

// MARK: - Startup

/// What is on screen before the viewfinder exists.
///
/// Bringing up a multi-camera session takes a noticeable moment — two devices
/// are locked, formats applied and a synchroniser built — and the permission
/// prompt can sit in front of all of it indefinitely. Without something here the
/// app is a black rectangle during that window, which is indistinguishable from
/// a crash, and *also* indistinguishable from the several real failures that
/// leave it black permanently. So this screen always says which of those it is.
private struct StartupView: View {
    let status: BroadcastController.Status
    let permissionDenied: Bool
    let retry: () -> Void

    /// Matches the launch image, which is generated at this size by
    /// `ios/Tools/make-launch-logo.swift`.
    static let glyphPoints: CGFloat = 46

    var body: some View {
        // The glyph is centred on its own rather than sitting at the top of a
        // stack, because iOS centres the launch image and anything else here
        // would make it jump the instant SwiftUI takes over. The words arrive
        // underneath it; the glyph itself does not move.
        ZStack {
            Image(systemName: symbol)
                .font(.system(size: Self.glyphPoints, weight: .light))
                .foregroundStyle(.white.opacity(0.9))
                .symbolEffect(.pulse, options: .repeating, isActive: isWorking)
                .contentTransition(.symbolEffect(.replace))

            VStack(spacing: 14) {
                Spacer()

                VStack(spacing: 8) {
                    Text("AVR Capture")
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .foregroundStyle(.white)

                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.65))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 420)
                }

                if isWorking {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.white.opacity(0.7))
                } else {
                    HStack(spacing: 12) {
                        if permissionDenied {
                            Button("Open Settings", action: openSettings)
                                .buttonStyle(.borderedProminent)
                        }

                        Button("Try Again", action: retry)
                            .buttonStyle(.bordered)
                    }
                    .tint(.white)
                }
            }
            // Clear of the centred glyph above, and off the bottom edge.
            .padding(.top, Self.glyphPoints * 2)
            .padding(.bottom, 36)
            .padding(.horizontal, 40)
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .animation(.easeInOut(duration: 0.2), value: message)
        .transition(.opacity)
    }

    private var isWorking: Bool {
        if case .error = status { return false }
        return !permissionDenied
    }

    private var symbol: String {
        if permissionDenied { return "lock.shield" }
        if case .error = status { return "exclamationmark.triangle" }
        return "camera.aperture"
    }

    private var message: String {
        if permissionDenied {
            return """
            Camera access is off. Turn it on in Settings › Privacy & Security › \
            Camera, then come back.
            """
        }

        if case let .error(detail) = status { return detail }

        return "Starting both cameras…"
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - Status

/// The one line that is always on screen while broadcasting.
///
/// It names the destination, and it says how long the broadcast has been
/// running. Both are deliberate: an operator must never be able to wonder
/// whether they are live, or where the picture is going. Guideline 2.5.14 asks
/// for the first; a shoot where somebody forgets asks for both.
///
/// Idle splits in two. "Ready", in green, means a destination is selected *and*
/// its key is in the Keychain, so pressing the shutter will actually go
/// somewhere. Without both it reads "No destination" and stays grey, because an
/// indicator that says ready when the shutter is going to refuse is worse than
/// no indicator at all.
private struct StatusBar: View {
    let status: BroadcastController.Status
    let telemetry: BroadcastController.Telemetry
    let destination: String?

    /// `DestinationStore.isReadyToBroadcast` — a selected profile with a key.
    let ready: Bool

    /// Whether the destination's return feed is open, and whether anything is
    /// coming out of it right now.
    let returnAudio: ReturnAudioPlayer.State

    /// What is actually going out, which is not always what was selected: a
    /// phone that cannot run two cameras, or one that got too hot to, sends
    /// Standard with the setting still reading Stereo Side-by-Side.
    let mode: CaptureConfig.Mode

    /// Stereo Side-by-Side was asked for and is not what is being sent. The
    /// notice that says so is dismissible; this is not.
    let modeDegraded: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            HStack(spacing: 7) {
                Circle()
                    .fill(tint)
                    .frame(width: 9, height: 9)

                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.system(.footnote, design: .rounded).weight(.semibold))
                        .foregroundStyle(.white)

                    if status.isLive || ready {
                        HStack(spacing: 4) {
                            if let destination {
                                Text("to \(destination)")
                                Text("·")
                            }

                            Text(mode.shortLabel)
                                .foregroundStyle(modeDegraded ? Color.orange : Color.white.opacity(0.7))
                        }
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }

            Spacer()

            if status.isLive {
                // Monospaced digits: without them the readout jitters
                // horizontally every time a digit changes, which is
                // surprisingly hard to ignore in peripheral vision.
                Text(readout)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
            }

            // Sound the operator did not record is coming out of the phone.
            // That is worth saying on the one line that is always on screen,
            // both so it is not mistaken for the broadcast's own audio and so
            // an open return feed is never a surprise.
            if returnAudio == .waiting || returnAudio == .playing {
                Label(
                    "Return",
                    systemImage: returnAudio == .playing ? "speaker.wave.2.fill" : "speaker.fill"
                )
                .font(.caption2.weight(.semibold))
                .foregroundStyle(returnAudio == .playing ? .green : .white.opacity(0.6))
                .labelStyle(.titleAndIcon)
            }

            if case .starved = telemetry.stereoSync {
                Label("1 eye", systemImage: "eye.trianglebadge.exclamationmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .labelStyle(.titleAndIcon)
            }

            if telemetry.thermal == .serious || telemetry.thermal == .critical {
                Label("Hot", systemImage: "thermometer.high")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .labelStyle(.titleAndIcon)
            }
        }
    }

    private var label: String {
        switch status {
        case .idle: return ready ? "Ready" : "No destination"
        case .preparing: return "Starting camera"
        case .connecting: return "Connecting"
        case let .reconnecting(attempt, total): return "Reconnecting \(attempt)/\(total)"
        case .live: return "Live"
        case let .error(message): return message
        }
    }

    private var tint: Color {
        switch status {
        case .idle: return ready ? .green : .white.opacity(0.5)
        case .preparing, .connecting, .reconnecting: return .yellow
        case .live: return .red
        case .error: return .orange
        }
    }

    private var readout: String {
        let mbps = String(format: "%.1f", telemetry.megabitsPerSecond)
        var parts = [Self.duration(telemetry.elapsed), "\(mbps) Mbps"]

        if telemetry.framesDropped > 0 {
            parts.append("\(telemetry.framesDropped) dropped")
        }

        if telemetry.reconnections > 0 {
            parts.append("\(telemetry.reconnections) reconnect\(telemetry.reconnections == 1 ? "" : "s")")
        }

        return parts.joined(separator: "  ·  ")
    }

    /// `h:mm:ss` past an hour, `m:ss` below it. A three-hour event and a
    /// ninety-second test both want to be read at a glance.
    static func duration(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds))
        let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}

private struct NoticeBanner: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)

            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Controls

private struct Controls: View {
    let status: BroadcastController.Status
    let ready: Bool
    let onToggle: () -> Void
    let onSettings: () -> Void

    var body: some View {
        HStack {
            Button(action: onSettings) {
                Image(systemName: "slider.horizontal.3")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("Settings")

            Spacer()

            // The shutter. A ring with a shape inside it, the convention every
            // camera app on the platform uses, so it needs no label.
            Button(action: onToggle) {
                ZStack {
                    Circle()
                        .stroke(.white.opacity(0.9), lineWidth: 4)
                        .frame(width: 78, height: 78)

                    RoundedRectangle(cornerRadius: status.isLive ? 6 : 31, style: .continuous)
                        .fill(ready || status.isLive ? Color.red : Color.white.opacity(0.35))
                        .frame(
                            width: status.isLive ? 30 : 62,
                            height: status.isLive ? 30 : 62
                        )
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: status.isLive)
            }
            .accessibilityLabel(status.isLive ? "Stop broadcasting" : "Start broadcasting")
            .disabled(status.isBusy && !status.isLive)

            Spacer()

            // Balances the settings button so the shutter sits centred.
            Color.clear.frame(width: 48, height: 48)
        }
    }
}
