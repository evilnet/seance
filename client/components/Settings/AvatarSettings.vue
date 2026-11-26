<template>
	<section class="avatar-settings" :aria-labelledby="'avatar-settings-' + uuid">
		<div v-if="unavailable" class="avatar-settings-warning" role="alert">
			<div>
				<strong>{{ t("avatar.unavailableTitle") }}</strong>
				<p>{{ t("avatar.unavailableText", {host: currentHost}) }}</p>
			</div>
			<button
				v-if="currentRecent && currentRecent.blob && uploadable"
				type="button"
				class="btn btn-sm"
				:disabled="busy"
				@click="reuploadCurrent"
			>
				{{ t("avatar.uploadAgain") }}
			</button>
		</div>

		<div class="avatar-settings-main">
			<Avatar v-if="nick && enabled" :uuid="uuid" :nick="nick" :self="true" size="large" />
			<div class="avatar-settings-body">
				<h3 :id="'avatar-settings-' + uuid">{{ heading || t("avatar.heading") }}</h3>
				<p class="avatar-settings-help">{{ helpText }}</p>
				<p v-if="retentionNote" class="avatar-settings-note">{{ retentionNote }}</p>
				<div v-if="editable" class="avatar-settings-buttons">
					<label v-if="uploadable" class="btn btn-sm avatar-upload-button">
						{{ t("avatar.upload") }}
						<input
							ref="fileInput"
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
				<p v-else-if="enabled" class="avatar-settings-note">{{ notEditableText }}</p>
			</div>
		</div>

		<form v-if="linkOpen && editable" class="avatar-settings-link" @submit.prevent="saveLink">
			<label :for="'avatar-link-' + uuid">{{ t("avatar.linkLabel") }}</label>
			<div class="avatar-settings-link-row">
				<input
					:id="'avatar-link-' + uuid"
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
			<p class="avatar-settings-note">{{ linkNote }}</p>
		</form>

		<p v-if="status" class="avatar-settings-status" role="status">{{ status }}</p>

		<div v-if="editable && recent.length > 0" class="avatar-settings-recent">
			<h4>{{ t("avatar.recent") }}</h4>
			<ul>
				<li v-for="rec in recent" :key="rec.id">
					<button
						type="button"
						class="avatar-recent"
						:aria-pressed="rec.url === current"
						:aria-label="recentLabel(rec)"
						:disabled="busy"
						@click="useRecent(rec)"
					>
						<span class="avatar avatar-large avatar-image avatar-recent-image">
							<img
								:src="recentSrc(rec)"
								alt=""
								referrerpolicy="no-referrer"
								loading="lazy"
								decoding="async"
							/>
						</span>
						<span class="avatar-recent-date">{{ recentDate(rec) }}</span>
					</button>
					<button
						v-if="rec.url !== current"
						type="button"
						class="avatar-recent-forget"
						:aria-label="t('avatar.forgetRecent')"
						:title="t('avatar.forgetRecent')"
						@click="forget(rec)"
					>
						×
					</button>
				</li>
			</ul>
			<p class="avatar-settings-note">{{ t("avatar.recentNote") }}</p>
		</div>

		<label class="avatar-settings-switch">
			<input v-switch type="checkbox" :checked="enabled" @change="toggle" />
			{{ t("avatar.showOnNetwork", {network: networkName}) }}
		</label>

		<AvatarCrop v-if="cropFile" :file="cropFile" @done="onCropped" @cancel="cropFile = null" />
	</section>
</template>

<style>
.avatar-settings {
	display: flex;
	flex-direction: column;
	gap: 0.875rem;
	padding: 0.875rem 0 0.25rem;
}

.avatar-settings-main {
	display: flex;
	gap: 1.25rem;
	align-items: center;
}

.avatar-settings-body {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
	min-width: 0;
}

.avatar-settings h3,
.avatar-settings h4 {
	margin: 0;
	font-size: 1rem;
}

.avatar-settings h4 {
	font-size: 0.8125rem;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--body-color-muted);
}

.avatar-settings p {
	margin: 0;
}

.avatar-settings-help {
	line-height: 1.45;
}

.avatar-settings-note,
.avatar-settings-status {
	font-size: 0.8125rem;
	color: var(--body-color-muted);
	line-height: 1.4;
}

.avatar-settings-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-top: 0.25rem;
}

.avatar-upload-button {
	position: relative;
	cursor: pointer;
}

.avatar-file-input {
	position: absolute;
	inset: 0;
	opacity: 0;
	width: 100%;
	cursor: pointer;
}

.avatar-upload-button:focus-within {
	outline: 2px solid var(--focus-ring, currentcolor);
	outline-offset: 2px;
}

