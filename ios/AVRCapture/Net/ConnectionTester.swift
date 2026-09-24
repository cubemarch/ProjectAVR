import Foundation
import Network
import os

/// "Test Connection" for a destination.
///
/// Reachability and, where the destination asks for TLS, the certificate: the
/// host is resolved, a connection is opened, the handshake is completed, and
/// the socket is closed. It deliberately does **not** send a HELLO and does not
/// check the stream key.
///
/// That is a decision rather than a shortcut. A stream key is a bearer
/// credential, and this button is pressed while editing a destination whose
/// address may have been mistyped — sending the key would mean handing it to
/// whatever answered at the address the operator got wrong. A server may also
/// count or rate-limit authentication attempts, and a test that consumes one is
/// a test that changes what it measures. Meanwhile the failures this button
/// actually gets pressed for — wrong address, server not running, wrong
/// port, local-network permission declined, phone on the wrong Wi-Fi — are all
/// visible from a socket that either opens or does not. A bad key already
/// produces a clear message on the first real connection.
///
/// The handshake is worth completing for the same reason the HELLO is not: it
/// costs nothing. A pin that no longer matches the server's certificate is a
/// setup-time problem that would otherwise surface as a failed broadcast, and
/// finding out about it needs no credential.
enum ConnectionTester {
    enum Result: Equatable {
        case reachable(milliseconds: Int, secure: Bool)
        case refused
        case unreachable(String)
        case timedOut
        case localNetworkDenied
        case certificateMismatch
        case encryptionRefused
        case tlsFailed(OSStatus)

        var isSuccess: Bool {
            if case .reachable = self { return true }
            return false
        }

        var message: String {
            switch self {
            case let .reachable(ms, secure):
                return secure
                    ? "Connected and the certificate matched, in \(ms) ms."
                    : "Something is listening. Connected in \(ms) ms."
            case .refused:
                return "Reached the address, but nothing is listening on that port. Is the server running?"
            case let .unreachable(detail):
                return detail
            case .timedOut:
                return "No answer within five seconds. Check the address and that both devices are on the same network."
            case .localNetworkDenied:
                return "Local network access is off for this app. Turn it on in Settings › Privacy & Security › Local Network."
            case .certificateMismatch:
                return "Reached the server, but its certificate is not the one this destination expects. "
                    + "If the server was reinstalled, get a new destination link and import it again."
            case .encryptionRefused:
                return "Reached the server, but it refused an encrypted connection. "
                    + "Check whether this destination should be using TLS."
            case let .tlsFailed(status):
                return "Reached the server, but the secure connection failed (TLS error \(status))."
            }
        }
    }

    private static let timeout: TimeInterval = 5

    static func test(
        host: String,
        port: Int,
        allowsCellular: Bool,
        security: TransportSecurity = .cleartext
    ) async -> Result {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)), port > 0 else {
            return .unreachable("Port \(port) is not valid.")
        }

        let parameters = security.parameters()
        if !allowsCellular { parameters.prohibitedInterfaceTypes = [.cellular] }
        if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.connectionTimeout = Int(timeout)
        }

        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: parameters)
        let queue = DispatchQueue(label: "com.projectavr.capture.probe")
        let startedAt = Date()

        // `withCheckedContinuation` plus a hand-rolled one-shot guard, because
        // `stateUpdateHandler` can fire more than once — `.waiting` then
        // `.failed`, say — and resuming a continuation twice is a crash, not a
        // warning.
        let result: Result = await withCheckedContinuation { continuation in
            let finished = OSAllocatedUnfairLock(initialState: false)

            @Sendable func finish(_ value: Result) {
                let alreadyFinished = finished.withLock { done -> Bool in
                    if done { return true }
                    done = true
                    return false
                }
                guard !alreadyFinished else { return }

                connection.cancel()
                continuation.resume(returning: value)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    // With TLS in the stack, `.ready` is after the handshake,
                    // so reaching here means the certificate was accepted —
                    // by the pin if there is one, by the trust store if not.
                    let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                    finish(.reachable(milliseconds: elapsed, secure: security.isEncrypted))

                case let .failed(error):
                    finish(classify(error))

                case let .waiting(error):
                    // `.waiting` means the stack will retry — but for a probe
                    // there is nothing to wait for. A refused connection or a
                    // denied permission arrives here rather than in `.failed`.
                    finish(classify(error))

                default:
                    break
                }
            }

            connection.start(queue: queue)

            queue.asyncAfter(deadline: .now() + timeout) { finish(.timedOut) }
        }

        return result
    }

    private static func classify(_ error: NWError) -> Result {
        switch error {
        case .posix(.ECONNREFUSED):
            return .refused
        case .posix(.EPERM):
            return .localNetworkDenied
        case .posix(.EHOSTUNREACH), .posix(.ENETUNREACH):
            return .unreachable("Could not reach that address. Check both devices are on the same network.")
        case .posix(.ETIMEDOUT):
            return .timedOut
        case .dns:
            return .unreachable("That host name could not be resolved.")
        case let .tls(status):
            return classifyTLS(status)
        default:
            return .unreachable(error.localizedDescription)
        }
    }

    private static func classifyTLS(_ status: OSStatus) -> Result {
        switch status {
        case errSSLBadCert, errSSLPeerBadCert, errSSLXCertChainInvalid,
             errSSLUnknownRootCert, errSSLNoRootCert, errSSLCertExpired,
             errSSLCertNotYetValid, errSSLHostNameMismatch:
            return .certificateMismatch
        case errSSLPeerProtocolVersion, errSSLProtocol, errSSLClosedAbort, errSSLPeerHandshakeFail:
            return .encryptionRefused
        default:
            return .tlsFailed(status)
        }
    }
}
