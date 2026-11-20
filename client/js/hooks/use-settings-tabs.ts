import {computed, type ComputedRef} from "vue";
import {useRoute} from "vue-router";
import {useI18n} from "../i18n";
import {useStore} from "../store";
import {brandingFeatures} from "../branding";
import {settingsTabFor, shouldShowGeneralSettings} from "../helpers/settingsTabs";
import {translationOn} from "../translate";

export interface SettingsTab {
	/** The route name, and the tab's identity; never the label. */
	name: string;
	/** What the tab strip (and, on a narrow pane, the title) calls it. */
	label: string;
	/** The tab button's class: its icon, and the hook scenarios click. */
	className: string;
	/** The path under /settings/. */
	to: string;
}

/**
 * The Settings modal's tabs, in strip order, labelled in the interface
 * language, and the one the current route belongs to. One list for the tab
 * strip (Settings/Navigation.vue) and the title above it
 * (Windows/Settings.vue), which names the open tab while the strip shows
 * icons alone.
 */
export function useSettingsTabs(): {
	tabs: ComputedRef<SettingsTab[]>;
	active: ComputedRef<SettingsTab | undefined>;
} {
	const store = useStore();
	const route = useRoute();
	const {t} = useI18n();
	const features = brandingFeatures(store.state.branding);
	// A sign-in deploy that locks its network shows an Account page there
	// instead (Settings/Account.vue); the route stays Networks.
	const showNetworks = features.saveNetworks || !features.editNetworks;
	const showGeneral = shouldShowGeneralSettings();

	const tabs = computed<SettingsTab[]>(() => {
		const list: SettingsTab[] = [];

		if (showNetworks) {
			list.push({
				name: "Networks",
				label: features.editNetworks
					? t("settings.tabs.networks")
					: t("settings.tabs.account"),
				className: "networks",
				to: "networks",
			});
		}

		if (showGeneral) {
			list.push({
				name: "General",
				label: t("settings.tabs.general"),
				className: "general",
				to: "",
			});
		}

		list.push(
			{
				name: "Appearance",
				label: t("settings.tabs.appearance"),
				className: "appearance",
				to: "appearance",
			},
			{
				name: "Notifications",
				label: t("settings.tabs.notifications"),
				className: "notifications",
				to: "notifications",
			},
			{
				// The tab holds the interface language alone (and, where the
				// deploy allows translation, its switch) while translation is
				// off: it is named for what it holds then. Route, path and
				// class stay "translation", so a link or a scenario finds it
				// either way.
				name: "Translation",
				label: translationOn()
					? t("settings.tabs.translation")
					: t("settings.tabs.language"),
				className: "translation",
				to: "translation",
			},
			{
				// Aliases live here too, as the list's first row
				// (Settings/Scripts.vue).
				name: "Scripts",
				label: t("settings.tabs.scripts"),
				className: "scripts",
				to: "scripts",
			}
		);

		return list;
	});

	const active = computed(() => {
		const name = settingsTabFor(route);
		return tabs.value.find((tab) => tab.name === name);
	});

	return {tabs, active};
}
