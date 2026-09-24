import Combine
import Foundation
import os

/// The destinations this device knows about, and which one is selected.
///
/// Split storage, deliberately. Profiles are JSON in `UserDefaults`: they are
/// not secret, they need to be enumerable, and losing them is an inconvenience.
/// Stream keys are in the Keychain under the profile's id: they are bearer
/// credentials, and losing one means retyping it.
///
/// The seam between the two is this class and nothing else. No other type in
/// the app can read a stream key, which means no other type can accidentally
/// log one, put one in a diagnostics export, or encode one into a URL.
@MainActor
final class DestinationStore: ObservableObject {
    @Published private(set) var profiles: [DestinationProfile] = []

    /// Which destination the shutter will broadcast to. `nil` is a legitimate
    /// state — the app is a usable camera and diagnostics tool with no
    /// destination at all, which is the point of the "no server required" path.
    @Published private(set) var selectedId: UUID?

    private let defaults: UserDefaults
    private let log = Logger(subsystem: "com.projectavr.capture", category: "destinations")

    private enum Key {
        static let profiles = "destinations.v1"
        static let selected = "destinations.selected"

        /// Pre-destination-profile settings, read once and then removed.
        static let legacyHost = "serverHost"
        static let legacyPort = "serverPort"
        static let legacyStreamKey = "streamKey"
        static let legacyName = "broadcastName"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
        migrateLegacySettingsIfNeeded()
    }

    // MARK: - Reading

    var selected: DestinationProfile? {
        guard let selectedId else { return nil }
        return profiles.first { $0.id == selectedId }
    }

    /// The stream key for a destination, straight from the Keychain.
    ///
    /// Not cached and not published. A `@Published` secret ends up in SwiftUI's
    /// diffing machinery and in every view that observes this object; reading it
    /// on demand keeps it in one stack frame at a time.
    func secret(for id: UUID) -> String? {
        Keychain.value(for: keychainAccount(id))
    }

    func hasSecret(for id: UUID) -> Bool {
        !(secret(for: id) ?? "").isEmpty
    }

    /// Everything needed to open a connection, or `nil` if the selection is
    /// incomplete. The single place the rest of the app asks "can we go live?"
    var readyDestination: (profile: DestinationProfile, key: String)? {
        guard let profile = selected, let key = secret(for: profile.id), !key.isEmpty else {
            return nil
        }
        return (profile, key)
    }

    var isReadyToBroadcast: Bool { readyDestination != nil }

    // MARK: - Writing

    func select(_ id: UUID?) {
        guard id == nil || profiles.contains(where: { $0.id == id }) else { return }
        selectedId = id
        defaults.set(id?.uuidString, forKey: Key.selected)
    }

    /// Save a parsed candidate. Called only from the import confirmation, never
    /// straight from a URL handler.
    @discardableResult
    func add(_ candidate: DestinationImport.Candidate, select makeSelected: Bool = true) -> DestinationProfile {
        let profile = candidate.profile()
        profiles.append(profile)

        if let key = candidate.key, !key.isEmpty {
            store(key: key, for: profile.id)
        }

        persistProfiles()
        if makeSelected { select(profile.id) }

        log.info("""
            destination added: \(profile.transport.rawValue, privacy: .public) \
            \(profile.endpointLabel, privacy: .public) \
            key=\(candidate.carriesKey, privacy: .public) \
            source=\(String(describing: candidate.source), privacy: .public)
            """)

        return profile
    }

    @discardableResult
    func add(
        name: String,
        transport: DestinationProfile.Transport,
        host: String,
        port: Int,
        key: String?,
        usesTLS: Bool = false,
        certificatePin: String? = nil
    ) -> DestinationProfile {
        add(
            .init(
                name: name,
                transport: transport,
                host: host,
                port: port,
                key: key,
                source: .configurationFile,
                usesTLS: usesTLS,
                certificatePin: certificatePin
            )
        )
    }

    func update(_ profile: DestinationProfile, key: String?) {
        guard let index = profiles.firstIndex(where: { $0.id == profile.id }) else { return }

        var updated = profile
        updated.updatedAt = Date()
        profiles[index] = updated

        // `nil` means "leave the stored key alone" — the editor passes nil when
        // the operator did not touch the field, so that opening an editor and
        // pressing Save does not wipe a key that was never displayed.
        if let key { store(key: key, for: profile.id) }

        persistProfiles()
    }

