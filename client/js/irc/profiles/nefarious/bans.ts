/**
 * nefarious2 G-lines, shuns and Z-lines from the oper dialog: mask
 * suggestions for a user, the server's own mask-width rules checked before
 * sending (so the oper reads why instead of a bare 520), durations, and the
 * line to send. docs/resources/nefarious2-oper.md §11.
 *
 * Kept free of store/DOM imports (mocha).
 */

export type BanType = "gline" | "shun" | "zline";

/** The longest a G-line, shun or Z-line may run (7 days). */
export const BAN_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Units ParseInterval knows (`ircd/ircd_string.c`): `M` is a month, `m` a minute. */
const UNITS: Record<string, number> = {
	y: 365 * 86400,
	M: 31 * 86400,
	w: 7 * 86400,
	d: 86400,
	h: 3600,
	m: 60,
	s: 1,
};

/**
 * A duration as the oper types it — plain seconds or `1d2h30m` — in
 * seconds; undefined when it is not one (the server would count an unknown
 * character as zero instead of saying so).
 */
export function parseDuration(text: string): number | undefined {
	const value = text.trim();

	if (/^\d+$/.test(value)) {
		const seconds = Number(value);
		return seconds > 0 ? seconds : undefined;
	}

	if (!/^(?:\d+[yMwdhms])+\d*$/.test(value)) {
		return undefined;
	}

	let total = 0;

	for (const [, n, unit] of value.matchAll(/(\d+)([yMwdhms])/g)) {
		total += Number(n) * UNITS[unit];
	}

	const tail = /(\d+)$/.exec(value);

	if (tail && /[yMwdhms]\d+$/.test(value)) {
		total += Number(tail[1]); // a trailing bare number is seconds
	}

	return total > 0 ? total : undefined;
}

