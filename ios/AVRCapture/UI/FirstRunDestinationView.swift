import SwiftUI

/// "Where should this broadcast go?"
///
/// Shown once, on the first launch that finds no destinations configured. It
/// exists because the app is genuinely useless as a broadcasting tool until it
/// has somewhere to send to, and burying that behind a settings sheet means the
/// first thing a new operator sees is a viewfinder with a shutter that refuses.
///
/// It asks and nothing more. Skipping is a first-class choice, in the same
/// visual weight as submitting: camera testing, stereo capability testing and
/// diagnostics all work with no destination at all, and an app that will not
/// proceed until it is pointed at a server is a worse tool than one that will.
/// (Local recording would belong in that list too, and does not yet exist —
/// finding 14 in `docs/IOS_AUDIT.md`. Add it here when it does.)
///
/// No destination is suggested, no default is filled in, and nothing is
/// contacted. The text that gets pasted here goes through exactly the same
/// parser and the same confirmation sheet as a tapped `avr://pair` link — see
/// `DestinationImport` — because a value typed in by hand deserves the same
/// validation as one that arrived in a URL, and because having one code path
/// means there is one place where that validation can be verified.
struct FirstRunDestinationView: View {
    @EnvironmentObject private var destinations: DestinationStore

    /// Called once the operator is finished here, whether or not they added
    /// anything. The caller records that the prompt has been shown.
    let onFinish: () -> Void

    @State private var pastedText = ""
    @State private var parseError: String?
    @State private var candidate: DestinationImport.Candidate?
    @State private var scanning = false

    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("""
                        AVR Capture sends live video to a destination you choose. It has no \
                        default and connects nowhere on its own.

                        Whoever receives your broadcast gives you an address and a key. Scan \
                        the code they show you, or paste the link below — either way you get a \
                        chance to check it before anything is saved.
                        """)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        parseError = nil
                        scanning = true
                    } label: {
                        Label("Scan a code", systemImage: "qrcode.viewfinder")
                    }

                    TextField("avr://pair?host=…", text: $pastedText, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .lineLimit(1...4)
                        .focused($fieldFocused)
                        .onSubmit(review)

                    Button("Submit", action: review)
                        .disabled(pastedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    if let parseError {
                        Label(parseError, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Destination address")
                } footer: {
                    Text("A key is like a password. Anyone who has it can broadcast in your place, so do not share the address you were given.")
                }

                Section {
                    Button("Set this up later", action: onFinish)
                } footer: {
                    Text("The camera, the stereo capability test and diagnostics all work without a destination.")
                }
            }
            .navigationTitle("Connect a destination")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip", action: onFinish)
                }
            }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    DestinationScannerView(onScan: reviewScanned)
                }
            }
            .sheet(item: $candidate) { candidate in
                NavigationStack {
                    ImportConfirmationView(candidates: [candidate]) { accepted in
                        for candidate in accepted { destinations.add(candidate) }

                        // Only leave once something was actually saved.
                        // Cancelling the confirmation returns here rather than
                        // dropping the operator into a viewfinder that still
                        // has nowhere to send to.
                        if !accepted.isEmpty { onFinish() }
                    }
                    .environmentObject(destinations)
                }
            }
        }
        .onAppear { fieldFocused = true }
    }

    /// Scanned codes take the pasted-link path. See `DestinationsView`.
    private func reviewScanned(_ text: String) {
        parseError = nil

        do {
            candidate = try DestinationImport.candidate(fromText: text, source: .scannedCode)
        } catch let error as DestinationImport.ImportError {
            parseError = error.description
        } catch {
            parseError = error.localizedDescription
        }
    }

    private func review() {
        parseError = nil

        do {
            candidate = try DestinationImport.candidate(fromText: pastedText)
            pastedText = ""
        } catch let error as DestinationImport.ImportError {
            parseError = error.description
        } catch {
            parseError = error.localizedDescription
        }
    }
}
