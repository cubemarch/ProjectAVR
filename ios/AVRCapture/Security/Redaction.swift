import Foundation

/// Turning secrets into something safe to print.
///
/// The app logs through `os.Logger`, whose string interpolations are private by
/// default — but several call sites mark values `.public` deliberately, because
/// a log full of `<private>` is a log nobody can debug from. This is what those
/// call sites use when the value might contain a credential, and what the
/// diagnostics export runs everything through before it is shared.
///
/// The rule this enforces: a redacted value must be enough to answer "is this
/// the same key I pasted?" and not enough to use. Four trailing characters of a
/// sixteen-character hex key is one part in 65,536 of the secret, which
/// distinguishes two keys an operator is holding and is useless to anyone else.
enum Redact {
    /// Mask a bearer credential, keeping just enough tail to identify it.
    ///
    /// Short values are masked completely: revealing four of six characters is
    /// not a hint, it is most of the secret.
    static func secret(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "(none)" }
        guard value.count >= 12 else { return "••••" }
        return "••••" + value.suffix(4)
    }

    /// Strip credentials out of a URL before it reaches a log or an export.
    ///
    /// Three places hide one: the userinfo component (`scheme://user:pass@host`),
    /// any query item whose name looks like a credential, and the fragment,
    /// which some ingest providers use to carry a token. A URL that cannot be
    /// parsed is dropped entirely rather than passed through — an unparseable
    /// string is exactly the case where a naive search-and-replace misses the
    /// secret it was meant to find.
    static func url(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "(none)" }

        guard var components = URLComponents(string: value) else { return "(unparseable url)" }

        components.user = nil
        components.password = nil
        components.fragment = nil

        if let items = components.queryItems {
            components.queryItems = items.map { item in
                isSensitive(item.name)
                    ? URLQueryItem(name: item.name, value: secret(item.value))
                    : item
            }
        }

        return components.string ?? "(unparseable url)"
    }

    /// Query-parameter names that carry a credential.
    ///
    /// Matched case-insensitively on a substring, so `streamKey`, `stream_key`
    /// and `STREAMKEY` are all caught, and so is a name this app does not use
    /// yet but some ingest provider does.
    private static let sensitiveNames = [
        "key", "token", "secret", "password", "passwd", "pass",
        "auth", "signature", "sig", "credential", "session"
    ]

    private static func isSensitive(_ name: String) -> Bool {
        let lowered = name.lowercased()
        return sensitiveNames.contains { lowered.contains($0) }
    }

    /// A host and port, safe to print. Hostnames are not secret; this exists so
    /// a caller never has to reach for string interpolation on a whole
    /// destination and accidentally include its key.
    static func endpoint(host: String, port: Int) -> String {
        host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    }
}
