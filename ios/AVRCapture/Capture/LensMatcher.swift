import AVFoundation
import os

/// Keep the ultra-wide looking like the wide camera.
///
/// The two lenses are different parts. On the phones this app targets the wide
/// opens to about f/1.8 and the ultra-wide to about f/2.2, which is most of a
/// stop of light, and their sensors have different colour response on top of
/// that. Left to themselves both cameras run their own auto-exposure and
/// auto-white-balance loops, and two independent loops pointed at the same
/// scene do not merely start apart — they drift apart, each hunting on its own
/// schedule as the camera moves.
///
/// In a stereo pair that is not a cosmetic problem. The visual system fuses the
/// two eyes, and a sustained brightness or colour difference between them does
/// not read as "one eye is dark"; it reads as fatigue and, at larger
/// differences, as binocular rivalry — the image seems to shimmer between the
/// two versions. It is one of the standard ways stereo footage becomes
/// uncomfortable to watch without the viewer being able to say why.
///
/// So only the wide camera is allowed to decide. Its exposure and white balance
/// are copied onto the ultra-wide on a timer, compensated for the aperture
/// difference so that matching the *settings* actually matches the *picture*.
final class LensMatcher {
    /// Extra exposure for the right eye, in stops, on top of the automatic
    /// aperture compensation. A fallback for the part that cannot be computed:
    /// transmission and sensor sensitivity differ between the two modules and
    /// are not published anywhere.
    var trimStops: Double {
        get { lock.withLock { storedTrimStops } }
        set { lock.withLock { storedTrimStops = newValue } }
    }

    /// How far short of the wide camera the ultra-wide is falling, in stops,
    /// after everything below has been tried.
    ///
    /// Zero means the eyes match. Anything else is the difference between "the
    /// trim is set too low" and "the trim cannot go any higher", which the
    /// operator has no way to tell apart by looking.
    var shortfallStops: Double { lock.withLock { storedShortfall } }

    /// How far the *left* eye has been brought down to meet the right, in
    /// stops. Never positive. This is the visible cost of matching — the whole
    /// shot gets darker — so the operator is told about it rather than left to
    /// wonder why the picture dimmed.
    var wideBiasStops: Double { lock.withLock { storedWideBias } }

    private let wide: AVCaptureDevice
    private let ultraWide: AVCaptureDevice
    private let queue: DispatchQueue
    private let log = Logger(subsystem: "com.projectavr.capture", category: "lens-match")

    /// `trimStops` is written from the UI and read on `queue`; `shortfallStops`
    /// the other way about.
    private let lock = NSLock()
    private var storedTrimStops: Double = 0
    private var storedShortfall: Double = 0
    private var storedWideBias: Double = 0

    /// Exposure compensation currently applied to the *wide* camera to bring it
    /// down to something the ultra-wide can reach. Never positive. Only touched
    /// on `queue`.
    private var wideBias: Float = 0
    private var cleanTicks = 0

    private var timer: DispatchSourceTimer?

    /// How much more light the ultra-wide needs to match the wide, as a linear
    /// multiplier. Light gathered goes as the inverse square of the f-number,
    /// so an f/2.2 lens next to an f/1.78 one needs about 1.5x.
    private let apertureCompensation: Double

    /// Four times a second. Fast enough to track a pan through a doorway,
    /// slow enough that locking the device for configuration is not a cost.
    private static let interval = 0.25

    init(wide: AVCaptureDevice, ultraWide: AVCaptureDevice, queue: DispatchQueue) {
        self.wide = wide
        self.ultraWide = ultraWide
        self.queue = queue

        let wideAperture = Double(wide.lensAperture)
        let ultraAperture = Double(ultraWide.lensAperture)

        if wideAperture > 0, ultraAperture > 0 {
            apertureCompensation = pow(ultraAperture / wideAperture, 2)
        } else {
            apertureCompensation = 1
        }

        log.info("aperture compensation \(self.apertureCompensation, privacy: .public)x")
    }

