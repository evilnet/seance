<template>
	<div class="oper-investigate-user">
		<template v-if="parts.includes('verdict')">
			<div v-if="view" :class="['oper-verdict', `tone-${view.tone}`]">
				<span class="oper-verdict-mark" aria-hidden="true"></span>
				<p class="oper-verdict-head">
					<span class="oper-verdict-kicker">{{ view.kicker }}</span>
					<span v-if="view.nick" class="oper-verdict-lead"
						><I18nFrame :text="view.lead"
							><template #nick
								><Username
									:user="{nick: view.nick, mode: ''}"
									:network="network" /></template></I18nFrame
					></span>
					<span v-else class="oper-verdict-lead">{{ view.lead }}</span>
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
						:title="t('oper.investigate.user.operActions')"
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
					<span class="oper-verdict-lead oper-muted">{{
						t("oper.investigate.user.lookingUp")
					}}</span>
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
					<h3 class="oper-report-section-title">
						{{ t("oper.investigate.user.bansNear") }}
					</h3>
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
							:title="t('oper.investigate.user.operActions')"
							@click.stop="openMenu($event, 'mask', ban.mask)"
						>
							{{ ban.mask }}
						</button>
						<span class="oper-row-main">
							<span class="oper-muted">{{ banText(ban) }}</span>
							<span v-if="ban.reason"> · "{{ ban.reason }}"</span>
						</span>
						<span :class="['oper-tag', ban.live ? 'bad' : 'plain']">{{
							ban.live
								? t("oper.investigate.user.banLive")
								: t("oper.investigate.user.banGone")
						}}</span>
					</li>
				</ul>
				<ul v-else-if="model.serviceBans.length" class="oper-bans oper-rows">
					<li v-for="ban in model.serviceBans" :key="ban.mask">
						<button
							type="button"
							class="oper-chip oper-chip-mask"
							:title="t('oper.investigate.user.operActions')"
							@click.stop="openMenu($event, 'mask', ban.mask)"
						>
							{{ ban.mask }}
						</button>
						<span class="oper-row-main oper-muted">
							{{
								ban.expiresIn === "never"
									? t("oper.investigate.user.serviceBanNever", {
											by: ban.issuedBy,
											ago: ban.issuedAgo,
									  })
									: t("oper.investigate.user.serviceBan", {
											by: ban.issuedBy,
											ago: ban.issuedAgo,
											expires: ban.expiresIn,
									  })
							}}<span v-if="ban.reason" class="oper-ban-reason">
								· "{{ ban.reason }}"</span
							></span
						>
						<span class="oper-tag bad">{{
							t("oper.investigate.user.byServices")
						}}</span>
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
					{{ t("oper.investigate.user.asking") }}
				</p>
				<p
					v-else
					:class="[
						'oper-empty',
						sources.stats === 'done' ? 'oper-empty-ok' : 'oper-muted',
					]"
				>
					<template v-if="sources.stats === 'done'">
						{{
							model.recentBans.length
								? t("oper.investigate.user.noLiveBans")
								: t("oper.investigate.user.noBansAtAll")
						}}
					</template>
					<template v-else>{{
						t("oper.investigate.user.banListUnread", {
							why: notes.stats ?? t("oper.investigate.user.notAsked"),
						})
					}}</template>
				</p>
			</section>

			<section class="oper-card-section">
				<div class="oper-section-head">
					<h3 class="oper-report-section-title">
						{{ t("oper.investigate.user.seenBefore") }}
					</h3>
					<span v-if="model.seen.length" class="oper-count">{{ model.seen.length }}</span>
				</div>
				<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
					{{ t("oper.investigate.user.snoopMissing", {channel: model.snoopMissing}) }}
				</p>
				<ul v-if="model.seen.length" class="oper-seen oper-rows">
					<li v-for="s in model.seen" :key="s.nick">
						<span class="oper-row-time">{{ when(s.time) }}</span>
						<span class="oper-row-main">
							<Username :user="{nick: s.nick, mode: ''}" :network="network" />
							<template v-if="s.ip || s.host">
								<span class="oper-muted">{{ fromParts[0] }}</span>
								<button
									type="button"
									:class="[
										'oper-chip',
										s.ip ? 'oper-chip-ip' : 'oper-chip-host',
										{same: s.matched.includes(s.ip ? 'ip' : 'host')},
									]"
									:title="t('oper.investigate.user.operActions')"
									@click.stop="
										openMenu($event, s.ip ? 'ip' : 'host', (s.ip ?? s.host)!)
									"
								>
									{{ s.ip ?? s.host }}
								</button>
								<span v-if="fromParts[1]" class="oper-muted">{{
									fromParts[1]
								}}</span>
							</template>
							<span v-if="s.fate" class="oper-row-fate oper-muted">{{
								fateText(s.fate)
							}}</span>
						</span>
						<span class="oper-row-tags">
							<span
								v-for="m in s.matched"
								:key="m"
								:class="['oper-tag', 'plain', {warn: m === 'ip'}]"
								>{{ sameTag(m) }}</span
							>
						</span>
					</li>
				</ul>
				<p v-else class="oper-empty oper-muted">
					{{ t("oper.investigate.user.nothingSeen") }}
				</p>
			</section>
		</template>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {type BanNear, fateText, type Matched, whenText} from "../../js/helpers/verdict";
