package chat.seance.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** The moment between notify() and the shade, and a dismissal inside it. */
public class PushPostedTest {

    private static List<PushMerge.Entry> entries(String... texts) {
        List<PushMerge.Entry> list = new ArrayList<>();
        for (String text : texts) {
            PushMerge.Entry e = new PushMerge.Entry();
            e.from = "alice";
            e.text = text;
            list.add(e);
        }
        return list;
    }

    @Test
    public void bridgesAPostNotInTheShadeYet() {
        PushPosted posted = new PushPosted();
        List<PushMerge.Entry> mine = entries("one");
        posted.record("n\n#c", "#c", mine, 1000);

        assertSame(mine, posted.shown("n\n#c", null, 1000 + PushPosted.POSTING_MS - 1));
    }

    @Test
    public void aPostDismissedBeforeItReachedTheShadeIsNotBroughtBack() {
        PushPosted posted = new PushPosted();
        posted.record("n\n#c", "#c", entries("one"), 1000);
        posted.forget("n\n#c"); // its delete intent, or its tap

        assertTrue(posted.shown("n\n#c", null, 2000).isEmpty());
    }

    @Test
    public void aPostLongGoneFromTheShadeIsForgotten() {
        PushPosted posted = new PushPosted();
        posted.record("n\n#c", "#c", entries("one"), 1000);

        assertTrue(posted.shown("n\n#c", null, 1000 + PushPosted.POSTING_MS).isEmpty());
        assertNull(posted.get("n\n#c"));
    }

    @Test
    public void theLatestPostIsAtLeastAsNewAsTheShade() {
        PushPosted posted = new PushPosted();
        List<PushMerge.Entry> mine = entries("one", "two");
        posted.record("n\n#c", "#c", mine, 1000);

        assertSame(mine, posted.shown("n\n#c", entries("one"), 1000 + 60_000));
        // Nothing posted by this process (it died since): the shade's list.
        List<PushMerge.Entry> shade = entries("three");
        assertSame(shade, posted.shown("n\n#d", shade, 0));
    }

    @Test
    public void forgetsOneNetworkAndListsItsKeys() {
        PushPosted posted = new PushPosted();
        posted.record("n\n#c", "#c", entries("one"), 1000);
        posted.record("n\nbob", "bob", entries("two"), 1000);
        posted.record("m\n#c", "#c", entries("three"), 1000);

        assertEquals(2, posted.keys("n").size());
        posted.forgetNetwork("n");
        assertTrue(posted.keys("n").isEmpty());
        assertEquals(1, posted.keys("m").size());
    }
}
