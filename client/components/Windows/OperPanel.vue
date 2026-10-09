<template>
	<div
		id="oper"
		class="window"
		role="dialog"
		aria-modal="true"
		:aria-label="`Oper tools for ${networkName}`"
		@click.self="close"
	>
		<div class="settings-modal oper-modal">
			<div class="settings-modal-header">
				<h1>
					Oper<span class="oper-modal-network"> · {{ networkName }}</span>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close the oper panel"
					@click="close"
				>
					✕
				</button>
			</div>
			<aside class="settings-menu">
				<ul role="tablist" aria-label="Oper panel tabs">
					<li v-for="t in TABS" :key="t.id" role="tab" :aria-selected="tab === t.id">
						<button
							type="button"
							:class="['icon', t.cls, {active: tab === t.id}]"
							:aria-label="t.label"
							:title="t.label"
							@click="go(t.id)"
						>
							<span class="tab-label">{{ t.label }}</span>
						</button>
					</li>
				</ul>
			</aside>
			<div class="settings-modal-body">
				<div class="container">
					<p v-if="!network" class="oper-panel-empty">This network is gone.</p>
					<p v-else-if="!opered" class="oper-panel-empty">
						You are not an IRC operator on {{ networkName }}. The oper tools appear when
						the server grants it — by <code>/oper</code> or, on networks that do, when
						you log in.
					</p>
					<OperNotices v-else-if="tab === 'notices'" :network="network" />
					<OperModes v-else :network="network" />
				</div>
			</div>
			<div class="settings-modal-footer">
				<span class="settings-modal-note">Changes apply as you make them.</span>
				<button class="btn settings-modal-done" type="button" @click="close">Done</button>
			</div>
		</div>
	</div>
</template>

<style>
.oper-modal-network {
	color: var(--body-color-muted);
	font-weight: normal;
}

.oper-panel-empty {
	color: var(--body-color-muted);
}

.settings-menu .oper-notices::before {
	content: "\f0a1"; /* https://fontawesome.com/icons/bullhorn?style=solid */
}

.settings-menu .oper-modes::before {
	content: "\f505"; /* https://fontawesome.com/icons/user-shield?style=solid */
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useRoute, useRouter} from "vue-router";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";
import {isOperOn} from "../../js/helpers/operMenu";
import OperNotices from "../Oper/OperNotices.vue";
import OperModes from "../Oper/OperModes.vue";

const TABS = [
	{id: "notices", label: "Notices", cls: "oper-notices"},
	{id: "modes", label: "Modes", cls: "oper-modes"},
];

/**
 * The oper panel (docs/projects/oper-tools.md): a modal over the app, like
 * Settings, opened from the shield in the network header. Its route is
 * `/oper/<network>/<tab>`, so it is a page opened on purpose
 * (`onStandalonePage`), a reload brings it back, and Done is `leavePage()`.
 */
export default defineComponent({
	name: "OperPanel",
	components: {OperNotices, OperModes},
	setup() {
		const store = useStore();
		const route = useRoute();
		const router = useRouter();

		const network = computed(() => store.getters.findNetwork(String(route.params.uuid)));
		const networkName = computed(() => network.value?.name ?? "");
		const opered = computed(() => isOperOn(network.value));
		const tab = computed(() =>
			TABS.some((t) => t.id === route.params.tab) ? String(route.params.tab) : "notices"
		);

		const go = (id: string) => {
			void router.push(`/oper/${String(route.params.uuid)}/${id}`);
		};

		const close = () => {
			leavePage();
		};

		return {TABS, network, networkName, opered, tab, go, close};
	},
});
</script>
