import CryptoKit
import Foundation
import Network
import os
import Security

/// How the contribution socket is protected.
///
/// The ingest link carries a stream key in its first frame and then the
/// broadcast itself, so on anything but a studio LAN it has to be encrypted.
/// The awkward part is that most destinations are bare private addresses —
/// `192.168.1.110:8081` — and no certificate authority will ever issue for one.
/// So there are two trust models and the *address* decides which applies, the
/// same way it decides whether cellular is allowed:
///
///   - A public host validates against the system trust store. Ordinary TLS,
///     nothing special, get a real certificate.
///   - A private host presents a self-signed certificate and the pairing link
///     carries its pin. The pin then becomes the entire trust decision.
///
/// There is deliberately no third case for "encrypted but trust anything". An
/// unpinned self-signed certificate is indistinguishable from an attacker's
/// self-signed certificate, so accepting one would mean shipping a switch whose
/// only effect is to make interception undetectable while the UI says
/// "Encrypted". A destination is either verifiable or it is cleartext and
/// labelled as such.
enum TransportSecurity: Equatable {
    /// No TLS. Legitimate on a trusted LAN and nowhere else; the destination
    /// editor says so.
    case cleartext

    /// TLS. With a pin, that pin is the whole trust decision and the system
    /// trust store is not consulted. Without one, validation is the system's.
    case tls(pin: String?)

    /// The security a saved destination asks for.
    init(profile: DestinationProfile) {
        self = profile.usesTLS ? .tls(pin: profile.certificatePin) : .cleartext
    }

    var isEncrypted: Bool {
        if case .tls = self { return true }
        return false
    }

    // MARK: - Parameters

    private static let log = Logger(subsystem: "com.projectavr.capture", category: "tls")

    /// Handshake callbacks land here. Its own queue rather than the ingest
    /// queue: the verify block runs inside the handshake, and the ingest queue
    /// is where `connect` is already blocked waiting for it.
    private static let verifyQueue = DispatchQueue(label: "com.projectavr.capture.tls-verify")

    /// Network parameters for a connection with this security.
    ///
    /// The caller still sets `noDelay`, timeouts and interface restrictions on
    /// the returned stack — those are the same either way.
    func parameters() -> NWParameters {
        switch self {
        case .cleartext:
            return NWParameters.tcp
        case let .tls(pin):
            return NWParameters(tls: Self.tlsOptions(pin: pin), tcp: NWProtocolTCP.Options())
        }
    }

    private static func tlsOptions(pin: String?) -> NWProtocolTLS.Options {
        let options = NWProtocolTLS.Options()

        // 1.2 is the floor. Below it is a downgrade surface, not compatibility:
        // the server on the other end is one we ship.
        sec_protocol_options_set_min_tls_protocol_version(options.securityProtocolOptions, .TLSv12)

        guard let pin else { return options }

        guard let expected = Data(base64Encoded: pin), expected.count == 32 else {
            // A pin that cannot be decoded fails every connection rather than
            // falling through to system validation. The fall-through looks
            // harmless — a self-signed certificate would be rejected anyway —
            // but for a destination with a real hostname it would silently
            // demote "pinned" to "whatever the trust store says", which is the
            // one thing the operator asked it not to be.
            log.error("certificate pin is not 32 base64 bytes; refusing all certificates")
            sec_protocol_options_set_verify_block(
                options.securityProtocolOptions,
                { _, _, complete in complete(false) },
                verifyQueue
            )
            return options
        }

        sec_protocol_options_set_verify_block(
            options.securityProtocolOptions,
            { _, trust, complete in
                // Setting a verify block *replaces* the default evaluation, so
                // the chain is never walked and an expired or wrong-named
                // self-signed certificate is fine. That is the point: for a
                // certificate nothing will ever vouch for, identity is "it is
                // the exact certificate the pairing link named", and the
                // expiry and hostname fields of a self-signed certificate
                // carry no information a pin does not already carry.
                let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()

                guard let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate],
                      let leaf = chain.first
                else {
                    log.error("TLS peer offered no certificate")
                    complete(false)
                    return
                }

                let presented = Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data))
                let matches = constantTimeEquals(presented, expected)

                if !matches {
                    // The pin itself is not secret — it travels in the pairing
                    // link — but logging either value invites someone to read
                    // one out of a sysdiagnose and think it is the problem.
                    log.error("TLS certificate does not match the pinned certificate for this destination")
                }

                complete(matches)
            },
            verifyQueue
        )

        return options
    }

    /// Length-independent only because both sides are checked to be 32 bytes
    /// first. Comparing a hash early-exit is a weak oracle rather than a real
    /// one, but it costs four lines not to have it.
    private static func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var difference: UInt8 = 0
        for (a, b) in zip(lhs, rhs) { difference |= a ^ b }
        return difference == 0
    }
}
