// The app's one TranslateService: the real worker (or the in-page fake on
// a development build opened with ?fakeTranslate), the deploy's
// config.json, the store's settings and the store's translation slice.
// Created on first use, so a page that never translates starts no worker
// and loads no model. The device probe does run once a channel shows,
// since it decides whether the translate button is offered at all -- but
// never on a deploy that switched translation off (service.ts
// `capabilities`).

import {getBranding} from "../branding";
import {BUILD} from "../build";
import {store} from "../store";
import {probeOnce} from "./capability";
import {emptyContext, type Device, type ModelRef} from "./engine";
import {TranslateClient} from "./client";
import {FAKE_CAPABILITY, fakePort} from "./fakePort";
import {buildCatalog, listedSize, nativeDevice, normalizeDeviceChoice} from "./models";
import {MainPort} from "./protocol";
import {RouteTable} from "./router";
import {ServiceDeps, ServiceSettings, TranslateService} from "./service";
import {storedConsent} from "./consent";
import eventbus from "../eventbus";
import storage from "../localStorage";
import {t} from "../i18n/core";
import friendlysize from "../helpers/friendlysize";
import {modelDisplayName} from "../helpers/translateWhy";

// Captured at module load (vue.ts imports the router, which statically
// imports Settings/Translation.vue, before `boot()` runs) rather than read
// inside useFake(): boot.ts's handleQueryParams() strips the page's query
// string on every load, and the service is created lazily, well after that
// — reading window.location.search at call time would never see the flag.
// Declared above every export so no caller, however early, can reach it
// before it is initialized.
const initialSearch = window.location.search;

let service: TranslateService | null = null;
let usage: (() => boolean) | null = null;

/**
 * What says translation is in use (reader.ts `translationInUse`): once it
 * is not and nothing is in flight, the service unloads every model at once.
 * Registered before the service exists (initReader runs at boot) and handed
 * to it when it is created.
 */
export function setTranslationUsage(inUse: () => boolean): void {
	usage = inUse;
	service?.setInUse(inUse);
}

export function translateService(): TranslateService {
	if (!service) {
		service = create();
	}

	return service;
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
	};
}

function useFake(): boolean {
	return BUILD === "dev" && new URLSearchParams(initialSearch).has("fakeTranslate");
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

/**
 * The question's title, a whole sentence per device: the model's usual
 * copy (the GPU's for the language model, the CPU's for the others) asks
 * with the plain title, the other device's names its device.
 */
function consentTitle(model: string, device: Device, usual: Device): string {
	if (device === usual) {
		return t("translate.consent.title", {model});
	}

	return device === "cpu"
		? t("translate.consent.titleCpu", {model})
		: t("translate.consent.titleGpu", {model});
}

function consentText(model: string, device: Device, usual: Device, size: string): string {
	if (device === usual) {
		return t("translate.consent.text", {model, size});
	}

	return device === "cpu"
		? t("translate.consent.textCpu", {model, size})
		: t("translate.consent.textGpu", {model, size});
}

/** The download question, in the app's confirm dialog (ConfirmDialog.vue): the copy's own size. */
function askDownload(ref: ModelRef, device: Device): Promise<boolean> {
	const model = modelDisplayName(ref);
	const sizeBytes = ref.copies[device]?.sizeBytes ?? listedSize(ref);
	const usual = nativeDevice(ref);

	return new Promise((resolve) => {
		eventbus.emit(
			"confirm-dialog",
			{
				title: consentTitle(model, device, usual),
				text: consentText(model, device, usual, friendlysize(sizeBytes)),
				note: meteredConnection() ? t("translate.consent.metered") : undefined,
				button: t("translate.model.download"),
				cancel: t("translate.consent.notNow"),
				primary: true,
			},
			(yes: boolean) => resolve(yes)
		);
	});
}

function create(): TranslateService {
	const branding = getBranding().translation ?? {};
	const fake = useFake();
	const deps: ServiceDeps = {
		createClient() {
			if (fake) {
				const {port, terminate} = fakePort();

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
		probe: () => (fake ? Promise.resolve(FAKE_CAPABILITY) : probeOnce()),
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
	}

	// An unset GPU model ("") is no choice: it resolves every time it is read
	// — the deploy's model, else what the device probe fits, else the shipped
	// default (models.ts `llmChoice`) — so a later deploy default, and a
	// device the probe has since measured, both reach everyone who never
	// picked one. Nothing writes a resolved id back to the settings.
	const selectedLlm = store.state.settings.translateLlmModel || null;
	// `seq2seqGpu` stays off whatever the deploy says (models.ts
	// CatalogOptions): this build cannot run OPUS-MT or NLLB-200 on the GPU.
	const catalog = buildCatalog({...branding, seq2seqGpu: false}, selectedLlm);
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

	// A switch or a device setting changed: the service gets the whole set.
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
			];
		},
		() => created.setSettings(serviceSettings())
	);
	// A switch takes effect at once (service.ts `setLlmModel`): the old model
	// unloads once its running requests are done, later requests route anew.
	store.watch(
		() => store.state.settings.translateLlmModel,
		(id: string) => created.setLlmModel(id)
	);

	if (usage) {
		created.setInUse(usage);
	}

	// A channel switched off, a composer strip closed: the store state the
	// usage reads is reactive, so a change asks again (a queue draining asks
	// through reader.ts).
	store.watch(
		() => (usage ? usage() : true),
		(inUse: boolean) => {
			if (!inUse) {
				created.usageChanged();
			}
		}
	);
	created.onModels((models) => store.commit("translationModels", models));
	created.onWorkerError((message) => store.commit("translationWorkerError", message));
	// The service resolves an unset choice against the probe itself once it
	// lands (service.ts `capabilities`), and the store's capability is what
	// Settings reads it through: the pick is never persisted as a choice.
	void created.capabilities().then((capability) => {
		store.commit("translationCapability", capability);
	});
	window.addEventListener("pagehide", () => created.pagehide());

	return created;
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
