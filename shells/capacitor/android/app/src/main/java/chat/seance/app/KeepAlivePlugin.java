package chat.seance.app;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * `KeepAlive`, the page's handle on {@link ConnectionService}. The web build
 * reaches it through the bridge's `nativePromise("KeepAlive", …)`
 * (client/js/helpers/keepAlive.ts), nothing bundled.
 *
 * - `enable({quiet})`: start the service. On Android 13+ a foreground
 *   service's notification needs POST_NOTIFICATIONS; the first enable asks
 *   for it, and `quiet: true` (the boot-time re-apply of the stored
 *   setting) never does. The service starts whatever the answer — denied,
 *   the notification is simply not shown and `status().notifications`
 *   says so.
 * - `disable()`: stop it.
 * - `status()`: `{running, notifications}`.
 * - event `stopped`: the user pressed the notification's "Turn off".
 */
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class KeepAlivePlugin extends Plugin {

    @Override
    public void load() {
        ConnectionService.onStoppedByUser = () -> notifyListeners("stopped", new JSObject());
    }

    @PluginMethod
    public void enable(PluginCall call) {
        boolean quiet = Boolean.TRUE.equals(call.getBoolean("quiet", false));
        if (!quiet && !notificationsAllowed()) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        start(call);
    }

    private void start(PluginCall call) {
        ConnectionService.start(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void disable(PluginCall call) {
        ConnectionService.stop(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @Override
    protected void handleOnDestroy() {
        // The activity, and the WebView with the connections, is going away.
        ConnectionService.onStoppedByUser = null;
        ConnectionService.stop(getContext());
    }

    private boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("running", ConnectionService.running);
        result.put("notifications", notificationsAllowed());
        return result;
    }
}
