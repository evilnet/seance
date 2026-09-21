/**
 * Parse a link handed to us as `?uri=` into Connect-form fields.
 *
 * Seance dials a **WebSocket**, so a link's authority is a WebSocket endpoint,
 * not a TCP IRC one — see `docs/resources/irc-links.md`:
 *
 * - `web+irc://host[:port][/#chan]` is our own scheme (a web app may only
 *   register handlers for `web+…` schemes, and `irc:`/`ircs:` would promise a
 *   TCP connection we cannot make). Always `wss://`; no port means the saved
 *   network's, else 443 (`linkTarget.ts`).
 * - `irc:` / `ircs:` links are still read for their host and channels, but
 *   their port is a TCP port we cannot connect to, so it is ignored.
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
}

export default (stringUri: string): ParsedIrcUri | Record<string, never> => {
	let uri: URL;

	try {
		uri = new URL(stringUri);
	} catch (e) {
		return {}; // do nothing on invalid uri
	}

	// Legacy IRC links (https://tools.ietf.org/html/draft-butcher-irc-url-04)
	// keep their host and channels; only web+irc: carries a usable port.
	const legacy = uri.protocol === "irc:" || uri.protocol === "ircs:";

	if (!legacy && uri.protocol !== "web+irc:") {
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

	const parsed: ParsedIrcUri = {
		name: uri.hostname,
		host: uri.hostname,
		// Links are always TLS: a page served over https cannot open a plain
		// ws:// socket anyway. Plain ws:// stays a dev case for the form.
		tls: true,
		// We don't split channels or append # here because the connect window takes care of that
		join: channel,
	};

	// Only a port the link spells out. Without one the link means "this
	// host": a saved network there matches whatever port it uses, and the
	// connect form falls back to 443 (linkTarget.ts `DEFAULT_LINK_PORT`).
	if (!legacy && uri.port) {
		parsed.port = uri.port;
	}

	return parsed;
};
