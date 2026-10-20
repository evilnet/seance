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
			<div class="dnd-schedule">
				<label class="opt">
					<input
						v-switch
						type="checkbox"
						:checked="schedule.enabled"
						@change="update({enabled: ($event.target as HTMLInputElement).checked})"
					/>
					Do not disturb on a schedule
				</label>
				<!-- Inactive while the schedule is off: dimmed and disabled. -->
				<fieldset
					:class="['dnd-schedule-fields', {disabled: !schedule.enabled}]"
					:disabled="!schedule.enabled"
				>
					<div class="dnd-times">
						<label
							>From
							<input
								type="time"
								aria-label="Do not disturb from"
								:value="schedule.start"
								@change="setTime('start', $event)"
						/></label>
						<label
							>until
							<input
								type="time"
								aria-label="Do not disturb until"
								:value="schedule.end"
								@change="setTime('end', $event)"
						/></label>
					</div>
					<div class="dnd-days" role="group" aria-label="Days">
						<label v-for="(name, day) in DAYS" :key="day">
							<input
								v-switch
								type="checkbox"
								:aria-label="DAY_FULL_NAMES[day]"
								:checked="schedule.days.includes(day)"
								@change="toggleDay(day)"
							/>
							{{ name }}
						</label>
					</div>
				</fieldset>
				<p class="dnd-schedule-hint">
					While do not disturb is on, you show as away and nothing alerts you here or
					through push. Push stops on all your devices signed in to the same account. If
					no {{ appName }} is open when a scheduled window starts, push stops once one
					opens. Same start and end: all day.
				</p>
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
			<!-- The shells notify through the OS (helpers/nativeAlerts.ts). -->
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'unsupported'"
				class="error"
			>
				<strong>Warning</strong>: Notifications are not supported by your browser.
			</div>
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'nohttps'"
				class="error"
			>
				<strong>Warning</strong>: Notifications are only supported over HTTPS connections.
			</div>
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'blocked'"
				class="error"
			>
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
import {computed, defineComponent, onMounted} from "vue";
import {useStore} from "../../js/store";
import webpush from "../../js/webpush";
import dnd from "../../js/dnd";
import {DAYS, DAY_FULL_NAMES, HHMM, type DndSchedule} from "../../js/helpers/dnd";
import {isAndroidShell} from "../../js/helpers/capacitor";
import {nativeAlertsAvailable} from "../../js/helpers/nativeAlerts";
import {playNotificationSound} from "../../js/helpers/notificationSound";

export default defineComponent({
	name: "NotificationSettings",
	setup() {
		const store = useStore();

		// The do-not-disturb schedule (client/js/dnd.ts); every edit saves at once.
		const schedule = computed(() => dnd.state.schedule);
		const update = (patch: Partial<DndSchedule>) =>
			dnd.setSchedule({...dnd.state.schedule, ...patch});

		// A cleared time field reports "": keep the stored time and show it again.
		const setTime = (field: "start" | "end", event: Event) => {
			const input = event.target as HTMLInputElement;

			if (!HHMM.test(input.value)) {
				input.value = schedule.value[field];
				return;
			}

			update(field === "start" ? {start: input.value} : {end: input.value});
		};

		const toggleDay = (day: number) => {
			const days = schedule.value.days.includes(day)
				? schedule.value.days.filter((d) => d !== day)
				: [...schedule.value.days, day].sort((a, b) => a - b);
			update({days});
		};

		onMounted(() => {
			webpush.refresh();
		});

		const playNotification = () => {
			void playNotificationSound().catch(() => undefined);
		};

		return {
			store,
			androidShell: isAndroidShell(),
			nativeShell: nativeAlertsAvailable(),
			playNotification,
			// Sunday = 0, the day a window starts on (helpers/dnd.ts DndSchedule.days).
			DAYS,
			DAY_FULL_NAMES,
			appName: computed(() => store.state.branding.appName),
			schedule,
			update,
			setTime,
			toggleDay,
		};
	},
});
</script>
