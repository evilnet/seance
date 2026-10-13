<template>
	<span class="content">
		<p>
			<Username :user="{nick: message.whois.nick}" />
			<span v-if="message.whois.whowas"> is offline, last information:</span>
		</p>

		<!-- Each dt/dd pair is wrapped in a div (valid in a dl) so the label
		     can be positioned into the empty gutter column, right-aligned
		     against the row separator like a nick (style.css `.whois`). -->
		<dl class="whois">
			<div v-if="message.whois.account">
				<dt>Logged in as:</dt>
				<dd>{{ message.whois.account }}</dd>
			</div>

			<div>
				<dt>Host mask:</dt>
				<dd class="hostmask">
					<ParsedMessage
						:network="network"
						:text="message.whois.ident + '@' + message.whois.hostname"
					/>
				</dd>
			</div>

			<div v-if="message.whois.actual_hostname">
				<dt>Actual host:</dt>
				<dd class="hostmask">
					<a
						:href="'https://ipinfo.io/' + message.whois.actual_ip"
						target="_blank"
						rel="noopener"
						>{{ message.whois.actual_ip }}</a
					>
					<i v-if="message.whois.actual_hostname != message.whois.actual_ip">
						({{ message.whois.actual_hostname }})</i
					>
				</dd>
			</div>

			<div v-if="message.whois.actual_username">
				<dt>Actual username:</dt>
				<dd>{{ message.whois.actual_username }}</dd>
			</div>

			<div v-if="message.whois.real_name">
				<dt>Real name:</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.real_name" /></dd>
			</div>

			<div v-if="message.whois.registered_nick">
				<dt>Registered nick:</dt>
				<dd>{{ message.whois.registered_nick }}</dd>
			</div>

			<div v-if="message.whois.channels">
				<dt>Channels:</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.channels" /></dd>
			</div>

			<div v-if="message.whois.modes">
				<dt>Modes:</dt>
				<dd>{{ message.whois.modes }}</dd>
			</div>

			<template v-if="message.whois.special">
				<div v-for="special in message.whois.special" :key="special">
					<dt>Special:</dt>
					<dd>{{ special }}</dd>
				</div>
			</template>

			<div v-if="message.whois.operator">
				<dt>Operator:</dt>
				<dd>{{ message.whois.operator }}</dd>
			</div>

			<div v-if="message.whois.marks && message.whois.marks.length">
				<dt>Marks:</dt>
				<dd class="oper-chips">
					<span
						v-for="mark in message.whois.marks"
						:key="mark"
						class="oper-chip-static"
						>{{ mark }}</span
					>
				</dd>
			</div>

			<div v-if="message.whois.killListed">
				<dt>Kill listed:</dt>
				<dd>{{ message.whois.killListed }}</dd>
			</div>

			<div v-if="message.whois.helpop">
				<dt>Available for help:</dt>
				<dd>Yes</dd>
			</div>

			<div v-if="message.whois.bot">
				<dt>Is a bot:</dt>
				<dd>Yes</dd>
			</div>

			<div v-if="message.whois.away">
				<dt>Away:</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.away" /></dd>
			</div>

			<div v-if="message.whois.secure">
				<dt>Secure connection:</dt>
				<dd>Yes</dd>
			</div>

			<template v-if="message.whois.certfps">
				<div v-for="certfp in message.whois.certfps" :key="certfp">
					<dt>Certificate:</dt>
					<dd>{{ certfp }}</dd>
				</div>
			</template>

			<div v-if="message.whois.websocket">
				<dt>WebSocket from:</dt>
				<dd>{{ message.whois.websocket }}</dd>
			</div>

			<div v-if="message.whois.webirc">
				<dt>Via gateway:</dt>
				<dd>{{ message.whois.webirc }}</dd>
			</div>

			<div v-if="message.whois.bouncer">
				<dt>Bouncer:</dt>
				<dd>{{ message.whois.bouncer }}</dd>
			</div>

			<div v-if="message.whois.server">
				<dt>Connected to:</dt>
				<dd>
					{{ message.whois.server }} <i>({{ message.whois.server_info }})</i>
				</dd>
			</div>

			<div v-if="message.whois.logonTime">
				<dt>Connected at:</dt>
				<dd>{{ localetime(message.whois.logonTime) }}</dd>
			</div>

			<div v-if="message.whois.idle">
				<dt>Idle since:</dt>
				<dd>{{ localetime(message.whois.idleTime) }}</dd>
			</div>
		</dl>
		<p v-if="canCheck && !message.whois.whowas" class="whois-oper-actions">
			<button type="button" class="btn btn-small" @click="check">
				Check {{ message.whois.nick }}
			</button>
		</p>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import {hasPriv, isOperOn} from "../../js/helpers/operMenu";
import localetime from "../../js/helpers/localetime";
import {ClientNetwork, ClientMessage} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

export default defineComponent({
	name: "MessageTypeWhois",
	components: {
		ParsedMessage,
		Username,
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
		const store = useStore();

		// An oper with CHECK gets the full picture one click away.
		const canCheck = computed(() => isOperOn(props.network) && hasPriv(props.network, "CHECK"));

		const check = () => {
			const target = store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			socket.emit("input", {target, text: `/check ${String(props.message.whois.nick)}`});
		};

		return {
			localetime: (date: Date) => localetime(date),
			canCheck,
			check,
		};
	},
});
</script>
