<template>
	<div>
		<div v-if="canRegisterProtocol || store.state.installPromptAvailable">
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
	</div>
</template>

<style></style>

<script lang="ts">
import {computed, defineComponent, onMounted, ref} from "vue";
import {useStore} from "../../js/store";
import {promptInstall} from "../../js/pwa";

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

		return {
			appName,
			store,
			canRegisterProtocol,
			nativeInstallPrompt,
			registerProtocol,
		};
	},
});
</script>
