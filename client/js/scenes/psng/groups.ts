import type {Tier} from "./tiers";

/** Motion groups: each is one class on the scene root, `psng-m-<group>`, that the stylesheet's animations hang on. */
export type Group =
	| "clouds"
	| "stars"
	| "fireflies"
	| "smoke"
	| "grass"
	| "weather"
	| "skeins"
	| "daybirds"
	| "sun";

export const GROUPS: readonly Group[] = [
	"clouds",
	"stars",
	"fireflies",
	"smoke",
	"grass",
	"weather",
	"skeins",
	"daybirds",
	"sun",
];

const CALM: readonly Group[] = ["clouds"];

/** The groups that run in a tier, narrowed to `only` when given (the phone ladder). */
export function groupsFor(tier: Tier, only?: ReadonlySet<Group>): Set<Group> {
	const all = tier === "full" ? GROUPS : tier === "calm" ? CALM : [];
	return new Set(all.filter((g) => !only || only.has(g)));
}

export const GROUPS_KEY = "thelounge.state.psngGroups";

/** `thelounge.state.psngGroups`: comma-separated group names, unknown ones ignored; undefined when unset. */
export function groupOverride(storage: {get(key: string): string | null}): Set<Group> | undefined {
	const raw = storage.get(GROUPS_KEY);

	if (raw === null) {
		return undefined;
	}

	const names = raw.split(",").map((s) => s.trim());
	return new Set(GROUPS.filter((g) => names.includes(g)));
}
