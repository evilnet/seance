<template>
	<div
		id="channel-avatar-overlay"
		v-backdrop="dismiss"
		class="screen-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request && !cropFile ? 'channel-avatar-dialog' : null"
	>
		<div
			v-if="request && network"
			id="channel-avatar-dialog"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
		>
			<div class="oper-action-body">
				<div class="oper-action-title">{{ title }}</div>

				<div class="channel-avatar-main">
					<Avatar :uuid="request.network" :nick="request.channel" size="large" />
					<div class="channel-avatar-side">
						<p class="oper-action-hint">{{ help }}</p>
						<div v-if="editable" class="channel-avatar-buttons">
							<label v-if="uploadable" class="btn btn-sm avatar-upload-button">
								{{ t("avatar.upload") }}
								<input
									type="file"
									accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
									class="avatar-file-input"
									:disabled="busy"
									@change="onFile"
								/>
							</label>
							<button
								type="button"
								class="btn btn-sm"
								:aria-expanded="linkOpen"
								:disabled="busy"
								@click="linkOpen = !linkOpen"
							>
								{{ t("avatar.useLink") }}
							</button>
							<button
								v-if="current"
								type="button"
								class="btn btn-sm btn-cancel"
								:disabled="busy"
								@click="remove"
							>
								{{ t("avatar.remove") }}
							</button>
						</div>
						<p v-else class="oper-action-hint">{{ t("channelAvatar.notAllowed") }}</p>
					</div>
				</div>

				<p v-if="retentionNote" class="oper-action-hint">{{ retentionNote }}</p>

				<form
					v-if="linkOpen && editable"
					class="channel-avatar-link"
					@submit.prevent="saveLink"
				>
					<label class="oper-action-label" for="channel-avatar-link">{{
						t("avatar.linkLabel")
					}}</label>
					<div class="channel-avatar-link-row">
						<input
							id="channel-avatar-link"
							ref="linkField"
							v-model="link"
							class="input"
							type="url"
							dir="ltr"
							inputmode="url"
							spellcheck="false"
							autocapitalize="off"
							placeholder="https://"
						/>
						<button type="submit" class="btn btn-sm" :disabled="busy || !!linkProblem">
							{{ t("avatar.save") }}
						</button>
					</div>
					<p class="oper-action-hint">{{ linkNote }}</p>
				</form>

				<p v-if="status" class="oper-action-result" role="status">{{ status }}</p>
			</div>
			<div class="oper-action-buttons">
				<button
					type="button"
					class="oper-btn oper-btn-ghost oper-cancel"
					:disabled="busy"
					@click="dismiss"
				>
					{{ t("channelAvatar.close") }}
				</button>
			</div>
		</div>

		<AvatarCrop
			v-if="cropFile"
			:file="cropFile"
			:title="t('channelAvatar.cropTitle', {channel: request?.channel ?? ''})"
			@done="onCropped"
			@cancel="cropFile = null"
		/>
	</div>
</template>

<style>
#channel-avatar-dialog .channel-avatar-main {
	display: flex;
	gap: 1.25rem;
	align-items: center;
}

#channel-avatar-dialog .channel-avatar-side {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	min-width: 0;
}

#channel-avatar-dialog .channel-avatar-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}

#channel-avatar-dialog .channel-avatar-link {
	display: flex;
	flex-direction: column;
	gap: 0.45rem;
}

#channel-avatar-dialog .channel-avatar-link-row {
	display: flex;
	gap: 0.5rem;
}
</style>

<script lang="ts">
// A channel's avatar (draft/metadata-2 `avatar` on the channel's name),
// opened from the channel's menu by a half-op or op (avatars/channel.ts):
// upload a picture to the network's image host, or point at one, or
// remove it. The server has the last word on who may: a refusal is shown.
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import Avatar from "./Avatar.vue";
import AvatarCrop from "./Settings/AvatarCrop.vue";
import eventbus from "../js/eventbus";
import {useI18n} from "../js/i18n";
import {useStore} from "../js/store";
import {clientForNetwork} from "../js/irc/manager";
import {setChannelAvatar} from "../js/irc/avatars";
import {canUpload, retentionDays, uploadAvatar} from "../js/avatars/actions";
import {
	CHANNEL_AVATAR_DIALOG,
	canSetChannelAvatar,
	type ChannelAvatarRequest,
} from "../js/avatars/channel";
import {clearFailed} from "../js/avatars/prefs";
import {proxiedSrc} from "../js/avatars/policy";
import {avatarOf} from "../js/avatars/registry";
import {avatarLinkProblem, parseAvatarUrl} from "../js/avatars/url";
import {filehostHost} from "../js/avatars/view";
import {hasVirtualKeyboard} from "../js/helpers/device";

