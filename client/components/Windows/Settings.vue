<template>
	<div
		id="settings"
		class="window"
		role="dialog"
		aria-modal="true"
		aria-label="Settings"
		@click.self="close"
	>
		<div class="settings-modal">
			<div class="settings-modal-header">
				<h1>Settings</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close settings"
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
				<span class="settings-modal-note">Changes are saved as you make them.</span>
				<button class="btn settings-modal-done" type="button" @click="close">Done</button>
			</div>
		</div>
	</div>
</template>

<style>
/* The settings window is a modal: a dimmed backdrop over the whole app
 * (sidebar included — absolute within #viewport, above the sidebar's
 * z-index 10, so it never fights the hamburger or the swipe) with the
 * settings in their own pane on top. The route is still /settings/…, so
 * deep links, reloads and leavePage() behave exactly as before; only the
 * rendering is an overlay. */
#settings.window {
	position: absolute;
	top: 0;
	right: 0;
	bottom: 0;
	left: 0;
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
	#settings.window {
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
import {defineComponent} from "vue";
import {useRoute} from "vue-router";
import Navigation from "../Settings/Navigation.vue";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";

export default defineComponent({
	name: "Settings",
	components: {
		Navigation,
	},
	setup() {
		const store = useStore();
		const route = useRoute();

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
			onChange,
			close,
		};
	},
});
</script>
