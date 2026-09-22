<template>
	<div>
		<div v-if="canRegisterProtocol || store.state.installPromptAvailable || canShowGuide">
			<h2>Native app</h2>
			<button
				v-if="store.state.installPromptAvailable"
				type="button"
				class="btn"
				@click.prevent="nativeInstallPrompt"
			>
				Install {{ appName }} as an app
			</button>
			<button
				v-if="canRegisterProtocol"
				type="button"
				class="btn"
				@click.prevent="registerProtocol"
			>
				Open web+irc:// links with {{ appName }}
			</button>
			<button
				v-if="canShowGuide"
				id="show-install-guide"
				type="button"
				class="btn"
				@click.prevent="showInstallGuide"
			>
				How to install {{ appName }}
			</button>
		</div>
		<div v-if="store.state.serverConfiguration?.fileUpload">
			<h2>File uploads</h2>
			<div>
				<label class="opt">
					<input
						:checked="store.state.settings.uploadCanvas"
						type="checkbox"
						name="uploadCanvas"
					/>
					Attempt to remove metadata from images before uploading
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						aria-label="This option renders the image into a canvas element to remove metadata from the image.
	This may break orientation if your browser does not support that."
					>
						<button class="extra-help" />
					</span>
				</label>
			</div>
		</div>
		<div>
			<h2>Typing notifications</h2>
			<div>
				<label class="opt">
					<input
						:checked="store.state.settings.sendTypingNotifications"
						type="checkbox"
						name="sendTypingNotifications"
					/>
					Send typing notifications
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						aria-label="Lets people in the channel see when you are typing (IRCv3 +typing)."
					>
						<button class="extra-help" />
					</span>
				</label>
			</div>
		</div>
		<div v-if="!store.state.serverConfiguration?.public">
			<h2>Automatic away message</h2>

			<label class="opt">
				<label for="awayMessage" class="sr-only">Automatic away message</label>
				<input
					id="awayMessage"
					:value="store.state.settings.awayMessage"
					type="text"
					name="awayMessage"
					class="input"
					:placeholder="`Away message if ${appName} is not open`"
				/>
			</label>
		</div>
		<div class="settings-backup">
			<h2>Backup and restore</h2>
			<p>Save your settings to a file. You can restore here or on another device.</p>
			<label class="opt">
				<input v-model="includePasswords" type="checkbox" />
				Include network passwords
				<span
					class="tooltipped tooltipped-n tooltipped-no-delay"
					aria-label="Passwords are stored in the file unencrypted."
				>
					<button class="extra-help" />
				</span>
			</label>
			<div class="opt">
				<button type="button" class="btn" :disabled="busy" @click.prevent="download">
					Export settings…
				</button>
				<button type="button" class="btn" :disabled="busy" @click.prevent="pickFile">
					Import settings…
				</button>
				<input
					ref="fileInput"
					type="file"
					class="sr-only"
					aria-label="Settings file to restore"
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
import {computed, defineComponent, onMounted, ref} from "vue";
import {useStore} from "../../js/store";
import {canDescribeInstall, openInstallGuide, promptInstall} from "../../js/pwa";
import eventbus from "../../js/eventbus";
import {
	applyBackup,
	BackupFormatError,
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
		const appName = computed(() => store.state.branding.appName);
		const canRegisterProtocol = ref(false);

		onMounted(() => {
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
				error.value = "Couldn't create the file.";
			} finally {
				busy.value = false;
			}
		};

		const pickFile = () => {
			error.value = "";
			fileInput.value?.click();
		};

		const describe = (backup: SettingsBackup, name: string) => {
			const networks = networkCount(backup);
			const parts = [
				"your settings",
				networks === 1 ? "1 network" : `${networks} networks`,
				"mutes and ignore lists",
			];
			const passwords = hasPasswords(backup) ? " The file includes network passwords." : "";
			return (
				`This replaces ${parts.join(", ")} with the contents of ${name}, ` +
				`then reloads.${passwords}`
			);
		};

		const restore = (backup: SettingsBackup, name: string) => {
			eventbus.emit(
				"confirm-dialog",
				{
					title: "Import settings?",
					text: describe(backup, name),
					button: "Import and reload",
				},
				(confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					// Nothing runs between the write and the reload, so no
					// in-memory state can overwrite the file's entries.
					applyBackup(backup);
					window.location.reload();
				}
			);
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
					e instanceof BackupFormatError ? e.message : "Couldn't read the file.";
			} finally {
				busy.value = false;
			}
		};

		return {
			appName,
			store,
			canRegisterProtocol,
			canShowGuide,
			showInstallGuide,
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
