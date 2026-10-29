import type {TypedStore} from "./store";
import {mirrorPushPrefs} from "./push-prefs";
import {activate} from "./i18n";
import {setHour12Source} from "./i18n/dates";
import {normalizeFontSize} from "./helpers/fontSize";
import {normalizeOwnMessageStyle} from "./helpers/ownMessages";
import {normalizePsWords} from "./helpers/psWords";
import {prefersTwelveHourClock} from "./helpers/hourCycle";
import storage from "./localStorage";
import {normalizeSceneMotion, themeScene} from "./themeScene";
import {setQueryLogEnabled} from "./irc/querylog";
import {setClosedQueriesKept} from "./irc/closedQueries";
import {forgetPrivateTerms, loadAll} from "./translate/channelStore";
import {setKeepAlive} from "./helpers/keepAlive";
import {effectiveTheme} from "./helpers/themeAppearance";
import {currentPlatform, PLATFORM_DEFAULTS} from "./helpers/platformDefaults";
import {setMatchSystemTextSize} from "./helpers/systemTextSize";

const defaultSettingConfig = {
	apply() {},
	default: null,
	sync: null,
};

const buildThemeColor =
	document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || "";

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme loadTheme last applied, theme-color included. */
let appliedTheme: string | null = null;

/** Load the theme the settings ask for: the chosen one, or its light/dark
 * partner when following the system (helpers/themeAppearance.ts). */
function loadTheme(store: TypedStore): void {
	const chosen = store.state.settings.theme;

	if (!chosen) {
		return;
	}

	const value = effectiveTheme(
		chosen,
		store.state.settings.matchSystemAppearance,
		darkScheme.matches
	);

	// A theme's own scene, if it has one (client/js/themeScene.ts).
	void themeScene.setTheme(value);

	const themeEl = document.getElementById("theme");
	const themeUrl = `themes/${value}.css`;

	if (!(themeEl instanceof HTMLLinkElement)) {
		throw new Error("theme element is not a link");
	}

	const hrefAttr = themeEl.attributes.getNamedItem("href");

	if (!hrefAttr) {
		throw new Error("theme is missing href attribute");
	}

	// Nothing to do when the theme on screen is already this one: applyAll,
	// the matchSystemAppearance toggle and a mode change that leaves an
	// unpaired theme alone all land here, and rewriting theme-color each time
	// would fight anything that sets it live. The early loader
	// (loading-error-handlers.js) has usually set the href already, so the
	// first call is measured against what this function last applied, not
	// the href: the browser chrome's colour is still this function's to set.
	if (value === appliedTheme) {
		return;
	}

	if (hrefAttr.value !== themeUrl) {
		hrefAttr.value = themeUrl;
	}

	if (!store.state.serverConfiguration) {
		return;
	}

	const newTheme = store.state.serverConfiguration?.themes.filter(
		(theme) => theme.name === value
	)[0];

	const metaSelector = document.querySelector('meta[name="theme-color"]');

	if (!(metaSelector instanceof HTMLMetaElement)) {
		throw new Error("theme meta element is not a meta element");
	}

	// A theme without a colour of its own (day, morning) hands the
	// browser chrome back to the deploy: config.json's themeColor, else
	// the colour the build put in the tag.
	metaSelector.content =
		newTheme?.themeColor || store.state.branding.themeColor || buildThemeColor;
	appliedTheme = value;
}

let followingScheme = false;

/** Swap the theme live when the system's light/dark mode changes. */
function followScheme(store: TypedStore): void {
	if (followingScheme) {
		return;
	}

	followingScheme = true;
	darkScheme.addEventListener("change", () => loadTheme(store));
}