    /// Copy a destination, without its key.
    ///
    /// Duplicating is for "same server, second event" and for "same address,
    /// different creator". Carrying the key across would make the second case
    /// silently wrong in the way that is hardest to notice: the broadcast works,
    /// and it goes out under the other person's identity.
    @discardableResult
    func duplicate(_ id: UUID) -> DestinationProfile? {
        guard let original = profiles.first(where: { $0.id == id }) else { return nil }

        let copy = DestinationProfile(
            name: uniqueName(basedOn: original.name),
            transport: original.transport,
            host: original.host,
            port: original.port
        )

        profiles.append(copy)
        persistProfiles()
        return copy
    }

    func remove(_ id: UUID) {
        profiles.removeAll { $0.id == id }
        Keychain.remove(keychainAccount(id))
        persistProfiles()

        if selectedId == id { select(profiles.first?.id) }
    }

    func setSecret(_ key: String?, for id: UUID) {
        guard let key, !key.isEmpty else {
            Keychain.remove(keychainAccount(id))
            objectWillChange.send()
            return
        }
        store(key: key, for: id)
        objectWillChange.send()
    }

    /// Delete every destination and every stored key.
    ///
    /// Surfaced in Settings because an app that holds credentials the user
    /// cannot see or delete cannot make an honest privacy disclosure.
    func eraseAll() {
        profiles.removeAll()
        Keychain.removeAll()
        defaults.removeObject(forKey: Key.profiles)
        defaults.removeObject(forKey: Key.selected)
        selectedId = nil
    }

    // MARK: - Persistence

    private func keychainAccount(_ id: UUID) -> String { "destination.\(id.uuidString)" }

    private func store(key: String, for id: UUID) {
        do {
            try Keychain.set(key, for: keychainAccount(id))
        } catch {
            // Non-fatal by design: the destination is still usable for this
            // launch, it just will not be remembered. Saying nothing would be
            // worse — the operator would find the key gone tomorrow morning.
            log.error("could not store stream key: \(error.localizedDescription, privacy: .public)")
            keychainFailure = error.localizedDescription
        }
    }

    /// Set when the Keychain refuses a write, so Settings can say so. Cleared
    /// by the view once it has been shown.
    @Published var keychainFailure: String?

    private func load() {
        if let data = defaults.data(forKey: Key.profiles),
           let decoded = try? JSONDecoder().decode([DestinationProfile].self, from: data) {
            profiles = decoded
        }

        if let raw = defaults.string(forKey: Key.selected), let id = UUID(uuidString: raw),
           profiles.contains(where: { $0.id == id }) {
            selectedId = id
        } else {
            selectedId = profiles.first?.id
        }
    }

    private func persistProfiles() {
        guard let data = try? JSONEncoder().encode(profiles) else { return }
        defaults.set(data, forKey: Key.profiles)
    }

    private func uniqueName(basedOn name: String) -> String {
        let base = "\(name) copy"
        guard profiles.contains(where: { $0.name == base }) else { return base }

        var index = 2
        while profiles.contains(where: { $0.name == "\(base) \(index)" }) { index += 1 }
        return "\(base) \(index)"
    }

    // MARK: - Migration

    /// Move the single pre-profiles destination into the list, and get its
    /// stream key out of `UserDefaults`.
    ///
    /// The key removal is the part that matters and it is unconditional: even
    /// if there is no host to build a profile from, a key left behind in the
    /// defaults plist is a credential sitting in the clear. It is copied into
    /// the Keychain first where there is somewhere to put it, and deleted
    /// either way.
    private func migrateLegacySettingsIfNeeded() {
        defer {
            defaults.removeObject(forKey: Key.legacyStreamKey)
            defaults.removeObject(forKey: Key.legacyHost)
            defaults.removeObject(forKey: Key.legacyPort)
        }

        let legacyKey = defaults.string(forKey: Key.legacyStreamKey)

        guard profiles.isEmpty else { return }

        let host = (defaults.string(forKey: Key.legacyHost) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return }

        let port = defaults.object(forKey: Key.legacyPort) as? Int
            ?? DestinationProfile.Transport.avrLive.defaultPort

        // A previously working configuration is trusted enough to migrate even
        // if it would not pass validation today; refusing it would present the
        // operator with an empty list and no explanation. It is validated
        // again before every connection.
        let name = (defaults.string(forKey: Key.legacyName) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = DestinationProfile(
            name: name.isEmpty ? host : String(name.prefix(DestinationLimits.nameMaxLength)),
            transport: .avrLive,
            host: host,
            port: port
        )

        profiles = [profile]
        if let legacyKey, !legacyKey.isEmpty { store(key: legacyKey, for: profile.id) }
        persistProfiles()
        select(profile.id)

        log.notice("migrated legacy destination \(profile.endpointLabel, privacy: .public) into the profile store")
    }
}
