import Combine
import Foundation
import SwiftUI
import UIKit

private let defaults = UserDefaults.standard

private extension UserDefaults {
    /// `integer(forKey:)` reports 0 for a missing key, which is
    /// indistinguishable from a stored 0 and would silently turn an unset port
    /// into port 0. This distinguishes the two.
    func integer(forKey key: String, default fallback: Int) -> Int {
        object(forKey: key) == nil ? fallback : integer(forKey: key)
    }

    /// Same problem as above, and worse for a setting that defaults to on:
    /// `bool(forKey:)` reports `false` for a missing key, so a feature that is
    /// meant to be on out of the box would be off until it is toggled twice.
    func bool(forKey key: String, default fallback: Bool) -> Bool {
        object(forKey: key) == nil ? fallback : bool(forKey: key)
    }

    func double(forKey key: String, default fallback: Double) -> Double {
        object(forKey: key) == nil ? fallback : double(forKey: key)
    }
}

/// Everything the operator can change, persisted between launches.
///
/// Capture settings only. Destinations and their stream keys live in
/// ``DestinationStore``, which keeps the secrets in the Keychain — nothing in
/// this type is confidential, and it is written to the defaults plist in the
/// clear.
///
/// The one setting here that is not a preference is ``swapEyes``: it is a
/// per-device fact that has to be established by looking through a headset
/// once.
@MainActor
final class CaptureConfig: ObservableObject {
    enum Codec: String, CaseIterable, Identifiable {
        case h264
        case hevc

        var id: String { rawValue }

        var label: String {
            switch self {
            case .h264: return "H.264"
            case .hevc: return "HEVC"
            }
        }

        /// H.264 is the default because every browser with WebCodecs can decode
        /// it. HEVC is roughly 30% cheaper for the same quality but support is
        /// uneven, and a stream nobody can watch is not a saving.
        var note: String {
            switch self {
            case .h264: return "Widest compatibility"
            case .hevc: return "Smaller, not all browsers"
            }
        }

        var nalCodec: NALUnit.Codec {
            switch self {
            case .h264: return .h264
            case .hevc: return .hevc
            }
        }
    }

    enum Quality: String, CaseIterable, Identifiable {
        case hd720
        case hd1080

        var id: String { rawValue }

        var label: String {
            switch self {
            case .hd720: return "720p"
            case .hd1080: return "1080p"
            }
        }

        var size: (width: Int, height: Int) {
            switch self {
            case .hd720: return (1280, 720)
            case .hd1080: return (1920, 1080)
            }
        }

        /// Per eye. Doubling for two eyes, 1080p30 stereo is a 16 Mbps uplink,
        /// which is near the practical ceiling for a phone on domestic Wi-Fi.
        var defaultBitrate: Int {
            switch self {
            case .hd720: return 4_000_000
            case .hd1080: return 8_000_000
            }
        }
    }

    enum Mode: String, CaseIterable, Identifiable {
        case separate
        case mono

        var id: String { rawValue }

        var label: String {
            switch self {
            case .separate: return "Stereo"
            case .mono: return "Mono"
            }
        }

        var detail: String {
            switch self {
            case .separate: return "Both cameras, one encoded stream per eye"
            case .mono: return "Single camera, for setup and framing"
            }
        }
    }

    /// Mirrors `PROJECTION` in `src/catalog/media-format.js`. The ingest server
    /// validates against that same list, so a value added here without adding
    /// it there is rejected at the handshake.
    enum Projection: String, CaseIterable, Identifiable {
        case flat
        case dome180
        case fisheye

        var id: String { rawValue }

        var label: String {
            switch self {
            case .flat: return "Flat"
            case .dome180: return "180° dome"
            case .fisheye: return "Fisheye"
            }
        }

        var detail: String {
            switch self {
            case .flat: return "A screen in space. Correct for the built-in lenses."
            case .dome180: return "Wraps to a hemisphere. Needs a 180° lens attachment."
            case .fisheye: return "Circular image on a dome. Needs a fisheye attachment."
            }
        }
    }

    // MARK: - Persisted settings
    //
    // `@Published` with a `didSet` that writes to `UserDefaults`, rather than
    // `@AppStorage`. `@AppStorage` is a `DynamicProperty`: it works inside a
    // `View`, where SwiftUI installs an update mechanism, but inside an
    // `ObservableObject` it stores and reads correctly while never firing
    // `objectWillChange`. Views observing this object would then show stale
    // values — the shutter staying grey after a key is pasted, say — which is a
    // particularly annoying bug because the data is genuinely saved.

