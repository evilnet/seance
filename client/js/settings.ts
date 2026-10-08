import type {TypedStore} from "./store";
import {mirrorPushPrefs} from "./push-prefs";
import {normalizeFontSize} from "./helpers/fontSize";
import {normalizeOwnMessageStyle} from "./helpers/ownMessages";
import {prefersTwelveHourClock} from "./helpers/hourCycle";
import {normalizeSceneMotion, themeScene} from "./themeScene";
import {setQueryLogEnabled} from "./irc/querylog";
import {setKeepAlive} from "./helpers/keepAlive";

const defaultSettingConfig = {
	apply() {},
	default: null,
	sync: null,
};

const buildThemeColor =
	document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || "";

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
	},
	statusMessages: {
		default: "condensed",
	},
	/** A server's push identity (VAPID key) changed: ask | trust | ignore
	 * (client/js/webpush.ts, helpers/pushKeys.ts keyChangePolicy). */
	pushKeyChange: {
		default: "ask",
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
		// One-time note of the tag's build-time colour, before boot applies
		// anything: the fallback for themes that carry no colour of their own.
		apply(store: TypedStore, value: string) {
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

			if (hrefAttr.value === themeUrl) {
				return;
			}

			hrefAttr.value = themeUrl;

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
		},
	},
	// The ps theme's own settings (Settings → Appearance shows them under the
	// theme while ps is the theme). How much its scene moves: "off", "sparse"
	// (every five minutes and on coming back), "1s", "24" (frames a second) or
	// "60" (the browser's own rate) — themeScene.ts SceneMotion, the scene's
	// stepper.ts. A hidden page and reduced motion still stop it whatever this
	// says.
	psAnimation: {
		default: "24",
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
	// and keeps nothing more; applyAll runs this at boot too, before any
	// network is created, so a page with it off restores nothing.
	keepPrivateConversations: {
		default: true,
		apply(store: TypedStore, value: boolean) {
			setQueryLogEnabled(value);
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
