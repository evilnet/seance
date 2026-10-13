<template>
	<div>
		<h2>Push Notifications</h2>
		<div>
			<div class="push-networks-hint">
				Push is set up per network — turn it on or off in each network's settings (Edit
				network → “Push notifications for this network”), where the enrollment status is
				also shown. The browser delivers the notifications; each push-capable server decides
				whether to wake this app.
			</div>
			<div
				id="label-push-key-change"
				class="push-networks-hint"
				role="heading"
				aria-level="3"
			>
				When a server's push identity (its key) changes, this device's subscription for it
				stops working. Then:
			</div>
			<div role="group" aria-labelledby="label-push-key-change">
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'ask'"
						type="radio"
						name="pushKeyChange"
						value="ask"
					/>
					Wary — ask before renewing the subscription
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'trust'"
						type="radio"
						name="pushKeyChange"
						value="trust"
					/>
					Naive — renew it on the spot, without asking
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'ignore'"
						type="radio"
						name="pushKeyChange"
						value="ignore"
					/>
					Suspicious — leave it alone; push from that server stays off until you renew
					from the network settings
				</label>
			</div>
			<div v-if="store.state.pushNotificationState === 'subscribed'" class="opt">
				<div>Snooze pushes everywhere:</div>
				<div class="push-snooze">
					<button type="button" class="btn" @click.prevent="snooze(15 * 60 * 1000)">
						15 min
					</button>
					<button type="button" class="btn" @click.prevent="snooze(60 * 60 * 1000)">
						1 hour
					</button>
					<button type="button" class="btn" @click.prevent="snooze(8 * 60 * 60 * 1000)">
						8 hours
					</button>
					<button type="button" class="btn" @click.prevent="snooze(0)">Off</button>
				</div>
			</div>
			<div v-if="store.state.pushNotificationState === 'stale'" id="pushStale" class="error">
				<strong>Warning</strong>: A server's push identity (its key) changed, so this
				device's push subscription for it no longer works. Renew it from that network's
				settings (Edit network → “Renew push notifications”) to keep being notified while
				the app is closed.
			</div>
			<div v-if="store.state.pushNotificationState === 'unsupported'" class="error">
				Push notifications are not supported by this browser (they need the Push API, a
				service worker and a secure context).
			</div>
			<div v-if="store.state.pushNotificationState === 'not-installed'" class="error">
				<strong>Warning</strong>: On iOS, push notifications are only available after
				installing the app to the Home Screen (Share → Add to Home Screen).
			</div>
			<div v-if="store.state.pushNotificationState === 'denied'" class="error">
				<template v-if="androidShell">
					<strong>Warning</strong>: Notifications are turned off for this app. Allow them
					in Android's settings for the app, then try again.
				</template>
				<template v-else>
					<strong>Warning</strong>: Notifications are blocked by your browser. Allow them
					in the browser's site settings, then try again.
				</template>
			</div>
			<div v-if="store.state.pushNotificationState === 'server-unsupported'" class="error">
				Push notifications need a connected server that supports the draft/webpush
				capability and you to be logged in to an account.
			</div>
			<div v-if="store.state.pushNotificationState === 'blocked'" class="error">
				<strong>Warning</strong>: The server refused the push subscription. It may require
				logging in (SASL) before subscribing.
			</div>
		</div>

		<h2>Browser Notifications</h2>
		<div>
			<div class="push-networks-hint">
				Browser notifications are also per network — enabled by default, toggled in each
				network's settings (Edit network → “Browser notifications for this network”).
			</div>
			<div v-if="store.state.desktopNotificationState === 'unsupported'" class="error">
				<strong>Warning</strong>: Notifications are not supported by your browser.
			</div>
			<div v-if="store.state.desktopNotificationState === 'nohttps'" class="error">
				<strong>Warning</strong>: Notifications are only supported over HTTPS connections.
			</div>
			<div v-if="store.state.desktopNotificationState === 'blocked'" class="error">
				<strong>Warning</strong>: Notifications are blocked by your browser.
			</div>
		</div>
		<div>
			<label class="opt">
				<input
					v-switch
					:checked="store.state.settings.notification"
					type="checkbox"
					name="notification"
				/>
				Enable notification sound
			</label>
		</div>
		<div>
			<div class="opt">
				<button id="play" @click.prevent="playNotification">Play sound</button>
			</div>
		</div>

		<div>
			<label class="opt">
				<input
					v-switch
					:checked="store.state.settings.notifyAllMessages"
					type="checkbox"
					name="notifyAllMessages"
				/>
				Enable notification for all messages
			</label>
		</div>

		<div>
			<label class="opt">
				<input
					v-switch
					:checked="store.state.settings.highlightMessages"
					type="checkbox"
					name="highlightMessages"
				/>
				Highlight messages that mention you
				<span
					class="tooltipped tooltipped-n tooltipped-no-delay"
					aria-label="Messages that mention you or match a custom highlight get a
colored background and border in the channel."
				>
					<button class="extra-help" />
				</span>
			</label>
		</div>

		<div v-if="!store.state.serverConfiguration?.public">
			<label class="opt">
				<label for="highlights" class="opt">
					Custom highlights
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						aria-label="If a message contains any of these comma-separated
expressions, it will trigger a highlight."
					>
						<button class="extra-help" />
					</span>
				</label>
				<input
					id="highlights"
					:value="store.state.settings.highlights"
					type="text"
					name="highlights"
					class="input"
					autocomplete="off"
					placeholder="Comma-separated, e.g.: word, some more words, anotherword"
				/>
			</label>
		</div>

		<div v-if="!store.state.serverConfiguration?.public">
			<label class="opt">
				<label for="highlightExceptions" class="opt">
					Highlight exceptions
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						aria-label="If a message contains any of these comma-separated
expressions, it will not trigger a highlight even if it contains
your nickname or expressions defined in custom highlights."
					>
						<button class="extra-help" />
					</span>
				</label>
				<input
					id="highlightExceptions"
					:value="store.state.settings.highlightExceptions"
					type="text"
					name="highlightExceptions"
					class="input"
					autocomplete="off"
					placeholder="Comma-separated, e.g.: word, some more words, anotherword"
				/>
			</label>
		</div>
	</div>
</template>

<script lang="ts">
import {defineComponent, onMounted} from "vue";
import {useStore} from "../../js/store";
import webpush from "../../js/webpush";
import {isAndroidShell} from "../../js/helpers/capacitor";

export default defineComponent({
	name: "NotificationSettings",
	setup() {
		const store = useStore();

		const snooze = (ms: number) => {
			webpush.setSnooze(ms);
		};

		onMounted(() => {
			webpush.refresh();
		});

		const playNotification = () => {
			const pop = new Audio();
			pop.src = "audio/pop.wav";

			// eslint-disable-next-line
			pop.play();
		};

		return {
			store,
			androidShell: isAndroidShell(),
			playNotification,
			snooze,
		};
	},
});
</script>
