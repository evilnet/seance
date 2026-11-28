/**
 * Networks Seance knows: where each is reached over a WebSocket and what
 * its services are called, so the connect form can offer them by name and
 * an oper there has nothing to set up (docs/resources/oper-tools-map.md
 * § Services support). A network nobody listed is found out at oper-up
 * instead (`./services/detect.ts`).
 *
 * An entry is a statement about a network at the time of a release: a bot
 * renamed since is caught by the trust check (`./bottrust.ts`), which
 * sends nothing to a nick WHOIS does not call a network service.
 *
 * Kept free of store/DOM imports (mocha, test/irc/known-networks.ts).
 */

import type {ServicesConfig} from "../../../shared/types/network";

export interface KnownNetwork {
	/** Stable id (`afternet`); never shown. */
	id: string;
	/** The network's own name for itself. */
	name: string;
	/** The WebSocket endpoint the connect form is filled with. */
	host: string;
	port: number;
	tls: boolean;
	/**
	 * The domains the network's servers live under: a saved network whose
	 * host is one of them, or under one, is this network.
	 */
	domains: string[];
	/** Channels the form suggests joining. */
	channels?: string[];
	/** The network's services, when Seance has a profile for the package. */
	services?: ServicesConfig;
}

export const KNOWN_NETWORKS: KnownNetwork[] = [
	{
		id: "afternet",
		name: "AfterNET",
		host: "webirc.afternet.org",
		port: 9998,
		tls: true,
		domains: ["afternet.org"],
		services: {
			package: "x3",
			bots: {
				oper: "O3",
				account: "AuthServ",
				channel: "X3",
				report: "#operserv",
				snoop: "#mrsnoopy",
			},
		},
	},
];

/** `wss://Host:port/path` → `host`. */
function bareHost(host: string): string {
	const stripped = host
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, "");
	const end = stripped.search(/[/:]/);
	return end === -1 ? stripped : stripped.slice(0, end);
}

export function knownNetworkById(id: string): KnownNetwork | undefined {
	return KNOWN_NETWORKS.find((n) => n.id === id);
}

/** The known network a host belongs to: one of its domains, or a name under one. */
export function knownNetworkByHost(host: string | undefined): KnownNetwork | undefined {
	const name = bareHost(host ?? "");

	if (name === "") {
		return undefined;
	}

	return KNOWN_NETWORKS.find((n) =>
		n.domains.some((domain) => name === domain || name.endsWith(`.${domain}`))
	);
}

/** Whether two services blocks say the same thing. */
export function sameServices(
	a: ServicesConfig | undefined,
	b: ServicesConfig | undefined
): boolean {
	if (!a || !b) {
		return a === b;
	}

	const roles = Object.keys(a.bots) as (keyof ServicesConfig["bots"])[];

	return (
		a.package === b.package &&
		roles.every((role) => a.bots[role].trim() === (b.bots[role] ?? "").trim())
	);
}

/**
 * The services a network runs with: what the oper set, else what the list
 * says about its host. `servicesChosen` with nothing set is the oper's
 * "None", which the list does not overrule.
 */
export function effectiveServices(
	net: {host?: string; services?: ServicesConfig; servicesChosen?: boolean} | undefined,
	host: string | undefined = net?.host
): ServicesConfig | undefined {
	if (net?.services || net?.servicesChosen) {
		return net.services;
	}

	const known = knownNetworkByHost(host)?.services;
	return known ? {package: known.package, bots: {...known.bots}} : undefined;
}
