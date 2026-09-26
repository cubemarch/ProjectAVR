import XCTest
@testable import AVRCapture

/// Importing is the app's only untrusted input path, and the one with
/// consequences: a destination is where the camera's output goes.
final class DestinationImportTests: XCTestCase {
    private func url(_ string: String) throws -> URL {
        try XCTUnwrap(URL(string: string))
    }

    // MARK: - Pairing links

    func testParsesAPairingLink() throws {
        let candidate = try DestinationImport.candidate(
            from: url("avr://pair?host=192.168.1.10&port=8081&key=abc123&name=Studio%20B")
        )

        XCTAssertEqual(candidate.name, "Studio B")
        XCTAssertEqual(candidate.host, "192.168.1.10")
        XCTAssertEqual(candidate.port, 8081)
        XCTAssertEqual(candidate.key, "abc123")
        XCTAssertEqual(candidate.transport, .avrLive)
        XCTAssertEqual(candidate.source, .pairingLink)
        XCTAssertTrue(candidate.carriesKey)
        XCTAssertTrue(candidate.isLocalNetwork)
    }

    func testALinkWithoutAKeyIsValid() throws {
        // Distributing an address to a crew who each hold their own credential
        // is a legitimate and common shape.
        let candidate = try DestinationImport.candidate(from: url("avr://pair?host=live.example.com&port=8081"))

        XCTAssertFalse(candidate.carriesKey)
        XCTAssertEqual(candidate.name, "live.example.com", "falls back to the host")
        XCTAssertFalse(candidate.isLocalNetwork)
    }

    func testRejectsForeignSchemesAndHosts() {
        for raw in [
            "https://pair?host=a&port=1",
            "avr://connect?host=a&port=1",
            "avr://pair"
        ] {
            XCTAssertThrowsError(try DestinationImport.candidate(from: XCTUnwrap(URL(string: raw))))
        }
    }

    func testMissingFieldsAreNamed() throws {
        XCTAssertThrowsError(try DestinationImport.candidate(from: url("avr://pair?port=8081"))) { error in
            XCTAssertEqual(error as? DestinationImport.ImportError, .missingField("address"))
        }

        XCTAssertThrowsError(try DestinationImport.candidate(from: url("avr://pair?host=a.example.com"))) { error in
            XCTAssertEqual(error as? DestinationImport.ImportError, .missingField("port"))
        }
    }

    func testRejectsAHostileHostInALink() throws {
        // Percent-encoded CRLF. The link parser is the place this has to be
        // caught: by the time it reaches a log line it is already a forged
        // entry, and by the time it reaches the socket it is a connection
        // somewhere nobody chose.
        XCTAssertThrowsError(
            try DestinationImport.candidate(from: url("avr://pair?host=10.0.0.1%0D%0Aevil&port=8081"))
        ) { error in
            guard case .invalid = error as? DestinationImport.ImportError else {
                return XCTFail("expected .invalid, got \(error)")
            }
        }
    }

    func testRejectsOutOfRangePorts() throws {
        for port in ["0", "65536", "-1", "notanumber"] {
            XCTAssertThrowsError(
                try DestinationImport.candidate(from: url("avr://pair?host=a.example.com&port=\(port)")),
                "accepted port \(port)"
            )
        }
    }

    func testRejectsUnknownTransports() throws {
        XCTAssertThrowsError(
            try DestinationImport.candidate(from: url("avr://pair?host=a.example.com&port=1935&transport=rtmp"))
        ) { error in
            XCTAssertEqual(error as? DestinationImport.ImportError, .unsupportedTransport("rtmp"))
        }
    }

    func testStripsBidirectionalOverridesFromNames() throws {
        // A name is what the operator reads before going on air. A run of
        // right-to-left overrides lets one list entry impersonate another.
        let candidate = try DestinationImport.candidate(
            from: url("avr://pair?host=10.0.0.1&port=8081&name=Studio%E2%80%AEB")
        )

        XCTAssertEqual(candidate.name, "StudioB")
    }

    func testDuplicateParametersTakeTheLastValue() throws {
        // Documented behaviour rather than an accident: a duplicated parameter
        // is an attempt to have two readers disagree about the same link.
        let candidate = try DestinationImport.candidate(
            from: url("avr://pair?host=10.0.0.1&host=10.0.0.2&port=8081")
        )

        XCTAssertEqual(candidate.host, "10.0.0.2")
    }

