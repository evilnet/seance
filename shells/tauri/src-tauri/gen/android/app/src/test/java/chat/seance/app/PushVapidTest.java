package chat.seance.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** What the connector would refuse (and crash on) never reaches it. */
public class PushVapidTest {

    private static final String KEY = "BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_8uA1CpBkiyd_lc8ztobgKxEs1F7dFHQGB3yW5mgi54GkJBnGU";

    @Test
    public void takesAUrlSafeP256Key() {
        assertEquals(KEY, PushVapid.forConnector(KEY));
        assertTrue(PushVapid.connectorAccepts(KEY));
    }

    @Test
    public void normalisesStandardBase64AndPadding() {
        String standard = KEY.replace('-', '+').replace('_', '/') + "=";
        assertFalse(PushVapid.connectorAccepts(standard));
        assertEquals(KEY, PushVapid.forConnector(standard));
    }

    @Test
    public void refusesWhatIsNotA65BytePoint() {
        assertNull(PushVapid.forConnector(null));
        assertNull(PushVapid.forConnector(""));
        // caps.ts accepts any URL-safe key of 32 characters or more.
        assertNull(PushVapid.forConnector(KEY.substring(0, 43)));
        assertNull(PushVapid.forConnector(KEY + "A"));
        // The ISUPPORT fallback accepts anything.
        assertNull(PushVapid.forConnector("not a key at all"));
        assertNull(PushVapid.forConnector(KEY.substring(0, 86) + "!"));
        // 87 characters, but not an uncompressed point (0x04 first).
        assertNull(PushVapid.forConnector("A" + KEY.substring(1)));
    }
}
