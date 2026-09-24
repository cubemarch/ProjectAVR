import XCTest
@testable import AVRCapture

/// The address field is a trust boundary.
///
/// Everything that reaches `DestinationAddress.validate` was typed, pasted,
/// scanned, or handed over in a link somebody received, and it ends up in
/// `NWEndpoint.Host`, in a log line and in the diagnostics export. These tests
/// are mostly about what must be *refused*.
final class DestinationValidationTests: XCTestCase {
    // MARK: - Hosts

    func testAcceptsOrdinaryAddresses() {
        for host in [
            "192.168.1.10",
            "10.0.0.1",
            "live.example.com",
            "a.b.c.d.example.com",
            "example.com.",          // fully qualified, trailing dot is legal
            "server-1.local",
            "::1",
            "[2001:db8::1]",
            "2001:db8::1",
            "fe80::1%en0"            // zone identifier
        ] {
            XCTAssertEqual(DestinationAddress.validate(host), [], "rejected \(host)")
        }
    }

    func testRejectsControlCharactersInHost() {
        // A newline in a host forges a log entry, which is the whole reason the
        // field is validated rather than trimmed.
        for host in ["192.168.1.10\nHELLO", "host\r\nname", "host\tname", "ho st"] {
            XCTAssertEqual(DestinationAddress.validate(host), [.hostMalformed], "accepted \(host)")
        }
    }

    func testRejectsURLsWithAdviceRatherThanGenericFailure() {
        for host in ["https://example.com", "avr://pair", "//example.com"] {
            XCTAssertEqual(DestinationAddress.validate(host), [.hostLooksLikeURL], "wrong error for \(host)")
        }
    }

    func testRejectsCredentialsAndPathsSmuggledIntoTheHost() {
        for host in ["user@example.com", "example.com/stream", "example.com?key=abc", "example.com#frag"] {
            XCTAssertEqual(DestinationAddress.validate(host), [.hostMalformed], "accepted \(host)")
        }
    }

    func testRejectsAbbreviatedAndOctalIPv4() {
        // `inet_aton` accepts both of these and resolves them somewhere the
        // operator did not intend; `inet_pton` does not, which is why the code
        // uses it.
        XCTAssertEqual(DestinationAddress.validate("0177.0.0.1"), [.hostMalformed])
        XCTAssertEqual(DestinationAddress.validate("999.1.1.1"), [.hostMalformed])
        XCTAssertEqual(DestinationAddress.validate("1.2.3.4.5"), [.hostMalformed])
    }

    func testRejectsMalformedHostnames() {
        for host in ["-leading.example.com", "trailing-.example.com", "under_score.example.com", "..", "a..b"] {
            XCTAssertEqual(DestinationAddress.validate(host), [.hostMalformed], "accepted \(host)")
        }
    }

    func testRejectsOverlongHost() {
        let label = String(repeating: "a", count: 63)
        let host = [label, label, label, label].joined(separator: ".")  // 255 characters
        XCTAssertTrue(DestinationAddress.validate(host).contains(.hostTooLong(max: DestinationLimits.hostMaxLength)))
    }

    func testEmptyHost() {
        XCTAssertEqual(DestinationAddress.validate("   "), [.hostEmpty])
    }

    // MARK: - Local versus public

    func testRecognisesLocalAddresses() {
        for host in [
            "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.255.254",
            "169.254.1.1", "100.64.0.1", "localhost", "studio.local", "::1", "fd00::1", "fe80::1"
        ] {
            XCTAssertTrue(DestinationAddress.isPrivate(host), "\(host) should be local")
        }
    }

    func testTreatsEverythingElseAsPublic() {
        // Conservative on purpose: calling a public host local blocks a
        // legitimate remote broadcast, which is the more expensive mistake.
        for host in ["8.8.8.8", "172.32.0.1", "172.15.0.1", "live.example.com", "2001:db8::1"] {
            XCTAssertFalse(DestinationAddress.isPrivate(host), "\(host) should be public")
        }
    }

    // MARK: - Whole profiles

    func testPortRange() {
        for port in [0, -1, 65_536, 1_000_000] {
            XCTAssertTrue(
                DestinationProfile.validate(name: "A", host: "example.com", port: port, key: nil)
                    .contains(.portOutOfRange),
                "accepted port \(port)"
            )
        }

        for port in [1, 8081, 65_535] {
            XCTAssertEqual(
                DestinationProfile.validate(name: "A", host: "example.com", port: port, key: nil),
                []
            )
        }
    }

    func testNameLimits() {
        XCTAssertTrue(
            DestinationProfile.validate(name: "  ", host: "example.com", port: 1, key: nil)
                .contains(.nameEmpty)
        )

        let long = String(repeating: "n", count: DestinationLimits.nameMaxLength + 1)
        XCTAssertTrue(
            DestinationProfile.validate(name: long, host: "example.com", port: 1, key: nil)
                .contains(.nameTooLong(max: DestinationLimits.nameMaxLength))
        )
    }

    func testKeyMustBePrintableASCII() {
        XCTAssertTrue(
            DestinationProfile.validate(name: "A", host: "example.com", port: 1, key: "key with space")
                .contains(.keyNotPrintable)
        )
        XCTAssertTrue(
            DestinationProfile.validate(name: "A", host: "example.com", port: 1, key: "key\nnewline")
                .contains(.keyNotPrintable)
        )
        XCTAssertEqual(
            DestinationProfile.validate(name: "A", host: "example.com", port: 1, key: "sk_live_abc123-._~"),
            []
        )

        let long = String(repeating: "k", count: DestinationLimits.keyMaxLength + 1)
        XCTAssertTrue(
            DestinationProfile.validate(name: "A", host: "example.com", port: 1, key: long)
                .contains(.keyTooLong(max: DestinationLimits.keyMaxLength))
        )
    }

    func testReportsEveryProblemAtOnce() {
        // So the editor can mark all the bad fields rather than one per save.
        let errors = DestinationProfile.validate(name: "", host: "", port: 0, key: nil)
        XCTAssertTrue(errors.contains(.nameEmpty))
        XCTAssertTrue(errors.contains(.hostEmpty))
        XCTAssertTrue(errors.contains(.portOutOfRange))
    }

    func testLocalNetworkIsDerivedFromTheAddress() {
        let local = DestinationProfile(name: "Studio", host: "192.168.1.10", port: 8081)
        let remote = DestinationProfile(name: "Cloud", host: "live.example.com", port: 8081)

        XCTAssertTrue(local.isLocalNetwork)
        XCTAssertFalse(remote.isLocalNetwork)
    }
}
