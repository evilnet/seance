// The reading pipeline's glue (spec § Reading pipeline): one of the three
// modules — with index.ts and writer.ts — that import the store. Nothing
// here runs while translation is off (index.ts `translationOn`, switch.ts):
// every entry asks first, switching off stops every queue and clears what
// the store shows (`stopReading`), and switching back on reads what is on
// screen (`resumeReading`).
//
// With translation on, every channel and query reads unless the user
// excluded it (switch.ts `readsHere`), but only the conversation on screen
// does any work (onScreen.ts): its live lines as they arrive (a second
// `socket.on("msg")` listener, registered by socket-events/translate.ts
// after socket-events/msg.ts pushed the message), and the lines that come
// into view -- on opening it, on scrolling, on a history page or a replay
// landing, on the page coming back from the background -- through
// `scanOnScreen`. Each runs eligibility → detection → context → queue; the
// queue writes state.translations; the panel and the composer sheet call
// setReading/setChannelOptions; the chip and the toolbar call
// retranslate/showOriginal/retryTranslation.

import {ref as vueRef, toRaw, watch} from "vue";

import {getBranding} from "../branding";
import {userLanguageRef} from "../i18n";
import socket from "../socket";
import {store, type TranslationEntry} from "../store";
import type {ClientChan, ClientMessage, ClientNetwork} from "../types";
import {ChanType} from "../../../shared/types/chan";
import {
	type ChannelTranslation,
	channelKey,
	defaultChannelTranslation,
	effectiveFormality,
	forgetNetwork,
	forgetTerms,
	loadAll,
	migrateChannelStore,
	setChannelTranslation,
	termsFor,
} from "./channelStore";
import {buildContext} from "./context";
import {
	type Detection,
	LanguagePrior,
	detectLanguage,
	detectionSkip,
	sourceFor,
	withSenderLanguage,
} from "./detect";
import {HISTORY_QUEUE_CAP, isChatLine, isEligible, plainTextOf} from "./eligibility";
import {namesFor} from "./names";
import {fromLocaleTag, isSupported} from "./languages";
import {OnScreen, linesToRead} from "./onScreen";
import storage from "../localStorage";
import {needsDownloadError} from "./consent";
import {
	APPLE_REF,
	type ModelBlock,
	choiceFor,
	deviceOrder,
	llmChoice,
	llmName,
	modelBlock,
	selectLlm,
} from "./models";
import type {Device, DeviceChoice, ModelRef} from "./engine";
import {type IsolationEnv, cpuThreads, isolationState} from "./threads";
import {threadsText} from "../helpers/translateWhy";
import {serviceWorkerCanServe} from "../pwa";
import {type RouteVerdict, explainRoute, routeInput, translationBlock} from "./router";
import {
	activeService,
	configuredCatalog,
	onTranslationSwitch,
	servedIsolating,
	serviceSettings,
	setTranslationUsage,
	systemTranslator,
	translateService,
	translationOn,
} from "./index";
import {considersLine, readsHere as readsRule, translationOffBlock} from "./switch";
import {NO_ROUTE, type QueueItem, type QueueUpdate, TranslateQueue} from "./queue";
import {sentReadBacks, takesReadBack} from "./sentReadBack";
import {protect, stripCopiedNickPrefix} from "./spans";
import {topicEntryId} from "./topic";
import {yieldToPage} from "./yieldToPage";
import {claimPack} from "./applePacks";

const queues = new Map<string, TranslateQueue>();
/** The conversation on screen and its lines in view (onScreen.ts). */
export const onScreen = new OnScreen();
/**
 * Lines looked at and found not to be worth anything -- not a chat line,
 * nothing left once the syntax is gone -- which leave no entry in the
 * store: remembered so scrolling past them again does not strip and
 * measure them again. Forgotten with the reading they were judged under.
 */
const considered = new Set<number>();
/** Lines on their way through `translateMessage` right now: a scan does not start them twice. */
const considering = new Set<number>();
/** Translation was just switched on and its first scan has not finished. */
let firstReadPending = false;
const priors = new Map<string, LanguagePrior>();
const arrivals = new Map<number, number>();
/**
 * Per channel id, bumped whenever its reading restarts (switched on, off,
 * or to another language) or the channel goes: a history run or a
 * detection still under way for the old state stops rather than queueing
 * into the new one — twice, or into a channel that is no longer there.
 */
const generations = new Map<number, number>();
/**
 * The last item queued per message, for retries. `unsure` marks one queued
 * only because the detector could not place it (not a forced request): with
 * no engine for an unnamed source it becomes the unsure mark, not a failure.
 */
const items = new Map<number, {network: string; item: QueueItem; unsure?: boolean}>();

/** Composer requests holding the reading queues (writer.ts); nested holds count. */
let holds = 0;

export function holdReading(): void {
	if (holds++ === 0) {
		for (const queue of queues.values()) {
			queue.hold();
		}
	}
}

export function releaseReading(): void {
	if (holds > 0 && --holds === 0) {
		for (const queue of queues.values()) {
			queue.release();
		}
	}
}

export function channelTranslation(
	network: ClientNetwork,
	channel: ClientChan
): ChannelTranslation {
	return (
		store.state.translateChannels[channelKey(network.uuid, channel.name)] ??
		defaultChannelTranslation()
	);
}

/**
 * The language the user reads in: Settings → Language's "Translate into"
 * (`translateInto`, any of the supported languages), or where that is
 * "Same as the interface" (its default, ""), the interface's
 * (`userLanguageRef`; `fromLocaleTag` maps it to a translation code). The
 * one decision for everything that needs it: the queues translate into it,
 * the composer (`writer.ts`) places a draft it cannot detect and reads a
 * translation back into it, and the labels (`TranslationLine.vue`, the
 * composer strip) name their languages in it.
 */
export function readingLanguage(): string {
	const into = store.state.settings.translateInto;

	return typeof into === "string" && isSupported(into)
		? into
		: fromLocaleTag(userLanguageRef.value);
}

/**
 * The languages the user reads besides the reading language (Settings →
 * Language, "I also read"): a line detected in one is left as it is,
 * though the toolbar's Translate still translates it on request.
 */
export function alsoReadLanguages(): string[] {
	const list: unknown = store.state.settings.translateAlsoRead;

	return Array.isArray(list)
		? list.filter((code): code is string => typeof code === "string" && isSupported(code))
		: [];
}

/** The effective-reading rule (switch.ts `readsHere`) over the store. */
export function readsHere(network: ClientNetwork, channel: ClientChan): boolean {
	return readsRule(translationOn(), channel.type, channelTranslation(network, channel).exclude);
}

/** Whether `channel` is the conversation on screen (onScreen.ts). */
function shownNow(channel: ClientChan): boolean {
	return onScreen.current() === channel.id;
}

/**
 * What reading is judged under: the reading language and the "I also
 * read" list. When either changes (Settings, or the interface's language
 * while "Translate into" follows it), every conversation starts over
 * (`requeueReading`): what is translated is dropped, and the one on screen
 * is read again in the new terms. A change that leaves both alone
 * restarts nothing; the terms the reader is initialised with are the ones
 * to measure the first change against, so they are recorded there.
 */
