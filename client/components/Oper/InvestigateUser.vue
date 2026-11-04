<template>
	<div class="oper-investigate-user">
		<template v-if="parts.includes('verdict')">
			<div v-if="view" :class="['oper-verdict', `tone-${view.tone}`]">
				<span class="oper-verdict-mark" aria-hidden="true"></span>
				<p class="oper-verdict-head">
					<span class="oper-verdict-kicker">{{ view.kicker }}</span>
					<span class="oper-verdict-lead"
						>{{ view.lead }}{{ view.nick ? " " : ""
						}}<template v-if="view.nick">
							<Username
								:user="{nick: view.nick, mode: ''}"
								:network="network" /></template
					></span>
				</p>
				<p
					v-if="view.evidence.length || view.mask || view.detail"
					class="oper-verdict-evidence"
				>
					<span v-for="e in view.evidence" :key="e" class="oper-tag warn">{{ e }}</span>
					<button
						v-if="view.mask"
						type="button"
						class="oper-chip oper-chip-mask"
						title="Oper actions"
						@click.stop="openMenu($event, 'mask', view.mask)"
					>
						{{ view.mask }}
					</button>
					<span v-if="view.detail" class="oper-muted">{{ view.detail }}</span>
				</p>
			</div>
			<div v-else class="oper-verdict tone-pending">
				<span class="oper-verdict-mark" aria-hidden="true"></span>
				<p class="oper-verdict-head">
					<span class="oper-verdict-lead oper-muted">Looking them up…</span>
				</p>
			</div>
		</template>

		<InvestigateFacts
			v-if="parts.includes('facts')"
			:sides="[{model, sources}]"
			:network="network"
			@sent="(to: number) => $emit('sent', to)"
		/>
		<template v-if="parts.includes('sections')">
			<section class="oper-card-section">
				<div class="oper-section-head">
					<h3 class="oper-report-section-title">Bans near this user</h3>
					<span v-if="bans.length || model.serviceBans.length" class="oper-count">{{
						bans.length || model.serviceBans.length
					}}</span>
				</div>
				<ul v-if="bans.length" class="oper-bans oper-rows">
					<li
						v-for="ban in bans"
						:key="ban.mask + ban.live"
						:class="{expired: !ban.live}"
					>
						<button
							type="button"
							class="oper-chip oper-chip-mask"
							title="Oper actions"
							@click.stop="openMenu($event, 'mask', ban.mask)"
						>
							{{ ban.mask }}
						</button>
						<span class="oper-row-main">
							<span class="oper-muted">{{ banText(ban) }}</span>
							<span v-if="ban.reason"> · "{{ ban.reason }}"</span>
						</span>
						<span :class="['oper-tag', ban.live ? 'bad' : 'plain']">{{
							ban.live ? "live" : "gone"
						}}</span>
					</li>
				</ul>
				<ul v-else-if="model.serviceBans.length" class="oper-bans oper-rows">
					<li v-for="ban in model.serviceBans" :key="ban.mask">
						<button
							type="button"
							class="oper-chip oper-chip-mask"
							title="Oper actions"
							@click.stop="openMenu($event, 'mask', ban.mask)"
						>
							{{ ban.mask }}
						</button>
						<span class="oper-row-main oper-muted">
							by {{ ban.issuedBy }}, {{ ban.issuedAgo }} ago, expires
							{{ ban.expiresIn === "never" ? "never" : "in " + ban.expiresIn
							}}<span v-if="ban.reason" class="oper-ban-reason">
								· "{{ ban.reason }}"</span
							></span
						>
						<span class="oper-tag bad">services</span>
					</li>
				</ul>
				<!-- The server's list read is an answer; a gtrace still out does not take it back. -->
				<p
					v-else-if="
						sources.stats === 'asking' ||
						(sources.stats !== 'done' && sources.gtrace === 'asking')
					"
					class="oper-empty oper-muted"
				>
					asking…
				</p>
				<p
					v-else
					:class="[
						'oper-empty',
						sources.stats === 'done' ? 'oper-empty-ok' : 'oper-muted',
					]"
				>
					<template v-if="sources.stats === 'done'">
						No live G-line, shun or Z-line covers them{{
							model.recentBans.length ? "" : ", and the kept feed saw none set"
						}}.
					</template>
					<template v-else
						>The ban list could not be read ({{
							notes.stats ?? "not asked"
						}}).</template
					>
				</p>
			</section>

			<section class="oper-card-section">
				<div class="oper-section-head">
					<h3 class="oper-report-section-title">Seen before</h3>
					<span v-if="model.seen.length" class="oper-count">{{ model.seen.length }}</span>
				</div>
				<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
					Not in {{ model.snoopMissing }}: earlier sessions aren't kept.
				</p>
				<ul v-if="model.seen.length" class="oper-seen oper-rows">
					<li v-for="s in model.seen" :key="s.nick">
						<span class="oper-row-time">{{ when(s.time) }}</span>
						<span class="oper-row-main">
							<Username :user="{nick: s.nick, mode: ''}" :network="network" />
							<template v-if="s.ip || s.host">
								<span class="oper-muted"> from </span>
								<button
									type="button"
									:class="[
										'oper-chip',
										s.ip ? 'oper-chip-ip' : 'oper-chip-host',
										{same: s.matched.includes(s.ip ? 'ip' : 'host')},
									]"
									title="Oper actions"
									@click.stop="
										openMenu($event, s.ip ? 'ip' : 'host', (s.ip ?? s.host)!)
									"
								>
									{{ s.ip ?? s.host }}
								</button>
							</template>
							<span v-if="s.fate" class="oper-row-fate oper-muted">{{ s.fate }}</span>
						</span>
						<span class="oper-row-tags">
							<span
								v-for="m in s.matched"
								:key="m"
								:class="['oper-tag', 'plain', {warn: m === 'ip'}]"
								>same {{ m === "ip" ? "IP" : m }}</span
							>
						</span>
					</li>
				</ul>
				<p v-else class="oper-empty oper-muted">
					Nothing in the kept feed shares their IP, host, realname or account.
				</p>
			</section>
		</template>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {type BanNear, whenText} from "../../js/helpers/verdict";
