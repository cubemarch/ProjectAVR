import Foundation
import Network
import os

/// The uplink to the relay.
///
/// A plain TCP socket carrying the framing in ``Wire``, rather than RTMP. RTMP
/// carries one video track, so a stereo broadcast over it means either two
/// connections that drift apart or packing both eyes into one frame before
/// encoding. Two sibling tracks on a single socket keeps the eyes on one
/// congestion window and one ordering guarantee, which is what makes matching
/// them by timestamp work at the far end.
///
/// The interesting part of this class is what it does when the link is too
/// slow, which on Wi-Fi it eventually will be. TCP will happily buffer: frames
/// keep being accepted, nothing errors, and latency climbs without bound until
/// the broadcast is minutes behind reality. So the client tracks its own
/// in-flight bytes and drops frames rather than queue them. A live stream that
/// skips is still live; a live stream that lags is just a slow recording.
final class IngestClient {
    enum State: Equatable {
        case idle
        case connecting
        case handshaking
        case live

        /// Something went wrong that might not go wrong again — a dropped
        /// link, a timeout, a server that has not come up yet.
        case failed(String)

        /// The server refused the connection for a reason that will still be
        /// true on the next attempt.
        ///
        /// Separate from ``failed`` because the two want opposite handling and
        /// the difference is invisible from the text. A rejected stream key is
        /// rejected because it is wrong, expired or already spent, and none of
        /// those heals on its own, so a phone that reconnects after being told its
        /// credential was refused spends the whole backoff ladder — six
        /// attempts, about a minute — being told the same thing,
        /// while the operator watches a spinner that was never going to
        /// resolve and the shot stays off air. Stopping immediately and saying
        /// what to do about it is the shorter route back on air.
        case rejected(String)

        var isConnected: Bool {
            self == .live || self == .handshaking
        }
    }

    struct Stats {
        var bytesSent: UInt64 = 0
        var framesSent: UInt64 = 0
        var framesDropped: UInt64 = 0
        var inFlightBytes: Int = 0
        var roundTripMilliseconds: Double?
    }

    /// Above this many unacknowledged bytes, non-keyframes are dropped.
    ///
    /// Roughly a quarter second of 1080p stereo. Small enough that the
    /// backlog cannot become a perceptible delay, large enough to absorb the
    /// burst a keyframe produces.
    private static let softLimitBytes = 512 * 1024

    /// Above this, everything is dropped until the socket drains. Reaching it
    /// means the link cannot carry the stream at all and the bitrate needs to
    /// come down.
    private static let hardLimitBytes = 2 * 1024 * 1024

    private static let helloTimeout: TimeInterval = 8

    /// Called on `queue`.
    var onState: ((State) -> Void)?
    var onSessionId: ((String) -> Void)?

    /// One packet of return audio from the destination.
    ///
    /// Only called while ``acceptsReturnAudio`` is true, which the controller
    /// sets from the operator's setting. With it false these frames are read
    /// off the socket and discarded without ever reaching an audio device —
    /// there is nowhere for them to go, and nothing to turn on.
    var onReturnAudio: ((Data) -> Void)?

    /// Whether return audio is wanted at all. Off unless the operator says so.
    var acceptsReturnAudio: Bool {
        get { queue.sync { _acceptsReturnAudio } }
        set { queue.async { self._acceptsReturnAudio = newValue } }
    }

    private let log = Logger(subsystem: "com.projectavr.capture", category: "ingest")
    private let queue = DispatchQueue(label: "com.projectavr.capture.ingest")

    private var connection: NWConnection?
    private var reader = Wire.FrameReader()
    private var handshakeTimer: DispatchSourceTimer?

    private var state: State = .idle {
        didSet {
            guard state != oldValue else { return }
            let state = state
            onState?(state)
        }
    }

    private var sequences: [UInt8: UInt32] = [:]
    private var inFlightBytes = 0
    private var stats = Stats()
    private var _acceptsReturnAudio = false

    /// Cleared by a CONFIG announcing a return-audio format this app cannot
    /// play, and restored by one it can. Starts true because a server that
    /// sends the audio without describing it is sending the only format the
    /// protocol defines.
    private var returnAudioFormatUnderstood = true

    /// Most recent config per track, replayed on the transition to `.live`.
    private var lastConfig: [Wire.Track: [String: Any]] = [:]

    /// Set after a drop so the next frame on that track tells the receiver its
    /// stream has a hole in it, rather than letting the decoder discover it.
    private var discontinuous: Set<UInt8> = []

    // MARK: - Lifecycle

