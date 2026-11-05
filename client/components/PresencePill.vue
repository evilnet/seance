<template>
	<div class="presence-pill-row">
		<button
			type="button"
			:class="['presence-pill', {'is-dnd': isDnd}]"
			aria-haspopup="menu"
			:aria-expanded="expanded ? 'true' : 'false'"
			:aria-label="ariaLabel"
			:title="label"
			@click="openMenu"
		>
			<!-- The dot and the caret float on the first line, so a second line
			     gets the pill's whole width; a long label breaks after its
			     separator ("Do not disturb ·" over "until 10:36 AM"), and inside
			     the last part only when it alone is wider than the label (a long
			     translation). -->
			<span class="presence-pill-text"
				><span :class="['presence-dot', `is-${dotState}`]" aria-hidden="true" /><span
					class="presence-pill-caret"
					aria-hidden="true"
				/><template v-for="(part, i) in parts" :key="i"
					><span v-if="i < parts.length - 1">{{ part }}&nbsp;·</span
					><span v-else class="presence-pill-part">{{ part }}</span
					>{{ i < parts.length - 1 ? " " : "" }}</template
				></span
			>
		</button>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useRouter} from "vue-router";
import dnd from "../js/dnd";
import {clockText, modeLabel, scheduleTimeText} from "../js/helpers/dnd";
import {useI18n} from "../js/i18n";
import {store} from "../js/store";
import eventbus from "../js/eventbus";
import useMenuTrigger from "../js/hooks/use-menu-trigger";
import type {ContextMenuItem} from "../js/helpers/contextMenu";

const HOUR = 3600_000;

// The global presence switch under the sidebar logo (client/js/dnd.ts):
// Online, Auto, Away (the global mode) or do not disturb; the pill says what holds
// now, its menu sets it.
export default defineComponent({
	name: "PresencePill",
	setup() {
		const router = useRouter();
		const {expanded, opened} = useMenuTrigger();
		const isDnd = computed(() => dnd.pillState.value === "dnd");
		const dotState = computed(() => dnd.pillState.value);
		const {t} = useI18n();
		const label = computed(() => dnd.pillLabel.value);
		const parts = computed(() => dnd.pillParts.value);
		const ariaLabel = computed(() => t("presence.pillAria", {state: label.value}));

		const openMenu = (event: MouseEvent) => {
			const manual = dnd.state.manual;
			const schedule = dnd.state.schedule;
			const verdict = dnd.verdict.value;
			const hour12 = !!store.state.settings.use12hClock;
			// A time never breaks inside ("11:00 PM"), and a range never at
			// its dash: an en dash is a break opportunity, the joiners take it.
			const at = (hhmm: string) => scheduleTimeText(hhmm, hour12).replace(/ /g, "\u00a0");
			const range = `${at(schedule.start)}\u2060–\u2060${at(schedule.end)}`;
			const timed = manual.kind === "until" && verdict.source === "manual" ? manual : null;

			const endText = () => {
				const end = new Date(timed?.until ?? 0);
				return clockText(end.getHours(), end.getMinutes(), hour12).replace(/ /g, "\u00a0");
			};

			const forSpan = (
				span: number,
				text: string,
				runningText: (until: string) => string,
				cls: string
			): ContextMenuItem => {
				// Picked with this span, and no further off than it (an end
				// moved by hand is no longer "for 1 hour").
				const running =
					timed !== null && timed.span === span && timed.until - Date.now() <= span;
				return {
					label: running ? runningText(endText()) : text,
					type: "item",
					class: cls,
					checked: running,
					action: () => dnd.setManual({kind: "until", until: Date.now() + span, span}),
				};
			};

			const following = schedule.enabled && schedule.days.length > 0;
			const items: ContextMenuItem[] = [
				// The global mode. Only while the pill does not read DND: with
				// every network in mode dnd, or another device's DND, the pill says
				// Do not disturb and a ticked mode would not.
				...(["online", "auto", "away"] as const).map(
					(mode): ContextMenuItem => ({
						label: modeLabel(mode, t),
						type: "item",
						class: `status-${mode}`,
						checked: dnd.pillState.value !== "dnd" && dnd.status.value === mode,
						action: () => dnd.setGlobalMode(mode),
					})
				),
				{type: "divider"},
				forSpan(HOUR, t("dnd.for1h"), (until) => t("dnd.for1hUntil", {until}), "dnd-1h"),
				forSpan(
					8 * HOUR,
					t("dnd.for8h"),
					(until) => t("dnd.for8hUntil", {until}),
					"dnd-8h"
				),
				{
					label: t("dnd.indefinite"),
					type: "item",
					class: "dnd-indefinite",
					checked: manual.kind === "indefinite",
					action: () => dnd.setManual({kind: "indefinite"}),
				},
				{type: "divider"},
				{
					label: t("dnd.followSchedule", {range}),
					type: "item",
					class: "dnd-schedule",
					checked: following,
					toggle: true,
					// What the tick shows: a schedule with no days is not followed,
					// so a click turns it on.
					action: () => dnd.followSchedule(!following),
				},
				{
					label: t("dnd.editSchedule"),
					type: "item",
					class: "dnd-edit-schedule",
					action: () => void router.push({name: "Notifications"}),
				},
			];
			eventbus.emit("contextmenu:items", {event, items});
			// After the emit: opening it closed any other menu first.
			opened();
		};

		return {expanded, isDnd, dotState, label, ariaLabel, parts, openMenu};
	},
});
</script>
