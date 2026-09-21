/**
 * What to do with connection details arriving in the page URL — a
 * `?uri=web+irc://…` link (already parsed by ./parseIrcUri) or plain
 * `?host=…&port=…` parameters.
 *
 * A link is a suggestion, not an instruction: anybody can craft one naming
 * any server, so nothing may connect or persist on its say-so alone. The
 * decision is
 *
 *  - the host + port (casefolded, TLS included) match a saved network →
 *    that server was approved before; connect to / focus it. A link that
 *    names no port means the host: a saved network there matches whatever
 *    port it uses (a network's direct servers rarely sit on 443);
 *  - a locked deploy (`lockHost` / `allowCustomServer: false`) and the link
 *    names some other host → refuse it, with a message;
 *  - anything else → the connect form, pre-filled, for the user to approve.
 *
 * Secrets never ride along: a URL cannot supply `saslPassword`, and
 * `autoconnect` is not honoured from URLs at all — the user must click.
 *
 * Kept free of Vue/store/DOM imports so mocha covers it
 * (test/helpers/linkTarget.ts); boot.ts applies the decision. See
 * docs/projects/irc-link-new-server-dialog.md and docs/resources/irc-links.md.
 */

import {hostnameOf, type SavedNetwork} from "../irc/saved-networks";
import {parseJoinList} from "../irc/client";

/** A link names a wss:// endpoint; no port and no saved network means 443. */
const DEFAULT_LINK_PORT = 443;

/** The connection details a URL may suggest. No password field, on purpose. */
export interface LinkSuggestion {
	host: string;
	port: number;
	/** The link spelled the port out (false: `port` is the 443 default). */
	portGiven: boolean;
	tls: boolean;
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

	return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Read a suggestion out of a query-parameter object (`parseIrcUri` output or
 * raw `?host=…` entries). `undefined` when no server is named. Password and
 * autoconnect parameters are deliberately never read.
 */
export function linkSuggestion(params: Record<string, unknown>): LinkSuggestion | undefined {
	const host = firstString(params.host);

	if (!host || !hostnameOf(host)) {
		return undefined;
	}

	const port = Number(firstString(params.port));
	const portGiven = Number.isInteger(port) && port > 0 && port <= 65535;
	const tls = firstString(params.tls);
	const suggestion: LinkSuggestion = {
		host,
		port: portGiven ? port : DEFAULT_LINK_PORT,
		portGiven,
		tls: !(tls === "0" || tls === "false"),
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

	const network = policy.saved.find(
		(net) =>
			hostnameOf(net.host).toLowerCase() === host &&
			(!suggestion.portGiven || (net.port === suggestion.port && net.tls === suggestion.tls))
	);

	return network ? {kind: "saved", network, suggestion} : {kind: "new", suggestion};
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
