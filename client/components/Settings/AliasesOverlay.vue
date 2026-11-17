<template>
	<Teleport to="#viewport">
		<div
			id="aliases-overlay"
			v-backdrop="close"
			class="screen-overlay settings-layer"
			data-escape-close="aliases"
		>
			<div
				ref="pane"
				class="settings-modal aliases-layer"
				role="dialog"
				aria-modal="true"
				:aria-label="t('settings.aliases.paneAria')"
				tabindex="-1"
				@keydown.tab="onTab"
			>
				<div class="settings-modal-header">
					<h1>{{ t("settings.aliases.titleHeading") }}</h1>
					<button
						class="settings-modal-close"
						type="button"
						:aria-label="t('settings.aliases.close')"
						@click="close"
					>
						✕
					</button>
				</div>
				<div class="settings-modal-body">
					<div class="container">
						<AliasSettings />
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
	</Teleport>
</template>

<style>
.aliases-layer:focus {
	outline: 0;
}
</style>

<script lang="ts">
import {defineComponent, onMounted, onUnmounted, ref} from "vue";
import eventbus from "../../js/eventbus";
import {navigate} from "../../js/router";
import {useI18n} from "../../js/i18n";
import {useLayerFocus} from "../../js/hooks/use-layer-focus";
import AliasSettings from "./Aliases.vue";

/**
 * The aliases (Settings/Aliases.vue), opened from the first row of
 * Settings → Scripts: a layer over the settings, the list still under it,
 * the size of the settings pane. Every change is saved as it is made, so
 * Done, ✕, Escape and the backdrop all just close it back to the list.
 */
export default defineComponent({
	name: "AliasesOverlay",
	components: {
		AliasSettings,
	},
	setup() {
		const {t} = useI18n();
		const pane = ref<HTMLElement>();
		const {onTab} = useLayerFocus(pane, () =>
			document.querySelector<HTMLElement>(".settings-scripts .scripts-aliases")
		);

		const close = () => {
			void navigate("Scripts");
		};

		const onEscape = (layer: string | null) => {
			if (layer === "aliases") {
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
			t,
			pane,
			onTab,
			close,
		};
	},
});
</script>
