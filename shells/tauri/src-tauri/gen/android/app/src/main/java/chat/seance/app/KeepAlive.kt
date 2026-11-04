package chat.seance.app

import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/**
 * `KeepAlive`, the page's handle on [ConnectionService]
 * (client/js/helpers/keepAlive.ts).
 *
 * - `enable({quiet})`: start the service. On Android 13+ a foreground
 *   service's notification needs POST_NOTIFICATIONS; the first enable asks
 *   for it, and `quiet: true` (the boot-time re-apply of the stored setting)
 *   never does. The service starts whatever the answer — denied, the
 *   notification is simply not shown and `status().notifications` says so.
 * - `disable()`: stop it.
 * - `status()`: `{running, notifications}`.
 * - event `stopped`: the user pressed the notification's "Turn off".
 */
class KeepAlive(private val plugin: SeancePlugin) : SeancePlugin.Handler {
    init {
        ConnectionService.onStoppedByUser = Runnable { plugin.emit("KeepAlive", "stopped") }
    }

    override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
        when (method) {
            "enable" ->
                if (!options.getBoolean("quiet", false) && !plugin.notificationsAllowed()) {
                    plugin.askNotifications(invoke) { start(it) }
                } else {
                    start(invoke)
                }
            "disable" -> {
                ConnectionService.stop(plugin.context)
                invoke.resolve(status())
            }
            "status" -> invoke.resolve(status())
            else -> return false
        }
        return true
    }

    fun start(invoke: Invoke) {
        ConnectionService.start(plugin.context)
        invoke.resolve(status())
    }

    /**
     * The activity is going away. Only a configuration change it does not
     * declare brings it straight back with its WebView — any other destroy
     * takes the connections with it, so the service has nothing left to keep.
     */
    fun destroy(changingConfigurations: Boolean) {
        // Dropped first either way: the static outlives this instance and
        // would hold the plugin, the activity and the WebView behind it.
        ConnectionService.onStoppedByUser = null

        if (!changingConfigurations) {
            ConnectionService.stop(plugin.context)
        }
    }

    private fun status(): JSObject {
        val result = JSObject()
        result.put("running", ConnectionService.running)
        result.put("notifications", plugin.notificationsAllowed())
        return result
    }
}
