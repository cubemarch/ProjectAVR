import Foundation

/// The privacy policy and support pages, read from the bundle.
///
/// In `Info.plist` rather than in Swift, because these are deployment facts
/// rather than code: a self-hosted build and a build published to the App Store
/// point at different pages, and the person who has to change them is not
/// necessarily the person who can rebuild the app from source.
///
/// Anything that does not resolve to a live `https` page is treated as absent
/// and its row is hidden, so a self-hosted build shows no link rather than a
/// dead one. **A published build must set both** — Guideline 5.1.1 requires a
/// reachable privacy policy and App Store Connect requires a support URL — and
/// that is a line item in docs/APP_STORE.md rather than something this file can
/// enforce.
///
/// What it *can* enforce is that the placeholder never ships as a broken link.
/// See ``isPlaceholder(host:)``.
enum SupportLinks {
    static let privacyPolicy = url(forInfoKey: "AVRPrivacyPolicyURL")
    static let support = url(forInfoKey: "AVRSupportURL")

    private static func url(forInfoKey key: String) -> URL? {
        url(from: Bundle.main.object(forInfoDictionaryKey: key) as? String)
    }

    /// Parse one configured value.
    ///
    /// Separated from the bundle lookup so it can be tested: the test bundle has
    /// its own `Info.plist` and cannot exercise the app's.
    ///
    /// Only `https`. A policy fetched over plain HTTP can be rewritten in
    /// transit, and the one document whose integrity the user is being asked to
    /// rely on is a poor place to make an exception to ATS.
    static func url(from raw: String?) -> URL? {
        guard
            let raw,
            case let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty,
            let url = URL(string: trimmed),
            url.scheme?.lowercased() == "https",
            let host = url.host?.lowercased(),
            !host.isEmpty,
            !isPlaceholder(host: host)
        else {
            return nil
        }

        return url
    }

    /// Whether a host is one of the names reserved by RFC 2606 and RFC 6761 for
    /// documentation and testing.
    ///
    /// The checked-in `Info.plist` carries such a host, because a build that has
    /// not been configured for release should still demonstrate the shape of
    /// the thing. Rejecting the reserved names here is what stops that
    /// demonstration from becoming a shipped link to nowhere: a build nobody
    /// remembered to configure hides the rows, exactly as an empty value does,
    /// instead of putting a broken link in front of a reviewer.
    static func isPlaceholder(host: String) -> Bool {
        let reserved = ["example.com", "example.net", "example.org",
                        "example", "invalid", "test", "localhost"]

        return reserved.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    static var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }
}