import {relativeTime, sinceTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu, operChanFor} from "../../js/helpers/operMenu";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import InvestigateFacts from "./InvestigateFacts.vue";
import Username from "../Username.vue";

export type UserPart = "verdict" | "facts" | "sections";

/**
 * One user as the user card shows them (irc/investigate.ts `UserModel`):
 * the verdict, the facts (InvestigateFacts), the bans near them, and who
 * was seen before with the same IP, host, realname or account. Compare
 * renders each user's verdict and sections in parts around one facts
 * panel for both.
 */
export default defineComponent({
	name: "InvestigateUser",
	components: {InvestigateFacts, Username},
	props: {
		model: {type: Object as PropType<UserModel>, required: true},
		sources: {
			type: Object as PropType<Partial<Record<SourceId, SourceState>>>,
			required: true,
		},
		notes: {type: Object as PropType<Partial<Record<SourceId, string>>>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		/** What to show: Compare puts the facts of both users in one panel
		 * and shows each one's verdict and sections around it. */
		parts: {
			type: Array as PropType<UserPart[]>,
			default: () => ["verdict", "facts", "sections"],
		},
	},
	/** `sent`: a chip's Check or Who went to that window (operMenu.ts). */
	emits: {sent: (chan: number) => typeof chan === "number"},
	setup(props, {emit}) {
		const store = useStore();
		const now = useNow();
		const bans = computed<BanNear[]>(() => [
			...props.model.liveBans,
			...props.model.recentBans,
		]);

		const banText = (ban: BanNear) => {
			const parts: string[] = [];

			if (ban.by) {
				parts.push(`by ${ban.by}`);
			}

			if (ban.setAt !== undefined) {
				parts.push(sinceTime(ban.setAt, now.value));
			}

			if (!ban.live) {
				parts.push(
					ban.expiresAt !== undefined && ban.expiresAt <= now.value
						? "expired"
						: "no longer live"
				);
			} else if (ban.expiresAt === 0) {
				parts.push("never expires");
			} else if (ban.expiresAt !== undefined) {
				parts.push(`expires ${relativeTime(ban.expiresAt, now.value)}`);
			}

			return `${ban.type} ${parts.join(", ")}`;
		};

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			const chan = operChanFor(props.network, store.state.activeChannel);
			openOperTargetMenu(event, props.network, chan, kind, value, (to) => emit("sent", to));
		};

		return {
			bans,
			banText,
			view: computed(() => props.model.verdictView),
			openMenu,
			when: (ms: number) => whenText(ms, now.value),
		};
	},
});
</script>
