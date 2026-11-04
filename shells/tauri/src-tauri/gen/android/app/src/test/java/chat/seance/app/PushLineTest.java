package chat.seance.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The same lines test/push/line.ts pins for the service worker. */
public class PushLineTest {

    @Test
    public void readsAChannelMessage() {
        PushLine line = PushLine.parse("@msgid=abc;time=2026-10-06T12:00:00.000Z :alice!a@host PRIVMSG #seance :hello \u0002there\u0002");

        assertEquals("alice", line.nick);
        assertEquals("PRIVMSG", line.command);
        assertEquals("#seance", line.target);
        assertEquals("hello there", PushLine.notificationText(line.text));
        assertEquals("abc", line.msgid());
        assertEquals(1791288000000L, line.time());
        assertTrue(PushLine.isChannel(line.target));
    }

    @Test
    public void readsAnActionAndStripsColours() {
        PushLine line = PushLine.parse(":bob!b@h PRIVMSG me :\u0001ACTION waves \u000304,12hi\u0003\u0001");

        assertTrue(PushLine.isAction(line.text));
        assertEquals("waves hi", PushLine.notificationText(line.text));
        assertFalse(PushLine.isChannel(line.target));
    }

    @Test
    public void keepsTheSpaceAConcatChunkEndsOn() {
        PushLine line = PushLine.parse("@batch=b1;draft/multiline-concat;evilnet.github.io/line=1/2/2 :a!a@h PRIVMSG #c :hello ");

        assertEquals("hello ", line.text);
        assertTrue(line.concat());
        assertEquals("b1", line.batch());
        assertArrayEquals(new int[] { 1, 2, 2 }, line.lineIndex());
    }

    @Test
    public void readsMarkreadWithItsTimestampAndEscapedTags() {
        PushLine line = PushLine.parse("@batch=x\\sy;draft/multiline-concat :irc.test MARKREAD #seance timestamp=2026-10-06T12:00:00.000Z");

        assertEquals("MARKREAD", line.command);
        assertEquals("#seance", line.target);
        assertEquals("2026-10-06T12:00:00.000Z", line.timestamp);
        assertEquals("x y", line.tags.get("batch"));
        assertTrue(line.concat());
    }

    @Test
    public void rejectsWhatIsNotALine() {
        assertNull(PushLine.parse("PRIVMSG #x :no prefix"));
        assertNull(PushLine.parse("@tags-only"));
    }

    @Test
    public void rejectsAnInconsistentLineIndex() {
        assertNull(PushLine.parse("@evilnet.github.io/line=3/2/2 :a PRIVMSG #c :x").lineIndex());
        assertNull(PushLine.parse("@evilnet.github.io/line=0/1/1 :a PRIVMSG #c :x").lineIndex());
        assertNull(PushLine.parse(":a PRIVMSG #c :x").lineIndex());
    }

    @Test
    public void readsTheJsonTiers() {
        PushLine read = PushLine.fromJson("{\"t\":\"read\",\"target\":\"#seance\",\"ts\":\"2026-10-06T12:00:00Z\"}");
        assertEquals("MARKREAD", read.command);
        assertEquals("#seance", read.target);
        assertEquals("2026-10-06T12:00:00Z", read.timestamp);

        PushLine msg = PushLine.fromJson("{\"t\":\"hl\",\"from\":\"alice\",\"target\":\"#seance\",\"msgid\":\"m1\"}");
        assertEquals("PRIVMSG", msg.command);
        assertEquals("alice", msg.nick);
        assertEquals("New message", msg.text);
        assertEquals("m1", msg.msgid());

        assertNull(PushLine.fromJson(":a PRIVMSG #b :c"));
        assertNull(PushLine.fromJson("{\"t\":\"other\"}"));
    }

    @Test
    public void parsesServerTime() {
        assertEquals(1791288000123L, PushLine.parseTime("2026-10-06T12:00:00.123Z"));
        assertEquals(1791288000100L, PushLine.parseTime("2026-10-06T12:00:00.1Z"));
        assertEquals(1791288000000L, PushLine.parseTime("2026-10-06T14:00:00+02:00"));
        assertEquals(0L, PushLine.parseTime("yesterday"));
        assertEquals(0L, PushLine.parseTime(null));
    }

    @Test
    public void readsEitherTierOfAPayload() {
        PushLine line = PushLine.ofPayload("@msgid=m1 :alice!a@h PRIVMSG bob :hi\u0002");
        assertEquals("PRIVMSG", line.command);
        assertEquals("hi", line.text);

        PushLine read = PushLine.ofPayload("{\"t\":\"read\",\"target\":\"#c\"}\u0002");
        assertEquals("MARKREAD", read.command);
    }

    @Test
    public void aPayloadOfNeitherTierIsNothingToShow() {
        // PushService then posts the "new activity" notification.
        assertNull(PushLine.ofPayload("{\"t\":\"other\"}"));
        assertNull(PushLine.ofPayload("garbage"));
        assertNull(PushLine.ofPayload(""));
    }

    @Test
    public void foldsNamesAsTheServiceWorkerDoes() {
        // service-worker.js foldName: rfc1459, ASCII only.
        assertEquals("#seance{dev}|x^", PushLine.foldName("#SEANCE[Dev]\\X~"));
        assertEquals("nick{}|^", PushLine.foldName("NICK{}|^"));
        // Non-ASCII is left alone: no Unicode lowering to make two names one.
        assertEquals("#\u00dcn\u00efcode", PushLine.foldName("#\u00dcN\u00efCODE"));
        assertEquals("\u00c9", PushLine.foldName("\u00c9"));
        assertEquals("\u0130", PushLine.foldName("\u0130"));
    }

    @Test
    public void aConversationKeyFoldsItsTargetAndTheActivityKeyIsNoTarget() {
        assertEquals(PushService.key("n", "#Chan[1]"), PushService.key("n", "#chan{1}"));
        assertEquals(PushService.key("n", "Nick~"), PushService.key("n", "nick^"));
        // A push with no target (the JSON ping tier) and the "new activity"
        // notification are two notifications.
        assertFalse(PushService.activityKey("n").equals(PushService.key("n", "")));
        assertTrue(PushService.activityKey("n").startsWith("n\n"));
    }
}