let lastReadingTerms: string | null = null;

function readingTerms(): string {
	return JSON.stringify([readingLanguage(), [...alsoReadLanguages()].sort()]);
}

function restartAllReading(): void {
	const next = readingTerms();

	if (next === lastReadingTerms) {
		return;
	}

	lastReadingTerms = next;

	for (const network of store.state.networks) {
		for (const channel of network.channels) {
			if (readsHere(network, channel)) {
				requeueReading(network, channel);
			}
		}
	}
}

watch(readingTerms, restartAllReading);

/**
 * Whether translation is wanted right now (service.ts `setInUse`): a
 * composer strip open (with its read-back), a line waiting in a queue, the
 * conversation on screen reading, or a channel still in the store writing
 * through it. A conversation in the background reads nothing until it is
 * opened, so it wants nothing meanwhile. When none is, and nothing is in
 * flight, the models unload at once.
 */
export function translationInUse(): boolean {
	if (Object.keys(store.state.outgoingTranslations).length > 0) {
		return true;
	}

	if ([...queues.values()].some((queue) => queue.size() > 0)) {
		return true;
	}

	const shown = onScreen.current();
	const found = shown === null ? undefined : store.getters.findChannel(shown);

	if (found && readsHere(found.network, found.channel)) {
		return true;
	}

	return store.state.networks.some((network) =>
		network.channels.some((channel) => !!channelTranslation(network, channel).write)
	);
}

/**
 * Whether translation is offered here at all: switched on (the deploy and
 * the user, `translationOn`), and the device probe found something to run
 * it on. Every surface that offers translation asks this first -- the
 * header's button, the composer's, the toolbar's Translate, the channel
 * menu -- so with translation off none of them renders, and none of them
 * makes the service (whose creation starts the probe) just to ask.
 */
export function translationAvailable(): boolean {
	if (!translationOn()) {
		return false;
	}

	const tier = store.state.translation.capability?.tier;

	return translateService().enabled && tier !== undefined && tier !== "none";
}

/**
 * `translationAvailable`, with a probe still running counted as yes: for
 * what must not pop into place once the probe lands (the composer's
 * translate button, which shifted the input on every app load). Only a
 * device the probe rules out takes it away again.
 */
export function translationMayRun(): boolean {
	if (!translationOn()) {
		return false;
	}

	return translateService().enabled && store.state.translation.capability?.tier !== "none";
}

/**
 * The catalog as the service runs it: the language model the setting, the
 * probe and its device setting resolve to. Read from the running service
 * when there is one and from the configuration otherwise, so naming a model
 * in a reason never makes the service -- nor throws while translation is
 * off, when there is none to make.
 */
function liveCatalog() {
	return selectLlm(
		activeService()?.catalog ?? configuredCatalog(),
		store.state.settings.translateLlmModel,
		store.state.translation.capability,
		serviceSettings().devices.llm
	);
}

/** The language model in use, by its product name (the words of a reason that names it). */
export function liveLlmName(): string {
	return llmName(liveCatalog().llm);
}

/** Where a model runs here: its device setting, Auto's order, and each device's block. */
export interface ModelDevices {
	choice: DeviceChoice;
	/** The devices to try, best first (models.ts `deviceOrder`). */
	order: Device[];
	/** What keeps it off each device (models.ts `modelBlock`), with the user's switches. */
	blocks: Record<Device, ModelBlock | null>;
}

/**
 * `ref` on each device, for Settings' Run on and copy lines: the store glue
 * over `choiceFor`, `deviceOrder` and `modelBlock`. Reactive through the
 * store reads. A language model is judged on each device with the model
 * that device would run: an Automatic choice (the setting "") the adapter
 * resolves to the 4B runs the 1.7B on the CPU (models.ts `llmChoice`), so
 * its CPU is not blocked by the 4B's missing CPU copy. Pass `exact` to
 * judge `ref` itself on both (a copy line of a model that is not in use).
 */
export function modelDevices(ref: ModelRef, exact = false): ModelDevices {
	const service = translateService();
	const capability = store.state.translation.capability;
	const {switches, devices} = serviceSettings();
	const choice = choiceFor(ref, devices);
	const on = (device: Device): ModelRef =>
		ref.family === "llm" && !exact
			? llmChoice(
					service.catalog,
					store.state.settings.translateLlmModel,
					capability,
					device === "cpu" ? "cpu" : "auto"
			  )
			: ref;
	const block = (device: Device) =>
		modelBlock(on(device), device, capability, switches, service.enabled);

	return {
		choice,
		order: deviceOrder(ref, choice, capability),
		blocks: {gpu: block("gpu"), cpu: block("cpu")},
	};
}

/**
 * What decides whether the CPU models can run multithreaded on this page
 * (threads.ts `isolationState`): whether it is isolated, whether the
 * service worker served this document (its navigation timing's
 * `workerStart`) and meant to isolate it (the flag it served it by,
 * index.ts `servedIsolating`), whether it isolates the next load
 * (translation is on), WebKit by the same rule the worker uses
 * (service-worker.js), and whether a worker is ever registered here.
 */
export function isolationEnv(): IsolationEnv {
	const ua = navigator.userAgent;
	const nav = performance.getEntriesByType?.("navigation")[0] as
		| PerformanceNavigationTiming
		| undefined;

	return {
		crossOriginIsolated: !!self.crossOriginIsolated,
		controlled: (nav?.workerStart ?? 0) > 0,
		servedIsolating: servedIsolating(),
		workerIsolates: translationOn(),
		webkit: /AppleWebKit\//.test(ua) && !/Chrome\//.test(ua),
		workerCanServe: serviceWorkerCanServe(),
	};
}

/** Settings' CPU threads line (helpers/translateWhy.ts `threadsText`); "" when there is none. */
export function cpuThreadsLine(): string {
	const mobile = !!store.state.translation.capability?.mobile;

	return threadsText(
		isolationState(isolationEnv()),
		cpuThreads(navigator.hardwareConcurrency, mobile)
	);
}

/** Why translation is off, or null while it is on (switch.ts `translationOffBlock`). */
function offBlock(): ModelBlock | null {
	return translationOffBlock(
		store.state.branding.translation,
		store.state.settings.translationEnabled
	);
}

/**
 * Translation is off by the user's own setting (its default), not the
 * deploy's: the switch in Settings would turn it on. Never makes the service.
 */
export function translationOffByUser(): boolean {
	return (
		translationOffBlock(
			store.state.branding.translation,
			store.state.settings.translationEnabled
		)?.by === "user"
	);
}

/**
 * Whether anything can translate here right now, and if not why (router.ts
 * `translationBlock`): the deploy, the probe, the device, the user's two
 * switches. Null once an engine runs. Reactive through the store reads, so
 * a component's computed follows the switches and the probe.
 */