const defaultConfig = {
	advanced: {
		default: false,
	},
	autocomplete: {
		default: true,
	},
	nickPostfix: {
		default: "",
	},
	coloredNicks: {
		default: true,
	},
	highlightMessages: {
		default: true,
	},
	highlights: {
		default: "",
		sync: "always",
	},
	highlightExceptions: {
		default: "",
		sync: "always",
	},
	awayMessage: {
		default: "",
		sync: "always",
	},
	// Android shell only (Settings → General → Background connection): the
	// foreground service that keeps the connections through Doze. applyAll
	// re-applies it at every launch — quietly, the permission prompt is the
	// toggle's.
	keepConnected: {
		default: false,
		apply(store: TypedStore, value: boolean, auto?: boolean) {
			void setKeepAlive(value, auto === true);
		},
	},
	links: {
		default: true,
	},
	// Display language: "auto" (follow the browser) or a locale tag from
	// client/js/i18n/available.ts (generated). apply() resolves, lazy-loads
	// the catalog, sets <html lang>/<html dir> and mirrors the tag to the
	// push worker. Nothing renders before boot's applyAll, and the pre-paint
	// script in index.html covers the direction before that.
	locale: {
		default: "auto",
		apply(store: TypedStore, value: string) {
			void activate(value);
		},
	},
	markdown: {
		default: true,
		// Mirrored to the service worker (it cannot read localStorage) so a
		// push notification strips Markdown exactly when the page renders it;
		// applyAll runs this at boot too.
		apply(store: TypedStore, value: boolean) {
			void mirrorPushPrefs({markdown: value});
		},
	},
	motd: {
		default: true,
	},
	notification: {
		default: true,
		sync: "never",
	},
	notifyAllMessages: {
		default: false,
	},
	showSeconds: {
		default: false,
	},
	// Whichever clock the browser's locale writes times in, until the reader
	// says otherwise: en-US opens on "3:04 PM", de-DE on "15:04". Asked once,
	// at load; a stored setting is assigned over it (store-settings.ts).
	use12hClock: {
		default: prefersTwelveHourClock(),
		// Every timestamp that names no clock (tooltips, ban lists, whois, the
		// oper cards) reads this one through the getter, reactively.
		apply(store: TypedStore) {
			setHour12Source(() => !!store.state.settings.use12hClock);
		},
	},
	statusMessages: {
		default: "condensed",
	},
	/** A server's push identity (VAPID key) changed: ask | trust | ignore
	 * (client/js/webpush.ts, helpers/pushKeys.ts keyChangePolicy). */
	pushKeyChange: {
		default: "ask",
	},
	/**
	 * Translation (client/js/translate): one language everywhere — the
	 * interface's and the reading target's (the unified control; the
	 * Settings → Translation select and the dev sidebar globe both write
	 * this). "auto" resolves from the browser. reader.ts
	 * `readingLanguage()` reads it through `userLanguageRef`.
	 */
	/** auto | formal | casual, one line of the prompt. */
	translateFormality: {
		default: "auto",
	},
	/** Let the router pick the GPU model / the CPU models. */
	translateLlm: {
		default: true,
	},
	translateCpu: {
		default: true,
	},
	/** NLLB-200 (translate/models.ts). Off until the
	 * user switches it on, for new and existing users alike: its licence is
	 * CC-BY-NC-4.0 (non-commercial use only), so a stored settings object
	 * that never chose (one saved before the setting existed) reads as off.
	 * The OPUS-MT pairs and the language model serve without it. */
	translateNllb: {
		default: false,
	},
	/** Which device each model runs on: auto | gpu | cpu (translate/models.ts `DeviceChoices`). */
	translateLlmDevice: {
		default: "auto",
	},
	translateOpusDevice: {
		default: "auto",
	},
	translateNllbDevice: {
		default: "auto",
	},
	/** Which GPU model (translate/models.ts LLM_CHOICES, or the deploy's own) the
	 * LLM candidate runs. "" until the user picks one, and a stored id that is no
	 * longer a choice counts as unset: both resolve at read time (models.ts
	 * `llmChoice`) to the deploy's own model, else — on a gpu-tier device — the
	 * one its memory fits (`defaultLlmForAdapter`), else the catalog's default.
	 * Nothing writes a resolved id back here, so a later deploy default, and a
	 * device the probe has since measured, both still reach users who never
	 * chose. */
	translateLlmModel: {
		default: "",
	},
	// UI scale: the root font size everything in style.css is sized off in
	// rem. The scale and its normalization live in helpers/fontSize.ts; the
	// values live in style.css, keyed off <html data-font-size="...">, so
	// themes and the custom stylesheet can override them.
	fontSize: {
		default: "large",
		apply(store: TypedStore, value: string) {
			document.documentElement.dataset.fontSize = normalizeFontSize(value);
		},
	},
	// In the native shells the system's text size (iOS Text Size, Android's
	// Font size) stands in for the step above, live; off, the step applies as
	// on the web (helpers/systemTextSize.ts). On by default there: Apple's and
	// Google's guidelines both ask an app to follow the system's size.
	matchSystemTextSize: {
		default: PLATFORM_DEFAULTS.matchSystemTextSize(currentPlatform()),
		apply(store: TypedStore, value: boolean) {
			setMatchSystemTextSize(value);
		},
	},
	// How own messages stand out: greyed text (TheLounge's look), a band, or
	// nothing. Applied as <html data-own-messages="...">; the looks are in
	// style.css so every theme gets all three (helpers/ownMessages.ts).
	ownMessages: {
		default: "muted",
		apply(store: TypedStore, value: string) {
			document.documentElement.dataset.ownMessages = normalizeOwnMessageStyle(value);
		},
	},
	theme: {
		default: document.getElementById("theme")?.dataset.serverTheme,
		apply(store: TypedStore) {
			loadTheme(store);
			followScheme(store);
		},
	},
	// A theme that comes as a light/dark pair follows the system's mode:
	// coffee becomes creama in light mode and back (helpers/themeAppearance.ts).
	// On by default in the native shell, where Apple's guidelines ask an app
	// to honour the system setting; off on the web, where a browser's theme
	// stays the one picked.
	matchSystemAppearance: {
		default: PLATFORM_DEFAULTS.matchSystemAppearance(currentPlatform()),
		apply(store: TypedStore) {
			loadTheme(store);
		},
	},
	// The ps theme's own settings (Settings → Appearance shows them under the
	// theme while ps is the theme). How much its scene moves: "auto" (follows the
	// device), "full", "calm" or "still" — themeScene.ts SceneMotion, the
	// scene's psng/tiers.ts. A hidden page and reduced motion still stop it whatever this
	// says.
	psAnimation: {
		default: "auto",
		apply(store: TypedStore, value: string) {
			themeScene.setMotion(normalizeSceneMotion(value));
		},
	},
	// Whether the ps scene rests on a window nobody attends to (themeScene.ts
	// createAttention: 15 s without the focus, 2 minutes without input).
	psPauseWhenAway: {
		default: true,
		apply(store: TypedStore, value: boolean) {
			themeScene.setPauseWhenAway(value !== false);
		},
	},
	// Whether the ps theme combines a run of one sender's lines under one nick
	// and time (MessageList.vue, helpers/messageRuns.ts).
	psGroupMessages: {
		default: true,
	},
	// Which treatment the words in the message column get over the plains
	// (helpers/psWords.ts; ps.css reads html[data-ps-words], a missing
	// attribute is Bubbles). Reflected like fontSize and ownMessages.
	psWords: {
		default: "bubbles",
		apply(store: TypedStore, value: string) {
			document.documentElement.dataset.psWords = normalizePsWords(value);
		},
	},
	media: {
		default: true,
	},
	// "click": media previews show a placeholder until the reader reveals them
	// (or trusts the host, helpers/mediaTrust.ts); "always": load at once.
	mediaReveal: {
		default: "click",
	},
	uploadCanvas: {
		default: true,
	},
	// Report own input activity as `+typing` TAGMSGs (IRCv3 typing client tag).
	sendTypingNotifications: {
		default: true,
	},
	// Keep the recent lines of private conversations in this browser so they
	// come back after a reload (irc/querylog.ts). Off deletes what is kept
	// (the translation terms learnt in queries included) and keeps nothing
	// more; applyAll runs this at boot too, before any
	// network is created, so a page with it off restores nothing.
	keepPrivateConversations: {
		default: true,
		apply(store: TypedStore, value: boolean) {
			setQueryLogEnabled(value);
			setClosedQueriesKept(value); // the closed ones' names too, here and shared

			// And the translation terms learnt in queries: whole short lines
			// the user sent in private (translate/writer.ts records none
			// while this is off). The store's copy is what prompts read.
			if (!value && forgetPrivateTerms()) {
				store.commit("translateChannelsLoaded", loadAll());
			}
		},
	},
	userStyles: {
		default: "",
		apply(store: TypedStore, value: string) {
			if (!/[?&]nocss/.test(window.location.search)) {
				const element = document.getElementById("user-specified-css");

				if (element) {
					element.innerHTML = value;
				}
			}
		},
	},
	// Search is local (client/js/search.ts) and always available.
	searchEnabled: {
		default: true,
	},
};

