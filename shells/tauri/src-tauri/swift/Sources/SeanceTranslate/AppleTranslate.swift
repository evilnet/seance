import SeanceNotifications
import SwiftUI
import Translation

/// `AppleTranslate`: Apple's Translation framework for the page's translator
/// (client/js/translate/engines/apple.ts), so a line is translated by the
/// system's own language packs instead of a model the page downloads.
/// The iOS shell's SeancePlugin and the macOS shell's Bridge.swift hand it
/// every `AppleTranslate` method; each brings its own `PrepareHost`, the one
/// part that needs the platform's windows.
///
/// - `availability({from, to, strategy?})`: `{status}` — `installed`,
///   `supported` (the pair exists, its pack is not downloaded) or
///   `unsupported`.
/// - `translate({lines, from, to, strategy?, skip?})`: `{lines}`, one
///   translation per line, in order. `skip` marks every `⟦n⟧` placeholder
///   `skipsTranslation`, so the engine never sees inside one (26.4+).
/// - `prepare({from, to, strategy?})`: asks the user to download the pair's
///   pack in the system's own sheet, then `{status}` as `availability` says it,
///   with `error` and `message` when the sheet ended without the pack.
/// - `languages()`: `{languages}`, the language codes (ISO 639) the framework
///   translates, once each.
///
/// `strategy` is `low` (the default: the downloaded packs, ~80 ms a line) or
/// `high` (Apple's on-device 3B model, 13–27× slower). Before 26.4 there is no
/// strategy and the session takes the system's default.
///
/// Sessions are made with `installedSource`, which never downloads: a pair
/// without its pack fails with code `notInstalled` until `prepare` has run.
/// The translation daemon serves one request at a time (measured: parallel
/// requests took no less time), so every request waits for the one before.
///
/// Carried over from the Capacitor shell's AppleTranslatePlugin (rdrake,
/// PseudoSean/seance#9); the framework code is unchanged, the plugin glue is
/// the shell's: options in, `Failure` out.
public final class AppleTranslate {
    public static let methods = ["availability", "translate", "prepare", "languages"]

    private let translator = SerialTranslator()

    public init() {}

    public func call(_ method: String, _ options: [String: Any], host: PrepareHost?) async throws -> [String: Any] {
        switch method {
        case "availability":
            let (from, to) = try Self.pair(options)
            return ["status": await Self.status(from: from, to: to, high: Self.high(options))]
        case "translate":
            let (from, to) = try Self.pair(options)
            guard let lines = options["lines"] as? [String] else {
                throw Failure(code: "badRequest", message: "lines must be an array of strings")
            }
            do {
                let out = try await translator.translate(
                    lines, from: from, to: to, high: Self.high(options), skip: options["skip"] as? Bool ?? false
                )
                return ["lines": out]
            } catch {
                let (code, message) = Self.describe(error)
                throw Failure(code: code, message: message)
            }
        case "languages":
            let supported = await LanguageAvailability().supportedLanguages
            var seen = Set<String>()
            let codes = supported.compactMap { $0.languageCode?.identifier }.filter { seen.insert($0).inserted }
            return ["languages": codes.sorted()]
        case "prepare":
            let (from, to) = try Self.pair(options)
            let high = Self.high(options)
            guard let host else {
                throw Failure(code: "noView", message: "no view to present from")
            }
            let error = await Self.askToDownload(from: from, to: to, high: high, host: host)
            let status = await Self.status(from: from, to: to, high: high)
            if let error, status != "installed" {
                let (code, message) = Self.describe(error)
                return ["status": status, "error": code, "message": message]
            }
            return ["status": status]
        default:
            throw Failure(code: "unimplemented", message: "AppleTranslate.\(method) is not implemented")
        }
    }

    /// `.translationTask` hands its action a session that may ask to download
    /// (`canRequestDownloads`), and `prepareTranslation()` is what shows the
    /// sheet. It needs a SwiftUI view in the window, so the shell's host adds a
    /// 1×1 clear one for the length of the question. Answers the sheet's
    /// error, nil when it finished.
    @MainActor
    private static func askToDownload(from: Locale.Language, to: Locale.Language, high: Bool, host: PrepareHost) async -> Error? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Error?, Never>) in
            var remove: (() -> Void)?
            var answered = false
            let finish: (Error?) -> Void = { error in
                DispatchQueue.main.async {
                    remove?()
                    remove = nil
                    if !answered {
                        answered = true
                        continuation.resume(returning: error)
                    }
                }
            }
            remove = host(AnyView(PrepareView(source: from, target: to, high: high, done: finish)))
            if remove == nil {
                finish(Failure(code: "noView", message: "no window to present from"))
            }
        }
    }

    private static func pair(_ options: [String: Any]) throws -> (Locale.Language, Locale.Language) {
        guard let from = options["from"] as? String, let to = options["to"] as? String else {
            throw Failure(code: "badRequest", message: "from and to are required")
        }
        return (Locale.Language(identifier: from), Locale.Language(identifier: to))
    }

    private static func high(_ options: [String: Any]) -> Bool {
        options["strategy"] as? String == "high"
    }

    static func status(from: Locale.Language, to: Locale.Language, high: Bool) async -> String {
        let availability: LanguageAvailability
        if #available(iOS 26.4, macOS 26.4, *) {
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
        if #available(iOS 26.4, macOS 26.4, *) {
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
            if skip, #available(iOS 26.4, macOS 26.4, *) {
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
/// URLs, code and line prefixes (client/js/translate/spans.ts). The `#/…/#`
/// literal, not a bare `/…/` one: this package builds in Swift 5 mode, where
/// a bare regex literal needs a compiler flag.
@available(iOS 26.4, macOS 26.4, *)
func protectPlaceholders(_ line: String) -> AttributedString {
    var text = AttributedString(line)
    for match in line.matches(of: #/⟦[0-9]+⟧/#) {
        if let lo = AttributedString.Index(match.range.lowerBound, within: text),
           let hi = AttributedString.Index(match.range.upperBound, within: text) {
            text[lo..<hi].translation.skipsTranslation = true
        }
    }
    return text
}

/// Puts a SwiftUI view into the app's window for the length of the download
/// question (`prepare`) and answers how to take it out again, or nil when
/// there is no window to put it in. UIKit's on iOS (SeancePlugin), AppKit's
/// on macOS (Bridge.swift); both run on the main thread.
public typealias PrepareHost = @MainActor (AnyView) -> (() -> Void)?

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
                if #available(iOS 26.4, macOS 26.4, *) {
                    configuration = .init(source: source, target: target, preferredStrategy: high ? .highFidelity : .lowLatency)
                } else {
                    configuration = .init(source: source, target: target)
                }
            }
    }
}
