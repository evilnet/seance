<template>
	<span class="host-address" role="button" @click.prevent="open" @contextmenu.prevent="open">{{
		address
	}}</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {openAddressMenu} from "../js/helpers/banMenu";
import {useStore} from "../js/store";
import type {ClientNetwork} from "../js/types";

/**
 * `ident@host` in a join, part or quit line: looks like the text around it
 * until hovered, and opens the address menu (helpers/banMenu.ts).
 */
export default defineComponent({
	name: "HostAddress",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		address: {type: String, required: true},
		nick: {type: String, required: false},
	},
	setup(props) {
		const store = useStore();

		const open = (event: MouseEvent) => {
			// The line is in the conversation on screen, on this network or
			// (a search result, an oper card) in its lobby.
			const active = store.state.activeChannel;
			const chan =
				active?.network.uuid === props.network.uuid
					? active.channel
					: props.network.channels[0];

			if (chan) {
				openAddressMenu(event, props.network, chan, props.address, props.nick);
			}
		};

		return {open};
	},
});
</script>
