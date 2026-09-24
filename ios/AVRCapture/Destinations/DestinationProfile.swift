import Foundation

/// A place this app can send a broadcast to.
///
/// The secret is deliberately not a property. A profile is persisted as plain
/// JSON in `UserDefaults`; its stream key is persisted separately in the
/// Keychain under the profile's id. Keeping them in different types means a
/// profile can be logged, exported, diffed and put in a SwiftUI preview without
/// anyone having to remember that one field of it is a bearer credential.
/// ``DestinationStore`` is the only thing that joins the two.
struct DestinationProfile: Identifiable, Codable, Equatable, Sendable {
    /// How the broadcast reaches the destination.
    ///
    /// One case, because one transport is implemented. The brief asks for a
    /// protocol field and this is it — but a picker offering SRT and RTMP that
    /// cannot connect is a dormant feature under Guideline 2.3.1, and worse, it
    /// is a support burden shaped like a product. Cases get added here when the
    /// code behind them exists; see docs/IOS_AUDIT.md for what that would take.
    enum Transport: String, Codable, CaseIterable, Identifiable, Sendable {
        /// Length-framed TCP, two sibling video tracks on one socket. Described
        /// in docs/LIVE.md.
        case avrLive = "avr-live"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .avrLive: return "AVR Live (TCP)"
            }
        }

        var detail: String {
            switch self {
            case .avrLive:
                return "One encoded stream per eye on a single connection, matched by timestamp at the server."
            }
        }

        /// Whether "Test Connection" can do anything meaningful.
        var supportsConnectionTest: Bool {
            switch self {
            case .avrLive: return true
            }
        }

        var defaultPort: Int {
            switch self {
            case .avrLive: return 8081
            }
        }
    }

    let id: UUID
    var name: String
    var transport: Transport
    var host: String
    var port: Int
    var createdAt: Date
    var updatedAt: Date

    /// Whether to negotiate TLS on the contribution socket.
    ///
    /// Off by default, and *not* because cleartext is fine — it is the only
    /// value that can be inferred for a destination someone typed by hand
    /// before this field existed. A destination that arrives by pairing link
    /// from a TLS-enabled server carries `tls=1`, and one an operator ticks in
    /// the editor sets it explicitly.
    var usesTLS: Bool

    /// Base64 SHA-256 of the DER form of the server's certificate.
    ///
    /// Set only for destinations that cannot have a publicly-trusted
    /// certificate — which is every bare private address, because no authority
    /// will issue for `192.168.1.110`. When present it is the *entire* trust
    /// decision: the system trust store is not consulted and a mismatch fails
    /// the connection. When absent on a TLS destination, the certificate is
    /// validated normally, which is what a real hostname should do.
    ///
    /// The whole certificate rather than its public key: a key pin survives
    /// certificate renewal, which is the right trade for a pin compiled into a
    /// binary that ships for years, but these pins arrive in a pairing link
    /// minted per broadcast and are replaced as often as they are used. What is
    /// bought instead is that the phone can compute the comparison from
    /// `SecCertificateCopyData` with no ASN.1 of its own — a key pin would mean
    /// rebuilding DER from a `SecKey` with a hand-written algorithm-identifier
    /// prefix per key type, which fails by rejecting a certificate that is fine.
    ///
    /// Regenerating the server certificate therefore invalidates saved
    /// destinations until the operator pairs again.
    var certificatePin: String?

    init(
        id: UUID = UUID(),
        name: String,
        transport: Transport = .avrLive,
        host: String,
        port: Int,
        usesTLS: Bool = false,
        certificatePin: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.transport = transport
        self.host = host
        self.port = port
        self.usesTLS = usesTLS
        self.certificatePin = certificatePin
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Decoded by hand so that adding a field does not delete everyone's
    /// destinations.
    ///
    /// The synthesised `init(from:)` throws `keyNotFound` for a property that
    /// is missing from the stored JSON, default value or not — so shipping a
    /// new field with synthesised `Codable` would make every record written by
    /// a previous build fail to decode, and `DestinationStore` would come up
    /// empty with no error the operator could act on. Every field added from
    /// here on must be read with `decodeIfPresent` and a stated default.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        transport = try container.decodeIfPresent(Transport.self, forKey: .transport) ?? .avrLive
        host = try container.decode(String.self, forKey: .host)
        port = try container.decode(Int.self, forKey: .port)
        usesTLS = try container.decodeIfPresent(Bool.self, forKey: .usesTLS) ?? false
        certificatePin = try container.decodeIfPresent(String.self, forKey: .certificatePin)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    /// How the destination describes its own security, for the confirmation
    /// sheet and the destination list. Deliberately plain language: the person
    /// reading it is deciding whether to trust an address, not auditing a
    /// cipher suite.
    var securityLabel: String {
        switch (usesTLS, certificatePin != nil) {
        case (false, _): return "Not encrypted"
        case (true, true): return "Encrypted, pinned certificate"
        case (true, false): return "Encrypted"
        }
    }

    /// Whether this destination is reachable only over the local link.
    ///
    /// Derived from the address rather than offered as a setting. A private or
    /// link-local address is not routable over a carrier, so permitting
    /// cellular for one achieves nothing except letting the connection attempt
    /// leave by an interface that cannot carry it; a public host must be
    /// allowed to use cellular, or the app cannot broadcast to a remote server
    /// at all — which is what the previous hard-coded
    /// `prohibitedInterfaceTypes = [.cellular]` did.
    var isLocalNetwork: Bool {
        DestinationAddress.isPrivate(host)
    }

    var endpointLabel: String {
        Redact.endpoint(host: host, port: port)
    }
}

