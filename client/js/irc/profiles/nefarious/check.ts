/**
 * nefarious2 CHECK replies (286/287/290/291/292) as structured reports
 * (docs/resources/nefarious2-oper.md §7, `ircd/m_check.c`).
 *
 * A card is `290 " "`, `286 Information for <type> <target>`, `290 " "`,
 * body lines, `291 " "`. Body lines are `<right-aligned label>:: <value>`
 * with widths that differ per card and block, so they are matched by the
 * `::`, never by column. Repeated labels (Privileges, Capabilities,
 * Channel(s), Marks) are one value wrapped over several lines and are merged
 * back. Times are `ctime()` in the server's zone, read as UTC (report.ts).
 */

import type {
	OperReport,
	ReportEntry,
	ReportSection,
	ReportTable,
	ReportValue,
} from "../../../../../shared/types/oper";
import type {IrcMessage} from "../../message";
import {
	bytes,
	channel,
	chips,
	duration,
	errorOf,
	errorReport,
	fromUnix,
	host,
	ip,
	isIp,
	mask,
	mono,
	nick,
	number,
	parseCtime,
	rawLines,
	server,
	state,
	text,
	time,
} from "../report";

/** `Label:: value` (value optional: section headers end in `::`). */
const LABEL_RE = /^\s*(.+?)::(?: (.*))?$/;

/** The trailing parameter of a numeric, IRC reset codes and trailing blanks off. */
function bodyOf(msg: IrcMessage): string {
	return clean(msg.params[msg.params.length - 1] ?? "");
}

function clean(value: string): string {
	return value.replace(/\x0f/g, "").replace(/\s+$/, "");
}

/** The target named in the command: `CHECK [server] <target> [-flags]`. */
function commandTarget(command: string): string {
	const words = command
		.trim()
		.split(/\s+/)
		.slice(1)
		.filter((w) => w && !w.startsWith("-"));
	return words[words.length - 1] ?? "";
}

/** `D days, HH:MM:SS` → seconds. */
function parseIdle(value: string): number | undefined {
	const m = /^(\d+) days?, (\d+):(\d{2}):(\d{2})$/.exec(value.trim());
	return m
		? Number(m[1]) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
		: undefined;
}

/** `<KB>.<rem> Kb`: the part after the dot is a byte remainder (0-1023), not a fraction. */
function parseKb(value: string): number | undefined {
	const m = /^(\d+)\.(\d+)\s*Kb$/i.exec(value.trim());
	return m ? Number(m[1]) * 1024 + Number(m[2]) : undefined;
}

/** A time value from a ctime, or the text when it is not one. */
function ctimeValue(value: string): ReportValue {
	const ms = parseCtime(value);
	return ms === undefined ? text(value) : time(ms, value.trim());
}

/** `<ctime> (<unix>)` → time from the unix seconds, printed text kept. */
function ctimeUnixValue(value: string): ReportValue {
	const m = /^(.*?)\s*\((\d+)\)$/.exec(value);

	if (m) {
		return time(fromUnix(m[2]), m[1].trim());
	}

	return ctimeValue(value);
}

const CHANNEL_PREFIXES = "-<@+*!%~";

