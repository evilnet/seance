package chat.seance.app;

import java.util.HashMap;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One push payload as draft/webpush shapes it: a single IRC line, no CRLF.
 * The Java twin of client/js/push/line.ts and the parts of push/strip.ts a
 * notification needs (no Markdown: the shell shows the text as sent, minus
 * IRC formatting). Plain Java, so the JVM unit test runs it.
 */
final class PushLine {

    static final String LINE_TAG = "evilnet.github.io/line";
    static final String CONCAT_TAG = "draft/multiline-concat";

    final Map<String, String> tags;
    /** The prefix's nick, or the server name. */
    final String nick;
    /** Upper-cased. */
    final String command;
    /** First parameter: the message target, or MARKREAD's target. */
    final String target;
    /** Trailing parameter, raw: formatting, CTCP and edge spaces kept; "" when there is none. */
    final String text;
    /** MARKREAD's `timestamp=` parameter, or null. */
    final String timestamp;

    PushLine(Map<String, String> tags, String nick, String command, String target, String text, String timestamp) {
        this.tags = tags;
        this.nick = nick;
        this.command = command;
        this.target = target;
        this.text = text;
        this.timestamp = timestamp;
    }

    /**
     * A decrypted push payload, either tier (handlePushNow in the service
     * worker): trailing control bytes off — an unstripped aes128gcm padding
     * delimiter must not spoil the parse — then the JSON tier, then the IRC
     * line. Null when it is neither: the push then says only "new activity".
     */
    static PushLine ofPayload(String payload) {
        String clean = payload.replaceFirst("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]+$", "");
        PushLine line = fromJson(clean);
        return line != null ? line : parse(clean);
    }

    /** `[@tags] :prefix COMMAND target [...] [:trailing]`; null when it is not that. */
    static PushLine parse(String line) {
        String rest = line;
        Map<String, String> tags = new HashMap<>();

        if (rest.startsWith("@")) {
            int space = rest.indexOf(' ');
            if (space == -1) {
                return null;
            }
            tags = parseTags(rest.substring(1, space));
            rest = rest.substring(space + 1).replaceFirst("^ +", "");
        }

        if (!rest.startsWith(":")) {
            return null;
        }

        int first = rest.indexOf(' ');
        if (first == -1) {
            return null;
        }

        String prefix = rest.substring(1, first);
        int bang = prefix.indexOf('!');
        String nick = bang == -1 ? prefix : prefix.substring(0, bang);
        String tail = rest.substring(first + 1).replaceFirst("^ +", "");
        int second = tail.indexOf(' ');
        String command = (second == -1 ? tail : tail.substring(0, second)).toUpperCase(java.util.Locale.ROOT);

        if (command.isEmpty()) {
            return null;
        }

        String params = second == -1 ? "" : tail.substring(second + 1);
        String middle = params;
        String text = "";

        if (params.startsWith(":")) {
            middle = "";
            text = params.substring(1);
        } else {
            int colon = params.indexOf(" :");
            if (colon != -1) {
                middle = params.substring(0, colon);
                text = params.substring(colon + 2);
            }
        }

        String target = "";
        String timestamp = null;
        for (String word : middle.split(" ")) {
            if (word.isEmpty()) {
                continue;
            }
            if (target.isEmpty()) {
                target = word;
            } else if (command.equals("MARKREAD") && word.startsWith("timestamp=")) {
                timestamp = word.substring("timestamp=".length());
            }
        }

        return new PushLine(tags, nick, command, target, text, timestamp);
    }

    /**
     * The JSON opt-down tiers the service worker also reads (fromJson there):
     * `{"t":"read","target","ts"}` as a MARKREAD, `{"t":"msg"|"notice"|"hl",
     * "from","target","text"?,"msgid"?,"time"?}` as a message. Null for
     * anything else, the IRC-line tier included.
     */
    static PushLine fromJson(String payload) {
        if (!payload.startsWith("{")) {
            return null;
        }
        JSONObject json;
        try {
            json = new JSONObject(payload);
        } catch (JSONException e) {
            return null;
        }

        String t = json.optString("t");
        String target = json.optString("target");
        Map<String, String> tags = new HashMap<>();

        if (t.equals("read")) {
            return new PushLine(tags, "", "MARKREAD", target, "", json.has("ts") ? json.optString("ts") : null);
        }
        if (!t.equals("msg") && !t.equals("notice") && !t.equals("hl")) {
            return null;
        }
        if (json.has("msgid")) {
            tags.put("msgid", json.optString("msgid"));
        }
        if (json.has("time")) {
            tags.put("time", json.optString("time"));
        }
        String text = json.has("text") ? json.optString("text") : "New message";
        return new PushLine(tags, json.optString("from"), t.equals("notice") ? "NOTICE" : "PRIVMSG", target, text, null);
    }

    static Map<String, String> parseTags(String raw) {
        Map<String, String> tags = new HashMap<>();
        for (String pair : raw.split(";")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            if (eq == -1) {
                tags.put(pair, "");
            } else {
                tags.put(pair.substring(0, eq), unescapeTagValue(pair.substring(eq + 1)));
            }
        }
        return tags;
    }

