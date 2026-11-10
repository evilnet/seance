// The app's one TranslateService: the real worker (or the in-page fake on
// a development build opened with ?fakeTranslate), the deploy's
// config.json, the store's settings and the store's translation slice.
// Created on first use, so a page that never translates starts no worker
// and loads no model. The device probe does run once a channel shows,
// since it decides whether the translate button is offered at all -- but
// only while translation is on: switched off (the user's
// `translationEnabled`, off by default, or the deploy's
// `translation.enabled`; switch.ts `translationAllowed`) there is no
// service at all, and switching it off takes an existing one down at once
// (switch.ts `TranslationSwitch`).

import {shallowRef} from "vue";
import {getBranding} from "../branding";
import {BUILD} from "../build";
import {store} from "../store";
import {IsolationMirror, type IsolationMessage} from "../isolationFlag";
import {serviceWorkerCanServe} from "../pwa";
import {type Capability, probeOnce} from "./capability";
import {emptyContext, type Device, type ModelRef} from "./engine";
import {TranslateClient} from "./client";
import {type ModelCatalog, buildCatalog, listedSize, normalizeDeviceChoice} from "./models";
import {APPLE_PLUGIN, AppleTranslator} from "./engines/apple";
import {hasAppleTranslate, nativeInvoke} from "../helpers/shell";
import type {MainPort, MainToWorker} from "./protocol";
import {RouteTable, normalizePreference} from "./router";
import {
	CpuFallbackAnswer,
	CpuFallbackInfo,
	ServiceDeps,
	ServiceSettings,
	TranslateService,
} from "./service";
import {type DownloadAbout, REMOVED_KEY, storedConsent} from "./consent";
import {languageName} from "./languages";
// A cycle (reader.ts imports this module), read only at call time.
import {readingLanguage} from "./reader";
import {TranslationSwitch, translationAllowed} from "./switch";
import eventbus from "../eventbus";
import storage from "../localStorage";
import {KEEP, t} from "../i18n/core";
import friendlysize from "../helpers/friendlysize";
import {modelDisplayName} from "../helpers/translateWhy";
import {clearPacks, notePack, takePack} from "./applePacks";
import {runDetached} from "../helpers/detachedScope";

// Captured at module load (vue.ts imports the router, which statically
// imports Settings/Translation.vue, before `boot()` runs) rather than read
// inside useFake(): boot.ts's handleQueryParams() strips the page's query
// string on every load, and the service is created lazily, well after that
// — reading window.location.search at call time would never see the flag.
// Declared above every export so no caller, however early, can reach it
// before it is initialized.
const initialSearch = window.location.search;

let usage: (() => boolean) | null = null;

/** What `translateService()` throws while translation is off: a call no gate stopped. */
export const TRANSLATION_OFF = "translation is switched off";

/**
 * Whether translation is on: the deploy allows it and the user switched it
 * on (switch.ts `translationAllowed`). Reactive -- both are store state --
 * so a component's computed and a store watch follow it; every surface asks
 * this before it renders anything of translation, and every path of the
 * pipeline before it does any work.
 */
export function translationOn(): boolean {
	return translationAllowed(
		store.state.branding.translation,
		store.state.settings.translationEnabled
	);
}

/** A made service and what `create()` registered for it, undone together. */
interface Made {
	service: TranslateService;
	undo: (() => void)[];
	/** The system translator the service routes to first (the iOS shell's); null everywhere else. */
	apple: AppleTranslator | null;
}

const gate = new TranslationSwitch<Made>({
	on: translationOn,
	// Made by whatever asks first, often a component's computed (Chat.vue's
	// `translationAvailable`): in a scope of its own, or every watch
	// create() registers would stop when that component unmounts (Settings
	// opening closes the chat) and the service would never hear a switch.
	create() {
		const {value: made, stop} = runDetached(create);

		made.undo.push(stop);
		return made;
	},
	destroy(made) {
		for (const undo of made.undo) {
			undo();
		}

		made.service.dispose();
	},
});

/**
 * What says translation is in use (reader.ts `translationInUse`): once it
 * is not and nothing is in flight, the service unloads every model at once.
 * Registered before the service exists (initReader runs at boot) and handed
 * to it when it is created.
 */
export function setTranslationUsage(inUse: () => boolean): void {
	usage = inUse;
	gate.current()?.service.setInUse(inUse);
}