import {commaList} from "../../js/helpers/operList";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import {relativeTime, sinceTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu, operChanFor} from "../../js/helpers/operMenu";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import InvestigateFacts from "./InvestigateFacts.vue";
import Username from "../Username.vue";
import I18nFrame from "../I18nFrame.vue";

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
	components: {I18nFrame, InvestigateFacts, Username},
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
		const {t} = useI18n();
		const bans = computed<BanNear[]>(() => [
			...props.model.liveBans,
			...props.model.recentBans,
		]);

		const banText = (ban: BanNear) => {
			const parts: string[] = [];

			if (ban.by) {
				parts.push(t("oper.investigate.user.banBy", {by: ban.by}));
			}

			if (ban.setAt !== undefined) {
				parts.push(sinceTime(ban.setAt, now.value));
			}

			if (!ban.live) {
				parts.push(
					ban.expiresAt !== undefined && ban.expiresAt <= now.value
						? t("oper.investigate.user.banExpired")
						: t("oper.investigate.user.banNotLive")
				);
			} else if (ban.expiresAt === 0) {
				parts.push(t("oper.investigate.user.banNeverExpires"));
			} else if (ban.expiresAt !== undefined) {
				parts.push(
					t("oper.investigate.user.banExpires", {
						when: relativeTime(ban.expiresAt, now.value),
					})
				);
			}

			return parts.length
				? t("oper.investigate.user.banLine", {type: ban.type, details: commaList(parts)})
				: ban.type;
		};

		/** `same IP`, `same realname`: a tag on a sighting. */
		const sameTag = (m: Matched) => {
			switch (m) {
				case "ip":
					return t("oper.investigate.same.ip");
				case "host":
					return t("oper.investigate.same.host");
				case "realname":
					return t("oper.investigate.same.realname");
				default:
					return t("oper.investigate.same.account");
			}
		};

		// A sighting's "from" around its address chip (the verdict's headline,
		// verdict.ts `lead`, is an I18nFrame holding `{nick}`).
		const fromParts = computed(() =>
			frameSegments(t("oper.investigate.user.seenFromAddress", {address: KEEP}), ["address"])
		);

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			const chan = operChanFor(props.network, store.state.activeChannel);
			openOperTargetMenu(event, props.network, chan, kind, value, (to) => emit("sent", to));
		};

		return {
			t,
			bans,
			banText,
			sameTag,
			fateText,
			fromParts,
			view: computed(() => props.model.verdictView),
			openMenu,
			when: (ms: number) => whenText(ms, now.value),
		};
	},
});
</script>