    deinit {
        timer?.cancel()
    }

    func start() {
        queue.async { [weak self] in
            guard let self, self.timer == nil else { return }

            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: Self.interval)
            timer.setEventHandler { [weak self] in self?.apply() }
            timer.resume()
            self.timer = timer
        }
    }

    /// Stop matching and hand the ultra-wide back its own auto loops.
    ///
    /// Without this the camera stays locked to whatever the last copied values
    /// were, which the *next* session then inherits — a broadcast that starts
    /// in a dark room and is stopped outdoors would otherwise leave the
    /// ultra-wide locked to the dark room's exposure.
    func stop() {
        // Strong capture, deliberately. The caller usually drops its reference
        // immediately after calling this — a weak one would let the matcher
        // deallocate before the block runs, and the ultra-wide would be left
        // locked to the last values copied onto it.
        queue.async {
            self.timer?.cancel()
            self.timer = nil

            self.configureUltraWide { device in
                if device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposureMode = .continuousAutoExposure
                }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    device.whiteBalanceMode = .continuousAutoWhiteBalance
                }
            }

            // And give the wide camera back its own idea of correct exposure.
            // Left biased down, every later session — mono ones included, which
            // never go near this class — would start underexposed.
            if self.wideBias != 0 {
                self.wideBias = 0
                self.cleanTicks = 0
                self.configureWide { $0.setExposureTargetBias(0, completionHandler: nil) }
            }

            self.lock.withLock {
                self.storedShortfall = 0
                self.storedWideBias = 0
            }
        }
    }

    private func apply() {
        let duration = wide.exposureDuration
        let iso = wide.iso
        let wideGains = wide.deviceWhiteBalanceGains

        var shortfall: Double = 0

        configureUltraWide { device in
            shortfall = self.matchExposure(on: device, duration: duration, iso: iso)
            self.matchWhiteBalance(on: device, wideGains: wideGains)
        }

        setShortfall(shortfall)
        meetInTheMiddle(shortfall: shortfall)
    }

    /// Drive the ultra-wide to the wide camera's exposure, and report how far
    /// short it fell, in stops.
    @discardableResult
    private func matchExposure(on device: AVCaptureDevice, duration: CMTime, iso: Float) -> Double {
        guard device.isExposureModeSupported(.custom) else { return 0 }

        let format = device.activeFormat
        let gain = apertureCompensation * pow(2, trimStops)

        // Never longer than one frame: a longer exposure than the frame
        // interval forces the camera to drop its frame rate, and a right eye
        // running at half the left eye's rate is worse than a dark one.
        let durationCeiling = min(format.maxExposureDuration, device.activeVideoMaxFrameDuration)
        var targetDuration = clamp(duration, low: format.minExposureDuration, high: durationCeiling)

        // Spend the gain on ISO first. It costs noise, where a longer exposure
        // costs motion blur the *other* eye does not have, and mismatched blur
        // on anything moving breaks fusion in a way that matched noise does not.
        let wantedISO = Double(iso) * gain
        let targetISO = min(max(wantedISO, Double(format.minISO)), Double(format.maxISO))

        // What ISO could not deliver. This used to be thrown away by a `min`
        // against `maxISO`, which made the ceiling invisible: past it the trim
        // slider moved and nothing on screen changed.
        var remaining = wantedISO / max(targetISO, .leastNormalMagnitude)

        if remaining > 1 {
            // Only now, with ISO exhausted, is a longer exposure worth its cost
            // — and only up to the frame interval, which is often no headroom
            // at all indoors, where the wide camera is already there.
            let stretched = CMTimeMultiplyByFloat64(targetDuration, multiplier: remaining)
            let capped = clamp(stretched, low: format.minExposureDuration, high: durationCeiling)

            let before = CMTimeGetSeconds(targetDuration)
            let after = CMTimeGetSeconds(capped)
            if before > 0, after > before { remaining /= after / before }

            targetDuration = capped
        }

        device.setExposureModeCustom(duration: targetDuration, iso: Float(targetISO))

        return log2(max(remaining, 1))
    }

    /// When the ultra-wide cannot be raised any further, lower the wide camera
    /// to meet it.
    ///
    /// The alternative is to leave the pair mismatched, and a mismatched pair is
    /// the thing this class exists to prevent. Bringing the bright eye down
    /// always has headroom where raising the dark eye does not, and the cost — a
    /// slightly darker image overall — is paid by both eyes equally, which is
    /// the entire point.
    ///
    /// The wide stays on its own auto-exposure; only its *target* is moved, so
    /// it goes on metering the scene normally underneath.
    private func meetInTheMiddle(shortfall: Double) {
        guard wide.isExposureModeSupported(.continuousAutoExposure) else { return }

        // Never further than this, whatever the camera would allow. Past about
        // three stops down the shot is too dark to be worth matching, and a
        // matched pair of black frames is not an improvement.
        let floor = max(wide.minExposureTargetBias, -3)
        let wanted: Float

        if shortfall > 0.05 {
            cleanTicks = 0

            // A fraction of the correction, not all of it. The wide camera's
            // auto-exposure takes a few hundred milliseconds to respond to a
            // change of target, and this runs four times a second — so applying
            // the whole shortfall each tick would re-apply a correction that is
            // already on its way, overshoot, and then hunt.
            wanted = wideBias - Float(shortfall) * 0.35
        } else {
            // Release slowly, and only once the mismatch has stayed gone for a
            // couple of seconds. Releasing re-creates the shortfall that caused
            // the bias in the first place, so a quick release just oscillates.
            cleanTicks += 1
            guard cleanTicks >= 8, wideBias < 0 else { return }
            wanted = min(wideBias + 0.05, 0)
        }

        let target = min(max(wanted, floor), 0)
        guard abs(target - wideBias) > 0.01 else { return }

        wideBias = target
        lock.withLock { storedWideBias = Double(target) }
        configureWide { $0.setExposureTargetBias(target, completionHandler: nil) }
    }

    private func matchWhiteBalance(on device: AVCaptureDevice, wideGains: AVCaptureDevice.WhiteBalanceGains) {
        guard device.isWhiteBalanceModeSupported(.locked) else { return }

        // Gains cannot be copied across devices directly. They are raw channel
        // multipliers, defined against one sensor's colour filters, so the same
        // numbers on the other camera give a different colour. Going via
        // temperature and tint — which are device independent — is what makes
        // this a match rather than a coincidence.
        let temperatureAndTint = wide.temperatureAndTintValues(for: wideGains)
        var gains = device.deviceWhiteBalanceGains(for: temperatureAndTint)

        let maximum = device.maxWhiteBalanceGain
        gains.redGain = min(max(gains.redGain, 1), maximum)
        gains.greenGain = min(max(gains.greenGain, 1), maximum)
        gains.blueGain = min(max(gains.blueGain, 1), maximum)

        device.setWhiteBalanceModeLocked(with: gains)
    }

    private func setShortfall(_ stops: Double) {
        lock.withLock { storedShortfall = stops }
    }

    private func configureUltraWide(_ body: (AVCaptureDevice) -> Void) {
        configure(ultraWide, name: "ultra-wide", body)
    }

    private func configureWide(_ body: (AVCaptureDevice) -> Void) {
        configure(wide, name: "wide", body)
    }

    private func configure(_ device: AVCaptureDevice, name: String, _ body: (AVCaptureDevice) -> Void) {
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            body(device)
        } catch {
            log.error("could not lock the \(name, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func clamp(_ value: CMTime, low: CMTime, high: CMTime) -> CMTime {
        if CMTimeCompare(value, low) < 0 { return low }
        if CMTimeCompare(value, high) > 0 { return high }
        return value
    }
}
