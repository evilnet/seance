package chat.seance.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.PermissionState
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class EventHandlerArgs {
    lateinit var handler: Channel
}

/**
 * Every plugin the page calls on Android (client/js/helpers/shell.ts):
 * src/mobile.rs hands each call here as
 * `{plugin, method, options}`, and events go back through the one channel it
 * set at start. A plugin is a [Handler] in [handlers].
 */
@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class SeancePlugin(val activity: Activity) : Plugin(activity) {
    /** One of the page's plugins. */
    interface Handler {
        /** False for a method it does not have. */
        fun call(method: String, options: JSObject, invoke: Invoke): Boolean
    }

    private var channel: Channel? = null
    private val held = mutableListOf<JSObject>()

    val context: Context get() = activity.applicationContext

    private lateinit var keepAlive: KeepAlive
    private lateinit var accessibility: SystemAccessibility
    private lateinit var push: NativePush
    private var handlers: Map<String, Handler> = emptyMap()

    @Command
    fun setEventHandler(invoke: Invoke) {
        channel = invoke.parseArgs(EventHandlerArgs::class.java).handler
        held.forEach { channel?.send(it) }
        held.clear()
        invoke.resolve()
    }

    @Command
    fun call(invoke: Invoke) {
        val args = invoke.getArgs()
        val plugin = args.getString("plugin")
        val method = args.getString("method")
        val options = args.optJSONObject("options")?.let { JSObject(it.toString()) } ?: JSObject()
        val answered = try {
            handlers[plugin]?.call(method, options, invoke) ?: false
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString(), "failed")
            true
        }

        if (!answered) {
            invoke.reject("$plugin.$method is not implemented", "unimplemented")
        }
    }

    /** Hand the page a plugin's event (src/mobile.rs → emit). */
    fun emit(plugin: String, event: String, data: JSObject = JSObject(), retain: Boolean = false) {
        val payload = JSObject()
        payload.put("plugin", plugin)
        payload.put("event", event)
        payload.put("data", data)
        payload.put("retain", retain)
        channel?.send(payload) ?: held.add(payload)
    }

    override fun load(webView: WebView) {
        super.load(webView)
        instance = this
        keepAlive = KeepAlive(this)
        accessibility = SystemAccessibility(this)
        push = NativePush(this)
        handlers = mapOf(
            "App" to AppHandler(),
            "StatusBar" to BarsHandler(),
            "SystemBars" to BarsHandler(),
            "SplashScreen" to Answers(setOf("hide")),
            "Keyboard" to Answers(setOf("setAccessoryBarVisible")),
            "Badge" to BadgeHandler(),
            "KeepAlive" to keepAlive,
            "SystemAccessibility" to accessibility,
            "NativePush" to push,
        )

        // Android's font size reaches the page as a number instead
        // (SystemAccessibility, client/js/helpers/systemTextSize.ts), which
        // scales the whole interface; the WebView's own text zoom scales
        // glyphs and never rem lengths, so it stays pinned at 100%.
        webView.settings.textZoom = 100

        // The paperclip's picker offers the camera too (UploadChooserClient).
        // wry sets its chrome client after the activity hears of the web
        // view, in the same turn of the main thread: wrap it on the next.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.post {
                val wry = webView.webChromeClient

                if (wry != null && wry !is UploadChooserClient) {
                    webView.webChromeClient = UploadChooserClient(activity as WryActivity, wry)
                }
            }
        }

        // Launched by tapping a push notification. A link is the deep-link
        // plugin's (tauri.conf.json), which hands it to src/lib.rs.
        NativePush.onIntent(activity.intent)

        // The page closes what is open first, and minimizes the app when
        // nothing is left (client/js/native.ts); Android's own back is never
        // taken.
        (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(
            activity,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val data = JSObject()
                    data.put("canGoBack", false)
                    emit("App", "backButton", data)
                }
            },
        )
    }

    /** A push notification tapped while the app was running (singleTask). */
    override fun onNewIntent(intent: Intent) {
        NativePush.onIntent(intent)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        if (this::accessibility.isInitialized) {
            accessibility.configurationChanged(newConfig)
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (!this::keepAlive.isInitialized) {
            return
        }
        keepAlive.destroy(activity.isChangingConfigurations)
        accessibility.destroy()
        push.destroy()
        if (instance === this) {
            instance = null
        }
    }

    /** POST_NOTIFICATIONS, which Android 13+ asks for and older ones grant. */
    fun notificationsAllowed() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState("notifications") == PermissionState.GRANTED

    /** Calls waiting for the POST_NOTIFICATIONS dialog, each with what it does next. */
    private val askingNotifications = mutableListOf<Pair<Invoke, (Invoke) -> Unit>>()

    /**
     * Ask for POST_NOTIFICATIONS, then `answered(invoke)`. Tauri keeps one
     * permission callback at a time, so a second ask while the dialog is up
     * (a mention's push subscribe during keep-alive's) joins the first, and
     * every call waiting is answered when it closes. On the main thread, as
     * every command is.
     */
    fun askNotifications(invoke: Invoke, answered: (Invoke) -> Unit) {
        askingNotifications.add(invoke to answered)
        if (askingNotifications.size == 1) {
            requestPermissionForAliases(arrayOf("notifications"), invoke, "notificationsAnswered")
        }
    }

    @PermissionCallback
    private fun notificationsAnswered(@Suppress("UNUSED_PARAMETER") invoke: Invoke) {
        val waiting = askingNotifications.toList()
        askingNotifications.clear()
        waiting.forEach { (call, answered) -> answered(call) }
    }

    override fun onResume(activity: AppCompatActivity) {
        appState(true)
    }

    override fun onPause(activity: AppCompatActivity) {
        appState(false)
    }

    private fun appState(active: Boolean) {
        val data = JSObject()
        data.put("isActive", active)
        emit("App", "appStateChange", data)
    }

    private inner class AppHandler : Handler {
        override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
            when (method) {
                "minimizeApp" -> activity.moveTaskToBack(true)
                else -> return false
            }
            invoke.resolve()
            return true
        }
    }

    /** `setStyle({style})`: DARK is light text for a dark page. */
    private inner class BarsHandler : Handler {
        override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
            if (method != "setStyle") {
                return false
            }

            val light = options.getString("style") == "LIGHT"
            activity.runOnUiThread {
                val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                bars.isAppearanceLightStatusBars = light
                bars.isAppearanceLightNavigationBars = light
            }
            invoke.resolve()
            return true
        }
    }

    /** A launcher badge is the launcher's own on Android: nothing to set. */
    private inner class BadgeHandler : Handler {
        override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
            when (method) {
                "checkPermissions", "requestPermissions" -> {
                    val data = JSObject()
                    data.put("display", "granted")
                    invoke.resolve(data)
                }
                "set", "clear" -> invoke.resolve()
                else -> return false
            }
            return true
        }
    }

    /** Methods with nothing to do on Android, answered so the page carries on. */
    private class Answers(private val methods: Set<String>) : Handler {
        override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
            if (method !in methods) {
                return false
            }
            invoke.resolve()
            return true
        }
    }

    companion object {
        var instance: SeancePlugin? = null
    }
}
