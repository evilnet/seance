/**
 * IRC-operator types shared by the IRC layer and the UI
 * (docs/projects/oper-tools.md).
 */

/** How much of an operator this connection is, from its own user modes. */
export type OperLevel = "none" | "local" | "global" | "admin" | "service";

/** What the UI knows about being an oper on one network (`oper:state`). */
export type SharedOperState = {
	level: OperLevel;
	/** `PRIVS` names (`KILL`, `CHECK`, `WIDE_GLINE`, …); empty until the reply is in. */
	privs: string[];
	/** The PRIVS reply has arrived (an empty list then means "none"). */
	privsKnown: boolean;
	/** The server notice mask from the last 008, when known. */
	snomask?: number;
	/** Our own user modes, letters only (`owsgx`). */
	umodes: string;
	/** Server profile id (`nefarious2`, `ircu`, `generic`): which tables apply. */
	profile: string;
	/** Feature values the oper tools asked for (`CONNEXIT_NOTICES` → `FALSE`). */
	features: Record<string, string>;
};

/**
 * Where a server-volunteered line goes: the window the user is looking at,
 * the network's lobby (no unread), or nowhere.
 */
export type Route = "active" | "network" | "off";

/** What a classified server notice or WALLOPS carries on its message. */
export type SnoticeInfo = {
	/** Stable kind id (`gline.add`, `client.connect`, `wallops`, …). */
	kind: string;
	/** The snomask bit it travels on (`GLINE`, `CONNEXIT`), or a family for WALLOPS. */
	category: string;
	/** Extracted fields: nick, user, host, ip, mask, reason, oper, server, … */
	fields: Record<string, string>;
	/** The server it came from, when not the one we are on (relayed global notices). */
	origin?: string;
	/** Where it was routed: an active-routed line restored on reload says so. */
	route?: Route;
};

/**
 * One typed value in a report. The renderer formats it by type (a nick is
 * clickable, a time relative, bytes humanised) and copies it as `text`.
 */
export type ReportValue =
	| {t: "text"; v: string}
	| {t: "mono"; v: string}
	| {t: "nick"; v: string}
	| {t: "ip"; v: string}
	| {t: "host"; v: string}
	| {t: "mask"; v: string}
	| {t: "server"; v: string}
	| {t: "channel"; v: string; prefix?: string}
	/** An absolute time (epoch ms); `text` is what the server printed. */
	| {t: "time"; v: number; text?: string}
	/** When something ends (epoch ms); 0 for never. */
	| {t: "expiry"; v: number}
	/** A length of time in seconds. */
	| {t: "duration"; v: number}
	| {t: "bytes"; v: number}
	| {t: "number"; v: number}
	| {t: "chips"; v: string[]}
	/** A state badge: `ok` colours it as good (active) or not (inactive). */
	| {t: "state"; v: string; ok: boolean};

export type ReportColumn = {
	key: string;
	label: string;
	/** Numbers read better right-aligned. */
	align?: "left" | "right";
};

export type ReportTable = {
	columns: ReportColumn[];
	rows: Record<string, ReportValue | undefined>[];
};

export type ReportEntry = {
	label: string;
	value: ReportValue | ReportValue[];
};

/** A titled block of a report: label/value pairs, a table, or both. */
export type ReportSection = {
	title?: string;
	entries?: ReportEntry[];
	table?: ReportTable;
	/** Free lines shown monospaced (a reply nobody parses). */
	lines?: string[];
};

/**
 * A structured answer to an oper command (`MessageType.REPORT`): what
 * `/stats`, `/check`, `/privs` render as instead of raw numerics.
 */
export type OperReport = {
	/** `stats`, `check-user`, `check-channel`, `check-server`, `check-host`, `privs`, `raw`. */
	kind: string;
	title: string;
	subtitle?: string;
	/** The line that was sent, for the header and the Refresh button. */
	command: string;
	sections: ReportSection[];
	/** Warnings (a truncated search) and the like. */
	notes?: string[];
	/** The reply as text, one line per numeric, for "raw" and copy. */
	raw: string[];
	/** An error reply (481, 517, …) instead of a result. */
	error?: string;
};