    @Published var broadcastName = defaults.string(forKey: "broadcastName") ?? "" {
        didSet { defaults.set(broadcastName, forKey: "broadcastName") }
    }

    @Published var codecRaw = defaults.string(forKey: "codec") ?? Codec.h264.rawValue {
        didSet { defaults.set(codecRaw, forKey: "codec") }
    }

    @Published var qualityRaw = defaults.string(forKey: "quality") ?? Quality.hd1080.rawValue {
        didSet { defaults.set(qualityRaw, forKey: "quality") }
    }

    @Published var modeRaw = defaults.string(forKey: "mode") ?? Mode.separate.rawValue {
        didSet { defaults.set(modeRaw, forKey: "mode") }
    }

    @Published var projectionRaw = defaults.string(forKey: "projection") ?? Projection.flat.rawValue {
        didSet { defaults.set(projectionRaw, forKey: "projection") }
    }

    @Published var frameRate = defaults.integer(forKey: "frameRate", default: 30) {
        didSet { defaults.set(frameRate, forKey: "frameRate") }
    }

    @Published var bitrate = defaults.integer(forKey: "bitrate", default: Quality.hd1080.defaultBitrate) {
        didSet { defaults.set(bitrate, forKey: "bitrate") }
    }

    /// Which physical camera feeds which eye.
    ///
    /// This is not a preference, it is a per-device fact that has to be
    /// established by looking through a headset once. The wide and ultra-wide
    /// lenses sit at fixed positions on the camera bump, but which one is on
    /// the left depends on the model *and* on which way up the phone is being
    /// held, and getting it backwards inverts the depth of the whole scene —
    /// which looks subtly wrong rather than obviously wrong, so it is easy to
    /// ship a broadcast with it inverted. The default below is a starting
    /// guess; verify it on the actual device before a real shoot.
    @Published var swapEyes = defaults.bool(forKey: "swapEyes") {
        didSet { defaults.set(swapEyes, forKey: "swapEyes") }
    }

    /// Hold the ultra-wide to the wide camera's exposure and white balance.
    ///
    /// On by default: two cameras each running their own auto loops will not
    /// agree, and a stereo pair whose eyes disagree about brightness is tiring
    /// to watch. Worth turning off only when deliberately exposing the two
    /// lenses differently.
    @Published var matchLenses = defaults.bool(forKey: "matchLenses", default: true) {
        didSet { defaults.set(matchLenses, forKey: "matchLenses") }
    }

    /// Manual brightness trim for the right eye, in stops, on top of the
    /// automatic aperture compensation.
    ///
    /// The compensation can only account for the published f-numbers. Lens
    /// transmission and sensor sensitivity also differ between the two modules
    /// and are not published anywhere, so if the right eye still reads dark (or
    /// now reads bright) after matching, this is the dial that fixes it.
    @Published var lensTrimStops = defaults.double(forKey: "lensTrimStops", default: 0) {
        didSet { defaults.set(lensTrimStops, forKey: "lensTrimStops") }
    }

    /// Drop to one camera when the phone gets hot, rather than letting the
    /// system throttle the frame rate of both.
    ///
    /// On by default. A thermally constrained multi-cam session does not stop —
    /// it quietly starts missing frames on whichever camera loses the race, and
    /// the result is a stereo pair with a stuttering right eye, which is more
    /// uncomfortable to watch than a clean mono picture. Turning this off is
    /// for a bench test where the point is to observe the throttling.
    @Published var thermalFallbackToMono = defaults.bool(forKey: "thermalFallbackToMono", default: true) {
        didSet { defaults.set(thermalFallbackToMono, forKey: "thermalFallbackToMono") }
    }

    /// Reconnect automatically after the link drops mid-broadcast.
    @Published var autoReconnect = defaults.bool(forKey: "autoReconnect", default: true) {
        didSet { defaults.set(autoReconnect, forKey: "autoReconnect") }
    }

