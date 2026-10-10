package chat.seance.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.util.Log;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import kotlin.Unit;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * `NativePush`, the page's Push API in the Android shell
 * (client/js/helpers/nativePush.ts). The WebView has no PushManager, so a
 * subscription here is a UnifiedPush registration ({@link PushService}),
 * one per network, made with that network's VAPID key — and it hands the
 * page the same `{endpoint, keys}` a browser would, which webpush.ts
 * REGISTERs with the ircd unchanged.
 *
 * - `status()`: `{available, permission}` — available = a distributor is
 *   there (the embedded FCM one needs Google Play services); permission =
 *   "granted" | "denied" | "prompt". Refused once is "denied": the page
 *   stops asking on connect as it does after a browser's denial, although
 *   Android would show its dialog once more (Settings can still grant it).
 * - `subscribe({network, name, vapid})`: asks for POST_NOTIFICATIONS on 13+,
 *   picks the distributor (Android may ask which, when the phone has more
 *   than one), registers, and resolves `{endpoint, keys: {p256dh, auth}}`.
 *   A rejection's code says why: `denied` (the permission was refused),
 *   `cancelled` (unsubscribed, or a later subscribe took over, meanwhile),
 *   `unavailable` (no distributor), `failed` (anything else).
 * - `subscription({network})`: the stored one (with the `vapid` it was made
 *   for), or `{endpoint: null}`.
 * - `unsubscribe({network})`, `clear({network?, target?})`.
 * - `seen({msgid})`: the page took this message while the user was looking
 *   at it; its push shows nothing ({@link PushSeen}).
 * - `takeTap()` / event `tap`: `{network, target}` of a tapped notification.
 * - event `endpoint`: `{network}` — the distributor changed or dropped a
 *   network's endpoint on its own; the page re-reads and re-registers.
 */
