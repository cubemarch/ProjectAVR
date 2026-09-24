import Foundation
import Network
import os

/// Finds the AVR server on the local network.
///
/// A UDP broadcast probe rather than Bonjour, and rather than SSDP. Bonjour
/// would be the idiomatic choice, but the server this talks to already runs an
/// SSDP responder for DLNA and adding a second discovery stack to it is more
/// moving parts than the problem needs. SSDP itself is not an option because
/// UDP 1900 is single-owner and DLNA has it. So: a dedicated port, a fixed
/// probe string, and a JSON reply.
///
/// Discovery deliberately does **not** hand out the stream key. It tells the
/// phone that a door exists; the pairing screen in the creator portal is what
/// gives out the key. Anything else would mean any device on the Wi-Fi could
/// start broadcasting to the server by asking it nicely.
final class Discovery {
    /// Matches `PROBE` in `server/live/discovery.js`.
    private static let probe = "AVR-DISCOVER/1"
    private static let defaultPort: UInt16 = 8082

    private let log = Logger(subsystem: "com.projectavr.capture", category: "discovery")
    private let queue = DispatchQueue(label: "com.projectavr.capture.discovery")

    private var connection: NWConnection?
    private var found: [String: DestinationImport.Candidate] = [:]

    /// Called on the main queue as servers answer.
    ///
    /// Candidates, not saved destinations. A UDP reply is an unauthenticated
    /// datagram from anything on the Wi-Fi that felt like answering, so it gets
    /// exactly the same treatment as a link somebody sent: parsed, validated,
    /// shown, and written only when the operator picks it.
    var onResults: (([DestinationImport.Candidate]) -> Void)?

    /// Broadcast a probe and collect replies for a few seconds.
    ///
    /// - Parameter port: Matches `AVR_LIVE_DISCOVERY_PORT` on the server.
    func search(port: UInt16 = Discovery.defaultPort, duration: TimeInterval = 3) {
        queue.async { [weak self] in
            guard let self else { return }

            self.cancel()
            self.found.removeAll()

            guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }

            let parameters = NWParameters.udp
            parameters.prohibitedInterfaceTypes = [.cellular]

            // 255.255.255.255 reaches every host on the link regardless of
            // subnet mask, which matters because the phone has no reliable way
            // to learn the LAN's broadcast address from inside the sandbox.
            let connection = NWConnection(
                host: "255.255.255.255",
                port: nwPort,
                using: parameters
            )

            self.connection = connection

            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }

                switch state {
                case .ready:
                    connection.send(
                        content: Data(Self.probe.utf8),
                        completion: .contentProcessed { _ in }
                    )
                    self.receive()

                case let .failed(error):
                    // The most likely cause by far is the local network
                    // permission prompt not having been accepted yet.
                    self.log.notice("discovery failed: \(error.localizedDescription, privacy: .public)")

                default:
                    break
                }
            }

            connection.start(queue: self.queue)

            self.queue.asyncAfter(deadline: .now() + duration) { [weak self] in
                self?.cancel()
            }
        }
    }

    func cancel() {
        connection?.cancel()
        connection = nil
    }

    private func receive() {
        connection?.receiveMessage { [weak self] data, _, _, _ in
            guard let self else { return }

            if let data, let candidate = self.parse(data) {
                self.found[candidate.endpointLabel] = candidate
                let results = self.found.values.sorted { $0.name < $1.name }
                DispatchQueue.main.async { self.onResults?(results) }
            }

            // Several servers may answer, so keep listening until the search
            // window closes rather than stopping at the first reply.
            if self.connection != nil { self.receive() }
        }
    }

    /// Turn one reply into a validated candidate, or discard it.
    ///
    /// The reply is a datagram from an unauthenticated stranger, so its fields
    /// go through exactly the validation a pasted link would get. A malformed
    /// or hostile reply is dropped silently: there is no operator action that
    /// would fix somebody else's broken responder, and a discovery list that
    /// raises errors about other people's devices is noise.
    private func parse(_ data: Data) -> DestinationImport.Candidate? {
        guard
            data.count <= 4 * 1024,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let host = object["host"] as? String,
            let ingestPort = object["ingestPort"] as? Int
        else {
            return nil
        }

        return try? DestinationImport.discovered(
            name: object["name"] as? String,
            host: host,
            port: ingestPort
        )
    }
}
