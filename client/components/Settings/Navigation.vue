<template>
	<aside class="settings-menu">
		<ul role="navigation" :aria-label="tabsAria">
			<SettingTabItem
				v-for="tab in tabs"
				:key="tab.name"
				:name="tab.name"
				:label="tab.label"
				:class-name="tab.className"
				:to="tab.to"
			/>
		</ul>
	</aside>
</template>

<style>
/* The settings menu is a tab strip across the top of the settings modal
 * (Windows/Settings.vue): icon + label tabs, the active one underlined in
 * the theme's accent. When the pane is too narrow for every label (the
 * modal is the `settings` size container), every tab drops to its icon and
 * the modal's title names the open one ("Settings › Appearance"). Tabs that
 * still do not fit (the big text sizes on a phone) wrap onto another row:
 * a strip that scrolled sideways hid them past the edge with nothing to
 * say they were there. */
.settings-menu {
	flex: 0 0 auto;
	width: 100%;
}

.settings-menu ul {
	display: flex;
	flex-wrap: wrap;
	margin: 0;
	padding: 0 0.75rem;
	/* An inset hairline rather than a border: the underline of the active
	 * tab paints over it. */
	box-shadow: inset 0 -1px 0 rgb(128 128 128 / 30%);
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

.settings-menu .scripts::before {
	content: "\f121"; /* https://fontawesome.com/icons/code */
}

.settings-menu button:hover,
.settings-menu button.active {
	color: var(--body-color);
}

.settings-menu button.active {
	border-bottom-color: var(--button-color);
	cursor: default;
}

/* Six labelled tabs need roughly 45rem; below that every tab is its icon
 * alone (the names stay as aria-label and title, and the modal's title
 * names the open tab). */
@container settings (max-width: 46rem) {
	.settings-menu button .tab-label {
		display: none;
	}

	.settings-menu button::before {
		margin-inline-end: 0;
	}
}
</style>

<script lang="ts">
import SettingTabItem from "./SettingTabItem.vue";
import {computed, defineComponent} from "vue";
import {useI18n} from "../../js/i18n";
import {useSettingsTabs} from "../../js/hooks/use-settings-tabs";

export default defineComponent({
	name: "SettingsTabs",
	components: {
		SettingTabItem,
	},
	setup() {
		const {t} = useI18n();
		// The labels are the tabs' visible names; `name` keeps the route
		// identity (SettingTabItem's active-tab detection), never these.
		const {tabs} = useSettingsTabs();
		const tabsAria = computed(() => t("settings.tabs.aria"));

		return {
			tabsAria,
			tabs,
		};
	},
});
</script>
