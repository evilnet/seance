/**
 * WHOIS / WHOWAS replies, accumulated per nick until 318 / 369 and then
 * shown as one `whois` message where the user is (lobby + `showInActive`,
 * docs/projects/reply-routing.md) — never opening a query window. Field
 * names match irc-framework's so
 * `client/components/MessageTypes/whois.vue` renders unchanged.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {IrcClient} from "../client";
import type {IrcMessage} from "../message";
import type {Handler} from "../types";

export interface WhoisData {
	nick: string;
	ident?: string;
	hostname?: string;
	real_name?: string;
	server?: string;
	server_info?: string;
	operator?: string;
	channels?: string;
	modes?: string;
	/** Seconds idle, as sent by the server. */
	idle?: string;
	/** Epoch seconds of sign-on, as sent by the server. */
	logon?: string;
	registered_nick?: string;
	actual_ip?: string;
	actual_hostname?: string;
	actual_username?: string;
	secure?: boolean;
	certfp?: string;
	certfps?: string[];
	account?: string;
	special?: string[];
	helpop?: string;
	bot?: string;
	away?: string;
	country?: string;
	country_code?: string;
	asn?: string;
	whowas?: boolean;
	/** nefarious2 672 (opers only): the WebSocket origin the user connected from. */
	websocket?: string;
	/** nefarious2 325: the WebIRC gateway (`is connected via <description>`). */
	webirc?: string;
	/** nefarious2 339: marks set on the user (DNSBL, IAuth). */
	marks?: string[];
	/** nefarious2 343: `is Kill listed on <x>`. */
	killListed?: string;
	/** nefarious2 320 (opers or self): the bouncer session line. */
	bouncer?: string;
	/** Absolute epoch milliseconds derived from `idle` / `logon` at the end. */
	idleTime?: number;
	logonTime?: number;
}

const pending = new WeakMap<IrcClient, Map<string, WhoisData>>();

function pendingFor(client: IrcClient): Map<string, WhoisData> {
	let map = pending.get(client);

	if (!map) {
		map = new Map();
		pending.set(client, map);
	}

	return map;
}

/** The in-progress record for the nick in params[1], created on first use. */
function record(client: IrcClient, msg: IrcMessage): WhoisData | undefined {
	const nick = msg.params[1];

	if (!nick) {
		return undefined;
	}

	const map = pendingFor(client);
	const key = client.casefold(nick);
	let data = map.get(key);

	if (!data) {
		data = {nick};
		map.set(key, data);
	}

	return data;
}

function last(msg: IrcMessage): string {
	return msg.params[msg.params.length - 1] ?? "";
}

/** A handler that stores the trailing parameter under `field`. */
function trailing(field: keyof WhoisData): Handler {
	return (client, msg) => {
		const data = record(client, msg);

		if (data) {
			(data as unknown as Record<string, unknown>)[field] = last(msg);
		}
	};
}

/** Show the finished record (or "no such nick") and forget it. */
function finish(client: IrcClient, msg: IrcMessage, whowas: boolean): void {
	const nick = msg.params[1];

	if (!nick) {
		return;
	}

	const map = pendingFor(client);
	const key = client.casefold(nick);
	const data = map.get(key);
	map.delete(key);

	// Errors never open windows: the nick may contain illegal characters.
	if (!data || data.ident === undefined) {
		client.pushMessage(client.lobby, {
			type: MessageType.ERROR,
			time: client.timeOf(msg),
			text: `No such nick: ${nick}`,
			showInActive: true,
		});
		return;
	}

	if (whowas) {
		data.whowas = true;
	}

	if (data.idle !== undefined) {
		data.idleTime = Date.now() - parseInt(data.idle, 10) * 1000;
	}

	if (data.logon !== undefined) {
		data.logonTime = parseInt(data.logon, 10) * 1000;
	}

	client.pushMessage(client.lobby, {
		type: MessageType.WHOIS,
		time: client.timeOf(msg),
		whois: data,
		showInActive: true,
	});
}

// RPL_WHOISUSER / RPL_WHOWASUSER: <me> <nick> <user> <host> * :<real name>
const whoisUser: Handler = (client, msg) => {
	const data = record(client, msg);

	if (!data) {
		return;
	}

	// WHOWAS sends one 314 per remembered session, newest first: keep that one.
	if (msg.command === "314" && data.ident !== undefined) {
		return;
	}

	data.nick = msg.params[1];
	data.ident = msg.params[2] ?? "";
	data.hostname = msg.params[3] ?? "";
	data.real_name = last(msg);
};

// RPL_WHOISSERVER: <me> <nick> <server> :<server info>
const whoisServer: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.server = msg.params[2] ?? "";
		data.server_info = last(msg);
	}
};

// RPL_WHOISIDLE: <me> <nick> <idle seconds> [<signon epoch>] :seconds idle...
const whoisIdle: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.idle = msg.params[2] ?? "0";

		if (msg.params.length > 4) {
			data.logon = msg.params[3];
		}
	}
};

// RPL_WHOISCHANNELS: <me> <nick> :<prefix>#chan ... (may repeat)
const whoisChannels: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.channels = data.channels ? `${data.channels} ${last(msg)}` : last(msg);
	}
};

// RPL_WHOISACCOUNT: <me> <nick> <account> :is logged in as
const whoisAccount: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.account = msg.params[2] ?? "";
	}
};

