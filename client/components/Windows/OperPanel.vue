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
							:title="t.title"
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
					<OperActivity v-else-if="tab === 'opers'" :network="network" />
					<OperAlerts v-else-if="tab === 'alerts'" :network="network" />
					<OperMe v-else :network="network" />
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

.settings-menu .oper-opers::before {
	content: "\f0c0"; /* https://fontawesome.com/icons/users?style=solid */
}

.settings-menu .oper-alerts::before {
	content: "\f0f3"; /* https://fontawesome.com/icons/bell?style=solid */
}

.settings-menu .oper-me::before {
	content: "\f505"; /* https://fontawesome.com/icons/user-shield?style=solid */
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useRoute, useRouter} from "vue-router";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";
import {isOperOn} from "../../js/helpers/operMenu";
import OperActivity from "../Oper/OperActivity.vue";
import OperAlerts from "../Oper/OperAlerts.vue";
import OperMe from "../Oper/OperMe.vue";

const TABS = [
	{id: "opers", label: "Opers", title: "What the opers have been doing", cls: "oper-opers"},
	{id: "alerts", label: "Alerts", title: "What reaches you, and how loudly", cls: "oper-alerts"},
	{id: "me", label: "Me", title: "Your status, privileges and user modes", cls: "oper-me"},
];

/** The phase-1 tab ids, so links to them still open (notices → alerts, modes → me). */
const OLD_TABS: Record<string, string> = {notices: "alerts", modes: "me"};

/**
 * The oper panel (docs/projects/oper-tools.md): a modal over the app, like
 * Settings, opened from the shield in the network header. Three tabs, each
 * one question — Opers (what have they been doing), Alerts (what reaches
 * me, how loudly) and Me. Its route is `/oper/<network>/<tab>`, so it is a
 * page opened on purpose (`onStandalonePage`), a reload brings it back,
 * and Done is `leavePage()`.
 */
export default defineComponent({
	name: "OperPanel",
	components: {OperActivity, OperAlerts, OperMe},
	setup() {
		const store = useStore();
		const route = useRoute();
		const router = useRouter();

		const network = computed(() => store.getters.findNetwork(String(route.params.uuid)));
		const networkName = computed(() => network.value?.name ?? "");
		const opered = computed(() => isOperOn(network.value));
		const tab = computed(() => {
			const wanted = OLD_TABS[String(route.params.tab)] ?? String(route.params.tab);
			return TABS.some((t) => t.id === wanted) ? wanted : "opers";
		});

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
