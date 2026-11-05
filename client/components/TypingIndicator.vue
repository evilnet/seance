<template>
	<div v-if="visible" class="typing-indicator" role="status" aria-live="polite">
		<span v-if="summary" class="typing-indicator-text">{{ summary }}</span>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientChan} from "../js/types";
import {useI18n} from "../js/i18n";
import {typingSummary} from "../js/helpers/typingState";

// A one-line "alice is typing…" strip above the input, with a fixed height
// (see #form .typing-indicator in style.css). It appears with the first
// typing entry — the scrollback moves up once to make room — and once the
// entries are gone the empty line stays (`channel.typingReserved`) so the
// scrollback does not bounce back. The next message appended to the channel
// releases the reservation (socket-events/typing.ts) in the same render, so
// the new message fills the space and the view does not move again.
// Expired entries are dropped by the shared sweep in helpers/typingExpiry.ts,
// so whatever is in `channel.typing` here is live.
export default defineComponent({
	name: "TypingIndicator",
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const {t, tCount} = useI18n();

		const visible = computed(
			() => props.channel.typing.length > 0 || props.channel.typingReserved
		);

		const summary = computed(() => typingSummary(props.channel.typing, t, tCount));

		return {visible, summary};
	},
});
</script>
