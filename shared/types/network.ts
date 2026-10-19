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

export type SharedNetwork = {
	uuid: string;
	name: string;
	nick: string;
	serverOptions: SharedServerOptions;
	status: SharedNetworkStatus;
	channels: SharedNetworkChan[];
	/** Services support, when the oper configured it (absent: none). */
	services?: ServicesConfig;
};
