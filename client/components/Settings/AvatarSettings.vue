<template>
	<section class="avatar-settings" :aria-labelledby="headingId">
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
			<div v-if="subject && enabled" :class="['avatar-settings-preview', {busy}]">
				<Avatar
					v-if="!channel || current"
					:uuid="uuid"
					:nick="subject"
					:self="!channel"
					size="large"
				/>
				<!-- A channel without one: what its row in the channel list shows
				     now, its topic's emoji or the bubbles (Channel.vue). -->
				<span
					v-else
					class="avatar avatar-large avatar-tile avatar-settings-placeholder"
					aria-hidden="true"
					><span v-if="channelEmoji" class="avatar-settings-placeholder-emoji">{{
						channelEmoji
					}}</span></span
				>
			</div>
			<div class="avatar-settings-body">
				<h3 :id="headingId">{{ headingText }}</h3>
				<p class="avatar-settings-help">{{ helpText }}</p>
				<p v-if="channel" class="avatar-settings-note">{{ t("avatar.channelKeepNote") }}</p>
				<p v-if="retentionNote" class="avatar-settings-note">{{ retentionNote }}</p>
				<div v-if="veiledHost" class="avatar-settings-veiled">
					<p>{{ t("avatar.channelVeiled", {host: veiledHost}) }}</p>
					<button type="button" class="btn btn-sm" @click="showOnce">
						{{ t("avatar.showOnce") }}
					</button>
				</div>
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
						ref="linkToggle"
						type="button"
						class="btn btn-sm"
						:aria-expanded="linkOpen"
						:disabled="busy"
						@click="toggleLink"
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
				<p v-if="uploadNeedsAccount" class="avatar-settings-note">
					{{ t("avatar.uploadNeedsAccount") }}
				</p>
				<!-- Next to the buttons that caused it. An error is its own
				     element, so a screen reader is told as it appears. -->
				<p
					v-if="status && statusKind === 'error'"
					class="avatar-settings-status is-error"
					role="alert"
				>
					{{ status }}
				</p>
				<p
					v-else-if="status"
					:class="['avatar-settings-status', `is-${statusKind}`]"
					role="status"
				>
					{{ status }}
				</p>
			</div>
		</div>

		<form v-if="linkOpen && editable" class="avatar-settings-link" @submit.prevent="saveLink">
			<label :for="linkId">{{ t("avatar.linkLabel") }}</label>
			<div class="avatar-settings-link-row">
				<input
					:id="linkId"
					ref="linkInput"
					v-model="link"
					class="input"
					type="url"
					dir="ltr"
					inputmode="url"
					spellcheck="false"
					autocapitalize="off"
					placeholder="https://"
				/>
				<span class="avatar-settings-link-actions">
					<button
						type="submit"
						class="btn btn-sm avatar-settings-save"
						:disabled="busy || !!linkProblem"
					>
						{{ t("avatar.save") }}
					</button>
					<button type="button" class="btn btn-sm" :disabled="busy" @click="closeLink">
						{{ t("confirm.cancel") }}
					</button>
				</span>
			</div>
			<p class="avatar-settings-note">{{ linkNote }}</p>
		</form>

		<div v-if="editable && recent.length > 0" class="avatar-settings-recent">
			<h4>{{ t("avatar.recent") }}</h4>
			<ul>
				<li v-for="rec in recent" :key="rec.id">
					<button
						type="button"
						class="avatar-recent"
						:aria-pressed="rec.url === current"
						:aria-label="recentLabel(rec)"
						:title="recentLabel(rec)"
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
			<p class="avatar-settings-note">
				{{ channel ? t("avatar.channelRecentNote") : t("avatar.recentNote") }}
			</p>
		</div>

		<label v-if="!channel" class="avatar-settings-switch">
			<input v-switch type="checkbox" :checked="enabled" @change="toggle" />
			{{ t("avatar.showOnNetwork", {network: networkName}) }}
		</label>

		<AvatarCrop
			v-if="cropFile"
			:file="cropFile"
			:title="channel ? t('avatar.channelCropTitle') : ''"
			@done="onCropped"
			@cancel="cropFile = null"
		/>
	</section>
</template>

