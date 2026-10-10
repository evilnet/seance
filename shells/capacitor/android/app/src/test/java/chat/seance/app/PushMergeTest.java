package chat.seance.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

/** The merge rules test/push/merge.ts pins for the service worker. */
public class PushMergeTest {

    private static PushMerge.Result add(List<PushMerge.Entry> entries, String line) {
        return PushMerge.add(entries, PushLine.parse(line), 1000, PushMerge.KEEP);
    }

    private static String batchLine(int index, int sent, int total, String text, boolean concat, String msgid) {
        return "@batch=b1;evilnet.github.io/line=" + index + "/" + sent + "/" + total
            + (concat ? ";draft/multiline-concat" : "")
            + (msgid != null ? ";msgid=" + msgid : "")
            + ";time=2026-10-06T12:00:00.000Z :alice!a@h PRIVMSG #c :" + text;
    }

    @Test
    public void joinsConcatChunksWithTheirSpaces() {
        PushMerge.Result r = add(new ArrayList<>(), batchLine(1, 2, 2, "hello ", true, "m1"));
        r = add(r.entries, batchLine(2, 2, 2, "world", true, null));

        assertEquals(1, r.entries.size());
        assertEquals("hello world", r.entries.get(0).text);
        assertEquals("m1", r.entries.get(0).msgid);
        assertFalse(r.isNew);
    }

    @Test
    public void putsLinesInOrderWhateverOrderTheyArriveIn() {
        PushMerge.Result r = add(new ArrayList<>(), batchLine(3, 3, 3, "three", false, null));
        assertTrue(r.isNew);
        assertEquals("…\n…\nthree", r.entries.get(0).text);

        r = add(r.entries, batchLine(1, 3, 3, "one", false, "m1"));
        r = add(r.entries, batchLine(2, 3, 3, "two", false, null));

        assertEquals("one\ntwo\nthree", r.entries.get(0).text);
        assertEquals("m1", r.entries.get(0).msgid);
        assertFalse(r.isNew);
    }

    @Test
    public void findsItsMessagePastSomeoneElsesLine() {
        PushMerge.Result r = add(new ArrayList<>(), batchLine(1, 2, 2, "one", false, "m1"));
        r = add(r.entries, "@msgid=m2 :bob!b@h PRIVMSG #c :in between");
        r = add(r.entries, batchLine(2, 2, 2, "two", false, null));

        assertEquals(2, r.entries.size());
        assertEquals("in between", r.entries.get(0).text);
        assertEquals("one\ntwo", r.entries.get(1).text);
        assertFalse(r.isNew);
    }

    @Test
    public void marksACappedMessage() {
        PushMerge.Result r = add(new ArrayList<>(), batchLine(1, 1, 5, "only", false, "m1"));
        assertEquals("only\n…", r.entries.get(0).text);
    }

    @Test
    public void ignoresAPushDeliveredTwice() {
        PushMerge.Result r = add(new ArrayList<>(), "@msgid=m1 :bob!b@h PRIVMSG #c :hi");
        r = add(r.entries, "@msgid=m1 :bob!b@h PRIVMSG #c :hi");
        assertEquals(1, r.entries.size());
        assertFalse(r.changed);

        r = add(new ArrayList<>(), batchLine(1, 2, 2, "one", false, "m1"));
        r = add(r.entries, batchLine(1, 2, 2, "one", false, "m1"));
        assertFalse(r.changed);
    }

    @Test
    public void keepsTheNewestMessages() {
        List<PushMerge.Entry> entries = new ArrayList<>();
        for (int i = 0; i < PushMerge.KEEP + 3; i++) {
            entries = add(entries, "@msgid=m" + i + " :bob!b@h PRIVMSG #c :" + i).entries;
        }
        assertEquals(PushMerge.KEEP, entries.size());
        assertEquals("3", entries.get(0).text);
    }

    @Test
    public void keepsAsManyAsTheServiceWorker() throws Exception {
        // The test runs in the app module; merge.ts is at the repository root.
        String merge = new String(Files.readAllBytes(Paths.get("../../../../client/js/push/merge.ts")), StandardCharsets.UTF_8);
        Matcher keep = Pattern.compile("export const MERGE_KEEP = (\\d+);").matcher(merge);
        assertTrue(keep.find());
        assertEquals(Integer.parseInt(keep.group(1)), PushMerge.KEEP);
    }

    @Test
    public void aReadMarkerLeavesWhatCameAfterIt() {
        List<PushMerge.Entry> entries = add(new ArrayList<>(), "@msgid=a;time=2026-10-06T12:00:00.000Z :bob!b@h PRIVMSG #c :old").entries;
        entries = add(entries, "@msgid=b;time=2026-10-06T12:05:00.000Z :bob!b@h PRIVMSG #c :new").entries;

        List<PushMerge.Entry> unread = PushMerge.unreadAfter(entries, PushLine.parseTime("2026-10-06T12:01:00.000Z"));
        assertEquals(1, unread.size());
        assertEquals("new", unread.get(0).text);

        assertTrue(PushMerge.unreadAfter(entries, PushLine.parseTime("2026-10-06T12:05:00.000Z")).isEmpty());
        assertTrue(PushMerge.unreadAfter(entries, 0).isEmpty());
    }

    @Test
    public void aMessageWithoutServerTimeCountsAsRead() {
        List<PushMerge.Entry> entries = add(new ArrayList<>(), ":bob!b@h PRIVMSG #c :no time").entries;
        assertNull(entries.get(0).msgid);
        assertTrue(PushMerge.unreadAfter(entries, PushLine.parseTime("2000-01-01T00:00:00Z")).isEmpty());
    }

    private static List<PushMerge.Entry> timed(long... times) {
        List<PushMerge.Entry> list = new ArrayList<>();
        for (long t : times) {
            PushMerge.Entry e = new PushMerge.Entry();
            e.from = "alice";
            e.text = "at " + t;
            e.time = t;
            list.add(e);
        }
        return list;
    }

    @Test
    public void aReadWithNoTargetReachesEveryNotificationOfTheNetwork() {
        // service-worker.js closeForTarget with no target: every push
        // notification goes whose message predates the marker.
        Map<String, List<PushMerge.Entry>> showing = new LinkedHashMap<>();
        showing.put("n\n#c", timed(100, 200));
        showing.put("n\nbob", timed(300));
        showing.put("n\n#d", timed(100));
        showing.put("n\n\n", new ArrayList<>()); // "new activity": no messages

        Map<String, List<PushMerge.Entry>> changes = PushMerge.afterRead(showing, 150);

        assertEquals(1, changes.get("n\n#c").size()); // 200 stays
        assertFalse(changes.containsKey("n\nbob")); // all newer: untouched
        assertTrue(changes.get("n\n#d").isEmpty()); // read: closed
        assertTrue(changes.get("n\n\n").isEmpty()); // closed
    }

    @Test
    public void aReadWithNoTimeClosesEverything() {
        Map<String, List<PushMerge.Entry>> showing = new LinkedHashMap<>();
        showing.put("n\n#c", timed(100, 200));
        showing.put("n\n\n", new ArrayList<>());

        Map<String, List<PushMerge.Entry>> changes = PushMerge.afterRead(showing, 0);

        assertEquals(2, changes.size());
        assertTrue(changes.get("n\n#c").isEmpty());
        assertTrue(changes.get("n\n\n").isEmpty());
    }
}
