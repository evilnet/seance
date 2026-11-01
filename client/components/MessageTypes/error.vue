<template>
	<span class="content">
		<ParsedMessage :network="network" :message="message" :text="errorMessage" />
	</span>
</template>

<script lang="ts">
import ParsedMessage from "../ParsedMessage.vue";
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import {useI18n} from "../../js/i18n";

export default defineComponent({
	name: "MessageTypeError",
	components: {
		ParsedMessage,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		message: {
			type: Object as PropType<ClientMessage>,
			required: true,
		},
	},
	setup(props) {
		const {t} = useI18n();

		const errorMessage = computed(() => {
			// TODO: enforce chan and nick fields so that we can get rid of that
			const chan = props.message.channel || "!UNKNOWN_CHAN";
			const nick = props.message.nick || "!UNKNOWN_NICK";

			switch (props.message.error) {
				case "bad_channel_key":
					return t("error.badChannelKey", {channel: chan});
				case "banned_from_channel":
					return t("error.bannedFromChannel", {channel: chan});
				case "cannot_send_to_channel":
					return t("error.cannotSendToChannel", {channel: chan});
				case "channel_is_full":
					return t("error.channelIsFull", {channel: chan});
				case "chanop_privs_needed":
					return t("error.chanopPrivsNeeded");
				case "invite_only_channel":
					return t("error.inviteOnlyChannel", {channel: chan});
				case "no_such_nick":
					return t("error.noSuchNick", {nick});
				case "not_on_channel":
					return t("error.notOnChannel");
				case "password_mismatch":
					return t("error.passwordMismatch");
				case "too_many_channels":
					return t("error.tooManyChannels", {channel: chan});
				case "unknown_command":
					// TODO: not having message.command should never happen, so force existence
					return t("error.unknownCommand", {
						command: props.message.command || "!UNDEFINED_COMMAND_BUG",
					});
				case "user_not_in_channel":
					return t("error.userNotInChannel", {nick});
				case "user_on_channel":
					return t("error.userOnChannel", {nick});
				default:
					if (props.message.reason) {
						// The server's own reason text with the error code beside
						// it: both verbatim, only the layout is ours.
						return `${props.message.reason} (${
							props.message.error || "!UNDEFINED_ERR"
						})`;
					}

					return props.message.error;
			}
		});

		return {
			errorMessage,
		};
	},
});
</script>
