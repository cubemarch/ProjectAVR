import SwiftUI

/// Everything that is set once and then left alone.
///
/// Split out of the viewfinder deliberately: a control that is only touched
/// during setup should not be on screen during a shoot, where it is one
/// mis-tap away from changing the encoder mid-broadcast. Most of these are
/// disabled while live for the same reason.
struct SettingsView: View {
    @EnvironmentObject private var config: CaptureConfig
    @EnvironmentObject private var destinations: DestinationStore
    @EnvironmentObject private var broadcast: BroadcastController
    @Environment(\.dismiss) private var dismiss

    @State private var confirmingErase = false
    @State private var showingRights = false

    private var live: Bool { broadcast.status.isActive }

    var body: some View {
        NavigationStack {
            Form {
                destinationSection
                captureSection
                soundSection
                returnAudioSection
                stereoSection
                lensSection
                behaviourSection
                aboutSection
                dataSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showingRights) {
                RightsAcknowledgementView()
                    .environmentObject(config)
            }
            .alert("Keychain", isPresented: keychainFailureBinding) {
                Button("OK", role: .cancel) { destinations.keychainFailure = nil }
            } message: {
                Text("A stream key could not be saved: \(destinations.keychainFailure ?? ""). It will work for this session but will not be remembered.")
            }
            .confirmationDialog(
                "Erase everything stored on this device?",
                isPresented: $confirmingErase,
                titleVisibility: .visible
            ) {
                Button("Erase", role: .destructive, action: erase)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Deletes every destination, every stored stream key, and your acknowledgement of the broadcasting terms. Capture settings are kept.")
            }
        }
    }

    // MARK: - Destination

