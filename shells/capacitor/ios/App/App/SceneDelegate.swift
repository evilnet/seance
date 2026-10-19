import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Registers the plugins that live in the app target itself.
class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PowerPlugin())
    }
}

/// `Power`: Low Power Mode, for the ps scene's Auto (client/js/themeScene.ts).
/// WebKit holds a Safari page to 30 fps in Low Power Mode but not this web
/// view (measured 2026-10-17), so the shell has to say it.
///
/// - `status()`: `{lowPower}`.
/// - event `changed`: the same, whenever it changes.
class PowerPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PowerPlugin"
    let jsName = "Power"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(powerStateChanged),
            name: .NSProcessInfoPowerStateDidChange,
            object: nil
        )
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }

    /// Posted on an arbitrary thread.
    @objc private func powerStateChanged() {
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        DispatchQueue.main.async {
            self.notifyListeners("changed", data: ["lowPower": lowPower])
        }
    }
}