export function currentTranslationBlock(): ModelBlock | null {
	// Switched off -- by the user or by the deploy, which say different
	// things -- nothing is offered and nothing reads this; answered without
	// making the service.
	const off = offBlock();

	if (off) {
		return off;
	}

	const {switches, devices} = serviceSettings();

	return translationBlock(
		liveCatalog(),
		store.state.translation.capability,
		switches,
		devices,
		translateService().enabled
	);
}

/**
 * Whether `from` → `to` can be translated here, and if not why (router.ts
 * `explainRoute`, the router's own test). `from` null is a line the
 * detector will place before the request goes, so the CPU models count;
 * `from` equal to `to` is the cleanup pass (`polish` in the verdict).
 */
export function pairVerdict(from: string | null, to: string): RouteVerdict {
	const off = offBlock();

	if (off) {
		return {route: null, why: off, polish: from !== null && from === to};
	}

	const apple = appleVerdict(from, to);

	if (apple) {
		return apple;
	}

	const service = translateService();
	const capability = store.state.translation.capability;
	const {switches, devices} = serviceSettings();
	const input = routeInput(capability, switches, devices, {
		from,
		to,
		sourceLater: from === null,
	});

	if (!service.enabled || !capability) {
		return {
			route: null,
			why: service.enabled ? {kind: "probing"} : {kind: "disabled"},
			polish: from !== null && from === to,
		};
	}

	return explainRoute(service.routeTable, liveCatalog(), input);
}

/** Bumped when the system translator learns a pair's status, so a verdict that read it recomputes. */
const appleStatuses = vueRef(0);
const appleHeard = new WeakSet<object>();

/**
 * The system translator's verdict, where the service would take it: a pair
 * whose pack is installed goes to Apple before any table (service.ts
 * `appleRoute`), so the row says so -- no download -- instead of naming the
 * table's model. A pair not asked about yet is asked once (`lookup`) and the
 * verdict recomputes when the answer arrives; until then, and for a pack
 * that is not installed, the table's verdict stands, as the service's walk
 * does on a line it reads.
 */
function appleVerdict(from: string | null, to: string): RouteVerdict | null {
	const apple = systemTranslator();

	if (!apple || !from || from === to || serviceSettings().system === false) {
		return null;
	}

	if (!appleHeard.has(apple)) {
		appleHeard.add(apple);
		apple.onKnown(() => {
			appleStatuses.value++;
		});
	}

	// Read so that a computed over this verdict hears the next answer.
	void appleStatuses.value;
	const status = apple.knownStatus(from, to);

	if (status === undefined) {
		apple.lookup(from, to);
		return null;
	}

	return status === "installed"
		? {route: {candidate: "apple", ref: APPLE_REF, device: "cpu"}, why: null, polish: false}
		: null;
}

function priorFor(network: ClientNetwork, channel: ClientChan): LanguagePrior {
	const key = channelKey(network.uuid, channel.name);
	let prior = priors.get(key);

	if (!prior) {
		prior = new LanguagePrior();
		priors.set(key, prior);
	}

	return prior;
}

function generationOf(chanId: number): number {
	return generations.get(chanId) ?? 0;
}

/** Still the reading the caller started under, in a channel still in the store. */
function stillCurrent(chanId: number, generation: number): boolean {
	return generationOf(chanId) === generation && !!store.getters.findChannel(chanId);
}

function queueFor(network: ClientNetwork): TranslateQueue {
	let queue = queues.get(network.uuid);

	if (!queue) {
		const service = translateService();

		queue = new TranslateQueue({
			// Quiet: nothing the reader did not ask for interrupts them. A
			// route that needs a download nobody agreed to fails the line
			// with the model named (consent.ts), through the queue's rejection
			// path, which pauses nothing, and the line offers the download
			// (TranslationLine.vue); a system language pack is offered on the
			// line too (applePacks.ts), never in the system's sheet.
			route: (from, to, hint) =>
				service
					.resolve(from, to, hint, {quiet: true})
					.then(({route, refused, refusedDevice}) => {
						if (!route && refused) {
							throw new Error(
								needsDownloadError(refused, refusedDevice ?? undefined)
							);
						}

						return route ? {engine: route.ref.engine, device: route.device} : null;
					}),
			translate: (req, signal) => service.translate(req, signal),
			loadTicks: () => service.loadTicks(),
			priority(chanId) {
				if (store.state.activeChannel?.channel.id === chanId) {
					return 0;
				}

				const index = network.channels.findIndex((c) => c.id === chanId);

				return index < 0 ? network.channels.length + 1 : index + 1;
			},
			arrivals: (chanId) => arrivals.get(chanId) ?? 0,
			onUpdate: (id, update) => applyUpdate(id, update),
			onPause: (engine, message) => store.commit("translationPaused", {engine, message}),
			// The pause waited itself out (`PAUSE_RESUME_MS`) or someone
			// asked for a line on that engine: the banner goes, unless the
			// one showing is another engine's.
			onResume(engine) {
				if (store.state.translation.paused?.engine === engine) {
					store.commit("translationPaused", null);
				}
			},
		});

		if (holds > 0) {
			queue.hold();
		}

		queues.set(network.uuid, queue);
	}

	return queue;
}

/**
 * The finished translation with a nick prefix the model copied out of the
 * context taken off — but only when the message itself did not open with
 * one (spans.ts `stripCopiedNickPrefix`), which needs the message and its
 * channel. Read before the item is forgotten; an item, a channel or a
 * message we cannot find leaves the text as the engine gave it, since
 * keeping a prefix is the harmless way to be wrong.
 */
function withoutCopiedNick(id: number, known: {item: QueueItem} | undefined, text: string): string {
	if (!known) {
		return text;
	}

	const target = store.getters.findChannel(known.item.chanId);
	const at = target?.channel.messages.findIndex((m) => m.id === id) ?? -1;
	const message = at >= 0 ? target?.channel.messages[at] : undefined;
	const source = message?.text;

	if (!target || !source) {
		return text;
	}

	// The set the line was fenced with, not the user list: a prefix the model
	// copied out of the context is the model's to lose whoever holds the name,
	// and the name may be someone who has since left (names.ts `namesFor`).
	return stripCopiedNickPrefix(
		text,
		source,
		namesFor({
			users: target.channel.users,
			sender: message?.from?.nick,
			target: target.channel.name,
			messages: target.channel.messages.slice(0, at + 1),
		})
	);
}