// MARK: - Validation

/// Why a destination was rejected.
///
/// Typed rather than a `[String]` so the editor can highlight the offending
/// field, and so the import confirmation can list precisely what is wrong with
/// a link somebody was sent rather than refusing it without saying why.
enum DestinationValidationError: Error, Equatable, CustomStringConvertible {
    case nameEmpty
    case nameTooLong(max: Int)
    case hostEmpty
    case hostTooLong(max: Int)
    case hostMalformed
    case hostLooksLikeURL
    case portOutOfRange
    case keyTooLong(max: Int)
    case keyNotPrintable

    var description: String {
        switch self {
        case .nameEmpty:
            return "Give the destination a name."
        case let .nameTooLong(max):
            return "The name must be \(max) characters or fewer."
        case .hostEmpty:
            return "Enter an address."
        case let .hostTooLong(max):
            return "The address must be \(max) characters or fewer."
        case .hostMalformed:
            return "That is not a valid host name or IP address."
        case .hostLooksLikeURL:
            return "Enter just the host, without a scheme or path — for example 192.168.1.10 or live.example.com."
        case .portOutOfRange:
            return "The port must be between 1 and 65535."
        case let .keyTooLong(max):
            return "The stream key must be \(max) characters or fewer."
        case .keyNotPrintable:
            return "The stream key contains characters that cannot be sent."
        }
    }
}

enum DestinationLimits {
    static let nameMaxLength = 60
    /// The DNS limit. Anything longer cannot resolve, so it is not a hostname.
    static let hostMaxLength = 253
    /// Generous: some providers issue long signed tokens as publishing keys.
    static let keyMaxLength = 512
}

extension DestinationProfile {
    /// Validate a candidate destination, secret included.
    ///
    /// Static and taking loose values, because it has to run on three
    /// different things: a profile being edited, a link being imported, and a
    /// row in a configuration file. Returning every error rather than the first
    /// means the editor can mark all the bad fields at once.
    static func validate(
        name: String,
        host: String,
        port: Int,
        key: String?
    ) -> [DestinationValidationError] {
        var errors: [DestinationValidationError] = []

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedName.isEmpty { errors.append(.nameEmpty) }
        if trimmedName.count > DestinationLimits.nameMaxLength {
            errors.append(.nameTooLong(max: DestinationLimits.nameMaxLength))
        }

        errors.append(contentsOf: DestinationAddress.validate(host))

        if port < 1 || port > 65_535 { errors.append(.portOutOfRange) }

        if let key, !key.isEmpty {
            if key.count > DestinationLimits.keyMaxLength {
                errors.append(.keyTooLong(max: DestinationLimits.keyMaxLength))
            }
            if !DestinationAddress.isPrintableASCII(key) {
                errors.append(.keyNotPrintable)
            }
        }

        return errors
    }

    func validationErrors(key: String?) -> [DestinationValidationError] {
        Self.validate(name: name, host: host, port: port, key: key)
    }
}

// MARK: - Address parsing

/// Host validation, kept separate because it is the part with the sharp edges.
///
/// Everything here exists because the host string arrives from outside the app
/// — typed, pasted, scanned off a QR code, or handed over in a link somebody
/// received. It ends up in `NWEndpoint.Host`, which is forgiving in ways that
/// are useful for a library and wrong for a trust boundary.
enum DestinationAddress {
    /// Characters that must never appear in a host, whatever else is true.
    ///
    /// CR and LF are the ones that matter. Historically, a newline smuggled
    /// through a host field is how a value meant for one connection ends up
    /// being interpreted as a second request; this transport is length-framed
    /// binary and is not susceptible, but the host is also written into logs and
    /// into the diagnostics export, and a newline there forges a log entry.
    private static let forbidden = CharacterSet(charactersIn: " \t\r\n/\\?#@\"'<>{}|^`")

