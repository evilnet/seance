/**
 * Settings sync on the page (docs/projects/settings-sync.md): the host of
 * sync/engine.ts. It gives the engine the store's settings, the home
 * network's connection, the dialogs and the notices, and it is what the
 * settings page talks to ({@link syncState}, {@link turnOn}, {@link turnOff}).
 *
 * What asks the engine for a run: the home's pointer read or changed
 * (`sync:pointer`), a write to a store that roams (localStorage.ts
 * `onStorageWrite`, dated at once), another tab's write to the shared sync
 * state, the wake timer, and this tab becoming the one that uploads.
 */

import {ref, type Ref} from "vue";
import {retentionDays} from "../avatars/actions";
import eventbus from "../eventbus";
import {t} from "../i18n/core";
import {clientForNetwork} from "../irc/manager";
import storage, {onStorageWrite} from "../localStorage";
import {config, createState} from "../settings";
import socket from "../socket";
import {store} from "../store";
import {SyncEngine, type HomeLink, type Notice} from "./engine";
import {isRoamingKey, type SettingsPort} from "./entries";
import {fileSupported, parsePointer} from "./file";
import {followOtherTabs, reloadStored} from "./reload";
import {COPY_KEY, readState, sameAccount, STATE_KEY, type SyncState} from "./state";

/** How long a write to a roaming store waits for the next before it is dated. */
const SCAN_DELAY_MS = 1_000;
/** How long a token for the file host may take, queue included. */
const TOKEN_TIMEOUT_MS = 90_000;
/** One upload at a time on this device, whichever tab holds this lock. */
const UPLOAD_LOCK = "seance-settings-sync";

/** The stored sync state, for the settings page to follow. */
export const syncState: Ref<SyncState> = ref(readState(storage));
/** Moves when a connection's part in sync may have changed (its pointer, its status). */
export const syncTick = ref(0);

const roamingSettings = Object.keys(config).filter(
	(name) => (config as Record<string, {sync?: unknown}>)[name].sync === true
);

function settingDefaults(): Record<string, unknown> {
	const defaults: Record<string, unknown> = createState();
	const deployTheme = store.state.serverConfiguration?.defaultTheme;

	if (deployTheme) {
		defaults.theme = deployTheme;
	}

	return defaults;
}

const settingsPort: SettingsPort = {
	values() {
		const state = store.state.settings as Record<string, unknown>;
		return Object.fromEntries(roamingSettings.map((name) => [name, state[name]]));
	},
	defaults() {
		const defaults = settingDefaults();
		return Object.fromEntries(roamingSettings.map((name) => [name, defaults[name]]));
	},
	set(name, value) {
		// A theme this deploy does not ship would load no stylesheet.
		if (
			name === "theme" &&
			!store.state.serverConfiguration?.themes.some((theme) => theme.name === value)
		) {
			return false;
		}

		void store.dispatch("settings/update", {name, value});
		return true;
	},
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error("timeout")), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

function link(uuid: string): HomeLink | null {
	const client = clientForNetwork(uuid);

	if (!client || !client.isWelcomed || !client.account) {
		return null;
	}

	return {
		account: client.account,
		pointer: client.syncPointer,
		filehost: client.filehostUrl(),
		canWrite: client.canWriteSyncPointer,
		token: () => withTimeout(client.backgroundToken(), TOKEN_TIMEOUT_MS),
		setPointer: (value) => void client.writeSyncPointer(value),
	};
}

function noticeText(notice: Notice): string {
	switch (notice.kind) {
		case "alias-added":
			return t("sync.notice.aliasAdded", {name: notice.name});
		case "alias-changed":
			return t("sync.notice.aliasChanged", {name: notice.name});
		case "alias-removed":
			return t("sync.notice.aliasRemoved", {name: notice.name});
		case "too-large":
			return t("sync.notice.tooLarge");
		case "elsewhere":
			return t("sync.notice.elsewhere");
		case "damaged":
			return t("sync.notice.damaged");
		case "newer-version":
			return t("sync.notice.newerVersion");
		case "upload-too-large":
			return t("sync.notice.uploadTooLarge");
		case "upload-refused":
			return t("sync.notice.uploadRefused", {status: notice.status});
	}
}

const networkName = (uuid: string): string => store.getters.findNetwork(uuid)?.name ?? "";

/** Whether this tab uploads for the device: the one holding the Web Lock. */
let uploader = typeof navigator === "undefined" || !navigator.locks;
let wakeTimer: number | null = null;
let scanTimer: number | null = null;

const engine = new SyncEngine({
	storage,
	now: () => Date.now(),
	fetch: (input, init) => fetch(input, init),
	link,
	context: (home) => ({storage, home, settings: settingsPort}),
	applied: reloadStored,
	say(uuid, notice) {
		const client = clientForNetwork(uuid);

		if (client) {
			client.pushMessage(client.lobby, {text: noticeText(notice)}, true);
		}
	},
	askOtherAccount(account, known) {
		const home = readState(storage).home;
		return new Promise((resolve) => {
			eventbus.emit(
				"confirm-dialog",
				{
					title: t("sync.otherAccount.title", {account}),
					text: t("sync.otherAccount.text", {
						account,
						known,
						network: home ? networkName(home) : "",
					}),
					button: t("sync.otherAccount.yes", {account}),
					cancel: t("sync.otherAccount.no"),
					primary: true,
					wait: true,
				},
				(yes: boolean) => resolve(yes)
			);
		});
	},
	isUploader: () => uploader,
	wake(ms) {
		if (wakeTimer !== null) {
			window.clearTimeout(wakeTimer);
		}

		// Never longer than a timer holds, and never a busy loop.
		wakeTimer = window.setTimeout(() => {
			wakeTimer = null;
			engine.run();
		}, Math.min(Math.max(ms, 250), 0x7fffffff));
	},
	retentionMs: () => retentionDays() * 24 * 3600 * 1000,
	changed() {
		syncState.value = readState(storage);
	},
});

