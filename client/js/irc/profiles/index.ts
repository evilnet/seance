/**
 * The server profile registry: which ircd family a connection talks to,
 * from the version in 004 (and 002/351) plus ISUPPORT. See `./types.ts`.
 *
 * nefarious2 says `+Nefarious(` in its version. Its `master` and
 * `ircv3.2-upgrade` branches print the same version string; the oper tools
 * only need the family, so the branch is not told apart here.
 */

import type {ISupport} from "../isupport";
import {generic} from "./generic";
import {nefarious} from "./nefarious";
import type {ServerProfile} from "./types";

export type {ServerProfile} from "./types";

const PROFILES: ServerProfile[] = [nefarious, generic];

/** The profile for a server that reports `version` (004) and `isupport`. */
export function detectProfile(version: string | undefined, isupport?: ISupport): ServerProfile {
	void isupport; // reserved: ircds whose version string is not enough

	if (version && /\+Nefarious\(/i.test(version)) {
		return nefarious;
	}

	return generic;
}

/** A profile by id (what `SharedOperState.profile` carries), else the generic one. */
export function profileById(id: string | undefined): ServerProfile {
	return PROFILES.find((p) => p.id === id) ?? generic;
}