    private var destinationSection: some View {
        Section {
            NavigationLink {
                DestinationsView()
                    .environmentObject(destinations)
                    .environmentObject(broadcast)
            } label: {
                LabeledContent("Destination") {
                    Text(destinations.selected?.name ?? "None")
                        .foregroundStyle(destinations.selected == nil ? .secondary : .primary)
                }
            }

            if let selected = destinations.selected {
                LabeledContent("Address", value: selected.endpointLabel)
                LabeledContent("Encrypted", value: selected.encryptedLabel)

                // Only for a destination that leaves the building. Cleartext on
                // a studio LAN is a normal choice and warning about it here
                // every time would teach the operator to ignore the row that
                // matters.
                if !selected.usesTLS && !selected.isLocalNetwork {
                    Label("This destination is on the public internet and is not encrypted.", systemImage: "lock.open")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if !destinations.hasSecret(for: selected.id) {
                    Label("No stream key stored for this destination.", systemImage: "key.slash")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            LabeledContent("Broadcast name") {
                TextField(config.displayName, text: $config.broadcastName)
                    .multilineTextAlignment(.trailing)
            }
        } header: {
            Text("Where it goes")
        } footer: {
            Text("The app has no default destination and connects nowhere on its own. The name is what the destination lists this broadcast as.")
        }
        .disabled(live)
    }

    // MARK: - Capture

    private var captureSection: some View {
        Section {
            // Not segmented. "Stereo Side-by-Side" is the term the web Studio
            // asks creators to broadcast in and the term the brief fixes, and
            // it does not fit in a segment — abbreviating it here would put the
            // two products back to using different words for one control. The
            // menu style also matches Quality, Codec and Projection around it.
            Picker("Mode", selection: modeBinding) {
                ForEach(CaptureConfig.Mode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .disabled(!broadcast.supportsStereo)

            Text(config.mode.detail)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let reason = broadcast.stereoUnavailableReason {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            Picker("Quality", selection: qualityBinding) {
                ForEach(CaptureConfig.Quality.allCases) { quality in
                    Text(quality.label).tag(quality)
                }
            }

            Picker("Frame rate", selection: $config.frameRate) {
                Text("30 fps").tag(30)
                Text("60 fps").tag(60)
            }

            Picker("Codec", selection: codecBinding) {
                ForEach(CaptureConfig.Codec.allCases) { codec in
                    Text(codec.label).tag(codec)
                }
            }

            Text(config.codec.note)
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Bitrate", value: bitrateLabel)

                Slider(
                    value: Binding(
                        get: { Double(config.bitrate) },
                        set: { config.bitrate = Int($0) }
                    ),
                    in: 2_000_000...24_000_000,
                    step: 1_000_000
                )
            }
        } header: {
            Text("Capture")
        } footer: {
            Text("This is the ceiling, not a promise. The app lowers the bitrate on its own when the link cannot keep up, and raises it again slowly once it can.")
        }
        .disabled(live)
    }

    private var bitrateLabel: String {
        let mbps = config.bitrate / 1_000_000
        return broadcast.effectiveStereo ? "\(mbps) Mbps per eye" : "\(mbps) Mbps"
    }

    // MARK: - Sound

    /// Not disabled while live, unlike the rest of capture.
    ///
    /// The capture graph cannot be rebuilt under a live broadcast, so toggling
    /// this mid-shoot takes effect at the next one and says so — but greying
    /// the control out would read as "this app cannot do sound", which is a
    /// worse misunderstanding than a deferred setting.
    private var soundSection: some View {
        Section {
            Toggle("Sound", isOn: $config.captureAudio)

            if config.captureAudio && broadcast.microphoneDenied {
                Button(action: openSettings) {
                    Label(
                        "Microphone access is off. Turn it on in Settings › Privacy & Security › Microphone.",
                        systemImage: "mic.slash"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        } header: {
            Text("Sound")
        } footer: {
            Text("Sound is captured from the microphone and sent with the picture. With this off the app does not attach a microphone at all: it never asks for access, never appears under Settings › Privacy & Security › Microphone, and the orange recording dot stays dark. Changed while live, it applies to the next broadcast.")
        }
    }

    // MARK: - Return audio

    /// Talkback, in the sense a broadcast engineer means it: the destination
    /// can speak to the person holding the camera. Nothing is sent back along
    /// this path, and it is off until the operator turns it on.
    private var returnAudioSection: some View {
        Section {
            Toggle("Return audio", isOn: $config.returnAudio)

            if config.returnAudio {
                Label(
                    "Use headphones. On the speaker, the microphone will pick this up and send it back out in the broadcast.",
                    systemImage: "headphones"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if case let .failed(message) = broadcast.returnAudio {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        } header: {
            Text("Return audio")
        } footer: {
            Text("Plays audio the destination sends back, so whoever is receiving the feed can talk to you while you are shooting. One way: nothing from this phone goes out on it, and it is separate from the broadcast's own sound. Not every destination sends it — with this on and a server that does not, you will hear nothing.")
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - Stereo

    private var stereoSection: some View {
        Section {
            Toggle("Swap left and right eyes", isOn: $config.swapEyes)
                .disabled(config.mode == .mono)

            Picker("Projection", selection: projectionBinding) {
                ForEach(CaptureConfig.Projection.allCases) { projection in
                    Text(projection.label).tag(projection)
                }
            }

            Text(config.projection.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Geometry")
        } footer: {
            // The single most important sentence in this screen.
            Text("Check the eye order through a headset before a real shoot. Reversed eyes invert the depth of the whole scene, and it reads as mildly uncomfortable rather than obviously broken — which is how it gets shipped.")
        }
    }

    // MARK: - Lens matching

    private var lensSection: some View {
        Section {
            Toggle("Match the lenses", isOn: $config.matchLenses)
                .disabled(config.mode == .mono)

            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Right eye trim", value: trimLabel)

                Slider(
                    value: $config.lensTrimStops,
                    // Asymmetric on purpose. The ultra-wide is the darker of
                    // the two on every phone this runs on — smaller aperture,
                    // smaller pixels — so the useful travel is almost all
                    // upwards, and four stops is enough to cover the sensor
                    // difference rather than just the aperture difference.
                    in: -2...4,
                    // A sixth of a stop. Below that the change is not visible;
                    // much above it and the slider skips past the right answer.
                    step: 1.0 / 6.0
                )
                .disabled(!config.matchLenses || config.mode == .mono)
            }
        } header: {
            Text("Lens matching")
        } footer: {
            Text("The ultra-wide gathers less light than the wide camera and colours the scene slightly differently. Matching holds it to the wide camera's exposure and white balance so the two eyes agree. Use the trim if the right eye still looks off — it can be moved while live.")
        }
    }

    /// Stops, signed, to two places. Signed because the sign is the whole
    /// point: the operator is answering "is the right eye dark or bright?"
    private var trimLabel: String {
        if abs(config.lensTrimStops) < 0.01 { return "None" }
        return String(format: "%+.2f stops", config.lensTrimStops)
    }

    // MARK: - Behaviour

    private var behaviourSection: some View {
        Section {
            Toggle("Reconnect automatically", isOn: $config.autoReconnect)
            Toggle("Drop to one camera when hot", isOn: $config.thermalFallbackToMono)
                .disabled(!broadcast.supportsStereo)
        } header: {
            Text("While broadcasting")
        } footer: {
            Text("A phone that gets too hot for two cameras does not stop — it starts missing frames on whichever one loses the race, which shows up as a stuttering right eye. Switching to one camera keeps the picture clean for the rest of the broadcast.")
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section {
            NavigationLink {
                DiagnosticsView()
                    .environmentObject(broadcast)
            } label: {
                Label("Diagnostics", systemImage: "stethoscope")
            }

            Button {
                showingRights = true
            } label: {
                Label("Broadcasting terms", systemImage: "hand.raised")
            }

            if let privacy = SupportLinks.privacyPolicy {
                Link(destination: privacy) {
                    Label("Privacy policy", systemImage: "lock.shield")
                }
            }

            if let support = SupportLinks.support {
                Link(destination: support) {
                    Label("Support", systemImage: "questionmark.circle")
                }
            }

            LabeledContent("Version", value: SupportLinks.version)
            LabeledContent("Protocol", value: "\(Wire.protocolName) v\(Wire.protocolVersion)")
            LabeledContent("Encoder", value: "VideoToolbox, hardware")
        } header: {
            Text("About")
        }
    }

    // MARK: - Data

    private var dataSection: some View {
        Section {
            Button("Erase stored data", role: .destructive) { confirmingErase = true }
                .disabled(live)
        } footer: {
            Text("This app stores your destinations and their stream keys on this device. It has no account, sends no analytics, and uploads nothing except the broadcast you start.")
        }
    }

    private func erase() {
        destinations.eraseAll()
        config.withdrawRightsAcknowledgement()

        // Back to a genuinely first-run app, which includes being asked where
        // to broadcast again.
        config.hasSeenDestinationPrompt = false
    }

    // MARK: - Bindings
    //
    // `CaptureConfig`'s typed accessors are computed over the persisted raw
    // strings, so they are not themselves `@Published` and SwiftUI cannot bind
    // to them with `$`. These wrappers write through and keep the enum types at
    // the call site.

    private var modeBinding: Binding<CaptureConfig.Mode> {
        Binding(get: { config.mode }, set: { config.mode = $0 })
    }

    private var qualityBinding: Binding<CaptureConfig.Quality> {
        Binding(get: { config.quality }, set: { config.quality = $0 })
    }

    private var codecBinding: Binding<CaptureConfig.Codec> {
        Binding(get: { config.codec }, set: { config.codec = $0 })
    }

    private var projectionBinding: Binding<CaptureConfig.Projection> {
        Binding(get: { config.projection }, set: { config.projection = $0 })
    }

    private var keychainFailureBinding: Binding<Bool> {
        Binding(
            get: { destinations.keychainFailure != nil },
            set: { if !$0 { destinations.keychainFailure = nil } }
        )
    }
}
