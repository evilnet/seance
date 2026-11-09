/**
 * What to do with connection details arriving in the page URL — a
 * `?uri=web+irc://…` link (already parsed by ./parseIrcUri) or plain
 * `?host=…&port=…` parameters.
 *
 * A link is a suggestion, not an instruction: anybody can craft one naming
 * any server, so nothing may connect or persist on its say-so alone. The
 * decision is
 *
 *  - the host + port (casefolded, TLS and transport included) match a saved
 *    network → that server was approved before; connect to / focus it. A
 *    link that names no port means the host: a saved TLS network there
 *    matches whatever port it uses (a network's direct servers rarely sit
 *    on 443). A link may upgrade but never downgrade: a TLS link never
 *    matches a cleartext network, and a plain `irc://` link prefers a saved
 *    TLS network on its host to a plain one, whatever port it names;
 *  - nothing on the link's transport, but the host is saved over the other
 *    one (a `wss://` entry for an `irc://` link, say) → that network, on the
 *    same no-downgrade terms: the user approved that server and chose how to
 *    reach it;
 *  - a locked deploy (`lockHost` / `allowCustomServer: false`) and the link
 *    names some other host → refuse it, with a message;
 *  - anything else → the connect form, pre-filled, for the user to approve.
 *
 * Secrets never ride along: a URL cannot supply `saslPassword` or
 * `serverPassword` (the allow-list below), and
 * `autoconnect` is not honoured from URLs at all — the user must click.
 *
 * Kept free of Vue/store/DOM imports so mocha covers it
 * (test/helpers/linkTarget.ts); boot.ts applies the decision. See
 * docs/projects/irc-link-new-server-dialog.md and docs/resources/irc-links.md.
 */

import {defaultPort, hostnameOf, type SavedNetwork} from "../irc/saved-networks";
import {parseJoinList} from "../irc/client";

/** A web+irc: link names a wss:// endpoint; no port and no saved network means 443. */
const DEFAULT_LINK_PORT = 443;

export type LinkTransport = "tcp" | "websocket";

/** The connection details a URL may suggest. No password field, on purpose. */
export interface LinkSuggestion {
	host: string;
	port: number;
	/** The link spelled the port out (false: `port` is the default). */
	portGiven: boolean;
	tls: boolean;
	/** `tcp` only for an `irc:`/`ircs:` link in the app shell. */
	transport: LinkTransport;
	/** Comma-separated channels, possibly with keys; may be empty. */
	join: string;
	nick?: string;
	saslAccount?: string;
}

export type LinkDecision =
	| {kind: "locked"; suggestion: LinkSuggestion}
	| {kind: "saved"; network: SavedNetwork; suggestion: LinkSuggestion}
	| {kind: "new"; suggestion: LinkSuggestion};

export interface LinkPolicy {
	/** Saved networks to match against (`saved-networks.list()`). */
	saved: SavedNetwork[];
	/** When the deploy pins its server, its host; links elsewhere are refused. */
	lockedHost?: string;
}

/** First value of a possibly-repeated query parameter, as a trimmed string. */
function firstString(value: unknown): string {
	if (Array.isArray(value)) {
		value = value[0];
	}

	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value).trim()
		: "";
}

/**
 * Read a suggestion out of a query-parameter object (`parseIrcUri` output or
 * raw `?host=…` entries). `undefined` when no server is named. Password and
 * autoconnect parameters are deliberately never read. `transport: "tcp"` is
 * honoured only when the page can dial TCP (`tcp`, the app shell).
 */
export function linkSuggestion(
	params: Record<string, unknown>,
	options: {tcp?: boolean} = {}
): LinkSuggestion | undefined {
	const host = firstString(params.host);

	if (!host || !hostnameOf(host)) {
		return undefined;
	}

	const port = Number(firstString(params.port));
	const portGiven = Number.isInteger(port) && port > 0 && port <= 65535;
	const tlsParam = firstString(params.tls);
	const tls = !(tlsParam === "0" || tlsParam === "false");
	const transport: LinkTransport =
		options.tcp === true && firstString(params.transport) === "tcp" ? "tcp" : "websocket";
	const suggestion: LinkSuggestion = {
		host,
		port: portGiven ? port : transport === "tcp" ? defaultPort(tls, "tcp") : DEFAULT_LINK_PORT,
		portGiven,
		tls,
		transport,
		join: firstString(params.join ?? params.channels),
	};
	const nick = firstString(params.nick);
	const saslAccount = firstString(params.saslAccount);

	if (nick) {
		suggestion.nick = nick;
	}

	if (saslAccount) {
		suggestion.saslAccount = saslAccount;
	}

	return suggestion;
}

/** Decide what a suggested server means against the saved list and deploy policy. */
export function decideLinkTarget(suggestion: LinkSuggestion, policy: LinkPolicy): LinkDecision {
	const host = hostnameOf(suggestion.host).toLowerCase();

	if (policy.lockedHost && hostnameOf(policy.lockedHost).toLowerCase() !== host) {
		return {kind: "locked", suggestion};
	}

	// Never weaker than the link: a TLS link needs a TLS network.
	const onHost = policy.saved.filter(
		(net) => hostnameOf(net.host).toLowerCase() === host && (net.tls || !suggestion.tls)
	);
	const sameTransport = onHost.filter((net) => transportOf(net) === suggestion.transport);
	const otherTransport = onHost.filter((net) => transportOf(net) !== suggestion.transport);
	const network =
		// A TLS network on the link's transport and host. Its port only has
		// to agree when the link asked for TLS: a plain link's port is a
		// cleartext one, and the upgrade is the point.
		sameTransport.find(
			(net) =>
				net.tls &&
				(!suggestion.tls || !suggestion.portGiven || net.port === suggestion.port)
		) ??
		// A plain link: a plain network there, on its port if it named one.
		sameTransport.find(
			(net) => !net.tls && (!suggestion.portGiven || net.port === suggestion.port)
		) ??
		// The same host over the other transport. A port means nothing
		// across transports, so it is not compared; TLS first.
		otherTransport.find((net) => net.tls) ??
		otherTransport[0];

	return network ? {kind: "saved", network, suggestion} : {kind: "new", suggestion};
}

function transportOf(net: SavedNetwork): LinkTransport {
	return net.transport === "tcp" ? "tcp" : "websocket";
}

/** Parameters a URL may pre-fill the connect form with. No secrets. */
export const LINK_PARAM_KEYS = [
	"host",
	"port",
	"tls",
	"nick",
	"join",
	"channels",
	"saslAccount",
] as const;

/** Keep only the parameters a URL is allowed to supply, as strings. */
export function sanitizeLinkParams(params: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};

	for (const key of LINK_PARAM_KEYS) {
		const value = firstString(params[key]);

		if (value) {
			result[key] = value;
		}
	}

	return result;
}

/** Union of two comma-separated join lists; the first occurrence keeps its key. */
export function mergeJoinLists(base: string, extra: string): string {
	const joined = [base, extra].filter((part) => part.trim().length > 0).join(",");

	return parseJoinList(joined)
		.map((chan) => (chan.key ? `${chan.name} ${chan.key}` : chan.name))
		.join(", ");
}
