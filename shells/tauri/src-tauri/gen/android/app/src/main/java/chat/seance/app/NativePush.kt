package chat.seance.app

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush

/**
 * `NativePush`, the page's Push API in the Android shell
 * (client/js/helpers/nativePush.ts), as the Capacitor shell's
 * NativePushPlugin answers it. The WebView has no PushManager, so a
 * subscription here is a UnifiedPush registration ([PushService]), one per
 * network, made with that network's VAPID key — and it hands the page the
 * same `{endpoint, keys}` a browser would, which webpush.ts REGISTERs with
 * the ircd unchanged.
 *
 * - `status()`: `{available, permission}` — available = a distributor is
 *   there (the embedded FCM one needs Google Play services); permission =
 *   "granted" | "denied" | "prompt". Refused once is "denied".
 * - `subscribe({network, name, vapid})`: asks for POST_NOTIFICATIONS on 13+,
 *   picks the distributor, registers, and resolves `{endpoint, keys}`. A
 *   rejection's code says why: `denied`, `cancelled`, `unavailable`, `failed`.
 * - `subscription({network})`: the stored one, or `{endpoint: null}`.
 * - `unsubscribe({network})`, `clear({network?, target?})`.
 * - `seen({msgid})`: the page took this message while the user was looking
 *   at it; its push shows nothing ([PushSeen]).
 * - `show({network, conversation, from, text, msgid?, time?, notice, silent})`:
 *   the page's own alert for a message, shown as a push for it would be.
 * - `askPermission()`: `{permission}`, asking while it is undecided.
 * - `takeTap()` / event `tap`: `{network, target}` of a tapped notification.
 *   The event is retained until the page listens (src/lib.rs `emit`), so
 *   `takeTap` has nothing left to hand over.
 * - event `endpoint`: `{network}` — the distributor changed or dropped a
 *   network's endpoint on its own; the page re-reads and re-registers.
 */
class NativePush(private val plugin: SeancePlugin) : SeancePlugin.Handler {
    private val context = plugin.context

    init {
        instance = this
        dropUnreadableRegistrations()
    }