/**
 * The service, made on the first call while translation is on. Off, it
 * throws (TRANSLATION_OFF): every caller is behind `translationOn()`, and a
 * call that is not is a bug that would otherwise probe the GPU or start
 * the worker of a feature the user switched off.
 */
export function translateService(): TranslateService {
	const made = gate.service();

	if (!made) {
		throw new Error(TRANSLATION_OFF);
	}

	return made.service;
}

/**
 * The system translator the service routes to first (the iOS shell's), for
 * Settings to ask about its packs: made with the service, so it is null
 * while translation is off -- never a reason to make one -- and everywhere
 * but the iOS shell.
 */
export function systemTranslator(): AppleTranslator | null {
	if (!translationOn()) {
		return null;
	}

	return gate.service()?.apple ?? null;
}

/** The service if one is running; never makes one (a queue's update, the usage check). */
export function activeService(): TranslateService | null {
	return gate.current()?.service ?? null;
}

/**
 * Hear translation being switched on or off. Off is heard before the
 * service is disposed (switch.ts): the reader and the composer stop their
 * work on it while it still stands.
 */
export function onTranslationSwitch(listener: (on: boolean) => void): () => void {
	return gate.onChange(listener);
}

// The setting (or, at boot, the branding) moved: act on it now rather than
// at the next ask, so a switch-off takes the worker and the GPU down at
// once even on a page where nothing asks again.
store.watch(translationOn, () => gate.sync());

/**
 * Whether the root service worker meant to isolate this document when it
 * served it (isolationFlag.ts `IsolationMirror.served`): the CPU threads
 * line says "Reload" when it did not and translation is on now
 * (threads.ts `isolationState`). Until the flag is read, the setting this
 * page loaded with, which is what the flag mirrors.
 */
const servedIsolation = shallowRef(false);

let isolationMirror: IsolationMirror | null = null;

/** reader.ts `isolationEnv`'s `servedIsolating`; reactive. */
export function servedIsolating(): boolean {
	return servedIsolation.value;
}

/** Tell the worker, whichever of it is there: the page's controller, or the
 * active worker once registered (a first load has no controller yet). */
function postToWorker(message: IsolationMessage): void {
	const controller = navigator.serviceWorker.controller;

	controller?.postMessage(message);
	navigator.serviceWorker.ready.then(
		(registration) => {
			if (registration.active && registration.active !== controller) {
				registration.active.postMessage(message);
			}
		},
		() => undefined
	);
}

/**
 * Keep the worker's isolation flag on translation (isolationFlag.ts): the
 * app's documents are cross-origin isolated only while translation is on,
 * from the load after it was switched on. Called once from boot, after the
 * branding and the stored settings; nothing where no worker ever serves the
 * page (plain http, the native shells).
 */
export function startIsolationMirror(): void {
	if (isolationMirror || !serviceWorkerCanServe()) {
		return;
	}

	const mirror = new IsolationMirror(postToWorker);

	isolationMirror = mirror;
	servedIsolation.value = translationOn();
	void mirror.served.then((served) => {
		if (served !== null) {
			servedIsolation.value = served;
		}
	});
	store.watch(translationOn, (on: boolean) => void mirror.set(on), {immediate: true});
}

/**
 * The store's engine switches and device settings, as the service and the
 * router read them: a stored device value that is none of the three (an
 * older backup, a hand edit) reads as Auto.
 */
export function serviceSettings(): ServiceSettings {
	const settings = store.state.settings;

	return {
		switches: {
			llm: !!settings.translateLlm,
			opus: !!settings.translateCpu,
			nllb: !!settings.translateNllb,
		},
		devices: {
			llm: normalizeDeviceChoice(settings.translateLlmDevice),
			opus: normalizeDeviceChoice(settings.translateOpusDevice),
			nllb: normalizeDeviceChoice(settings.translateNllbDevice),
		},
		system: settings.translateSystem !== false,
		prefer: normalizePreference(settings.translatePrefer),
	};
}

function useFake(): boolean {
	return BUILD === "dev" && new URLSearchParams(initialSearch).has("fakeTranslate");
}

/**
 * The in-page fake (fakePort.ts), loaded with import() inside a branch the
 * build's NODE_ENV define folds away: a production build has neither the
 * module nor a chunk for it (test/tests/build.ts). Asked only when
 * `useFake()` said yes, on a development build.
 */
