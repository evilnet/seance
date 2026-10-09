/**
 * nefarious2's server notice mask (`include/client.h:1623-1661`): a decimal
 * number, set with `MODE <me> +s <n>` and reported by 008. The values never
 * change — the server's header says clients depend on them. See
 * docs/resources/nefarious2-oper.md §4.
 */

import type {SnomaskModel} from "../types";

export const NEFARIOUS_SNOMASK: SnomaskModel = {
	all: 0xeffff,
	defaultFeature: "SNOMASK_DEFAULT",
	operDefaultFeature: "SNOMASK_OPERDEFAULT",
	userDefault: 0x604,
	operDefault: 0x160d,
	bits: [
		{
			bit: 0x1,
			name: "OLDSNO",
			label: "Server events",
			description:
				"Opers coming up, server links and SQUITs, rehashes and restarts, clock changes, nick collisions, bouncer and web push housekeeping, critical log lines.",
			volume: "low",
			operDefault: true,
		},
		{
			bit: 0x2,
			name: "SERVKILL",
			label: "Server kills",
			description: "KILLs issued by servers, mostly nick collisions.",
			volume: "low",
		},
		{
			bit: 0x4,
			name: "OPERKILL",
			label: "Oper kills",
			description: "KILLs issued by opers, and K-line hits.",
			volume: "low",
			userDefault: true,
			operDefault: true,
		},
		{
			bit: 0x8,
			name: "HACK2",
			label: "Desyncs",
			description: "Bounced modes and kicks from users the server thinks are not ops.",
			volume: "low",
			operDefault: true,
		},
		{
			bit: 0x10,
			name: "HACK3",
			label: "Server modes",
			description: "Channel modes set by servers (BOUNCE or HACK(3)).",
			volume: "medium",
		},
		{
			bit: 0x20,
			name: "UNAUTH",
			label: "Refused connections",
			description: "Unauthorized connections and SASL-required rejections.",
			volume: "medium",
		},
		{
			bit: 0x40,
			name: "TCPCOMMON",
			label: "Socket and TLS errors",
			description: "accept() failures and TLS handshake errors — scanners make a lot of these.",
			volume: "high",
		},
		{
			bit: 0x80,
			name: "TOOMANY",
			label: "Too many connections",
			description: "A class or an IP over its connection limit (rate-limited by the server).",
			volume: "low",
		},
		{
			bit: 0x100,
			name: "HACK4",
			label: "Services and OPMODE",
			description:
				"Modes and kicks by services and U-lined servers, OPMODE, CLEARMODE and oper join overrides. Busy wherever services set modes.",
			volume: "high",
		},
		{
			bit: 0x200,
			name: "GLINE",
			label: "Bans",
			description:
				"G-lines, shuns, Z-lines and channel bans being added, changed and removed, every user they hit, temporary shuns and DNSBL blocks.",
			volume: "medium",
			userDefault: true,
			operDefault: true,
		},
		{
			bit: 0x400,
			name: "NETWORK",
			label: "Network",
			description: "Net junctions and breaks, bursts, jupes, clock drift and IAuth log lines.",
			volume: "low",
			userDefault: true,
			operDefault: true,
		},
		{
			bit: 0x800,
			name: "IPMISMATCH",
			label: "IP mismatches",
			description: "A client's reverse DNS that does not resolve back to its IP.",
			volume: "medium",
		},
		{
			bit: 0x1000,
			name: "THROTTLE",
			label: "Throttling",
			description: "Host throttling. Nothing on this server sends on it.",
			volume: "none",
			operDefault: true,
			dead: true,
		},
		{
			bit: 0x2000,
			name: "OLDREALOP",
			label: "Failed OPER",
			description: "Failed OPER attempts.",
			volume: "low",
			operOnly: true,
		},
		{
			bit: 0x4000,
			name: "CONNEXIT",
			label: "Connects and exits",
			description: "Every client connecting and leaving, network-wide.",
			volume: "high",
			operOnly: true,
			needsFeature: "CONNEXIT_NOTICES",
		},
		{
			bit: 0x8000,
			name: "AUTO",
			label: "Automatic bans",
			description: "Bans whose reason starts with AUTO (set by services and scripts).",
			volume: "low",
		},
		{
			bit: 0x10000,
			name: "DEBUG",
			label: "Debug",
			description: "Debug log lines. Only debug builds have it.",
			volume: "high",
			debugOnly: true,
		},
		{
			bit: 0x20000,
			name: "NICKCHG",
			label: "Nick changes",
			description: "Every nick change, network-wide.",
			volume: "high",
			needsFeature: "CONNEXIT_NOTICES",
		},
		{
			bit: 0x40000,
			name: "AUTH",
			label: "IAuth",
			description: "Notices from the IAuth daemon.",
			volume: "medium",
			operOnly: true,
		},
		{
			bit: 0x80000,
			name: "WEBIRC",
			label: "WebIRC",
			description:
				"WebIRC gateways changing hosts and bad WEBIRC attempts. Also gets config parse errors, which the server sends on every bit but delivers only on the highest.",
			volume: "medium",
		},
	],
};

/** The bit names set in `mask`, lowest first. */
export function bitNames(model: SnomaskModel, mask: number): string[] {
	return model.bits.filter((b) => (mask & b.bit) !== 0).map((b) => b.name);
}