function applyUpdate(id: number, update: QueueUpdate): void {
	const existing = store.state.translations[id];
	const known = items.get(id);

	// A line leaving the queue may be the last thing translation was wanted
	// for (queue sizes are not store state, so the watch in index.ts cannot see it).
	// The running service only: the lines a switch-off drops are reported
	// with the service already out of reach (switch.ts), and asking for one
	// would make it again.
	if (update.status !== "pending") {
		activeService()?.usageChanged();
	}

	// The queue is finished with the item, so the context it carries (up
	// to CONTEXT_LINES of text, the names and a copy of the channel's term
	// memory) goes with it. Never on "failed": retryTranslation's fast
	// path is what that entry survives for; anything else is rebuilt by
	// retranslate.
	if (update.status === "done" || update.status === "dropped") {
		items.delete(id);
	}

	switch (update.status) {
		case "pending":
			if (existing) {
				store.commit("translationPatch", {
					id,
					patch: {
						status: "pending",
						text: update.text,
						engine: update.engine,
						error: null,
					},
				});
			}

			break;
		case "done":
			store.commit("translationPatch", {
				id,
				patch: {
					status: "done",
					// The prompt shows the earlier lines as `nick: text`, so a
					// model can copy a name in that shape; only the finished
					// text is cleaned, since a stream's prefix is not a prefix
					// until the line after it has arrived.
					text: withoutCopiedNick(id, known, update.text),
					engine: update.engine,
					error: null,
				},
			});

			if (existing) {
				claimPack(id, existing.from, existing.to);
			}

			break;
		case "failed":
			// A line queued with its source left to the engine because the
			// detector could not place it, and no engine takes an unnamed
			// source (a CPU-only device): what it would otherwise have been is
			// the unsure mark, not a failure nobody asked for.
			if (update.error === NO_ROUTE && known?.unsure) {
				items.delete(id);
				store.commit("translationPatch", {
					id,
					patch: {status: "skipped", reason: "unsure", from: "", error: null},
				});
				break;
			}

			store.commit("translationPatch", {id, patch: {status: "failed", error: update.error}});
			break;
		case "dropped":
			if (existing && existing.status !== "done") {
				store.commit("translationPatch", {id, patch: {status: "dropped"}});
			}

			break;
	}
}

/** Drop the remembered queue items the predicate matches. */
function forgetItems(match: (entry: {network: string; item: QueueItem}) => boolean): void {
	for (const [id, entry] of items) {
		if (match(entry)) {
			items.delete(id);
		}
	}
}

/**
 * Messages that are gone for good -- a trim, a cleared history, a redaction,
 * an edit's original -- take the pipeline's memory of them with them. The
 * store's own `translationRemove`/`translationRemoveMany` drops the
 * translation; this drops the queue item the chip's retry would have reused,
 * which is keyed by the same message id and could never be reached again.
 */
export function forgetTranslations(ids: readonly number[]): void {
	for (const id of ids) {
		items.delete(id);
		considered.delete(id);
	}
}

function commitChannel(
	network: ClientNetwork,
	channel: ClientChan,
	value: ChannelTranslation
): void {
	store.commit("translateChannelSet", {key: channelKey(network.uuid, channel.name), value});
}

/**
 * "Translate what I read here" (the panel and the composer sheet): off
 * stores an exclusion (channelStore.ts `exclude`) and stops the
 * conversation's reading; on removes it and reads what is on screen. The
 * same setting again changes nothing. A line asked for by hand -- the
 * toolbar's Translate -- is still translated in an excluded conversation.
 */
export function setReading(network: ClientNetwork, channel: ClientChan, on: boolean): void {
	const before = readsHere(network, channel);
	const value = setChannelTranslation(network.uuid, channel.name, {exclude: !on});

	commitChannel(network, channel, value);

	if (readsHere(network, channel) === before) {
		return;
	}

	if (!on) {
		stopChannel(network, channel);
		forgetTopic(channel.id);
		return;
	}

	requeueReading(network, channel);
}

/**
 * A conversation's reading stops where it stands: every detection and scan
 * under way gives up at its next check, and its waiting and in-flight
 * lines leave the queue as dropped -- which is what makes them worth
 * reading again when they are next in view (`scanOnScreen`). What is
 * finished stays.
 */
function stopChannel(network: ClientNetwork, channel: ClientChan): void {
	generations.set(channel.id, generationOf(channel.id) + 1);
	queues.get(network.uuid)?.cancelChannel(channel.id);
}

/**
 * Start a conversation over: its queued work and translations go, its
 * language prior with them, and the one on screen is read again from what
 * is in view (`scanOnScreen`); one in the background is read when it is
 * opened. Every way into a fresh read goes through here -- reading
 * switched back on in it, and a change of the reading language or of "I
 * also read" (`restartAllReading`), which leave the exclusion alone and so
 * never reach `setReading`'s body.
 *
 * Own lines go with the rest and are read again like anyone's. The one
 * exception is an own line whose translation is already in the new language
 * -- a posted line's read-back (writer.ts) -- which is kept, and which the
 * scan then leaves alone rather than translating it a second time.
 */
export function requeueReading(network: ClientNetwork, channel: ClientChan): void {
	// Switched off: the channel's setting is kept and nothing is queued;
	// switching back on reads what is on screen (`resumeReading`).
	if (!translationOn()) {
		return;
	}

	stopChannel(network, channel);

	// Only a finished translation already in the reading language is kept;
	// a skipped mark is detected again like everything else.
	const lang = readingLanguage();

	forgetItems(({item}) => item.chanId === channel.id);

	const dropped = channel.messages.filter((m) => {
		const entry = store.state.translations[m.id];

		return !(m.self && entry?.status === "done" && entry.to === lang);
	});

	store.commit(
		"translationRemoveMany",
		dropped.map((m) => m.id)
	);

	for (const m of channel.messages) {
		considered.delete(m.id);
	}

	priors.delete(channelKey(network.uuid, channel.name));
	forgetTopic(channel.id);

	if (shownNow(channel)) {
		scheduleScan(channel.id);
		void readTopic(network, channel);
	}
}

/** Channel ids with a scan asked for and not yet run: one scan per task, however many asks. */
const scansDue = new Set<number>();

/**
 * Ask for a scan of `chanId`, run in a task of its own: after every
 * observer callback of the frame that asked (lineVisibility.ts has two),
 * so the scan sees which lines are on the visible part as well as which
 * are near it.
 */
function scheduleScan(chanId: number): void {
	if (scansDue.has(chanId)) {
		return;
	}

	scansDue.add(chanId);
	setTimeout(() => {
		scansDue.delete(chanId);
		void scanOnScreen(chanId);
	});
}

/**
 * Whether a line in view still needs reading: nothing has looked at it in
 * the current reading (no entry, not judged ineligible), or what did was
 * cut short (dropped: the conversation was left, or the page hidden,
 * before it finished). A failed line keeps its Retry, a skipped one its
 * mark, a done one its translation: none of them is read again.
 */
function wantsReading(id: number): boolean {
	if (considered.has(id) || considering.has(id)) {
		return false;
	}

	const entry = store.state.translations[id];

	return !entry || entry.status === "dropped";
}

/**
 * Read the lines of the conversation on screen that are in view and not
 * read yet, newest first and at most `HISTORY_QUEUE_CAP` of them a scan.
 * Asked whenever lines come into view (onScreen.ts), a conversation is
 * opened, the page comes back, or reading starts over; a scan of a
 * conversation that is no longer on screen, or no longer reads, does
 * nothing, and one cut short by a later change stops at its next line.
 */
