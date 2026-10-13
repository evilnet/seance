package chat.seance.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * What {@link PushService} last posted per conversation, and when. Android
 * posts asynchronously, so for a moment after notify() the shade does not
 * show it yet: a second push read from the shade alone would start from the
 * older list and drop the first. The shade stays the record across process
 * deaths and swipes; this only bridges that moment — and forgets a post as
 * soon as the user dismisses or taps it, so a notification swiped away
 * within that moment does not come back with the next push. Not
 * thread-safe: the service holds its lock.
 */
final class PushPosted {

    /** How long a post may take to reach the shade before it is taken as gone. */
    static final long POSTING_MS = 5_000;

    static final class Post {
        final String conversation;
        final List<PushMerge.Entry> entries;
        final long at;

        Post(String conversation, List<PushMerge.Entry> entries, long at) {
            this.conversation = conversation;
            this.entries = entries;
            this.at = at;
        }
    }

    private final Map<String, Post> posts = new HashMap<>();

    void record(String key, String conversation, List<PushMerge.Entry> entries, long now) {
        posts.put(key, new Post(conversation, entries, now));
    }

    /** The user swiped it away, cleared the shade, or tapped it. */
    void forget(String key) {
        posts.remove(key);
    }

    /** Every conversation key of `network` ({@link PushService#key}). */
    void forgetNetwork(String network) {
        posts.keySet().removeIf(key -> network == null || key.startsWith(network + "\n"));
    }

    Post get(String key) {
        return posts.get(key);
    }

    /** The keys of `network` this process posted to and still remembers. */
    List<String> keys(String network) {
        List<String> out = new ArrayList<>();
        for (String key : posts.keySet()) {
            if (key.startsWith(network + "\n")) {
                out.add(key);
            }
        }
        return out;
    }

    /**
     * The messages the conversation's notification shows now: `inShade` is
     * the list the shade's copy carries, null when the shade has none.
     * Empty when nothing is showing.
     */
    List<PushMerge.Entry> shown(String key, List<PushMerge.Entry> inShade, long now) {
        Post mine = posts.get(key);
        if (inShade != null) {
            // Showing: what this process posted last is at least as new.
            return mine != null ? mine.entries : inShade;
        }
        // Not in the shade: still on its way there (it was not dismissed,
        // or it would be forgotten), or gone without telling (the process
        // missed the dismissal, the permission was withdrawn).
        if (mine != null && now - mine.at < POSTING_MS) {
            return mine.entries;
        }
        posts.remove(key);
        return new ArrayList<>();
    }
}
