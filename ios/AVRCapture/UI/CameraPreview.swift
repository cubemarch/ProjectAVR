import AVFoundation
import SwiftUI
import UIKit

/// The viewfinder.
///
/// `AVCaptureVideoPreviewLayer` rather than rendering the pixel buffers that
/// reach the encoder, because the preview must stay smooth even when the
/// encoder or the uplink is struggling — those are exactly the moments the
/// operator most needs to see what the camera sees. The layer is fed directly by
/// the capture graph and is unaffected by anything downstream of it.
///
/// A consequence worth knowing: the preview is *not* the broadcast. It shows one
/// camera, uncropped, so it does not reflect the field-of-view rectification
/// that ``PixelRectifier`` applies, and it never shows the second eye. For
/// framing that is the right trade; for checking stereo, use the monitor page on
/// the server.
struct CameraPreview: UIViewRepresentable {
    let session: StereoCaptureSession

    /// Preview the ultra-wide instead of the wide camera.
    var useUltraWide = false

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black

        // The layer is attached with `addConnection`, not by setting `session`,
        // because a multi-cam session's connections are all made manually — see
        // `StereoCaptureSession.attachPreview`.
        session.attachPreview(view.previewLayer, useUltraWide: useUltraWide)

        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    /// A `UIView` whose backing layer *is* the preview layer.
    ///
    /// The alternative — adding the preview layer as a sublayer — means keeping
    /// its frame in sync with the view by hand, and getting a stale frame for
    /// one layout pass on every rotation.
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer {
            // swiftlint:disable:next force_cast
            layer as! AVCaptureVideoPreviewLayer
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            previewLayer.videoGravity = .resizeAspectFill
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }
    }
}
