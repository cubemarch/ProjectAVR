import AVFoundation
import Foundation
import os

/// Return audio from the destination, played to the operator.
///
/// The standing broadcast feature usually called talkback or IFB: whoever is at
/// the receiving end of the contribution feed can speak to the person holding
/// the camera. It is one-way into this app — nothing from the microphone is
/// ever sent along this path, and the app has no idea who is speaking, only
/// that the server it was configured to broadcast to sent return audio.
///
/// Three things make it safe to have in a capture app:
///
///   **It is off unless the operator turned it on.** No audio session is
///   changed and no output is opened until then, so an app with the setting off
///   behaves exactly as it did before this file existed.
///
///   **It plays nothing but linear PCM at one known rate.** There is no decoder
///   on this path and nothing to configure, so a hostile server has the same
///   attack surface as a `memcpy`.
///
///   **The queue is bounded.** See ``ReturnAudioBuffer``.
///
/// - Note: without headphones the microphone will pick this up and send it back
///   out in the broadcast. The UI says so; there is no echo canceller here,
///   because the only way to get one on iOS is to put the *capture* path
///   through voice processing, which would degrade the sound of every broadcast
///   for the benefit of the one that has talkback running.
final class ReturnAudioPlayer {
    enum State: Equatable {
        case stopped
        /// Running, with nothing arriving. The ordinary state between someone
        /// speaking and someone speaking again.
        case waiting
        case playing
        case failed(String)
    }

    /// Called on an internal queue.
    var onState: ((State) -> Void)?

    private let log = Logger(subsystem: "com.projectavr.capture", category: "return-audio")
    private let queue = DispatchQueue(label: "com.projectavr.capture.return-audio")

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()

    /// The one format on this path. Mono 16-bit at 16 kHz, and nothing else is
    /// ever accepted, so there is no negotiation to get wrong.
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Wire.ReturnAudio.sampleRate,
        channels: AVAudioChannelCount(Wire.ReturnAudio.channels),
        interleaved: true
    )!

    private var buffer = ReturnAudioBuffer()
    private var running = false
    private var lastPacketAt: Date?

    private var state: State = .stopped {
        didSet {
            guard state != oldValue else { return }
            onState?(state)
        }
    }

    // MARK: - Lifecycle

    /// Open the output.
    ///
    /// Called when a broadcast goes live and the operator has return audio
    /// switched on, not at launch.
    func start() {
        queue.async { [weak self] in
            guard let self, !self.running else { return }

            do {
                try self.activateSession()

                self.engine.attach(self.player)
                // Straight to the main mixer. The engine inserts whatever
                // conversion the current output route needs, which is the one
                // piece of resampling in this app that is somebody else's
                // problem to get right.
                self.engine.connect(self.player, to: self.engine.mainMixerNode, format: self.format)

                try self.engine.start()
                self.player.play()

                self.running = true
                self.buffer.flush()
                self.state = .waiting
            } catch {
                self.log.error("return audio failed to start: \(error.localizedDescription, privacy: .public)")
                self.state = .failed("Return audio could not be started: \(error.localizedDescription)")
                self.teardown()
            }
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.teardown()
            self.state = .stopped
        }
    }

    private func teardown() {
        if running {
            player.stop()
            engine.stop()
            engine.detach(player)
        }

        running = false
        buffer.flush()
        lastPacketAt = nil
    }

    /// Put the audio session into a category that can play as well as record.
    ///
    /// The capture session is already recording; this adds playback to it
    /// without touching the input side, so the broadcast's own sound is
    /// unaffected. `.defaultToSpeaker` only decides where the *output* goes when
    /// there is no better route — a wired or Bluetooth headset, which is what
    /// this feature really wants, still wins over it.
    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()

        try session.setCategory(
            .playAndRecord,
            mode: .videoRecording,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try session.setActive(true)
    }

    // MARK: - Playback

    /// Play one packet of return audio.
    ///
    /// Called from the ingest client's queue, deliberately without a hop to the
    /// main actor: this runs twenty-five times a second, and the main thread is
    /// drawing a viewfinder.
    func enqueue(_ pcm: Data) {
        queue.async { [weak self] in
            guard let self, self.running else { return }

            switch self.buffer.admit(packetBytes: pcm.count) {
            case let .reject(reason):
                // Logged at debug: a broken sender would otherwise fill the
                // operator's log with one line per packet.
                self.log.debug("return audio packet rejected: \(String(describing: reason), privacy: .public)")
                return

            case .dropStale:
                return

            case .play:
                break
            }

            let frames = AVAudioFrameCount(pcm.count / Wire.ReturnAudio.bytesPerSample)

            guard
                let pcmBuffer = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: frames),
                let channel = pcmBuffer.int16ChannelData
            else {
                self.buffer.finished()
                return
            }

            pcmBuffer.frameLength = frames
            pcm.withUnsafeBytes { raw in
                channel[0].update(
                    from: raw.bindMemory(to: Int16.self).baseAddress!,
                    count: Int(frames)
                )
            }

            self.lastPacketAt = Date()
            self.state = .playing

            self.player.scheduleBuffer(pcmBuffer) { [weak self] in
                guard let self else { return }
                self.queue.async {
                    self.buffer.finished()

                    // Back to waiting once the queue has run dry, so the
                    // indicator reflects silence rather than staying lit for
                    // the rest of the broadcast.
                    if self.buffer.queued == 0, self.running { self.state = .waiting }
                }
            }
        }
    }

    // MARK: - Diagnostics

    struct Stats {
        var packetsPlayed: UInt64 = 0
        var packetsDropped: UInt64 = 0
        var packetsRejected: UInt64 = 0
        var queuedMilliseconds = 0
        var isRunning = false
    }

    func snapshot() -> Stats {
        queue.sync {
            Stats(
                packetsPlayed: buffer.played,
                packetsDropped: buffer.dropped,
                packetsRejected: buffer.rejected,
                queuedMilliseconds: buffer.queuedMilliseconds,
                isRunning: running
            )
        }
    }
}
