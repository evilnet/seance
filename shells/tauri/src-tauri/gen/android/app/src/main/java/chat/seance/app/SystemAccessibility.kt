package chat.seance.app

import android.app.UiModeManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.TypedValue
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/**
 * `SystemAccessibility`: Android's contrast, animation and font-size
 * settings, raw, for client/js/helpers/systemAccessibility.ts, which turns
 * the first two into the page's Increase Contrast and Reduce Motion with
 * Chromium's own rule, and helpers/systemTextSize.ts, which scales the
 * interface by the font size (SeancePlugin pins the WebView's own text zoom
 * at 100%).
 *
 * The WebView would answer `prefers-contrast` and `prefers-reduced-motion`
 * itself, but only with the values its process started with (Chromium
 * watches them in WebView only behind a flag that is off by default), and
 * [ConnectionService] keeps the process for as long as the user stays
 * connected. So the shell watches them and tells the page.
 *
 * - `status()`: `{highTextContrast, contrast, animatorDurationScale, fontScale, powerSave}`,
 *   where `fontScale` is body text's (16sp) over its default size: Android
 *   14's nonlinear font scaling grows large text less than the raw
 *   `Configuration.fontScale` says, and `powerSave`, whether battery saver
 *   is on (the ps scene's Auto does less).
 * - event `changed`: the same, whenever one of them changes.
 */
class SystemAccessibility(private val plugin: SeancePlugin) : SeancePlugin.Handler {
    private val context: Context = plugin.context
    private var fontScale = context.resources.configuration.fontScale
    private val changed = { plugin.emit("SystemAccessibility", "changed", status()) }

    private val settingsObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean, uri: Uri?) = changed()
    }
    private val contrastListener: Any? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            UiModeManager.ContrastChangeListener { changed() }
        } else {
            null
        }
    private val powerSaveReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = changed()
    }

    init {
        val resolver = context.contentResolver
        resolver.registerContentObserver(Settings.Secure.getUriFor(HIGH_TEXT_CONTRAST), false, settingsObserver)
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            settingsObserver,
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            uiModeManager().addContrastChangeListener(
                context.mainExecutor,
                contrastListener as UiModeManager.ContrastChangeListener,
            )
        }

        context.registerReceiver(powerSaveReceiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    }

    override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
        if (method != "status") {
            return false
        }
        invoke.resolve(status())
        return true
    }

    /** The activity declares fontScale, so it is not relaunched: it hears the change here. */
    fun configurationChanged(newConfig: Configuration) {
        if (newConfig.fontScale != fontScale) {
            fontScale = newConfig.fontScale
            changed()
        }
    }

    fun destroy() {
        context.contentResolver.unregisterContentObserver(settingsObserver)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            uiModeManager().removeContrastChangeListener(contrastListener as UiModeManager.ContrastChangeListener)
        }

        context.unregisterReceiver(powerSaveReceiver)
    }

    private fun status(): JSObject {
        val resolver = context.contentResolver
        val result = JSObject()
        result.put("highTextContrast", Settings.Secure.getInt(resolver, HIGH_TEXT_CONTRAST, 0))
        result.put(
            "contrast",
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                uiModeManager().contrast.toDouble()
            } else {
                0.0
            },
        )
        result.put(
            "animatorDurationScale",
            Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f).toDouble(),
        )
        result.put("fontScale", bodyTextScale().toDouble())
        result.put("powerSave", powerManager().isPowerSaveMode)
        return result
    }

    /** 16sp in dp over 16: TypedValue applies the system's FontScaleConverter from Android 14 on. */
    private fun bodyTextScale(): Float {
        val metrics = context.resources.displayMetrics
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 16f, metrics) /
            TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 16f, metrics)
    }

    private fun powerManager() = context.getSystemService(Context.POWER_SERVICE) as PowerManager

    private fun uiModeManager() = context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager

    companion object {
        /** Settings.Secure.ACCESSIBILITY_HIGH_TEXT_CONTRAST_ENABLED, hidden from the SDK. */
        private const val HIGH_TEXT_CONTRAST = "high_text_contrast_enabled"
    }
}
