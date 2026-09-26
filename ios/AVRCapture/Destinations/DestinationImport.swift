import Foundation

/// Bringing a destination in from outside the app.
///
/// Two shapes arrive here: an `avr://pair?…` link, which carries one
/// destination and is what the creator portal hands out, and a versioned JSON
/// document, which carries several and is what a production company would keep
/// in a file and send to a crew.
///
/// Nothing in this file saves anything or connects to anything. Parsing
/// produces a *candidate*, the UI shows the candidate to the operator with its
/// address and whether it carries a key, and only an explicit confirmation
/// writes it. That separation is the whole point: a link is an instruction from
/// whoever sent it, and a broadcasting app that silently repoints itself at an
/// address in a URL somebody tapped is a redirection primitive.
enum DestinationImport {
    /// Where a candidate came from. Shown in the confirmation sheet, because
    /// "you opened a link" and "you chose a file" deserve different amounts of
    /// suspicion from the person confirming it.
    ///
    /// The case names follow the `avr://pair` wire format; the labels follow
    /// what the person receiving one is told it is called. Those two diverged
    /// on purpose - the portal that issues these calls the whole string a
    /// **destination link**, and a sheet that answered "Pairing link" was the
    /// only place in either product using a third word for it.
    enum Source: Equatable, Sendable {
        case pairingLink
        case scannedCode
        case configurationFile
        case discovery

        var label: String {
            switch self {
            case .pairingLink: return "Destination link"
            case .scannedCode: return "Scanned code"
            case .configurationFile: return "Configuration file"
            case .discovery: return "Found on this network"
            }
        }
    }

    /// A destination that has been parsed and validated but not yet saved.
    struct Candidate: Identifiable, Equatable, Sendable {
        let id = UUID()
        var name: String
        var transport: DestinationProfile.Transport
        var host: String
        var port: Int
        /// `nil` when the source carried no key — discovery never does, and a
        /// configuration file distributed to a crew often should not.
        var key: String?
        var source: Source
        var usesTLS: Bool = false
        var certificatePin: String?

        var carriesKey: Bool { !(key ?? "").isEmpty }

        var isLocalNetwork: Bool { DestinationAddress.isPrivate(host) }

        var endpointLabel: String { Redact.endpoint(host: host, port: port) }

        /// See `DestinationProfile.encryptedLabel` for why the field is called
        /// **Encrypted** rather than "Security".
        var encryptedLabel: String {
            switch (usesTLS, certificatePin != nil) {
            case (false, _): return "No"
            case (true, true): return "Yes, certificate pinned"
            case (true, false): return "Yes"
            }
        }

        func profile() -> DestinationProfile {
            DestinationProfile(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                transport: transport,
                host: host.trimmingCharacters(in: .whitespacesAndNewlines),
                port: port,
                usesTLS: usesTLS,
                certificatePin: certificatePin
            )
        }
    }

    enum ImportError: Error, Equatable, CustomStringConvertible {
        case notAPairingLink
        case missingField(String)
        case invalid([DestinationValidationError])
        case unsupportedTransport(String)
        case documentTooLarge(limit: Int)
        case tooManyDestinations(limit: Int)
        case unreadableDocument
        case unsupportedSchemaVersion(found: Int, supported: Int)
        case noDestinations

        var description: String {
            switch self {
            case .notAPairingLink:
                return "That is not an AVR destination link."
            case let .missingField(name):
                return "The link is missing its \(name)."
            case let .invalid(errors):
                return errors.map(\.description).joined(separator: " ")
            case let .unsupportedTransport(name):
                return "This version does not support the \"\(name)\" protocol."
            case let .documentTooLarge(limit):
                return "That file is too large to be a destination list (limit \(limit / 1024) KB)."
            case let .tooManyDestinations(limit):
                return "That file contains more than \(limit) destinations."
            case .unreadableDocument:
                return "That file is not a destination list this app can read."
            case let .unsupportedSchemaVersion(found, supported):
                return """
                That file is version \(found); this app reads version \(supported). \
                Update the app, or ask for a version \(supported) file.
                """
            case .noDestinations:
                return "That file contains no destinations."
            }
        }
    }

    // MARK: - Pairing links

    static let urlScheme = "avr"
    static let pairingHost = "pair"