<style>
.avatar-settings {
	display: flex;
	flex-direction: column;
	gap: 0.875rem;
	padding: 0.875rem 0 0.25rem;

	/* Narrow (a phone, a large font): the picture goes above the text. */
	/* stylelint-disable-next-line property-no-unknown */
	container-type: inline-size;
	/* stylelint-disable-next-line property-no-unknown */
	container-name: avatar-settings;
}

.avatar-settings-main {
	display: flex;
	gap: 1.25rem;
	align-items: center;
}

@container avatar-settings (max-width: 26rem) {
	.avatar-settings-main {
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
	}
}

/* While a change is on its way, the picture it replaces steps back. */
.avatar-settings-preview {
	flex: none;
	transition: opacity 0.2s;
}

.avatar-settings-preview.busy {
	opacity: 0.5;
}

html[data-reduce-motion] .avatar-settings-preview {
	transition: none;
}

.avatar-settings-placeholder::before {
	font-family: FontAwesome;
	font-weight: normal;
	content: "\f086"; /* https://fontawesome.com/icons/comments?style=solid, as the channel list */
}

.avatar-settings-placeholder:has(.avatar-settings-placeholder-emoji)::before {
	content: none;
}

.avatar-settings-placeholder-emoji {
	font-family: var(--emoji-font);
	font-size: 2.75rem;
	font-weight: normal;
}

.avatar-settings-veiled {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 0.375rem;
	padding: 0.625rem 0.75rem;
	border-radius: 0.5rem;
	background: rgb(128 128 128 / 12%);
}

