<template>
	<span class="content">
		<p>
			<bdi><Username :user="{nick: message.whois.nick}" /></bdi>
			<!-- The phrase follows the nick: its space is ours to give (the
			     template compiler drops a leading whitespace-only text). -->
			<template v-if="message.whois.whowas"
				>{{ " " }}<span>{{ t("whois.offline") }}</span></template
			>
		</p>

		<!-- Each dt/dd pair is wrapped in a div (valid in a dl) so the label
		     can be positioned into the empty gutter column, right-aligned
		     against the row separator like a nick (style.css `.whois`). -->
		<dl class="whois">
			<div v-if="message.whois.account">
				<dt>{{ t("whois.loggedAs") }}</dt>
				<dd>{{ message.whois.account }}</dd>
			</div>

			<div>
				<dt>{{ t("whois.hostmask") }}</dt>
				<dd class="hostmask">
					<ParsedMessage
						:network="network"
						:text="message.whois.ident + '@' + message.whois.hostname"
					/>
				</dd>
			</div>

			<div v-if="message.whois.actual_hostname">
				<dt>{{ t("whois.actualHost") }}</dt>
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
				<dt>{{ t("whois.actualUsername") }}</dt>
				<dd>{{ message.whois.actual_username }}</dd>
			</div>

			<div v-if="message.whois.real_name">
				<dt>{{ t("whois.realName") }}</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.real_name" /></dd>
			</div>

			<div v-if="message.whois.registered_nick">
				<dt>{{ t("whois.registeredNick") }}</dt>
				<dd>{{ message.whois.registered_nick }}</dd>
			</div>

			<div v-if="message.whois.channels">
				<dt>{{ t("whois.channels") }}</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.channels" /></dd>
			</div>

			<div v-if="message.whois.modes">
				<dt>{{ t("whois.modes") }}</dt>
				<dd>{{ message.whois.modes }}</dd>
			</div>

			<template v-if="message.whois.special">
				<div v-for="special in message.whois.special" :key="special">
					<dt>{{ t("whois.special") }}</dt>
					<dd>{{ special }}</dd>
				</div>
			</template>

			<div v-if="message.whois.operator">
				<dt>{{ t("whois.operator") }}</dt>
				<dd>{{ message.whois.operator }}</dd>
			</div>

			<div v-if="message.whois.marks && message.whois.marks.length">
				<dt>{{ t("whois.marks") }}</dt>
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
				<dt>{{ t("whois.killListed") }}</dt>
				<dd>{{ message.whois.killListed }}</dd>
			</div>

			<div v-if="message.whois.helpop">
				<dt>{{ t("whois.helpop") }}</dt>
				<dd>{{ t("whois.yes") }}</dd>
			</div>

			<div v-if="message.whois.bot">
				<dt>{{ t("whois.bot") }}</dt>
				<dd>{{ t("whois.yes") }}</dd>
			</div>

			<!-- `*`: away with no message (draft/pre-away, handlers/whois.ts).
			     The pair keeps its value cell, or the label rides over the
			     next row. -->
			<div v-if="message.whois.away === '*'">
				<dt>{{ t("whois.awayLabel") }}</dt>
				<dd>
					<i class="whois-no-message">{{ t("whois.awayNoMessage") }}</i>
				</dd>
			</div>
			<div v-else-if="message.whois.away">
				<dt>{{ t("whois.awayLabel") }}</dt>
				<dd><ParsedMessage :network="network" :text="message.whois.away" /></dd>
			</div>

			<div v-if="message.whois.secure">
				<dt>{{ t("whois.secure") }}</dt>
				<dd>{{ t("whois.yes") }}</dd>
			</div>

			<template v-if="message.whois.certfps">
				<div v-for="certfp in message.whois.certfps" :key="certfp">
					<dt>{{ t("whois.cert") }}</dt>
					<dd>{{ certfp }}</dd>
				</div>
			</template>

			<div v-if="message.whois.websocket">
				<dt>{{ t("whois.websocket") }}</dt>
				<dd>{{ message.whois.websocket }}</dd>
			</div>

			<div v-if="message.whois.webirc">
				<dt>{{ t("whois.webirc") }}</dt>
				<dd>{{ message.whois.webirc }}</dd>
			</div>

			<div v-if="message.whois.bouncer">
				<dt>{{ t("whois.bouncer") }}</dt>
				<dd>{{ message.whois.bouncer }}</dd>
			</div>

			<div v-if="message.whois.server">
				<dt>{{ t("whois.connectedTo") }}</dt>
				<dd>
					{{ message.whois.server }} <i>({{ message.whois.server_info }})</i>
				</dd>
			</div>

			<div v-if="message.whois.logonTime">
				<dt>{{ t("whois.connectedAt") }}</dt>
				<dd>{{ fullTime(message.whois.logonTime) }}</dd>
			</div>

			<div v-if="message.whois.idle">
				<dt>{{ t("whois.idleSince") }}</dt>
				<dd>{{ fullTime(message.whois.idleTime) }}</dd>
			</div>
		</dl>
		<p v-if="canCheck && !message.whois.whowas" class="whois-oper-actions">
			<button type="button" class="btn btn-small" @click="check">
				{{ checkParts[0] }}<bdi>{{ message.whois.nick }}</bdi
				>{{ checkParts[1] }}
			</button>
		</p>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import {hasPriv, isOperOn} from "../../js/helpers/operMenu";
import {formatDateTime} from "../../js/i18n/dates";
import {ClientNetwork, ClientMessage} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

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
		const {t} = useI18n();
		const store = useStore();

		// An oper with CHECK gets the full picture one click away.
		const canCheck = computed(() => isOperOn(props.network) && hasPriv(props.network, "CHECK"));

		// "Check <nick>", cut around the nick.
		const checkParts = computed(() =>
			frameSegments(t("whois.checkNick", {nick: KEEP}), ["nick"])
		);

		const check = () => {
			const target = store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			socket.emit("input", {target, text: `/check ${String(props.message.whois.nick)}`});
		};

		return {
			t,
			fullTime: (date: number | Date) => formatDateTime(date),
			canCheck,
			check,
			checkParts,
		};
	},
});
</script>
