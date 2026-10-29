/* eslint-disable @typescript-eslint/no-shadow */

import {createStore, Store, useStore as baseUseStore} from "vuex";
import {createSettingsStore} from "./store-settings";
import storage from "./localStorage";
import type {ClientChan, ClientNetwork, NetChan} from "./types";
import type {InboxEntry} from "../../shared/types/mention";
import type {InjectionKey} from "vue";

import {SettingsState} from "./settings";
import {SharedConfiguration, LockedSharedConfiguration} from "../../shared/types/config";
import {BrandingConfig, DEFAULT_BRANDING} from "./branding";
import type {UploadProgress} from "./upload";
import type {Capability} from "./translate/capability";
import type {ModelView} from "./translate/service";
import type {ChannelTranslation} from "./translate/channelStore";
import type {Device, EngineName} from "./translate/engine";
import {conversationKey} from "./helpers/inbox";

enum DesktopNotificationState {
	Unsupported = "unsupported",
	Blocked = "blocked",
	NoHttps = "nohttps",
	Granted = "granted",
}

function detectDesktopNotificationState(): DesktopNotificationState {
	if (!("Notification" in window)) {
		return DesktopNotificationState.Unsupported;
	} else if (Notification.permission === DesktopNotificationState.Granted) {
		return DesktopNotificationState.Granted;
	} else if (!window.isSecureContext) {
		return DesktopNotificationState.NoHttps;
	}

	return DesktopNotificationState.Blocked;
}

/** A message's translation (spec § Reading pipeline, 5): in memory only, keyed by the message's store id. */
export interface TranslationEntry {
	/**
	 * `skipped`: detection left the line alone (`reason` says why) and no
	 * request was made. A mark, never a translation: no text, nothing to
	 * copy or quote as context.
	 */
	status: "pending" | "done" | "failed" | "dropped" | "skipped";
	/** Restored text so far (pending) or the result (done). */
	text: string;
	/** Detected source (ISO 639-1) or "" when the engine detected it. */
	from: string;
	to: string;
	/**
	 * The detector's runners-up (`detect.ts` `candidates`), which the chip's
	 * menu offers as one-click "Retranslate from …" corrections. Session
	 * only, like the rest of the entry; an explicit source keeps the list it
	 * inherited, so the alternatives stay on offer.
	 */
	candidates: string[];
	engine: EngineName | null;
	error: string | null;
	/** "Show original only": the line is kept but not rendered. */
	hidden: boolean;
	/**
	 * Why a `skipped` line was not translated: `same`, detected as the
	 * reading language (`from` names it); `unsure`, the detector could not
	 * place it and the reading language is among its `candidates` (or it has
	 * none). Unset on every other status.
	 */
	reason?: "same" | "unsure";
}

/** A draft's translation in the composer (spec § Composer), keyed by the channel's store id. */
export interface OutgoingTranslation {
	status: "pending" | "done" | "failed";
	/** The draft the strip was made from; a different draft invalidates it. */
	draft: string;
	/** Restored text so far (pending) or the translation (done). */
	text: string;
	/**
	 * The draft's language, as the writer chose it (`writeSource`): the
	 * chip's label. Null until the source is known, or when none is named.
	 * A retry leaves it alone -- the draft is still in that language.
	 */
	from: string | null;
	/**
	 * The source the request in flight named: `from` on the first try, null
	 * on the bare second one (the chip's title says "auto").
	 */
	requestFrom: string | null;
	/** The bare second try ran (`outgoing.ts` `bareRetry`). */
	retried: boolean;
	to: string;
	/**
	 * The route that produced it (`writer.ts` `engineFor`): the engine and
	 * the model, both null until the route has answered.
	 */
	engine: EngineName | null;
	/**
	 * The device the route runs its model on: the strip's chip says GPU or
	 * CPU by it, and its download note follows that copy. Unset until the
	 * route has answered.
	 */
	device?: Device;
	model: string | null;
	error: string | null;
	/**
	 * The round trip: idle until the translation is done, then it always
	 * runs. `engine` is the route the read-back came down, which the posted
	 * line's translation carries (writer.ts `recordSentReadBack`).
	 */
	check: {
		status: "idle" | "pending" | "done" | "failed";
		text: string;
		to: string | null;
		engine?: EngineName | null;
	};
}