    /// Capture and send sound from the microphone.
    ///
    /// On by default, because a broadcast without sound is a broadcast most
    /// audiences will not sit through, and because a tool that ships the
    /// feature switched off is a tool whose operators discover the omission
    /// after the event they were covering.
    ///
    /// Off is a real setting rather than a mute button: with this false the app
    /// does not attach a microphone to the capture session at all, so it never
    /// asks for permission, never appears in Settings › Privacy › Microphone,
    /// and never lights the orange indicator. See
    /// ``StereoCaptureSession/configure(quality:frameRate:stereo:audio:)``.
    @Published var captureAudio = defaults.bool(forKey: "captureAudio", default: true) {
        didSet { defaults.set(captureAudio, forKey: "captureAudio") }
    }

    /// Play return audio sent back by the destination — talkback, in the sense
    /// every professional contribution encoder means it.
    ///
    /// Off by default, and deliberately so. It is the only thing in this app
    /// that plays sound the operator did not record, it needs the audio session
    /// to be able to play as well as record, and without headphones the
    /// microphone will pick it up and send it back out in the broadcast. None
    /// of that should happen to somebody who never asked for it.
    ///
    /// Not every destination sends return audio; with this on and a server that
    /// does not, nothing is heard and nothing is opened. See
    /// ``ReturnAudioPlayer``.
    @Published var returnAudio = defaults.bool(forKey: "returnAudio", default: false) {
        didSet { defaults.set(returnAudio, forKey: "returnAudio") }
    }

    // MARK: - Rights acknowledgement
    //
    // Recorded as a version number rather than a boolean, so that changing the
    // wording re-asks. An acknowledgement of text nobody has read is not an
    // acknowledgement.

    /// Bump when the text in ``RightsAcknowledgement`` changes materially.
    static let rightsAcknowledgementVersion = 1

    @Published private(set) var acknowledgedRightsVersion = defaults.integer(forKey: "acknowledgedRightsVersion") {
        didSet { defaults.set(acknowledgedRightsVersion, forKey: "acknowledgedRightsVersion") }
    }

    var hasAcknowledgedRights: Bool {
        acknowledgedRightsVersion >= Self.rightsAcknowledgementVersion
    }

    func acknowledgeRights() {
        acknowledgedRightsVersion = Self.rightsAcknowledgementVersion
    }

    /// Used by "Erase stored data", which has to return the app to a state
    /// where it asks again.
    func withdrawRightsAcknowledgement() {
        acknowledgedRightsVersion = 0
    }

    // MARK: - First run

    /// Whether the "connect a destination" prompt has been shown.
    ///
    /// Asked once, not once per launch. Someone who deliberately skipped it, or
    /// who uses the app purely to test stereo capability, should not have to
    /// dismiss the same sheet every time they open it — the setting is still
    /// there under Destinations, which is where a second one would be added
    /// anyway. Cleared by "Erase stored data" along with everything else.
    @Published var hasSeenDestinationPrompt = defaults.bool(forKey: "hasSeenDestinationPrompt", default: false) {
        didSet { defaults.set(hasSeenDestinationPrompt, forKey: "hasSeenDestinationPrompt") }
    }

    var codec: Codec {
        get { Codec(rawValue: codecRaw) ?? .h264 }
        set { codecRaw = newValue.rawValue }
    }

    var quality: Quality {
        get { Quality(rawValue: qualityRaw) ?? .hd1080 }
        set {
            qualityRaw = newValue.rawValue
            bitrate = newValue.defaultBitrate
        }
    }

    var mode: Mode {
        get { Mode(rawValue: modeRaw) ?? .separate }
        set { modeRaw = newValue.rawValue }
    }

    var projection: Projection {
        get { Projection(rawValue: projectionRaw) ?? .flat }
        set { projectionRaw = newValue.rawValue }
    }

    /// The `stereo` field in the handshake. Separate per-eye tracks are still
    /// described as side-by-side because that is the layout a viewer assembles
    /// them into; `mono` when there is only one camera.
    var stereoLayout: String {
        mode == .mono ? "mono" : "sbs"
    }

    /// What the broadcast is called at the far end.
    ///
    /// `UIDevice.current.name` has returned the model — "iPhone", not "Dave's
    /// iPhone" — since iOS 16 for apps without the user-assigned device name
    /// entitlement, so the fallback is a device class rather than a person.
    var displayName: String {
        let trimmed = broadcastName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? UIDevice.current.model : trimmed
    }
}
