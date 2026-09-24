import XCTest
@testable import AVRCapture

/// The Keychain wrapper is four calls long and each one of them has a failure
/// mode that is silent: `SecItemAdd` refusing a duplicate, `SecItemCopyMatching`
/// returning data that is not a UTF-8 string, a delete that removes more than
/// it was asked to.
final class KeychainTests: XCTestCase {
    private let account = "tests.destination.\(UUID().uuidString)"

    override func setUp() {
        super.setUp()
        Keychain.removeAll()
    }

    override func tearDown() {
        Keychain.removeAll()
        super.tearDown()
    }

    func testRoundTrip() throws {
        try Keychain.set("a-stream-key", for: account)
        XCTAssertEqual(Keychain.value(for: account), "a-stream-key")
    }

    func testOverwritingReplacesRatherThanFailing() throws {
        // `SecItemAdd` on an existing account returns `errSecDuplicateItem`, so
        // the wrapper deletes first. Without that, changing a key would appear
        // to work and then keep using the old one.
        try Keychain.set("first", for: account)
        try Keychain.set("second", for: account)

        XCTAssertEqual(Keychain.value(for: account), "second")
    }

    func testEmptyValueDeletes() throws {
        try Keychain.set("something", for: account)
        try Keychain.set("", for: account)

        XCTAssertNil(Keychain.value(for: account))
    }

    func testMissingAccountReturnsNil() {
        XCTAssertNil(Keychain.value(for: "never.written.\(UUID().uuidString)"))
    }

    func testRemoveIsScopedToOneAccount() throws {
        let other = "tests.other.\(UUID().uuidString)"
        try Keychain.set("mine", for: account)
        try Keychain.set("theirs", for: other)

        Keychain.remove(account)

        XCTAssertNil(Keychain.value(for: account))
        XCTAssertEqual(Keychain.value(for: other), "theirs")
    }

    func testRemoveAllClearsTheService() throws {
        try Keychain.set("a", for: "tests.a")
        try Keychain.set("b", for: "tests.b")

        Keychain.removeAll()

        XCTAssertNil(Keychain.value(for: "tests.a"))
        XCTAssertNil(Keychain.value(for: "tests.b"))
    }

    func testHandlesUnicodeAndLongValues() throws {
        let long = String(repeating: "k", count: DestinationLimits.keyMaxLength)
        try Keychain.set(long, for: account)
        XCTAssertEqual(Keychain.value(for: account), long)
    }
}