export type State = {
	appLoaded: boolean;
	activeChannel?: NetChan;
	branding: BrandingConfig;
	currentUserVisibleError: string | null;
	desktopNotificationState: DesktopNotificationState;
	isAutoCompleting: boolean;
	isConnected: boolean;
	networks: ClientNetwork[];
	// TODO: type
	mentions: InboxEntry[];
	hasServiceWorker: boolean;
	/** Chrome offered `beforeinstallprompt` and the app is not installed yet. */
	installPromptAvailable: boolean;
	/** The install guide (InstallGuide.vue) is open. */
	installGuideOpen: boolean;
	pushNotificationState: string;
	serverConfiguration: SharedConfiguration | LockedSharedConfiguration | null;
	sidebarOpen: boolean;
	sidebarDragging: boolean;
	userlistOpen: boolean;
	/** The file upload in flight (`client/js/upload.ts`); `null` when idle. */
	uploadProgress: UploadProgress | null;
	/**
	 * Client-side translation: the device probe, the model manager's rows and
	 * what the worker last reported about itself (`null` while it is healthy).
	 */
	translation: {
		capability: Capability | null;
		models: ModelView[];
		workerError: string | null;
		/** The queue paused an engine after repeated failures (spec § Lifecycle). */
		paused: {engine: EngineName; message: string} | null;
		/** The channel id whose translation panel was asked for (the channel menu). */
		panelFor: number | null;
	};
	translations: Record<number, TranslationEntry>;
	outgoingTranslations: Record<number, OutgoingTranslation>;
	/** Per-channel switch state, keyed `<network uuid>/<channel name>` (translate/channelStore.ts). */
	translateChannels: Record<string, ChannelTranslation>;
};

const state = (): State => ({
	appLoaded: false,
	activeChannel: undefined,
	branding: DEFAULT_BRANDING,
	currentUserVisibleError: null,
	desktopNotificationState: detectDesktopNotificationState(),
	isAutoCompleting: false,
	isConnected: false,
	networks: [],
	mentions: [],
	hasServiceWorker: false,
	installPromptAvailable: false,
	installGuideOpen: false,
	pushNotificationState: "unsupported",
	serverConfiguration: null,
	sidebarOpen: false,
	sidebarDragging: false,
	userlistOpen: storage.get("thelounge.state.userlist") !== "false",
	uploadProgress: null,
	translation: {capability: null, models: [], workerError: null, paused: null, panelFor: null},
	translations: {},
	outgoingTranslations: {},
	translateChannels: {},
});

type Getters = {
	findChannelOnCurrentNetwork: (state: State) => (name: string) => ClientChan | undefined;
	findChannelOnNetwork: (state: State) => (
		networkUuid: string,
		channelName: string
	) => {
		network: ClientNetwork;
		channel: ClientChan;
	} | null;
	findChannel: (state: State) => (id: number) => {
		network: ClientNetwork;
		channel: ClientChan;
	} | null;
	findNetwork: (state: State) => (uuid: string) => ClientNetwork | null;
	/** The conversation an inbox entry belongs to, when this page has it. */
	findConversation: (state: State) => (network: string, target: string) => NetChan | null;
	/** What the inbox shows: every entry but those of muted conversations. */
	visibleMentions: (
		state: State,
		getters: {findConversation: (network: string, target: string) => NetChan | null}
	) => InboxEntry[];
	/** Unread mentions as the inbox shows them (docs/projects/inbox.md). */
	mentionCount(state: State, getters: {visibleMentions: InboxEntry[]}): number;
	title(state: State, getters: Omit<Getters, "title">): string;
};

// getters without the state argument
export type CallableGetters = {
	[K in keyof Getters]: ReturnType<Getters[K]>;
};

