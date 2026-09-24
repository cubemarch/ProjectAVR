import XCTest
@testable import AVRCapture

/// A redaction that leaks is worse than no redaction, because it is trusted.
final class RedactionTests: XCTestCase {
    func testMasksSecretsButKeepsThemIdentifiable() {
        XCTAssertEqual(Redact.secret(nil), "(none)")
        XCTAssertEqual(Redact.secret(""), "(none)")

        // Short values go completely: four of six characters is most of the
        // secret, not a hint.
        XCTAssertEqual(Redact.secret("abc123"), "••••")
        XCTAssertEqual(Redact.secret(String(repeating: "a", count: 11)), "••••")

        XCTAssertEqual(Redact.secret("sk_live_0123456789"), "••••6789")
    }

    func testRedactedSecretNeverContainsTheOriginal() {
        let secret = "sk_live_supersecretvalue"
        let redacted = Redact.secret(secret)

        XCTAssertFalse(redacted.contains("supersecret"))
        XCTAssertLessThan(redacted.count, secret.count)
    }

    func testStripsUserinfoFromURLs() {
        let redacted = Redact.url("https://operator:hunter2@example.com/ingest")

        XCTAssertFalse(redacted.contains("hunter2"))
        XCTAssertFalse(redacted.contains("operator"))
        XCTAssertTrue(redacted.contains("example.com"))
    }

    func testStripsFragments() {
        // Some ingest providers carry a token in the fragment.
        XCTAssertFalse(Redact.url("https://example.com/live#tok_abcdef123456").contains("abcdef"))
    }

    func testMasksSensitiveQueryItems() {
        let redacted = Redact.url("avr://pair?host=10.0.0.1&port=8081&key=abcdef123456&streamKey=zzzzzzzzzzzz")

        XCTAssertFalse(redacted.contains("abcdef123456"))
        XCTAssertFalse(redacted.contains("zzzzzzzzzzzz"))
        XCTAssertTrue(redacted.contains("10.0.0.1"), "the address is not a secret and is the useful part")
        XCTAssertTrue(redacted.contains("8081"))
    }

    func testMatchesCredentialNamesLoosely() {
        for name in ["token", "AUTH", "x-signature", "session_id", "user_password", "apiSecret"] {
            let redacted = Redact.url("https://example.com?\(name)=abcdef123456")
            XCTAssertFalse(redacted.contains("abcdef123456"), "\(name) was not masked")
        }
    }

    func testUnparseableURLsAreDroppedRatherThanPassedThrough() {
        // The case where a naive search-and-replace misses the secret it was
        // meant to find.
        XCTAssertEqual(Redact.url("http://exa mple.com?key=abcdef123456"), "(unparseable url)")
        XCTAssertEqual(Redact.url(nil), "(none)")
    }

    func testEndpointBracketsIPv6() {
        XCTAssertEqual(Redact.endpoint(host: "10.0.0.1", port: 8081), "10.0.0.1:8081")
        XCTAssertEqual(Redact.endpoint(host: "2001:db8::1", port: 8081), "[2001:db8::1]:8081")
    }
}
