/**
 * The services profile registry (see `./types.ts`): one entry per package
 * the client can talk to, found by the id the network's setting names.
 */

import type {ServicesConfig} from "../../../../shared/types/network";
import type {ServicesProfile} from "./types";
import {x3} from "./x3";

export type {ServicesProfile} from "./types";

export const SERVICES_PROFILES: ServicesProfile[] = [x3];

/** The profile a setting names, or undefined when there is no such package. */
export function servicesProfileById(id: string | undefined): ServicesProfile | undefined {
	return SERVICES_PROFILES.find((p) => p.id === id);
}

/** The profile for a network's services setting, if it names one we know. */
export function servicesProfileFor(
	services: ServicesConfig | undefined
): ServicesProfile | undefined {
	return servicesProfileById(services?.package);
}

/** The nicks of the configured bots (blank roles left out). */
export function serviceNicksOf(services: ServicesConfig | undefined): string[] {
	if (!services) {
		return [];
	}

	const {oper, account, channel} = services.bots;
	return [oper, account, channel].filter((nick) => nick !== "");
}
