import {SharedChan} from "./chan";

export type SharedPrefixObject = {
	symbol: string;
	mode: string;
};

export type SharedNetworkChan = SharedChan & {
	totalMessages: number;
};

export type SharedPrefix = {
	prefix: SharedPrefixObject[];
	modeToSymbol: {[mode: string]: string};
	symbols: string[];
};

export type SharedServerOptions = {
	CHANTYPES: string[];
	PREFIX: SharedPrefix;
	NETWORK: string;
	/** The network's upload host (`draft/FILEHOST` ISUPPORT), when usable. */
	FILEHOST?: string;
};

export type SharedNetworkStatus = {
	connected: boolean;
	/** A connection attempt is under way (including the wait before a retry). */
	connecting: boolean;
	secure: boolean;
	/**
	 * When the next automatic dial is due (epoch ms), while `connecting` is
	 * the wait before a retry; absent while a dial is in flight, when
	 * connected, and when nothing is being tried. The UI counts it down.
	 */
	retryAt?: number;
	/**
	 * Client-side only (socket-events/network.ts): when the network went
	 * down (epoch ms), absent while connected. The composer's connection
	 * strip waits on it, so a quick reconnect says nothing.
	 */
	downSince?: number;
	/** Why that wait: the server's throttle, or no network here (client/js/irc/transport.ts). */
	retryReason?: "throttled" | "offline";
};

/** The services packages the client knows how to talk to (irc/services/). */
export type ServicesPackage = "x3";

/**
 * The network's services, as the oper set them up in the network's edit
 * form (docs/projects/oper-tools.md, "Services support"): which package,
 * and its bots and channels by role — nothing is assumed from a network's
 * name. A channel may be blank when the network does not run it.
 */
export type ServicesConfig = {
	package: ServicesPackage;
	bots: {
		/** The oper service (X3: `O3`), which takes G-lines and shuns. */
		oper: string;
		/** The account service (`AuthServ`). */
		account: string;
		/** The channel service (`ChanServ`). */
		channel: string;
		/** Where the audit lines land (`#operserv`): what opers made services do. */
		report: string;
		/** The connect/join/part/quit feed (`#mrsnoopy`). */
		snoop: string;
	};
};

/** A network's effective presence mode (docs/projects/do-not-disturb.md §2). */
export type SharedPresenceMode = "online" | "auto" | "away" | "dnd";

/** A network's own mode: one of the four, or Same as global (shared-presence-modes.md §2). */
export type SharedNetworkMode = SharedPresenceMode | "global";

/** What this client tells the server about the user (docs/projects/do-not-disturb.md). */
export type SharedNetworkPresence = {
	/** The network's own mode (`global`: it follows the pill). */
	mode: SharedNetworkMode;
	/** The mode in force: the network's own, or the global one. */
	effective: SharedPresenceMode;
	/** Do not disturb in force here: global, this network's mode, or another device's. */
	dnd: boolean;
	/** The server shows the user away from this connection (`AWAY *` or `/away`). */
	away: boolean;
};

/** One of soju's networks, as `soju.im/bouncer-networks` lists it (irc/bouncer.ts). */
export type SharedBouncerNetwork = {
	netid: string;
	/** `name`, `state`, `error`, `host`, `port`, `tls`, `nickname`, `username`, `realname`, `pass`, … */
	attrs: Record<string, string>;
};

export type SharedNetwork = {
	uuid: string;
	name: string;
	nick: string;
	serverOptions: SharedServerOptions;
	status: SharedNetworkStatus;
	presence?: SharedNetworkPresence;
	channels: SharedNetworkChan[];
	/** Services support, when the oper configured it (absent: none). */
	services?: ServicesConfig;
};
