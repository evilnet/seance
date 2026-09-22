<template>
	<div
		id="install-guide-overlay"
		:class="{opened: store.state.installGuideOpen}"
		@click.self="close"
	>
		<div
			v-if="store.state.installGuideOpen && step"
			id="install-guide"
			role="dialog"
			aria-modal="true"
			aria-labelledby="install-guide-title"
		>
			<div class="install-guide-header">
				<img class="install-guide-icon" src="img/icon-192.png" alt="" />
				<h1 id="install-guide-title">{{ appName }}</h1>
				<button class="install-guide-close" type="button" aria-label="Close" @click="close">
					✕
				</button>
			</div>
			<div class="install-guide-body">
				<div class="install-guide-art">
					<InstallGuideArt :kind="step.art" :app-name="appName" />
				</div>
				<div class="install-guide-text" aria-live="polite">
					<p v-if="index > 0" class="install-guide-count">
						Step {{ index }} of {{ steps.length - 1 }}
					</p>
					<h2>{{ step.title }}</h2>
					<p>{{ step.body }}</p>
					<button
						v-if="step.action === 'prompt'"
						class="btn install-guide-install"
						type="button"
						@click="install"
					>
						Install
					</button>
					<p v-if="step.note" class="install-guide-note">{{ step.note }}</p>
				</div>
			</div>
			<div class="install-guide-footer">
				<label class="install-guide-remember">
					<input v-model="dontShowAgain" type="checkbox" />
					Don't show this again
				</label>
				<div class="install-guide-nav">
					<div class="install-guide-dots" aria-hidden="true">
						<span
							v-for="(s, i) in steps"
							:key="i"
							:class="{current: i === index}"
						></span>
					</div>
					<button v-if="index > 0" class="btn btn-secondary" type="button" @click="back">
						Back
					</button>
					<button v-if="index === 0" class="btn" type="button" @click="next">
						Show me how
					</button>
					<button v-else-if="!last" class="btn" type="button" @click="next">Next</button>
					<button v-else class="btn" type="button" @click="close">Done</button>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
/* The pane: an illustration on top, the step under it, the checkbox and
 * the navigation in a footer that holds still. Sized in rem like the rest
 * of the chrome, so a font-size step scales it too. */
#install-guide {
	display: flex;
	flex-direction: column;
	width: min(30rem, 100%);
	max-height: 100%;
	margin: 1rem;
	background: var(--window-bg-color);
	color: var(--body-color);
	border-radius: 0.75rem;
	box-shadow: 0 8px 40px rgb(0 0 0 / 45%);
	overflow: hidden;
	user-select: text;
}

.install-guide-header {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	padding: 0.75rem 0.75rem 0.75rem 1rem;
}

.install-guide-header h1 {
	flex: 1 1 auto;
	margin: 0;
	font-size: 1.125rem;
	font-weight: 700;
}

.install-guide-icon {
	width: 1.75rem;
	height: 1.75rem;
	border-radius: 0.4rem;
}

.install-guide-close {
	color: var(--body-color-muted);
	font-size: 1.125rem;
	line-height: 1;
	padding: 0.35em 0.5em;
}

.install-guide-close:hover,
.install-guide-close:focus {
	color: var(--body-color);
}

.install-guide-body {
	flex: 1 1 auto;
	overflow-y: auto;
	scrollbar-width: thin;
	overscroll-behavior: contain;
}

.install-guide-art {
	aspect-ratio: 8 / 5;
	max-height: 40vh;
	padding: 0.5rem 1rem;
	background: rgb(128 128 128 / 10%);
	background: color-mix(in srgb, var(--button-color) 10%, transparent);
}

.install-guide-text {
	padding: 1rem 1.25rem 0.5rem;
}

.install-guide-text h2 {
	margin: 0 0 0.35rem;
	font-size: 1.25rem;
	font-weight: 700;
	line-height: 1.25;
}

.install-guide-text p {
	margin: 0 0 0.6rem;
	line-height: 1.45;
}