    static String unescapeTagValue(String value) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch != '\\') {
                out.append(ch);
                continue;
            }
            if (i + 1 >= value.length()) {
                break;
            }
            char next = value.charAt(++i);
            switch (next) {
                case ':': out.append(';'); break;
                case 's': out.append(' '); break;
                case 'r': out.append('\r'); break;
                case 'n': out.append('\n'); break;
                default: out.append(next);
            }
        }
        return out.toString();
    }

    /** The msgid tag, or null. */
    String msgid() {
        String id = tags.get("msgid");
        return id == null || id.isEmpty() ? null : id;
    }

    /** The `batch` tag a multiline line carries, or null. */
    String batch() {
        String batch = tags.get("batch");
        return batch == null || batch.isEmpty() ? null : batch;
    }

    /** A `draft/multiline-concat` line: glued to the one before, no newline. */
    boolean concat() {
        return tags.containsKey(CONCAT_TAG);
    }

    /** The server's `@time` in epoch milliseconds, or 0 when absent or unreadable. */
    long time() {
        return parseTime(tags.get("time"));
    }

    private static final Pattern LINE_INDEX = Pattern.compile("^(\\d{1,6})/(\\d{1,6})/(\\d{1,6})$");

    /**
     * The `evilnet.github.io/line=<i>/<sent>/<total>` ordering tag as
     * {index, sent, total}, or null when absent or inconsistent (line.ts
     * `lineIndexOf`).
     */
    int[] lineIndex() {
        String value = tags.get(LINE_TAG);
        if (value == null) {
            return null;
        }
        Matcher m = LINE_INDEX.matcher(value);
        if (!m.matches()) {
            return null;
        }
        int index = Integer.parseInt(m.group(1));
        int sent = Integer.parseInt(m.group(2));
        int total = Integer.parseInt(m.group(3));
        if (index < 1 || sent < 1 || total < 1 || index > sent || sent > total) {
            return null;
        }
        return new int[] { index, sent, total };
    }

    private static final Pattern ISO_TIME = Pattern.compile(
        "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?(Z|([+-])(\\d{2}):?(\\d{2}))$"
    );

    /**
     * An IRCv3 server-time (`2026-10-06T12:00:00.123Z`) in epoch ms; 0 when
     * null or not one. By hand: java.time needs API 26 and minSdk is 24.
     */
    static long parseTime(String value) {
        if (value == null) {
            return 0;
        }
        Matcher m = ISO_TIME.matcher(value);
        if (!m.matches()) {
            return 0;
        }
        java.util.Calendar c = java.util.Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        c.clear();
        c.set(
            Integer.parseInt(m.group(1)),
            Integer.parseInt(m.group(2)) - 1,
            Integer.parseInt(m.group(3)),
            Integer.parseInt(m.group(4)),
            Integer.parseInt(m.group(5)),
            Integer.parseInt(m.group(6))
        );
        long ms = c.getTimeInMillis();
        if (m.group(7) != null) {
            ms += Integer.parseInt((m.group(7) + "00").substring(0, 3));
        }
        if (m.group(9) != null) {
            long offset = (Integer.parseInt(m.group(10)) * 60L + Integer.parseInt(m.group(11))) * 60_000L;
            ms += m.group(9).equals("+") ? -offset : offset;
        }
        return ms;
    }

    /** shared/irc.ts `matchFormatting`. */
    private static final Pattern FORMATTING = Pattern.compile(
        "\\x02|\\x1D|\\x1F|\\x16|\\x0F|\\x11|\\x1E|\\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?|\\x04(?:[0-9a-f]{6}(?:,[0-9a-f]{6})?)?",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern ACTION = Pattern.compile("^\\x01ACTION ([\\s\\S]*?)\\x01?$");

    /** A CTCP ACTION. */
    static boolean isAction(String text) {
        return ACTION.matcher(text).matches();
    }

    /**
     * What a notification shows for one message, a joined multiline one
     * included (strip.ts `notificationText`): an ACTION as its body,
     * formatting gone, trimmed once over the whole text — never per line,
     * or the spaces a concat chunk ends on would go with it.
     */
    static String notificationText(String text) {
        Matcher action = ACTION.matcher(text);
        String raw = action.matches() ? action.group(1) : text;
        return FORMATTING.matcher(raw).replaceAll("").trim();
    }

    /**
     * rfc1459 case folding, ASCII only — the service worker's `foldName`
     * (and client/js/irc/casemap.ts `casefold`): A-Z lowered, `[]\~` to
     * `{}|^`, everything else (non-ASCII included) left as it is. A read
     * need not spell its target as the notification it closes does.
     */
    static String foldName(String name) {
        StringBuilder out = new StringBuilder(name.length());
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if ((c >= 'A' && c <= 'Z') || c == '[' || c == '\\' || c == ']') {
                out.append((char) (c + 0x20));
            } else if (c == '~') {
                out.append('^');
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** Channel targets start with a channel prefix (helpers/pendingTarget.ts). */
    static boolean isChannel(String target) {
        return !target.isEmpty() && "#&!+".indexOf(target.charAt(0)) != -1;
    }
}
