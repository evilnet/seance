<template>
	<div>
		<h2>{{ t("settings.notifications.pushHeading") }}</h2>
		<div>
			<div class="push-networks-hint">
				{{ t("settings.notifications.pushPerNetwork") }}
			</div>
			<div
				id="label-push-key-change"
				class="push-networks-hint"
				role="heading"
				aria-level="3"
			>
				{{ t("settings.notifications.keyChangeIntro") }}
			</div>
			<div role="group" aria-labelledby="label-push-key-change">
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'ask'"
						type="radio"
						name="pushKeyChange"
						value="ask"
					/>
					{{ t("settings.notifications.keyChangeAsk") }}
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'trust'"
						type="radio"
						name="pushKeyChange"
						value="trust"
					/>
					{{ t("settings.notifications.keyChangeTrust") }}
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.pushKeyChange === 'ignore'"
						type="radio"
						name="pushKeyChange"
						value="ignore"
					/>
					{{ t("settings.notifications.keyChangeIgnore") }}
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
					{{ t("dnd.scheduleToggle") }}
				</label>
				<!-- Inactive while the schedule is off: dimmed and disabled. -->
				<fieldset
					:class="['dnd-schedule-fields', {disabled: !schedule.enabled}]"
					:disabled="!schedule.enabled"
				>
					<!-- One sentence, "From [start] until [end]", cut around its two
					     fields (frameSegments): each label holds the words before
					     its field. -->
					<div class="dnd-times">
						<label
							>{{ windowParts[0] }}
							<input
								type="time"
								:aria-label="startLabel"
								:value="schedule.start"
								@change="setTime('start', $event)"
						/></label>
						<label
							>{{ windowParts[1] }}
							<input
								type="time"
								:aria-label="endLabel"
								:value="schedule.end"
								@change="setTime('end', $event)"
						/></label>
						<span v-if="windowParts[2].trim()">{{ windowParts[2] }}</span>
					</div>
					<div class="dnd-days" role="group" :aria-label="daysLabel">
						<label v-for="day in DAYS" :key="day">
							<input
								v-switch
								type="checkbox"
								:aria-label="weekdayName(day, 'long')"
								:checked="schedule.days.includes(day)"
								@change="toggleDay(day)"
							/>
							{{ weekdayName(day) }}
						</label>
					</div>
				</fieldset>
				<p class="dnd-schedule-hint">
					{{ t("dnd.scheduleHint", {appName}) }}
				</p>
			</div>
			<div v-if="store.state.pushNotificationState === 'stale'" id="pushStale" class="error">
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.stale") }}
			</div>
			<div v-if="store.state.pushNotificationState === 'unsupported'" class="error">
				{{ t("settings.notifications.unsupported") }}
			</div>
			<div v-if="store.state.pushNotificationState === 'not-installed'" class="error">
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.iosNotInstalled") }}
			</div>
			<div v-if="store.state.pushNotificationState === 'denied'" class="error">
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{
					androidShell
						? t("settings.notifications.pushDeniedAndroid")
						: t("settings.notifications.pushDenied")
				}}
			</div>
			<div v-if="store.state.pushNotificationState === 'server-unsupported'" class="error">
				{{ t("settings.notifications.serverUnsupported") }}
			</div>
			<div v-if="store.state.pushNotificationState === 'blocked'" class="error">
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.pushBlocked") }}
			</div>
		</div>

		<h2>{{ t("settings.notifications.browserHeading") }}</h2>
		<div>
			<div class="push-networks-hint">
				{{ t("settings.notifications.browserPerNetwork") }}
			</div>
			<!-- The shells notify through the OS (helpers/nativeAlerts.ts). -->
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'unsupported'"
				class="error"
			>
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.browserUnsupported") }}
			</div>
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'nohttps'"
				class="error"
			>
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.noHttps") }}
			</div>
			<div
				v-if="!nativeShell && store.state.desktopNotificationState === 'blocked'"
				class="error"
			>
				<strong>{{ t("settings.notifications.warning") }}</strong
				>:
				{{ t("settings.notifications.browserBlocked") }}
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
				{{ t("settings.notifications.sound") }}
			</label>
		</div>
		<div>
			<div class="opt">
				<button id="play" @click.prevent="playNotification">
					{{ t("settings.notifications.playSound") }}
				</button>
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
				{{ t("settings.notifications.notifyAll") }}
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
				{{ t("settings.notifications.highlight") }}
				<span
					class="tooltipped tooltipped-n tooltipped-no-delay"
					:aria-label="highlightHelp"
				>
					<button class="extra-help" />
				</span>
			</label>
		</div>

		<div v-if="!store.state.serverConfiguration?.public">
			<label class="opt">
				<label for="highlights" class="opt">
					{{ t("settings.notifications.highlights") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="highlightsHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
				<input
					id="highlights"
					dir="auto"
					:value="store.state.settings.highlights"
					type="text"
					name="highlights"
					class="input"
					autocomplete="off"
					:placeholder="commaListPlaceholder"
				/>
			</label>
		</div>

		<div v-if="!store.state.serverConfiguration?.public">
			<label class="opt">
				<label for="highlightExceptions" class="opt">
					{{ t("settings.notifications.highlightExceptions") }}
					<span
						class="tooltipped tooltipped-n tooltipped-no-delay"
						:aria-label="highlightExceptionsHelp"
					>
						<button class="extra-help" />
					</span>
				</label>
				<input
					id="highlightExceptions"
					dir="auto"
					:value="store.state.settings.highlightExceptions"
					type="text"
					name="highlightExceptions"
					class="input"
					autocomplete="off"
					:placeholder="commaListPlaceholder"
				/>
			</label>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onMounted} from "vue";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import webpush from "../../js/webpush";
import dnd from "../../js/dnd";
import {DAYS, HHMM, weekdayName, type DndSchedule} from "../../js/helpers/dnd";
import {frameSegments, KEEP} from "../../js/i18n/core";
import {isAndroidShell} from "../../js/helpers/capacitor";
import {nativeAlertsAvailable} from "../../js/helpers/nativeAlerts";
import {playNotificationSound} from "../../js/helpers/notificationSound";

export default defineComponent({
	name: "NotificationSettings",
	setup() {
		const store = useStore();
		const {t, locale} = useI18n();

		const highlightHelp = computed(() => t("settings.notifications.highlightHelp"));
		const highlightsHelp = computed(() => t("settings.notifications.highlightsHelp"));
		const highlightExceptionsHelp = computed(() =>
			t("settings.notifications.highlightExceptionsHelp")
		);
		const commaListPlaceholder = computed(() => t("settings.notifications.commaList"));
		// Two names on frameSegments on purpose: each half is a <label> around
		// its own time field, so the halves stay in "from … until …" order.
		const windowParts = computed(() =>
			frameSegments(t("dnd.scheduleWindow", {start: KEEP, end: KEEP}), ["start", "end"])
		);
		const startLabel = computed(() => t("dnd.scheduleStartAria"));
		const endLabel = computed(() => t("dnd.scheduleEndAria"));
		const daysLabel = computed(() => t("dnd.scheduleDaysAria"));

		// A weekday's name in the language shown (Intl, helpers/dnd.ts).
		const dayName = (day: number, width?: "short" | "long") => {
			void locale.value;

			return weekdayName(day, width);
		};

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
			t,
			highlightHelp,
			highlightsHelp,
			highlightExceptionsHelp,
			commaListPlaceholder,
			androidShell: isAndroidShell(),
			nativeShell: nativeAlertsAvailable(),
			playNotification,
			// Sunday = 0, the day a window starts on (helpers/dnd.ts DndSchedule.days).
			DAYS,
			weekdayName: dayName,
			windowParts,
			startLabel,
			endLabel,
			daysLabel,
			appName: computed(() => store.state.branding.appName),
			schedule,
			update,
			setTime,
			toggleDay,
		};
	},
});
</script>
