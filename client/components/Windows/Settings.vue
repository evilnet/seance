<template>
	<div
		id="settings"
		v-backdrop="close"
		class="window screen-overlay"
		role="dialog"
		aria-modal="true"
		:aria-label="dialogLabel"
	>
		<div class="settings-modal">
			<div class="settings-modal-header">
				<h1>
					<span class="settings-title-plain">{{ t("windows.settings.title") }}</span>
					<span v-if="activeTab" class="settings-title-in">
						<I18nFrame :text="t('windows.settings.titleIn', {section: KEEP})"
							><template v-slot:section
								><span class="settings-title-section">{{
									activeTab.label
								}}</span></template
							></I18nFrame
						>
					</span>
					<span v-if="activeTab" class="settings-title-only">{{ activeTab.label }}</span>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					:aria-label="closeAria"
					@click="close"
				>
					✕
				</button>
			</div>
			<Navigation />
			<div class="settings-modal-body">
				<div class="container" @change="onChange">
					<router-view></router-view>
				</div>
			</div>
			<div class="settings-modal-footer">
				<span class="settings-modal-note">{{ t("windows.settings.note") }}</span>
				<button class="btn settings-modal-done" type="button" @click="close">
					{{ t("windows.settings.done") }}
				</button>
			</div>
		</div>
	</div>
</template>

<style>
/* The settings window is a modal (and the oper panel, Windows/OperPanel.vue,
 * Help and the release notes, Windows/Help.vue and Windows/Changelog.vue,
 * borrow the same frame): a dimmed backdrop over the whole app
 * (sidebar included — absolute within #viewport, above the sidebar's
 * z-index 10, so it never fights the hamburger or the swipe) with the
 * settings in their own pane on top. The route is still /settings/…, so
 * deep links, reloads and leavePage() behave exactly as before; only the
 * rendering is an overlay. */
#settings.window,
#oper.window,
#help.window,
#changelog.window,
#bouncer.window,
.settings-layer {
	position: absolute;
	inset: 0;
	z-index: 20;
	background: var(--overlay-bg-color);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 1.5rem;
	/* clip, not hidden: a hidden box still scrolls when something inside it
	 * is scrolled into view — focus moving to a field as the keyboard opens,
	 * VoiceOver or TalkBack stepping through, scrollIntoView — and the pane
	 * slid up off a strip of empty backdrop it could not scroll back from.
	 * Only .settings-modal-body scrolls. hidden first, for a browser without
	 * clip (Safari 15 and older), which drops the declaration it cannot read. */
	overflow: hidden;
	overflow: clip;
}

/* A layer over the settings modal, for a page opened from one of its tabs
 * (the script editor, Settings/ScriptEdit.vue; the aliases,
 * Settings/AliasesOverlay.vue): the same frame, its own .settings-modal
 * pane over a backdrop that dims the settings under it, one step above
 * them (20) and below the confirm dialog and the menus (999 and up), so a
 * question asked from it shows over it. */
.settings-layer {
	z-index: 30;
}

/* A fixed height, not content-driven: the footer holds still when tabs of
 * different lengths come and go, and the body scrolls inside. The pane is
 * the size container the tab strip asks for its icons-only switch
 * (Navigation.vue), replacing the old container on #settings. */
.settings-modal {
	display: flex;
	flex-direction: column;
	width: min(52rem, 100%);
	height: min(44rem, 100%);
	background: var(--window-bg-color);
	border-radius: 8px;
	box-shadow: 0 8px 40px rgb(0 0 0 / 45%);
	overflow: hidden;
	overflow: clip;
	/* stylelint-disable-next-line property-no-unknown */
	container-type: inline-size;
	/* stylelint-disable-next-line property-no-unknown */
	container-name: settings;
}

.settings-modal-header {
	display: flex;
	align-items: center;
	padding: 0.75rem 1rem 0;
}

