/**
 * A WHOIS / WHOWAS reply as one record (client/js/irc/handlers/whois.ts).
 * Field names match irc-framework's, so the `whois` message renderer reads
 * them unchanged; the user profile (UserCard.vue) reads the same record.
 */
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

/**
 * How the user profile's quiet lookup (`whois:profile`) went: `online` with
 * the WHOIS, `offline` with the WHOWAS when the server still remembers the
 * nick, `unavailable` when the server could not be asked or did not answer.
 */
export type WhoisProfileStatus = "online" | "offline" | "unavailable";
