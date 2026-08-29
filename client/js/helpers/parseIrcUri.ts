/**
 * Parse a link handed to us as `?uri=` into Connect-form fields.
 *
 * Seance dials a **WebSocket**, so a link's authority is a WebSocket endpoint,
 * not a TCP IRC one — see `docs/resources/irc-links.md`:
 *
 * - `web+irc://host[:port][/#chan]` is our own scheme (a web app may only
 *   register handlers for `web+…` schemes, and `irc:`/`ircs:` would promise a
 *   TCP connection we cannot make). Always `wss://`; no port means 443.
 * - `irc:` / `ircs:` links are still read for their host and channels, but
 *   their port is a TCP port we cannot connect to, so it is ignored.
 *
 * Anything else — an unknown scheme, no host, an unparseable URL — yields an
 * empty object, which leaves the connect form on its own defaults.
 */

/** `wss://` on the standard HTTPS port, what a public deploy should serve. */
const DEFAULT_PORT = "443";

export default (stringUri: string) => {
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

	return {
		name: uri.hostname,
		host: uri.hostname,
		port: !legacy && uri.port ? uri.port : DEFAULT_PORT,
		// Links are always TLS: a page served over https cannot open a plain
		// ws:// socket anyway. Plain ws:// stays a dev case for the form.
		tls: true,
		// We don't split channels or append # here because the connect window takes care of that
		join: channel,
	};
};