async function scanOnScreen(chanId: number): Promise<void> {
	const found = store.getters.findChannel(chanId);

	if (!found || !shownNow(found.channel) || !readsHere(found.network, found.channel)) {
		return;
	}

	const {network, channel} = found;
	const generation = generationOf(chanId);
	const inView = onScreen.inView(chanId);
	const lines = linesToRead(
		toRaw(channel.messages),
		inView,
		(m) => wantsReading(m.id),
		HISTORY_QUEUE_CAP,
		onScreen.visible(chanId)
	);
	let queued = false;

	for (const [index, message] of lines.entries()) {
		// A task boundary between two lines (yieldToPage.ts): once the
		// detector is loaded a whole screen would otherwise be one task.
		if (index > 0) {
			await yieldToPage();
		}

		if (!stillCurrent(chanId, generation) || !shownNow(channel)) {
			return;
		}

		if (wantsReading(message.id) && (await readLine(network, channel, message, false))) {
			queued = true;
		}
	}

	// Nothing reported in view yet (the list has not mounted its observer):
	// the first-run note waits for a scan that has seen the screen.
	if (inView.size > 0) {
		noteFirstRead(queued);
	}
}

/**
 * One line through `translateMessage` on reading's own account (not a
 * forced request): marked while it is on its way, so a scan does not start
 * it twice, and remembered as considered when it turned out not to be worth
 * reading, so the next scan passes it by.
 */
async function readLine(
	network: ClientNetwork,
	channel: ClientChan,
	message: ClientMessage,
	live: boolean
): Promise<boolean> {
	considering.add(message.id);

	try {
		const outcome = await translateMessage(network, channel, message, false, !live);

		if (outcome === "ineligible") {
			considered.add(message.id);
		}

		return outcome === "queued";
	} finally {
		considering.delete(message.id);
	}
}

/**
 * A line left the view before its turn came: reading lets it go (dropped,
 * so it is read again when it is back in view), and what is in view now is
 * not kept waiting behind what the reader scrolled past. A line someone
 * asked for -- the toolbar's Translate, a Retry: a single item -- stays.
 */
function lineLeft(id: number): void {
	const known = items.get(id);

	if (known && !known.item.single) {
		queues.get(known.network)?.cancelWaiting(id);
	}
}

/** The topic each channel's translation was made from (topic.ts). */
const topicSources = new Map<number, string>();

/**
 * Drop a channel's topic translation: reading switched off, a fresh read
 * (`requeueReading`), or a topic that is gone.
 */
export function forgetTopic(chanId: number): void {
	const id = topicEntryId(chanId);

	topicSources.delete(chanId);
	items.delete(id);
	store.commit("translationRemoveMany", [id]);
}

/**
 * Read a channel's topic the way its lines are read: detected, left alone
 * when it is already in the reading language, and otherwise translated
 * into it and kept under the channel's topic id (topic.ts) for the header
 * to show in the topic's place. Idempotent on the topic as it stands --
 * the header calls it whenever the channel, its topic or the reading
 * language changes -- and a dropped or failed request is asked again the
 * next time. Never batched, and at the front of the queue: the topic is
 * the line the reader is looking at.
 */
export async function readTopic(network: ClientNetwork, channel: ClientChan): Promise<void> {
	// Chat.vue asks on every channel opened: switched off, it is nothing.
	if (!translationOn()) {
		return;
	}

	const id = topicEntryId(channel.id);
	const topic = channel.topic;
	const initial = channelTranslation(network, channel);

	if (!readsHere(network, channel) || !topic) {
		forgetTopic(channel.id);
		return;
	}

	// Read when its conversation is opened (Chat.vue asks again then).
	if (!shownNow(channel)) {
		return;
	}

	const existing = store.state.translations[id];

	if (
		topicSources.get(channel.id) === topic &&
		existing &&
		existing.to === readingLanguage() &&
		(existing.status === "pending" || existing.status === "done")
	) {
		return;
	}

	topicSources.set(channel.id, topic);

	if (!store.state.translation.capability) {
		await translateService().capabilities();
	}

	// Switched off during the probe: translationAvailable answers no.
	if (!translationAvailable()) {
		return;
	}

	const nicks = namesFor({
		users: channel.users,
		target: channel.name,
		messages: channel.messages,
	});
	const plain = plainTextOf(topic, nicks);

	if (plain.trim() === "") {
		forgetTopic(channel.id);
		return;
	}

	const generation = generationOf(channel.id);
	const prior = priorFor(network, channel);
	const detection = await detectLanguage(plain, prior, initial.languages, {
		exclude: readingLanguage(),
	});

	// The wait above is where the world moves: the switch, the language,
	// the topic itself and the channel are all re-read (cf. translateMessage).
	const settings = channelTranslation(network, channel);

	if (
		!translationOn() ||
		!store.getters.findChannel(channel.id) ||
		!readsHere(network, channel) ||
		generationOf(channel.id) !== generation ||
		channel.topic !== topic
	) {
		return;
	}

	const to = readingLanguage();

	if (detectionSkip(detection, to, alsoReadLanguages())) {
		// Already readable: no entry, the header shows the topic as it is.
		items.delete(id);
		store.commit("translationRemoveMany", [id]);
		return;
	}

	const {source, unsure, routeHint} = sourceFor(detection, null, to, prior.top());
	const protectedText = protect(topic, {nicks});
	const item: QueueItem = {
		id,
		chanId: channel.id,
		text: protectedText.text,
		spans: protectedText.spans,
		meta: protectedText.meta,
		from: source,
		routeHint,
		to,
		// The channel's recent lines and names as context, the topic itself
		// left out of it: the prompt would otherwise quote the line it is
		// about to translate.
		context: buildContext(
			{messages: channel.messages, users: channel.users, topic: ""},
			{id, text: topic},
			{
				translated(messageId) {
					const entry = store.state.translations[messageId];

					return entry && entry.status === "done" ? entry.text : undefined;
				},
				terms: termsFor(settings.terms, source, to),
				glossary: getBranding().translation?.glossary ?? [],
				formality: effectiveFormality(
					settings.formality,
					store.state.settings.translateFormality
				),
				variant: settings.variant,
				sourceHint: source ?? (unsure ? null : prior.top()),
				nicks,
			}
		),
		arrivalsAtEnqueue: arrivals.get(channel.id) ?? 0,
		single: true,
	};

	items.set(id, {network: network.uuid, item, unsure});
	store.commit("translationEntry", {id, entry: entryFor(source ?? "", to, detection.candidates)});
	queueFor(network).retry(item);
}

/**
 * Ask the view of that channel to open its translation panel (the channel
 * menu's "Translation…", which switches to the channel first). Store
 * state rather than an event: the view may not exist yet when it is asked.
 * Off by the user's own setting, the panel opens too, as the one button
 * that switches translation on (spec § Finding it); off by the deploy, it
 * does not.
 */
export function requestTranslationPanel(channel: ClientChan): void {
	if (translationOn() || translationOffByUser()) {
		store.commit("translationPanelFor", channel.id);
	}
}

export function setChannelOptions(
	network: ClientNetwork,
	channel: ClientChan,
	patch: Partial<
		Pick<
			ChannelTranslation,
			"write" | "writeFrom" | "formality" | "variant" | "languages" | "once" | "noSuggest"
		>
	>
): void {
	commitChannel(network, channel, setChannelTranslation(network.uuid, channel.name, patch));
}

