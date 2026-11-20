import storage from "../localStorage";

const COLLAPSED_KEY = "thelounge.networks.collapsed";

/**
 * The uuids of the networks collapsed in the sidebar. The key is written
 * verbatim by a settings restore, so anything but an array of strings
 * (`{}`, `5`, broken JSON) reads as none collapsed instead of throwing:
 * `init` reads it on every registration, before the networks are committed.
 */
export function collapsedNetworks(): Set<string> {
	const stored = storage.get(COLLAPSED_KEY);

	if (!stored) {
		return new Set();
	}

	try {
		const parsed: unknown = JSON.parse(stored);
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((uuid): uuid is string => typeof uuid === "string")
				: []
		);
	} catch {
		return new Set();
	}
}

export default (network, isCollapsed) => {
	const networks = collapsedNetworks();

	network.isCollapsed = isCollapsed;

	if (isCollapsed) {
		networks.add(network.uuid);
	} else {
		networks.delete(network.uuid);
	}

	storage.set(COLLAPSED_KEY, JSON.stringify([...networks]));
};
