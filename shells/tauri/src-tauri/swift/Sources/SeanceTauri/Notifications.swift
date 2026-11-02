import Foundation
import UserNotifications

/// `LocalNotifications` on macOS: the page's message alerts
/// (client/js/helpers/nativeAlerts.ts), handed to the system, which owns the
/// banner and the sound. Methods and shapes are those of Capacitor's plugin of
/// the same name, which the iOS shell uses, so the page has one code path:
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
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    static let methods = ["checkPermissions", "requestPermissions", "schedule", "removeDeliveredNotifications"]

    private let center: UNUserNotificationCenter?
    private let tapped: ([String: Any]) -> Void

    init(tapped: @escaping ([String: Any]) -> Void) {
        center = Bundle.main.bundleURL.pathExtension == "app" ? .current() : nil
        self.tapped = tapped
        super.init()
        center?.delegate = self
    }

    func call(_ method: String, _ options: [String: Any]) async throws -> [String: Any] {
        guard let center else {
            throw Failure(code: "unsupported", message: "no notifications outside an app bundle")
        }

        switch method {
        case "checkPermissions":
            return ["display": await display(center)]
        case "requestPermissions":
            _ = try await withCheckedThrowingContinuation { (done: CheckedContinuation<Bool, Error>) in
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                    if let error { done.resume(throwing: error) } else { done.resume(returning: granted) }
                }
            }
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
        let settings = await withCheckedContinuation { done in
            center.getNotificationSettings { done.resume(returning: $0) }
        }
        switch settings.authorizationStatus {
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
            content.sound = UNNotificationSound(named: UNNotificationSoundName(sound))
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            }
        }
    }

    /// The page's id (a number) as the request's identifier.
    private static func id(_ alert: [String: Any]) -> String? {
        (alert["id"] as? NSNumber).map { $0.stringValue }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(macOS 11.0, *) {
            done([.banner, .list, .sound, .badge])
        } else {
            done([.alert, .sound, .badge])
        }
    }

    func userNotificationCenter(
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