/**
 * A line detection left alone gets a mark (`TranslationLine.vue`: the
 * language it was taken for, or "?"), so a reader can tell it from a line
 * nothing looked at, and translate it anyway from the mark's menu. A
 * translation already there or on its way is never replaced by one.
 */
function markSkipped(
	id: number,
	reason: "same" | "unsure",
	to: string,
	detection: Detection
): void {
	// "same" is the reading language or one the user also reads: the mark
	// names the language it was taken for.
	const from = reason === "same" ? detection.lang ?? to : "";

	const existing = store.state.translations[id];

	if (existing && (existing.status === "done" || existing.status === "pending")) {
		return;
	}

	store.commit("translationEntry", {
		id,
		entry: {
			status: "skipped",
			reason,
			text: "",
			from,
			to,
			candidates: detection.candidates,
			engine: null,
			error: null,
			hidden: false,
		},
	});
}

function entryFor(from: string, to: string, candidates: string[]): TranslationEntry {
	return {
		status: "pending",
		text: "",
		from,
		to,
		candidates,
		engine: null,
		error: null,
		hidden: false,
	};
}

/**
 * What `translateMessage` did with a line: `queued` (a request, or a
 * forced one), `skipped` (a mark: already readable, or unsure), `ineligible`
 * (nothing in it to read, judged once per reading) or `stale` (reading
 * changed or stopped while it was looked at; the line is as it was).
 */
export type LineOutcome = "queued" | "skipped" | "ineligible" | "stale";

/**
 * Consider one message. `force` is the toolbar's "Translate" and the chip's
 * "Retranslate": eligibility and the target check are skipped, and an
 * unknown source is left to the LLM. `replay` is the bus payload's flag: a
 * history line, which the queue runs behind the channel's live ones.
 * `from` is the chip menu's "Retranslate from …": the reader has said what
 * the line is written in, so detection is skipped entirely — the source is
 * never null, the detector's candidates are carried over so the menu keeps
 * offering the alternatives, and nothing is noted into the channel's prior
 * (one reader's correction of one line is not the channel's language).
 * However old a line is, it is considered: reading covers what the channel
 * shows, and history is bounded per load by its callers instead.
 */
export async function translateMessage(
	network: ClientNetwork,
	channel: ClientChan,
	message: ClientMessage,
	force = false,
	replay = false,
	from?: string
): Promise<LineOutcome> {
	// Switched off, nothing is looked at, a forced line included; and a line
	// of a conversation that does not read is not worth the probe below.
	if (!message.text) {
		return "ineligible";
	}

	if (!considersLine(translationOn(), readsHere(network, channel), force)) {
		return "stale";
	}

	// The service is created (and the device probe started) on first use,
	// which is often this very call: without waiting for it here, every
	// message that arrives before the probe resolves is silently dropped.
	if (!store.state.translation.capability) {
		await translateService().capabilities();
	}

	if (!translationAvailable()) {
		return "stale";
	}

	const initial = channelTranslation(network, channel);
	// Every name this line may carry, not only the user list: the sender
	// (who may have left), a query's other party, and whoever has spoken
	// here lately (names.ts `namesFor`). The same set is fenced and listed.
	// Up to this message, not to the channel's tail: the speaker window is
	// capped, and the prompt's `Names:` list is drawn from the lines just
	// before this one, so the two windows have to end at the same place or a
	// history line could be told to keep a name nothing fenced.
	// Read raw: nothing here is an effect that must track them, and a big
	// channel's user list read through the store's proxies cost about a
	// millisecond a line.
	const users = toRaw(channel.users);
	const messages = toRaw(channel.messages);
	const at = messages.findIndex((m) => m.id === message.id);
	const nicks = namesFor({
		users,
		sender: message.from?.nick,
		target: channel.name,
		messages: at >= 0 ? messages.slice(0, at + 1) : messages,
	});
	const generation = generationOf(channel.id);
	// Stripped once, and only for a line that gets that far: eligibility
	// counts its words and detection reads it (the strip runs the whole
	// Markdown layout).
	let plain: string | undefined;
	const plainText = () => (plain ??= plainTextOf(message.text ?? "", nicks));

	if (!force && !readsHere(network, channel)) {
		return "stale";
	}

	if (!force && !isEligible(message, {nicks, plain: plainText})) {
		return "ineligible";
	}

	const prior = priorFor(network, channel);
	// A chosen source is the answer detection would have given: no chunk to
	// download, no verdict to reach, and the previous entry's candidates
	// stay on offer.
	const detected = from
		? {
				lang: from,
				confidence: 1,
				candidates: store.state.translations[message.id]?.candidates ?? [],
		  }
		: await detectLanguage(plainText(), prior, initial.languages, {
				// The language the reader already reads: a lone verdict with it
				// in the running is no verdict (detect.ts `decide`). The switch
				// is re-read after the await below; this is the target as it
				// stands now, which is the one the reader is looking at.
				exclude: readingLanguage(),
				// The user's own lines say what they write, not the channel.
				learn: !message.self,
		  });
	// The sender's word for its language (`+draft/language`, irc/langtag.ts)
	// as a strong prior: it settles the short lines the detector cannot
	// place, and loses only to a verdict close to certain (detect.ts
	// `withSenderLanguage`). Not for a forced line: the toolbar's Translate
	// and the chip's Retranslate are the reader's way past a wrong tag.
	const detection = from || force ? detected : withSenderLanguage(detected, message.language);

	// Detection (the first call also awaits the identifiers' chunk) can
	// take a while: re-read the switch afterwards, since a switch-off or a
	// target change during that wait must not still ship a translation (a
	// target change queues the channel again itself), and a channel left
	// meanwhile keeps its setting but has nothing to show a translation in.
	const settings = channelTranslation(network, channel);

	// Switched off meanwhile: a forced line too (the generation test below
	// is not a forced line's).
	if (!translationOn() || !store.getters.findChannel(channel.id)) {
		return "stale";
	}

	if (!force && (!readsHere(network, channel) || generationOf(channel.id) !== generation)) {
		return "stale";
	}

	const to = readingLanguage();

	// Placed in the reading language or one the user also reads, not placed
	// at all, or placed on doubt in a language the channel is not known to
	// write: left alone (detect.ts `detectionSkip`), and the toolbar's
	// Translate still translates it.
	const skip = force ? null : detectionSkip(detection, to, alsoReadLanguages());

	if (skip) {
		markSkipped(message.id, skip, to, detection);
		return "skipped";
	}

	// What the line is translated from, whether the source is left to the
	// engine, and what the router may still be told (detect.ts `sourceFor`):
	// a chosen source as it stands, the detector's verdict, or nothing at
	// all. Unsure means the prompt says nothing about the
	// source (`context.sourceHint` is null) -- the channel's prior is no
	// better a guess, having announced a Spanish line in a German channel as
	// "probably German" -- while `routeHint` keeps the line routable.
	const {source, unsure, routeHint} = sourceFor(detection, from ?? null, to, prior.top());
	const protectedText = protect(message.text, {nicks});
	const item: QueueItem = {
		id: message.id,
		chanId: channel.id,
		text: protectedText.text,
		spans: protectedText.spans,
		meta: protectedText.meta,
		from: source,
		// Routing only, never the prompt: where the request names no source,
		// the channel's prior still steers the router, so a CPU-only device
		// can route the line to a seq2seq model instead of leaving it
		// untranslated (detect.ts `sourceFor`).
		routeHint,
		to,
		context: buildContext(channel, message, {
			translated(id) {
				const entry = store.state.translations[id];

				return entry && entry.status === "done" ? entry.text : undefined;
			},
			terms: termsFor(settings.terms, source, to),
			glossary: getBranding().translation?.glossary ?? [],
			// The channel's register, or the global one where it says "auto":
			// the same fallback the composer uses (channelStore.ts).
			formality: effectiveFormality(
				settings.formality,
				store.state.settings.translateFormality
			),
			variant: settings.variant,
			sourceHint: source ?? (unsure ? null : prior.top()),
			nicks,
		}),
		arrivalsAtEnqueue: arrivals.get(channel.id) ?? 0,
		single: force,
		// A history line waits behind the channel's live ones (queue.ts): what
		// is being said now matters more than what was said then. A forced
		// request is never history, however old the line is — someone asked.
		...(!force && replay ? {history: true as const} : {}),
	};

	items.set(message.id, {network: network.uuid, item, unsure: unsure && !force});
	store.commit("translationEntry", {
		id: message.id,
		entry: entryFor(source ?? "", to, detection.candidates),
	});

	if (force) {
		queueFor(network).retry(item);
	} else {
		queueFor(network).enqueue(item);
	}

	return "queued";
}

