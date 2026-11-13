import ObjectiveC
import SeanceNotifications
import SeanceTranslate
import SwiftUI
import Tauri
import UIKit
import UserNotifications
import WebKit

class EventHandlerArgs: Decodable {
    let handler: Channel
}

/// Every plugin the page calls on iOS (client/js/helpers/shell.ts):
/// src/mobile.rs hands each call here as `{plugin, method, options}`, and
/// events go back through the one channel it set at start. LocalNotifications
/// is the one the macOS shell answers too (../swift, SeanceNotifications);
/// App, Keyboard, StatusBar, SplashScreen, Badge and Power are answered here,
/// and AppleTranslate (Apple's Translation framework, ../swift SeanceTranslate,
/// shared with the macOS shell) with `prepareHost` for its download sheet.
final class SeancePlugin: Plugin {
    private var channel: Channel?
    private var held: [JsonObject] = []
    private lazy var notifications = Notifications { [weak self] tap in
        self?.emit("LocalNotifications", "localNotificationActionPerformed", tap, retain: true)
    }
    private let appleTranslate = AppleTranslate()
    private weak var webview: WKWebView?
    private var observers: [NSObjectProtocol] = []

    override func load(webview: WKWebView) {
        self.webview = webview
        _ = notifications

        // The page lays itself out edge to edge from env(safe-area-inset-*)
        // (client/css/style.css); wry leaves the scroll view on .automatic,
        // which pads it by the safe areas again and makes every screen
        // scroll by their height.
        webview.scrollView.contentInsetAdjustmentBehavior = .never

        let center = NotificationCenter.default
        let on = { (name: Notification.Name, block: @escaping (Notification) -> Void) in
            self.observers.append(center.addObserver(forName: name, object: nil, queue: .main, using: block))
        }

        // iOS drops the page's sockets in the background; the page reconnects
        // when this says it is back (client/js/native.ts).
        on(UIApplication.didBecomeActiveNotification) { [weak self] _ in
            self?.emit("App", "appStateChange", ["isActive": true], retain: false)
        }
        on(UIApplication.willResignActiveNotification) { [weak self] _ in
            self?.emit("App", "appStateChange", ["isActive": false], retain: false)
        }

        // The keyboard's height, which iOS never tells a page straight
        // (client/js/helpers/viewport.ts).
        on(UIResponder.keyboardWillShowNotification) { [weak self] note in
            let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
            self?.emit("Keyboard", "keyboardWillShow", ["keyboardHeight": frame.height], retain: false)
        }
        on(UIResponder.keyboardWillHideNotification) { [weak self] _ in
            self?.emit("Keyboard", "keyboardWillHide", [:], retain: false)
        }

        // Low Power Mode, for the ps scene's Auto (client/js/themeScene.ts):
        // WebKit holds a Safari page to 30 fps in it but not this web view,
        // so the page cannot see it for itself.
        on(.NSProcessInfoPowerStateDidChange) { [weak self] _ in
            self?.emit("Power", "changed", ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled], retain: false)
        }
    }

    @objc func setEventHandler(_ invoke: Invoke) throws {
        channel = try invoke.parseArgs(EventHandlerArgs.self).handler
        held.forEach { channel?.send($0) }
        held.removeAll()
        invoke.resolve()
    }

    @objc func call(_ invoke: Invoke) {
        let args = (try? JSONSerialization.jsonObject(with: Data(invoke.getRawArgs().utf8))) as? [String: Any] ?? [:]
        let plugin = args["plugin"] as? String ?? ""
        let method = args["method"] as? String ?? ""
        let options = args["options"] as? [String: Any] ?? [:]

        Task { @MainActor in
            do {
                invoke.resolve(try await self.answer(plugin, method, options))
            } catch let failure as Failure {
                invoke.reject(failure.message, code: failure.code)
            } catch {
                invoke.reject(error.localizedDescription, code: "failed")
            }
        }
    }

    @MainActor private func answer(_ plugin: String, _ method: String, _ options: [String: Any]) async throws -> JsonObject {
        switch (plugin, method) {
        case ("SplashScreen", "hide"):
            return [:]
        case ("Keyboard", "setAccessoryBarVisible"):
            AccessoryBar.hide(in: webview, (options["isVisible"] as? Bool) == false)
            return [:]
        case ("Keyboard", "reset"):
            KeyboardState.reset(in: webview)
            return [:]
        case ("StatusBar", "setStyle"):
            StatusBar.style = options["style"] as? String == "LIGHT" ? .darkContent : .lightContent
            return [:]
        case ("Badge", "checkPermissions"):
            return ["display": await badgePermission()]
        case ("Badge", "requestPermissions"):
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.badge])
            return ["display": await badgePermission()]
        case ("Badge", "set"):
            try await UNUserNotificationCenter.current().setBadgeCount(max(0, options["count"] as? Int ?? 0))
            return [:]
        case ("Badge", "clear"):
            try await UNUserNotificationCenter.current().setBadgeCount(0)
            return [:]
        case ("Power", "status"):
            return ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
        case ("LocalNotifications", _) where Notifications.methods.contains(method):
            return try await notifications.call(method, options)
        case ("AppleTranslate", _) where AppleTranslate.methods.contains(method):
            return try await appleTranslate.call(method, options, host: prepareHost)
        default:
            throw Failure(code: "unimplemented", message: "\(plugin).\(method) is not implemented")
        }
    }

    /// AppleTranslate's `prepare` question: its 1×1 SwiftUI view as a child of
    /// the web view's controller, so the system's download sheet has a view
    /// controller to present from.
    private var prepareHost: PrepareHost {
        { [weak self] view in
            guard let parent = self?.presenter else { return nil }
            let controller = UIHostingController(rootView: view)
            controller.view.backgroundColor = .clear
            controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
            controller.view.isUserInteractionEnabled = false
            parent.addChild(controller)
            parent.view.addSubview(controller.view)
            controller.didMove(toParent: parent)
            return {
                controller.willMove(toParent: nil)
                controller.view.removeFromSuperview()
                controller.removeFromParent()
            }
        }
    }

    /// The web view's own view controller, for a sheet the system shows over
    /// the page (AppleTranslate's `prepare`).
    private var presenter: UIViewController? {
        var responder: UIResponder? = webview
        while let next = responder {
            if let controller = next as? UIViewController {
                return controller
            }
            responder = next.next
        }
        return webview?.window?.rootViewController
    }

    private func badgePermission() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().badgeSetting {
        case .enabled: return "granted"
        case .disabled: return "denied"
        default: return "prompt"
        }
    }

    func emit(_ plugin: String, _ event: String, _ data: [String: Any], retain: Bool) {
        let payload: JsonObject = ["plugin": plugin, "event": event, "data": data, "retain": retain]
        DispatchQueue.main.async {
            if let channel = self.channel {
                channel.send(payload)
            } else {
                self.held.append(payload)
            }
        }
    }
}