    static func validate(_ host: String) -> [DestinationValidationError] {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmed.isEmpty { return [.hostEmpty] }

        var errors: [DestinationValidationError] = []

        if trimmed.count > DestinationLimits.hostMaxLength {
            errors.append(.hostTooLong(max: DestinationLimits.hostMaxLength))
        }

        // Caught before the general check so the message can say what to do.
        // Pasting a whole URL into an address field is the single most likely
        // mistake here, and "not a valid host name" is unhelpful advice for it.
        if trimmed.contains("://") || trimmed.hasPrefix("//") {
            errors.append(.hostLooksLikeURL)
            return errors
        }

        if isIPv6Literal(trimmed) {
            // Bracketed or bare, both are written by hand and both are common.
            let inner = trimmed.hasPrefix("[") ? String(trimmed.dropFirst().dropLast()) : trimmed
            if !isValidIPv6(inner) { errors.append(.hostMalformed) }
            return errors
        }

        if trimmed.rangeOfCharacter(from: forbidden) != nil {
            errors.append(.hostMalformed)
            return errors
        }

        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            errors.append(.hostMalformed)
            return errors
        }

        if isIPv4Literal(trimmed) {
            if !isValidIPv4(trimmed) { errors.append(.hostMalformed) }
            return errors
        }

        if !isValidHostname(trimmed) { errors.append(.hostMalformed) }

        return errors
    }

    static func isPrintableASCII(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7E }
    }

    /// Is this address only reachable on the local link?
    ///
    /// RFC 1918, RFC 3927 link-local, loopback, carrier-grade NAT, `.local`
    /// mDNS names, and IPv6 unique-local and link-local. Deliberately
    /// conservative: an address this does not recognise is treated as public,
    /// because wrongly calling a public host local blocks a legitimate remote
    /// broadcast, while wrongly calling a private host public only permits an
    /// interface that will fail to route.
    static func isPrivate(_ host: String) -> Bool {
        let value = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.isEmpty { return false }

        if value == "localhost" || value.hasSuffix(".local") || value.hasSuffix(".localhost") {
            return true
        }

        if isIPv6Literal(value) {
            let inner = value.hasPrefix("[") ? String(value.dropFirst().dropLast()) : value
            if inner == "::1" { return true }
            // fc00::/7 unique-local, fe80::/10 link-local.
            return inner.hasPrefix("fc") || inner.hasPrefix("fd") || inner.hasPrefix("fe8")
                || inner.hasPrefix("fe9") || inner.hasPrefix("fea") || inner.hasPrefix("feb")
        }

        let parts = value.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }

        switch (parts[0], parts[1]) {
        case (10, _), (127, _), (169, 254):
            return true
        case (192, 168):
            return true
        case (172, 16...31):
            return true
        case (100, 64...127):  // RFC 6598 carrier-grade NAT
            return true
        default:
            return false
        }
    }

    // MARK: Literals

    private static func isIPv6Literal(_ value: String) -> Bool {
        value.hasPrefix("[") || (value.contains(":") && !value.contains("://"))
    }

    private static func isValidIPv6(_ value: String) -> Bool {
        // Delegated to the resolver rather than reimplemented. IPv6 text form
        // has compressed runs, embedded IPv4 and zone identifiers; a hand-rolled
        // parser gets one of those wrong and rejects an address that works.
        var address = in6_addr()
        let scopeless = value.split(separator: "%").first.map(String.init) ?? value
        return scopeless.withCString { inet_pton(AF_INET6, $0, &address) == 1 }
    }

    /// Four dot-separated groups that are all digits. Distinguishes "meant to be
    /// an IPv4 address and is wrong" from "is a hostname".
    private static func isIPv4Literal(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isNumber) }
    }

    private static func isValidIPv4(_ value: String) -> Bool {
        // Leading zeros are rejected by hand before the resolver sees them.
        //
        // `inet_pton` is the strict one of the pair — `inet_aton` accepts "10.1"
        // and "0x7f.1" outright — but Darwin's still takes "0177.0.0.1" and
        // reads it as decimal 177. Elsewhere in the stack, and in most server
        // languages, the same string is read as *octal* 127.0.0.1. An address
        // that means two different things to two readers is exactly how a
        // loopback gets disguised as something else, so it is not an address.
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        for part in parts where part.count > 1 && part.first == "0" {
            return false
        }

        var address = in_addr()
        return value.withCString { inet_pton(AF_INET, $0, &address) == 1 }
    }

    private static func isValidHostname(_ value: String) -> Bool {
        // A single trailing dot is a fully-qualified name and is legal.
        let name = value.hasSuffix(".") ? String(value.dropLast()) : value
        guard !name.isEmpty else { return false }

        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard !labels.isEmpty else { return false }

        for label in labels {
            guard (1...63).contains(label.count) else { return false }
            guard label.first != "-", label.last != "-" else { return false }
            guard label.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
            else { return false }
        }

        // A final label of pure digits is not a hostname — RFC 1123 requires a
        // top-level label to contain at least one letter, and there is no
        // registered all-numeric TLD. Without this, "1.2.3.4.5" and "10.0.0"
        // fall through the IPv4 check (wrong number of parts) and are accepted
        // as names, so a mistyped address is stored as a destination and fails
        // much later as an unhelpful resolver error.
        if let last = labels.last, last.allSatisfy(\.isNumber) { return false }

        return true
    }
}
