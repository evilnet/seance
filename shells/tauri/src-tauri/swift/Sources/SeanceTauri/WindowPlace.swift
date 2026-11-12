import AppKit
import Foundation

// Where the Mac app's window sits, kept by the shell itself in points
// (src/apple.rs `place_window`) in place of tauri-plugin-window-state, which
// stays on the other desktops.
//
// That plugin keeps the frame in physical pixels and puts it back once, when
// the window is made. A Mac with a Retina screen and an external one at a
// different scale got a window half or twice its size, somewhere else, after
// any change of displays; and nothing put the window back when a display came
// back, since the plugin never looks at the screens again.
//
// Here the frame is kept per arrangement of displays: the screens' names and
// frames, so a laptop at its desk and the same laptop on its own each keep
// their own place for the window. When the displays change, the frame kept
// for the new arrangement is put back once the change has settled (see
// `screensChanged`). An arrangement never seen before keeps the place AppKit
// gives it until the user moves the window. A move or resize made while the
// screens are settling is AppKit's, not the user's, and is not kept; nor is a
// frame in full screen or in the Dock.

@_cdecl("seance_window_place")
public func seanceWindowPlace(_ window: UnsafeMutableRawPointer) {
    let window = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()
    MainActor.assumeIsolated {
        WindowPlace.shared = WindowPlace(window)
    }
}

@MainActor
final class WindowPlace {
    static var shared: WindowPlace?

    private static let framesKey = "seance.windowFrames"
    private static let orderKey = "seance.windowFrameOrder"
    /// Arrangements remembered, the most recently used kept.
    private static let kept = 16
    /// How long the screens must stay quiet before a change counts as done.
    private static let settleDelay: TimeInterval = 1

    private let window: NSWindow
    private var frames: [String: String]
    /// Arrangement keys, the most recently used last.
    private var order: [String]
    /// The arrangement the window's frame is kept under; nil while the
    /// screens are settling.
    private var arrangement: String?
    private var settle: Timer?
    /// From willExitFullScreen to didExitFullScreen: the frames AppKit sets
    /// on the way out are not the user's. On the way in, and in full screen,
    /// the style mask already says so; an exit that fails stays in full
    /// screen, so the flag cannot outlast it.
    private var leavingFullScreen = false
    private var observers: [NSObjectProtocol] = []

    init(_ window: NSWindow) {
        let defaults = UserDefaults.standard
        self.window = window
        // Only frames the order knows of, so the cap holds.
        let saved = defaults.dictionary(forKey: Self.framesKey) as? [String: String] ?? [:]
        let order = (defaults.array(forKey: Self.orderKey) as? [String] ?? []).filter { saved[$0] != nil }
        self.order = order
        frames = saved.filter { order.contains($0.key) }

        let key = Self.currentArrangement()
        if !restore(key) {
            window.center()
        }
        arrangement = key
        keep()

        let center = NotificationCenter.default
        let watch = { (name: Notification.Name, object: AnyObject?, run: @escaping @MainActor (WindowPlace) -> Void) in
            center.addObserver(forName: name, object: object, queue: .main) { _ in
                MainActor.assumeIsolated {
                    if let place = WindowPlace.shared { run(place) }
                }
            }
        }
        observers = [
            watch(NSWindow.didMoveNotification, window) { $0.keep() },
            watch(NSWindow.didResizeNotification, window) { $0.keep() },
            watch(NSWindow.willStartLiveResizeNotification, window) { $0.userResizing() },
            watch(NSWindow.didEndLiveResizeNotification, window) { $0.keep() },
            watch(NSWindow.willExitFullScreenNotification, window) { $0.leavingFullScreen = true },
            watch(NSWindow.didExitFullScreenNotification, window) {
                $0.leavingFullScreen = false
                $0.putBack()
            },
            watch(NSWindow.didDeminiaturizeNotification, window) { $0.putBack() },
            watch(NSApplication.didChangeScreenParametersNotification, nil) { $0.screensChanged() },
        ]
    }

