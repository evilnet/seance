package chat.seance.app;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * The shell's "seen" ring, the twin of the service worker's
 * (client/js/push-seen.ts and showMessage in client/service-worker.js):
 * what this device has already surfaced, so a push for it shows nothing.
 * Two writers. The page records the msgid of every pushable message it
 * took while the user was looking at it (NativePushPlugin `seen`) — the
 * WebView has no Notification API, so a message the page took unattended
 * is recorded by nobody and its push is the only notice the user gets. And
 * {@link PushService} records what it showed — by msgid, or `<batch>#<i>`
 * for a multiline message's line — so a push delivered twice (push services
 * promise at least once) shows nothing even after its notification was
 * swiped. A batch's reference is the msgid the page recorded from the
 * BATCH opener, so the page blocks every line of a message it showed by it.
 * Plain Java, so the JVM test runs it; PushService keeps it in
 * SharedPreferences under its lock.
 */
final class PushSeen {

    /** Mirrors CAP in client/js/push-seen.ts. */
    static final int CAP = 200;

    private final LinkedHashSet<String> ids = new LinkedHashSet<>();

    /** Record an id; the oldest goes once the ring is full. */
    void add(String id) {
        if (id == null || id.isEmpty()) {
            return;
        }
        ids.remove(id);
        ids.add(id);
        while (ids.size() > CAP) {
            ids.remove(ids.iterator().next());
        }
    }

    boolean contains(String id) {
        return id != null && ids.contains(id);
    }

    /**
     * The push is something this device already surfaced: its msgid, its
     * batch reference, or (a multiline line) that very line.
     */
    boolean covers(PushLine line) {
        String msgid = line.msgid();
        String seenId = seenId(line);
        return contains(msgid) || contains(seenId) || contains(seenKey(line));
    }

    /** What a shown push is recorded as: the line of a batch, or the message. */
    static String seenKey(PushLine line) {
        int[] index = line.lineIndex();
        String seenId = seenId(line);
        if (index != null && seenId != null) {
            return seenId + "#" + index[0];
        }
        return line.msgid();
    }

    /** The message a push belongs to: a line's batch (its first line's msgid), or its own msgid. */
    private static String seenId(PushLine line) {
        if (line.lineIndex() != null) {
            String batch = line.batch();
            return batch != null ? batch : line.msgid();
        }
        return line.msgid();
    }

    List<String> ids() {
        return new ArrayList<>(ids);
    }

    String toJson() {
        JSONArray list = new JSONArray();
        for (String id : ids) {
            list.put(id);
        }
        return list.toString();
    }

    /** The ring as stored; an empty one when there is none or it is unreadable. */
    static PushSeen fromJson(String json) {
        PushSeen seen = new PushSeen();
        if (json == null) {
            return seen;
        }
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < list.length(); i++) {
                seen.add(list.optString(i, null));
            }
        } catch (JSONException e) {
            return new PushSeen();
        }
        return seen;
    }
}
