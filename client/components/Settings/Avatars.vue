<template>
	<div class="avatars-settings">
		<h2>{{ t("settings.avatars.yours") }}</h2>
		<p v-if="networks.length === 0" class="avatar-load-help">
			{{ t("settings.avatars.connectFirst") }}
		</p>
		<div
			v-for="network in networks"
			:key="network.uuid"
			class="avatars-settings-network"
			:data-network="network.uuid"
		>
			<AvatarSettings :uuid="network.uuid" :heading="network.name" />
		</div>

		<h2 id="label-avatars">{{ t("settings.appearance.avatarsHeading") }}</h2>
		<div role="group" aria-labelledby="label-avatars" class="avatar-load-options">
			<p class="avatar-load-help">{{ t("settings.appearance.avatarsHelp") }}</p>
			<label class="opt">
				<input
					:checked="avatarLoad === 'trusted'"
					type="radio"
					name="avatarLoad"
					value="trusted"
				/>
				<span>
					{{ t("settings.appearance.avatarsTrusted") }}
					<span class="avatar-load-hint">{{
						t("settings.appearance.avatarsTrustedHint")
					}}</span>
				</span>
			</label>
			<label class="opt">
				<input :checked="avatarLoad === 'any'" type="radio" name="avatarLoad" value="any" />
				<span>
					{{ t("settings.appearance.avatarsAny") }}
					<span class="avatar-load-hint">{{
						t("settings.appearance.avatarsAnyHint")
					}}</span>
				</span>
			</label>
			<label class="opt">
				<input
					:checked="avatarLoad === 'none'"
					type="radio"
					name="avatarLoad"
					value="none"
				/>
				<span>
					{{ t("settings.appearance.avatarsNone") }}
					<span class="avatar-load-hint">{{
						t("settings.appearance.avatarsNoneHint")
					}}</span>
				</span>
			</label>
			<div
				v-if="avatarLoad === 'trusted' && trustedAvatarPeople.length > 0"
				class="trusted-hosts"
			>
				<div class="trusted-hosts-head">
					<span class="trusted-hosts-title">{{
						t("settings.appearance.avatarsPeople")
					}}</span>
				</div>
				<ul class="trusted-host-list">
					<li
						v-for="person in trustedAvatarPeople"
						:key="person.key"
						class="trusted-host trusted-account"
					>
						<span class="trusted-host-name">{{ person.account }}</span>
						<span class="trusted-host-network">{{ person.where }}</span>
						<button
							type="button"
							class="trusted-host-remove"
							:aria-label="
								t('settings.appearance.untrustFrom', {name: person.account})
							"
							:title="t('settings.appearance.untrustFrom', {name: person.account})"
							@click="untrustPerson(person.key)"
						></button>
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>

<style>
/* Avatars: the three choices carry a line each on what they mean. */
.avatar-load-help,
.avatar-load-hint {
	display: block;
	font-size: 0.8125rem;
	color: var(--body-color-muted);
	line-height: 1.4;
}

.avatar-load-help {
	margin: 0 0 0.5rem;
}

.avatars-settings-network + .avatars-settings-network {
	margin-block-start: 1.25rem;
	padding-block-start: 1rem;
	border-block-start: 1px solid rgb(128 128 128 / 25%);
}
</style>

<script lang="ts">
// Settings → Avatar: your own avatar on each connected network
// (AvatarSettings.vue) and whose avatars load (avatars/policy.ts). The
// network open in the chat comes first; `?network=<uuid>` puts that one
// first instead (the user card's "Change your avatar").
import {computed, defineComponent} from "vue";
import {useRoute} from "vue-router";
import {normalizeAvatarLoad} from "../../js/avatars/policy";
import {splitPersonKey, trustedPeople, untrustPerson} from "../../js/avatars/prefs";
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import AvatarSettings from "./AvatarSettings.vue";

export default defineComponent({
	name: "AvatarsSettings",
	components: {AvatarSettings},
	setup() {
		const store = useStore();
		const route = useRoute();
		const {t} = useI18n();

		const networks = computed(() => {
			const first =
				(typeof route.query.network === "string" ? route.query.network : undefined) ??
				store.state.activeChannel?.network.uuid;
			const list = [...store.state.networks];
			const index = list.findIndex((n) => n.uuid === first);

			if (index > 0) {
				list.unshift(...list.splice(index, 1));
			}

			return list;
		});

		const avatarLoad = computed(() => normalizeAvatarLoad(store.state.settings.avatarLoad));

		const networkName = (uuid: string) =>
			store.getters.findNetwork(uuid)?.name ?? uuid.slice(0, 8);

		// The people whose avatar always loads: account at the host it was on.
		const trustedAvatarPeople = computed(() =>
			trustedPeople().map((key) => {
				const {network, account, host} = splitPersonKey(key);
				const name = network ? networkName(network) : "";
				return {
					key,
					account,
					where: name
						? t("settings.appearance.avatarsPersonWhere", {network: name, host})
						: host,
				};
			})
		);

		return {t, networks, avatarLoad, trustedAvatarPeople, untrustPerson};
	},
});
</script>