export default defineComponent({
	name: "ChannelAvatarDialog",
	components: {Avatar, AvatarCrop},
	setup() {
		const {t, tCount} = useI18n();
		const store = useStore();
		const request = ref<ChannelAvatarRequest | null>(null);
		const network = computed(() =>
			request.value ? store.getters.findNetwork(request.value.network) : undefined
		);
		const client = () => (request.value ? clientForNetwork(request.value.network) : undefined);
		const busy = ref(false);
		const status = ref("");
		const linkOpen = ref(false);
		const link = ref("");
		const linkField = ref<HTMLInputElement | null>(null);
		const cropFile = ref<File | null>(null);

		const title = computed(() =>
			t("channelAvatar.title", {channel: request.value?.channel ?? ""})
		);
		const help = computed(() =>
			t("channelAvatar.help", {channel: request.value?.channel ?? ""})
		);
		const editable = computed(
			() =>
				!!request.value &&
				!!network.value &&
				canSetChannelAvatar(network.value, request.value.channel)
		);
		const uploadable = computed(() => editable.value && canUpload(client()));
		const current = computed(() =>
			request.value ? avatarOf(request.value.network, request.value.channel)?.value ?? "" : ""
		);
		// An upload of ours is not sent again before the host deletes it, as
		// our own avatar's is (avatars/actions.ts upkeep): say so.
		const retentionNote = computed(() => {
			const days = retentionDays();
			return uploadable.value && days > 0 ? tCount("channelAvatar.retentionNote", days) : "";
		});

		const linkProblem = computed(() => avatarLinkProblem(link.value));
		const linkNote = computed(() => {
			switch (linkProblem.value) {
				case "notHttps":
					return t("avatar.linkNotHttps");
				case "tooLong":
					return t("avatar.linkTooLong");
				case "svg":
					return t("avatar.linkSvg");
				case "invalid":
					return t("avatar.linkInvalid");
				default:
					break;
			}

			const host = parseAvatarUrl(link.value)?.host;
			// What loads for everyone (avatars/policy.ts): the network's image
			// host, the deploy's trusted hosts, or anything through its proxy.
			const config = store.state.branding.avatars;
			const trusted =
				!!host &&
				!!request.value &&
				(host === filehostHost(request.value.network) ||
					(config?.trustedHosts ?? []).includes(host) ||
					!!proxiedSrc(config?.proxy, link.value));
			return host && !trusted
				? t("channelAvatar.linkElsewhere", {host})
				: t("avatar.linkRules");
		});

		const write = async (value: string, done: string) => {
			const c = client();
			const r = request.value;

			if (!r) {
				return;
			}

			if (!c) {
				status.value = t("channelAvatar.failed", {reason: "unavailable"});
				return;
			}

			busy.value = true;
			status.value = t("avatar.saving");

			try {
				await setChannelAvatar(c, r.channel, value);

				if (value) {
					clearFailed(value);
				}

				status.value = done;
			} catch (e: unknown) {
				const reason = e instanceof Error ? e.message : String(e);
				status.value = t("channelAvatar.failed", {reason});
			} finally {
				busy.value = false;
			}
		};

		const onFile = (event: Event) => {
			const input = event.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";

			if (file) {
				status.value = "";
				cropFile.value = file;
			}
		};

		const onCropped = async (blob: Blob) => {
			cropFile.value = null;
			const c = client();

			if (!c) {
				status.value = t("channelAvatar.failed", {reason: "unavailable"});
				return;
			}

			busy.value = true;
			status.value = t("avatar.saving");
			let url: string;

			try {
				url = await uploadAvatar(c, blob);
			} catch (e: unknown) {
				const reason = e instanceof Error ? e.message : String(e);
				status.value = t("channelAvatar.failed", {reason});
				busy.value = false;
				return;
			}

			await write(url, t("channelAvatar.saved"));
		};

		const saveLink = () => {
			const parsed = parseAvatarUrl(link.value);

			if (!parsed || linkProblem.value) {
				return;
			}

			void write(parsed.href, t("channelAvatar.saved")).then(() => {
				if (current.value === parsed.href) {
					linkOpen.value = false;
					link.value = "";
				}
			});
		};

		const remove = () => void write("", t("channelAvatar.removed"));

		watch(linkOpen, (open) => {
			if (open && !hasVirtualKeyboard()) {
				void nextTick(() => linkField.value?.focus());
			}
		});

		const open = (incoming: ChannelAvatarRequest) => {
			request.value = incoming;
			busy.value = false;
			status.value = "";
			linkOpen.value = false;
			link.value = "";
			cropFile.value = null;
		};

		/** Close, the backdrop, Escape: not while a SET is out (its answer lands here). */
		const dismiss = () => {
			if (busy.value || cropFile.value) {
				return;
			}

			request.value = null;
		};

		const onEscape = (layer: string | null) => {
			if (layer === "channel-avatar-dialog") {
				dismiss();
			}
		};

		onMounted(() => {
			eventbus.on(CHANNEL_AVATAR_DIALOG, open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off(CHANNEL_AVATAR_DIALOG, open);
			eventbus.off("escapekey", onEscape);
		});

		return {
			t,
			request,
			network,
			busy,
			status,
			linkOpen,
			link,
			linkField,
			linkProblem,
			linkNote,
			cropFile,
			title,
			help,
			editable,
			uploadable,
			current,
			retentionNote,
			onFile,
			onCropped,
			saveLink,
			remove,
			dismiss,
		};
	},
});
</script>