    /// - Parameter allowsCellular: Whether the connection may leave over the
    ///   carrier. Decided by the destination's address rather than by a
    ///   preference: a private or link-local address is not routable over
    ///   cellular, so permitting it there only widens the attack surface for no
    ///   gain, while forbidding it for a public host — which is what this
    ///   client used to do unconditionally — makes remote broadcasting
    ///   impossible and presents as "could not reach that address" on a phone
    ///   with a perfectly good connection.
    /// - Parameter security: Whether to wrap the socket in TLS, and against
    ///   what. Defaults to cleartext for the benefit of tests that stand up a
    ///   plain listener; every shipping call site derives it from the
    ///   destination. See ``TransportSecurity``.
    func connect(
        host: String,
        port: UInt16,
        allowsCellular: Bool,
        security: TransportSecurity = .cleartext,
        hello: [String: Any]
    ) {
        queue.async { [weak self] in
            guard let self else { return }

            self.disconnectLocked(sendBye: false)

            guard let nwPort = NWEndpoint.Port(rawValue: port) else {
                self.state = .failed("Port \(port) is not valid.")
                return
            }

            let parameters = security.parameters()

            // Nagle batches small writes to save packets. For video that trade
            // is backwards: it delays the tail of every frame to save a header.
            if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
                tcp.noDelay = true
                tcp.connectionTimeout = 8
                tcp.enableKeepalive = true
                tcp.keepaliveIdle = 5
            }

            if !allowsCellular {
                parameters.prohibitedInterfaceTypes = [.cellular]
            }

            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: nwPort,
                using: parameters
            )

            self.connection = connection
            self.reader.reset()
            self.sequences.removeAll()
            self.returnAudioFormatUnderstood = true
            self.inFlightBytes = 0
            self.stats = Stats()
            self.state = .connecting

            connection.stateUpdateHandler = { [weak self] nwState in
                self?.handle(nwState, hello: hello)
            }