function loadFake(): Promise<typeof import("./fakePort")> {
	if (process.env.NODE_ENV !== "production") {
		return import("./fakePort");
	}

	return Promise.reject(new Error("the fake translation engine is a development build's"));
}

/**
 * The fake's port before the fake has loaded: the service makes its client
 * synchronously, so what the client posts meanwhile waits here and is
 * handed over, in order, once the module is in; a terminate that comes
 * first stops the fake as soon as it arrives.
 */
function deferredFakePort(): {port: MainPort; terminate: () => void} {
	const waiting: MainToWorker[] = [];
	let real: MainPort | null = null;
	let stopReal: (() => void) | null = null;
	let terminated = false;
	const port: MainPort = {
		onmessage: null,
		postMessage(message) {
			if (real) {
				real.postMessage(message);
			} else if (!terminated) {
				waiting.push(message);
			}
		},
	};

	void loadFake().then(({fakePort}) => {
		const fake = fakePort();

		if (terminated) {
			fake.terminate();
			return;
		}

		real = fake.port;
		stopReal = fake.terminate;
		real.onmessage = (event) => port.onmessage?.(event);

		for (const message of waiting.splice(0)) {
			real.postMessage(message);
		}
	});

	return {
		port,
		terminate() {
			terminated = true;
			waiting.length = 0;
			stopReal?.();
		},
	};
}

function workerUrl(): string {
	return new URL(`js/translate-worker.js?v=${BUILD}`, document.baseURI).href;
}

/**
 * Whether the connection says it is metered: Save-Data, or a cellular
 * link (`navigator.connection`, Chromium only; elsewhere it says nothing).
 */
function meteredConnection(): boolean {
	const connection = (navigator as Navigator & {connection?: {saveData?: boolean; type?: string}})
		.connection;

	return !!connection && (connection.saveData === true || connection.type === "cellular");
}

/** The remembered GPU loss (service.ts `ServiceDeps.gpuMemory`). */
const GPU_LOST_KEY = "thelounge.state.translateGpuLost";

/**
 * The language a download is for, in the question's plain words: the side
 * of the pair that is not the user's reading language (a line read from
 * Finnish, a message written into it), or null where that cannot be told
 * (a request with no source, a same-language cleanup pass).
 */
function downloadLanguage(about: DownloadAbout | undefined): string | null {
	if (!about) {
		return null;
	}

	const reading = readingLanguage();
	const foreign = about.to === reading ? about.from ?? about.hint : about.to;

	return foreign && foreign !== reading ? foreign : null;
}

/**
 * The download question, in the app's confirm dialog (ConfirmDialog.vue): the
 * copy's own size. It waits behind any dialog that is up (`wait`), and one
 * the user opens over it sends it back to wait: a question displaced and
 * answered no would be a session's "Not now" to downloads.
 */
function askDownload(ref: ModelRef, device: Device, about?: DownloadAbout): Promise<boolean> {
	// Switched off since the request was routed: nobody is asked (the
	// disposed service routes nothing after the answer either).
	if (!translationOn()) {
		return Promise.resolve(false);
	}

	const sizeBytes = ref.copies[device]?.sizeBytes ?? listedSize(ref);
	const size = friendlysize(sizeBytes);
	const code = downloadLanguage(about);
	const language = code ? languageName(code, readingLanguage()) : null;

	return new Promise((resolve) => {
		eventbus.emit(
			"confirm-dialog",
			{
				// Plain words, no model and no device: what the download is
				// for and how big it is (Settings' Advanced names the model).
				title: t("translate.consent.titlePlain"),
				text: language
					? t("translate.consent.textLanguage", {language, size})
					: t("translate.consent.textPlain", {size}),
				// The language model on the processor: Auto takes it only
				// where the GPU cannot run it (models.ts `deviceOrder`), and
				// a line there takes a while.
				note:
					[
						ref.family === "llm" && device === "cpu"
							? t("translate.consent.slowCpu")
							: "",
						meteredConnection() ? t("translate.consent.metered") : "",
					]
						.filter(Boolean)
						.join(" ") || undefined,
				button: t("translate.model.download"),
				cancel: t("translate.consent.notNow"),
				primary: true,
				wait: true,
			},
			(yes: boolean) => resolve(yes)
		);
	});
}

