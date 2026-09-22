<template>
	<span class="content who">
		<p class="who-title">
			Who is on <ParsedMessage :network="network" :text="message.who.target" />
			<span class="who-count">{{ countLabel }}</span>
		</p>
		<div class="who-scroll">
			<table class="who-list">
				<thead>
					<tr>
						<th class="who-nick">Nick</th>
						<th class="who-status">Status</th>
						<th class="who-host">User@host</th>
						<th v-if="hasAccounts" class="who-account">Account</th>
						<th class="who-realname">Real name</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="entry in message.who.entries" :key="entry.nick">
						<td class="who-nick">
							<Username :user="userOf(entry)" :network="network" />
						</td>
						<td class="who-status" :title="entry.flags">
							<span
								v-for="flag in flagsOf(entry)"
								:key="flag.text"
								:class="flag.cls"
								>{{ flag.text }}</span
							>
						</td>
						<td
							class="who-host"
							:title="entry.server ? `on ${entry.server}` : undefined"
						>
							<span class="who-ident">{{ entry.ident }}</span
							><span class="who-at">@</span><wbr /><span class="who-hostname">{{
								entry.hostname
							}}</span>
						</td>
						<td v-if="hasAccounts" class="who-account">
							<template v-if="entry.account">{{ entry.account }}</template>
							<span v-else class="who-none">—</span>
						</td>
						<td class="who-realname">
							<ParsedMessage :network="network" :text="entry.realname" />
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {WhoEntry} from "../../../shared/types/msg";
import {ClientNetwork, ClientMessage} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

interface Flag {
	text: string;
	cls: string;
}

export default defineComponent({
	name: "MessageTypeWho",
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
		const entries = computed<WhoEntry[]>(() => props.message.who?.entries ?? []);

		const countLabel = computed(() => {
			const n = entries.value.length;
			return n === 1 ? "1 user" : `${n} users`;
		});

		// The column only exists when the server told us (WHOX `a` field).
		const hasAccounts = computed(() => entries.value.some((e) => e.account !== undefined));

		const userOf = (entry: WhoEntry) => ({
			nick: entry.nick,
			mode: entry.prefixes.charAt(0),
		});

		const flagsOf = (entry: WhoEntry): Flag[] => {
			const flags: Flag[] = [];

			for (const symbol of entry.prefixes) {
				flags.push({text: symbol, cls: "who-flag who-prefix"});
			}

			if (entry.oper) {
				flags.push({text: "oper", cls: "who-flag who-oper"});
			}

			if (entry.away) {
				flags.push({text: "away", cls: "who-flag who-away"});
			}

			if (entry.bot) {
				flags.push({text: "bot", cls: "who-flag who-bot"});
			}

			return flags;
		};

		return {countLabel, hasAccounts, userOf, flagsOf};
	},
});
</script>