const getters: Getters = {
	findChannelOnCurrentNetwork: (state) => (name: string) => {
		name = name.toLowerCase();
		return state.activeChannel?.network.channels.find((c) => c.name.toLowerCase() === name);
	},
	findChannelOnNetwork: (state) => (networkUuid: string, channelName: string) => {
		for (const network of state.networks) {
			if (network.uuid !== networkUuid) {
				continue;
			}

			for (const channel of network.channels) {
				if (channel.name === channelName) {
					return {network, channel};
				}
			}
		}

		return null;
	},
	findChannel: (state) => (id: number) => {
		for (const network of state.networks) {
			for (const channel of network.channels) {
				if (channel.id === id) {
					return {network, channel};
				}
			}
		}

		return null;
	},
	findConversation: (state) => (network: string, target: string) => {
		const key = conversationKey(network, target);
		const net = state.networks.find((n) => n.uuid === network);
		const channel = net?.channels.find((c) => conversationKey(network, c.name) === key);
		return net && channel ? {network: net, channel} : null;
	},
	visibleMentions: (state, getters) =>
		state.mentions.filter((e) => !getters.findConversation(e.network, e.target)?.channel.muted),
	findNetwork: (state) => (uuid: string) => {
		for (const network of state.networks) {
			if (network.uuid === uuid) {
				return network;
			}
		}

		return null;
	},
	// The one count of unread mentions: the @ button, the title, the
	// favicon and the app icon all read it.
	mentionCount: (state, getters) => getters.visibleMentions.length,
	title(state, getters) {
		const alertEventCount = getters.mentionCount ? `(${getters.mentionCount.toString()}) ` : "";
		const channelname = state.activeChannel ? `${state.activeChannel.channel.name} — ` : "";

		return alertEventCount + channelname + state.branding.appName;
	},
};

type Mutations = {
	appLoaded(state: State): void;
	activeChannel(state: State, netChan: State["activeChannel"]): void;
	branding(state: State, branding: State["branding"]): void;
	currentUserVisibleError(state: State, error: State["currentUserVisibleError"]): void;
	refreshDesktopNotificationState(state: State): void;
	isAutoCompleting(state: State, isAutoCompleting: State["isAutoCompleting"]): void;
	isConnected(state: State, payload: State["isConnected"]): void;
	networks(state: State, networks: State["networks"]): void;
	mentions(state: State, mentions: State["mentions"]): void;

	removeNetwork(state: State, networkUuid: string): void;
	sortNetworks(
		state: State,
		sortFn: (a: State["networks"][0], b: State["networks"][0]) => number
	): void;
	hasServiceWorker(state: State): void;
	installPromptAvailable(state: State, available: boolean): void;
	installGuideOpen(state: State, open: boolean): void;
	/** A newer build's service worker took over; a reload picks it up. */
	updateAvailable(state: State): void;
	pushNotificationState(
		state: State,
		pushNotificationState: State["pushNotificationState"]
	): void;
	serverConfiguration(state: State, serverConfiguration: State["serverConfiguration"]): void;
	sidebarOpen(state: State, payload: State["sidebarOpen"]): void;
	sidebarDragging(state: State, payload: State["sidebarDragging"]): void;
	toggleSidebar(state: State): void;
	toggleUserlist(state: State): void;
	userlistOpen(state: State, payload: State["userlistOpen"]): void;
	uploadProgress(state: State, progress: State["uploadProgress"]): void;
	translationCapability(state: State, capability: Capability): void;
	translationModels(state: State, models: ModelView[]): void;
	translationWorkerError(state: State, message: string | null): void;
	translationPaused(state: State, paused: State["translation"]["paused"]): void;
	/** Ask the view of that channel to open its translation panel; null clears it. */
	translationPanelFor(state: State, id: number | null): void;
	translationEntry(state: State, payload: {id: number; entry: TranslationEntry}): void;
	translationPatch(state: State, payload: {id: number; patch: Partial<TranslationEntry>}): void;
	translationRemove(state: State, id: number): void;
	/** Prune several at once: a channel's messages left the store (trim, part, quit). */
	translationRemoveMany(state: State, ids: number[]): void;
	outgoingTranslationSet(
		state: State,
		payload: {chanId: number; value: OutgoingTranslation}
	): void;
	outgoingTranslationPatch(
		state: State,
		payload: {chanId: number; patch: Partial<OutgoingTranslation>}
	): void;
	outgoingTranslationRemove(state: State, chanId: number): void;
	translateChannelSet(state: State, payload: {key: string; value: ChannelTranslation}): void;
	translateChannelRemove(state: State, key: string): void;
	translateChannelsLoaded(state: State, all: Record<string, ChannelTranslation>): void;
};

