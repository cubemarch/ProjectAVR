import XCTest
@testable import AVRCapture

/// The privacy policy link is a submission requirement, and the failure mode
/// worth testing is not "the link is missing" — that is visible — but "the link
/// is present and goes nowhere", which looks configured right up until a
/// reviewer taps it.
final class SupportLinksTests: XCTestCase {
    func testAcceptsAConfiguredHTTPSPage() {
        let url = SupportLinks.url(from: "https://capture.projectavr.tv/privacy")

        XCTAssertEqual(url?.absoluteString, "https://capture.projectavr.tv/privacy")
    }

    func testTrimsSurroundingWhitespace() {
        // Plist values get pasted, and a trailing newline is invisible in Xcode.
        XCTAssertNotNil(SupportLinks.url(from: "  https://capture.projectavr.tv/privacy\n"))
    }

    func testRejectsAnythingThatIsNotHTTPS() {
        // A policy fetched over plain HTTP can be rewritten in transit, and the
        // one document whose integrity the user is asked to rely on is a poor
        // place to make an exception.
        for raw in [
            "http://capture.projectavr.tv/privacy",
            "ftp://capture.projectavr.tv/privacy",
            "capture.projectavr.tv/privacy",
            "javascript:alert(1)"
        ] {
            XCTAssertNil(SupportLinks.url(from: raw), raw)
        }
    }

    func testRejectsEmptyAndAbsentValues() {
        XCTAssertNil(SupportLinks.url(from: nil))
        XCTAssertNil(SupportLinks.url(from: ""))
        XCTAssertNil(SupportLinks.url(from: "   "))
        XCTAssertNil(SupportLinks.url(from: "https://"))
    }

    func testRejectsTheCheckedInPlaceholder() {
        // This is the guard that matters. The plist ships with a reserved host
        // so the shape of the setting is documented in the file itself; if that
        // value reached the UI it would be a dead link in the one place Apple
        // is certain to look.
        XCTAssertNil(SupportLinks.url(from: "https://capture.example.com/privacy"))
        XCTAssertNil(SupportLinks.url(from: "https://capture.example.com/support"))
    }

    func testRejectsEveryReservedName() {
        for host in [
            "example.com", "www.example.com",
            "example.net", "example.org",
            "anything.example", "anything.invalid", "anything.test",
            "localhost"
        ] {
            XCTAssertTrue(SupportLinks.isPlaceholder(host: host), host)
            XCTAssertNil(SupportLinks.url(from: "https://\(host)/privacy"), host)
        }
    }

    func testDoesNotRejectARealNameThatMerelyContainsAReservedOne() {
        // Suffix matching, not substring: "example.company" and
        // "notexample.com" are ordinary registrable names and refusing them
        // would hide a correctly configured link.
        for host in ["example.company", "notexample.com", "test.projectavr.tv", "invalid-input.org"] {
            XCTAssertFalse(SupportLinks.isPlaceholder(host: host), host)
            XCTAssertNotNil(SupportLinks.url(from: "https://\(host)/privacy"), host)
        }
    }
}