    /// Parse `avr://pair?host=…&port=…&key=…`.
    ///
    /// The same query is also accepted on an `https://…/pair?…` URL. The portal
    /// shows both forms: the `avr://` one opens this app when tapped on the
    /// phone, and the `https://` one is what gets copied when somebody selects
    /// the visible text instead. Refusing the second would be refusing the
    /// thing most people will actually paste.
    ///
    /// `http://` is not accepted. A pairing link is a credential delivery
    /// mechanism, and one that can be rewritten in transit hands the phone an
    /// address of the attacker's choosing.
    ///
    /// Note what this does *not* do: resolve the host, contact it, or treat the
    /// absence of a key as an error. A link with no key is a perfectly good way
    /// to distribute an address to a crew who each hold their own credential.
    static func candidate(from url: URL) throws -> Candidate {
        let scheme = url.scheme?.lowercased()

        let recognised =
            (scheme == urlScheme && url.host?.lowercased() == pairingHost)
            || (scheme == "https" && url.path.lowercased().hasSuffix("/\(pairingHost)"))

        guard recognised, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ImportError.notAPairingLink
        }

        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            // Last wins. A duplicated parameter is either a mistake or an
            // attempt to have two readers disagree about the same link, and
            // taking a consistent, documented side of that is what matters.
            items.last { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard let host = value("host"), !host.isEmpty else {
            throw ImportError.missingField("address")
        }

        guard let portText = value("port"), let port = Int(portText) else {
            throw ImportError.missingField("port")
        }

        let transport: DestinationProfile.Transport
        if let raw = value("transport"), !raw.isEmpty {
            guard let parsed = DestinationProfile.Transport(rawValue: raw) else {
                throw ImportError.unsupportedTransport(raw)
            }
            transport = parsed
        } else {
            // Links predating the transport parameter are all AVR Live.
            transport = .avrLive
        }

        let name = sanitiseName(value("name")) ?? host
        let key = value("key")

        // A pin implies TLS. A link that carried a pin but left `tls` off would
        // otherwise connect in the clear while looking, in the confirmation
        // sheet, like the more secure of the two options.
        let pin = validPin(value("pin"))
        let usesTLS = pin != nil || ["1", "true", "yes"].contains(value("tls")?.lowercased() ?? "")

        let errors = DestinationProfile.validate(name: name, host: host, port: port, key: key)
        guard errors.isEmpty else { throw ImportError.invalid(errors) }

        return Candidate(
            name: name,
            transport: transport,
            host: host,
            port: port,
            key: key,
            source: .pairingLink,
            usesTLS: usesTLS,
            certificatePin: pin
        )
    }

    /// A pin is 32 bytes of SHA-256, base64. Anything else is discarded rather
    /// than stored, because a malformed pin that is kept would fail every
    /// connection with a certificate error that looks like a server fault.
    static func validPin(_ raw: String?) -> String? {
        guard
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty,
            let decoded = Data(base64Encoded: trimmed),
            decoded.count == 32
        else {
            return nil
        }

        return trimmed
    }

    /// Same, from text pasted into a field.
    static func candidate(fromText text: String, source: Source = .pairingLink) throws -> Candidate {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else {
            throw ImportError.notAPairingLink
        }

        // Same parser, same validation, same confirmation sheet. `source` only
        // changes the line the operator is shown about where it came from -
        // "you scanned this" and "you pasted this" deserve different amounts of
        // suspicion, and a camera can be pointed at a code by someone else.
        var candidate = try candidate(from: url)
        candidate.source = source
        return candidate
    }

    // MARK: - Network discovery

    /// Build a candidate from a discovery reply.
    ///
    /// Same validation as everything else on this path, and deliberately no key
    /// parameter: a UDP responder on the Wi-Fi has proved nothing about itself,
    /// so the address is the most it is allowed to contribute. The credential
    /// comes from the operator.
    static func discovered(name: String?, host: String, port: Int) throws -> Candidate {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = sanitiseName(name) ?? host

        let errors = DestinationProfile.validate(name: name, host: host, port: port, key: nil)
        guard errors.isEmpty else { throw ImportError.invalid(errors) }

        return Candidate(
            name: name,
            transport: .avrLive,
            host: host,
            port: port,
            key: nil,
            source: .discovery
        )
    }

    // MARK: - Configuration documents

    /// Version of the document schema this build writes.
    ///
    /// A document declaring a *higher* version is refused rather than
    /// best-guessed. A future version could add a field whose absence changes
    /// what a destination means, and quietly ignoring it would connect
    /// somewhere the author did not intend. Version 2 is exactly that case: it
    /// added `tls` and `pin`, and a build that dropped them on the floor would
    /// read a document describing a pinned encrypted destination and import a
    /// cleartext one under the same name.
    ///
    /// Older documents are still read, because the reverse is safe — a version
    /// 1 document has no encryption fields, and the absence of them means
    /// cleartext, which is precisely what version 1 always meant.
    static let schemaVersion = 2

    /// Refuse anything implausible before handing it to the JSON decoder. A
    /// destination list is a few hundred bytes per entry; a megabyte of it is
    /// not a configuration file.
    static let documentByteLimit = 64 * 1024
    static let destinationCountLimit = 32

