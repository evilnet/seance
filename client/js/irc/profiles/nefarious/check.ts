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
import {t, tCount} from "../../../i18n/core";
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
	const identity = new SectionBuilder(t("oper.check.section.identity"));
	const connection = new SectionBuilder(t("oper.check.section.connection"));
	const oper = new SectionBuilder(t("oper.check.section.oper"));
	const channels = new SectionBuilder(t("oper.check.section.channels"));
	const caps = new SectionBuilder(t("oper.check.section.capabilities"));
	const marks = new SectionBuilder(t("oper.check.section.marks"));
	const traffic = new SectionBuilder(t("oper.check.section.traffic"));
	const other = new SectionBuilder(t("oper.check.section.other"));
	const bouncer = new SectionBuilder(t("oper.check.section.bouncerSession"));
	const bouncerSubs: SectionBuilder[] = [];
	const detail = new SectionBuilder(t("oper.check.section.bouncerDetail"));

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
							? state(t("oper.check.history.connected"), true)
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
					local: local ? text(t("oper.check.alias.local")) : undefined,
				});
			} else {
				other.add(t("oper.check.row.line"), text(item.raw.trim()));
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
				section = new SectionBuilder(t("oper.check.section.bouncerPrimary"));
				bouncerSubs.push(section);
				table = undefined;
				continue;
			}

			if (label === "Primary (remote)" && value === "") {
				section = new SectionBuilder(t("oper.check.section.bouncerPrimaryRemote"));
				bouncerSubs.push(section);
				table = undefined;
				continue;
			}

			if (label === "Aliases") {
				const sub = new SectionBuilder(t("oper.check.section.bouncerAliases"));
				aliasTable = {
					columns: [
						{key: "n", label: "#", align: "right"},
						{key: "numeric", label: t("oper.check.col.numeric")},
						{key: "server", label: t("oper.check.col.server")},
						{key: "modes", label: t("oper.check.col.modes")},
						{key: "local", label: t("oper.check.col.where")},
					],
					rows: [],
				};
				sub.table = aliasTable;
				bouncerSubs.push(sub);
				table = "aliases";
				continue;
			}

			if (label === "Connection History") {
				const sub = new SectionBuilder(t("oper.check.section.connectionHistory"));
				historyTable = {
					columns: [
						{key: "n", label: "#", align: "right"},
						{key: "ip", label: t("oper.check.col.ip")},
						{key: "host", label: t("oper.check.col.host")},
						{key: "count", label: t("oper.check.col.times"), align: "right"},
						{key: "last", label: t("oper.check.col.lastConnected")},
						{key: "until", label: t("oper.check.col.until")},
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
		subtitle: t("oper.check.subtitle.user"),
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
	return m ? [bytes(Number(m[1])), text(t("oper.check.of")), bytes(Number(m[2]))] : text(value);
}

/** `N messages`, the count as the server printed it. */
function messagesText(count: string): string {
	return tCount("oper.check.messages", Number(count));
}

/** `<A.aaa> Kb (<n> protocol messages)` → [bytes, "n messages"]. */
function dataValue(value: string): ReportValue | ReportValue[] {
	const m = /^(\S+ Kb) \((\d+) protocol messages\)$/.exec(value);
	const amount = m ? parseKb(m[1]) : undefined;

	if (!m || amount === undefined) {
		return text(value);
	}

	return [bytes(amount), text(messagesText(m[2]))];
}

function userEntry(s: UserSections, label: string, value: string): void {
	switch (label) {
		case "Nick": {
			const m = /^(\S+) \((\S+)\)$/.exec(value);
			s.identity.add(t("oper.check.row.nick"), nick(m ? m[1] : value));

			if (m) {
				s.identity.add(t("oper.check.row.numeric"), text(m[2]));
			}

			return;
		}

		case "User/Hostmask":
			s.identity.add(t("oper.check.row.visibleHost"), host(value));
			return;

		case "Real User/Host": {
			const [real, addr] = hostAndIp(value);
			s.identity.add(t("oper.check.row.realHost"), real);
			s.identity.add(t("oper.check.row.ip"), addr);
			return;
		}

		case "Connect host/ip":
			s.identity.add(t("oper.check.row.connectedVia"), hostAndIp(value));
			return;
		case "Real Name":
			s.identity.add(t("oper.check.row.realName"), text(value));
			return;
		case "Status":
			s.identity.add(t("oper.check.row.status"), text(value));
			return;
		case "Bouncer Alias":
		case "Alias Numeric":
			s.identity.add(label, text(value));
			return;
		case "Class":
			s.identity.add(t("oper.check.row.class"), text(value));
			return;
		case "Country":
		case "Continent":
			s.identity.add(label, text(value));
			return;
		case "Connected to":
			s.identity.add(t("oper.check.row.server"), server(value));
			return;
		case "Session ID":
			s.identity.add(t("oper.check.row.sessionID"), mono(value));
			return;
		case "CTCP Version":
		case "SWHOIS":
		case "WebIRC":
		case "Kill":
			s.identity.add(label, text(value));
			return;
		case "Exemptions":
			s.identity.add(t("oper.check.row.exemptions"), chips(splitList(value, ",")));
			return;
		case "Umode(s)":
			umodeEntries(s, value);
			return;
		case "Signed on":
			s.connection.add(t("oper.check.row.signedOn"), ctimeValue(value));
			return;
		case "Timestamp":
			s.connection.add(t("oper.check.row.nickTS"), ctimeUnixValue(value));
			return;

		case "Idle for": {
			const seconds = parseIdle(value);
			s.connection.add(
				t("oper.check.row.idle"),
				seconds === undefined ? text(value) : duration(seconds)
			);
			return;
		}

		case "Away message":
			s.connection.add(t("oper.check.row.away"), text(value));
			return;
		case "Ports":
			s.connection.add(t("oper.check.row.ports"), mono(value));
			return;
		case "SSL Ciphers":
			s.connection.add(t("oper.check.row.tlsCipher"), mono(value));
			return;
		case "SSL Fingerprint":
			s.connection.add(t("oper.check.row.certificateFingerprint"), mono(value));
			return;
		case "Opered":
			s.oper.add(t("oper.check.row.opered"), text(value));
			return;
		case "Privileges":
			s.oper.add(t("oper.check.row.privileges"), chips(splitList(value, " ")));
			return;
		case "Channel(s)":
			if (value === "<none>" || value.startsWith("- ")) {
				s.channels.add(t("oper.check.row.channels"), text(value));
			} else {
				s.channels.add(
					t("oper.check.row.channels"),
					splitList(value, " ").map(channelValue)
				);
			}

			return;
		case "Capabilities":
			s.caps.add(t("oper.check.row.capabilities"), chips(splitList(value, " ")));
			return;
		case "Marks":
			s.marks.add(t("oper.check.row.marks"), chips(splitList(value, ",")));
			return;
		case "Data sent":
			s.traffic.add(t("oper.check.row.sent"), dataValue(value));
			return;
		case "Data received":
			s.traffic.add(t("oper.check.row.received"), dataValue(value));
			return;
		case "receiveQ size":
			s.traffic.add(t("oper.check.row.receiveQueue"), queueValue(value));
			return;
		case "sendQ size":
			s.traffic.add(t("oper.check.row.sendQueue"), queueValue(value));
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
		s.connection.add(t("oper.check.row.userModes"), text(value));
		return;
	}

	const [letters, ...rest] = value.split(/\s+/);
	s.connection.add(t("oper.check.row.userModes"), mono(letters));

	if (letters.includes("r") && rest.length > 0) {
		s.identity.add(t("oper.check.row.account"), text(rest.shift()!.replace(/:\d+$/, "")));
	}

	if (rest.length > 0) {
		s.identity.add(
			t("oper.check.row.hostCloaks"),
			rest.map((h) => (isIp(h) ? ip(h) : host(h)))
		);
	}
}

/** `<numeric> on <server>, idle <n>s` (a bouncer connection's activity). */
function activityValue(value: string): ReportValue | ReportValue[] {
	const m = /^(\S+) on (\S+), idle (\d+)s$/.exec(value);
	return m
		? [mono(m[1]), server(m[2]), text(t("oper.check.idle")), duration(Number(m[3]))]
		: text(value);
}

function bouncerEntry(section: SectionBuilder, label: string, value: string): void {
	switch (label) {
		case "Session state":
			section.add(t("oper.check.row.state"), state(value, value.startsWith("ACTIVE")));
			return;
		case "Session ID":
			section.add(t("oper.check.row.sessionID"), mono(value));
			return;

		case "Managing server": {
			const m = /^(\S+) \((local|remote)\)$/.exec(value);
			section.add(
				t("oper.check.row.managingServer"),
				m
					? [
							server(m[1]),
							text(
								m[2] === "local"
									? t("oper.check.managing.local")
									: t("oper.check.managing.remote")
							),
					  ]
					: text(value)
			);
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
			section.add(
				t("oper.check.row.resumes"),
				/^\d+$/.test(value) ? number(Number(value)) : text(value)
			);
			return;

		case "Session totals": {
			const m = /^(\S+ Kb) sent \/ (\S+ Kb) recv \((\d+) msgs sent \/ (\d+) recv\)$/.exec(
				value
			);
			const sent = m ? parseKb(m[1]) : undefined;
			const recv = m ? parseKb(m[2]) : undefined;

			if (m && sent !== undefined && recv !== undefined) {
				section.add(t("oper.check.row.sent"), [bytes(sent), text(messagesText(m[3]))]);
				section.add(t("oper.check.row.received"), [bytes(recv), text(messagesText(m[4]))]);
			} else {
				section.add(label, text(value));
			}

			return;
		}

		case "IP":
			section.add(t("oper.check.row.ip"), isIp(value) ? ip(value) : text(value));
			return;
		case "Server":
			section.add(t("oper.check.row.server"), server(value));
			return;
		case "Numeric":
		case "Port":
			section.add(label, mono(value));
			return;
		case "TLS":
			section.add(t("oper.check.row.tls"), state(value, value === "yes"));
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

/** A member's status prefix in words; "" for none. */
function statusName(prefix: string): string {
	switch (prefix) {
		case "~":
			return t("oper.check.status.alias");
		case "<":
			return t("oper.check.status.delayed");
		case "@":
			return t("oper.check.status.op");
		case "%":
			return t("oper.check.status.halfop");
		case "+":
			return t("oper.check.status.voice");
		default:
			return "";
	}
}

/** A member's status in words, a zombie (`!`, parted but kept) said so. */
function memberStatus(zombie: boolean, prefix: string): string | undefined {
	const name = statusName(prefix);

	if (zombie) {
		return name
			? t("oper.check.status.zombieWith", {status: name})
			: t("oper.check.status.zombie");
	}

	return name || undefined;
}

function channelCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const info = new SectionBuilder(t("oper.check.section.channel"));
	const members = new SectionBuilder(t("oper.check.section.members"));
	const totals = new SectionBuilder(t("oper.check.section.totals"));
	const bans = new SectionBuilder(t("oper.check.section.bans"));
	const excepts = new SectionBuilder(t("oper.check.section.excepts"));
	const other = new SectionBuilder(t("oper.check.section.other"));

	const memberRows: Record<string, ReportValue | undefined>[] = [];
	let mode: "info" | "bans" | "excepts" = "info";

	for (const msg of card.body) {
		if (msg.command === "287") {
			const row = memberRow(msg.params[msg.params.length - 1] ?? "");

			if (row) {
				memberRows.push(row);
			} else {
				other.add(t("oper.check.row.member"), text(bodyOf(msg).trim()));
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
					{key: "mask", label: t("oper.check.col.mask")},
					{key: "by", label: t("oper.check.col.setBy")},
					{key: "when", label: t("oper.check.col.when")},
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
			other.add(t("oper.check.row.line"), text(body.trim()));
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		switch (label) {
			case "Creation time":
				info.add(t("oper.check.row.created"), ctimeValue(value));
				break;
			case "Destruction time":
				info.add(t("oper.check.row.destroyedAt"), ctimeValue(value));
				break;
			case "Topic":
				info.add(t("oper.check.row.topic"), text(value));
				break;
			case "Set by":
				info.add(t("oper.check.row.topicSetBy"), setterValue(value));
				break;
			case "Channel mode(s)":
				info.add(t("oper.check.row.modes"), value === "<none>" ? text(value) : mono(value));
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
				{key: "status", label: t("oper.check.col.status")},
				{key: "nick", label: t("oper.check.col.nick")},
				{key: "host", label: t("oper.check.col.userHost")},
				{key: "realname", label: t("oper.check.col.realName")},
				...(has("account") ? [{key: "account", label: t("oper.check.col.account")}] : []),
				...(has("clones")
					? [{key: "clones", label: t("oper.check.col.clones"), align: "right" as const}]
					: []),
				...(has("oplevel")
					? [
							{
								key: "oplevel",
								label: t("oper.check.col.opLevel"),
								align: "right" as const,
							},
					  ]
					: []),
			],
			rows: memberRows,
		};
	}

	return {
		kind: "check-channel",
		title: `CHECK ${card.target}`,
		subtitle: t("oper.check.subtitle.channel"),
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
	const words = memberStatus(zombie === "!", status);

	return {
		status: words ? text(words) : undefined,
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
		section.add(t("oper.check.row.users"), text(value));
		return;
	}

	section.add(t("oper.check.row.users"), number(Number(m[1])));

	for (const part of m[2].split(",")) {
		const p = /^\s*(\d+) (\w+)\s*$/.exec(part);

		if (p) {
			section.add(totalLabel(p[2]), number(Number(p[1])));
		}
	}
}

/** A word of the channel card's total line (`3 ops`) as a row label. */
function totalLabel(word: string): string {
	switch (word) {
		case "ops":
			return t("oper.check.total.ops");
		case "halfops":
			return t("oper.check.total.halfops");
		case "voiced":
			return t("oper.check.total.voiced");
		case "clones":
			return t("oper.check.total.clones");
		case "authed":
			return t("oper.check.total.authed");
		case "delayed":
			return t("oper.check.total.delayed");
		case "aliases":
			return t("oper.check.total.aliases");
		default:
			return word.charAt(0).toUpperCase() + word.slice(1);
	}
}

// ---------------------------------------------------------------- server card

/** A downlink's flag character in words; undefined for none. */
function downlinkFlag(flag: string): string | undefined {
	switch (flag) {
		case "*":
			return t("oper.check.downlink.bursting");
		case "!":
			return t("oper.check.downlink.awaitingAck");
		case "=":
			return t("oper.check.downlink.service");
		case "+":
			return t("oper.check.downlink.hub");
		default:
			return undefined;
	}
}

function serverCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const info = new SectionBuilder(t("oper.check.section.server"));
	const downlinks = new SectionBuilder(t("oper.check.section.downlinks"));
	const other = new SectionBuilder(t("oper.check.section.other"));
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
					{key: "name", label: t("oper.check.col.server")},
					{key: "flag", label: t("oper.check.col.state")},
				],
				rows: [],
			};
			const flag = downlinkFlag(link[2]);
			downlinks.table.rows.push({
				n: number(Number(link[1])),
				name: server(link[3]),
				flag: flag ? state(flag, link[2] === "+" || link[2] === "=") : undefined,
			});
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (!m) {
			other.add(t("oper.check.row.line"), text(body.trim()));
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		switch (label) {
			case "Downlinks":
				inDownlinks = true;
				break;
			case "Connected at":
				info.add(t("oper.check.row.connected"), ctimeUnixValue(value));
				break;
			case "Server name":
				info.add(t("oper.check.row.name"), server(value));
				break;
			case "NOOP":
				info.add("NOOP", state(value, false));
				break;
			case "SSL Fingerprint":
				info.add(t("oper.check.row.certificateFingerprint"), mono(value));
				break;
			case "SSL Ciphers":
				info.add(t("oper.check.row.tlsCipher"), mono(value));
				break;
			case "Numeric":
				info.add(t("oper.check.row.numeric"), mono(value));
				break;

			case "Users": {
				const u = /^(\d+) \/ (\d+)$/.exec(value);
				info.add(
					t("oper.check.row.users"),
					u
						? [number(Number(u[1])), text(t("oper.check.of")), number(Number(u[2]))]
						: text(value)
				);
				break;
			}

			case "Status":
				info.add(t("oper.check.row.status"), text(value));
				break;
			case "Class":
				info.add(t("oper.check.row.class"), text(value));
				break;
			default:
				other.add(label, text(value));
		}
	}

	return {
		kind: "check-server",
		title: `CHECK ${card.target}`,
		subtitle: t("oper.check.subtitle.server"),
		command,
		sections: buildSections([info, downlinks, other]),
		raw: rawLines(lines),
	};
}

// -------------------------------------------------------------- host search

function hostCard(card: Card, command: string, lines: IrcMessage[]): OperReport {
	const matches = new SectionBuilder(t("oper.check.section.matches"));
	const other = new SectionBuilder(t("oper.check.section.other"));
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
			notes.push(t("oper.check.truncated", {line: body.trim()}));
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (m && m[1].trim() === "Matching records found") {
			found = Number(clean(m[2] ?? ""));
			continue;
		}

		other.add(
			m ? m[1].trim() : t("oper.check.row.line"),
			text(m ? clean(m[2] ?? "") : body.trim())
		);
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
				{key: "nick", label: t("oper.check.col.nick")},
				{key: "user", label: t("oper.check.col.user")},
				{key: "host", label: t("oper.check.col.host")},
				...(withChannels ? [{key: "channels", label: t("oper.check.col.channels")}] : []),
			],
			rows,
		};
	}

	const count = found ?? rows.length;

	return {
		kind: "check-host",
		title: `CHECK ${card.target}`,
		subtitle: tCount("oper.check.subtitle.matches", count),
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
			return target
				? t("oper.check.error.noMatchFor", {target})
				: t("oper.check.error.noMatch");
		case "481":
			return t("oper.check.error.notOper");
		case "517":
			return t("oper.check.error.noPrivilege");
		case "461":
			return t("oper.check.error.needsTarget");
		case "402":
			return t("oper.check.error.noSuchServer", {server: err.params[1] ?? target});
		default:
			return errorOf([err]);
	}
}