    func testTextEntryPoint() throws {
        let candidate = try DestinationImport.candidate(fromText: "  avr://pair?host=10.0.0.1&port=8081  ")
        XCTAssertEqual(candidate.host, "10.0.0.1")

        XCTAssertThrowsError(try DestinationImport.candidate(fromText: "   "))
    }

    // MARK: - Encryption in a pairing link

    private var samplePin: String { Data(repeating: 9, count: 32).base64EncodedString() }

    func testAPairingLinkCarriesTLSAndAPin() throws {
        let encoded = try XCTUnwrap(samplePin.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let candidate = try DestinationImport.candidate(
            from: url("avr://pair?host=192.168.1.10&port=8081&tls=1&pin=\(encoded)")
        )

        XCTAssertTrue(candidate.usesTLS)
        XCTAssertEqual(candidate.certificatePin, samplePin)
        XCTAssertEqual(candidate.encryptedLabel, "Yes, certificate pinned")
        XCTAssertEqual(TransportSecurity(profile: candidate.profile()), .tls(pin: samplePin))
    }

    func testAPinImpliesTLS() throws {
        // A link with a pin but no `tls` would otherwise connect in the clear
        // while presenting, on the confirmation sheet, as the safer option.
        let encoded = try XCTUnwrap(samplePin.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let candidate = try DestinationImport.candidate(
            from: url("avr://pair?host=192.168.1.10&port=8081&pin=\(encoded)")
        )

        XCTAssertTrue(candidate.usesTLS)
    }

    func testAMalformedPinIsDiscardedWithoutDowngrading() throws {
        for bad in ["short", "AAAA", "%20"] {
            let candidate = try DestinationImport.candidate(
                from: url("avr://pair?host=192.168.1.10&port=8081&tls=1&pin=\(bad)")
            )

            XCTAssertNil(candidate.certificatePin, "\(bad) is not 32 base64 bytes")
            XCTAssertTrue(candidate.usesTLS, "\(bad) must not turn encryption off")
        }
    }

    func testALinkWithoutTLSIsCleartext() throws {
        let candidate = try DestinationImport.candidate(from: url("avr://pair?host=192.168.1.10&port=8081"))

        XCTAssertFalse(candidate.usesTLS)
        XCTAssertEqual(candidate.encryptedLabel, "No")
        XCTAssertEqual(TransportSecurity(profile: candidate.profile()), .cleartext)
    }

    func testAProfileSurvivesJSONWrittenBeforeEncryptionExisted() throws {
        // The regression this guards is total: Swift's synthesised
        // `init(from:)` throws `keyNotFound` for a missing key even when the
        // property has a default, so shipping a new field without decoding it
        // by hand would make every stored destination fail to decode and the
        // list come up empty with nothing for the operator to act on.
        let legacy = Data("""
        {
          "id": "8B27E1F4-8B2A-4E2E-9E7B-2E3A6E9A1C11",
          "name": "Studio A",
          "transport": "avr-live",
          "host": "10.0.0.1",
          "port": 8081
        }
        """.utf8)

        let profile = try JSONDecoder().decode(DestinationProfile.self, from: legacy)

        XCTAssertEqual(profile.host, "10.0.0.1")
        XCTAssertFalse(profile.usesTLS)
        XCTAssertNil(profile.certificatePin)
    }

    // MARK: - Configuration documents

    private func document(_ json: String) -> Data { Data(json.utf8) }

    func testParsesAConfigurationDocument() throws {
        let candidates = try DestinationImport.candidates(fromDocument: document("""
        {
          "avrDestinationConfig": 1,
          "destinations": [
            {"name": "Studio A", "host": "10.0.0.1", "port": 8081},
            {"name": "Studio B", "host": "10.0.0.2", "port": 8082, "key": "abc"}
          ]
        }
        """))

        XCTAssertEqual(candidates.count, 2)
        XCTAssertEqual(candidates[0].source, .configurationFile)
        XCTAssertFalse(candidates[0].carriesKey)
        XCTAssertTrue(candidates[1].carriesKey)
    }

    func testRejectsAFutureSchemaVersion() {
        // A later version could add a field whose absence changes what a
        // destination means, so a higher version is refused rather than
        // best-guessed.
        let future = DestinationImport.schemaVersion + 1

        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document("""
            {"avrDestinationConfig": \(future), "destinations": [{"host": "10.0.0.1", "port": 1}]}
            """))
        ) { error in
            XCTAssertEqual(
                error as? DestinationImport.ImportError,
                .unsupportedSchemaVersion(found: future, supported: DestinationImport.schemaVersion)
            )
        }

        // And nothing below 1, which is not an older schema but a malformed
        // document claiming to be one.
        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document("""
            {"avrDestinationConfig": 0, "destinations": [{"host": "10.0.0.1", "port": 1}]}
            """))
        )
    }

    func testReadsSchemaOneAsCleartext() throws {
        // Version 1 had no encryption fields and their absence meant cleartext,
        // so reading an old document must not invent anything.
        let candidates = try DestinationImport.candidates(fromDocument: document("""
        {"avrDestinationConfig": 1, "destinations": [{"host": "10.0.0.1", "port": 8081}]}
        """))

        XCTAssertFalse(candidates[0].usesTLS)
        XCTAssertNil(candidates[0].certificatePin)
        XCTAssertEqual(candidates[0].encryptedLabel, "No")
    }

    func testReadsEncryptionFieldsFromSchemaTwo() throws {
        let pin = Data(repeating: 7, count: 32).base64EncodedString()

        let candidates = try DestinationImport.candidates(fromDocument: document("""
        {
          "avrDestinationConfig": 2,
          "destinations": [
            {"host": "10.0.0.1", "port": 8081, "tls": true, "pin": "\(pin)"},
            {"host": "live.example.com", "port": 8081, "tls": true},
            {"host": "10.0.0.3", "port": 8081, "pin": "\(pin)"},
            {"host": "10.0.0.4", "port": 8081, "tls": true, "pin": "not base64 at all"}
          ]
        }
        """))

        XCTAssertEqual(candidates[0].certificatePin, pin)
        XCTAssertEqual(candidates[0].encryptedLabel, "Yes, certificate pinned")

        XCTAssertTrue(candidates[1].usesTLS)
        XCTAssertNil(candidates[1].certificatePin, "a real host name is validated by iOS")

        XCTAssertTrue(candidates[2].usesTLS, "a pin implies TLS even with the flag absent")

        // A pin that cannot be a SHA-256 is dropped rather than stored, but
        // dropping it must not also downgrade the connection to cleartext.
        XCTAssertNil(candidates[3].certificatePin)
        XCTAssertTrue(candidates[3].usesTLS)
    }

    func testRejectsTheWholeDocumentWhenOneRowIsBad() {
        // A crew member who sees "3 destinations added" has no reason to go
        // looking for the fourth.
        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document("""
            {"avrDestinationConfig": 1, "destinations": [
              {"host": "10.0.0.1", "port": 8081},
              {"host": "not a host", "port": 8081}
            ]}
            """))
        )
    }

    func testRejectsAnOversizedDocument() {
        let padding = String(repeating: "x", count: DestinationImport.documentByteLimit)
        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document("""
            {"avrDestinationConfig": 1, "destinations": [{"name": "\(padding)", "host": "10.0.0.1", "port": 1}]}
            """))
        ) { error in
            XCTAssertEqual(
                error as? DestinationImport.ImportError,
                .documentTooLarge(limit: DestinationImport.documentByteLimit)
            )
        }
    }

    func testRejectsTooManyDestinations() {
        let entries = (0..<(DestinationImport.destinationCountLimit + 1))
            .map { #"{"host": "10.0.0.1", "port": \#($0 + 1)}"# }
            .joined(separator: ",")

        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document(
                #"{"avrDestinationConfig": 1, "destinations": [\#(entries)]}"#
            ))
        ) { error in
            XCTAssertEqual(
                error as? DestinationImport.ImportError,
                .tooManyDestinations(limit: DestinationImport.destinationCountLimit)
            )
        }
    }

    func testRejectsAnEmptyOrUnreadableDocument() {
        XCTAssertThrowsError(
            try DestinationImport.candidates(fromDocument: document(
                #"{"avrDestinationConfig": 1, "destinations": []}"#
            ))
        ) { error in
            XCTAssertEqual(error as? DestinationImport.ImportError, .noDestinations)
        }

        XCTAssertThrowsError(try DestinationImport.candidates(fromDocument: document("not json"))) { error in
            XCTAssertEqual(error as? DestinationImport.ImportError, .unreadableDocument)
        }
    }

    // MARK: - Exporting

    func testExportedDocumentsNeverContainKeys() throws {
        let profile = DestinationProfile(name: "Studio", host: "10.0.0.1", port: 8081)
        let data = try DestinationImport.document(for: [profile])
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertFalse(text.lowercased().contains("key"))

        // And the round trip still parses.
        let reimported = try DestinationImport.candidates(fromDocument: data)
        XCTAssertEqual(reimported.count, 1)
        XCTAssertFalse(reimported[0].carriesKey)
        XCTAssertEqual(reimported[0].host, "10.0.0.1")
    }

    func testExportRoundTripsEncryptionButNotAStalePin() throws {
        let pin = Data(repeating: 3, count: 32).base64EncodedString()

        let profiles = [
            DestinationProfile(name: "Pinned", host: "10.0.0.1", port: 8081, usesTLS: true, certificatePin: pin),
            // A pin left behind after TLS was turned off. Exporting it would
            // hand someone a document that pins a connection they were told is
            // in the clear, and the next import would honour the pin.
            DestinationProfile(name: "Plain", host: "10.0.0.2", port: 8081, usesTLS: false, certificatePin: pin)
        ]

        let data = try DestinationImport.document(for: profiles)
        let reimported = try DestinationImport.candidates(fromDocument: data)

        XCTAssertTrue(reimported[0].usesTLS)
        XCTAssertEqual(reimported[0].certificatePin, pin)

        XCTAssertFalse(reimported[1].usesTLS)
        XCTAssertNil(reimported[1].certificatePin)
    }

    // MARK: - Discovery

    func testDiscoveredCandidatesNeverCarryAKey() throws {
        let candidate = try DestinationImport.discovered(name: "Server", host: "192.168.1.50", port: 8081)

        XCTAssertEqual(candidate.source, .discovery)
        XCTAssertNil(candidate.key)
        XCTAssertFalse(candidate.carriesKey)
    }

    func testDiscoveryValidatesLikeEverythingElse() {
        XCTAssertThrowsError(try DestinationImport.discovered(name: nil, host: "10.0.0.1\nevil", port: 8081))
        XCTAssertThrowsError(try DestinationImport.discovered(name: nil, host: "10.0.0.1", port: 0))
    }

    // MARK: - Scanned codes

    /// A scan is a paste with a camera in front of it.
    ///
    /// The scanner has no parser of its own on purpose: it decodes a string and
    /// hands it here. This is the test that says so, and it is the one that
    /// fails if somebody ever "optimises" the scanner by letting it build a
    /// candidate directly.
    func testAScannedCodeParsesIdenticallyToAPastedLink() throws {
        let link = "avr://pair?host=192.168.1.110&port=8081&key=abc123&name=Studio%20A"

        let pasted = try DestinationImport.candidate(fromText: link)
        let scanned = try DestinationImport.candidate(fromText: link, source: .scannedCode)

        XCTAssertEqual(scanned.host, pasted.host)
        XCTAssertEqual(scanned.port, pasted.port)
        XCTAssertEqual(scanned.key, pasted.key)
        XCTAssertEqual(scanned.name, pasted.name)
        XCTAssertEqual(scanned.usesTLS, pasted.usesTLS)
        XCTAssertEqual(scanned.certificatePin, pasted.certificatePin)
    }

    /// The source is what the confirmation sheet tells the operator, and a
    /// camera can be pointed at a code by somebody else.
    func testAScannedCodeSaysItWasScanned() throws {
        let candidate = try DestinationImport.candidate(
            fromText: "avr://pair?host=10.0.0.5&port=8081&key=abc123",
            source: .scannedCode
        )

        XCTAssertEqual(candidate.source, .scannedCode)
        XCTAssertEqual(DestinationImport.Source.scannedCode.label, "Scanned code")
    }

    /// Anything a camera can see, the parser has to be able to refuse. A QR
    /// code is an instruction from whoever printed it, and the sticker on a
    /// lamp post is as likely to reach this function as the portal's own code.
    func testRubbishFromACameraIsRefusedLikeAnythingElse() {
        for text in [
            "hello",
            "https://example.com/",
            "http://pair?host=10.0.0.1&port=8081",
            "avr://pair?port=8081",
            "avr://pair?host=10.0.0.1",
            "avr://connect?host=10.0.0.1&port=8081",
            "WIFI:S=Venue;T=WPA;P=hunter2;;"
        ] {
            XCTAssertThrowsError(
                try DestinationImport.candidate(fromText: text, source: .scannedCode),
                "a scan of \"\(text)\" was accepted"
            )
        }
    }
}
