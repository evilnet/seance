import Capacitor
import SwiftUI
import Translation
import UIKit

/// `AppleTranslate`: Apple's Translation framework for the page's translator
/// (client/js/translate/engines/apple.ts), so a line is translated by the
/// system's own language packs instead of a model the page downloads.
///
/// - `availability({from, to, strategy?})`: `{status}` — `installed`,
///   `supported` (the pair exists, its pack is not downloaded) or
///   `unsupported`.
/// - `translate({lines, from, to, strategy?, skip?})`: `{lines}`, one
///   translation per line, in order. `skip` marks every `⟦n⟧` placeholder
///   `skipsTranslation`, so the engine never sees inside one (26.4+).
/// - `prepare({from, to, strategy?})`: asks the user to download the pair's
///   pack in the system's own sheet, then `{status}` as `availability` says it.
///
/// `strategy` is `low` (the default: the downloaded packs, ~80 ms a line) or
/// `high` (Apple's on-device 3B model, 13–27× slower). Before 26.4 there is no
/// strategy and the session takes the system's default.
///
/// Sessions are made with `installedSource`, which never downloads: a pair
/// without its pack fails with code `notInstalled` until `prepare` has run.
/// The translation daemon serves one request at a time (measured: parallel
/// requests took no less time), so every request waits for the one before.
class AppleTranslatePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AppleTranslatePlugin"
    let jsName = "AppleTranslate"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
    ]

    private let translator = SerialTranslator()

    @objc func availability(_ call: CAPPluginCall) {
        guard let (from, to) = pair(call) else { return }
        let high = call.getString("strategy") == "high"

        Task {
            call.resolve(["status": await Self.status(from: from, to: to, high: high)])
        }
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard let (from, to) = pair(call) else { return }
        guard let lines = call.getArray("lines") as? [String] else {
            call.reject("lines must be an array of strings", "badRequest")
            return
        }
        let high = call.getString("strategy") == "high"
        let skip = call.getBool("skip") ?? false

        Task {
            do {
                let out = try await translator.translate(lines, from: from, to: to, high: high, skip: skip)
                call.resolve(["lines": out])
            } catch {
                let (code, message) = Self.describe(error)
                call.reject(message, code, error)
            }
        }
    }

    @objc func prepare(_ call: CAPPluginCall) {
        guard let (from, to) = pair(call) else { return }
        let high = call.getString("strategy") == "high"

        DispatchQueue.main.async {
            guard let parent = self.bridge?.viewController else {
                call.reject("no view to present from", "noView")
                return
            }

            // `.translationTask` hands its action a session that may ask to
            // download (`canRequestDownloads`), and `prepareTranslation()` is
            // what shows the sheet. It needs a SwiftUI view in the window, so
            // a 1×1 clear one is added for the length of the question.
            var host: UIHostingController<PrepareView>?
            let view = PrepareView(source: from, target: to, high: high) { error in
                DispatchQueue.main.async {
                    host?.willMove(toParent: nil)
                    host?.view.removeFromSuperview()
                    host?.removeFromParent()
                    host = nil
                }
                Task {
                    let status = await Self.status(from: from, to: to, high: high)
                    if let error, status != "installed" {
                        let (code, message) = Self.describe(error)
                        call.resolve(["status": status, "error": code, "message": message])
                    } else {
                        call.resolve(["status": status])
                    }
                }
            }
            let controller = UIHostingController(rootView: view)
            controller.view.backgroundColor = .clear
            controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
            controller.view.isUserInteractionEnabled = false
            parent.addChild(controller)
            parent.view.addSubview(controller.view)
            controller.didMove(toParent: parent)
            host = controller
        }
    }

    private func pair(_ call: CAPPluginCall) -> (Locale.Language, Locale.Language)? {
        guard let from = call.getString("from"), let to = call.getString("to") else {
            call.reject("from and to are required", "badRequest")
            return nil
        }
        return (Locale.Language(identifier: from), Locale.Language(identifier: to))
    }

    static func status(from: Locale.Language, to: Locale.Language, high: Bool) async -> String {
        let availability: LanguageAvailability
        if #available(iOS 26.4, *) {
            availability = LanguageAvailability(preferredStrategy: high ? .highFidelity : .lowLatency)
        } else {
            availability = LanguageAvailability()
        }
        switch await availability.status(from: from, to: to) {
        case .installed: return "installed"
        case .supported: return "supported"
        case .unsupported: return "unsupported"
        @unknown default: return "unsupported"
        }
    }

    static func describe(_ error: Error) -> (String, String) {
        let code: String
        if TranslationError.notInstalled ~= error {
            code = "notInstalled"
        } else if TranslationError.unsupportedLanguagePairing ~= error
            || TranslationError.unsupportedSourceLanguage ~= error
            || TranslationError.unsupportedTargetLanguage ~= error {
            code = "unsupported"
        } else if TranslationError.nothingToTranslate ~= error {
            code = "nothingToTranslate"
        } else if TranslationError.unableToIdentifyLanguage ~= error {
            code = "unableToIdentifyLanguage"
        } else if error is CancellationError || TranslationError.alreadyCancelled ~= error {
            code = "cancelled"
        } else {
            code = "failed"
        }
        return (code, error.localizedDescription)
    }
}

