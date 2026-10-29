<template>
	<div :aria-label="localeDate" class="date-marker-container tooltipped tooltipped-s">
		<div class="date-marker">
			<span :aria-label="friendlyDate()" class="date-marker-text" />
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, onMounted, PropType} from "vue";
import eventbus from "../js/eventbus";
import {formatDayHeading, formatRelativeDay} from "../js/i18n/dates";
import {useI18n} from "../js/i18n";
import type {ClientMessage} from "../js/types";

export default defineComponent({
	name: "DateMarker",
	props: {
		message: {
			type: Object as PropType<ClientMessage>,
			required: true,
		},
		focused: Boolean,
	},
	setup(props) {
		const {t, locale} = useI18n();

		const ms = () => props.message.time.getTime();

		// Reading locale.value ties the computed to the active language, so a
		// locale change re-renders the heading (Intl itself is not reactive).
		const localeDate = computed(() => {
			void locale.value;
			return formatDayHeading(ms());
		});

		const hoursPassed = () => {
			return (Date.now() - ms()) / 3600000;
		};

		const dayChange = () => {
			if (hoursPassed() >= 48) {
				eventbus.off("daychange", dayChange);
			}
		};

		// Today / Yesterday / the date. The labels resolve through the
		// catalog keys dates.today / dates.yesterday, owned by this component.
		const friendlyDate = () => formatRelativeDay(ms(), t);

		onMounted(() => {
			if (hoursPassed() < 48) {
				eventbus.on("daychange", dayChange);
			}
		});

		onBeforeUnmount(() => {
			eventbus.off("daychange", dayChange);
		});

		return {
			localeDate,
			friendlyDate,
		};
	},
});
</script>
