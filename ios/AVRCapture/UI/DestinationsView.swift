import SwiftUI
import UniformTypeIdentifiers

/// The list of places this phone can broadcast to.
///
/// A list rather than a single address field, because the app is a tool and a
/// tool gets pointed at different things: a rehearsal server, a venue's
/// encoder, a production endpoint. More importantly it makes the destination a
/// *named, chosen* thing. An operator who has to pick "Studio B" before going
/// live knows where the picture is going; one who inherits whatever address was
/// last in a text field does not.
struct DestinationsView: View {
    @EnvironmentObject private var store: DestinationStore
    @EnvironmentObject private var broadcast: BroadcastController
    @Environment(\.dismiss) private var dismiss

    @State private var editing: DestinationProfile?
    @State private var creating = false
    @State private var pairingText = ""
    @State private var pairingError: String?
    @State private var importing = false
    @State private var importError: String?
    @State private var candidates: [DestinationImport.Candidate] = []
    @State private var scanning = false
    @State private var confirmingDelete: DestinationProfile?

    private var live: Bool { broadcast.status.isActive }

    var body: some View {
        Form {
            savedSection
            addSection
            discoverySection
        }
        .navigationTitle("Destinations")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { profile in
            NavigationStack {
                DestinationEditor(profile: profile)
                    .environmentObject(store)
            }
        }
        .sheet(isPresented: $creating) {
            NavigationStack {
                DestinationEditor(profile: nil)
                    .environmentObject(store)
            }
        }
        .sheet(isPresented: $scanning) {
            NavigationStack {
                DestinationScannerView(onScan: reviewScannedCode)
            }
        }
        .sheet(isPresented: candidatesBinding) {
            NavigationStack {
                ImportConfirmationView(candidates: candidates) { accepted in
                    for candidate in accepted { store.add(candidate) }
                    candidates = []
                }
                .environmentObject(store)
            }
        }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.json, .item],
            allowsMultipleSelection: false,
            onCompletion: handleFileImport
        )
        .alert("Cannot import", isPresented: importErrorBinding) {
            Button("OK", role: .cancel) { importError = nil }
        } message: {
            Text(importError ?? "")
        }
        .confirmationDialog(
            confirmingDelete.map { "Delete \($0.name)?" } ?? "",
            isPresented: deleteBinding,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let profile = confirmingDelete { store.remove(profile.id) }
                confirmingDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmingDelete = nil }
        } message: {
            Text("The stored stream key for this destination is deleted too.")
        }
    }

    // MARK: - Saved

    @ViewBuilder
    private var savedSection: some View {
        Section {
            if store.profiles.isEmpty {
                Text("No destinations yet. Add one below, or paste a link from whoever is receiving the broadcast.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(store.profiles) { profile in
                DestinationRow(
                    profile: profile,
                    isSelected: store.selectedId == profile.id,
                    hasKey: store.hasSecret(for: profile.id)
                ) {
                    store.select(profile.id)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        confirmingDelete = profile
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(live)

                    Button {
                        editing = profile
                    } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    .tint(.indigo)

                    Button {
                        store.duplicate(profile.id)
                    } label: {
                        Label("Duplicate", systemImage: "plus.square.on.square")
                    }
                    .tint(.gray)
                }
            }
        } header: {
            Text("Saved")
        } footer: {
            if !store.profiles.isEmpty {
                Text("Swipe a destination for edit, duplicate and delete. Duplicating never copies the stream key — the copy is for a different event or a different person, and both need their own.")
            }
        }
        .disabled(live && store.profiles.isEmpty)
    }

    // MARK: - Adding

    private var addSection: some View {
        Section {
            Button {
                creating = true
            } label: {
                Label("Add manually", systemImage: "plus")
            }

            Button {
                pairingError = nil
                scanning = true
            } label: {
                Label("Scan a code", systemImage: "qrcode.viewfinder")
            }

            Button {
                importing = true
            } label: {
                Label("Import from a file", systemImage: "doc.badge.plus")
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    TextField("avr://pair?host=…", text: $pairingText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    Button("Review") { reviewPastedLink() }
                        .disabled(pairingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let pairingError {
                    Text(pairingError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        } header: {
            Text("Add a destination")
        } footer: {
            // Saying "review" rather than "use" is not decoration: it is what
            // the button does, and the difference is the whole security
            // posture of this screen.
            Text("A scanned or pasted link is shown for review before anything is saved. Nothing in this app connects to an address you have not confirmed.")
        }
        .disabled(live)
    }

    // MARK: - Discovery

    private var discoverySection: some View {
        Section {
            ForEach(broadcast.discovered) { candidate in
                Button {
                    candidates = [candidate]
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.name)
                        Text(candidate.endpointLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }

            Button {
                broadcast.search()
            } label: {
                Label("Search this network", systemImage: "antenna.radiowaves.left.and.right")
            }
        } header: {
            Text("On this network")
        } footer: {
            Text("Anything on this Wi-Fi can answer a search, so a result is a suggestion rather than a destination. It never carries a stream key — that comes from whoever is receiving the broadcast.")
        }
        .disabled(live)
    }

    // MARK: - Actions

    /// A scanned code goes through the pasted-link path, deliberately.
    ///
    /// The scanner decodes a string and knows nothing else about it. Everything
    /// that decides whether it is safe - the scheme check, the field
    /// validation, the confirmation sheet - lives on the one path, so there is
    /// one place to verify rather than two to keep in step.
    private func reviewScannedCode(_ text: String) {
        pairingError = nil
        do {
            candidates = [try DestinationImport.candidate(fromText: text, source: .scannedCode)]
        } catch let error as DestinationImport.ImportError {
            pairingError = error.description
        } catch {
            pairingError = error.localizedDescription
        }
    }

    private func reviewPastedLink() {
        pairingError = nil
        do {
            candidates = [try DestinationImport.candidate(fromText: pairingText)]
            pairingText = ""
        } catch let error as DestinationImport.ImportError {
            pairingError = error.description
        } catch {
            pairingError = error.localizedDescription
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case let .success(urls):
            guard let url = urls.first else { return }

            // A document picked outside the sandbox needs the scope opened
            // explicitly, and closed again whatever happens — leaking one is a
            // resource the app never gets back.
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            do {
                let data = try Data(contentsOf: url)
                candidates = try DestinationImport.candidates(fromDocument: data)
            } catch let error as DestinationImport.ImportError {
                importError = error.description
            } catch {
                importError = "That file could not be read."
            }

        case let .failure(error):
            importError = error.localizedDescription
        }
    }

    private var candidatesBinding: Binding<Bool> {
        Binding(get: { !candidates.isEmpty }, set: { if !$0 { candidates = [] } })
    }

    private var importErrorBinding: Binding<Bool> {
        Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })
    }

    private var deleteBinding: Binding<Bool> {
        Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } })
    }
}

// MARK: - Row

private struct DestinationRow: View {
    let profile: DestinationProfile
    let isSelected: Bool
    let hasKey: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(profile.name)
                        .foregroundStyle(.primary)

                    HStack(spacing: 6) {
                        Text(profile.endpointLabel)
                        if profile.isLocalNetwork {
                            Text("· local")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer()

                if !hasKey {
                    // Shown rather than hidden behind the editor: a destination
                    // with no key looks identical to a working one until the
                    // shutter refuses, which is the worst moment to find out.
                    Label("No key", systemImage: "key.slash")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.orange)
                        .accessibilityLabel("No stream key stored")
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Editor

/// Add or change one destination.
///
/// The key field starts empty even when a key is stored, and an empty field on
/// save means "leave it alone". A stored credential is never rendered, not even
/// behind a `SecureField`: it is a bearer token, the operator already has it
/// somewhere, and displaying it only creates new places for it to be
/// shoulder-surfed or screenshotted.
struct DestinationEditor: View {
    @EnvironmentObject private var store: DestinationStore
    @Environment(\.dismiss) private var dismiss

    /// `nil` when creating.
    let profile: DestinationProfile?

    @State private var name = ""
    @State private var host = ""
    @State private var port = DestinationProfile.Transport.avrLive.defaultPort
    @State private var transport = DestinationProfile.Transport.avrLive
    @State private var key = ""
    @State private var clearKey = false
    @State private var usesTLS = false
    @State private var certificatePin: String?

    @State private var testing = false
    @State private var testResult: ConnectionTester.Result?

    private var errors: [DestinationValidationError] {
        DestinationProfile.validate(name: name, host: host, port: port, key: key.isEmpty ? nil : key)
    }

    private var hasStoredKey: Bool {
        guard let profile else { return false }
        return store.hasSecret(for: profile.id)
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Name") {
                    TextField("Studio B", text: $name)
                        .multilineTextAlignment(.trailing)
                }

                LabeledContent("Address") {
                    TextField("192.168.1.10", text: $host)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                LabeledContent("Port") {
                    TextField("8081", value: $port, format: .number.grouping(.never))
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.numberPad)
                }

                if DestinationProfile.Transport.allCases.count > 1 {
                    Picker("Protocol", selection: $transport) {
                        ForEach(DestinationProfile.Transport.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                } else {
                    LabeledContent("Protocol", value: transport.label)
                }
            } footer: {
                Text(transport.detail)
            }

            Section {
                Toggle("Encrypt the connection", isOn: $usesTLS)

                if usesTLS {
                    if let certificatePin {
                        LabeledContent("Certificate pin") {
                            Text(Self.pinSummary(certificatePin))
                                .font(.footnote.monospaced())
                                .foregroundStyle(.secondary)
                        }

                        Button("Stop pinning this certificate", role: .destructive) {
                            self.certificatePin = nil
                        }
                    } else {
                        LabeledContent("Certificate pin", value: "None — checked by iOS")
                    }
                }
            } header: {
                // "Encrypted" and "Certificate pin" are the two field names in
                // the shared vocabulary; see `docs/LIVE.md`.
                Text("Encrypted")
            } footer: {
                // Three states, three different truths, and the wrong one
                // stated confidently is worse than saying nothing. In
                // particular the unpinned case is the one an operator will
                // reach for with a private address, where it cannot work.
                if !usesTLS {
                    Text("The stream key and the video are sent in the clear. Only reasonable on a network you control.")
                } else if certificatePin != nil {
                    Text("Only the exact certificate recorded when this destination was imported will be accepted. Reinstalling the server means importing a new destination link.")
                } else {
                    Text("The server must present a certificate iOS already trusts, which means a real host name. A bare IP address cannot have one — import a destination link from the server to pin its certificate instead.")
                }
            }

            Section {
                SecureField(hasStoredKey ? "Stored — leave blank to keep" : "Stream key", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                if hasStoredKey {
                    Toggle("Remove the stored key", isOn: $clearKey)
                }
            } header: {
                Text("Credential")
            } footer: {
                Text("Kept in the iOS Keychain on this device only — not in a backup, not in iCloud, and never written to a log or a diagnostics export.")
            }

            if transport.supportsConnectionTest {
                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("Test connection")
                            if testing {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(testing || host.isEmpty)

                    if let testResult {
                        Label(testResult.message, systemImage: testResult.isSuccess ? "checkmark.circle" : "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(testResult.isSuccess ? .green : .orange)
                    }
                } footer: {
                    // Explaining the limit rather than implying more than it
                    // does. See `ConnectionTester` for why it stops here.
                    Text(usesTLS
                        ? "Checks that something is listening at that address and that its certificate is accepted. It does not send the stream key, so it cannot tell you whether the key is right."
                        : "Checks that something is listening at that address. It does not send the stream key, so it cannot tell you whether the key is right.")
                }
            }

            if !errors.isEmpty && !(name.isEmpty && host.isEmpty) {
                Section {
                    ForEach(errors.indices, id: \.self) { index in
                        Label(errors[index].description, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
        .navigationTitle(profile == nil ? "New Destination" : "Edit Destination")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save).disabled(!errors.isEmpty)
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard let profile else { return }
        name = profile.name
        host = profile.host
        port = profile.port
        transport = profile.transport
        usesTLS = profile.usesTLS
        certificatePin = profile.certificatePin
    }

    /// Enough of the pin to tell two apart, not so much that it looks like
    /// something to transcribe. The full value is in the destination link.
    private static func pinSummary(_ pin: String) -> String {
        "\(pin.prefix(12))…"
    }

    private func save() {
        guard errors.isEmpty else { return }

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)

        if var existing = profile {
            existing.name = trimmedName
            existing.host = trimmedHost
            existing.port = port
            existing.transport = transport
            existing.usesTLS = usesTLS
            // A pin without TLS is a contradiction that would come back as a
            // silently pinned connection the next time the toggle was flipped.
            existing.certificatePin = usesTLS ? certificatePin : nil

            store.update(existing, key: key.isEmpty ? nil : key)
            if clearKey && key.isEmpty { store.setSecret(nil, for: existing.id) }
        } else {
            store.add(
                name: trimmedName,
                transport: transport,
                host: trimmedHost,
                port: port,
                key: key.isEmpty ? nil : key,
                usesTLS: usesTLS,
                certificatePin: usesTLS ? certificatePin : nil
            )
        }

        dismiss()
    }

    private func test() async {
        testing = true
        testResult = nil
        defer { testing = false }

        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        testResult = await ConnectionTester.test(
            host: trimmed,
            port: port,
            allowsCellular: !DestinationAddress.isPrivate(trimmed),
            // The unsaved state of the form, not the saved profile: the point
            // of the button is to find out whether what is about to be saved
            // works.
            security: usesTLS ? .tls(pin: certificatePin) : .cleartext
        )
    }
}

// MARK: - Import confirmation

/// What a link or a file is proposing, before any of it is saved.
///
/// Every field is shown, including whether a credential came along with it. The
/// operator is being asked to agree to send their camera somewhere, and the
/// only honest way to ask is to show where.
struct ImportConfirmationView: View {
    @Environment(\.dismiss) private var dismiss

    let candidates: [DestinationImport.Candidate]
    let accept: ([DestinationImport.Candidate]) -> Void

    @State private var chosen: Set<UUID> = []

    var body: some View {
        Form {
            Section {
                ForEach(candidates) { candidate in
                    Button {
                        toggle(candidate.id)
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: chosen.contains(candidate.id) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(chosen.contains(candidate.id) ? Color.accentColor : Color.secondary)

                            VStack(alignment: .leading, spacing: 4) {
                                Text(candidate.name).foregroundStyle(.primary)

                                LabeledDetail("Address", candidate.endpointLabel)
                                LabeledDetail("Protocol", candidate.transport.label)
                                LabeledDetail("Network", candidate.isLocalNetwork ? "Local only" : "Public internet")
                                LabeledDetail("Encrypted", candidate.encryptedLabel)
                                LabeledDetail("Stream key", candidate.carriesKey ? "Included in this link" : "Not included — add it yourself")
                                LabeledDetail("Source", candidate.source.label)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text(candidates.count == 1 ? "Destination" : "\(candidates.count) destinations")
            } footer: {
                Text("Check the address is the one you expect. A broadcast goes wherever its destination points, and a link can point anywhere.")
            }
        }
        .navigationTitle("Add Destination?")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Add") {
                    accept(candidates.filter { chosen.contains($0.id) })
                    dismiss()
                }
                .disabled(chosen.isEmpty)
            }
        }
        .onAppear {
            // A single candidate is pre-ticked because the operator already
            // performed a deliberate act to get here. A list is not: bulk
            // agreement to a set of addresses nobody read is the thing this
            // screen exists to prevent.
            if candidates.count == 1, let only = candidates.first { chosen = [only.id] }
        }
    }

    private func toggle(_ id: UUID) {
        if chosen.contains(id) { chosen.remove(id) } else { chosen.insert(id) }
    }
}

private struct LabeledDetail: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 84, alignment: .leading)

            Text(value)
                .font(.caption)
                .foregroundStyle(.primary)
        }
    }
}
