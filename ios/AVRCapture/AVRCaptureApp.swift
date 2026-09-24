import SwiftUI
import UIKit

/// AVR Capture.
///
/// A live video broadcasting tool. It encodes what the phone's cameras see and
/// sends it to a destination the operator configures — a standard single-camera
/// picture, or, on devices whose hardware allows two cameras to run at once, a
/// stereoscopic pair encoded as one stream per eye.
///
/// The phone encodes because nothing else can. Two uncompressed 1080p30 streams
/// are roughly 1.5 Gbps; no Wi-Fi link and no uplink to a cloud region will
/// carry that, so the *contribution* encode has to happen where the sensors are.
/// Everything after it — compositing, the bitrate ladder, packaging — happens at
/// the destination.
///
/// The app ships no content of its own. It has no catalogue, no directory, no
/// store, and no default destination: it broadcasts where its operator points
/// it, and what they broadcast is theirs. See `docs/IOS_BRIEF.md`.
@main
@MainActor
struct AVRCaptureApp: App {
    @StateObject private var config: CaptureConfig
    @StateObject private var destinations: DestinationStore
    @StateObject private var broadcast: BroadcastController

    @Environment(\.scenePhase) private var scenePhase

    init() {
        // `BroadcastController` needs both stores at init, and one
        // `@StateObject` cannot read another during `init`, so all three are
        // built here and handed to the wrappers directly.
        let config = CaptureConfig()
        let destinations = DestinationStore()
        _config = StateObject(wrappedValue: config)
        _destinations = StateObject(wrappedValue: destinations)
        _broadcast = StateObject(
            wrappedValue: BroadcastController(config: config, destinations: destinations)
        )
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(config)
                .environmentObject(destinations)
                .environmentObject(broadcast)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                // Multi-cam capture is suspended by the system on backgrounding
                // and there is no entitlement that changes that. Ending the
                // broadcast cleanly means the server sees a BYE and writes a
                // proper end to the HLS playlist, rather than viewers sitting on
                // a stream that has silently stopped producing segments.
                broadcast.stop()
            case .active:
                // The camera stays awake for as long as the app is in front. A
                // viewfinder that dims mid-shot is worse than a flat battery.
                UIApplication.shared.isIdleTimerDisabled = true
            default:
                break
            }
        }
    }
}
