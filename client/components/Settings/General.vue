<template>
	<div>
		<div v-if="canRegisterProtocol || store.state.installPromptAvailable || canShowGuide">
			<h2>{{ t("settings.general.nativeApp") }}</h2>
			<button
				v-if="store.state.installPromptAvailable"
				type="button"
				class="btn"
				@click.prevent="nativeInstallPrompt"
			>
				{{ t("settings.general.installApp", {appName}) }}
			</button>
			<button
				v-if="canRegisterProtocol"
				type="button"
				class="btn"
				@click.prevent="registerProtocol"
			>
				{{ t("settings.general.openLinks", {appName}) }}
			</button>
			<button
				v-if="canShowGuide"
				id="show-install-guide"
				type="button"
				class="btn"
				@click.prevent="showInstallGuide"
			>
				{{ t("settings.general.installGuide", {appName}) }}
			</button>
		</div>
		<div v-if="keepAliveAvailable">
			<h2>{{ t("settings.general.keepAliveHeading") }}</h2>
			<div>
				<label class="opt">
					<input
						v-switch
						:checked="store.state.settings.keepConnected"
						type="checkbox"
						name="keepConnected"
					/>
					{{ t("settings.general.keepAlive") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="keepAliveHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
				<p
					v-if="
						store.state.settings.keepConnected &&
						keepAliveStatus?.notifications === false
					"
					class="keepalive-hint"
				>
					{{ t("settings.general.keepAliveNotificationsOff", {appName}) }}
				</p>
			</div>
		</div>
		<div v-if="store.state.serverConfiguration?.fileUpload">
			<h2>{{ t("settings.general.uploadsHeading") }}</h2>
			<div>
				<label class="opt">
					<input
						v-switch
						:checked="store.state.settings.uploadCanvas"
						type="checkbox"
						name="uploadCanvas"
					/>
					{{ t("settings.general.uploadCanvas") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="uploadCanvasHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
			</div>
		</div>
		<div>
			<h2>{{ t("settings.general.typingHeading") }}</h2>
			<div>
				<label class="opt">
					<input
						v-switch
						:checked="store.state.settings.sendTypingNotifications"
						type="checkbox"
						name="sendTypingNotifications"
					/>
					{{ t("settings.general.sendTyping") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="sendTypingHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
			</div>
		</div>
		<div>
			<h2>{{ t("settings.general.privateHeading") }}</h2>
			<div>
				<label class="opt">
					<input
						v-switch
						:checked="store.state.settings.keepPrivateConversations"
						type="checkbox"
						name="keepPrivateConversations"
					/>
					{{ t("settings.general.keepPrivate") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="keepPrivateHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
			</div>
		</div>
		<div v-if="!store.state.serverConfiguration?.public">
			<h2>{{ t("settings.general.awayHeading") }}</h2>

			<label class="opt">
				<label for="awayMessage" class="sr-only">{{
					t("settings.general.awayHeading")
				}}</label>
				<input
					id="awayMessage"
					dir="auto"
					:value="store.state.settings.awayMessage"
					type="text"
					name="awayMessage"
					class="input"
					:placeholder="awayPlaceholder"
				/>
			</label>
		</div>
		<div class="settings-backup">
			<h2>{{ t("settings.general.backupHeading") }}</h2>
			<p>{{ t("settings.general.backupIntro") }}</p>
			<label class="opt">
				<input v-model="includePasswords" v-switch type="checkbox" />
				{{ t("settings.general.includePasswords") }}
				<span
					class="tooltipped tooltipped-n tooltipped-no-delay"
					:aria-label="includePasswordsHelp"
				>
					<button class="extra-help" />
				</span>
			</label>
			<div class="opt">
				<button type="button" class="btn" :disabled="busy" @click.prevent="download">
					{{ t("settings.general.export") }}
				</button>
				<button type="button" class="btn" :disabled="busy" @click.prevent="pickFile">
					{{ t("settings.general.import") }}
				</button>
				<input
					ref="fileInput"
					type="file"
					class="sr-only"
					:aria-label="fileAriaLabel"
					:accept="`${fileExtension},application/json`"
					@change="onFileChosen"
				/>
			</div>
			<p v-if="error" class="settings-backup-error" role="alert">{{ error }}</p>
		</div>
	</div>
</template>

<style>
#settings .settings-backup p {
	color: var(--body-color-muted);
}

#settings .settings-backup .settings-backup-error {
	padding: 0.5em 0.75em;
	border-radius: 0.25em;
	color: var(--error-fg, #a94442);
	background-color: var(--error-bg, #f2dede);
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, ref} from "vue";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import {canDescribeInstall, openInstallGuide, promptInstall} from "../../js/pwa";
import {MAX_MESSAGES, MAX_QUERIES} from "../../js/irc/querylog";
import {
	keepAliveAvailable as isKeepAliveAvailable,
	keepAliveStatus as fetchKeepAliveStatus,
	onKeepAliveStatus,
	type KeepAliveStatus,
} from "../../js/helpers/keepAlive";
import eventbus from "../../js/eventbus";
import {currentPlatform} from "../../js/helpers/platformDefaults";
import {createState} from "../../js/settings";
import {
	applyBackup,
	BackupFormatError,
	BackupStorageError,
	BackupFormatErrorCode,
	collectBackup,
	decodeBackup,
	encodeBackup,
	FILE_EXTENSION,
	fileName,
	hasPasswords,
	networkCount,
	SettingsBackup,
} from "../../js/helpers/settingsBackup";

export default defineComponent({
	name: "GeneralSettings",
	setup() {
		const store = useStore();
		const {t, tCount, locale} = useI18n();
		const appName = computed(() => store.state.branding.appName);
		const uploadCanvasHelp = computed(() => t("settings.general.uploadCanvasHelp"));
		const keepAliveHelp = computed(() => t("settings.general.keepAliveHelp"));
		const sendTypingHelp = computed(() => t("settings.general.sendTypingHelp"));
		const keepPrivateHelp = computed(() =>
			t("settings.general.keepPrivateHelp", {lines: MAX_MESSAGES, queries: MAX_QUERIES})
		);
		const awayPlaceholder = computed(() =>
			t("settings.general.awayPlaceholder", {appName: appName.value})
		);
		const includePasswordsHelp = computed(() => t("settings.general.includePasswordsHelp"));
		const fileAriaLabel = computed(() => t("settings.general.fileAria"));
		const canRegisterProtocol = ref(false);
		const keepAliveAvailable = isKeepAliveAvailable();
		const keepAliveStatus = ref<KeepAliveStatus | null>(null);

		// The status follows every call the shell answers — the toggle's
		// enable resolves only once Android's permission prompt is answered,
		// so the hint below keeps up without polling.
		let stopKeepAlive: (() => void) | null = null;

		onMounted(() => {
			if (keepAliveAvailable) {
				stopKeepAlive = onKeepAliveStatus((status) => {
					keepAliveStatus.value = status;
				});
				void fetchKeepAliveStatus();
			}

			// Enable protocol handler registration if supported,
			// and the network configuration is not locked
			canRegisterProtocol.value =
				!!window.navigator.registerProtocolHandler &&
				!store.state.serverConfiguration?.lockNetwork;
		});

		// The guide re-opens from here after "don't show this again".
		const canShowGuide = ref(false);

		onMounted(() => {
			canShowGuide.value = canDescribeInstall();
		});

		const showInstallGuide = () => {
			openInstallGuide();
		};

		onUnmounted(() => {
			stopKeepAlive?.();
		});

		const nativeInstallPrompt = () => {
			// The store flag (and so the button) clears as soon as the prompt
			// is shown; Chrome fires a new beforeinstallprompt if dismissed.
			void promptInstall();
		};

		// `web+irc:`, not `irc:`/`ircs:`: those promise a TCP connection we
		// cannot make, and a web app may only claim `web+…` schemes anyway
		// (docs/resources/irc-links.md).
		const registerProtocol = () => {
			const uri = document.location.origin + document.location.pathname + "?uri=%s";
			// @ts-expect-error
			// the third argument is deprecated but recommended for compatibility: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/registerProtocolHandler
			window.navigator.registerProtocolHandler("web+irc", uri, appName.value);
		};

		// Settings backup (helpers/settingsBackup.ts). The download is a
		// gzipped JSON file; a restore replaces every covered localStorage
		// entry and reloads, which is how every module re-reads its storage.
		const includePasswords = ref(false);
		const busy = ref(false);
		const error = ref("");
		const fileInput = ref<HTMLInputElement>();

		const download = async () => {
			error.value = "";
			busy.value = true;

			try {
				const backup = collectBackup({
					includePasswords: includePasswords.value,
					settings: {...store.state.settings},
					app: appName.value,
					platform: currentPlatform(),
				});
				const bytes = await encodeBackup(backup);
				const blob = new Blob([bytes as BlobPart], {type: "application/octet-stream"});
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = fileName(appName.value);
				document.body.appendChild(link);
				link.click();
				link.remove();
				// Revoke after the click has had its turn at the URL.
				setTimeout(() => URL.revokeObjectURL(url), 10_000);
			} catch (e) {
				error.value = t("settings.general.exportFailed");
			} finally {
				busy.value = false;
			}
		};

		const pickFile = () => {
			error.value = "";
			fileInput.value?.click();
		};

		/** The day the file was made, in the reader's language — or "" when
		 * the envelope carries no usable date (it is optional, and a hand-made
		 * file can hold anything). */
		const exportedOn = (backup: SettingsBackup): string => {
			if (!backup.exportedAt) {
				return "";
			}

			const when = new Date(backup.exportedAt);

			if (Number.isNaN(when.getTime())) {
				return "";
			}

			return new Intl.DateTimeFormat(locale.value, {dateStyle: "long"}).format(when);
		};

		const describe = (backup: SettingsBackup, name: string) => {
			const networks = networkCount(backup);
			const parts = [
				t("settings.general.backupPartSettings"),
				tCount("settings.general.backupNetworks", networks),
				t("settings.general.backupMutes"),
			];
			// Two whole sentences the dialog may add after the frame's: what
			// the file carries that the reader should know about, and when it
			// was made. The warning went missing when the dialog was
			// localized (the variable was kept and its use was not), and the
			// date sentence went with it. The separating space belongs here,
			// not to the copy: every catalog is a whole sentence of its own.
			// `.trim()` guards a translation that padded itself anyway.
			const sentences = [
				t("settings.general.backupFrame", {parts: parts.join(", "), file: name}),
			];

			if (hasPasswords(backup)) {
				sentences.push(t("settings.general.backupPasswords"));
			}

			const exported = exportedOn(backup);

			if (exported) {
				sentences.push(t("settings.general.backupExported", {date: exported}));
			}

			return sentences.map((sentence) => sentence.trim()).join(" ");
		};

		const restore = (backup: SettingsBackup, name: string) => {
			eventbus.emit(
				"confirm-dialog",
				{
					title: t("settings.general.importTitle"),
					text: describe(backup, name),
					button: t("settings.general.importButton"),
				},
				(confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					// Nothing runs between the write and the reload, so no
					// in-memory state can overwrite the file's entries.
					// Measured against this deploy's defaults, as the
					// migration does (store-settings.ts `migrate`).
					try {
						applyBackup(backup, currentPlatform(), {
							...createState(),
							theme: store.state.serverConfiguration?.defaultTheme,
						});
					} catch (e) {
						// A full device: nothing was changed (settingsBackup.ts).
						error.value =
							e instanceof BackupStorageError
								? t("settings.general.importNoRoom")
								: t("settings.general.importFailed");
						return;
					}

					window.location.reload();
				}
			);
		};

		/** The reader-visible wording for a refused backup file: the Vue-free
		 * module carries stable codes, this is where they become copy. */
		const importErrorText = (code: BackupFormatErrorCode): string => {
			switch (code) {
				case "newer-version":
					return t("settings.general.importNewer");
				case "damaged":
					return t("settings.general.importDamaged");
				case "no-decompression":
					return t("settings.general.importNoDecompression");
				default:
					return t("settings.general.importNotSettings");
			}
		};

		const onFileChosen = async (event: Event) => {
			const input = event.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = ""; // so choosing the same file again fires change

			if (!file) {
				return;
			}

			busy.value = true;

			try {
				const backup = await decodeBackup(new Uint8Array(await file.arrayBuffer()));
				restore(backup, file.name);
			} catch (e) {
				error.value =
					e instanceof BackupFormatError
						? importErrorText(e.code)
						: t("settings.general.importFailed");
			} finally {
				busy.value = false;
			}
		};

		return {
			appName,
			store,
			t,
			uploadCanvasHelp,
			keepAliveHelp,
			sendTypingHelp,
			keepPrivateHelp,
			awayPlaceholder,
			includePasswordsHelp,
			fileAriaLabel,
			canRegisterProtocol,
			canShowGuide,
			showInstallGuide,
			keepAliveAvailable,
			keepAliveStatus,
			nativeInstallPrompt,
			registerProtocol,
			includePasswords,
			busy,
			error,
			fileInput,
			fileExtension: FILE_EXTENSION,
			download,
			pickFile,
			onFileChosen,
		};
	},
});
</script>
