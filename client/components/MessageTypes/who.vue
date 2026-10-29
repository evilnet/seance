<template>
	<span class="content who">
		<p class="who-title">
			{{ titleParts[0]
			}}<bdi><ParsedMessage :network="network" :text="message.who.target" /></bdi
			>{{ titleParts[1] }}
			<span class="who-count">{{ countLabel }}</span>
		</p>
		<div class="who-scroll">
			<table class="who-list">
				<thead>
					<tr>
						<th class="who-nick">{{ t("who.nick") }}</th>
						<th class="who-status">{{ t("who.status") }}</th>
						<th class="who-host">{{ t("who.host") }}</th>
						<th v-if="hasAccounts" class="who-account">{{ t("who.account") }}</th>
						<th class="who-realname">{{ t("who.realName") }}</th>
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
							:title="
								entry.server ? t('who.onServer', {server: entry.server}) : undefined
							"
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
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

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
		const {t, tCount} = useI18n();
		const entries = computed<WhoEntry[]>(() => props.message.who?.entries ?? []);

		// "Who is on <target>", cut around the target (a parsed channel or mask).
		const titleParts = computed(() =>
			frameSegments(t("who.title", {target: KEEP}), ["target"])
		);
		const countLabel = computed(() => tCount("who.count", entries.value.length));

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
				flags.push({text: t("who.flagOper"), cls: "who-flag who-oper"});
			}

			if (entry.away) {
				flags.push({text: t("who.flagAway"), cls: "who-flag who-away"});
			}

			if (entry.bot) {
				flags.push({text: t("who.flagBot"), cls: "who-flag who-bot"});
			}

			return flags;
		};

		return {t, titleParts, countLabel, hasAccounts, userOf, flagsOf};
	},
});
</script>
