<template>
	<aside class="settings-menu">
		<ul role="navigation" :aria-label="tabsAria">
			<SettingTabItem
				v-if="showNetworks"
				name="Networks"
				:label="tabNetworks"
				class-name="networks"
				to="networks"
			/>
			<SettingTabItem
				v-if="showGeneral"
				name="General"
				:label="tabGeneral"
				class-name="general"
				to=""
			/>
			<SettingTabItem
				name="Appearance"
				:label="tabAppearance"
				class-name="appearance"
				to="appearance"
			/>
			<SettingTabItem
				name="Notifications"
				:label="tabNotifications"
				class-name="notifications"
				to="notifications"
			/>
			<SettingTabItem
				name="Translation"
				:label="tabTranslation"
				class-name="translation"
				to="translation"
			/>
			<SettingTabItem name="Aliases" :label="tabAliases" class-name="aliases" to="aliases" />
		</ul>
	</aside>
</template>

<style>
/* The settings menu is a horizontal tab strip across the top of the
 * settings modal (Windows/Settings.vue): one row of icon + label tabs,
 * horizontally scrollable if it must be, the active one underlined in the
 * theme's accent. When the pane is too narrow for every label (the modal
 * is the `settings` size container), the inactive tabs drop to icons only
 * — the active tab keeps its label, so where you are is always written
 * out. */
.settings-menu {
	flex: 0 0 auto;
	width: 100%;
}

.settings-menu ul {
	display: flex;
	flex-wrap: nowrap;
	overflow-x: auto;
	scrollbar-width: none;
	margin: 0;
	padding: 0 0.75rem;
	/* An inset hairline rather than a border: the underline of the active
	 * tab paints over it. */
	box-shadow: inset 0 -1px 0 rgb(128 128 128 / 30%);
}

.settings-menu ul::-webkit-scrollbar {
	display: none;
}

.settings-menu li {
	flex: 0 0 auto;
	font-size: 1rem;
	list-style: none;
}

.settings-menu button {
	color: var(--body-color-muted);
	white-space: nowrap;
	padding: 0.55em 0.7em;
	border-bottom: 2px solid transparent;
}

/* The icon box and its gap are em: at the big scales an 18px box put the
 * glyph on top of the label. */
.settings-menu button::before {
	width: 1em;
	height: 1em;
	display: inline-block;
	content: "";
	margin-inline-end: 0.45em;
}

.settings-menu .appearance::before {
	content: "\f108"; /* http://fontawesome.io/icon/desktop/ */
}

.settings-menu .messages::before {
	content: "\f0e0"; /* http://fontawesome.io/icon/envelope/ */
}

.settings-menu .notifications::before {
	content: "\f0f3"; /* http://fontawesome.io/icon/bell/ */
}

.settings-menu .translation::before {
	content: "\f1ab"; /* https://fontawesome.com/icons/language?style=solid */
}

.settings-menu .general::before {
	content: "\f013"; /* http://fontawesome.io/icon/cog/ */
}

.settings-menu .networks::before {
	content: "\f233"; /* https://fontawesome.com/icons/server */
}

.settings-menu .aliases::before {
	content: "\f120"; /* https://fontawesome.com/icons/terminal */
}

.settings-menu button:hover,
.settings-menu button.active {
	color: var(--body-color);
}

.settings-menu button.active {
	border-bottom-color: var(--button-color);
	cursor: default;
}

/* Five labelled tabs need roughly 40rem; below that the inactive ones are
 * icons alone (their names stay as aria-label and title). */
@container settings (max-width: 41rem) {
	.settings-menu button:not(.active) .tab-label {
		display: none;
	}

	.settings-menu button:not(.active)::before {
		margin-inline-end: 0;
	}
}
</style>

<script lang="ts">
import SettingTabItem from "./SettingTabItem.vue";
import {computed, defineComponent, nextTick, onMounted, watch} from "vue";
import {useRoute} from "vue-router";
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import {brandingFeatures} from "../../js/branding";
import {shouldShowGeneralSettings} from "../../js/helpers/settingsTabs";

export default defineComponent({
	name: "SettingsTabs",
	components: {
		SettingTabItem,
	},
	setup() {
		const store = useStore();
		const route = useRoute();
		const {t} = useI18n();

		// The visible labels of the tab strip; `name` keeps the route
		// identity (SettingTabItem's active-tab detection), never these.
		const tabsAria = computed(() => t("settings.tabs.aria"));
		const tabNetworks = computed(() => t("settings.tabs.networks"));
		const tabGeneral = computed(() => t("settings.tabs.general"));
		const tabAppearance = computed(() => t("settings.tabs.appearance"));
		const tabNotifications = computed(() => t("settings.tabs.notifications"));
		const tabTranslation = computed(() => t("settings.tabs.translation"));
		const tabAliases = computed(() => t("settings.tabs.aliases"));

		// The strip scrolls, so the active tab may sit off screen (opening
		// Aliases from a deep link, or coming back to the tab the user
		// left). `nearest` makes this a no-op when nothing overflows.
		const revealActive = () => {
			void nextTick(() => {
				document
					.querySelector(".settings-menu button.active")
					?.scrollIntoView({inline: "nearest", block: "nearest"});
			});
		};

		onMounted(revealActive);
		watch(() => route.name, revealActive);

		return {
			tabsAria,
			tabNetworks,
			tabGeneral,
			tabAppearance,
			tabNotifications,
			tabTranslation,
			tabAliases,
			showGeneral: shouldShowGeneralSettings(),
			showNetworks: brandingFeatures(store.state.branding).saveNetworks,
		};
	},
});
</script>
