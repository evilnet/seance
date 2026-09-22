package chat.seance.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
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
 * activity is destroyed (the plugin's handleOnDestroy) — never left running
 * with nothing to keep.
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

    static void start(Context context) {
        Intent intent = new Intent(context, ConnectionService.class).setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, ConnectionService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            Runnable cb = onStoppedByUser;
            if (cb != null) {
                cb.run();
            }
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;

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
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.keepalive_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.keepalive_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;

        // Tap: bring the app forward (singleTask, so the running one).
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

        // "Turn off": back into this service with ACTION_STOP.
        Intent stop = new Intent(this, ConnectionService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

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