    override fun call(method: String, options: JSObject, invoke: Invoke): Boolean {
        when (method) {
            "takeTap" -> {
                val result = JSObject()
                result.put("tap", JSONObject.NULL)
                invoke.resolve(result)
            }
            "status" -> {
                val result = JSObject()
                result.put("available", available())
                result.put("permission", permission())
                invoke.resolve(result)
            }
            "subscribe" ->
                when {
                    !available() -> invoke.reject("no UnifiedPush distributor on this device", "unavailable")
                    permission() != "granted" -> plugin.askNotifications(invoke) { subscribeAnswered(it) }
                    else -> register(invoke)
                }
            "subscription" -> subscription(options, invoke)
            "unsubscribe" -> unsubscribe(options, invoke)
            "seen" -> {
                val msgid = options.getString("msgid", null)
                if (!msgid.isNullOrEmpty()) {
                    PushService.recordSeen(context, msgid)
                }
                invoke.resolve()
            }
            "show" -> show(options, invoke)
            "askPermission" ->
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || permission() != "prompt") {
                    invoke.resolve(permissionResult())
                } else {
                    plugin.askNotifications(invoke) { askAnswered(it) }
                }
            "clear" -> {
                val network = options.getString("network", null)
                val target = options.getString("target", null)
                if (network != null && target != null) {
                    PushService.cancel(context, network, target)
                } else {
                    PushService.cancelAll(context, network)
                }
                invoke.resolve()
            }
            else -> return false
        }
        return true
    }

    /** SeancePlugin's permission callback for `subscribe`. */
    fun subscribeAnswered(invoke: Invoke) {
        if (permission() != "granted") {
            invoke.reject("notification permission refused", "denied")
            return
        }
        register(invoke)
    }

    /** SeancePlugin's permission callback for `askPermission`. */
    fun askAnswered(invoke: Invoke) {
        invoke.resolve(permissionResult())
    }

    fun destroy() {
        if (instance === this) {
            instance = null
        }
    }

    /**
     * A build before [PushVapid] handed the connector whatever key the page
     * gave; one it refuses is stored all the same and makes it throw each
     * time it reads that registration again. Such a registration goes, with
     * its subscription; the page sees it gone and asks the network to forget it.
     */
    private fun dropUnreadableRegistrations() {
        for (network in PushSubscriptions.networks(context)) {
            val given = PushSubscriptions.connectorKey(context, network)
            val vapid = PushSubscriptions.vapid(context, network)
            if (given == null && vapid != null && !PushVapid.connectorAccepts(vapid.replace("=", ""))) {
                Log.w(TAG, "dropping a registration made with a key the connector refuses")
                UnifiedPush.unregister(context, network)
                PushSubscriptions.remove(context, network)
            }
        }
    }

    private fun register(invoke: Invoke) {
        val options = invoke.getArgs().optJSONObject("options") ?: JSONObject()
        val network = options.optString("network").ifEmpty { null }
        val vapid = options.optString("vapid").ifEmpty { null }

        if (network == null || vapid == null) {
            invoke.reject("network and vapid are required", "failed")
            return
        }

        // Refused before anything is stored: a key the connector cannot take
        // would be kept by it and crash the app (PushVapid).
        val connectorKey = PushVapid.forConnector(vapid)
        if (connectorKey == null) {
            invoke.reject("the network's push key is not a P-256 public key", "failed")
            return
        }

        PushSubscriptions.setName(context, network, options.optString("name").ifEmpty { null })
        main.post { start(network, vapid, connectorKey, invoke) }
    }

    /** On the main thread. */
    private fun start(network: String, vapid: String, connectorKey: String, answer: Invoke) {
        waiting.put(network, answer)?.reject("superseded", "cancelled")

        val renewing = PushSubscriptions.has(context, network)

        // Armed before the distributor is chosen: the connector keeps the
        // chooser's callback in one static field, which a second chooser
        // replaces and a chooser closed without a result never calls.
        main.postDelayed({
            choosing.remove(answer)
            if (waiting[network] !== answer) {
                return@postDelayed // answered, superseded or withdrawn
            }
            waiting.remove(network)
            answer.reject("timed out waiting for the push endpoint", "failed")
            // A first registration the page has given up on would be owned by
            // nothing if it completed later: drop it. A renewal is left to
            // finish; its endpoint reaches the page as `endpoint`.
            if (!renewing) {
                UnifiedPush.unregister(context, network)
                PushSubscriptions.remove(context, network)
            }
        }, REGISTER_TIMEOUT_MS)

        // One chooser at a time: a second would take the first's callback.
        val asking = choosing.isEmpty()
        choosing[answer] = { ok -> distributorChosen(network, vapid, connectorKey, answer, ok) }
        if (!asking) {
            return
        }
        UnifiedPush.tryUseCurrentOrDefaultDistributor(plugin.activity) { ok ->
            main.post {
                val chosen = choosing.values.toList()
                choosing.clear()
                chosen.forEach { it(ok) }
            }
        }
    }

    /** On the main thread. */
    private fun distributorChosen(network: String, vapid: String, connectorKey: String, answer: Invoke, ok: Boolean) {
        if (waiting[network] !== answer) {
            return // timed out, superseded or withdrawn meanwhile
        }
        if (!ok) {
            waiting.remove(network)
            answer.reject("no UnifiedPush distributor chosen", "unavailable")
            return
        }

        // The VAPID key binds the endpoint to this network's server: FCM only
        // accepts pushes signed with it.
        PushSubscriptions.setVapid(context, network, vapid, connectorKey)
        try {
            UnifiedPush.register(context, network, null, connectorKey)
        } catch (e: Exception) {
            // The connector throws (VapidNotValidException) after it has
            // stored the registration: whatever it kept goes.
            Log.w(TAG, "could not register", e)
            waiting.remove(network)
            UnifiedPush.unregister(context, network)
            PushSubscriptions.remove(context, network)
            answer.reject("could not register: $e", "failed")
            notifyEndpoint(network)
        }
    }

    private fun subscription(options: JSObject, invoke: Invoke) {
        val network = options.getString("network", null)
        val sub = network?.let { PushSubscriptions.get(context, it) }

        if (sub == null) {
            val none = JSObject()
            none.put("endpoint", JSONObject.NULL)
            invoke.resolve(none)
            return
        }
        invoke.resolve(JSObject.fromJSONObject(sub))
    }

    private fun unsubscribe(options: JSObject, invoke: Invoke) {
        val network = options.getString("network", null)
        if (network == null) {
            invoke.resolve()
            return
        }
        // On the main thread, in one step, like everything that reads
        // `waiting`: a distributorChosen already queued runs either before
        // this or after it, never in between.
        main.post {
            waiting.remove(network)?.reject("unsubscribed", "cancelled")
            // Withdrawn first: an endpoint already on its way is then dropped
            // (PushService.onNewEndpoint).
            PushSubscriptions.remove(context, network)
            UnifiedPush.unregister(context, network)
            PushService.cancelAll(context, network)
            invoke.resolve()
        }
    }

    private fun show(options: JSObject, invoke: Invoke) {
        val network = options.getString("network", null)
        val conversation = options.getString("conversation", null)
        val from = options.getString("from", null)
        if (network == null || conversation == null || from == null) {
            invoke.reject("network, conversation and from are required", "failed")
            return
        }
        val tags = HashMap<String, String>()
        options.getString("msgid", null)?.let { tags["msgid"] = it }
        options.getString("time", null)?.let { tags["time"] = it }
        val command = if (options.getBoolean("notice", false)) "NOTICE" else "PRIVMSG"
        val line = PushLine(tags, from, command, conversation, options.getString("text", "") ?: "", null)
        PushService.show(context, network, conversation, line, options.getBoolean("silent", false))
        invoke.resolve()
    }

    private fun permissionResult(): JSObject {
        val result = JSObject()
        result.put("permission", permission())
        return result
    }

    private fun available() = UnifiedPush.getDistributors(context).isNotEmpty()

    private fun permission(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
        }
        return when (plugin.getPermissionState("notifications")) {
            PermissionState.GRANTED -> "granted"
            // A refusal Android would still ask about once more is, to the
            // page, a refusal.
            PermissionState.DENIED, PermissionState.PROMPT_WITH_RATIONALE -> "denied"
            else -> "prompt"
        }
    }

    companion object {
        private const val TAG = "SeancePush"
        private const val REGISTER_TIMEOUT_MS = 30_000L

        // The permission and distributor callbacks and PushService's reports
        // run on other threads: the state below is touched on the main
        // thread only, and everything that reaches it is posted there.
        private val main = Handler(Looper.getMainLooper())
        private var instance: NativePush? = null

        /** subscribe() calls waiting for their endpoint, by network. */
        private val waiting = HashMap<String, Invoke>()

        /**
         * subscribe() calls waiting for the distributor to be chosen, in
         * order: the first asks the connector and its answer goes to all.
         */
        private val choosing = LinkedHashMap<Invoke, (Boolean) -> Unit>()

        /** From SeancePlugin: an intent that may be a notification tap. */
        fun onIntent(intent: Intent?) {
            val action = intent?.action ?: return
            if (!action.startsWith(PushService.ACTION_TAP + "\n")) {
                return
            }

            // Consumed: an activity recreated with this intent must not open
            // the conversation again.
            intent.action = null

            // Relaunched from Recents after the process died: Android hands
            // back the intent that started the task, which is this old tap.
            if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
                return
            }

            // Tapped, so gone from the shade (auto-cancel).
            PushService.forget(action.substring(PushService.ACTION_TAP.length + 1))

            val tap = JSObject()
            tap.put("network", intent.getStringExtra("network"))
            tap.put("target", intent.getStringExtra("target"))
            SeancePlugin.instance?.emit("NativePush", "tap", tap, retain = true)
        }

        /** From PushService: a registration finished, with its subscription or why not. */
        @JvmStatic
        fun registrationDone(network: String, subscription: JSONObject?, failure: String?) {
            main.post {
                val call = waiting.remove(network)
                if (call == null) {
                    // Nobody asked: the distributor renewed the endpoint by itself.
                    notifyEndpoint(network)
                    return@post
                }
                if (subscription == null) {
                    call.reject(failure ?: "registration failed", "failed")
                    return@post
                }
                call.resolve(JSObject.fromJSONObject(subscription))
            }
        }

        /** From PushService: the distributor dropped a network's registration. */
        @JvmStatic
        fun unregistered(network: String) {
            main.post { notifyEndpoint(network) }
        }

        private fun notifyEndpoint(network: String) {
            val data = JSObject()
            data.put("network", network)
            instance?.plugin?.emit("NativePush", "endpoint", data)
        }
    }
}