/**
 * Let a paused engine run again. state.translation.paused is global (one
 * engine, however many networks queue for it), so every queue resumes it.
 * Both ways back into the queue go through here: an engine pauses after
 * three failures in a row, which is exactly when a user reaches for a
 * retry, and an item queued behind a paused engine never runs.
 */
function resumePausedEngines(): void {
	const paused = store.state.translation.paused;

	if (!paused) {
		return;
	}

	for (const queue of queues.values()) {
		queue.resume(paused.engine);
	}

	store.commit("translationPaused", null);
}

/**
 * Translate one line on request: the toolbar's Translate and the chip
 * menu's Retranslate. `from` is the menu's "Retranslate from …" — the
 * source the reader chose, detection skipped.
 */
export function retranslate(
	network: ClientNetwork,
	channel: ClientChan,
	message: ClientMessage,
	from?: string
): void {
	// Toolbar hides the action while a line is pending, but no caller may double-queue a line
	if (!translationOn() || store.state.translations[message.id]?.status === "pending") {
		return;
	}

	resumePausedEngines();
	void translateMessage(network, channel, message, true, false, from);
}

export function showOriginal(id: number, hidden: boolean): void {
	store.commit("translationPatch", {id, patch: {hidden}});
}

/**
 * The source a rebuilt retry keeps: the failed line's own, never a skipped
 * mark's (a `same` mark's `from` is the reading language itself).
 */
function retrySource(entry: TranslationEntry | undefined): string | undefined {
	return entry && entry.status !== "skipped" && entry.from ? entry.from : undefined;
}

/** A failed line's retry: resumes a paused engine as well. */
export function retryTranslation(
	network: ClientNetwork,
	channel: ClientChan,
	message: ClientMessage
): void {
	if (!translationOn()) {
		return;
	}

	resumePausedEngines();
	// Someone asked for this line: a "not now" to a download is a question
	// again (consent.ts), asked once however many lines are retried.
	translateService().forgetDeclines();

	const known = items.get(message.id);

	if (known && known.network === network.uuid) {
		store.commit("translationPatch", {id: message.id, patch: {status: "pending", error: null}});
		queueFor(network).retry(known.item);
	} else {
		// The remembered item is gone, so the request is built again — with
		// the source the failed entry had, whether the detector or the reader
		// chose it: a retry is the same translation, not a fresh guess.
		retranslate(network, channel, message, retrySource(store.state.translations[message.id]));
	}
}

/**
 * Translation switched off: every queue is cancelled -- its lines dropped,
 * never failed, so nothing counts toward a pause -- and forgotten (each
 * one routes through the service that is about to go), every history run
 * and detection under way stops at its next check, and what the store
 * shows of translation goes: the translations under the messages and in
 * the topic (Message.vue restyles an original from them), the paused
 * banner, an ask for the panel. Called by the switch before the service is
 * disposed (switch.ts), so a line in flight leaves through its own queue's
 * abort. The per-channel settings (`state.translateChannels`,
 * `thelounge.translate`) are kept.
 */
function stopReading(): void {
	for (const queue of queues.values()) {
		queue.cancelAll();
	}

	queues.clear();

	for (const network of store.state.networks) {
		for (const channel of network.channels) {
			generations.set(channel.id, generationOf(channel.id) + 1);
		}
	}

	items.clear();
	considered.clear();
	firstReadPending = false;
	topicSources.clear();
	priors.clear();
	store.commit("translationRemoveMany", Object.keys(store.state.translations).map(Number));

	if (store.state.translation.paused) {
		store.commit("translationPaused", null);
	}

	if (store.state.translation.panelFor !== null) {
		store.commit("translationPanelFor", null);
	}
}

/**
 * Translation switched (back) on: the conversation on screen is read from
 * what is in view, topic included; the others when they are opened. No
 * reload. The first time on this device, a note says what changed when
 * nothing on screen needed translating (`noteFirstRead`).
 */
function resumeReading(): void {
	firstReadPending = !seenNote("firstRun");
	openOnScreen();
}

/** Read the conversation on screen, if there is one: its lines in view and its topic. */
function openOnScreen(): void {
	const shown = onScreen.current();
	const found = shown === null ? undefined : store.getters.findChannel(shown);

	if (!found || !readsHere(found.network, found.channel)) {
		if (firstReadPending && found) {
			noteFirstRead(false);
		}

		return;
	}

	scheduleScan(found.channel.id);
	void readTopic(found.network, found.channel);
}

/**
 * The conversation on screen changed: the one left stops where it stands
 * (its unfinished lines are read again when it is next on screen; its
 * finished ones stay), and the new one is read.
 */
function onConversationChange(from: number | null): void {
	if (from !== null) {
		const left = store.getters.findChannel(from);

		if (left) {
			stopChannel(left.network, left.channel);
		}
	}

	if (translationOn()) {
		openOnScreen();
	}
}

/** Device-side, one-time notes (spec § Finding it, § Existing users): not in the backup. */
export const NOTES_KEY = "thelounge.state.translateNotes";

export type TranslationNote = "firstRun" | "everywhere";

function seenNotes(): string[] {
	try {
		const parsed: unknown = JSON.parse(storage.get(NOTES_KEY) ?? "[]");

		return Array.isArray(parsed)
			? parsed.filter((n): n is string => typeof n === "string")
			: [];
	} catch {
		return [];
	}
}

