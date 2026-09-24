import Foundation
import Security
import os

/// Where stream keys and publishing tokens live.
///
/// Not `UserDefaults`. A stream key is a bearer credential: anything holding it
/// can broadcast under the creator's name until it is rotated. `UserDefaults`
/// writes it to a plist inside the app container in the clear, where it is
/// readable by anything that can read the container — an unencrypted device
/// backup, a filesystem dump, a jailbroken device, or a future feature of this
/// app that logs its own defaults while debugging something unrelated.
///
/// Every item is stored `ThisDeviceOnly`, so it is excluded from iCloud Keychain
/// and from encrypted backups restored onto a different phone. A broadcast
/// credential synced to the operator's other devices is a credential in more
/// places than the operator knows about, and the cost of not syncing it is
/// retyping a key on a second phone — which is the correct trade for something
/// that authorises going on air.
enum Keychain {
    /// Shared by every item this app writes, so `removeAll()` can find them.
    private static let service = "com.projectavr.capture.secrets"

    private static let log = Logger(subsystem: "com.projectavr.capture", category: "keychain")

    enum KeychainError: LocalizedError {
        case unexpectedStatus(OSStatus)

        var errorDescription: String? {
            switch self {
            case let .unexpectedStatus(status):
                let detail = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
                return "Could not use the keychain: \(detail)"
            }
        }
    }

    /// Store, replacing any existing value for `account`.
    ///
    /// An empty string deletes instead of storing. A zero-length keychain item
    /// is legal and useless, and every caller that clears a field would
    /// otherwise have to remember to call `remove` rather than `set("")`.
    static func set(_ value: String, for account: String) throws {
        guard !value.isEmpty else {
            remove(account)
            return
        }

        // Delete-then-add rather than `SecItemUpdate`, because an update on a
        // missing item fails and an add on an existing one fails, so either
        // path alone needs the other as a fallback. This needs neither.
        remove(account)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),

            // The app only broadcasts in the foreground on an unlocked device,
            // so it never needs to read a key while locked. `WhenUnlocked` is
            // the tightest class that still works, and `ThisDeviceOnly` keeps
            // the item off iCloud Keychain and out of portable backups.
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    static func value(for account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        guard status == errSecSuccess else {
            // `errSecItemNotFound` is the ordinary answer for a destination
            // with no key yet, so it is not worth a log line.
            if status != errSecItemNotFound {
                log.error("keychain read failed: \(status, privacy: .public)")
            }
            return nil
        }

        guard let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
            return nil
        }

        return text
    }

    @discardableResult
    static func remove(_ account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess
    }

    /// Delete every secret this app owns.
    ///
    /// Scoped to `service`, so it cannot reach an item written by anything
    /// else. Used by "Erase stored data" in Settings, which exists because a
    /// user who cannot see what an app has kept cannot ask for it to be
    /// deleted.
    static func removeAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]

        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            log.error("keychain wipe failed: \(status, privacy: .public)")
        }
    }
}
