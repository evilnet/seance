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

export type SharedNetwork = {
	uuid: string;
	name: string;
	nick: string;
	serverOptions: SharedServerOptions;
	status: SharedNetworkStatus;
	channels: SharedNetworkChan[];
};