.settings-modal-header h1 {
	flex: 1 1 auto;
	margin: 0;
	font-size: 1.375em;
}

/* With the tab strip down to icons (Navigation.vue), the title names the
 * open tab: "Settings › Appearance", the "Settings ›" muted; at the
 * biggest text sizes on a phone, "Appearance" alone. */
.settings-title-in {
	display: none;
	color: var(--body-color-muted);
	font-weight: normal;
}

.settings-title-section {
	color: var(--body-color);
	font-weight: bold;
}

.settings-title-only {
	display: none;
}

@container settings (max-width: 46rem) {
	.settings-title-plain {
		display: none;
	}

	.settings-title-in {
		display: inline;
	}
}

/* A phone at the biggest text sizes: "Settings ›" would take a line of its
 * own, and the tab strip already says where you are. */
@container settings (max-width: 16rem) {
	.settings-title-in {
		display: none;
	}

	.settings-title-only {
		display: inline;
	}
}

.settings-modal-close {
	color: var(--body-color-muted);
	font-size: 1.125rem;
	line-height: 1;
	padding: 0.35em 0.5em;
}

.settings-modal-close:hover,
.settings-modal-close:focus {
	color: var(--body-color);
}

.settings-modal-body {
	flex: 1 1 auto;
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	scrollbar-width: thin;
	overscroll-behavior: contain;
	-webkit-overflow-scrolling: touch;
	padding-top: 1rem;
}

/* A heading's top margin parts it from the section above; a tab's first
 * heading has none, so it sits the body's padding below the tab strip. */
.settings-modal-body > .container > :first-child > h2:first-child,
.settings-modal-body > .container > :first-child > :first-child > h2:first-child {
	margin-top: 0;
}

.settings-modal-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding: 0.6rem 1rem;
	/* An inset hairline, like the tab strip's, not a border: no box growth. */
	box-shadow: inset 0 1px 0 rgb(128 128 128 / 30%);
}

.settings-modal-note {
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.settings-modal-footer .btn {
	margin: 0;
}

/* On a phone the modal is the page: no backdrop margin, no rounding. The
 * breakpoint matches the sidebar's overlay mode. */
@media (max-width: 768px) {
	#settings.window,
	#oper.window,
	#help.window,
	#changelog.window,
	#bouncer.window,
	.settings-layer {
		padding: 0;
	}

	.settings-modal {
		width: 100%;
		height: 100%;
		border-radius: 0;
	}
}
</style>

<script lang="ts">
import {defineComponent, computed} from "vue";
import {useRoute} from "vue-router";
import Navigation from "../Settings/Navigation.vue";
import I18nFrame from "../I18nFrame.vue";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import {useSettingsTabs} from "../../js/hooks/use-settings-tabs";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";

export default defineComponent({
	name: "Settings",
	components: {
		Navigation,
		I18nFrame,
	},
	setup() {
		const store = useStore();
		const route = useRoute();
		const {t} = useI18n();
		const dialogLabel = computed(() => t("windows.settings.title"));
		const closeAria = computed(() => t("windows.settings.close"));
		const {active: activeTab} = useSettingsTabs();

		const onChange = (event: Event) => {
			// NetworkEdit has its own form and persistence contract; its fields
			// are not global client settings.
			if (route.name === "NetworkEdit") {
				return;
			}

			const ignore = ["old_password", "new_password", "verify_password"];

			const name = (event.target as HTMLInputElement).name;

			if (ignore.includes(name)) {
				return;
			}

			let value: boolean | string;

			if ((event.target as HTMLInputElement).type === "checkbox") {
				value = (event.target as HTMLInputElement).checked;
			} else {
				value = (event.target as HTMLInputElement).value;
			}

			void store.dispatch("settings/update", {name, value, sync: true});
		};

		const close = () => {
			leavePage();
		};

		return {
			t,
			KEEP,
			activeTab,
			dialogLabel,
			closeAria,
			onChange,
			close,
		};
	},
});
</script>
