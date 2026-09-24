#!/usr/bin/env swift

// Render the launch screen's logo.
//
//   swift ios/Tools/make-launch-logo.swift
//
// A launch screen is static - iOS draws it from the bundle before any of our
// code runs, so it cannot be a SwiftUI view and cannot animate. To keep the
// handoff invisible it has to be a *picture* of what `StartupView` draws first,
// which is the `camera.aperture` symbol in white. This renders exactly that,
// from the same system symbol, so the two cannot drift apart.
//
// Committed as a script rather than just its output so the PNGs can be
// regenerated after a change of symbol, weight or size, instead of being three
// opaque binaries nobody dares touch.

import AppKit

let symbolName = "camera.aperture"

// Sized so the drawn glyph lands on `StartupView.glyphPoints`, which is what
// SwiftUI puts in the same place a quarter of a second later. A symbol's ink is
// about 0.82 of its point size, hence the factor below.
let points: CGFloat = 56

let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()      // Tools
    .deletingLastPathComponent()      // ios
    .appendingPathComponent("AVRCapture/Assets.xcassets/LaunchLogo.imageset")

try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

for scale in 1...3 {
    let pixels = Int(points) * scale

    // Drawn at the symbol's natural size for the scale rather than by scaling a
    // 1x render, so the strokes stay crisp instead of being resampled.
    let configuration = NSImage.SymbolConfiguration(pointSize: points * CGFloat(scale) * 0.82, weight: .light)

    guard let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration) else {
        fatalError("no system symbol named \(symbolName)")
    }

    // An explicit bitmap rep, because `NSImage.lockFocus` picks up the main
    // display's backing scale and would silently produce a 2x bitmap here.
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else {
        fatalError("could not allocate a \(pixels)x\(pixels) bitmap")
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let box = NSRect(
        x: (CGFloat(pixels) - symbol.size.width) / 2,
        y: (CGFloat(pixels) - symbol.size.height) / 2,
        width: symbol.size.width,
        height: symbol.size.height
    )
    symbol.draw(in: box)

    // Symbols render in the current text colour, which is black off-screen.
    // Painting white through the alpha that was just laid down recolours the
    // glyph without touching its shape.
    NSColor.white.set()
    NSRect(x: 0, y: 0, width: pixels, height: pixels).fill(using: .sourceAtop)

    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        fatalError("could not encode the \(scale)x png")
    }

    let suffix = scale == 1 ? "" : "@\(scale)x"
    let url = root.appendingPathComponent("LaunchLogo\(suffix).png")
    try png.write(to: url)
    print("wrote \(url.lastPathComponent) (\(pixels)x\(pixels))")
}

// MARK: - App icon
//
// The same mark, filled rather than cut out. Not decoration: an app with no
// icon set gets a white square on the home screen, and once an asset catalog
// exists at all the build *fails* without one.

let iconSide = 1024
let iconRoot = root
    .deletingLastPathComponent()
    .appendingPathComponent("AppIcon.appiconset")

try FileManager.default.createDirectory(at: iconRoot, withIntermediateDirectories: true)

guard let iconRep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: iconSide, pixelsHigh: iconSide,
    bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
) else {
    fatalError("could not allocate the icon bitmap")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: iconRep)

// Opaque, and square. iOS rounds the corners itself, and an icon with alpha in
// it is rejected at submission.
NSColor(calibratedWhite: 0.043, alpha: 1).set()
NSRect(x: 0, y: 0, width: iconSide, height: iconSide).fill()

let iconConfiguration = NSImage.SymbolConfiguration(pointSize: CGFloat(iconSide) * 0.52, weight: .light)
if let mark = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
    .withSymbolConfiguration(iconConfiguration) {
    let box = NSRect(
        x: (CGFloat(iconSide) - mark.size.width) / 2,
        y: (CGFloat(iconSide) - mark.size.height) / 2,
        width: mark.size.width,
        height: mark.size.height
    )

    // Drawn into a transparent scratch layer and tinted there, because the
    // `sourceAtop` trick used above would recolour the background too.
    let layer = NSImage(size: box.size, flipped: false) { bounds in
        mark.draw(in: bounds)
        NSColor.white.set()
        bounds.fill(using: .sourceAtop)
        return true
    }
    layer.draw(in: box)
}

NSGraphicsContext.restoreGraphicsState()

guard let iconPng = iconRep.representation(using: .png, properties: [:]) else {
    fatalError("could not encode the icon")
}

try iconPng.write(to: iconRoot.appendingPathComponent("AppIcon.png"))
print("wrote AppIcon.png (\(iconSide)x\(iconSide))")