/** `1d 2h` style text for a number of seconds (largest two units). */
export function formatDuration(seconds: number): string {
	const parts: string[] = [];
	let rest = Math.max(0, Math.round(seconds));

	for (const [unit, size] of [
		["d", 86400],
		["h", 3600],
		["m", 60],
		["s", 1],
	] as const) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${unit}`);
			rest %= size;
		}

		if (parts.length === 2) {
			break;
		}
	}

	return parts.join(" ") || "0s";
}

/** What the oper knows about a user, for {@link maskSuggestions}. */
export interface UserAddress {
	ident?: string;
	/** The real IP (an oper's WHO `%i`). */
	ip?: string;
	/** The real host name (an oper's USERHOST), when it is not just the IP. */
	host?: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The masks worth offering for banning one user, most precise first. */
export function maskSuggestions(type: BanType, user: UserAddress): {mask: string; label: string}[] {
	const out: {mask: string; label: string}[] = [];
	const ip = user.ip && user.ip !== "0" && user.ip !== "255.255.255.255" ? user.ip : undefined;
	const ident = user.ident && !user.ident.startsWith("~") ? user.ident : undefined;

	if (type === "zline") {
		if (ip) {
			out.push({mask: ip, label: "This IP"});
			const v4 = IPV4.exec(ip);

			if (v4) {
				out.push({mask: `${v4[1]}.${v4[2]}.${v4[3]}.0/24`, label: "The /24"});
			}
		}

		return out;
	}

	if (ip) {
		out.push({mask: `*@${ip}`, label: "This IP"});

		if (ident) {
			out.push({mask: `${ident}@${ip}`, label: "This ident on this IP"});
		}

		const v4 = IPV4.exec(ip);

		if (v4) {
			out.push({mask: `*@${v4[1]}.${v4[2]}.${v4[3]}.0/24`, label: "The /24 (needs force)"});
		}
	}

	if (user.host && user.host !== ip) {
		out.push({mask: `*@${user.host}`, label: "This host name"});
	}

	return out;
}

/** A bare host becomes `*@host`, as the server reads it; other masks are as typed. */
export function normaliseMask(type: BanType, mask: string): string {
	const value = mask.trim();

	if (type === "zline" || value.startsWith("$") || /^[#&]/.test(value) || value.includes("@")) {
		return value;
	}

	return `*@${value}`;
}

export interface MaskCheck {
	/** Why the server would refuse it, even forced. */
	error?: string;
	/** It is wide: the server takes it only forced (`!`, PRIV_WIDE_*). */
	needsForce: boolean;
}

function checkIp(host: string): MaskCheck | undefined {
	const cidr = /^([0-9a-f.:*?]+?)(?:\/(\d{1,3}))?$/i.exec(host);

	if (!cidr || !/[.:]/.test(cidr[1]) || !/^[0-9a-f.:*?]+$/i.test(cidr[1])) {
		return undefined; // not an IP mask
	}

	const v6 = cidr[1].includes(":");
	const wild = /[*?]/.test(cidr[1]);
	let bits = cidr[2] === undefined ? (v6 ? 128 : 32) : Number(cidr[2]);

	if (!v6 && wild) {
		// `1.2.3.*` is a /24, `1.2.*` a /16: count the fixed octets.
		const fixed = cidr[1].split(".").findIndex((part) => /[*?]/.test(part));
		bits = Math.min(bits, Math.max(0, fixed) * 8);
	}

	if (bits > (v6 ? 128 : 32)) {
		return {error: "That CIDR has more bits than an address.", needsForce: false};
	}

	if (bits < 16) {
		return {error: "Wider than /16: the server refuses it even forced.", needsForce: false};
	}

	return {needsForce: wild || bits < (v6 ? 128 : 32)};
}

/**
 * The server's width rules (`gline_checkmask`), checked here so the dialog
 * can say why before sending. Applies to the host part of user@host masks
 * and to Z-line IP masks; realname (`$R`), version (`$V`) and channel masks
 * have no width rule.
 */
export function checkMask(type: BanType, rawMask: string): MaskCheck {
	const mask = normaliseMask(type, rawMask);

	if (mask === "" || mask === "*@") {
		return {error: "Enter a mask.", needsForce: false};
	}

	if (/\s/.test(mask)) {
		return {error: "A mask cannot contain spaces (use ? for one).", needsForce: false};
	}

	if (mask.startsWith("$")) {
		if (type === "zline") {
			return {error: "Z-lines take IP masks only.", needsForce: false};
		}

		return /^\$[RV].+/.test(mask)
			? {needsForce: false}
			: {error: "Only $R (realname) and $V (CTCP version) masks exist.", needsForce: false};
	}

	if (/^[#&]/.test(mask)) {
		return type === "gline"
			? {needsForce: false}
			: {error: "Only a G-line can ban a channel name.", needsForce: false};
	}

	if (type === "zline") {
		if (mask.includes("@") || !/^[0-9a-f.:*?/]+$/i.test(mask)) {
			return {error: "Z-line masks must be an IP address or CIDR.", needsForce: false};
		}

		return (
			checkIp(mask) ?? {
				error: "Z-line masks must be an IP address or CIDR.",
				needsForce: false,
			}
		);
	}

	const host = mask.slice(mask.lastIndexOf("@") + 1);

	if (host === "") {
		return {error: "The host part is empty.", needsForce: false};
	}

	const ip = checkIp(host);

	if (ip) {
		return ip;
	}

	const labels = host.split(".");

	if (labels.length < 3 && /[*?]/.test(host)) {
		return {error: "A wildcard host needs at least two dots.", needsForce: false};
	}

	if (labels.slice(-2).some((label) => /[*?]/.test(label))) {
		return {
			error: "No wildcards in the last two labels (*.com bans the world).",
			needsForce: false,
		};
	}

	return {needsForce: /[*?]/.test(host)};
}

export interface BanRequest {
	type: BanType;
	mask: string;
	/** `*` for the whole network, else a server name (local to it), "" for this server. */
	scope: string;
	seconds: number;
	reason: string;
	force?: boolean;
}

/**
 * The line that adds a ban. Duration in plain seconds — every server reads
 * those the same (a remote server reads `1d` with `atoi` on some paths).
 * The reason is the trailing parameter, as the server requires.
 */
export function banLine(ban: BanRequest): string {
	const command = ban.type.toUpperCase();
	const mask = `${ban.force ? "!" : ""}+${normaliseMask(ban.type, ban.mask)}`;
	const target = ban.scope ? ` ${ban.scope}` : "";
	return `${command} ${mask}${target} ${ban.seconds} :${ban.reason}`;
}

/** `KILL <nick> :<reason>`: nefarious2 refuses a KILL without a reason. */
export function killLine(nick: string, reason: string): string {
	return `KILL ${nick} :${reason}`;
}

/** The privileges an add of `type` in `scope` needs (any of them). */
export function banPrivs(type: BanType, scope: string): string[] {
	const name = type.toUpperCase();
	return scope === "*" ? [name] : [name, `LOCAL_${name}`];
}
