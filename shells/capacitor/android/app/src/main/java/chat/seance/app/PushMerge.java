package chat.seance.app;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * A conversation notification's message list: how a push joins it, how a
 * multiline message is put back together from one push per line, and how
 * a read marker trims it. The Java twin of client/js/push/merge.ts
 * (`addMessage`, `joinLines`) — the same rules, so the shell and the
 * service worker show the same thing. Plain Java, so the JVM test runs it;
 * PushService keeps the list on the notification itself.
 */
final class PushMerge {

    /** Messages a notification keeps. */
    static final int KEEP = 8;

    static final class Line {
        final String text;
        final boolean concat;

        Line(String text, boolean concat) {
            this.text = text;
            this.concat = concat;
        }
    }

    static final class Entry {
        String from;
        /** Raw text as pushed (joined for a batch); stripped only when shown. */
        String text;
        String msgid;
        /** Server time in epoch ms; 0 when the push carried none. */
        long time;
        /** When this device received it: what MessagingStyle shows when `time` is 0. */
        long arrived;
        /** Multiline: the batch reference and its lines by 1-based index. */
        String batch;
        TreeMap<Integer, Line> lines;
        int sent;
        int total;

        Entry copy() {
            Entry e = new Entry();
            e.from = from;
            e.text = text;
            e.msgid = msgid;
            e.time = time;
            e.arrived = arrived;
            e.batch = batch;
            e.lines = lines == null ? null : new TreeMap<>(lines);
            e.sent = sent;
            e.total = total;
            return e;
        }
    }

    static final class Result {
        final List<Entry> entries;
        /** A message was added (not a later line of one already shown, not a repeat). */
        final boolean isNew;
        /** Anything changed: false for a push delivered twice. */
        final boolean changed;

        Result(List<Entry> entries, boolean isNew, boolean changed) {
            this.entries = entries;
            this.isNew = isNew;
            this.changed = changed;
        }
    }

    private PushMerge() {}

    /**
     * A batch entry's lines joined: concat chunks glued on, `…` for a line
     * not received yet, a trailing `…` when the server capped the message.
     */
    static String joinLines(Entry entry) {
        if (entry.lines == null || entry.sent == 0) {
            return entry.text;
        }
        StringBuilder out = new StringBuilder();
        for (int i = 1; i <= entry.sent; i++) {
            Line line = entry.lines.get(i);
            if (line == null) {
                out.append(i == 1 ? "" : "\n").append("…");
                continue;
            }
            if (i > 1 && !line.concat) {
                out.append('\n');
            }
            out.append(line.text);
        }
        if (entry.total > entry.sent) {
            out.append("\n…");
        }
        return out.toString();
    }

    /**
     * Add one pushed message, or one line of a multiline one, to the list
     * (newest last, capped to `keep`). A line finds its message by batch
     * anywhere in the list and takes its place by index, so duplicates and
     * out-of-order delivery are harmless, and moves the message to the end;
     * a plain message is skipped when its msgid is already there (push
     * services deliver at least once).
     */
    static Result add(List<Entry> entries, PushLine line, long now, int keep) {
        List<Entry> list = new ArrayList<>();
        for (Entry e : entries) {
            list.add(e.copy());
        }

        String batch = line.batch();
        int[] index = line.lineIndex();
        String msgid = line.msgid();

        if (batch != null && index != null) {
            Entry found = null;
            for (Entry e : list) {
                if (batch.equals(e.batch)) {
                    found = e;
                    break;
                }
            }
            Entry entry = found;
            if (entry == null) {
                entry = new Entry();
                entry.from = line.nick;
                entry.text = "";
                entry.batch = batch;
                entry.lines = new TreeMap<>();
                entry.time = line.time();
                entry.arrived = now;
            }
            Line before = entry.lines.get(index[0]);
            boolean repeat = before != null && before.text.equals(line.text) && before.concat == line.concat();

            // The msgid rides the first line only; take it from whichever brings it.
            if (entry.msgid == null && msgid != null) {
                entry.msgid = msgid;
            }
            if (entry.time == 0) {
                entry.time = line.time();
            }
            entry.lines.put(index[0], new Line(line.text, line.concat()));
            entry.sent = Math.max(entry.sent, index[1]);
            entry.total = Math.max(entry.total, index[2]);
            entry.text = joinLines(entry);

            if (found != null) {
                list.remove(found);
            }
            list.add(entry);
            return new Result(cap(list, keep), found == null, !repeat);
        }

        if (msgid != null) {
            for (Entry e : list) {
                if (msgid.equals(e.msgid)) {
                    return new Result(cap(list, keep), false, false);
                }
            }
        }

        Entry entry = new Entry();
        entry.from = line.nick;
        entry.text = line.text;
        entry.msgid = msgid;
        entry.time = line.time();
        entry.arrived = now;
        list.add(entry);
        return new Result(cap(list, keep), true, true);
    }

    /**
     * The messages a read marker at `cutoff` (epoch ms) leaves unread: those
     * newer than it. 0 means the marker named no time and reads them all; a
     * message with no server time counts as read, as the service worker's
     * closeForTarget treats one.
     */
    static List<Entry> unreadAfter(List<Entry> entries, long cutoff) {
        List<Entry> unread = new ArrayList<>();
        if (cutoff == 0) {
            return unread;
        }
        for (Entry e : entries) {
            if (e.time > cutoff) {
                unread.add(e);
            }
        }
        return unread;
    }

    /**
     * A read marker at `cutoff` over the notifications showing, by key: for
     * each one it changes, the messages that stay (empty: close it). A
     * notification with no messages (the "new activity" one) has nothing
     * newer than any marker, so it closes too, as the service worker's
     * closeForTarget closes one with no time.
     */
    static Map<String, List<Entry>> afterRead(Map<String, List<Entry>> showing, long cutoff) {
        Map<String, List<Entry>> changes = new LinkedHashMap<>();
        for (Map.Entry<String, List<Entry>> shown : showing.entrySet()) {
            List<Entry> unread = unreadAfter(shown.getValue(), cutoff);
            if (shown.getValue().isEmpty() || unread.size() < shown.getValue().size()) {
                changes.put(shown.getKey(), unread);
            }
        }
        return changes;
    }

    private static List<Entry> cap(List<Entry> list, int keep) {
        return list.size() > keep ? new ArrayList<>(list.subList(list.size() - keep, list.size())) : list;
    }
}
