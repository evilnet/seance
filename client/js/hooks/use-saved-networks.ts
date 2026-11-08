import {onBeforeUnmount, onMounted, shallowRef, type Ref} from "vue";
import * as saved from "../irc/saved-networks";
import type {SavedNetwork} from "../irc/saved-networks";

/** What a sidebar row shows of an entry; anything else changing is not a re-render. */
function signature(list: SavedNetwork[]): string {
	return JSON.stringify(
		list.map((net) => [
			net.uuid,
			net.name,
			net.host,
			net.port,
			net.nick,
			net.sasl,
			!!net.saslPassword,
		])
	);
}

/**
 * The saved networks, most recently used first, kept current while the
 * component is mounted: this page's writes (`onSavedNetworksChange`) and
 * another tab's (`storage`). A write that changes nothing a row shows —
 * the history cursor moves on every message — keeps the same array.
 */
export default function useSavedNetworks(): Ref<SavedNetwork[]> {
	const list = shallowRef<SavedNetwork[]>(saved.list());
	let shown = signature(list.value);

	const refresh = () => {
		const next = saved.list();
		const nextShown = signature(next);

		if (nextShown !== shown) {
			shown = nextShown;
			list.value = next;
		}
	};

	const onStorage = (ev: StorageEvent) => {
		if (ev.key === saved.STORAGE_KEY || ev.key === null) {
			refresh();
		}
	};

	let off: (() => void) | null = null;

	onMounted(() => {
		off = saved.onSavedNetworksChange(refresh);
		window.addEventListener("storage", onStorage);
		refresh();
	});

	onBeforeUnmount(() => {
		off?.();
		window.removeEventListener("storage", onStorage);
	});

	return list;
}