/// The status bar's text colour. The view controller Tauri puts the web view
/// in is wry's, so its `preferredStatusBarStyle` is not ours to override:
/// its class gets one that reads this, swapped in once.
enum StatusBar {
    static var style: UIStatusBarStyle = .default {
        didSet {
            DispatchQueue.main.async { install() }
        }
    }

    private static var installed: Set<String> = []

    private static func install() {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows {
            guard let root = window.rootViewController else { continue }
            let cls: AnyClass = type(of: root)
            let name = NSStringFromClass(cls)
            if !installed.contains(name) {
                let block: @convention(block) (AnyObject) -> Int = { _ in StatusBar.style.rawValue }
                let imp = imp_implementationWithBlock(block)
                let selector = #selector(getter: UIViewController.preferredStatusBarStyle)
                if let method = class_getInstanceMethod(UIViewController.self, selector) {
                    class_replaceMethod(cls, selector, imp, method_getTypeEncoding(method))
                }
                installed.insert(name)
            }
            root.setNeedsStatusBarAppearanceUpdate()
        }
    }
}

/// iOS's form accessory bar (˄ ˅ Done) above the keyboard: the page has
/// nothing for it to step between (client/js/helpers/viewport.ts). WebKit's
/// content view answers `inputAccessoryView`; a subclass of it made at run
/// time answers nil.
enum AccessoryBar {
    private static var noBarClass: AnyClass?

    @MainActor static func hide(in webview: WKWebView?, _ hide: Bool) {
        guard hide,
              let content = webview?.scrollView.subviews.first(where: {
                  NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
              })
        else { return }

        if noBarClass == nil {
            let base: AnyClass = type(of: content)
            let name = NSStringFromClass(base) + "_SeanceNoBar"
            if let cls = objc_allocateClassPair(base, name, 0) {
                let block: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
                let selector = #selector(getter: UIResponder.inputAccessoryView)
                if let method = class_getInstanceMethod(UIView.self, selector) {
                    class_addMethod(cls, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
                }
                objc_registerClassPair(cls)
                noBarClass = cls
            } else {
                noBarClass = NSClassFromString(name)
            }
        }

        if let cls = noBarClass {
            object_setClass(content, cls)
        }
    }
}

/// The keyboard's own state (shift, the QuickType suggestion row) after the
/// page empties the composer with `value = ""`: WebKit does not tell the
/// keyboard about a script's edit, so it keeps what it had for the text that
/// was there, and its suggestion row can stay up empty, a blank band over the
/// keys (client/components/ChatInput.vue clearInput). Reloading the first
/// responder's input views has the keyboard read the field again, without
/// taking the keyboard down.
enum KeyboardState {
    @MainActor static func reset(in webview: WKWebView?) {
        guard let content = webview?.scrollView.subviews.first(where: {
            NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
        }), content.isFirstResponder
        else { return }

        content.reloadInputViews()
    }
}

@_cdecl("init_plugin_seance")
public func initPlugin() -> Plugin {
    SeancePlugin()
}