@CapacitorPlugin(
    name = "NativePush",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class NativePushPlugin extends Plugin {

    private static final String TAG = "SeancePush";
    private static final long REGISTER_TIMEOUT_MS = 30_000;

    // Plugin methods run on Capacitor's plugin thread, the permission and
    // distributor callbacks and PushService's reports on others: every
    // field below is touched on the main thread only, and everything that
    // reaches them is posted there.
    private static final Handler main = new Handler(Looper.getMainLooper());
    /** The live instance; null between activities. */
    private static NativePushPlugin instance;
    /** A tap that arrived before the page could hear it (a cold start). */
    private static JSObject pendingTap;
    /** subscribe() calls waiting for their endpoint, by network. */
    private static final Map<String, Waiting> waiting = new HashMap<>();
    /**
     * subscribe() calls waiting for the distributor to be chosen, in order:
     * the first asks the connector and its answer goes to all of them.
     */
    private static final Map<Waiting, Consumer<Boolean>> choosing = new LinkedHashMap<>();

    /**
     * A subscribe() call waiting for its endpoint. Answering it lets the
     * bridge go of it too: the permission request saved it with the bridge
     * (Bridge.savePermissionCall), and nothing else ever releases it.
     */
    private static final class Waiting {
        final PluginCall call;
        final Bridge bridge;

        Waiting(PluginCall call, Bridge bridge) {
            this.call = call;
            this.bridge = bridge;
        }

        void resolve(JSObject result) {
            call.resolve(result);
            call.release(bridge);
        }

        /** `code` is what the page tells apart (nativePush.ts): see the class comment. */
        void reject(String message, String code) {
            call.reject(message, code);
            call.release(bridge);
        }

        void reject(String message, Exception e) {
            call.reject(message, e);
            call.release(bridge);
        }
    }

    @Override
    public void load() {
        instance = this;
        dropUnreadableRegistrations();
    }

    /**
     * A build before {@link PushVapid} handed the connector whatever key the
     * page gave; one it refuses is stored all the same and makes it throw
     * each time it reads that registration again (a new endpoint, a
     * message), on the main thread. Such a registration goes, with its
     * subscription; the page sees it gone and asks the network to forget it.
     */
    private void dropUnreadableRegistrations() {
        for (String network : PushSubscriptions.networks(getContext())) {
            String given = PushSubscriptions.connectorKey(getContext(), network);
            String vapid = PushSubscriptions.vapid(getContext(), network);
            if (given == null && vapid != null && !PushVapid.connectorAccepts(vapid.replace("=", ""))) {
                Log.w(TAG, "dropping a registration made with a key the connector refuses");
                UnifiedPush.unregister(getContext(), network);
                PushSubscriptions.remove(getContext(), network);
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
    }

    /** From MainActivity: an intent that may be a notification tap. */
    static void onIntent(Intent intent) {
        if (intent == null || intent.getAction() == null || !intent.getAction().startsWith(PushService.ACTION_TAP + "\n")) {
            return;
        }

        String action = intent.getAction();

        // Consumed: an activity recreated with this intent (a configuration
        // change it does not declare) must not open the conversation again.
        intent.setAction(null);

        // Relaunched from Recents after the process died: Android hands back
        // the intent that started the task, which is this old tap, and
        // setAction(null) above did not outlive the process.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            return;
        }

        // Tapped, so gone from the shade (auto-cancel): a push right after
        // starts the conversation's list over.
        PushService.forget(action.substring(PushService.ACTION_TAP.length() + 1));

        JSObject tap = new JSObject();
        tap.put("network", intent.getStringExtra("network"));
        tap.put("target", intent.getStringExtra("target"));

        if (instance != null && instance.hasListeners("tap")) {
            instance.notifyListeners("tap", tap);
        } else {
            pendingTap = tap;
        }
    }

    /** From PushService: a registration finished, with its subscription or why not. */
    static void registrationDone(String network, JSONObject subscription, String failure) {
        main.post(() -> {
            Waiting call = waiting.remove(network);
            if (call == null) {
                // Nobody asked: the distributor renewed the endpoint by itself.
                notifyEndpoint(network);
                return;
            }
            if (subscription == null) {
                call.reject(failure != null ? failure : "registration failed", "failed");
                return;
            }
            try {
                call.resolve(JSObject.fromJSONObject(subscription));
            } catch (org.json.JSONException e) {
                call.reject("bad subscription", e);
            }
        });
    }

    /** From PushService: the distributor dropped a network's registration. */
    static void unregistered(String network) {
        main.post(() -> notifyEndpoint(network));
    }

    private static void notifyEndpoint(String network) {
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("network", network);
            instance.notifyListeners("endpoint", data);
        }
    }

    @PluginMethod
    public void takeTap(PluginCall call) {
        main.post(() -> {
            JSObject result = new JSObject();
            result.put("tap", pendingTap);
            pendingTap = null;
            call.resolve(result);
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", available());
        result.put("permission", permission());
        call.resolve(result);
    }

    @PluginMethod
    public void subscribe(PluginCall call) {
        if (!available()) {
            call.reject("no UnifiedPush distributor on this device", "unavailable");
            return;
        }
        if (!"granted".equals(permission())) {
            requestPermissionForAlias("notifications", call, "permissionAnswered");
            return;
        }
        register(call);
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        if (!"granted".equals(permission())) {
            new Waiting(call, getBridge()).reject("notification permission refused", "denied");
            return;
        }
        register(call);
    }

    private void register(PluginCall call) {
        Waiting answer = new Waiting(call, getBridge());
        String network = call.getString("network");
        String vapid = call.getString("vapid");

        if (network == null || vapid == null) {
            answer.reject("network and vapid are required", "failed");
            return;
        }

        // Refused before anything is stored: a key the connector cannot
        // take would be kept by it and crash the app (PushVapid).
        String connectorKey = PushVapid.forConnector(vapid);
        if (connectorKey == null) {
            answer.reject("the network's push key is not a P-256 public key", "failed");
            return;
        }

        PushSubscriptions.setName(getContext(), network, call.getString("name"));
        main.post(() -> start(network, vapid, connectorKey, answer));
    }

    /** On the main thread. */
    private void start(String network, String vapid, String connectorKey, Waiting answer) {
        Waiting previous = waiting.put(network, answer);
        if (previous != null) {
            previous.reject("superseded", "cancelled");
        }

        boolean renewing = PushSubscriptions.has(getContext(), network);

        // Armed before the distributor is chosen: the connector keeps the
        // chooser's callback in one static field (LinkActivity), which a
        // second chooser replaces and a chooser closed without a result
        // never calls, so the answer may never come.
        main.postDelayed(() -> {
            // Whatever became of it, it stops holding the chooser: one that
            // never answers is asked again by the next subscribe().
            choosing.remove(answer);
            if (waiting.get(network) != answer) {
                return; // answered, superseded or withdrawn
            }
            waiting.remove(network);
            answer.reject("timed out waiting for the push endpoint", "failed");
            // A first registration the page has given up on would be owned
            // by nothing if it completed later: drop it. A renewal is left
            // to finish; its endpoint reaches the page as a renewal
            // (`endpoint`), with the key it was made for.
            if (!renewing) {
                UnifiedPush.unregister(getContext(), network);
                PushSubscriptions.remove(getContext(), network);
            }
        }, REGISTER_TIMEOUT_MS);

        // One chooser at a time: a second would take the first's callback.
        boolean asking = choosing.isEmpty();
        choosing.put(answer, ok -> distributorChosen(network, vapid, connectorKey, answer, ok));
        if (!asking) {
            return;
        }
        UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), ok -> {
            main.post(() -> {
                ArrayList<Consumer<Boolean>> chosen = new ArrayList<>(choosing.values());
                choosing.clear();
                for (Consumer<Boolean> each : chosen) {
                    each.accept(ok);
                }
            });
            return Unit.INSTANCE;
        });
    }

    /** On the main thread. */
    private void distributorChosen(String network, String vapid, String connectorKey, Waiting answer, boolean ok) {
        if (waiting.get(network) != answer) {
            return; // timed out, superseded or withdrawn meanwhile
        }
        if (!ok) {
            waiting.remove(network);
            answer.reject("no UnifiedPush distributor chosen", "unavailable");
            return;
        }

        // The VAPID key binds the endpoint to this network's server: FCM
        // only accepts pushes signed with it.
        PushSubscriptions.setVapid(getContext(), network, vapid, connectorKey);
        try {
            UnifiedPush.register(getContext(), network, null, connectorKey);
        } catch (Exception e) {
            // Kotlin declares none, but the connector throws checked
            // exceptions (VapidNotValidException) after it has stored the
            // registration: whatever it kept goes, the one this replaced
            // included, so nothing re-reads it later.
            Log.w(TAG, "could not register", e);
            waiting.remove(network);
            UnifiedPush.unregister(getContext(), network);
            PushSubscriptions.remove(getContext(), network);
            answer.reject("could not register: " + e, "failed");
            notifyEndpoint(network);
        }
    }

    @PluginMethod
    public void subscription(PluginCall call) {
        String network = call.getString("network");
        JSONObject sub = network == null ? null : PushSubscriptions.get(getContext(), network);

        if (sub == null) {
            JSObject none = new JSObject();
            none.put("endpoint", null);
            call.resolve(none);
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(sub));
        } catch (org.json.JSONException e) {
            call.reject("bad subscription", e);
        }
    }

    @PluginMethod
    public void unsubscribe(PluginCall call) {
        String network = call.getString("network");
        if (network == null) {
            call.resolve();
            return;
        }
        // On the main thread, in one step, like everything that reads
        // `waiting`: a distributorChosen already queued there runs either
        // before this (its registration is then unregistered here) or after
        // it (and finds its call withdrawn) — never in between, where it
        // would register again after the subscription was cleared.
        main.post(() -> {
            Waiting pending = waiting.remove(network);
            if (pending != null) {
                pending.reject("unsubscribed", "cancelled");
            }
            // Withdrawn first: an endpoint already on its way is then dropped
            // (PushService.onNewEndpoint).
            PushSubscriptions.remove(getContext(), network);
            UnifiedPush.unregister(getContext(), network);
            PushService.cancelAll(getContext(), network);
            call.resolve();
        });
    }

    @PluginMethod
    public void seen(PluginCall call) {
        String msgid = call.getString("msgid");
        if (msgid != null && !msgid.isEmpty()) {
            PushService.recordSeen(getContext(), msgid);
        }
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String network = call.getString("network");
        String target = call.getString("target");
        if (network != null && target != null) {
            PushService.cancel(getContext(), network, target);
        } else {
            PushService.cancelAll(getContext(), network);
        }
        call.resolve();
    }

    private boolean available() {
        return !UnifiedPush.getDistributors(getContext()).isEmpty();
    }

    private String permission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
        }
        PermissionState state = getPermissionState("notifications");
        if (state == PermissionState.GRANTED) {
            return "granted";
        }
        // PROMPT_WITH_RATIONALE is a refusal Android would still ask about
        // once more; to the page a refusal is a refusal (see the class comment).
        return state == PermissionState.DENIED || state == PermissionState.PROMPT_WITH_RATIONALE ? "denied" : "prompt";
    }
}