// RPL_WHOISHOST: <me> <nick> :is connecting from <user>@<host> <ip>
const whoisHost: Handler = (client, msg) => {
	const data = record(client, msg);
	const match = last(msg).match(/.*@([^ ]+) ([^ ]+).*$/);

	if (data && match) {
		data.actual_hostname = match[1];
		data.actual_ip = match[2];
	}
};

// RPL_WHOISACTUALLY: <me> <nick> [<user>@]<host> <ip> :Actual user@host, Actual IP
const whoisActually: Handler = (client, msg) => {
	const data = record(client, msg);
	const userHost = msg.params[msg.params.length - 3] ?? "";
	const ip = msg.params[msg.params.length - 2] ?? "";
	const at = userHost.indexOf("@");
	const host = userHost.slice(at + 1);

	// UnrealIRCd reuses 338 for something else; ignore it when nothing parses.
	if (data && ip && host && msg.params.length >= 4) {
		data.actual_ip = ip;
		data.actual_hostname = host;

		if (at !== -1) {
			data.actual_username = userHost.slice(0, at);
		}
	}
};

// RPL_WHOISSECURE: <me> <nick> :is using a secure connection
const whoisSecure: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.secure = true;
	}
};

// RPL_WHOISCERTFP: <me> <nick> :has client certificate fingerprint <fp>
// (276 elsewhere, 616 on nefarious2): the fingerprint itself when it is one.
const whoisCertfp: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		const text = last(msg);
		const certfp = /([0-9a-f]{32,})\s*$/i.exec(text)?.[1] ?? text;
		data.certfp = data.certfp ?? certfp;
		data.certfps = [...(data.certfps ?? []), certfp];
	}
};

// RPL_WHOISSPECIAL: <me> <nick> :<free text> (may repeat). On nefarious2
// it also carries SWHOIS text and, for opers, the bouncer session line.
const whoisSpecial: Handler = (client, msg) => {
	const data = record(client, msg);

	if (!data) {
		return;
	}

	const text = last(msg);

	if (/^has a bouncer session\b/.test(text)) {
		data.bouncer = text.replace(/^has a /, "");
		return;
	}

	data.special = [...(data.special ?? []), text];
};

// nefarious2 RPL_WHOISWEBSOCKET (672): <me> <nick> :is connected via WebSocket (origin: <o>)
const whoisWebsocket: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.websocket = /\(origin: (.*)\)$/.exec(last(msg))?.[1] ?? last(msg);
	}
};

// nefarious2 RPL_WHOISWEBIRC (325): <me> <nick> :is connected via <description>
const whoisWebirc: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.webirc = last(msg).replace(/^is connected via /, "");
	}
};

// nefarious2 RPL_WHOISMARKS (339): <me> <nick> :is marked: <a, b> (may repeat)
const whoisMarks: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		const marks = last(msg)
			.replace(/^is marked: /, "")
			.split(/,\s*/)
			.filter(Boolean);
		data.marks = [...(data.marks ?? []), ...marks];
	}
};

// nefarious2 RPL_WHOISKILL (343): <me> <nick> :is Kill listed on <x>
const whoisKill: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.killListed = last(msg).replace(/^is Kill listed on /, "");
	}
};

// RPL_WHOISCOUNTRY: <me> <nick> [<code>] :<country>
const whoisCountry: Handler = (client, msg) => {
	const data = record(client, msg);

	if (data) {
		data.country = last(msg);

		if (msg.params.length === 4) {
			data.country_code = msg.params[2];
		}
	}
};

/**
 * RPL_AWAY: <me> <nick> :<away message>. Part of a WHOIS when one is in
 * progress; otherwise the server's reply to a PRIVMSG to an away user,
 * which is shown once in their query window.
 */
const away: Handler = (client, msg) => {
	const nick = msg.params[1];

	if (!nick) {
		return;
	}

	const text = last(msg) || "is away";
	const inProgress = pendingFor(client).get(client.casefold(nick));

	if (inProgress) {
		inProgress.away = text;
		return;
	}

	const chan = client.findChannel(nick);

	if (!chan || chan.type !== ChanType.QUERY || chan.userAway === text) {
		return;
	}

	chan.userAway = text;
	client.pushMessage(chan, {
		type: MessageType.AWAY,
		time: client.timeOf(msg),
		text,
		from: chan.userRef(nick),
	});
};

const endOfWhois: Handler = (client, msg) => finish(client, msg, false);
const endOfWhowas: Handler = (client, msg) => finish(client, msg, true);

export default {
	"276": whoisCertfp,
	"301": away,
	"307": trailing("registered_nick"),
	"310": trailing("helpop"),
	"311": whoisUser,
	"312": whoisServer,
	"313": trailing("operator"),
	"314": whoisUser,
	"317": whoisIdle,
	"318": endOfWhois,
	"319": whoisChannels,
	"320": whoisSpecial,
	"325": whoisWebirc,
	"330": whoisAccount,
	"335": trailing("bot"),
	"338": whoisActually,
	"339": whoisMarks,
	"343": whoisKill,
	"344": whoisCountry,
	"369": endOfWhowas,
	"378": whoisHost,
	"379": trailing("modes"),
	"569": trailing("asn"),
	"616": whoisCertfp,
	"671": whoisSecure,
	"672": whoisWebsocket,
};