// ------------------------------------------------- the card as plain facts

/** One member row of a channel card, as the investigation reads it. */
export interface CheckMember {
	nick: string;
	ident: string;
	host: string;
	realname: string;
	account?: string;
	/** `@`, `+`, `%`, `<` (delayed), `~` (alias) or "". */
	status: string;
	clones?: number;
	oplevel?: number;
}

/** A ban row of a channel card. */
export interface CheckBan {
	mask: string;
	by: string;
	/** Epoch ms, when the ctime parses. */
	at?: number;
}

/**
 * A CHECK reply as the facts it states, for the investigation cards
 * (irc/investigate.ts): every `Label:: value` (a repeated label's values
 * joined with a space), the member rows and the ban rows of a channel
 * card. `error` is the human reading of a refusal; undefined when the
 * lines are no CHECK reply at all.
 */
export interface CheckFacts {
	type: "user" | "channel" | "server" | "host";
	target: string;
	fields: Record<string, string>;
	members: CheckMember[];
	bans: CheckBan[];
	error?: string;
}

export function parseCheck(lines: IrcMessage[], command = ""): CheckFacts | undefined {
	const card = readCard(lines);

	if (!card) {
		const target = commandTarget(command);
		const error = humanError(lines, target);
		return error ? {type: "user", target, fields: {}, members: [], bans: [], error} : undefined;
	}

	const type =
		(["user", "channel", "server", "host"] as const).find((kind) => kind === card.type) ??
		"user";
	const facts: CheckFacts = {type, target: card.target, fields: {}, members: [], bans: []};
	let inBans = false;

	for (const msg of card.body) {
		if (msg.command === "287") {
			const m =
				MEMBER_RE.exec(msg.params[msg.params.length - 1] ?? "") ??
				MEMBER_LOOSE_RE.exec(msg.params[msg.params.length - 1] ?? "");

			if (m) {
				const [, oplvl, clones, , status, who, user, where, realname, account] = m;
				const member: CheckMember = {
					nick: who,
					ident: user,
					host: where,
					realname,
					status: status.trim(),
				};

				if (account) {
					member.account = account;
				}

				if (clones.trim()) {
					member.clones = Number(clones.trim());
				}

				if (oplvl.trim()) {
					member.oplevel = Number(oplvl.trim());
				}

				facts.members.push(member);
			}

			continue;
		}

		const body = bodyOf(msg);
		const ban = /^\[(\d+)\] - (\S+) - Set by (.+), on (.+)$/.exec(body);

		if (ban && inBans) {
			const at = parseCtime(ban[4]);
			facts.bans.push(
				at === undefined ? {mask: ban[2], by: ban[3]} : {mask: ban[2], by: ban[3], at}
			);
			continue;
		}

		const m = LABEL_RE.exec(body);

		if (!m) {
			continue;
		}

		const label = m[1].trim();
		const value = clean(m[2] ?? "");

		if (label === "Bans on channel") {
			inBans = true;
			continue;
		}

		if (label === "Excepts on channel") {
			inBans = false;
			continue;
		}

		if (value === "" || value === "<none>") {
			continue;
		}

		facts.fields[label] = facts.fields[label] ? `${facts.fields[label]} ${value}` : value;
	}

	return facts;
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
