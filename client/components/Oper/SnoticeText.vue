<template>
	<span class="snotice-text" :title="text">
		<template v-if="parts"
			><template v-for="(part, i) in parts" :key="i"
				><template v-if="'text' in part">{{ part.text }}</template
				><Username
					v-else-if="typeOf(part.field) === 'nick'"
					:user="{nick: part.value, mode: ''}"
					:network="network"
				/><button
					v-else-if="isChip(part.field)"
					type="button"
					:class="['oper-chip', 'oper-chip-' + typeOf(part.field)]"
					title="Oper actions"
					@click.stop="openMenu($event, part.field, part.value)"
				>
					{{ part.value }}</button
				><span v-else-if="typeOf(part.field) === 'server'" class="oper-server">{{
					part.value
				}}</span
				><span v-else-if="typeOf(part.field) === 'channel'" class="oper-channel"
					><ParsedMessage :network="network" :text="part.value" /></span
				><time
					v-else-if="typeOf(part.field) === 'expiry'"
					class="oper-expiry"
					:title="absolute(part.value)"
					>{{ expiry(part.value) }}</time
				><span v-else :class="['snotice-field', 'snotice-field-' + part.field]">{{
					part.value
				}}</span></template
			></template
		>
		<template v-else>{{ text }}</template>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {SnoticeInfo} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import {fieldType, splitTemplate} from "../../js/irc/profiles/fields";
import {findNoticeKind} from "../../js/irc/snotice";
import {formatExpiry} from "../../js/helpers/operFormat";
import {openOperTargetMenu} from "../../js/helpers/operMenu";
import localetime from "../../js/helpers/localetime";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

/**
 * A classified server notice in plain words: the kind's template with its
 * fields filled in — a nick as a nick, an IP or mask as a chip with oper
 * actions, an expiry as a relative time. The original text is the tooltip
 * (and what shows when the kind has no template).
 */
export default defineComponent({
	name: "SnoticeText",
	components: {ParsedMessage, Username},
	props: {
		info: {type: Object as PropType<SnoticeInfo>, required: true},
		text: {type: String, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const store = useStore();
		const now = useNow();

		const parts = computed(() => {
			const kind = findNoticeKind(props.info.kind, props.network.oper?.profile);
			return kind?.template ? splitTemplate(kind.template, props.info.fields) : undefined;
		});

		const typeOf = (field: string) => fieldType(field);
		const isChip = (field: string) => ["ip", "host", "mask"].includes(fieldType(field));

		const openMenu = (event: MouseEvent, field: string, value: string) => {
			const type = fieldType(field) as "ip" | "host" | "mask";
			const chan = store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			openOperTargetMenu(event, props.network, chan, type, value);
		};

		/** An `expires` field is Unix seconds. */
		const ms = (value: string) => Number(value) * 1000;

		return {
			parts,
			typeOf,
			isChip,
			openMenu,
			absolute: (value: string) => localetime(new Date(ms(value))),
			expiry: (value: string) => formatExpiry(ms(value), now.value),
		};
	},
});
</script>