    private struct Document: Decodable {
        let avrDestinationConfig: Int
        let destinations: [Entry]

        struct Entry: Decodable {
            let name: String?
            let transport: String?
            let host: String
            let port: Int
            let key: String?
            /// Schema 2. Absent means cleartext.
            let tls: Bool?
            /// Schema 2. Base64 SHA-256 of the server's certificate. Not a
            /// secret — it is a hash of something the server hands to anyone
            /// who connects — so unlike `key` it is safe in a shared file, and
            /// putting it there is how a crew gets the studio's self-signed
            /// server without each of them confirming a fingerprint by hand.
            let pin: String?
        }
    }

    private struct EncodableDocument: Encodable {
        let avrDestinationConfig: Int
        let destinations: [Entry]

        struct Entry: Encodable {
            let name: String
            let transport: String
            let host: String
            let port: Int
            let tls: Bool
            let pin: String?
        }
    }

    /// Parse a destination list.
    ///
    /// Every entry must be valid. A file with one bad row is rejected whole
    /// rather than partially imported, because a crew member who sees "3
    /// destinations added" has no reason to go looking for the fourth.
    static func candidates(fromDocument data: Data) throws -> [Candidate] {
        guard data.count <= documentByteLimit else {
            throw ImportError.documentTooLarge(limit: documentByteLimit)
        }

        guard let document = try? JSONDecoder().decode(Document.self, from: data) else {
            throw ImportError.unreadableDocument
        }

        guard document.avrDestinationConfig >= 1, document.avrDestinationConfig <= schemaVersion else {
            throw ImportError.unsupportedSchemaVersion(
                found: document.avrDestinationConfig,
                supported: schemaVersion
            )
        }

        guard !document.destinations.isEmpty else { throw ImportError.noDestinations }

        guard document.destinations.count <= destinationCountLimit else {
            throw ImportError.tooManyDestinations(limit: destinationCountLimit)
        }

        return try document.destinations.map { entry in
            let transport: DestinationProfile.Transport
            if let raw = entry.transport, !raw.isEmpty {
                guard let parsed = DestinationProfile.Transport(rawValue: raw) else {
                    throw ImportError.unsupportedTransport(raw)
                }
                transport = parsed
            } else {
                transport = .avrLive
            }

            let host = entry.host.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = sanitiseName(entry.name) ?? host

            let errors = DestinationProfile.validate(
                name: name, host: host, port: entry.port, key: entry.key
            )
            guard errors.isEmpty else { throw ImportError.invalid(errors) }

            // Same rule as a pairing link: a pin implies TLS. An entry carrying
            // a pin with `tls` absent or false would otherwise import as
            // cleartext while reading, to whoever wrote the file, like the more
            // careful of the two options.
            let pin = validPin(entry.pin)

            return Candidate(
                name: name,
                transport: transport,
                host: host,
                port: entry.port,
                key: entry.key,
                source: .configurationFile,
                usesTLS: pin != nil || entry.tls == true,
                certificatePin: pin
            )
        }
    }

    /// Write a destination list for sharing.
    ///
    /// Keys are never included, and there is no option to include them. A
    /// configuration file is a thing people email to each other; a stream key
    /// in one is a credential in an inbox, a mail server, and a backup of both.
    /// The recipient pastes their own key, which is also the only way the
    /// server can tell two operators apart.
    ///
    /// Certificate pins *are* included. A pin is a hash of something the server
    /// presents to every client that connects, so it authenticates the server
    /// to the phone and grants nothing to whoever holds it — the opposite of a
    /// key in both directions.
    static func document(for profiles: [DestinationProfile]) throws -> Data {
        let document = EncodableDocument(
            avrDestinationConfig: schemaVersion,
            destinations: profiles.map {
                .init(
                    name: $0.name,
                    transport: $0.transport.rawValue,
                    host: $0.host,
                    port: $0.port,
                    tls: $0.usesTLS,
                    pin: $0.usesTLS ? $0.certificatePin : nil
                )
            }
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(document)
    }

    // MARK: - Helpers

    /// Trim, strip control characters, and cap the length of a supplied name.
    ///
    /// The name is shown in a list and written to the server in the handshake.
    /// A name containing a newline or a run of right-to-left overrides can make
    /// a list entry impersonate another one, which matters here because the
    /// list is what the operator reads before going on air.
    private static func sanitiseName(_ raw: String?) -> String? {
        guard let raw else { return nil }

        let stripped = String(
            raw.unicodeScalars.filter {
                !CharacterSet.controlCharacters.contains($0)
                    && !bidiOverrides.contains($0)
            }
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !stripped.isEmpty else { return nil }
        return String(stripped.prefix(DestinationLimits.nameMaxLength))
    }

    private static let bidiOverrides = CharacterSet(charactersIn: "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}")
}
