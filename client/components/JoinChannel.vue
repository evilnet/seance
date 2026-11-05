<template>
	<form
		:id="'join-channel-' + channel.id"
		class="join-form"
		method="post"
		action=""
		autocomplete="off"
		@keydown.esc.prevent="$emit('toggle-join-channel')"
		@submit.prevent="onSubmit"
	>
		<input
			v-model="inputChannel"
			v-focus
			dir="auto"
			type="text"
			class="input"
			name="channel"
			:placeholder="channelPlaceholder"
			pattern="[^\s]+"
			maxlength="200"
			:title="channelHint"
			required
		/>
		<input
			v-model="inputPassword"
			dir="auto"
			type="password"
			class="input"
			name="key"
			:placeholder="passwordPlaceholder"
			pattern="[^\s]+"
			maxlength="200"
			:title="passwordHint"
			autocomplete="new-password"
		/>
		<button type="submit" class="btn btn-small">{{ t("join.submit") }}</button>
	</form>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, ref} from "vue";
import {switchToChannel} from "../js/router";
import socket from "../js/socket";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import {ClientNetwork, ClientChan} from "../js/types";

export default defineComponent({
	name: "JoinChannel",
	directives: {
		focus: {
			mounted: (el: HTMLFormElement) => el.focus(),
		},
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	emits: ["toggle-join-channel"],
	setup(props, {emit}) {
		const store = useStore();
		const {t} = useI18n();
		// Bound attribute labels: computeds, so a locale change re-renders.
		const channelPlaceholder = computed(() => t("join.channelPlaceholder"));
		const channelHint = computed(() => t("join.channelHint"));
		const passwordPlaceholder = computed(() => t("join.passwordPlaceholder"));
		const passwordHint = computed(() => t("join.passwordHint"));
		const inputChannel = ref("");
		const inputPassword = ref("");

		const onSubmit = () => {
			const existingChannel = store.getters.findChannelOnCurrentNetwork(inputChannel.value);

			if (existingChannel) {
				switchToChannel(existingChannel);
			} else {
				const chanTypes = props.network.serverOptions.CHANTYPES;
				let channel = inputChannel.value;

				if (chanTypes && chanTypes.length > 0 && !chanTypes.includes(channel[0])) {
					channel = chanTypes[0] + channel;
				}

				socket.emit("input", {
					text: `/join ${channel} ${inputPassword.value}`,
					target: props.channel.id,
				});
			}

			inputChannel.value = "";
			inputPassword.value = "";
			emit("toggle-join-channel");
		};

		return {
			t,
			channelPlaceholder,
			channelHint,
			passwordPlaceholder,
			passwordHint,
			inputChannel,
			inputPassword,
			onSubmit,
		};
	},
});
</script>