/**
 * The language model stopped on the GPU (service.ts `askCpuFallback`): carry
 * on on the CPU this time, always, or not now. A whole sentence with the
 * download and one without; the browser's reason, when the loss carried
 * one, quoted verbatim under it.
 */
function askCpuFallback(ref: ModelRef, info: CpuFallbackInfo): Promise<CpuFallbackAnswer> {
	if (!translationOn()) {
		return Promise.resolve("no");
	}

	const model = modelDisplayName(ref);

	return new Promise((resolve) => {
		eventbus.emit(
			"confirm-dialog",
			{
				title: t("translate.gpuFallback.title"),
				text: info.cached
					? t("translate.gpuFallback.textCached", {model})
					: t("translate.gpuFallback.text", {model, size: friendlysize(info.sizeBytes)}),
				quote: info.reason
					? {
							frame: t("translate.gpuFallback.reason", {reason: KEEP}),
							reason: info.reason,
					  }
					: undefined,
				button: t("translate.gpuFallback.once"),
				alt: t("translate.gpuFallback.always"),
				cancel: t("translate.consent.notNow"),
				primary: true,
				// Behind any dialog that is up, and back to waiting under one
				// the user opens (ConfirmDialog.vue): displaced, it would be a
				// session's "Not now".
				wait: true,
			},
			(yes: boolean, always?: boolean) => resolve(!yes ? "no" : always ? "always" : "once")
		);
	});
}

/**
 * The GPU model the user picked, or null. An unset one ("") is no choice: it
 * resolves every time it is read — the deploy's model, else what the device
 * probe fits, else the shipped default (models.ts `llmChoice`) — so a later
 * deploy default, and a device the probe has since measured, both reach
 * everyone who never picked one. Nothing writes a resolved id back to the
 * settings.
 */
function selectedLlmSetting(): string | null {
	return store.state.settings.translateLlmModel || null;
}

/**
 * The catalog this deploy and the settings make, as the service is created
 * with it; also what a reason's words read while there is no service
 * (reader.ts `liveCatalog`), so naming a model never makes one. Reactive
 * through the store reads. `seq2seqGpu` stays off whatever the deploy says
 * (models.ts CatalogOptions): this build cannot run OPUS-MT or NLLB-200 on
 * the GPU.
 */
export function configuredCatalog(): ModelCatalog {
	const branding = getBranding().translation ?? {};

	return buildCatalog({...branding, seq2seqGpu: false}, selectedLlmSetting());
}

