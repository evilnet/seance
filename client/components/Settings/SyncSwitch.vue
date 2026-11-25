<template>
	<div class="network-settings-sync">
		<label class="opt">
			<input
				v-switch
				:checked="on"
				:disabled="!on && reason !== null"
				type="checkbox"
				name="settingsSync"
				@change.stop="toggle"
			/>
			{{ t("settings.sync.label") }}
		</label>
		<p class="network-settings-sync-note">{{ note }}</p>
	</div>
</template>

<style>
.network-settings-sync {
	flex: 1 0 100%;
}

.network-settings-sync-note {
	margin: 0;
	font-size: 0.875rem;
	color: var(--body-color-muted);
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useI18n} from "../../js/i18n";
import {sameAccount} from "../../js/sync/state";
import {syncState, syncTick, turnOff, turnOn, unavailable} from "../../js/sync";
import {clientForNetwork} from "../../js/irc/manager";

/**
 * Settings → Networks, on one network: "Sync settings with this account"
 * (docs/projects/settings-sync.md § The home). On, the network is this
 * device's sync home; there is one at most, so switching it on elsewhere
 * asks to move it (sync/index.ts `turnOn`).
 */
export default defineComponent({
	name: "SyncSwitch",
	props: {
		uuid: {type: String, required: true},
	},
	setup(props) {
		const {t} = useI18n();

		const on = computed(() => syncState.value.home === props.uuid);

		/** Why it cannot be switched on here; null when it can. */
		const reason = computed(() => {
			void syncTick.value; // the connection's account and file host are not reactive
			return unavailable(props.uuid);
		});

		const note = computed(() => {
			void syncTick.value;
			const state = syncState.value;

			if (on.value) {
				const account = clientForNetwork(props.uuid)?.account ?? "";

				if (state.blocked) {
					return t("settings.sync.blocked");
				}

				if (account && !sameAccount(account, state.account)) {
					return t("settings.sync.paused", {account, known: state.account});
				}

				return t("settings.sync.on", {account: state.account});
			}

			switch (reason.value) {
				case "browser":
					return t("settings.sync.noBrowser");
				case "offline":
					return t("settings.sync.offline");
				case "signIn":
					return t("settings.sync.signIn");
				case "filehost":
					return t("settings.sync.noFilehost");
				case "private":
					return t("settings.sync.noPrivate");
				case "reading":
					return t("settings.sync.reading");
				default:
					return t("settings.sync.help");
			}
		});

		const toggle = (event: Event) => {
			const input = event.target as HTMLInputElement;
			const wanted = input.checked;
			// The switch shows the state, which a question may yet leave as it is.
			input.checked = on.value;

			if (wanted) {
				void turnOn(props.uuid);
			} else {
				turnOff();
			}
		};

		return {t, on, reason, note, toggle};
	},
});
</script>