/** `@#seance` → channel value with its prefixes split off. */
function channelValue(token: string): ReportValue {
	const at = token.search(/[#&]/);

	if (at > 0 && [...token.slice(0, at)].every((c) => CHANNEL_PREFIXES.includes(c))) {
		return channel(token.slice(at), token.slice(0, at));
	}

	return channel(token);
}

/** A setter as printed: `nick`, `nick!user@host` or a server name. */
function setterValue(who: string): ReportValue {
	if (who.includes("!")) {
		return nick(who.slice(0, who.indexOf("!")));
	}

	if (who.includes(".")) {
		return server(who);
	}

	return nick(who);
}

/** A section builder that drops itself when empty. */
class SectionBuilder {
	entries: ReportEntry[] = [];
	lines: string[] = [];
	table?: ReportTable;
	title?: string;

	constructor(title?: string) {
		this.title = title;
	}

	add(label: string, value: ReportValue | ReportValue[] | undefined): void {
		if (value !== undefined) {
			this.entries.push({label, value});
		}
	}

	get empty(): boolean {
		return this.entries.length === 0 && this.lines.length === 0 && !this.table?.rows.length;
	}

	build(): ReportSection {
		const section: ReportSection = {};

		if (this.title) {
			section.title = this.title;
		}

		if (this.entries.length > 0) {
			section.entries = this.entries;
		}

		if (this.table && this.table.rows.length > 0) {
			section.table = this.table;
		}

		if (this.lines.length > 0) {
			section.lines = this.lines;
		}

		return section;
	}
}

function buildSections(builders: SectionBuilder[]): ReportSection[] {
	return builders.filter((b) => !b.empty).map((b) => b.build());
}

/** Body lines of the card: the 290/287 numerics between the 286 and the first 291. */
interface Card {
	type: string;
	target: string;
	body: IrcMessage[];
}

function readCard(lines: IrcMessage[]): Card | undefined {
	const head = lines.findIndex((msg) => msg.command === "286");

	if (head === -1) {
		return undefined;
	}

	const m = /^Information for (\S+) (.*)$/.exec(bodyOf(lines[head]));
	const body: IrcMessage[] = [];

	for (const msg of lines.slice(head + 1)) {
		if (msg.command === "291") {
			break; // a truncated host search sends a second footer and 291: ignore it
		}

		if (msg.command === "290" || msg.command === "287") {
			body.push(msg);
		}
	}

	return {type: m?.[1] ?? "user", target: m?.[2] ?? "", body};
}

// ------------------------------------------------------------------ user card

/** Labels whose wrapped lines are one value. */
const MERGED = new Set(["Privileges", "Capabilities", "Channel(s)", "Marks"]);

function userCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const identity = new SectionBuilder("Identity");
	const connection = new SectionBuilder("Connection");
	const oper = new SectionBuilder("Oper");
	const channels = new SectionBuilder("Channels");
	const caps = new SectionBuilder("Capabilities");
	const marks = new SectionBuilder("Marks");
	const traffic = new SectionBuilder("Traffic");
	const other = new SectionBuilder("Other");
	const bouncer = new SectionBuilder("Bouncer session");
	const bouncerSubs: SectionBuilder[] = [];
	const detail = new SectionBuilder("Bouncer detail");

	// First pass: merge wrapped labels, keep the order of everything else.
	type Line = {label: string; value: string} | {raw: string};
	const items: Line[] = [];
	const merged = new Map<string, {label: string; value: string}>();
	let inBouncer = false;

	for (const msg of card.body) {
		const body = bodyOf(msg);

		if (body.trim() === "") {
			continue;
		}

		const row = /^\s*\[\d+\]/.test(body);
		const m = row ? null : LABEL_RE.exec(body);

		if (!m) {
			items.push({raw: body});
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		if (label === "Bouncer Session") {
			inBouncer = true;
		}

		if (!inBouncer && MERGED.has(label)) {
			const seen = merged.get(label);

			if (seen) {
				seen.value = `${seen.value} ${value}`.trim();
				continue;
			}

			const item = {label, value};
			merged.set(label, item);
			items.push(item);
			continue;
		}

		items.push({label, value});
	}

	// Second pass: place every line.
	let section: SectionBuilder | undefined; // the bouncer block's current sub-section
	let table: "aliases" | "history" | undefined;
	let aliasTable: ReportTable | undefined;
	let historyTable: ReportTable | undefined;
	inBouncer = false;

	for (const item of items) {
		if ("raw" in item) {
			const alias = /^\s*\[(\d+)\] (\S+) on (\S+) :: (.*)$/.exec(item.raw);
			const hist = /^\s*\[(\d+)\] (\S+) \((.*?)\) :: (\d+)x, last: (.*?) -> (.*)$/.exec(
				item.raw
			);

			if (table === "history" && hist && historyTable) {
				const until = hist[6].trim();
				historyTable.rows.push({
					n: number(Number(hist[1])),
					ip: isIp(hist[2]) ? ip(hist[2]) : host(hist[2]),
					host: host(hist[3]),
					count: number(Number(hist[4])),
					last: ctimeValue(hist[5]),
					// The server formats both times with one static buffer, so a
					// disconnect time equal to the connect time carries nothing.
					until:
						until === "connected"
							? state("connected", true)
							: until === hist[5].trim()
							? undefined
							: ctimeValue(until),
				});
			} else if (table === "aliases" && alias && aliasTable) {
				const status = alias[4].trim();
				const local = / \(local\)$/.test(status);
				aliasTable.rows.push({
					n: number(Number(alias[1])),
					numeric: mono(alias[2]),
					server: server(alias[3]),
					modes: status.startsWith("+")
						? mono(status.replace(/ \(local\)$/, ""))
						: state(status, false),
					local: local ? text("local") : undefined,
				});
			} else {
				other.add("Line", text(item.raw.trim()));
			}

			continue;
		}

		const {label, value} = item;

		if (/^Bouncer(Primary|Alias|Face)$/.test(label)) {
			detail.lines.push(`${label}:: ${value}`);
			continue;
		}

		if (label === "Bouncer Session") {
			inBouncer = true;
			section = bouncer;
			table = undefined;
			continue;
		}

		if (inBouncer) {
			if (label === "Primary" && value === "") {
				section = new SectionBuilder("Bouncer primary");
				bouncerSubs.push(section);
				table = undefined;
				continue;
			}

			if (label === "Primary (remote)" && value === "") {
				section = new SectionBuilder("Bouncer primary (remote)");
				bouncerSubs.push(section);
				table = undefined;
				continue;
			}

			if (label === "Aliases") {
				const sub = new SectionBuilder("Bouncer aliases");
				aliasTable = {
					columns: [
						{key: "n", label: "#", align: "right"},
						{key: "numeric", label: "Numeric"},
						{key: "server", label: "Server"},
						{key: "modes", label: "Modes"},
						{key: "local", label: "Where"},
					],
					rows: [],
				};
				sub.table = aliasTable;
				bouncerSubs.push(sub);
				table = "aliases";
				continue;
			}

			if (label === "Connection History") {
				const sub = new SectionBuilder("Connection history");
				historyTable = {
					columns: [
						{key: "n", label: "#", align: "right"},
						{key: "ip", label: "IP"},
						{key: "host", label: "Host"},
						{key: "count", label: "Times", align: "right"},
						{key: "last", label: "Last connected"},
						{key: "until", label: "Until"},
					],
					rows: [],
				};
				sub.table = historyTable;
				bouncerSubs.push(sub);
				table = "history";
				continue;
			}

			bouncerEntry(section ?? bouncer, label, value);
			continue;
		}

		userEntry(
			{identity, connection, oper, channels, caps, marks, traffic, other},
			label,
			value
		);
	}

	const sections = buildSections([
		identity,
		connection,
		oper,
		channels,
		caps,
		marks,
		traffic,
		bouncer,
		...bouncerSubs,
		detail,
		other,
	]);

	return {
		kind: "check-user",
		title: `CHECK ${card.target}`,
		subtitle: "User",
		command,
		sections,
		raw: rawLines(lines),
	};
}

interface UserSections {
	identity: SectionBuilder;
	connection: SectionBuilder;
	oper: SectionBuilder;
	channels: SectionBuilder;
	caps: SectionBuilder;
	marks: SectionBuilder;
	traffic: SectionBuilder;
	other: SectionBuilder;
}

/** `user@host (ip)` → [host, ip]. */
function hostAndIp(value: string): ReportValue[] {
	const m = /^(\S+) \((.*)\)$/.exec(value);

	if (!m) {
		return [host(value)];
	}

	return [host(m[1]), isIp(m[2]) ? ip(m[2]) : text(m[2])];
}

/** `N bytes (max. M bytes)` → [bytes, "of", bytes]. */
function queueValue(value: string): ReportValue | ReportValue[] {
	const m = /^(\d+) bytes \(max\. (\d+) bytes\)$/.exec(value);
	return m ? [bytes(Number(m[1])), text("of"), bytes(Number(m[2]))] : text(value);
}

/** `<A.aaa> Kb (<n> protocol messages)` → [bytes, "n messages"]. */
function dataValue(value: string): ReportValue | ReportValue[] {
	const m = /^(\S+ Kb) \((\d+) protocol messages\)$/.exec(value);
	const amount = m ? parseKb(m[1]) : undefined;

	if (!m || amount === undefined) {
		return text(value);
	}

	return [bytes(amount), text(`${m[2]} messages`)];
}

function userEntry(s: UserSections, label: string, value: string): void {
	switch (label) {
		case "Nick": {
			const m = /^(\S+) \((\S+)\)$/.exec(value);
			s.identity.add("Nick", nick(m ? m[1] : value));

			if (m) {
				s.identity.add("Numeric", text(m[2]));
			}

			return;
		}

		case "User/Hostmask":
			s.identity.add("Visible host", host(value));
			return;

		case "Real User/Host": {
			const [real, addr] = hostAndIp(value);
			s.identity.add("Real host", real);
			s.identity.add("IP", addr);
			return;
		}

		case "Connect host/ip":
			s.identity.add("Connected via", hostAndIp(value));
			return;
		case "Real Name":
			s.identity.add("Real name", text(value));
			return;
		case "Status":
			s.identity.add("Status", text(value));
			return;
		case "Bouncer Alias":
		case "Alias Numeric":
			s.identity.add(label, text(value));
			return;
		case "Class":
			s.identity.add("Class", text(value));
			return;
		case "Country":
		case "Continent":
			s.identity.add(label, text(value));
			return;
		case "Connected to":
			s.identity.add("Server", server(value));
			return;
		case "Session ID":
			s.identity.add("Session ID", mono(value));
			return;
		case "CTCP Version":
		case "SWHOIS":
		case "WebIRC":
		case "Kill":
			s.identity.add(label, text(value));
			return;
		case "Exemptions":
			s.identity.add("Exemptions", chips(splitList(value, ",")));
			return;
		case "Umode(s)":
			umodeEntries(s, value);
			return;
		case "Signed on":
			s.connection.add("Signed on", ctimeValue(value));
			return;
		case "Timestamp":
			s.connection.add("Nick TS", ctimeUnixValue(value));
			return;

		case "Idle for": {
			const seconds = parseIdle(value);
			s.connection.add("Idle", seconds === undefined ? text(value) : duration(seconds));
			return;
		}

		case "Away message":
			s.connection.add("Away", text(value));
			return;
		case "Ports":
			s.connection.add("Ports", mono(value));
			return;
		case "SSL Ciphers":
			s.connection.add("TLS cipher", mono(value));
			return;
		case "SSL Fingerprint":
			s.connection.add("Certificate fingerprint", mono(value));
			return;
		case "Opered":
			s.oper.add("Opered", text(value));
			return;
		case "Privileges":
			s.oper.add("Privileges", chips(splitList(value, " ")));
			return;
		case "Channel(s)":
			if (value === "<none>" || value.startsWith("- ")) {
				s.channels.add("Channels", text(value));
			} else {
				s.channels.add("Channels", splitList(value, " ").map(channelValue));
			}

			return;
		case "Capabilities":
			s.caps.add("Capabilities", chips(splitList(value, " ")));
			return;
		case "Marks":
			s.marks.add("Marks", chips(splitList(value, ",")));
			return;
		case "Data sent":
			s.traffic.add("Sent", dataValue(value));
			return;
		case "Data received":
			s.traffic.add("Received", dataValue(value));
			return;
		case "receiveQ size":
			s.traffic.add("Receive queue", queueValue(value));
			return;
		case "sendQ size":
			s.traffic.add("Send queue", queueValue(value));
			return;
		default:
			s.other.add(label, text(value));
	}
}

/**
 * `+<letters>[ <account>[:<ts>]][ <sethost>][ <fakehost>][ <cloakhost>][ <cloakip>]`:
 * the account is the first word after the letters only when the user is +r.
 */
function umodeEntries(s: UserSections, value: string): void {
	if (value === "<none>") {
		s.connection.add("User modes", text(value));
		return;
	}

	const [letters, ...rest] = value.split(/\s+/);
	s.connection.add("User modes", mono(letters));

	if (letters.includes("r") && rest.length > 0) {
		s.identity.add("Account", text(rest.shift()!.replace(/:\d+$/, "")));
	}

	if (rest.length > 0) {
		s.identity.add(
			"Host cloaks",
			rest.map((h) => (isIp(h) ? ip(h) : host(h)))
		);
	}
}

/** `<numeric> on <server>, idle <n>s` (a bouncer connection's activity). */
function activityValue(value: string): ReportValue | ReportValue[] {
	const m = /^(\S+) on (\S+), idle (\d+)s$/.exec(value);
	return m ? [mono(m[1]), server(m[2]), text("idle"), duration(Number(m[3]))] : text(value);
}

function bouncerEntry(section: SectionBuilder, label: string, value: string): void {
	switch (label) {
		case "Session state":
			section.add("State", state(value, value.startsWith("ACTIVE")));
			return;
		case "Session ID":
			section.add("Session ID", mono(value));
			return;

		case "Managing server": {
			const m = /^(\S+) \((local|remote)\)$/.exec(value);
			section.add("Managing server", m ? [server(m[1]), text(m[2])] : text(value));
			return;
		}

		case "Primary":
		case "Alias":
			section.add(label, activityValue(value));
			return;

		case "Session since":
		case "Disconnected":
		case "Connected":
			section.add(label, ctimeValue(value));
			return;

		case "Hold expires": {
			const m = /^(.*?) \((.*remaining)\)$/.exec(value);
			section.add(label, m ? [ctimeValue(m[1]), text(m[2])] : ctimeValue(value));
			return;
		}

		case "Resume count":
			section.add("Resumes", /^\d+$/.test(value) ? number(Number(value)) : text(value));
			return;

		case "Session totals": {
			const m = /^(\S+ Kb) sent \/ (\S+ Kb) recv \((\d+) msgs sent \/ (\d+) recv\)$/.exec(
				value
			);
			const sent = m ? parseKb(m[1]) : undefined;
			const recv = m ? parseKb(m[2]) : undefined;

			if (m && sent !== undefined && recv !== undefined) {
				section.add("Sent", [bytes(sent), text(`${m[3]} messages`)]);
				section.add("Received", [bytes(recv), text(`${m[4]} messages`)]);
			} else {
				section.add(label, text(value));
			}

			return;
		}

		case "IP":
			section.add("IP", isIp(value) ? ip(value) : text(value));
			return;
		case "Server":
			section.add("Server", server(value));
			return;
		case "Numeric":
		case "Port":
			section.add(label, mono(value));
			return;
		case "TLS":
			section.add("TLS", state(value, value === "yes"));
			return;
		default:
			section.add(label, text(value));
	}
}

function splitList(value: string, separator: string): string[] {
	return value
		.split(separator)
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

// --------------------------------------------------------------- channel card

/** ` <oplvl:3> <clones:2> <zombie><status><nick> (<user>@<host>)   (<gecos>^O) <account>` */
const MEMBER_RE = /^ (.{3}) (.{2}) (.)(.)(\S+) \((\S+?)@(\S+)\) {3}\((.*)\x0f\) (\S*)\s*$/;
/** The same without the reset code, for a server that leaves it out. */
const MEMBER_LOOSE_RE = /^ (.{3}) (.{2}) (.)(.)(\S+) \((\S+?)@(\S+)\) {3}\((.*)\) (\S*)\s*$/;

const STATUS_NAMES: Record<string, string> = {
	"~": "alias",
	"<": "delayed",
	"@": "op",
	"%": "halfop",
	"+": "voice",
};

function channelCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const info = new SectionBuilder("Channel");
	const members = new SectionBuilder("Members");
	const totals = new SectionBuilder("Totals");
	const bans = new SectionBuilder("Bans");
	const excepts = new SectionBuilder("Excepts");
	const other = new SectionBuilder("Other");

	const memberRows: Record<string, ReportValue | undefined>[] = [];
	let mode: "info" | "bans" | "excepts" = "info";

	for (const msg of card.body) {
		if (msg.command === "287") {
			const row = memberRow(msg.params[msg.params.length - 1] ?? "");

			if (row) {
				memberRows.push(row);
			} else {
				other.add("Member", text(bodyOf(msg).trim()));
			}

			continue;
		}

		const body = bodyOf(msg);

		if (body.trim() === "" || body.trim() === "<none>") {
			continue;
		}

		if (body.startsWith("Users (")) {
			continue; // the legend; the table says it with words
		}

		const ban = /^\[(\d+)\] - (\S+) - Set by (.+), on (.+)$/.exec(body);

		if (ban && (mode === "bans" || mode === "excepts")) {
			const target = mode === "bans" ? bans : excepts;
			target.table ??= {
				columns: [
					{key: "n", label: "#", align: "right"},
					{key: "mask", label: "Mask"},
					{key: "by", label: "Set by"},
					{key: "when", label: "When"},
				],
				rows: [],
			};
			target.table.rows.push({
				n: number(Number(ban[1])),
				mask: mask(ban[2]),
				by: setterValue(ban[3]),
				when: ctimeValue(ban[4]),
			});
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (!m) {
			other.add("Line", text(body.trim()));
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		switch (label) {
			case "Creation time":
				info.add("Created", ctimeValue(value));
				break;
			case "Destruction time":
				info.add("Destroyed at", ctimeValue(value));
				break;
			case "Topic":
				info.add("Topic", text(value));
				break;
			case "Set by":
				info.add("Topic set by", setterValue(value));
				break;
			case "Channel mode(s)":
				info.add("Modes", value === "<none>" ? text(value) : mono(value));
				break;
			case "Total users":
				totalEntries(totals, value);
				break;
			case "Bans on channel":
				mode = "bans";
				break;
			case "Excepts on channel":
				mode = "excepts";
				break;
			default:
				other.add(label, text(value));
		}
	}

	if (memberRows.length > 0) {
		const has = (key: string) => memberRows.some((r) => r[key] !== undefined);
		members.table = {
			columns: [
				{key: "status", label: "Status"},
				{key: "nick", label: "Nick"},
				{key: "host", label: "User@host"},
				{key: "realname", label: "Real name"},
				...(has("account") ? [{key: "account", label: "Account"}] : []),
				...(has("clones")
					? [{key: "clones", label: "Clones", align: "right" as const}]
					: []),
				...(has("oplevel")
					? [{key: "oplevel", label: "Op level", align: "right" as const}]
					: []),
			],
			rows: memberRows,
		};
	}

	return {
		kind: "check-channel",
		title: `CHECK ${card.target}`,
		subtitle: "Channel",
		command,
		sections: buildSections([info, members, totals, bans, excepts, other]),
		raw: rawLines(lines),
	};
}

function memberRow(param: string): Record<string, ReportValue | undefined> | undefined {
	const m = MEMBER_RE.exec(param) ?? MEMBER_LOOSE_RE.exec(param);

	if (!m) {
		return undefined;
	}

	const [, oplvl, clones, zombie, status, who, user, where, realname, account] = m;
	const words = [zombie === "!" ? "zombie" : "", STATUS_NAMES[status] ?? ""].filter(Boolean);

	return {
		status: words.length > 0 ? text(words.join(" ")) : undefined,
		nick: nick(who),
		host: host(`${user}@${where}`),
		realname: text(realname),
		account: account ? text(account) : undefined,
		clones: clones.trim() ? number(Number(clones.trim())) : undefined,
		oplevel: oplvl.trim() ? number(Number(oplvl.trim())) : undefined,
	};
}

/** `N (O ops, [H halfops, ]V voiced, C clones, A authed, D delayed, L aliases)` */
function totalEntries(section: SectionBuilder, value: string): void {
	const m = /^(\d+) \((.*)\)$/.exec(value);

	if (!m) {
		section.add("Users", text(value));
		return;
	}

	section.add("Users", number(Number(m[1])));

	for (const part of m[2].split(",")) {
		const p = /^\s*(\d+) (\w+)\s*$/.exec(part);

		if (p) {
			section.add(p[2].charAt(0).toUpperCase() + p[2].slice(1), number(Number(p[1])));
		}
	}
}

// ---------------------------------------------------------------- server card

const DOWNLINK_FLAGS: Record<string, string> = {
	"*": "bursting",
	"!": "awaiting EOB ack",
	"=": "service",
	"+": "hub",
};

function serverCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const info = new SectionBuilder("Server");
	const downlinks = new SectionBuilder("Downlinks");
	const other = new SectionBuilder("Other");
	let inDownlinks = false;

	for (const msg of card.body) {
		const body = bodyOf(msg);

		if (body.trim() === "" || body.trim() === "<none>") {
			continue;
		}

		const link = /^\[(\d+)\] - (.)(\S+)$/.exec(body);

		if (inDownlinks && link) {
			downlinks.table ??= {
				columns: [
					{key: "n", label: "#", align: "right"},
					{key: "name", label: "Server"},
					{key: "flag", label: "State"},
				],
				rows: [],
			};
			const flag = DOWNLINK_FLAGS[link[2]];
			downlinks.table.rows.push({
				n: number(Number(link[1])),
				name: server(link[3]),
				flag: flag ? state(flag, link[2] === "+" || link[2] === "=") : undefined,
			});
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (!m) {
			other.add("Line", text(body.trim()));
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		switch (label) {
			case "Downlinks":
				inDownlinks = true;
				break;
			case "Connected at":
				info.add("Connected", ctimeUnixValue(value));
				break;
			case "Server name":
				info.add("Name", server(value));
				break;
			case "NOOP":
				info.add("NOOP", state(value, false));
				break;
			case "SSL Fingerprint":
				info.add("Certificate fingerprint", mono(value));
				break;
			case "SSL Ciphers":
				info.add("TLS cipher", mono(value));
				break;
			case "Numeric":
				info.add("Numeric", mono(value));
				break;

			case "Users": {
				const u = /^(\d+) \/ (\d+)$/.exec(value);
				info.add(
					"Users",
					u ? [number(Number(u[1])), text("of"), number(Number(u[2]))] : text(value)
				);
				break;
			}

			case "Status":
				info.add("Status", text(value));
				break;
			case "Class":
				info.add("Class", text(value));
				break;
			default:
				other.add(label, text(value));
		}
	}

	return {
		kind: "check-server",
		title: `CHECK ${card.target}`,
		subtitle: "Server",
		command,
		sections: buildSections([info, downlinks, other]),
		raw: rawLines(lines),
	};
}

// -------------------------------------------------------------- host search

function hostCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const matches = new SectionBuilder("Matches");
	const other = new SectionBuilder("Other");
	const notes: string[] = [];
	const rows: Record<string, ReportValue | undefined>[] = [];
	/** Each row's channels with their prefixes (`@#seance`), as `-c` lists them. */
	const channelLists: string[][] = [];
	let found: number | undefined;

	for (const msg of card.body) {
		const body = bodyOf(msg);

		if (body.trim() === "") {
			continue;
		}

		if (/^No\.\s+Nick\s+User\s+Host$/.test(body)) {
			continue;
		}

		const row = /^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(body);

		if (row) {
			rows.push({
				n: number(Number(row[1])),
				nick: nick(row[2]),
				user: text(row[3]),
				host: isIp(row[4]) ? ip(row[4]) : host(row[4]),
			});
			channelLists.push([]);
			continue;
		}

		// `      on channels: +#seance #help ` after a row (a long list wraps
		// onto another such line).
		const chans = /^\s+on channels: (.*)$/.exec(body);

		if (chans) {
			channelLists[channelLists.length - 1]?.push(...splitList(chans[1], " "));
			continue;
		}

		if (/^More than \d+ results, truncating\.\.\.$/.test(body.trim())) {
			notes.push(`${body.trim()} The server stops at its MAX_CHECK_OUTPUT limit.`);
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (m && m[1].trim() === "Matching records found") {
			found = Number(clean(m[2] ?? ""));
			continue;
		}

		other.add(m ? m[1].trim() : "Line", text(m ? clean(m[2] ?? "") : body.trim()));
	}

	// A table cell holds one value: a row's channels are chips, prefixes kept.
	const withChannels = channelLists.some((list) => list.length > 0);

	rows.forEach((row, i) => {
		if (channelLists[i].length > 0) {
			row.channels = chips(channelLists[i]);
		}
	});

	if (rows.length > 0) {
		matches.table = {
			columns: [
				{key: "n", label: "#", align: "right"},
				{key: "nick", label: "Nick"},
				{key: "user", label: "User"},
				{key: "host", label: "Host"},
				...(withChannels ? [{key: "channels", label: "Channels"}] : []),
			],
			rows,
		};
	}

	const count = found ?? rows.length;

	return {
		kind: "check-host",
		title: `CHECK ${card.target}`,
		subtitle: count === 1 ? "1 match" : `${count} matches`,
		command,
		sections: buildSections([matches, other]),
		...(notes.length > 0 ? {notes} : {}),
		raw: rawLines(lines),
	};
}

// ---------------------------------------------------------------------- entry

/** A human reading of the reply's error numeric. */
function humanError(lines: IrcMessage[], target: string): string | undefined {
	const err = lines.find((msg) => /^[45]\d\d$/.test(msg.command) || msg.command === "292");

	if (!err) {
		return undefined;
	}

	switch (err.command) {
		case "292":
			return `No matching user, channel, server or host${target ? ` for ${target}` : ""}`;
		case "481":
			return "Permission denied: you are not an IRC operator";
		case "517":
			return "You don't have the CHECK privilege";
		case "461":
			return "CHECK needs a target: a nick, a channel, a server or a hostmask";
		case "402":
			return `No such server: ${err.params[1] ?? target}`;
		default:
			return errorOf([err]);
	}
}

/** The report for a CHECK reply; undefined when the lines are not one. */
export function checkReport(lines: IrcMessage[], command: string): OperReport | undefined {
	const card = readCard(lines);

	if (!card) {
		const noMatch = lines.find((msg) => msg.command === "292");
		// `292 <me> :CHECK <target> No matching record(s) found`
		const named = noMatch ? /^CHECK (\S+) /.exec(bodyOf(noMatch))?.[1] : undefined;
		const target = named ?? commandTarget(command);
		const error = humanError(lines, target);

		if (!error) {
			return undefined;
		}

		return errorReport("check", `CHECK ${target}`.trim(), command, lines, error);
	}

	switch (card.type) {
		case "channel":
			return channelCard(card, command, lines);
		case "server":
			return serverCard(card, command, lines);
		case "host":
			return hostCard(card, command, lines);
		default:
			return userCard(card, command, lines);
	}
}