function seenNote(note: TranslationNote): boolean {
	return seenNotes().includes(note);
}

/** A note was shown, or made pointless: it is not shown again on this device. */
export function markNoteSeen(note: TranslationNote): void {
	const seen = seenNotes();

	if (!seen.includes(note)) {
		try {
			storage.set(NOTES_KEY, JSON.stringify([...seen, note]));
		} catch {
			// A storage that cannot write shows the note again next time: harmless.
		}
	}
}

/** Show a note (TranslationNote.vue) unless it was seen; it is marked seen as it is shown. */
function showNote(note: TranslationNote): void {
	if (seenNote(note)) {
		return;
	}

	markNoteSeen(note);
	store.commit("translationNote", note);
}

/**
 * The first scan after switching translation on that saw the screen
 * finished: when it translated nothing, nothing visibly changed, so the
 * first-run note says what will. Either way the note is settled for this
 * device.
 */
function noteFirstRead(translatedSomething: boolean): void {
	if (!firstReadPending) {
		return;
	}

	firstReadPending = false;

	if (translatedSomething) {
		markNoteSeen("firstRun");
	} else {
		showNote("firstRun");
	}
}

export function initReader(): void {
	// Once per stored version (channelStore.ts): an older blob -- an
	// upgrade, or an old backup restored -- reads everywhere from now on,
	// and an enabled user is told so once.
	const migration = migrateChannelStore();

	store.commit("translateChannelsLoaded", loadAll());
	setTranslationUsage(translationInUse);
	onTranslationSwitch((on) => (on ? resumeReading() : stopReading()));
	// What reading starts under: the first change after boot is measured
	// against this, so it counts like any other.
	lastReadingTerms = readingTerms();

	if (migration !== "current" && translationOn()) {
		showNote("everywhere");
	}

	// The conversation on screen: the store's active channel (router.ts
	// clears it while Settings is open) in a visible page.
	onScreen.show(store.state.activeChannel?.channel.id ?? null);
	onScreen.setPageShown(document.visibilityState !== "hidden");
	watch(
		() => store.state.activeChannel?.channel.id ?? null,
		(id) => onScreen.show(id)
	);
	document.addEventListener("visibilitychange", () => {
		onScreen.setPageShown(document.visibilityState !== "hidden");
	});
	onScreen.onChange((change) => {
		if (change.kind === "conversation") {
			onConversationChange(change.from);
		} else if (change.kind === "left") {
			lineLeft(change.messageId);
		} else if (translationOn()) {
			scheduleScan(change.chanId);
		}
	});

	// After socket-events/msg.ts pushed the message (import order in
	// socket-events/index.ts): the object in `data.msg` is the one in
	// `channel.messages`, so its id is the store id.
	socket.on("msg", (data) => {
		const target = store.getters.findChannel(data.chan);

		// Switched off, the pipeline does nothing at all, not even count.
		if (!target || !translationOn()) {
			return;
		}

		// What the channel has said since a line was queued, which is how the
		// queue decides a translation has been left behind: only lines
		// someone said count, never a join, a quit or a mode.
		if (isChatLine(data.msg)) {
			arrivals.set(target.channel.id, (arrivals.get(target.channel.id) ?? 0) + 1);
		}

		// Only the conversation on screen reads as lines arrive; another one
		// reads them when it is opened. A replayed line (a reconnect's
		// catch-up, a bouncer replay) is read when it is in view, like a
		// history page: a reload of a channel that has been on for a week
		// does not queue a week.
		if (
			!readsHere(target.network, target.channel) ||
			!shownNow(target.channel) ||
			data.replay
		) {
			return;
		}

		{
			// A posted translation keeps the composer's read-back rather than
			// being translated again (sentReadBack.ts `takesReadBack`): checked
			// here, synchronously in the dispatch, so it holds whichever of
			// this listener and the writer's runs first.
			if (
				takesReadBack(
					sentReadBacks,
					target.channel.id,
					data.msg,
					false,
					// A skipped mark is no translation to keep.
					!!store.state.translations[data.msg.id] &&
						store.state.translations[data.msg.id].status !== "skipped",
					Date.now()
				)
			) {
				return;
			}

			void readLine(target.network, target.channel, data.msg, true);
		}
	});

	// A history page (`more`: the page MessageList asked for, a join's
	// first fill) is read as its lines come into view (MessageList.vue's
	// line observer, onScreen.ts), so nothing listens for it here.

	// Registered before socket-events/part.ts (import order), so the
	// channel is still in the store when this runs. The channel's setting
	// stays (channelStore and state.translateChannels): a rejoin finds
	// reading still on, in the same language, and translates the history
	// the join loads. What goes is this channel object's work: its queue,
	// counters, remembered items and the translations of its messages.
	socket.on("part", (data) => {
		const target = store.getters.findChannel(data.chan);

		if (!target) {
			return;
		}

		queues.get(target.network.uuid)?.cancelChannel(target.channel.id);
		priors.delete(channelKey(target.network.uuid, target.channel.name));
		arrivals.delete(target.channel.id);
		generations.delete(target.channel.id);
		onScreen.forget(target.channel.id);
		forgetItems(({item}) => item.chanId === target.channel.id);

		for (const m of target.channel.messages) {
			considered.delete(m.id);
		}
		store.commit(
			"translationRemoveMany",
			target.channel.messages.map((m) => m.id)
		);
		// The topic's translation is kept under its own id (topic.ts), not a
		// message's: a rejoin is a new channel id, so nothing would ever
		// show or drop this one.
		forgetTopic(target.channel.id);

		// A closed query takes its terms with it, as it does its log: they
		// are whole lines said in private. A channel's stay with its setting.
		if (target.channel.type === ChanType.QUERY) {
			const kept = forgetTerms(target.network.uuid, target.channel.name);

			if (kept) {
				store.commit("translateChannelSet", {
					key: channelKey(target.network.uuid, target.channel.name),
					value: kept,
				});
			}
		}
	});

	// Registered before socket-events/quit.ts (import order), so the
	// network and its messages are still in the store when this runs.
	socket.on("quit", (data) => {
		queues.get(data.network)?.cancelAll();
		queues.delete(data.network);
		forgetNetwork(data.network);
		forgetItems(({network}) => network === data.network);

		const network = store.state.networks.find((n) => n.uuid === data.network);

		if (network) {
			store.commit(
				"translationRemoveMany",
				network.channels.flatMap((c) => c.messages.map((m) => m.id))
			);

			for (const c of network.channels) {
				arrivals.delete(c.id);
				generations.delete(c.id);
				onScreen.forget(c.id);
				forgetTopic(c.id);

				for (const m of c.messages) {
					considered.delete(m.id);
				}
			}
		}

		for (const key of Object.keys(store.state.translateChannels)) {
			if (key.startsWith(`${data.network}/`)) {
				store.commit("translateChannelRemove", key);
			}
		}

		for (const key of [...priors.keys()]) {
			if (key.startsWith(`${data.network}/`)) {
				priors.delete(key);
			}
		}
	});
}