function create(): Made {
	const branding = getBranding().translation ?? {};
	const undo: (() => void)[] = [];
	const fake = useFake();
	const deps: ServiceDeps = {
		createClient() {
			if (fake) {
				const {port, terminate} = deferredFakePort();

				return {client: new TranslateClient(port), terminate};
			}

			const worker = new Worker(workerUrl());
			const client = new TranslateClient(worker as unknown as MainPort);

			// A script that will not load (a 404, a CSP) or a throw at its top
			// level is an `error` here and nothing else: without this every
			// request waited on a worker that would never answer.
			worker.addEventListener("error", (event) => {
				client.workerError((event as Partial<ErrorEvent>).message ?? "");
			});

			return {client, terminate: () => worker.terminate()};
		},
		probe: (): Promise<Capability> =>
			fake ? loadFake().then(({FAKE_CAPABILITY}) => FAKE_CAPABILITY) : probeOnce(),
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};

	// The question before a download nobody started by name (consent.ts):
	// the app's confirm dialog, Download / Not now. The in-page fake asks
	// only when the page was opened with ?askDownloads too, so the fake's
	// scenarios that are not about it run unasked.
	if (!fake || new URLSearchParams(initialSearch).has("askDownloads")) {
		deps.askDownload = askDownload;
		deps.consent = storedConsent(storage);
		deps.removed = storedConsent(storage, REMOVED_KEY);
	}

	// The GPU stopped under Auto: ask about the CPU. "Always" is the
	// setting, so Settings shows it and the backup carries it.
	deps.askCpuFallback = askCpuFallback;

	// A GPU this device lost under a translation stays off across reloads
	// until Settings' "Try the GPU again" (service.ts `retryGpu`). Not in
	// the fake's runs, whose scenarios lose the GPU on purpose.
	if (!fake) {
		deps.gpuMemory = {
			lost: () => storage.get(GPU_LOST_KEY) === "1",
			remember: () => storage.set(GPU_LOST_KEY, "1"),
			forget: () => storage.remove(GPU_LOST_KEY),
		};
	}

	deps.saveLlmDevice = (device) => {
		void store.dispatch("settings/update", {
			name: "translateLlmDevice",
			value: device,
			sync: true,
		});
	};

	// The system translator: the AppleTranslate plugin of the iOS and macOS
	// shells (shells/tauri/src-tauri/swift/Sources/SeanceTranslate), on this
	// thread, since the worker has no bridge. Nowhere else.
	const apple =
		!fake && hasAppleTranslate()
			? new AppleTranslator({
					invoke: (method, options) => nativeInvoke(APPLE_PLUGIN, method, options),
			  })
			: null;

	if (apple) {
		deps.apple = apple;
		// Reading never opens the sheet: the line offers the pack.
		deps.onApplePack = notePack;
		// Installed (from a line, Settings or the system): no line offers it.
		deps.onApplePackInstalled = takePack;
	}

	// A download is quiet only on a connection that does not say it is metered.
	deps.metered = meteredConnection;

	const selectedLlm = selectedLlmSetting();
	const catalog = configuredCatalog();
	const created = new TranslateService(
		deps,
		{
			catalog,
			selectedLlm,
			routes: (branding.routes ?? {}) as RouteTable,
			ortBase: new URL("js/ort/", document.baseURI).href,
			enabled: branding.enabled !== false,
		},
		serviceSettings()
	);

	// The packs offered on lines belong to this service's page load.
	undo.push(clearPacks);

	// A switch or a device setting changed: the service gets the whole set.
	// Every watch and listener registered here is undone with the service
	// (the gate's `destroy`), so a switched-off translation leaves none.
	undo.push(
		store.watch(
			() => {
				const {switches, devices} = serviceSettings();

				return [
					switches.llm,
					switches.opus,
					switches.nllb,
					devices.llm,
					devices.opus,
					devices.nllb,
					store.state.settings.translateSystem !== false,
					normalizePreference(store.state.settings.translatePrefer),
				];
			},
			() => created.setSettings(serviceSettings())
		)
	);
	// A switch takes effect at once (service.ts `setLlmModel`): the old model
	// unloads once its running requests are done, later requests route anew.
	undo.push(
		store.watch(
			() => store.state.settings.translateLlmModel,
			(id: string) => created.setLlmModel(id)
		)
	);

	if (usage) {
		created.setInUse(usage);
	}

	// A channel switched off, a composer strip closed: the store state the
	// usage reads is reactive, so a change asks again (a queue draining asks
	// through reader.ts).
	undo.push(
		store.watch(
			() => (usage ? usage() : true),
			(inUse: boolean) => {
				if (!inUse) {
					created.usageChanged();
				}
			}
		)
	);
	created.onModels((models) => store.commit("translationModels", models));
	created.onWorkerError((message) => store.commit("translationWorkerError", message));
	// The service resolves an unset choice against the probe itself once it
	// lands (service.ts `capabilities`), and the store's capability is what
	// Settings reads it through: the pick is never persisted as a choice.
	void created.capabilities().then((capability) => {
		store.commit("translationCapability", capability);
	});

	const onPagehide = () => created.pagehide();

	window.addEventListener("pagehide", onPagehide);
	undo.push(() => window.removeEventListener("pagehide", onPagehide));

	return {service: created, undo, apple};
}

// Development aid until plan 2 wires the channel switch: from the console,
// `await seanceTranslate("Hallo Welt", "en", "de")` returns the translation;
// pass `console.log` as the fourth argument to watch it stream. `from` null
// leaves the source to the LLM (the seq2seq engines need it).
if (BUILD === "dev") {
	(window as unknown as {seanceTranslate: unknown}).seanceTranslate = async (
		text: string,
		to: string,
		from: string | null = null,
		onChunk: (text: string, done: boolean) => void = () => {}
	): Promise<string> => {
		let last = "";

		for await (const chunk of translateService().translate({
			text,
			from,
			to,
			purpose: "read",
			context: emptyContext(),
		})) {
			last = chunk.text;
			onChunk(chunk.text, chunk.done);
		}

		return last;
	};
}