            connection.start(queue: self.queue)
        }
    }

    func disconnect() {
        queue.async { [weak self] in
            self?.disconnectLocked(sendBye: true)
        }
    }

    private func disconnectLocked(sendBye: Bool) {
        handshakeTimer?.cancel()
        handshakeTimer = nil

        if sendBye, let connection, state == .live {
            // Best effort. The relay ends the session on socket close anyway;
            // BYE is what lets it distinguish "broadcast finished" from
            // "phone fell off the network", which the monitor shows
            // differently.
            connection.send(
                content: Wire.frame(type: .bye),
                completion: .contentProcessed { _ in connection.cancel() }
            )
        } else {
            connection?.cancel()
        }

        connection = nil
        // A new session gets a freshly built encoder, so the next config is the
        // one that matters; replaying a previous run's would describe a decoder
        // that no longer exists.
        lastConfig.removeAll()
        state = .idle
    }

    private func handle(_ nwState: NWConnection.State, hello: [String: Any]) {
        switch nwState {
        case .ready:
            state = .handshaking
            sendHello(hello)
            receiveLoop()
            startHandshakeTimeout()

        case let .waiting(error):
            // Waiting means retryable — usually the server is not up yet.
            log.notice("ingest waiting: \(error.localizedDescription, privacy: .public)")
            state = .failed(Self.describe(error))

        case let .failed(error):
            log.error("ingest failed: \(error.localizedDescription, privacy: .public)")
            state = .failed(Self.describe(error))
            connection?.cancel()
            connection = nil

        case .cancelled:
            if state != .idle { state = .idle }

        default:
            break
        }
    }

    private static func describe(_ error: NWError) -> String {
        switch error {
        case .posix(.ECONNREFUSED):
            return "Nothing is listening on that port. Is the AVR server running?"
        case .posix(.EHOSTUNREACH), .posix(.ENETUNREACH), .posix(.ETIMEDOUT):
            return "Could not reach that address. Check both devices are on the same Wi-Fi."
        case .posix(.EPERM):
            return "Local network access is denied. Enable it for AVR Capture in Settings › Privacy."
        case let .tls(status):
            return describeTLS(status)
        default:
            return error.localizedDescription
        }
    }

    /// TLS failures all surface as `.tls(OSStatus)`, and the default
    /// description for those is a bare number. The distinction worth drawing is
    /// between "this destination's certificate changed" — which the operator
    /// fixes by pairing again — and "the server is not speaking TLS at all",
    /// which they fix in the destination editor. Everything else is one
    /// message, because a broadcaster three minutes from going live cannot act
    /// on the difference between a bad chain and an expired leaf.
    private static func describeTLS(_ status: OSStatus) -> String {
        switch status {
        case errSSLBadCert, errSSLPeerBadCert, errSSLXCertChainInvalid,
             errSSLUnknownRootCert, errSSLNoRootCert, errSSLCertExpired,
             errSSLCertNotYetValid, errSSLHostNameMismatch:
            return "The server's certificate is not the one this destination expects. "
                + "If the server was reinstalled, get a new destination link and import it again."
        case errSSLPeerProtocolVersion, errSSLProtocol, errSSLClosedAbort, errSSLPeerHandshakeFail:
            return "The server refused an encrypted connection. Check that this destination should be using TLS."
        default:
            return "The secure connection failed (TLS error \(status))."
        }
    }

    private func startHandshakeTimeout() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.helloTimeout)
        timer.setEventHandler { [weak self] in
            guard let self, self.state == .handshaking else { return }
            self.state = .failed("The server accepted the connection but never replied. Check the stream key.")
            self.disconnectLocked(sendBye: false)
        }
        timer.resume()
        handshakeTimer = timer
    }

    // MARK: - Sending

    private func sendHello(_ hello: [String: Any]) {
        send(Wire.jsonFrame(type: .hello, body: hello), counted: false)
    }

    /// Announce a track's codec before any of its frames.
    ///
    /// Sent every time the encoder produces a new format description, not just
    /// once. The relay caches the most recent one per track and replays it to
    /// anyone who joins later, so resending is how a viewer who arrives after a
    /// resolution change gets the right decoder.
    func sendConfig(track: Wire.Track, body: [String: Any]) {
        queue.async { [weak self] in
            guard let self else { return }

            // Latched, not just forwarded. A config is the only thing a decoder
            // cannot be handed late — and `VideoEncoder` emits one per format
            // description, which in practice means once, on the first frame. If
            // that single message lands while the socket is still handshaking,
            // dropping it strands the whole broadcast: video keeps arriving and
            // the viewer keeps showing black. Holding the last one per track
            // lets `flushConfigs()` replay it the moment the session is live.
            self.lastConfig[track] = body

            guard self.state == .live else { return }
            self.send(Wire.jsonFrame(type: .config, track: track, body: body), counted: false)
        }
    }

    /// Replay every latched config. Called on the transition to `.live`.
    private func flushConfigs() {
        for (track, body) in lastConfig {
            send(Wire.jsonFrame(type: .config, track: track, body: body), counted: false)
        }
    }

    /// Queue one encoded frame.
    ///
    /// - Returns: `false` if the frame was dropped for backpressure. The caller
    ///   uses this to decide whether to lower the bitrate.
    @discardableResult
    func sendVideo(
        track: Wire.Track,
        data: Data,
        timestampMicroseconds: UInt64,
        isKeyframe: Bool
    ) -> Bool {
        var accepted = false

        queue.sync {
            guard state == .live, connection != nil else { return }

            let limit = isKeyframe ? Self.hardLimitBytes : Self.softLimitBytes

            if inFlightBytes > limit {
                stats.framesDropped += 1
                discontinuous.insert(track.rawValue)
                return
            }

            var flags: Wire.Flags = isKeyframe ? [.keyframe] : []

            if discontinuous.remove(track.rawValue) != nil {
                flags.insert(.discontinuity)
            }

            let sequence = sequences[track.rawValue, default: 0]
            sequences[track.rawValue] = sequence &+ 1

            let frame = Wire.frame(
                type: .video,
                track: track,
                flags: flags,
                timestamp: timestampMicroseconds,
                sequence: sequence,
                payload: data
            )

            send(frame, counted: true)
            stats.framesSent += 1
            accepted = true
        }

        return accepted
    }

    /// Queue one encoded audio access unit.
    ///
    /// Separate from ``sendVideo(track:data:timestampMicroseconds:isKeyframe:)``
    /// for one reason: audio is never dropped for backpressure. An AAC packet
    /// is about a hundredth the size of a video frame, so dropping one buys
    /// nothing measurable off a congested link, and a gap in sound is much more
    /// noticeable than a dropped frame. The link recovers by shedding video.
    ///
    /// Every packet is flagged as a keyframe, which for AAC is simply true:
    /// each access unit decodes on its own with no reference to any other, so
    /// every one of them is a point a listener can join at. Saying so is what
    /// stops the relay's late-joiner gate and its keyframes-only backpressure
    /// mode — both of which exist for video's benefit — from holding audio back
    /// waiting for a sync point that would never arrive.
    func sendAudio(data: Data, timestampMicroseconds: UInt64, discontinuity: Bool) {
        queue.async { [weak self] in
            guard let self, self.state == .live, self.connection != nil else { return }

            var flags: Wire.Flags = [.keyframe]

            if discontinuity || self.discontinuous.remove(Wire.Track.audio.rawValue) != nil {
                flags.insert(.discontinuity)
            }

            let sequence = self.sequences[Wire.Track.audio.rawValue, default: 0]
            self.sequences[Wire.Track.audio.rawValue] = sequence &+ 1

            self.send(
                Wire.frame(
                    type: .audio,
                    track: .audio,
                    flags: flags,
                    timestamp: timestampMicroseconds,
                    sequence: sequence,
                    payload: data
                ),
                counted: true
            )
        }
    }

    private func send(_ data: Data, counted: Bool) {
        guard let connection else { return }

        let count = data.count
        if counted { inFlightBytes += count }

        connection.send(
            content: data,
            completion: .contentProcessed { [weak self] error in
                guard let self else { return }

                if counted {
                    self.inFlightBytes = max(0, self.inFlightBytes - count)
                    self.stats.bytesSent += UInt64(count)
                }

                if let error {
                    self.log.error("send failed: \(error.localizedDescription, privacy: .public)")
                    self.state = .failed(Self.describe(error))
                    self.disconnectLocked(sendBye: false)
                }
            }
        )
    }

    // MARK: - Receiving

    private func receiveLoop() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in

            guard let self else { return }

            if let data, !data.isEmpty {
                for frame in self.reader.push(data) {
                    self.handle(frame)
                }
            }

            if isComplete {
                // The relay closed cleanly. If this happens before READY the
                // key was wrong, which is worth saying plainly.
                if self.state == .handshaking {
                    self.state = .failed("The server closed the connection. The stream key is probably wrong.")
                } else {
                    self.state = .idle
                }
                self.disconnectLocked(sendBye: false)
                return
            }

            if let error {
                self.state = .failed(Self.describe(error))
                self.disconnectLocked(sendBye: false)
                return
            }

            self.receiveLoop()
        }
    }

    private func handle(_ frame: Wire.IncomingFrame) {
        switch frame.type {
        case .ready:
            handshakeTimer?.cancel()
            handshakeTimer = nil
            state = .live
            flushConfigs()

            if let id = frame.json?["sessionId"] as? String {
                onSessionId?(id)
            }

        case .ping:
            send(Wire.frame(type: .pong, timestamp: frame.timestamp), counted: false)

        case .audio:
            // The only inbound media there is: return audio from the
            // destination, on its own track. Anything else claiming to be audio
            // on the downlink is ignored rather than guessed at.
            guard frame.track == Wire.Track.talkback.rawValue else { return }
            guard _acceptsReturnAudio, returnAudioFormatUnderstood else { return }

            onReturnAudio?(frame.payload)

        case .config:
            // The server describes the return audio format before sending any.
            // There is nothing to negotiate — the format is fixed by the
            // protocol — so the only thing this can do is *stop* playback, for
            // a server that announces something this app would otherwise
            // misinterpret as PCM and play as noise.
            guard frame.track == Wire.Track.talkback.rawValue else { return }

            let codec = frame.json?["codec"] as? String
            let rate = frame.json?["sampleRate"] as? Double
            let channels = frame.json?["numberOfChannels"] as? Int

            returnAudioFormatUnderstood =
                codec == "pcm-s16le"
                && rate == Wire.ReturnAudio.sampleRate
                && channels == Int(Wire.ReturnAudio.channels)

            if !returnAudioFormatUnderstood {
                log.notice(
                    "ignoring return audio announced as \(codec ?? "unspecified", privacy: .public)"
                )
            }

        case .bye:
            // `reason` and `error` both, because the relay's session-close BYE
            // uses one key and the ingest listener's rejection BYE uses the
            // other. Reading only `reason` meant every rejection arrived as the
            // generic fallback with the server's actual explanation discarded.
            let reason = (frame.json?["reason"] ?? frame.json?["error"]) as? String

            switch frame.json?["code"] as? String {
            case "credential_rejected":
                // Deliberately not repeating the server's wording, which names
                // whichever kind of credential that particular server wanted —
                // none of which tells an operator standing in front of a camera
                // what to do next.
                state = .rejected(
                    "The server did not accept this destination's stream key. Check that it was entered "
                        + "whole, and that it has not expired — some servers issue keys that are only good "
                        + "for a short time."
                )
            case "protocol_rejected":
                state = .rejected(
                    reason.map { "The server refused this connection: \($0)." }
                        ?? "The server does not speak this version of the protocol. Update the app or the server."
                )
            default:
                state = .failed(reason ?? "The server ended the session.")
            }

            disconnectLocked(sendBye: false)

        default:
            break
        }
    }

    // MARK: - Statistics

    /// A snapshot for the UI. Synchronous because it is read once a second from
    /// a timer, not per frame.
    func snapshot() -> Stats {
        queue.sync {
            var current = stats
            current.inFlightBytes = inFlightBytes
            return current
        }
    }
}
