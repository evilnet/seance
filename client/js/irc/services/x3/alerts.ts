/**
 * O3's alerts on the wire (docs/resources/x3-services.md §7 Alerts, TRACE):
 * `stats alerts` parsed into {@link ServiceAlert}s, `trace print` into the
 * nicks it found, and the one-line verdicts of `addalert` and `delalert`,
 * each as a {@link ServiceLookup} the alert builder sends through
 * irc/alerts.ts. Formatting is already stripped when the text reaches
 * these. Kept free of store/DOM imports (mocha, test/irc/alerts.ts).
 */

import type {CommandReply, ServiceAlert, ServiceLookup, TraceResult, TraceUser} from "../types";

/** A criteria complaint (`$b<x>$b is an invalid search criteria.` and friends). */
const CRITERIA_ERROR =
	/is an invalid search criteria\.|requires more parameters\.|is an invalid IRC hostmask\.|is not a valid IP address|is an invalid binary value\.|^Invalid regex:/;

/** `O3 is a privileged service.` — the asker is not an oper to it. */
const PRIVILEGED = /^\S+ is a privileged service\.$/;

// ----------------------------------------------------------- stats alerts

/** `<name> <reaction> (by <owner>)` — `%-20s %-6s (by %s)`. */
const ALERT_ROW = /^(\S+)\s+(\S+)\s+\(by (\S+)\)$/;

function alerts(): ServiceLookup<ServiceAlert[]> {
	return {
		role: "oper",
		command: (bot) => `PRIVMSG ${bot} :stats alerts`,
		accept(text) {
			if (/^Current \S+ alerts matching '.*'$/.test(text)) {
				return "start";
			}

			if (/^-+End of Alerts-+$/.test(text)) {
				return "end";
			}

			if (PRIVILEGED.test(text)) {
				return "end";
			}

			return "take";
		},
		parse(lines) {
			const out: ServiceAlert[] = [];
			let current: ServiceAlert | undefined;

			for (const raw of lines.slice(1)) {
				const line = raw.trim();

				if (/^-+$/.test(line) || line === "Name Action (by Oper)" || line === "") {
					continue;
				}

				const row = ALERT_ROW.exec(line);

				if (row) {
					current = {
						name: row[1],
						reaction: row[2].toLowerCase(),
						owner: row[3],
						criteria: "",
					};
					out.push(current);
					continue;
				}

				if (!current) {
					continue;
				}

				// `$uExpires:$u: <date>` strips to `Expires:: <date>`.
				const detail = /^(Expires|Criteria|Triggered):?:\s*(.*)$/.exec(line);

				if (!detail) {
					continue;
				}

				const value = detail[2].trim();

				switch (detail[1]) {
					case "Expires":
						current.expires = value;
						break;
					case "Criteria":
						current.criteria = value;
						break;
					default:
						current.triggered = value;
						break;
				}
			}

			return out;
		},
	};
}

// ------------------------------------------------------------ trace print

/** `%-15s %10s@%s (%s)`: the nick, the ident right-aligned, the host, the account. */
const TRACE_ROW = /^(\S+)\s+(\S+)@(\S+)(?:\s+\((\S*)\))?$/;
const TRACE_FOOTER = /^-+\s*Found\s+(\d+) matches\s*-+$/;

function tracePrint(criteria: string): ServiceLookup<TraceResult> {
	return {
		role: "oper",
		command: (bot) => `PRIVMSG ${bot} :trace print ${criteria}`,
		accept(text) {
			if (/^The following users were found:$/.test(text)) {
				return "start";
			}

			if (TRACE_FOOTER.test(text)) {
				return "end";
			}

			if (
				/^Nothing matched the criteria of your search\.$/.test(text) ||
				CRITERIA_ERROR.test(text) ||
				PRIVILEGED.test(text) ||
				/^Access denied\.$/.test(text)
			) {
				return "end";
			}

			return "take";
		},
		parse(lines) {
			const first = (lines[0] ?? "").trim();

			if (first === "") {
				return undefined;
			}

			if (/^Nothing matched/.test(first)) {
				return {count: 0, users: []};
			}

			if (!/^The following users were found:$/.test(first)) {
				return {count: 0, users: [], error: first};
			}

			const users: TraceUser[] = [];
			let count: number | undefined;

			for (const raw of lines.slice(1)) {
				const line = raw.trim();
				const footer = TRACE_FOOTER.exec(line);

				if (footer) {
					count = Number(footer[1]);
					continue;
				}

				if (/^-+$/.test(line) || line === "Nick User@Host (Account)") {
					continue;
				}

				const row = TRACE_ROW.exec(line);

				if (!row) {
					continue;
				}

				const user: TraceUser = {nick: row[1], ident: row[2], host: row[3]};

				if (row[4]) {
					user.account = row[4];
				}

				users.push(user);
			}

			return {count: count ?? users.length, users};
		},
	};
}

// ------------------------------------------------------ addalert, delalert

function verdict(
	command: (bot: string) => string,
	ok: RegExp,
	last: RegExp,
	more: RegExp
): ServiceLookup<CommandReply> {
	return {
		role: "oper",
		command,
		accept(text) {
			if (ok.test(text) || last.test(text) || PRIVILEGED.test(text)) {
				return "end";
			}

			// A complaint about the criteria or the name comes first; the
			// bot's "Unable to add alert" line closes it.
			return more.test(text) ? "start" : "skip";
		},
		parse(lines) {
			if (lines.length === 0) {
				return undefined;
			}

			return {ok: ok.test(lines[0].trim()), text: lines.map((l) => l.trim()).join(" ")};
		},
	};
}

function addAlert(command: string): ServiceLookup<CommandReply> {
	return verdict(
		(bot) => `PRIVMSG ${bot} :${command}`,
		/^Added alert named \S+\.$/,
		/^Unknown alert reaction \S+\.$|^Unable to add alert\.|^Access denied\.$/,
		new RegExp(`^An alert named \\S+ already exists\\.$|${CRITERIA_ERROR.source}`)
	);
}

function delAlert(name: string): ServiceLookup<CommandReply> {
	return verdict(
		(bot) => `PRIVMSG ${bot} :delalert ${name}`,
		/^Removed alert named \S+\.$/,
		/^No alert named \S+ could be found\.$|^Access denied\.$/,
		/$^/
	);
}

export const x3Alerts = {alerts, tracePrint, addAlert, delAlert};
