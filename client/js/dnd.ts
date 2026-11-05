/**
 * The global do-not-disturb and the global mode, page side: the stored state (`thelounge.dnd`,
 * kept in step across this device's tabs by the `storage` event), the
 * verdict re-judged on every change and whenever it can next change by
 * itself (helpers/dnd.ts `nextChangeAt`), pushed to every
 * IRC client (manager.setGlobalDndAll); a DND shared from another device
 * read off the networks' presence. The global mode (`state.mode`) goes to every
 * client too (manager.setGlobalModeAll) and is shared through the networks'
 * metadata (irc/presenceShare.ts, `mode:shared`). Model: helpers/dnd.ts.
 * Specs: docs/projects/do-not-disturb.md, docs/projects/shared-presence-modes.md.
 */
import {computed, reactive, ref} from "vue";
import socket from "./socket";
import storage from "./localStorage";
import {store} from "./store";
import {
	describeDndParts,
	dndAt,
	editSchedule,
	nextChangeAt,
	parseDndState,
	pillStatus,
	reconcileRemote,
	serializeDndState,
	turnOff as modelTurnOff,
	type DndManual,
	type DndSchedule,
	type DndState,
	type GlobalMode,
	modeLabel,
} from "./helpers/dnd";
import {localeRef} from "./i18n";
import {
	claimMuteAll,
	clearRemoteDndAll,
	setGlobalModeAll,
	setGlobalDndAll,
	syncPresenceAll,
} from "./irc/manager";

const KEY = "thelounge.dnd";
const now = ref(new Date());
const state = reactive<DndState>(parseDndState(storage.get(KEY)));
const verdict = computed(() => dndAt(state, now.value));
/** The global mode or dnd: what the pill ticks and says (helpers/dnd.ts pillStatus). */
const status = computed(() => pillStatus(state, now.value));

let started = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function apply(): void {
	setGlobalDndAll(verdict.value.active, verdict.value.until);
	setGlobalModeAll(state.mode);

	if (started) {
		armWake();
	}
}

/**
 * Wake when the verdict can next change: a timed DND's end or a window's
 * start on the dot, not up to a minute late, and the minute boundary at the
 * latest (mute entries expire and renew on the clock, with no line from the
 * server).
 */
function armWake(): void {
	if (wakeTimer !== null) {
		clearTimeout(wakeTimer);
	}

	const at = nextChangeAt(state, new Date());
	wakeTimer = setTimeout(() => {
		wakeTimer = null;
		now.value = new Date();
		apply();
		syncPresenceAll();
	}, Math.max(0, at - Date.now()) + 50);
}

/**
 * A change the user made here: every network's live `*` entry becomes
 * ours (irc/pushMute.ts claimMute), so the new want is written over it,
 * whoever wrote it. Claimed before the save, whose apply syncs at once.
 */
function saveByHand(next: DndState): void {
	claimMuteAll();
	save(next);
	// The verdict may not have changed (no sync ran): take the claim now.
	syncPresenceAll();
}

function save(next: DndState): void {
	Object.assign(state, next);
	storage.set(KEY, serializeDndState(state));
	apply();
}

const connected = computed(() => store.state.networks.filter((n) => n.status.connected));
const remoteOnly = computed(
	() =>
		!verdict.value.active &&
		connected.value.length > 0 &&
		connected.value.every((n) => n.presence?.dnd && n.presence.mode !== "dnd")
);

/**
 * The pill's words, as parts the pill joins with " · ": its own DND (with
 * its end), one shared from another device, else the global mode.
 */
const pillParts = computed((): string[] => {
	void localeRef.value; // the words are the core resolver's: follow the language

	if (verdict.value.active) {
		return describeDndParts(verdict.value, now.value, !!store.state.settings.use12hClock);
	}

	return [modeLabel(remoteOnly.value ? "dnd" : state.mode.value)];
});

/** The pill's words on one line. */
const pillLabel = computed(() => pillParts.value.join(" · "));

/** The pill dot's colour: `dnd`, `away` or `online`. */
const pillState = computed(() => {
	if (verdict.value.active || remoteOnly.value) {
		return "dnd";
	}

	if (state.mode.value === "away") {
		return "away";
	}

	// Auto with nobody looking: amber once every connected network following
	// the pill is away (spec § 2), read off what the networks report.
	const following = connected.value.filter((n) => n.presence?.mode === "global");
	const unattended =
		state.mode.value === "auto" &&
		following.length > 0 &&
		following.every((n) => n.presence?.away);

	return unattended ? "away" : "online";
});

function start(): void {
	if (started) {
		return;
	}

	started = true;
	apply();
	// Another tab of this device changed it: take its state, claim nothing
	// (that tab claimed, on its own connections).
	window.addEventListener("storage", (e) => {
		if (e.key === KEY) {
			Object.assign(state, parseDndState(e.newValue));
			now.value = new Date();
			apply();
		}
	});
	// Another device's global mode, adopted on one network
	// (irc/presenceShare.ts): taken here when newer, and handed to every
	// network (apply), each of which writes it to its server if older there.
	socket.on("mode:shared", ({mode, at}) => {
		const mine = state.mode;

		if (mine.at === null || at > mine.at || (at === mine.at && mode > mine.value)) {
			save({...state, mode: {value: mode, at}});
		}
	});
	// Another device turned the shared DND off (irc/pushMute.ts).
	socket.on("dnd:cleared", () => {
		const next = reconcileRemote(state, new Date());

		if (next !== state) {
			now.value = new Date();
			save(next);
		}
	});
}

export default {
	state,
	verdict,
	remoteOnly,
	pillLabel,
	pillParts,
	pillState,
	status,
	start,
	/** A DND choice; the global mode stays underneath. */
	setManual(manual: DndManual): void {
		now.value = new Date();
		saveByHand({...state, manual});
	},
	/** The pill's Online / Auto / Away: the global mode, and do not disturb off. */
	setGlobalMode(mode: GlobalMode): void {
		now.value = new Date();
		saveByHand({...modelTurnOff(state, now.value), mode: {value: mode, at: Date.now()}});
		clearRemoteDndAll();
	},
	setSchedule(schedule: DndSchedule): void {
		now.value = new Date();
		saveByHand(editSchedule(state, schedule, now.value));
	},
	followSchedule(on: boolean): void {
		now.value = new Date();
		saveByHand({
			...state,
			schedule: {...state.schedule, enabled: on},
			scheduleSkippedUntil: null,
		});
	},
};
