import AVFoundation
import SwiftUI

/// Read a destination link off a screen with the camera.
///
/// This exists because the alternative was worse than it looked. A destination
/// link is an address, a port and a forty-character key; getting it from the
/// browser that issued it into this app meant either typing it on a phone
/// keyboard or mailing a live broadcast credential to yourself. People
/// overwhelmingly chose the second, which puts a bearer credential in a mailbox
/// that outlives it.
///
/// What it is not: this scanner decodes a string and hands it to
/// `DestinationImport.candidate(fromText:)` — the same parser, the same
/// validation and the same confirmation sheet as a pasted link. A scan saves
/// nothing and connects to nothing. A QR code is an instruction from whoever
/// printed it, and an app that repoints its broadcast at whatever address a
/// camera happened to see is a redirection primitive with a viewfinder.
///
/// The scanned string is never logged, not even truncated. It routinely
/// contains a key, and `Redact` exists because a log line is the one place a
/// credential reliably outlives everything else on the device.
///
/// Only one capture session can hold the camera, so this screen is reachable
/// only when no broadcast is running — the caller disables the button, and
/// `stop()` on disappear releases the camera whether the operator scanned
/// anything or backed out.
struct DestinationScannerView: View {
    @Environment(\.dismiss) private var dismiss

    /// Called with the decoded string. Validation and confirmation happen at
    /// the caller, on the shared import path.
    let onScan: (String) -> Void

    @State private var authorisation = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var scanned = false

    var body: some View {
        Group {
            switch authorisation {
            case .authorized:
                scanner

            case .notDetermined:
                // The prompt is raised from here rather than on appear of the
                // whole destinations screen: asking for the camera at the
                // moment somebody taps "Scan" is a question with visible
                // context, and asking earlier is a question about nothing.
                PermissionPrompt(
                    title: "Camera access",
                    message: "Scanning a destination link needs the camera. Nothing is recorded and nothing leaves the phone.",
                    action: "Allow camera access"
                ) {
                    Task {
                        _ = await AVCaptureDevice.requestAccess(for: .video)
                        authorisation = AVCaptureDevice.authorizationStatus(for: .video)
                    }
                }

            default:
                PermissionPrompt(
                    title: "Camera turned off",
                    message: "Camera access is off for AVR Capture, so a code cannot be scanned. You can still paste a destination link instead.",
                    action: "Open Settings"
                ) {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .navigationTitle("Scan a destination")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
    }

    private var scanner: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            QRScannerRepresentable { value in
                // One scan per presentation. A QR code in front of a camera
                // decodes many times a second, and without this the
                // confirmation sheet is pushed once per frame.
                guard !scanned else { return }
                scanned = true

                onScan(value)
                dismiss()
            }
            .ignoresSafeArea()

            VStack {
                Spacer()
                Text("Point the camera at the code shown by whoever is receiving the broadcast.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white)
                    .padding()
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                    .padding()
            }
        }
    }
}

/// The two states where there is nothing to show but an explanation.
private struct PermissionPrompt: View {
    let title: String
    let message: String
    let action: String
    let perform: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)

            Text(title).font(.headline)

            Text(message)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Button(action, action: perform)
                .buttonStyle(.borderedProminent)
        }
        .padding(32)
    }
}

/// The camera itself.
///
/// `AVCaptureMetadataOutput` rather than Vision: the barcode detector is a
/// frame-by-frame API that hands back pixel buffers, and pixel buffers of a
/// screen showing a credential are a thing this app would then be responsible
/// for not keeping. The metadata output never surfaces an image at all — the
/// hardware decodes and returns a string.
private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) {
        controller.onScan = onScan
    }
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    /// Configuration off the main thread. `startRunning` blocks for long enough
    /// to be visible as a dropped frame in the presenting animation, and the
    /// documented place for both is a serial queue of one's own.
    private let queue = DispatchQueue(label: "com.projectavr.capture.scanner")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer

        queue.async { [weak self] in self?.configure() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        queue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)

        // Not optional. The broadcast capture session wants the same hardware,
        // and a scanner left running behind a dismissed sheet is a camera the
        // encoder cannot have.
        queue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    private func configure() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            // No camera, or it is held by something else. The view shows a live
            // black rectangle and the operator backs out to the paste field;
            // there is nothing useful to say that is not already obvious from a
            // preview that never appears.
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)

        // Order matters: the types can only be set once the output belongs to a
        // session, and setting them before is the classic way to get a scanner
        // that runs and never fires.
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let object = objects.first as? AVMetadataMachineReadableCodeObject,
            object.type == .qr,
            let value = object.stringValue,
            !value.isEmpty
        else { return }

        // A QR code holds up to 2953 bytes and a destination link is a couple
        // of hundred. Refusing the rest here keeps anything absurd away from
        // the parser, and there is no legitimate link this excludes.
        guard value.utf8.count <= 1024 else { return }

        onScan?(value)
    }
}
