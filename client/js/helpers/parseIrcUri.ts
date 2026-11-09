/**
 * Parse a link handed to us as `?uri=` into Connect-form fields.
 *
 * Seance dials a **WebSocket**, so a link's authority is a WebSocket endpoint,
 * not a TCP IRC one — see `docs/resources/irc-links.md`:
 *
 * - `web+irc://host[:port][/#chan]` is our own scheme, `web+ircs:` the same
 *   thing for those who expect the `s` (a web app may only
 *   register handlers for `web+…` schemes, and `irc:`/`ircs:` would promise a
 *   TCP connection we cannot make). Always `wss://`; no port means the saved
 *   network's, else 443 (`linkTarget.ts`).
 * - `irc:` / `ircs:` name a TCP IRC server
 *   (https://datatracker.ietf.org/doc/html/draft-butcher-irc-url-04):
 *   `transport: "tcp"`, cleartext for `irc:`, TLS for `ircs:`, with the
 *   link's port. Only the app shell can dial one; in a browser
 *   `linkTarget.ts` keeps their host and channels and drops the rest.
 *
 * Anything else — an unknown scheme, no host, an unparseable URL — yields an
 * empty object, which leaves the connect form on its own defaults.
 */

/** Connect-form fields a link supplies; `port` only when it spelled one out. */
export interface ParsedIrcUri {
	name: string;
	host: string;
	port?: string;
	tls: boolean;
	join: string;
	/** Only for an `irc:` / `ircs:` link. */
	transport?: "tcp";
}

export default (stringUri: string): ParsedIrcUri | Record<string, never> => {
	let uri: URL;

	try {
		uri = new URL(stringUri);
	} catch (e) {
		return {}; // do nothing on invalid uri
	}

	const tcp = uri.protocol === "irc:" || uri.protocol === "ircs:";

	if (!tcp && uri.protocol !== "web+irc:" && uri.protocol !== "web+ircs:") {
		return {};
	}

	if (!uri.hostname) {
		return {};
	}

	let channel = "";

	if (uri.pathname.length > 1) {
		channel = uri.pathname.substr(1); // Remove slash
	}

	if (uri.hash.length > 1) {
		channel += uri.hash;
	}

	// Channels travel URL-encoded (`%23chan%20key` -> `#chan key`): a `#`
	// only survives un-encoded in the fragment, and a join key needs the
	// space a URL cannot carry raw.
	try {
		channel = decodeURIComponent(channel);
	} catch (e) {
		// a stray % is not worth refusing the whole link for
	}

	// Only the host, port, path and fragment are read: a link's userinfo
	// (`irc://user:pass@host`) and query never reach the form.
	const parsed: ParsedIrcUri = {
		name: uri.hostname,
		host: uri.hostname,
		// WebSocket links are always TLS: a page served over https cannot open
		// a plain ws:// socket anyway. Plain ws:// stays a dev case for the
		// form. Over TCP the scheme says it: `ircs:` is TLS, `irc:` is not.
		tls: tcp ? uri.protocol === "ircs:" : true,
		// We don't split channels or append # here because the connect window takes care of that
		join: channel,
	};

	if (tcp) {
		parsed.transport = "tcp";
	}

	// Only a port the link spells out. Without one the link means "this
	// host": a saved network there matches whatever port it uses, and the
	// connect form falls back to 443, or 6667 / 6697 over TCP
	// (linkTarget.ts).
	if (uri.port) {
		parsed.port = uri.port;
	}

	return parsed;
};
