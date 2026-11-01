<template>
	<div :class="['msg', {closed: isCollapsed}]" data-type="condensed">
		<div class="condensed-summary">
			<span class="time" />
			<span class="from" />
			<span class="content" @click="onCollapseClick"
				>{{ condensedText }}<button class="toggle-button" :aria-label="toggleLabel"
			/></span>
		</div>
		<Message
			v-for="message in messages"
			:key="message.id"
			:network="network"
			:message="message"
		/>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, ref} from "vue";
import {condensedTypes} from "../../shared/irc";
import {MessageType} from "../../shared/types/msg";
import {ClientMessage, ClientNetwork} from "../js/types";
import {localeRef, useI18n} from "../js/i18n";
import {warnFragmentJoin} from "../js/i18n/core";
import Message from "./Message.vue";

export default defineComponent({
	name: "MessageCondensed",
	components: {
		Message,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		messages: {
			type: Array as PropType<ClientMessage[]>,
			required: true,
		},
		keepScrollPosition: {
			type: Function as PropType<() => void>,
			required: true,
		},
		focused: Boolean,
	},
	setup(props) {
		const {t, tCount} = useI18n();

		const isCollapsed = ref(true);

		const onCollapseClick = () => {
			isCollapsed.value = !isCollapsed.value;
			props.keepScrollPosition();
		};

		const toggleLabel = computed(() => t("condensed.toggle"));

		const condensedText = computed(() => {
			const obj: Record<string, number> = {};

			condensedTypes.forEach((type) => {
				obj[type] = 0;
			});

			for (const message of props.messages) {
				// special case since one MODE message can change multiple modes
				if (message.type === MessageType.MODE) {
					// syntax: +vv-t maybe-some targets
					// we want the number of mode changes in the message, so count the
					// number of chars other than + and - before the first space
					const text = message.text ? message.text : "";
					const modeChangesCount = text
						.split(" ")[0]
						.split("")
						.filter((char) => char !== "+" && char !== "-").length;
					obj[message.type] += modeChangesCount;
				} else {
					if (!message.type) {
						/* eslint-disable no-console */
						console.log(`empty message type, this should not happen: ${message.id}`);
						continue;
					}

					obj[message.type]++;
				}
			}

			// Count quits as parts in condensed messages to reduce information density
			obj.part += obj.quit;

			const parts: string[] = [];

			// Every tCount keeps its key as a plain literal (the pot ↔
			// call-site scanner only sees direct calls), so the per-type
			// labels are a switch, not a key table. "quit" is folded into
			// "part" above; away/back build their own marked parts.
			for (const type of condensedTypes) {
				const count = obj[type];

				if (!count) {
					continue;
				}

				switch (type) {
					case "away":
						parts.push(tCount("condensed.away", count));
						break;
					case "back":
						parts.push(tCount("condensed.back", count));
						break;
					case "chghost":
						parts.push(tCount("condensed.chghost", count));
						break;
					case "join":
						parts.push(tCount("condensed.join", count));
						break;
					case "kick":
						parts.push(tCount("condensed.kicked", count));
						break;
					case "mode":
						parts.push(tCount("condensed.modes", count));
						break;
					case "nick":
						parts.push(tCount("condensed.nick", count));
						break;
					case "part":
						parts.push(tCount("condensed.left", count));
						break;
					case "quit":
						break; // folded into part above
				}
			}

			if (parts.length === 0) {
				return "";
			}

			// "3 users have joined, 1 mode was set and 1 user has left" — the
			// list conjunction is the locale's, not ", and ".
			if (parts.length > 1) {
				warnFragmentJoin(parts.length);
			}

			return new Intl.ListFormat(localeRef.value, {type: "conjunction"}).format(parts);
		});

		return {
			isCollapsed,
			condensedText,
			onCollapseClick,
			toggleLabel,
		};
	},
});
</script>
