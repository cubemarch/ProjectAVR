import SwiftUI

/// Shown once, before the first broadcast, and again if the wording changes.
///
/// This is not a licence agreement and it is not a click-through nobody reads
/// by design — it is four short lines, each of which is a thing the operator is
/// actually responsible for and the app cannot verify. The app can see that two
/// cameras are running; it cannot see whether the people in front of them
/// agreed to be on air.
///
/// Guideline 2.5.14 is the immediate reason it exists, but the substantive one
/// is that this app makes it trivial to put a live feed of a room in front of an
/// audience, and everyone in that room has a say in whether that happens.
struct RightsAcknowledgement: View {
    let onAccept: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Before you go live")
                        .font(.system(.title2, design: .rounded).weight(.semibold))

                    Text("""
                    This app sends live video from this phone to the destination you have \
                    configured. Once a broadcast starts, whoever can reach that destination \
                    can see what the cameras see.
                    """)
                    .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Self.terms, id: \.self) { term in
                            Label {
                                Text(term)
                            } icon: {
                                Image(systemName: "checkmark.circle")
                                    .foregroundStyle(.tint)
                            }
                            .font(.callout)
                        }
                    }

                    Text("""
                    Broadcasting content that is illegal, non-consensual, exploitative, or that \
                    depicts anyone under 18 is prohibited, wherever it is sent.
                    """)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                    if let policy = SupportLinks.privacyPolicy {
                        Link("Privacy policy", destination: policy)
                            .font(.footnote)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("I understand", action: onAccept)
                        .fontWeight(.semibold)
                }
            }
        }
    }

    /// Bump `CaptureConfig.rightsAcknowledgementVersion` when these change.
    static let terms = [
        "You have the right to record and transmit everything and everyone that appears in the shot.",
        "Everyone recognisable in the shot has agreed to be broadcast, and knows where to.",
        "Everyone appearing is an adult.",
        "You are responsible for what you broadcast and for the destination you send it to."
    ]
}

/// The same sheet, wired to the stored acknowledgement.
///
/// Presented from the shutter the first time, and reachable from Settings
/// afterwards — terms that can only be seen once, at the moment they are being
/// agreed to, are terms nobody can go back and check.
struct RightsAcknowledgementView: View {
    @EnvironmentObject private var config: CaptureConfig
    @Environment(\.dismiss) private var dismiss

    /// Called only when the operator accepts, so the caller can carry on with
    /// whatever the acknowledgement was blocking.
    var onAccept: (() -> Void)?

    var body: some View {
        RightsAcknowledgement(
            onAccept: {
                config.acknowledgeRights()
                dismiss()
                onAccept?()
            },
            onCancel: { dismiss() }
        )
    }
}
