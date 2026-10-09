package chat.seance.app;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Where the ircd's Web Push lands. The app is a UnifiedPush client, one
 * registration (instance) per network uuid, made with that network's VAPID
 * key: on a phone with Google Play services and no other distributor the
 * embedded FCM distributor registers it with FCM, which accepts the ircd's
 * VAPID-signed RFC 8291 pushes directly (no Firebase project, no relay); a
 * phone with a distributor app (ntfy, …) uses that instead. The connector
 * decrypts, so a message arrives here as the IRC line the ircd sent.
 *
 * Runs with no page — the app may have been swiped away — so everything a
 * notification needs is here: the line ({@link PushLine}), one MessagingStyle
 * notification per conversation whose messages merge as the service worker's
 * do ({@link PushMerge}). The message list rides on the notification's own
 * extras, so it is exactly what the shade shows: a swiped notification
 * starts over, and a process Android killed between two pushes loses
 * nothing. A MARKREAD from another device takes away what it read. A push
 * for a message this device already surfaced shows nothing
 * ({@link PushSeen}: what the page showed the user, what this service
 * showed before), the service worker's rule.
 */
public class PushService extends org.unifiedpush.android.connector.PushService {

    private static final String TAG = "SeancePush";
    static final String CHANNEL_ID = "messages";
    /** A tap's action starts with this; the rest is its conversation key (see {@link #base}). */
    static final String ACTION_TAP = "chat.seance.app.PUSH_TAP";
    /** A dismissal's action starts with this; the rest is its conversation key. */
    static final String ACTION_DISMISS = "chat.seance.app.PUSH_DISMISS";
    /** Every push notification's tag starts with this; the rest is its conversation key. */
    static final String TAG_PREFIX = "push\n";
    private static final String EXTRA_NETWORK = "seance.network";
    private static final String EXTRA_TARGET = "seance.target";
    private static final String EXTRA_ENTRIES = "seance.entries";
    private static final String SEEN_PREFS = "seance.push.seen";
    private static final String SEEN_KEY = "seen";

    /** One read-merge-post at a time: two pushes for a conversation must not both start from the same list. */
    private static final Object lock = new Object();