/// One request at a time, in the order they came, with a session kept per
/// pair and strategy. An actor alone would not do: its methods interleave at
/// every `await`, so each request first waits for the one queued before it.
actor SerialTranslator {
    private var sessions: [String: TranslationSession] = [:]
    private var tail: Task<Void, Never>?

    func translate(_ lines: [String], from: Locale.Language, to: Locale.Language, high: Bool, skip: Bool) async throws -> [String] {
        let previous = tail
        let job = Task { () throws -> [String] in
            await previous?.value
            return try await self.run(lines, from: from, to: to, high: high, skip: skip)
        }
        tail = Task { _ = try? await job.value }
        return try await job.value
    }

    private func session(from: Locale.Language, to: Locale.Language, high: Bool) -> TranslationSession {
        let key = "\(from.maximalIdentifier)>\(to.maximalIdentifier)>\(high)"
        if let session = sessions[key] { return session }
        let session: TranslationSession
        if #available(iOS 26.4, *) {
            session = TranslationSession(installedSource: from, target: to, preferredStrategy: high ? .highFidelity : .lowLatency)
        } else {
            session = TranslationSession(installedSource: from, target: to)
        }
        sessions[key] = session
        return session
    }

    private func run(_ lines: [String], from: Locale.Language, to: Locale.Language, high: Bool, skip: Bool) async throws -> [String] {
        let session = session(from: from, to: to, high: high)
        guard await session.isReady else { throw TranslationError.notInstalled }

        var requests: [TranslationSession.Request] = []
        for (i, line) in lines.enumerated() {
            if skip, #available(iOS 26.4, *) {
                requests.append(TranslationSession.Request(sourceText: protectPlaceholders(line), clientIdentifier: String(i)))
            } else {
                requests.append(TranslationSession.Request(sourceText: line, clientIdentifier: String(i)))
            }
        }

        var out = lines
        do {
            for response in try await session.translations(from: requests) {
                if let id = response.clientIdentifier, let i = Int(id) {
                    out[i] = response.targetText
                }
            }
        } catch {
            // One line the framework will not take fails the whole batch, so
            // the lines go again one at a time. A line with nothing to
            // translate (a placeholder or an emoji alone) stays as it is;
            // any other failure is the request's.
            if TranslationError.notInstalled ~= error { throw error }
            for (i, request) in requests.enumerated() {
                do {
                    out[i] = try await session.translations(from: [request]).first?.targetText ?? lines[i]
                } catch where TranslationError.nothingToTranslate ~= error {
                    out[i] = lines[i]
                }
            }
        }
        return out
    }
}

/// `⟦n⟧` runs marked `skipsTranslation`: the page's placeholders for nicks,
/// URLs, code and line prefixes (client/js/translate/spans.ts).
@available(iOS 26.4, *)
func protectPlaceholders(_ line: String) -> AttributedString {
    var text = AttributedString(line)
    for match in line.matches(of: /⟦[0-9]+⟧/) {
        if let lo = AttributedString.Index(match.range.lowerBound, within: text),
           let hi = AttributedString.Index(match.range.upperBound, within: text) {
            text[lo..<hi].translation.skipsTranslation = true
        }
    }
    return text
}

/// The download question's host: `.translationTask` runs its action once the
/// configuration is set, with a session that may ask the user to download.
struct PrepareView: View {
    let source: Locale.Language
    let target: Locale.Language
    let high: Bool
    let done: (Error?) -> Void
    @State private var configuration: TranslationSession.Configuration?

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .translationTask(configuration) { session in
                do {
                    try await session.prepareTranslation()
                    done(nil)
                } catch {
                    done(error)
                }
            }
            .onAppear {
                if #available(iOS 26.4, *) {
                    configuration = .init(source: source, target: target, preferredStrategy: high ? .highFidelity : .lowLatency)
                } else {
                    configuration = .init(source: source, target: target)
                }
            }
    }
}
