<template>
	<span
		:class="['user', {[nickColor]: store.state.settings.coloredNicks}, {active: active}]"
		:data-name="user.nick"
		role="button"
		v-on="onHover ? {mouseenter: hover} : {}"
		@click.prevent="openContextMenu"
		@contextmenu.prevent="openContextMenu"
		><Avatar
			v-if="avatarUuid"
			:uuid="avatarUuid"
			:nick="user.nick"
			:account="avatarAccount"
			:self="avatarSelf"
			:size="avatarSize"
		/><slot>{{ mode }}{{ user.nick }}</slot></span
	>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {UserInMessage} from "../../shared/types/msg";
import eventbus from "../js/eventbus";
import colorClass from "../js/helpers/colorClass";
import type {ClientChan, ClientNetwork} from "../js/types";
import {useStore} from "../js/store";
import Avatar from "./Avatar.vue";

type UsernameUser = Partial<UserInMessage> & {
	mode?: string;
	nick: string;
};

export default defineComponent({
	name: "Username",
	components: {Avatar},
	props: {
		/** The network's uuid, to draw the user's avatar before the nick (Avatar.vue). */
		avatarUuid: {type: String, required: false},
		/** The line's account-tag, for the avatar trust. */
		avatarAccount: {type: String, required: false},
		/** The line is ours. */
		avatarSelf: Boolean,
		avatarSize: {type: String as PropType<"line" | "list">, default: "line"},
		user: {
			// TODO: UserInMessage shouldn't be necessary here.
			type: Object as PropType<UsernameUser | UserInMessage>,
			required: true,
		},
		active: Boolean,
		onHover: {
			type: Function as PropType<(user: UserInMessage) => void>,
			required: false,
		},
		channel: {type: Object as PropType<ClientChan>, required: false},
		network: {type: Object as PropType<ClientNetwork>, required: false},
		/** `ident@host` where the line shows it, for the menu's Ban…. */
		address: {type: String, required: false},
	},
	setup(props) {
		const mode = computed(() => {
			// Message objects have a singular mode, but user objects have modes array
			if (props.user.modes) {
				return props.user.modes[0];
			}

			return props.user.mode;
		});

		// TODO: Nick must be ! because our user prop union includes UserInMessage
		const nickColor = computed(() => colorClass(props.user.nick!));

		const hover = () => {
			if (props.onHover) {
				return props.onHover(props.user as UserInMessage);
			}

			return null;
		};

		const openContextMenu = (event: Event) => {
			// A click or tap on the avatar opens the user card (UserCard.vue);
			// the nick, and a right-click anywhere, the menu.
			const onAvatar =
				event.type === "click" &&
				event.target instanceof Element &&
				!!event.target.closest(".avatar");

			eventbus.emit("contextmenu:user", {
				card: onAvatar,
				event: event,
				user: props.user,
				network: props.network,
				channel: props.channel,
				address: props.address,
			});
		};

		const store = useStore();

		return {
			mode,
			nickColor,
			hover,
			openContextMenu,
			store,
		};
	},
});
</script>