    /** What this process last posted per conversation, under {@link #lock}. */
    private static final PushPosted posted = new PushPosted();

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String network) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            // The ircd cannot push to an endpoint without encryption keys,
            // and nothing would ever own this registration: drop it.
            UnifiedPush.unregister(this, network);
            NativePushPlugin.registrationDone(network, null, "no keys");
            return;
        }
        if (!PushSubscriptions.wanted(this, network)) {
            // Unsubscribed while the registration was in flight.
            UnifiedPush.unregister(this, network);
            return;
        }
        PushSubscriptions.put(this, network, endpoint.getUrl(), keys.getPubKey(), keys.getAuth());
        NativePushPlugin.registrationDone(network, PushSubscriptions.get(this, network), null);
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String network) {
        Log.w(TAG, "registration failed: " + reason);
        NativePushPlugin.registrationDone(network, null, reason.name());
    }

    @Override
    public void onUnregistered(@NonNull String network) {
        PushSubscriptions.remove(this, network);
        cancelAll(this, network);
        NativePushPlugin.unregistered(network);
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String network) {
        if (!message.getDecrypted() || !PushSubscriptions.has(this, network)) {
            return;
        }

        PushLine line = PushLine.ofPayload(new String(message.getContent(), StandardCharsets.UTF_8));

        if (line != null && line.command.equals("MARKREAD")) {
            markRead(this, network, line.target, line.timestamp);
        } else if (line != null && (line.command.equals("PRIVMSG") || line.command.equals("NOTICE"))) {
            show(network, line);
        } else {
            // Something the ircd pushed that is not a message this build
            // can read: say so rather than drop it, as the service worker does.
            showActivity(this, network);
        }
    }

    /**
     * The service worker's "push-activity" notification: names no
     * conversation, so its tap only brings the app up (native.ts).
     */
    private static void showActivity(Context context, String network) {
        Bundle extras = new Bundle();
        extras.putString(EXTRA_NETWORK, network);

        NotificationCompat.Builder builder = base(context, network, "", activityKey(network))
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText("New activity while you were away.")
            .setSubText(PushSubscriptions.name(context, network))
            .setOnlyAlertOnce(true)
            .addExtras(extras);

        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) {
            return;
        }
        try {
            manager.notify(TAG_PREFIX + activityKey(network), 0, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notification permission withdrawn", e);
        }
    }

    private void show(String network, PushLine line) {
        boolean channel = PushLine.isChannel(line.target);
        String conversation = channel ? line.target : line.nick;
        String key = key(network, conversation);

        synchronized (lock) {
            PushSeen seen = seen(this);
            if (seen.covers(line)) {
                return; // the page showed it, or this service already did
            }
            PushMerge.Result merged = PushMerge.add(shownEntries(this, key), line, System.currentTimeMillis(), PushMerge.KEEP);
            if (merged.changed) {
                // A later line of a message already shown grows it in place without a second alert.
                post(this, network, conversation, merged.entries, !merged.isNew);
            }
            seen.add(PushSeen.seenKey(line));
            saveSeen(this, seen);
        }
    }

    /**
     * The page took this message while the user was looking at it: its push
     * shows nothing (NativePushPlugin `seen`).
     */
    static void recordSeen(Context context, String msgid) {
        synchronized (lock) {
            PushSeen seen = seen(context);
            seen.add(msgid);
            saveSeen(context, seen);
        }
    }

    /** Under {@link #lock}. */
    private static PushSeen seen(Context context) {
        return PushSeen.fromJson(context.getSharedPreferences(SEEN_PREFS, Context.MODE_PRIVATE).getString(SEEN_KEY, null));
    }

    /** Under {@link #lock}. */
    private static void saveSeen(Context context, PushSeen seen) {
        context.getSharedPreferences(SEEN_PREFS, Context.MODE_PRIVATE).edit().putString(SEEN_KEY, seen.toJson()).apply();
    }

    /**
     * Another device (or this one's page) read `target` up to `timestamp`:
     * what it read goes, what came after stays, quietly. No timestamp reads
     * everything; no target reads every conversation of the network, the
     * "new activity" notification included (the service worker's
     * closeForTarget).
     */
    static void markRead(Context context, String network, String target, String timestamp) {
        synchronized (lock) {
            Map<String, List<PushMerge.Entry>> showing = new LinkedHashMap<>();
            Map<String, String> conversations = new HashMap<>();

            if (target.isEmpty()) {
                NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                for (StatusBarNotification n : manager.getActiveNotifications()) {
                    Bundle extras = n.getNotification().extras;
                    if (n.getTag() == null || !n.getTag().startsWith(TAG_PREFIX) || !network.equals(extras.getString(EXTRA_NETWORK))) {
                        continue;
                    }
                    String key = n.getTag().substring(TAG_PREFIX.length());
                    showing.put(key, shownEntries(context, key));
                    conversations.put(key, extras.getString(EXTRA_TARGET));
                }
                // Posted, and not in the shade yet.
                for (String key : posted.keys(network)) {
                    List<PushMerge.Entry> shown = showing.containsKey(key) ? null : shownEntries(context, key);
                    if (shown != null && !shown.isEmpty()) {
                        showing.put(key, shown);
                    }
                }
            } else {
                String key = key(network, target);
                List<PushMerge.Entry> shown = shownEntries(context, key);
                if (shown.isEmpty()) {
                    return;
                }
                showing.put(key, shown);
                conversations.put(key, target);
            }

            Map<String, List<PushMerge.Entry>> changes = PushMerge.afterRead(showing, PushLine.parseTime(timestamp));
            for (Map.Entry<String, List<PushMerge.Entry>> change : changes.entrySet()) {
                String key = change.getKey();
                PushPosted.Post mine = posted.get(key);
                String conversation = conversations.get(key) != null ? conversations.get(key) : mine != null ? mine.conversation : null;
                if (change.getValue().isEmpty()) {
                    posted.forget(key);
                    NotificationManagerCompat.from(context).cancel(TAG_PREFIX + key, 0);
                } else if (conversation != null) {
                    post(context, network, conversation, change.getValue(), true);
                }
            }
        }
    }

    private static void post(Context context, String network, String conversation, List<PushMerge.Entry> entries, boolean quiet) {
        boolean channel = PushLine.isChannel(conversation);
        String key = key(network, conversation);

        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(new Person.Builder().setName("You").build());
        if (channel) {
            style.setConversationTitle(conversation);
            style.setGroupConversation(true);
        }
        for (PushMerge.Entry e : entries) {
            String text = PushLine.isAction(e.text) ? "* " + e.from + " " + PushLine.notificationText(e.text) : PushLine.notificationText(e.text);
            style.addMessage(text, e.time > 0 ? e.time : e.arrived, new Person.Builder().setName(e.from).build());
        }

        Bundle extras = new Bundle();
        extras.putString(EXTRA_NETWORK, network);
        extras.putString(EXTRA_TARGET, conversation);
        extras.putString(EXTRA_ENTRIES, toJson(entries));

        NotificationCompat.Builder builder = base(context, network, conversation, key)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setSubText(PushSubscriptions.name(context, network))
            .setOnlyAlertOnce(quiet)
            .addExtras(extras);

        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) {
            return;
        }
        try {
            manager.notify(TAG_PREFIX + key, 0, builder.build());
            posted.record(key, conversation, entries, System.currentTimeMillis());
        } catch (SecurityException e) {
            Log.w(TAG, "notification permission withdrawn", e);
        }
    }

    private static NotificationCompat.Builder base(Context context, String network, String target, String key) {
        ensureChannel(context);

        // One PendingIntent per conversation. Extras do not count in a
        // PendingIntent's identity, so the conversation rides in the action,
        // which does (no data URI: Capacitor reads any intent's data as a
        // launch link).
        Intent tap = new Intent(context, MainActivity.class)
            .setAction(ACTION_TAP + "\n" + key)
            .putExtra("network", network)
            .putExtra("target", target)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
            context,
            0,
            tap,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        // Swiped away or cleared: forgotten at once (PushDismissReceiver),
        // so a push right after does not bring its messages back.
        Intent dismiss = new Intent(context, PushDismissReceiver.class).setAction(ACTION_DISMISS + "\n" + key);
        PendingIntent deleted = PendingIntent.getBroadcast(
            context,
            0,
            dismiss,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_seance)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(content)
            .setDeleteIntent(deleted);
    }

    static void ensureChannel(Context context) {
        NotificationManagerCompat.from(context).createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName("Messages")
                .setDescription("Mentions and private messages while the app is closed")
                .build()
        );
    }

    /**
     * Conversation key: network and target, case-folded as the service
     * worker folds IRC names (rfc1459, {@link PushLine#foldName}). A push
     * with no target (the JSON ping tier) has the key with an empty target.
     */
    static String key(String network, String target) {
        return network + "\n" + PushLine.foldName(target);
    }

    /** The "new activity" notification's key: no target can spell it (no name holds a newline). */
    static String activityKey(String network) {
        return network + "\n\n";
    }

    /**
     * The messages the conversation's notification shows now; empty when
     * none is showing. Called under {@link #lock}.
     */
    private static List<PushMerge.Entry> shownEntries(Context context, String key) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        List<PushMerge.Entry> inShade = null;
        for (StatusBarNotification n : manager.getActiveNotifications()) {
            if ((TAG_PREFIX + key).equals(n.getTag())) {
                inShade = fromJson(n.getNotification().extras.getString(EXTRA_ENTRIES));
                break;
            }
        }
        return posted.shown(key, inShade, System.currentTimeMillis());
    }

    /** A notification was swiped away, cleared or tapped: what it showed starts over. */
    static void forget(String key) {
        synchronized (lock) {
            posted.forget(key);
        }
    }

    private static String toJson(List<PushMerge.Entry> entries) {
        JSONArray list = new JSONArray();
        try {
            for (PushMerge.Entry e : entries) {
                JSONObject o = new JSONObject()
                    .put("from", e.from)
                    .put("text", e.text)
                    .put("time", e.time)
                    .put("arrived", e.arrived)
                    .putOpt("msgid", e.msgid)
                    .putOpt("batch", e.batch);
                if (e.lines != null) {
                    JSONObject lines = new JSONObject();
                    for (Map.Entry<Integer, PushMerge.Line> l : e.lines.entrySet()) {
                        lines.put(String.valueOf(l.getKey()), new JSONObject().put("text", l.getValue().text).put("concat", l.getValue().concat));
                    }
                    o.put("lines", lines).put("sent", e.sent).put("total", e.total);
                }
                list.put(o);
            }
        } catch (JSONException e) {
            Log.w(TAG, "could not keep the message list", e);
        }
        return list.toString();
    }

    private static List<PushMerge.Entry> fromJson(String json) {
        List<PushMerge.Entry> entries = new ArrayList<>();
        if (json == null) {
            return entries;
        }
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                PushMerge.Entry e = new PushMerge.Entry();
                e.from = o.optString("from");
                e.text = o.optString("text");
                e.time = o.optLong("time");
                e.arrived = o.optLong("arrived");
                e.msgid = o.has("msgid") ? o.getString("msgid") : null;
                e.batch = o.has("batch") ? o.getString("batch") : null;
                JSONObject lines = o.optJSONObject("lines");
                if (lines != null) {
                    e.lines = new TreeMap<>();
                    for (Iterator<String> it = lines.keys(); it.hasNext(); ) {
                        String index = it.next();
                        JSONObject l = lines.getJSONObject(index);
                        e.lines.put(Integer.parseInt(index), new PushMerge.Line(l.optString("text"), l.optBoolean("concat")));
                    }
                    e.sent = o.optInt("sent");
                    e.total = o.optInt("total");
                }
                entries.add(e);
            }
        } catch (JSONException | NumberFormatException e) {
            Log.w(TAG, "unreadable message list; starting over", e);
            return new ArrayList<>();
        }
        return entries;
    }

    /** Close a conversation's notification (read here, or the page opened it). */
    static void cancel(Context context, String network, String target) {
        String key = key(network, target);
        synchronized (lock) {
            posted.forget(key);
            NotificationManagerCompat.from(context).cancel(TAG_PREFIX + key, 0);
        }
    }

    /** Close every push notification (the app was opened), or one network's. */
    static void cancelAll(Context context, String network) {
        synchronized (lock) {
            posted.forgetNetwork(network);
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            for (StatusBarNotification n : manager.getActiveNotifications()) {
                String owner = n.getNotification().extras.getString(EXTRA_NETWORK);
                if (n.getTag() != null && n.getTag().startsWith(TAG_PREFIX) && (network == null || network.equals(owner))) {
                    manager.cancel(n.getTag(), n.getId());
                }
            }
        }
    }
}
