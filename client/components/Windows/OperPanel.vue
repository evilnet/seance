<template>
	<div
		id="oper"
		class="window"
		role="dialog"
		aria-modal="true"
		:aria-label="t('oper.panel.aria', {network: networkName})"
		@click.self="close"
	>
		<div class="settings-modal oper-modal">
			<div class="settings-modal-header">
				<h1>
					{{ t("oper.panel.title")
					}}<span class="oper-modal-network">
						· <bdi>{{ networkName }}</bdi></span
					>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					:aria-label="t('oper.panel.close')"
					@click="close"
				>
					✕
				</button>
			</div>
			<aside class="settings-menu">
				<ul role="tablist" :aria-label="t('oper.panel.tabs')">
					<li v-for="tb in tabs" :key="tb.id" role="tab" :aria-selected="tab === tb.id">
						<button
							type="button"
							:class="['icon', tb.cls, {active: tab === tb.id}]"
							:aria-label="tb.label"
							:title="tb.title"
							@click="go(tb.id)"
						>
							<span class="tab-label">{{ tb.label }}</span>
						</button>
					</li>
				</ul>
			</aside>
			<div class="settings-modal-body">
				<div class="container">
					<p v-if="!network" class="oper-panel-empty">{{ t("oper.panel.gone") }}</p>
					<p v-else-if="!opered" class="oper-panel-empty">
						{{ notOperFrame[0] }}<bdi>{{ networkName }}</bdi
						>{{ notOperFrame[1] }} {{ grantFrame[0] }}<code>/oper</code
						>{{ grantFrame[1] }}
					</p>
					<OperActivity v-else-if="tab === 'opers'" :network="network" />
					<OperAlerts v-else-if="tab === 'alerts'" :network="network" />
					<OperMe v-else :network="network" />
				</div>
			</div>
			<div class="settings-modal-footer">
				<span class="settings-modal-note">{{ t("oper.panel.note") }}</span>
				<button class="btn settings-modal-done" type="button" @click="close">
					{{ t("oper.panel.done") }}
				</button>
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
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import OperActivity from "../Oper/OperActivity.vue";
import OperAlerts from "../Oper/OperAlerts.vue";
import OperMe from "../Oper/OperMe.vue";

const TAB_IDS = ["opers", "alerts", "me"];

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
		const {t} = useI18n();
		const tabs = computed(() => [
			{
				id: "opers",
				label: t("oper.panel.tab.opers"),
				title: t("oper.panel.tab.opersTitle"),
				cls: "oper-opers",
			},
			{
				id: "alerts",
				label: t("oper.panel.tab.alerts"),
				title: t("oper.panel.tab.alertsTitle"),
				cls: "oper-alerts",
			},
			{
				id: "me",
				label: t("oper.panel.tab.me"),
				title: t("oper.panel.tab.meTitle"),
				cls: "oper-me",
			},
		]);
		const notOperFrame = computed(() =>
			frameSegments(t("oper.panel.notOper", {network: KEEP}), ["network"])
		);
		const grantFrame = computed(() =>
			frameSegments(t("oper.panel.howGranted", {command: KEEP}), ["command"])
		);
		const route = useRoute();
		const router = useRouter();

		const network = computed(() => store.getters.findNetwork(String(route.params.uuid)));
		const networkName = computed(() => network.value?.name ?? "");
		const opered = computed(() => isOperOn(network.value));
		const tab = computed(() => {
			const wanted = OLD_TABS[String(route.params.tab)] ?? String(route.params.tab);
			return TAB_IDS.includes(wanted) ? wanted : "opers";
		});

		const go = (id: string) => {
			void router.push(`/oper/${String(route.params.uuid)}/${id}`);
		};

		const close = () => {
			leavePage();
		};

		return {t, tabs, notOperFrame, grantFrame, network, networkName, opered, tab, go, close};
	},
});
</script>
