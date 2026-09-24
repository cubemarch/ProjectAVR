import XCTest
@testable import AVRCapture

/// The store is the only seam between a profile and its credential, so it is
/// the only place a credential can leak into the wrong storage.
@MainActor
final class DestinationStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        try await super.setUp()
        suiteName = "com.projectavr.capture.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))

        // Keychain storage is shared by the whole process, so each test starts
        // from empty rather than inheriting the previous one's keys.
        Keychain.removeAll()
    }

    override func tearDown() async throws {
        Keychain.removeAll()
        defaults.removePersistentDomain(forName: suiteName)
        try await super.tearDown()
    }

    private func makeStore() -> DestinationStore {
        DestinationStore(defaults: defaults)
    }

    func testAddingSelectsAndPersistsTheProfileButNotTheKey() throws {
        let store = makeStore()
        let profile = store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "secret-key")

        XCTAssertEqual(store.selectedId, profile.id)
        XCTAssertTrue(store.hasSecret(for: profile.id))
        XCTAssertEqual(store.secret(for: profile.id), "secret-key")

        // The profile is in `UserDefaults`; the key must not be anywhere near it.
        let raw = try XCTUnwrap(defaults.data(forKey: "destinations.v1"))
        let text = try XCTUnwrap(String(data: raw, encoding: .utf8))
        XCTAssertTrue(text.contains("10.0.0.1"))
        XCTAssertFalse(text.contains("secret-key"))
    }

    func testProfilesSurviveANewStore() {
        let first = makeStore()
        let profile = first.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "k123456789012")

        let second = makeStore()
        XCTAssertEqual(second.profiles.map(\.id), [profile.id])
        XCTAssertEqual(second.selectedId, profile.id)
        XCTAssertEqual(second.secret(for: profile.id), "k123456789012")
    }

    func testReadyOnlyWithBothAProfileAndAKey() {
        let store = makeStore()
        XCTAssertFalse(store.isReadyToBroadcast)

        let profile = store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: nil)
        XCTAssertFalse(store.isReadyToBroadcast, "a destination with no key cannot broadcast")

        store.setSecret("abc", for: profile.id)
        XCTAssertTrue(store.isReadyToBroadcast)
        XCTAssertEqual(store.readyDestination?.profile.host, "10.0.0.1")
        XCTAssertEqual(store.readyDestination?.key, "abc")

        store.setSecret(nil, for: profile.id)
        XCTAssertFalse(store.isReadyToBroadcast)
    }

    func testUpdatingWithoutAKeyLeavesTheStoredOneAlone() {
        // The editor never displays a stored key, so pressing Save after
        // changing only the name must not wipe it.
        let store = makeStore()
        var profile = store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "keep-me")

        profile.name = "Studio B"
        store.update(profile, key: nil)

        XCTAssertEqual(store.profiles.first?.name, "Studio B")
        XCTAssertEqual(store.secret(for: profile.id), "keep-me")
    }

    func testDuplicatingNeverCopiesTheKey() {
        // "Same address, different creator" must not silently broadcast under
        // the other person's identity.
        let store = makeStore()
        let original = store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "original")

        let copy = store.duplicate(original.id)
        let copyId = try? XCTUnwrap(copy?.id)

        XCTAssertNotNil(copyId)
        XCTAssertEqual(copy?.host, "10.0.0.1")
        XCTAssertFalse(store.hasSecret(for: copy!.id))
        XCTAssertEqual(store.secret(for: original.id), "original", "the original keeps its key")
    }

    func testRemovingDeletesTheKeyToo() {
        let store = makeStore()
        let profile = store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "gone")

        store.remove(profile.id)

        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertNil(store.secret(for: profile.id))
        XCTAssertNil(store.selectedId)
    }

    func testEraseAllClearsEverything() {
        let store = makeStore()
        let a = store.add(name: "A", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "ka")
        let b = store.add(name: "B", transport: .avrLive, host: "10.0.0.2", port: 8081, key: "kb")

        store.eraseAll()

        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertNil(store.selectedId)
        XCTAssertNil(store.secret(for: a.id))
        XCTAssertNil(store.secret(for: b.id))
        XCTAssertNil(defaults.data(forKey: "destinations.v1"))
    }

    func testAddingACandidateCarriesItsKeyAcross() {
        let store = makeStore()
        let candidate = DestinationImport.Candidate(
            name: "From link",
            transport: .avrLive,
            host: "10.0.0.9",
            port: 8081,
            key: "link-key",
            source: .pairingLink
        )

        let profile = store.add(candidate)

        XCTAssertEqual(store.secret(for: profile.id), "link-key")
        XCTAssertEqual(store.selectedId, profile.id)
    }

    func testSelectingAnUnknownIdIsIgnored() {
        let store = makeStore()
        let profile = store.add(name: "A", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "k")

        store.select(UUID())
        XCTAssertEqual(store.selectedId, profile.id)

        store.select(nil)
        XCTAssertNil(store.selectedId)
    }

    // MARK: - Migration

    func testMigratesTheLegacySingleDestinationAndRemovesTheKeyFromDefaults() throws {
        // The pre-profiles build kept the stream key in `UserDefaults` in the
        // clear. Getting it out is the part that matters, and it happens even
        // when there is no host to build a profile from.
        defaults.set("192.168.1.42", forKey: "serverHost")
        defaults.set(8085, forKey: "serverPort")
        defaults.set("legacy-key", forKey: "streamKey")
        defaults.set("Old Name", forKey: "broadcastName")

        let store = makeStore()

        XCTAssertEqual(store.profiles.count, 1)
        let profile = try XCTUnwrap(store.profiles.first)
        XCTAssertEqual(profile.host, "192.168.1.42")
        XCTAssertEqual(profile.port, 8085)
        XCTAssertEqual(profile.name, "Old Name")
        XCTAssertEqual(store.secret(for: profile.id), "legacy-key")

        XCTAssertNil(defaults.string(forKey: "streamKey"))
        XCTAssertNil(defaults.string(forKey: "serverHost"))
    }

    func testRemovesALegacyKeyEvenWithNoHostToMigrate() {
        defaults.set("orphan-key", forKey: "streamKey")

        let store = makeStore()

        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertNil(defaults.string(forKey: "streamKey"))
    }

    func testDoesNotMigrateOverExistingProfiles() {
        let first = makeStore()
        first.add(name: "Existing", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "k")

        defaults.set("192.168.1.42", forKey: "serverHost")
        defaults.set("legacy-key", forKey: "streamKey")

        let second = makeStore()

        XCTAssertEqual(second.profiles.count, 1)
        XCTAssertEqual(second.profiles.first?.host, "10.0.0.1")
        XCTAssertNil(defaults.string(forKey: "streamKey"))
    }
}
