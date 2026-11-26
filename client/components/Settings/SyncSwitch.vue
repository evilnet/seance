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
		<p v-if="canSyncNow" class="network-settings-sync-now">
			<button type="button" class="btn btn-sm" :disabled="busy" @click="now">
				{{ busy ? t("settings.sync.now.busy") : t("settings.sync.now") }}
			</button>
			<span role="status" class="network-settings-sync-note">{{ result }}</span>
		</p>
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

.network-settings-sync-now {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	margin: 0.5rem 0 0;
}

.network-settings-sync-now .btn {
	margin: 0;
}
</style>

<script lang="ts">
import {computed, defineComponent, ref} from "vue";
import {useI18n} from "../../js/i18n";
import {sameAccount} from "../../js/sync/state";
import {syncNow, syncState, syncTick, turnOff, turnOn, unavailable} from "../../js/sync";
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

		/** The button shows while this device can sync here: on, connected, the same account, not waiting on an update. */
		const canSyncNow = computed(() => {
			void syncTick.value;
			const state = syncState.value;
			const client = clientForNetwork(props.uuid);

			return (
				on.value &&
				!state.blocked &&
				!!client?.isWelcomed &&
				sameAccount(client.account, state.account)
			);
		});

		const busy = ref(false);
		/** How the last "Sync now" ended. */
		const result = ref("");

		const now = async () => {
			busy.value = true;
			result.value = "";

			try {
				switch (await syncNow()) {
					case "sent":
						result.value = t("settings.sync.now.sent");
						break;
					case "upToDate":
						result.value = t("settings.sync.now.upToDate");
						break;
					case "offline":
						result.value = t("settings.sync.now.offline");
						break;
					default:
						result.value = t("settings.sync.now.failed");
				}
			} finally {
				busy.value = false;
			}
		};

		return {t, on, reason, note, toggle, canSyncNow, busy, result, now};
	},
});
</script>