    /// The displays as they are now: each screen's name and frame, in a
    /// fixed order. The same displays in the same places give the same key.
    private static func currentArrangement() -> String {
        NSScreen.screens
            .map { screen in
                let f = screen.frame
                return "\(screen.localizedName)@\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width))x\(Int(f.height))"
            }
            .sorted()
            .joined(separator: "|")
    }

    /// The user's own move or resize, kept for the arrangement it was made
    /// in. A frame that changes while the screens settle, or in full screen
    /// or in the Dock, is not the user's choice of place. Written to disk
    /// once a live resize ends, not at every step of it.
    private func keep() {
        guard let key = arrangement, key == Self.currentArrangement(),
              !leavingFullScreen, !window.styleMask.contains(.fullScreen), !window.isMiniaturized
        else { return }

        frames[key] = NSStringFromRect(window.frame)
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.kept {
            frames[order.removeFirst()] = nil
        }
        if !window.inLiveResize {
            save()
        }
    }

    /// Back from full screen or the Dock, where nothing was put back: the
    /// frame kept for the displays as they are now, then keep what results.
    private func putBack() {
        guard let key = arrangement else { return }
        if restore(key) || frames[key] == nil {
            keep()
        }
    }

    /// AppKit moves windows off a screen that went away, and the window
    /// server may move them again for some time after the notification, a
    /// display waking or a mode switch coming in more than one step. So the
    /// screens are settling until they have been quiet for `settleDelay`:
    /// nothing is kept, the kept frame is put back on the next turn of the
    /// run loop and again when the timer fires, and only then is the new
    /// arrangement's frame kept again. Every further notification restarts
    /// the timer. A resize by the user ends the settling at once, with
    /// nothing put back; a drag cannot be told from AppKit's own moves, so
    /// one in that second may be put back once.
    private func screensChanged() {
        arrangement = nil
        settle?.invalidate()
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let place = WindowPlace.shared, place.arrangement == nil,
                      !place.window.inLiveResize
                else { return }
                _ = place.restore(Self.currentArrangement())
            }
        }
        let timer = Timer(timeInterval: Self.settleDelay, repeats: false) { _ in
            MainActor.assumeIsolated {
                WindowPlace.shared?.settled()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        settle = timer
    }

    /// The screens are quiet: put the kept frame back and keep from here on.
    /// A frame that could not go back (the window is in full screen or the
    /// Dock) stays kept for when it comes back.
    private func settled() {
        settle = nil
        let key = Self.currentArrangement()
        if window.inLiveResize {
            arrangement = key
            return
        }
        let placed = restore(key)
        arrangement = key
        if placed || frames[key] == nil {
            keep()
        }
    }

    /// The user is resizing the window: if the screens are settling, the
    /// change is over as far as the window goes, and the size the user
    /// gives it is the one kept.
    private func userResizing() {
        guard arrangement == nil else { return }
        settle?.invalidate()
        settle = nil
        arrangement = Self.currentArrangement()
    }

    /// Put back the frame kept for `key`, if there is one and the band the
    /// traffic lights sit in (28pt, lib.rs `traffic_light_position`) is on a
    /// screen, all of its height and enough of its width to drag the window
    /// by. Full screen and the Dock are left alone.
    @discardableResult
    private func restore(_ key: String) -> Bool {
        guard let text = frames[key], !leavingFullScreen,
              !window.styleMask.contains(.fullScreen), !window.isMiniaturized
        else { return false }
        let frame = NSRectFromString(text)
        let band = NSRect(x: frame.minX, y: frame.maxY - 28, width: frame.width, height: 28)
        let shown = { (screen: NSScreen) -> Bool in
            let part = screen.visibleFrame.intersection(band)
            return part.height >= band.height && part.width >= min(band.width, 100)
        }
        guard !frame.isEmpty, NSScreen.screens.contains(where: shown) else { return false }

        if window.frame != frame {
            window.setFrame(frame, display: true)
        }
        return true
    }

    private func save() {
        let defaults = UserDefaults.standard
        defaults.set(frames, forKey: Self.framesKey)
        defaults.set(order, forKey: Self.orderKey)
    }
}
