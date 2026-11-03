import Foundation
import UserNotifications

/// A refused call: the page's `NativeCallError` reads both.
public struct Failure: Error {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// `LocalNotifications` on iOS and macOS: the page's message alerts
/// (client/js/helpers/nativeAlerts.ts), handed to the system, which owns the
/// banner and the sound. One code path for the page on both:
///
/// - `checkPermissions()`, `requestPermissions()`: `{display}` — `granted`,
///   `denied` or `prompt`. The request asks for alerts, sounds and the badge
///   at once.
/// - `schedule({notifications: [{id, title, body, sound?, extra?}]})`: shown
///   at once. An alert with an `id` already shown replaces it. `sound` is a
///   path in the app bundle (`public/audio/pop.wav`); without one, silent.
/// - `removeDeliveredNotifications({notifications: [{id}]})`.
/// - event `localNotificationActionPerformed`
///   `{actionId: "tap", notification: {id, title, body, extra}}` when one is
///   clicked, held until the page listens (a click may launch the app).
///
/// Shown in the foreground too, as the plugin does. A process outside an app
/// bundle (`cargo run`) has no notification center —
/// asking for it aborts — so there every method answers `unsupported`.
public final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    public static let methods = ["checkPermissions", "requestPermissions", "schedule", "removeDeliveredNotifications"]

    private let center: UNUserNotificationCenter?
    private let tapped: ([String: Any]) -> Void

    public init(tapped: @escaping ([String: Any]) -> Void) {
        center = Bundle.main.bundleURL.pathExtension == "app" ? .current() : nil
        self.tapped = tapped
        super.init()
        center?.delegate = self
    }

    public func call(_ method: String, _ options: [String: Any]) async throws -> [String: Any] {
        guard let center else {
            throw Failure(code: "unsupported", message: "no notifications outside an app bundle")
        }

        switch method {
        case "checkPermissions":
            return ["display": await display(center)]
        case "requestPermissions":
            _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            return ["display": await display(center)]
        case "schedule":
            for alert in options["notifications"] as? [[String: Any]] ?? [] {
                try await show(alert, on: center)
            }
            return [:]
        default:
            let ids = (options["notifications"] as? [[String: Any]] ?? []).compactMap(Self.id)
            center.removeDeliveredNotifications(withIdentifiers: ids)
            return [:]
        }
    }

    private func display(_ center: UNUserNotificationCenter) async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: return "prompt"
        case .denied: return "denied"
        default: return "granted"
        }
    }

    private func show(_ alert: [String: Any], on center: UNUserNotificationCenter) async throws {
        guard let id = Self.id(alert) else {
            throw Failure(code: "badRequest", message: "a notification needs an id")
        }
        let content = UNMutableNotificationContent()
        content.title = alert["title"] as? String ?? ""
        content.body = alert["body"] as? String ?? ""
        if let extra = alert["extra"] {
            content.userInfo = ["extra": extra]
        }
        if let sound = alert["sound"] as? String, !sound.isEmpty {
            content.sound = UNNotificationSound(named: Self.bundled(sound))
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try await center.add(request)
    }

    /// The sound's path in the build (`public/audio/pop.wav`) as it sits in
    /// the app: Tauri bundles it under `assets/` on iOS (tauri.ios.conf.json)
    /// and under `Resources/` on macOS, which is the bundle's root for this.
    private static func bundled(_ path: String) -> UNNotificationSoundName {
        #if os(iOS)
        UNNotificationSoundName("assets/" + path)
        #else
        UNNotificationSoundName(path)
        #endif
    }

    /// The page's id (a number) as the request's identifier.
    private static func id(_ alert: [String: Any]) -> String? {
        (alert["id"] as? NSNumber).map { $0.stringValue }
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        done([.banner, .list, .sound, .badge])
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler done: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            let request = response.notification.request
            var notification: [String: Any] = [
                "id": Int(request.identifier) ?? -1,
                "title": request.content.title,
                "body": request.content.body,
            ]
            notification["extra"] = request.content.userInfo["extra"]
            tapped(["actionId": "tap", "notification": notification])
        }
        done()
    }
}