.avatar-settings-warning {
	display: flex;
	gap: 1rem;
	align-items: center;
	justify-content: space-between;
	padding: 0.75rem 1rem;
	border-radius: 0.5rem;
	background: var(--warn-bg, #fff4d6);
	color: var(--warn-fg, #6b4e00);
}

.avatar-settings-warning p {
	font-size: 0.8125rem;
	margin-top: 0.25rem;
}

.avatar-settings-link {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
}

.avatar-settings-link-row {
	display: flex;
	gap: 0.5rem;
}

.avatar-settings-link-row .input {
	flex: 1;
	min-width: 0;
	margin: 0;
}

.avatar-settings-recent ul {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem;
	list-style: none;
	margin: 0.5rem 0;
	padding: 0;
}

.avatar-settings-recent li {
	position: relative;
}

.avatar-recent {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.375rem;
	padding: 0;
	border: 0;
	background: none;
	color: var(--body-color-muted);
	font: inherit;
	font-size: 0.75rem;
	cursor: pointer;
}

.avatar-recent .avatar-recent-image {
	width: 3.5rem;
	height: 3.5rem;
	margin: 0;
}

.avatar-recent[aria-pressed="true"] .avatar-recent-image {
	box-shadow: 0 0 0 2px var(--window-bg-color), 0 0 0 4px var(--link-color);
}

.avatar-recent-forget {
	position: absolute;
	inset-block-start: -0.375rem;
	inset-inline-end: -0.375rem;
	width: 1.375rem;
	height: 1.375rem;
	border-radius: 50%;
	border: 0;
	background: var(--body-color-muted);
	color: var(--window-bg-color);
	font-size: 0.875rem;
	line-height: 1;
	cursor: pointer;
	opacity: 0;
}

.avatar-settings-recent li:is(:hover, :focus-within) .avatar-recent-forget {
	opacity: 1;
}

@media (hover: none) {
	.avatar-recent-forget {
		opacity: 1;
	}
}

.avatar-settings-switch {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}
</style>

<script lang="ts">
// Settings: our own avatar on one network (draft/metadata-2 `avatar`):
// upload a picture to the network's image host, or point at one; the
// recent ones kept on this device; the switch for avatars on the network.
import {computed, defineComponent, onBeforeUnmount, onMounted, ref, watch} from "vue";
import Avatar from "../Avatar.vue";
import AvatarCrop from "./AvatarCrop.vue";
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import {clientForNetwork} from "../../js/irc/manager";
import {
	canUpload,
	retentionDays,
	reupload,
	uploadAvatar,
	useAvatar,
} from "../../js/avatars/actions";
import {applyAvatarsEnabled, setOwnAvatar} from "../../js/irc/avatars";
import {
	avatarUnavailable,
	forgetRecentAvatar,
	recentAvatars,
	refreshDue,
	type RecentAvatar,
} from "../../js/avatars/own";
import {avatarsEnabled, setAvatarsEnabled} from "../../js/avatars/prefs";
import {avatarOf} from "../../js/avatars/registry";
import {avatarLinkProblem, parseAvatarUrl} from "../../js/avatars/url";
import {filehostHost} from "../../js/avatars/view";

export default defineComponent({
	name: "AvatarSettings",
	components: {Avatar, AvatarCrop},
	props: {
		uuid: {type: String, required: true},
		/** Replaces "Your avatar" as the heading (the network's name, on the Avatar tab). */
		heading: {type: String, required: false},
	},
	setup(props) {
		const {t, tCount} = useI18n();
		const store = useStore();
		const network = computed(() => store.getters.findNetwork(props.uuid));
		const networkName = computed(() => network.value?.name ?? "");
		const nick = computed(() => network.value?.nick ?? "");
		const connected = computed(() => !!network.value?.status.connected);
		const enabled = computed(() => avatarsEnabled(props.uuid));
		const client = () => clientForNetwork(props.uuid);

		const supported = computed(
			() =>
				connected.value &&
				!!client()?.caps.hasCapability("draft/metadata-2") &&
				// re-read when the network's state changes
				network.value !== undefined
		);
		const editable = computed(() => enabled.value && supported.value);
		const uploadable = computed(() => editable.value && canUpload(client()));

		const current = computed(() =>
			nick.value ? avatarOf(props.uuid, nick.value)?.value ?? "" : ""
		);
		const currentHost = computed(() => parseAvatarUrl(current.value)?.host ?? "");

		const recent = ref<RecentAvatar[]>([]);
		const currentRecent = computed(() => recent.value.find((r) => r.url === current.value));
		const reload = async () => {
			recent.value = await recentAvatars(props.uuid);
		};

		// Re-read now and then while open: the probe and the refresh run behind it.
		const now = ref(Date.now());
		let tick: number | undefined;
		onMounted(() => {
			void reload();
			tick = window.setInterval(() => (now.value = Date.now()), 30_000);
		});
		onBeforeUnmount(() => window.clearInterval(tick));
		watch(current, () => void reload());

		const unavailable = computed(
			() =>
				!!current.value &&
				avatarUnavailable(props.uuid, parseAvatarUrl(current.value)?.href ?? "", now.value)
		);

		const busy = ref(false);
		const status = ref("");
		const linkOpen = ref(false);
		const link = ref("");
		const cropFile = ref<File | null>(null);
		const fileInput = ref<HTMLInputElement>();

		const helpText = computed(() =>
			t("avatar.help", {network: networkName.value || t("avatar.thisNetwork")})
		);

		const notEditableText = computed(() =>
			connected.value ? t("avatar.unsupported") : t("avatar.connectFirst")
		);

		const retentionNote = computed(() => {
			const days = retentionDays();
			return uploadable.value && days > 0 ? tCount("avatar.retentionNote", days) : "";
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
			const trusted = host && host === filehostHost(store, props.uuid);
			return host && !trusted ? t("avatar.linkElsewhere", {host}) : t("avatar.linkRules");
		});

		const run = async (work: () => Promise<unknown>, done: string) => {
			busy.value = true;
			status.value = t("avatar.saving");

			try {
				await work();
				status.value = done;
			} catch (e: unknown) {
				const reason = e instanceof Error ? e.message : String(e);
				status.value = t("avatar.failed", {reason});
			} finally {
				busy.value = false;
				await reload();
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

		const onCropped = (blob: Blob) => {
			cropFile.value = null;
			const c = client();

			if (!c) {
				return;
			}

			void run(async () => {
				const url = await uploadAvatar(c, blob);
				await useAvatar(c, url, {uploaded: true, blob});
			}, t("avatar.saved"));
		};

		const saveLink = () => {
			const c = client();
			const parsed = parseAvatarUrl(link.value);

			if (!c || !parsed || linkProblem.value) {
				return;
			}

			void run(async () => {
				await useAvatar(c, parsed.href, {uploaded: false});
				linkOpen.value = false;
				link.value = "";
			}, t("avatar.saved"));
		};

		const remove = () => {
			const c = client();

			if (c) {
				void run(() => setOwnAvatar(c, ""), t("avatar.removed"));
			}
		};

		const useRecent = (rec: RecentAvatar) => {
			const c = client();

			if (!c || rec.url === current.value) {
				return;
			}

			// An upload the host may have deleted by now goes up again.
			const stale = rec.uploaded && refreshDue(rec, Date.now(), retentionDays());
			void run(
				() =>
					stale && rec.blob && canUpload(c)
						? reupload(c, rec)
						: useAvatar(c, rec.url, {uploaded: rec.uploaded, blob: rec.blob}),
				t("avatar.saved")
			);
		};

		const reuploadCurrent = () => {
			const c = client();
			const rec = currentRecent.value;

			if (c && rec) {
				void run(() => reupload(c, rec), t("avatar.saved"));
			}
		};

		const forget = async (rec: RecentAvatar) => {
			await forgetRecentAvatar(rec.id);
			await reload();
		};

		const toggle = (event: Event) => {
			const on = (event.target as HTMLInputElement).checked;
			setAvatarsEnabled(props.uuid, on);
			const c = client();

			if (c) {
				applyAvatarsEnabled(c, on);
			}
		};

		// The picture of a recent avatar: its kept copy where there is one,
		// so the strip never fetches anything.
		const blobUrls = new Map<string, string>();
		const recentSrc = (rec: RecentAvatar) => {
			if (!rec.blob) {
				return rec.url;
			}

			let url = blobUrls.get(rec.id);

			if (!url) {
				url = URL.createObjectURL(rec.blob);
				blobUrls.set(rec.id, url);
			}

			return url;
		};
		onBeforeUnmount(() => {
			for (const url of blobUrls.values()) {
				URL.revokeObjectURL(url);
			}
		});

		const recentDate = (rec: RecentAvatar) =>
			rec.url === current.value
				? t("avatar.current")
				: new Date(rec.setAt).toLocaleDateString(undefined, {
						month: "short",
						day: "numeric",
				  });

		const recentLabel = (rec: RecentAvatar) =>
			rec.url === current.value
				? t("avatar.current")
				: t("avatar.useRecent", {date: recentDate(rec)});

		return {
			t,
			networkName,
			nick,
			enabled,
			editable,
			uploadable,
			current,
			currentHost,
			currentRecent,
			recent,
			unavailable,
			busy,
			status,
			linkOpen,
			link,
			linkProblem,
			linkNote,
			cropFile,
			fileInput,
			helpText,
			notEditableText,
			retentionNote,
			onFile,
			onCropped,
			saveLink,
			remove,
			useRecent,
			reuploadCurrent,
			forget,
			toggle,
			recentSrc,
			recentDate,
			recentLabel,
		};
	},
});
</script>
