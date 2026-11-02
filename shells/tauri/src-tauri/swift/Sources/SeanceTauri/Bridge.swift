import Foundation

// The macOS shell's Swift (Notifications.swift), reached from Rust
// (src/apple.rs) through two C entry points:
//
// - `seance_apple_start(event)`, once at setup: makes the plugin and gives it
//   `event(plugin, name, json, retain)` for what it tells the page, on the
//   main thread (`retain`: a click on an alert, held until the page listens).
// - `seance_apple_call(plugin, method, options, context, done)`: the options
//   as JSON in, `{"ok": result}` or `{"err": {code, message}}` as JSON out,
//   through `done(context, json)`, which may come on any thread.

public typealias SeanceAppleDone = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>) -> Void
public typealias SeanceAppleEvent = @convention(c) (UnsafePointer<CChar>, UnsafePointer<CChar>, UnsafePointer<CChar>, Bool) -> Void

/// A refused call: the page's `NativeCallError` reads both.
struct Failure: Error {
    let code: String
    let message: String
}

@_cdecl("seance_apple_start")
public func seanceAppleStart(_ event: SeanceAppleEvent) {
    Shared.notifications = Notifications { data in
        let json = String(decoding: encode(data), as: UTF8.self)
        "LocalNotifications".withCString { p in
            "localNotificationActionPerformed".withCString { n in json.withCString { d in event(p, n, d, true) } }
        }
    }
}

@_cdecl("seance_apple_call")
public func seanceAppleCall(
    _ plugin: UnsafePointer<CChar>,
    _ method: UnsafePointer<CChar>,
    _ options: UnsafePointer<CChar>,
    _ context: UnsafeMutableRawPointer?,
    _ done: SeanceAppleDone
) {
    let plugin = String(cString: plugin)
    let method = String(cString: method)
    let json = String(cString: options)
    let answer: (Any) -> Void = { value in
        String(decoding: encode(value), as: UTF8.self).withCString { done(context, $0) }
    }
    let reject: (String, String) -> Void = { code, message in answer(["err": ["code": code, "message": message]]) }

    guard plugin == "LocalNotifications", Notifications.methods.contains(method) else {
        reject("unimplemented", "\(plugin).\(method) is not implemented")
        return
    }
    guard let notifications = Shared.notifications else {
        reject("unavailable", "the plugin has not started")
        return
    }
    guard let options = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else {
        reject("badRequest", "options must be a JSON object")
        return
    }

    Task {
        do {
            answer(["ok": try await notifications.call(method, options)])
        } catch let failure as Failure {
            reject(failure.code, failure.message)
        } catch {
            reject("failed", error.localizedDescription)
        }
    }
}

private func encode(_ value: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: value))
        ?? Data("{\"err\":{\"code\":\"failed\",\"message\":\"unencodable\"}}".utf8)
}

private enum Shared {
    static var notifications: Notifications?
}
