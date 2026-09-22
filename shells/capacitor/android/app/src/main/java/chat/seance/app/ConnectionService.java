package chat.seance.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * The "stay connected" foreground service (Settings → General → Background
 * connection, {@link KeepAlivePlugin}).
 *
 * It does no networking of its own: the IRC WebSockets live in the WebView,
 * inside MainActivity's process. What the service changes is that process's
 * standing with the OS. Without it a backgrounded app is a cached process:
 * Doze cuts its network within minutes of the screen going off and the
 * low-memory killer takes it whenever it likes, which is how a backgrounded
 * Seance came back with every network disconnected. A process running a
 * foreground service keeps its network through Doze and is not a candidate
 * for that reclaim, at the price of a persistent notification — which is
 * why this is opt-in. The service holds no wake lock: an incoming PING
 * wakes the process to answer, and the client sends nothing on a timer.
 *
 * The service is only ever useful while the WebView is alive, so it stops
 * itself when the task is swiped away ({@link #onTaskRemoved}) and when the
 * activity is destroyed for good (the plugin's handleOnDestroy, which sits
 * out a configuration change) — never left running with nothing to keep.
 */
public class ConnectionService extends Service {
    static final String CHANNEL_ID = "connection";
    static final int NOTIFICATION_ID = 1;

    static final String ACTION_START = "chat.seance.app.keepalive.START";
    /** The notification's "Turn off" button. */
    static final String ACTION_STOP = "chat.seance.app.keepalive.STOP";

    /** Whether the service is up; the plugin reports it to the page. */
    static volatile boolean running = false;

    /** Set by the plugin: tells the page the user turned it off from the notification. */
    static Runnable onStoppedByUser = null;

    /**
     * Ask for the service. `running` is set here rather than in
     * {@link #onStartCommand}, which the framework delivers on a later
     * main-thread message: the plugin resolves the page's `enable()` before
     * that, and would otherwise always answer `running: false`.
     */
    static void start(Context context) {
        Intent intent = new Intent(context, ConnectionService.class).setAction(ACTION_START);

        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            // Android 12+ refuses a foreground service started from the
            // background (ForegroundServiceStartNotAllowedException). Nothing
            // is running and the page should hear exactly that.
            running = false;
            return;
        }

        running = true;
    }

    static void stop(Context context) {
        // Same reason as start(): onDestroy runs later.
        running = false;
        context.stopService(new Intent(context, ConnectionService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    // FOREGROUND_SERVICE_TYPE_SPECIAL_USE is an API 34 constant, inlined at
    // compile time; masking it away below 34 is what ServiceCompat is for.
    @SuppressLint("InlinedApi")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            running = false;
            stopSelf();
            Runnable cb = onStoppedByUser;
            if (cb != null) {
                cb.run();
            }
            return START_NOT_STICKY;
        }

        // ServiceCompat knows which SDK levels take a type and how to mask it.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        );

        // Not sticky: if the OS ever kills the process anyway the WebView is
        // gone with it, and a service restarted alone would keep nothing.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped out of recents: the activity and its WebView are
        // gone, so is the connection this notification claims to keep.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        // Channels are Oreo's; the compat call is a no-op below it, where the
        // notification's own PRIORITY_LOW is what ranks it.
        NotificationManagerCompat
            .from(this)
            .createNotificationChannel(
                new NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
                    .setName(getString(R.string.keepalive_channel_name))
                    .setDescription(getString(R.string.keepalive_channel_description))
                    .setShowBadge(false)
                    .build()
            );
    }

    private Notification buildNotification() {
        // Tap: bring the app forward (singleTask, so the running one).
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // "Turn off": back into this service with ACTION_STOP.
        Intent stop = new Intent(this, ConnectionService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_connection)
            .setContentTitle(getString(R.string.keepalive_notification_title, getString(R.string.app_name)))
            .setContentText(getString(R.string.keepalive_notification_text))
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.keepalive_notification_stop), stopIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
    }
}
