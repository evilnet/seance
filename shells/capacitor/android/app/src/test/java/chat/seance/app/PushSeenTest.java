package chat.seance.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The "seen" ring's rules, as showMessage in client/service-worker.js applies them. */
public class PushSeenTest {

    private static PushLine plain(String msgid) {
        return PushLine.parse("@msgid=" + msgid + " :alice!a@h PRIVMSG bob :hi");
    }

    private static PushLine batchLine(int index, String msgid) {
        return PushLine.parse(
            "@batch=b1;evilnet.github.io/line=" + index + "/3/3" + (msgid != null ? ";msgid=" + msgid : "") + " :alice!a@h PRIVMSG #c :x"
        );
    }

    @Test
    public void dropsAMessageThePageRecorded() {
        PushSeen seen = new PushSeen();
        seen.add("m1");

        assertTrue(seen.covers(plain("m1")));
        assertFalse(seen.covers(plain("m2")));
    }

    @Test
    public void thePagesBatchReferenceDropsEveryLine() {
        PushSeen seen = new PushSeen();
        seen.add("b1"); // the opener's msgid, as the page saw the joined message

        assertTrue(seen.covers(batchLine(1, "b1")));
        assertTrue(seen.covers(batchLine(2, null)));
        assertTrue(seen.covers(batchLine(3, null)));
    }

    @Test
    public void aShownLineDropsOnlyThatLine() {
        PushSeen seen = new PushSeen();
        seen.add(PushSeen.seenKey(batchLine(2, null)));

        assertEquals("b1#2", PushSeen.seenKey(batchLine(2, null)));
        assertTrue(seen.covers(batchLine(2, null)));
        assertFalse(seen.covers(batchLine(1, "b1")));
        assertFalse(seen.covers(batchLine(3, null)));
    }

    @Test
    public void aShownMessageIsRecordedByMsgid() {
        assertEquals("m1", PushSeen.seenKey(plain("m1")));
    }

    @Test
    public void aMessageWithoutMsgidIsNeverCovered() {
        PushSeen seen = new PushSeen();
        PushLine line = PushLine.parse(":alice!a@h PRIVMSG bob :hi");
        seen.add(PushSeen.seenKey(line));

        assertFalse(seen.covers(line));
        assertTrue(seen.ids().isEmpty());
    }

    @Test
    public void keepsTheNewestCapIds() {
        PushSeen seen = new PushSeen();
        for (int i = 0; i < PushSeen.CAP + 5; i++) {
            seen.add("m" + i);
        }

        assertEquals(PushSeen.CAP, seen.ids().size());
        assertFalse(seen.contains("m4"));
        assertTrue(seen.contains("m5"));
        assertTrue(seen.contains("m" + (PushSeen.CAP + 4)));
    }

    @Test
    public void aRepeatedIdMovesToTheNewestEnd() {
        PushSeen seen = new PushSeen();
        seen.add("old");
        for (int i = 0; i < PushSeen.CAP - 1; i++) {
            seen.add("m" + i);
        }
        seen.add("old");
        seen.add("new");

        assertTrue(seen.contains("old"));
        assertFalse(seen.contains("m0"));
    }

    @Test
    public void survivesItsStoredForm() {
        PushSeen seen = new PushSeen();
        seen.add("m1");
        seen.add("b1#2");

        PushSeen back = PushSeen.fromJson(seen.toJson());
        assertEquals(seen.ids(), back.ids());
        assertTrue(PushSeen.fromJson("not json").ids().isEmpty());
        assertTrue(PushSeen.fromJson(null).ids().isEmpty());
    }
}