/** Why sync cannot be switched on for a network here, or null when it can. */
export type Unavailable = "browser" | "offline" | "signIn" | "filehost" | "private" | "reading";

export function unavailable(uuid: string): Unavailable | null {
	const client = clientForNetwork(uuid);

	if (!fileSupported()) {
		return "browser";
	}

	if (!client || !client.isWelcomed) {
		return "offline";
	}

	if (!client.account) {
		return "signIn";
	}

	if (!client.filehostUrl()) {
		return "filehost";
	}

	if (!client.canWriteSyncPointer) {
		return "private";
	}

	// Until the connection has read the pointer, nobody can say whether the
	// account has settings this device would take: the question waits for it.
	return client.syncPointer === undefined ? "reading" : null;
}

/** The account has a file already: a device that joins takes the account's side. */
function hasFile(uuid: string): boolean {
	const value = clientForNetwork(uuid)?.syncPointer;
	return !!value && parsePointer(value) !== null;
}

function confirm(data: Record<string, unknown>): Promise<{yes: boolean; alt: boolean}> {
	return new Promise((resolve) => {
		eventbus.emit("confirm-dialog", data, (yes: boolean, alt?: boolean) =>
			resolve({yes, alt: !!alt})
		);
	});
}

/** The words of the question a device asks before it takes an account's settings. */
function joinQuestion(uuid: string, account: string): Record<string, unknown> {
	return {
		title: t("sync.offer.title"),
		text: t("sync.offer.text", {account, network: networkName(uuid)}),
		note: t("sync.offer.note"),
		button: t("sync.offer.yes"),
		primary: true,
	};
}

/**
 * The settings switch, on: make `uuid` this device's sync home. Asks first
 * when another network is the home (there is never more than one), and when
 * the account already has settings this device would take.
 */
export async function turnOn(uuid: string): Promise<void> {
	const client = clientForNetwork(uuid);

	if (!client || unavailable(uuid) !== null) {
		return;
	}

	const state = readState(storage);

	if (state.home && state.home !== uuid) {
		const {yes} = await confirm({
			title: t("sync.move.title", {network: networkName(uuid)}),
			text: t("sync.move.text", {account: state.account, home: networkName(state.home)}),
			button: t("sync.move.yes"),
			primary: true,
		});

		if (!yes) {
			return;
		}
	}

	if (hasFile(uuid) && !(await confirm(joinQuestion(uuid, client.account))).yes) {
		return;
	}

	engine.enable(uuid, client.account);
}

/** The settings switch, off: this device stops syncing; the account's file stays. */
export function turnOff(): void {
	engine.disable();
}

/** Networks whose offer was put off on this page: asked again at the next launch. */
const putOff = new Set<string>();

/**
 * A device with no sync home that sees an account's pointer asks once:
 * use the account's settings here, not now, or never on this device.
 */
async function offer(uuid: string): Promise<void> {
	const client = clientForNetwork(uuid);
	const state = readState(storage);

	if (
		state.home ||
		state.never.includes(uuid) ||
		putOff.has(uuid) ||
		!client ||
		!hasFile(uuid) ||
		unavailable(uuid) !== null
	) {
		return;
	}

	putOff.add(uuid);
	const account = client.account;
	const {yes, alt} = await confirm({
		...joinQuestion(uuid, account),
		alt: t("sync.offer.never"),
		cancel: t("sync.offer.notNow"),
		wait: true,
	});

	if (yes && alt) {
		engine.never(uuid);
		return;
	}

	// The answer may come much later: still no home, still that account.
	if (yes && !readState(storage).home && sameAccount(client.account, account)) {
		engine.enable(uuid, account);
	}
}

function scanSoon(): void {
	if (scanTimer !== null) {
		window.clearTimeout(scanTimer);
	}

	scanTimer = window.setTimeout(() => {
		scanTimer = null;
		engine.localChange();
	}, SCAN_DELAY_MS);
}

let started = false;

/** Start following: once, after the settings are applied and before any network dials. */
export function startSettingsSync(): void {
	if (started) {
		return;
	}

	started = true;
	followOtherTabs();

	socket.on("sync:pointer", ({network}) => {
		syncTick.value++;

		if (readState(storage).home === network) {
			engine.run();
		} else {
			void offer(network);
		}
	});

	socket.on("network:status", ({network}) => {
		syncTick.value++;

		if (readState(storage).home === network) {
			engine.run();
		}
	});

	onStorageWrite((key) => {
		const home = readState(storage).home;

		if (home && isRoamingKey(key, home)) {
			scanSoon();
		}
	});

	// Another tab moved the shared state (a change it dated, a file it took):
	// show it, and if this tab uploads, see whether there is something to send.
	window.addEventListener("storage", (ev: StorageEvent) => {
		if (ev.key === STATE_KEY || ev.key === COPY_KEY || ev.key === null) {
			syncState.value = readState(storage);
			engine.run();
		}
	});

	if (typeof navigator !== "undefined" && navigator.locks) {
		void navigator.locks.request(UPLOAD_LOCK, () => {
			uploader = true;
			engine.run();
			// Held until this tab goes; then the next one in line uploads.
			return new Promise<void>(() => undefined);
		});
	}

	engine.run();
}