.avatar-settings-veiled p {
	font-size: 0.8125rem;
	line-height: 1.4;
	color: var(--body-color-muted);
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

.avatar-settings h3 {
	font-weight: 600;
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

/* Done reads as plainly as the text around it; a failure as a failure. */
.avatar-settings-status.is-ok {
	color: var(--body-color);
}

.avatar-settings-status.is-error {
	padding: 0.375rem 0.625rem;
	border-radius: 0.25rem;
	color: var(--error-fg, #a94442);
	background-color: var(--error-bg, #f2dede);
}

/* style.css gives a disabled .btn its hover fill, which looks pressed. */
.avatar-settings .btn:disabled {
	background: none;
	color: inherit;
	opacity: 0.5;
	cursor: default;
}

.avatar-settings .btn.avatar-settings-save:not(:disabled) {
	background: var(--button-color);
	color: var(--button-text-color-hover);
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
	flex-wrap: wrap;
	gap: 0.5rem;
}

/* Save and Cancel wrap under the field together, never one without the other. */
.avatar-settings-link-actions {
	display: flex;
	gap: 0.5rem;
}

.avatar-settings-link-row .input {
	flex: 1 1 12rem;
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
// With `channel`, the same for that channel's avatar (ChannelAvatarDialog.vue),
// which its half-ops and ops (and IRC operators) can change.
import {computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue";
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
import {
	applyAvatarsEnabled,
	AvatarSetError,
	canSetChannelAvatar,
	setChannelAvatar,
	setOwnAvatar,
} from "../../js/irc/avatars";
import {namesEqual} from "../../js/irc/casemap";
import {leadingEmoji} from "../../js/helpers/emoji";
import {canSetBans} from "../../js/helpers/banMenu";
import {
	avatarUnavailable,
	forgetRecentAvatar,
	recentAvatars,
	refreshDue,
	type RecentAvatar,
} from "../../js/avatars/own";
import {avatarsEnabled, loadOnce, setAvatarsEnabled} from "../../js/avatars/prefs";
import {avatarOf} from "../../js/avatars/registry";
import {avatarLinkProblem, parseAvatarUrl} from "../../js/avatars/url";
import {filehostHost, viewFor} from "../../js/avatars/view";

export default defineComponent({
	name: "AvatarSettings",
	components: {Avatar, AvatarCrop},
	props: {
		uuid: {type: String, required: true},
		/** Replaces "Your avatar" as the heading (the network's name, on the Avatar tab). */
		heading: {type: String, required: false},
		/** The channel whose avatar this sets, instead of our own. */
		channel: {type: String, required: false},
	},
	/** `busy`: a change is on its way (ChannelAvatarDialog.vue stays open for it). */
	emits: ["busy"],
	setup(props, {emit}) {
		const {t, tCount} = useI18n();
		const store = useStore();
		const network = computed(() => store.getters.findNetwork(props.uuid));
		const networkName = computed(() => network.value?.name ?? "");
		const nick = computed(() => network.value?.nick ?? "");
		const connected = computed(() => !!network.value?.status.connected);
		const enabled = computed(() => avatarsEnabled(props.uuid));
		const client = () => clientForNetwork(props.uuid);
		/** Whose avatar: the channel's, or ours (our nick). */
		const subject = computed(() => props.channel ?? nick.value);
		const idSuffix = computed(() => props.uuid + (props.channel ? `-${props.channel}` : ""));
		const headingId = computed(() => `avatar-settings-${idSuffix.value}`);
		const linkId = computed(() => `avatar-link-${idSuffix.value}`);
		const headingText = computed(() =>
			props.channel
				? t("avatar.channelHeading", {channel: props.channel})
				: props.heading || t("avatar.heading")
		);

		// The server takes a channel's avatar from its members who are half-ops
		// and ops, or global IRC operators. The IRC client knows our modes in
		// every channel (the store only in one that has been opened); the
		// store's are read so that this follows a change while the dialog is
		// up, as is our oper level.
		const mayChange = computed(() => {
			if (!props.channel) {
				return true;
			}

			const c = client();
			const net = network.value;
			void net?.oper?.level;
			return (
				(!!net && canSetBans(net, props.channel)) ||
				(!!c && net?.status.connected === true && canSetChannelAvatar(c, props.channel))
			);
		});

		const supported = computed(
			() =>
				connected.value &&
				!!client()?.caps.hasCapability("draft/metadata-2") &&
				// re-read when the network's state changes
				network.value !== undefined
		);
		const editable = computed(() => enabled.value && supported.value && mayChange.value);
		const uploadable = computed(() => editable.value && canUpload(client()));

		const current = computed(() =>
			subject.value ? avatarOf(props.uuid, subject.value)?.value ?? "" : ""
		);
		const currentHost = computed(() => parseAvatarUrl(current.value)?.host ?? "");

		const recent = ref<RecentAvatar[]>([]);
		const currentRecent = computed(() => recent.value.find((r) => r.url === current.value));
		const reload = async () => {
			recent.value = await recentAvatars(props.uuid, props.channel);
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

		// Only our own avatar is probed (avatars/actions.ts).
		const unavailable = computed(
			() =>
				!props.channel &&
				!!current.value &&
				avatarUnavailable(props.uuid, parseAvatarUrl(current.value)?.href ?? "", now.value)
		);

		const busy = ref(false);
		const status = ref("");
		/** What the status line says: work under way, done, or a failure. */
		const statusKind = ref<"busy" | "ok" | "error">("busy");
		const linkOpen = ref(false);
		const link = ref("");
		const cropFile = ref<File | null>(null);
		const fileInput = ref<HTMLInputElement>();
		const linkInput = ref<HTMLInputElement>();
		const linkToggle = ref<HTMLButtonElement>();

		watch(busy, (isBusy) => emit("busy", isBusy));

		const setStatus = (kind: "busy" | "ok" | "error", text: string) => {
			statusKind.value = kind;
			status.value = text;
		};

		// The channel as the store has it: its topic's emoji is what the
		// channel list shows while it has no avatar.
		const channelEmoji = computed(() => {
			const net = network.value;

			if (!props.channel || !net) {
				return "";
			}

			const chan = net.channels.find((c) =>
				namesEqual(c.name, props.channel ?? "", net.serverOptions.CASEMAPPING)
			);
			return chan ? leadingEmoji(chan.topic) : "";
		});

		// A channel's picture the reader has not loaded: say where it is and
		// offer to load it, as the user profile does (UserCard.vue).
		const view = computed(() =>
			props.channel ? viewFor(store, {uuid: props.uuid, nick: props.channel}) : null
		);
		const veiledHost = computed(() =>
			view.value?.kind === "veiled" && current.value ? view.value.host : ""
		);
		const showOnce = () => {
			if (view.value?.kind === "veiled") {
				loadOnce(view.value.href);
			}
		};

		const helpText = computed(() =>
			props.channel
				? t("avatar.channelHelp", {channel: props.channel})
				: t("avatar.help", {network: networkName.value || t("avatar.thisNetwork")})
		);

		const notEditableText = computed(() => {
			if (!connected.value) {
				return props.channel ? t("avatar.channelConnectFirst") : t("avatar.connectFirst");
			}

			return supported.value ? t("avatar.channelNotOp") : t("avatar.unsupported");
		});

		const retentionNote = computed(() => {
			const days = retentionDays();

			if (!uploadable.value || days <= 0) {
				return "";
			}

			return props.channel
				? tCount("avatar.channelRetentionNote", days)
				: tCount("avatar.retentionNote", days);
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

			if (!host || trusted) {
				return t("avatar.linkRules");
			}

			return props.channel
				? t("avatar.channelLinkElsewhere", {host})
				: t("avatar.linkElsewhere", {host});
		});

		/** The words for a failed change. */
		const failureText = (e: unknown): string => {
			switch (e instanceof AvatarSetError ? e.code : "") {
				case "timeout":
					return t("avatar.failedTimeout");
				case "closed":
					return t("avatar.failedClosed");
				case "unavailable":
					return t("avatar.failedUnavailable");
				case "unsent":
					return t("avatar.failedUnsent");
				case "KEY_NO_PERMISSION":
					if (props.channel) {
						return t("avatar.channelFailedPermission", {channel: props.channel});
					}

					break;
				default:
					break;
			}

			// The server's own description, or the image host's.
			const reason = e instanceof Error ? e.message : String(e);
			return props.channel
				? t("avatar.channelFailed", {reason})
				: t("avatar.failed", {reason});
		};

		const run = async (
			work: () => Promise<unknown>,
			done: string,
			first = t("avatar.saving")
		) => {
			busy.value = true;
			setStatus("busy", first);

			try {
				await work();
				setStatus("ok", done);
			} catch (e: unknown) {
				setStatus("error", failureText(e));
			} finally {
				busy.value = false;
				await reload();
			}
		};

		// The network has an image host, but uploading to it takes an account.
		const uploadNeedsAccount = computed(() => {
			const c = client();
			return editable.value && !uploadable.value && !!c?.filehostUrl() && !c.account;
		});

		// "Use a link": its field takes the caret as it opens, and a stale
		// status goes with a fresh start.
		const toggleLink = () => {
			linkOpen.value = !linkOpen.value;
			status.value = "";
		};

		const closeLink = () => {
			linkOpen.value = false;
			link.value = "";
			void nextTick(() => linkToggle.value?.focus());
		};

		watch(linkOpen, (open) => {
			if (open) {
				void nextTick(() => linkInput.value?.focus());
			}
		});

		const savedText = () => (props.channel ? t("avatar.channelSaved") : t("avatar.saved"));

		const onFile = (event: Event) => {
			const input = event.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";

			if (file) {
				status.value = "";
				linkOpen.value = false;
				cropFile.value = file;
			}
		};

		const onCropped = (blob: Blob) => {
			cropFile.value = null;
			const c = client();

			if (!c) {
				return;
			}

			void run(
				async () => {
					const url = await uploadAvatar(c, blob);
					setStatus("busy", t("avatar.saving"));
					await useAvatar(c, url, {uploaded: true, blob, channel: props.channel});
				},
				savedText(),
				t("avatar.uploading")
			);
		};

		const saveLink = () => {
			const c = client();
			const parsed = parseAvatarUrl(link.value);

			if (!c || !parsed || linkProblem.value) {
				return;
			}

			void run(async () => {
				await useAvatar(c, parsed.href, {uploaded: false, channel: props.channel});
				linkOpen.value = false;
				link.value = "";
			}, savedText()).then(() => {
				// Saved, the form went: the caret goes back to what opened it,
				// once that is enabled again. A failure leaves it in the form.
				if (!linkOpen.value) {
					void nextTick(() => linkToggle.value?.focus());
				}
			});
		};

		const remove = () => {
			const c = client();

			if (c && props.channel) {
				void run(() => setChannelAvatar(c, props.channel!, ""), t("avatar.channelRemoved"));
			} else if (c) {
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
						: useAvatar(c, rec.url, {
								uploaded: rec.uploaded,
								blob: rec.blob,
								channel: props.channel,
						  }),
				savedText()
			);
		};

		const reuploadCurrent = () => {
			const c = client();
			const rec = currentRecent.value;

			if (c && rec) {
				void run(() => reupload(c, rec), savedText());
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
			subject,
			headingId,
			linkId,
			headingText,
			statusKind,
			linkInput,
			linkToggle,
			channelEmoji,
			veiledHost,
			showOnce,
			uploadNeedsAccount,
			toggleLink,
			closeLink,
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
