import AVFoundation
import XCTest
@testable import AVRCapture

/// Lifecycle and policy, as far as they can be exercised without a camera.
///
/// The simulator has no capture hardware, so `prepare()` and anything that
/// actually opens a session are out of scope here and covered by the manual
/// plan in docs/IOS_TESTING.md. What is testable is the part that decides
/// *whether* to do something: the gates in front of `start()`, the stereo
/// capability policy, and the state machine's own vocabulary.
@MainActor
final class BroadcastLifecycleTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var store: DestinationStore!
    private var config: CaptureConfig!
    private var controller: BroadcastController!

    override func setUp() async throws {
        try await super.setUp()

        suiteName = "com.projectavr.capture.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        Keychain.removeAll()

        store = DestinationStore(defaults: defaults)
        config = CaptureConfig()
        controller = BroadcastController(config: config, destinations: store)
    }

    override func tearDown() async throws {
        controller.stop()
        config.withdrawRightsAcknowledgement()
        Keychain.removeAll()
        defaults.removePersistentDomain(forName: suiteName)
        try await super.tearDown()
    }

    // MARK: - Gates in front of going live

    func testStartRefusesWithoutARightsAcknowledgement() {
        config.withdrawRightsAcknowledgement()
        store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: "k")

        controller.start()

        guard case let .error(message) = controller.status else {
            return XCTFail("expected an error, got \(controller.status)")
        }
        XCTAssertTrue(message.lowercased().contains("terms"))
    }

    func testStartRefusesWithNoDestination() {
        config.acknowledgeRights()

        controller.start()

        guard case let .error(message) = controller.status else {
            return XCTFail("expected an error, got \(controller.status)")
        }
        XCTAssertTrue(message.lowercased().contains("destination"))
    }

    func testStartRefusesWithADestinationThatHasNoKey() {
        config.acknowledgeRights()
        store.add(name: "Studio", transport: .avrLive, host: "10.0.0.1", port: 8081, key: nil)

        controller.start()

        guard case let .error(message) = controller.status else {
            return XCTFail("expected an error, got \(controller.status)")
        }
        XCTAssertTrue(message.lowercased().contains("key"))
    }

    func testStopIsIdempotentAndSafeFromIdle() {
        controller.stop()
        controller.stop()

        XCTAssertEqual(controller.status, .idle)
        XCTAssertEqual(controller.telemetry.framesEncoded, 0)
        XCTAssertEqual(controller.telemetry.reconnections, 0)
    }

    // MARK: - Rights acknowledgement

    func testAcknowledgementIsVersionedSoNewWordingReAsks() {
        config.withdrawRightsAcknowledgement()
        XCTAssertFalse(config.hasAcknowledgedRights)

        config.acknowledgeRights()
        XCTAssertTrue(config.hasAcknowledgedRights)
        XCTAssertEqual(config.acknowledgedRightsVersion, CaptureConfig.rightsAcknowledgementVersion)

        config.withdrawRightsAcknowledgement()
        XCTAssertFalse(config.hasAcknowledgedRights)
    }

    // MARK: - Capability policy

    func testStereoRequiresTheDeviceToOfferThePair() {
        // On a simulator there are no cameras at all, so this asserts the
        // *relationship* rather than a hardcoded answer: the app must never
        // claim stereo the hardware has not reported.
        if !controller.capabilities.supportsWideAndUltraWideTogether {
            XCTAssertFalse(controller.supportsStereo)
            XCTAssertFalse(controller.effectiveStereo)
            XCTAssertNotNil(controller.stereoUnavailableReason)
        } else {
            XCTAssertTrue(controller.supportsStereo)
            XCTAssertNil(controller.stereoUnavailableReason)
        }
    }

    func testMonoModeIsNeverStereoEvenOnCapableHardware() {
        config.mode = .mono
        XCTAssertFalse(controller.effectiveStereo)
    }

    func testCapabilityReportIsHardwareOnly() {
        // The export is shared with support, so it must not be able to carry a
        // destination or a credential out with it.
        config.acknowledgeRights()
        store.add(name: "Secret Studio", transport: .avrLive, host: "203.0.113.9", port: 8081, key: "topsecret")

        let text = controller.capabilities.exportText()

        XCTAssertFalse(text.contains("203.0.113.9"))
        XCTAssertFalse(text.contains("topsecret"))
        XCTAssertFalse(text.contains("Secret Studio"))
        XCTAssertTrue(text.contains("AVR Capture diagnostics"))
    }

    // MARK: - Status vocabulary

    func testStatusActivityFlags() {
        XCTAssertFalse(BroadcastController.Status.idle.isActive)
        XCTAssertTrue(BroadcastController.Status.connecting.isActive)
        XCTAssertTrue(BroadcastController.Status.reconnecting(attempt: 1, of: 6).isActive)
        XCTAssertTrue(BroadcastController.Status.live(sessionId: nil).isActive)
        XCTAssertTrue(BroadcastController.Status.live(sessionId: "abc").isLive)
        XCTAssertFalse(BroadcastController.Status.error("nope").isActive)
    }

    // MARK: - Interruption mapping

    func testInterruptionReasonsBecomeSentences() {
        for reason: AVCaptureSession.InterruptionReason in [
            .videoDeviceNotAvailableInBackground,
            .audioDeviceInUseByAnotherClient,
            .videoDeviceInUseByAnotherClient,
            .videoDeviceNotAvailableWithMultipleForegroundApps,
            .videoDeviceNotAvailableDueToSystemPressure
        ] {
            let interruption = StereoCaptureSession.Interruption(reason: reason)
            XCTAssertFalse(interruption.message.isEmpty, "no message for \(reason.rawValue)")
        }

        XCTAssertFalse(
            StereoCaptureSession.Interruption(reason: .videoDeviceNotAvailableDueToSystemPressure)
                .resumesAutomatically,
            "system pressure does not clear on its own"
        )
    }
}
