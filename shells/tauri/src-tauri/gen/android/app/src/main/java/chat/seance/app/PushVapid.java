package chat.seance.app;

import java.util.regex.Pattern;

/**
 * A network's VAPID key as the UnifiedPush connector takes it. The connector
 * (3.3.5, `register$connector`) checks the key against
 * `^[A-Za-z0-9_-]{87}$` — URL-safe base64 of a 65-byte P-256 point, no
 * padding — and throws a checked exception the Kotlin signature does not
 * declare when it does not match, after it has stored the registration, and
 * again every time it re-reads that registration. So a key goes in only
 * once it passes here.
 */
final class PushVapid {

    private static final Pattern CONNECTOR = Pattern.compile("^[A-Za-z0-9_-]{87}$");

    private PushVapid() {}

    /** URL-safe, unpadded: what the connector reads (the ircd may announce standard base64). */
    static String normalise(String vapid) {
        return vapid.replace('+', '-').replace('/', '_').replace("=", "");
    }

    /** Whether the connector takes `key` exactly as it is. */
    static boolean connectorAccepts(String key) {
        return key != null && CONNECTOR.matcher(key).matches();
    }

    /** {@link #normalise}d, or null when the connector would refuse the key. */
    static String forConnector(String vapid) {
        if (vapid == null) {
            return null;
        }
        String key = normalise(vapid);
        // 87 characters hold 65 bytes and 2 spare bits: a P-256 point starts with 0x04, "B" in base64.
        return connectorAccepts(key) && key.charAt(0) == 'B' ? key : null;
    }
}
