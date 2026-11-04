// The macOS app icon: the deploy's square logo cut to the rounded square every
// Mac icon is, on Apple's 1024 grid (an 824 square, 100 of margin, a soft
// shadow below). macOS draws an .icns as it is, so a full-bleed square logo
// shows as a hard-edged square in the Dock; iOS and Android round theirs.
//
//   swift tools/macos-icon.swift <square.png> <out.png>

import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: macos-icon.swift <square.png> <out.png>\n".data(using: .utf8)!)
    exit(2)
}

let canvas = 1024
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { exit(1) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high

let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)

// The shadow, under the tile only.
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 20
shadow.set()
NSColor.black.setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

shape.addClip()
logo.draw(in: tile, from: .zero, operation: .copy, fraction: 1)

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]),
      (try? png.write(to: URL(fileURLWithPath: args[2]))) != nil
else { exit(1) }