.install-guide-count {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}

.install-guide-note {
	color: var(--body-color-muted);
	font-size: 0.875rem;
}

.install-guide-install {
	margin: 0.25rem 0 0.75rem;
}

.install-guide-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	flex-wrap: wrap;
	padding: 0.6rem 1rem 0.75rem;
	box-shadow: inset 0 1px 0 rgb(128 128 128 / 30%);
}

.install-guide-remember {
	display: flex;
	align-items: center;
	gap: 0.4em;
	color: var(--body-color-muted);
	font-size: 0.875rem;
	cursor: pointer;
}

.install-guide-nav {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	margin-left: auto;
}

.install-guide-nav .btn {
	margin: 0;
}

.install-guide-nav .btn-secondary {
	border-color: transparent;
}

.install-guide-dots {
	display: flex;
	gap: 0.3rem;
	margin-right: 0.5rem;
}

.install-guide-dots span {
	width: 0.4rem;
	height: 0.4rem;
	border-radius: 50%;
	background: var(--body-color-muted);
	opacity: 0.35;
	transition: opacity 0.2s, background 0.2s;
}

.install-guide-dots span.current {
	background: var(--button-color);
	opacity: 1;
}

/* On a phone the guide is the page. */
@media (max-width: 768px) {
	#install-guide {
		width: 100%;
		height: 100%;
		margin: 0;
		border-radius: 0;
	}

	/* The phone drawings are portrait: give them height rather than width. */
	.install-guide-art {
		flex: 0 0 auto;
		aspect-ratio: auto;
		height: clamp(12rem, 42vh, 26rem);
		max-height: none;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, ref, watch} from "vue";
import eventbus from "../js/eventbus";
import {useStore} from "../js/store";
import {dismissInstallGuide, promptInstall} from "../js/pwa";
import {currentEnvironment, detectInstallTarget, installSteps} from "../js/helpers/installGuide";
import InstallGuideArt from "./InstallGuideArt.vue";

/**
 * The install guide: a short walkthrough of how this browser installs the
 * app, opened at start by pwa.ts (openInstallGuideAtStart) and from
 * Settings. The steps come from helpers/installGuide.ts; when Chrome has
 * offered `beforeinstallprompt`, the introduction carries the real Install
 * button and the manual steps stay as the fallback. "Don't show this again"
 * is honoured on any way out — Done, the close button, Escape, the backdrop.
 */
export default defineComponent({
	name: "InstallGuide",
	components: {InstallGuideArt},
	setup() {
		const store = useStore();
		const index = ref(0);
		const dontShowAgain = ref(false);

		const appName = computed(() => store.state.branding.appName);
		const target = detectInstallTarget(currentEnvironment());

		const steps = computed(() =>
			installSteps(target, appName.value, {
				canPrompt: store.state.installPromptAvailable,
			})
		);
		const step = computed(() => steps.value[index.value]);
		const last = computed(() => index.value >= steps.value.length - 1);

		const next = () => {
			if (!last.value) {
				index.value++;
			}
		};

		const back = () => {
			if (index.value > 0) {
				index.value--;
			}
		};

		const close = () => {
			if (dontShowAgain.value) {
				dismissInstallGuide();
			}

			store.commit("installGuideOpen", false);
		};

		const install = () => {
			// Accepting fires `appinstalled`, which closes the guide for good
			// (pwa.ts); a dismissal leaves the manual steps to read.
			void promptInstall();
		};

		watch(
			() => store.state.installGuideOpen,
			(open) => {
				if (open) {
					index.value = 0;
					dontShowAgain.value = false;
				}
			}
		);

		const onEscape = () => {
			if (store.state.installGuideOpen) {
				close();
			}
		};

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("escapekey", onEscape);
		});

		return {
			store,
			appName,
			steps,
			step,
			index,
			last,
			dontShowAgain,
			next,
			back,
			close,
			install,
		};
	},
});
</script>