export const config = normalizeConfig(defaultConfig);

export function createState() {
	const state = {};

	for (const settingName in config) {
		state[settingName] = config[settingName].default;
	}

	return state;
}

function normalizeConfig(obj: any) {
	const newConfig: Partial<typeof defaultConfig> = {};

	for (const settingName in obj) {
		newConfig[settingName] = {...defaultSettingConfig, ...obj[settingName]};
	}

	return newConfig as typeof defaultConfig;
}

// flatten to type of default
export type SettingsState = {
	[key in keyof typeof defaultConfig]: typeof defaultConfig[key]["default"];
};

/**
 * One-time migration for the removed "Read messages in" override
 * (`translateTo`): the interface language and the reading language are one
 * control now, so a user who had pinned a reading override keeps it as their
 * interface language — unless they had already picked one, which wins. The
 * old key is deleted either way, before the settings store's first write can
 * drop it silently. No-op when the override was "auto" or absent.
 */
export function migrateReadingToLocale(): void {
	let raw: string | null;

	try {
		raw = storage.get("settings");
	} catch {
		return;
	}

	let stored: Record<string, unknown>;

	try {
		stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return; // garbage settings blob: leave it alone
	}

	const override = stored.translateTo;

	if (typeof override !== "string" || override === "auto") {
		return;
	}

	if (stored.locale === undefined || stored.locale === "auto") {
		stored.locale = override;
	}

	delete stored.translateTo;
	storage.set("settings", JSON.stringify(stored));
}