const mutations: Mutations = {
	appLoaded(state) {
		state.appLoaded = true;
	},
	activeChannel(state, netChan) {
		state.activeChannel = netChan;
	},
	branding(state, branding) {
		state.branding = branding;
	},
	currentUserVisibleError(state, error) {
		state.currentUserVisibleError = error;
	},
	refreshDesktopNotificationState(state) {
		state.desktopNotificationState = detectDesktopNotificationState();
	},
	isAutoCompleting(state, isAutoCompleting) {
		state.isAutoCompleting = isAutoCompleting;
	},
	isConnected(state, payload) {
		state.isConnected = payload;
	},
	networks(state, networks) {
		state.networks = networks;
	},
	mentions(state, mentions) {
		state.mentions = mentions;
	},
	removeNetwork(state, networkId) {
		state.mentions = state.mentions.filter((e) => e.network !== networkId);
		state.networks.splice(
			state.networks.findIndex((n) => n.uuid === networkId),
			1
		);
	},
	sortNetworks(state, sortFn) {
		state.networks.sort(sortFn);
	},
	hasServiceWorker(state) {
		state.hasServiceWorker = true;
	},
	installPromptAvailable(state, available) {
		state.installPromptAvailable = available;
	},
	installGuideOpen(state, open) {
		state.installGuideOpen = open;
	},
	updateAvailable(state) {
		if (state.serverConfiguration) {
			state.serverConfiguration.isUpdateAvailable = true;
		}
	},
	pushNotificationState(state, pushNotificationState) {
		state.pushNotificationState = pushNotificationState;
	},
	serverConfiguration(state, serverConfiguration) {
		state.serverConfiguration = serverConfiguration;
	},
	sidebarOpen(state, payload) {
		state.sidebarOpen = payload;
	},
	sidebarDragging(state, payload) {
		state.sidebarDragging = payload;
	},
	toggleSidebar(state) {
		state.sidebarOpen = !state.sidebarOpen;
	},
	toggleUserlist(state) {
		state.userlistOpen = !state.userlistOpen;
	},
	userlistOpen(state, payload) {
		state.userlistOpen = payload;
	},
	uploadProgress(state, progress) {
		state.uploadProgress = progress;
	},
	translationCapability(state, capability) {
		state.translation.capability = capability;
	},
	translationModels(state, models) {
		state.translation.models = models;
	},
	translationWorkerError(state, message) {
		state.translation.workerError = message;
	},
	translationPaused(state, paused) {
		state.translation.paused = paused;
	},
	translationPanelFor(state, id) {
		state.translation.panelFor = id;
	},
	translationEntry(state, {id, entry}) {
		state.translations[id] = entry;
	},
	translationPatch(state, {id, patch}) {
		const entry = state.translations[id];

		if (entry) {
			Object.assign(entry, patch);
		}
	},
	translationRemove(state, id) {
		delete state.translations[id];
	},
	translationRemoveMany(state, ids) {
		for (const id of ids) {
			delete state.translations[id];
		}
	},
	outgoingTranslationSet(state, {chanId, value}) {
		state.outgoingTranslations[chanId] = value;
	},
	outgoingTranslationPatch(state, {chanId, patch}) {
		const entry = state.outgoingTranslations[chanId];

		if (entry) {
			Object.assign(entry, patch);
		}
	},
	outgoingTranslationRemove(state, chanId) {
		delete state.outgoingTranslations[chanId];
	},
	translateChannelSet(state, {key, value}) {
		state.translateChannels[key] = value;
	},
	translateChannelRemove(state, key) {
		delete state.translateChannels[key];
	},
	translateChannelsLoaded(state, all) {
		state.translateChannels = all;
	},
};

export type TypedCommit = <T extends keyof Mutations>(
	type: T,
	payload?: Parameters<Mutations[T]>[1] | null,
	options?: {root?: boolean}
) => ReturnType<Mutations[T]>;

const storePattern = {
	state,
	mutations,
	getters,
};

// https://vuex.vuejs.org/guide/typescript-support.html#typing-usestore-composition-function
export const key: InjectionKey<Store<State>> = Symbol();

// vuex types getters as any
export type TypedStore = Omit<Store<State>, "getters" | "commit"> & {
	getters: CallableGetters;
	commit: TypedCommit;
	state: State & {
		settings: SettingsState;
	};
};

export const store = createStore(storePattern) as TypedStore;

const settingsStore = createSettingsStore(store);

// Settings module is registered dynamically because it benefits
// from a direct reference to the store
store.registerModule("settings", settingsStore);

export function useStore() {
	return baseUseStore(key) as TypedStore;
}
