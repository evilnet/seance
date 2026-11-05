<template>
	<dl
		:class="[
			'oper-report-entries',
			'oper-facts',
			'oper-props',
			{'oper-facts-pair': pair, 'oper-facts-differences': differences},
		]"
	>
		<div :class="['wide', {same: sameAs('host')}]">
			<dt>{{ t("oper.investigate.user.host") }}</dt>
			<dd v-for="s in sides" :key="s.model.target" class="oper-prop-flow">
				<template v-if="s.model.user.host">
					<span class="oper-mono">{{ s.model.user.ident ?? "?" }}@</span
					><button
						type="button"
						class="oper-chip oper-chip-host"
						:title="t('oper.investigate.user.operActions')"
						@click.stop="openMenu($event, 'host', s.model.user.host)"
					>
						{{ s.model.user.host }}
					</button>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('ip')}">
			<dt>{{ t("oper.investigate.user.ip") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.ip">
					<button
						type="button"
						class="oper-chip oper-chip-ip"
						:title="t('oper.investigate.user.operActions')"
						@click.stop="openMenu($event, 'ip', s.model.user.ip)"
					>
						{{ s.model.user.ip }}
					</button>
					<span v-if="place(s)" class="oper-muted">{{ place(s) }}</span>
				</template>
				<span v-else class="oper-muted">{{
					pending(s, "check", "whois", "userip", "lookups")
				}}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('server')}">
			<dt>{{ t("oper.investigate.user.server") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<span v-if="s.model.user.server" class="oper-server">{{
					s.model.user.server
				}}</span>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('account')}">
			<dt>{{ t("oper.investigate.user.account") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.account">{{ s.model.user.account }}</template>
				<span v-else-if="s.model.user.authed === false" class="oper-tag">{{
					t("oper.investigate.user.notAuthed")
				}}</span>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('realname')}">
			<dt>{{ t("oper.investigate.user.realname") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.realname !== undefined">{{
					s.model.user.realname
				}}</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div class="wide">
			<dt>{{ t("oper.investigate.user.connected") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.connectedAt !== undefined">
					<time
						:title="absolute(s.model.user.connectedAt)"
						:data-abs="absolute(s.model.user.connectedAt)"
						>{{ since(s.model.user.connectedAt) }}</time
					>
					<span v-if="s.model.user.idle !== undefined" class="oper-muted">
						·
						{{
							t("oper.investigate.user.idle", {duration: duration(s.model.user.idle)})
						}}</span
					>
					<span v-if="s.model.user.nickAge" class="oper-muted">
						·
						{{ t("oper.investigate.user.nickAge", {age: s.model.user.nickAge}) }}</span
					>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois") }}</span>
			</dd>
		</div>
		<!-- One user, two facts a row: a long version takes the row, and Modes
		     with it, so no half row is left empty. -->
		<div :class="{wide: pair || longVersion, same: sameAs('version')}">
			<dt>{{ t("oper.investigate.user.version") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.version">{{ s.model.user.version }}</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair || longVersion}">
			<dt>{{ t("oper.investigate.user.modes") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-if="s.model.user.modes" class="oper-mono oper-value">{{
					s.model.user.modes
				}}</code>
				<span v-if="s.model.user.oper" class="oper-tag plain">{{
					t("oper.investigate.user.chipOper")
				}}</span>
				<span v-if="s.model.user.away" class="oper-tag warn">{{
					t("oper.investigate.user.chipAway")
				}}</span>
				<span v-if="!s.model.user.modes && !s.model.user.oper" class="oper-muted">{{
					pending(s, "check", "lookups")
				}}</span>
			</dd>
		</div>
		<div class="wide">
			<dt>{{ t("oper.investigate.user.channels") }}</dt>
			<dd v-for="s in sides" :key="s.model.target" class="oper-prop-flow">
				<template v-if="s.model.user.channels && s.model.user.channels.length === 1">
					<span class="oper-muted">{{ onlyParts[0] }}</span
					><ParsedMessage :network="network" :text="s.model.user.channels[0]" /><span
						class="oper-muted"
						>{{ onlyParts[1] }}</span
					>
				</template>
				<template v-else-if="s.model.user.channels && s.model.user.channels.length">
					<span v-for="(c, i) in s.model.user.channels" :key="c"
						><template v-if="i > 0">{{ separator }}</template
						><ParsedMessage :network="network" :text="c"
					/></span>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div v-if="sides.some((s) => s.model.user.marks?.length)" class="wide">
			<dt>{{ t("oper.investigate.user.marks") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<span v-for="m in s.model.user.marks ?? []" :key="m" class="oper-tag plain">{{
					m
				}}</span>
				<span v-if="!s.model.user.marks?.length" class="oper-muted">—</span>
			</dd>
		</div>
		<div
			v-if="sides.some((s) => s.model.lastQuitHostmask)"
			:class="['wide', {same: sameAs('lastQuitHostmask')}]"
		>
			<dt>{{ t("oper.investigate.user.lastQuit") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-if="s.model.lastQuitHostmask" class="oper-mono oper-value">{{
					s.model.lastQuitHostmask
				}}</code>
				<span v-else class="oper-muted">—</span>
			</dd>
		</div>
		<div v-if="sides.some((s) => s.model.hostmasks?.length)" class="wide">
			<dt>{{ t("oper.investigate.user.hostmasks") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-for="m in s.model.hostmasks ?? []" :key="m" class="oper-mono oper-value">{{
					m
				}}</code>
				<span v-if="!s.model.hostmasks?.length" class="oper-muted">—</span>
			</dd>
		</div>
		<div v-if="pair" class="wide">
			<dt>{{ t("oper.investigate.user.bansNearShort") }}</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.liveBans.length || s.model.serviceBans.length">
					<span class="oper-tag bad">{{ bansNearTag(s) }}</span>
					<code class="oper-mono oper-value">{{
						(s.model.liveBans[0] ?? s.model.serviceBans[0]).mask
					}}</code>
				</template>
				<!-- As InvestigateUser's section: the list read is an answer, a
				     gtrace still out does not take it back; a list never read
				     is no answer at all. -->
				<span
					v-else-if="
						s.sources.stats === 'asking' ||
						(s.sources.stats !== 'done' && s.sources.gtrace === 'asking')
					"
					class="oper-muted"
					>{{ t("oper.investigate.user.asking") }}</span
				>
				<span v-else-if="s.sources.stats !== 'done'" class="oper-muted">{{
					t("oper.investigate.user.notRead")
				}}</span>
				<span v-else class="oper-muted">{{ t("oper.investigate.user.noBansNear") }}</span>
			</dd>
		</div>
	</dl>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {formatDuration, sinceTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu, operChanFor} from "../../js/helpers/operMenu";
import {formatDateTime} from "../../js/i18n/dates";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import {commaList} from "../../js/helpers/operList";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import {type ComparedKey, sameFact} from "../../js/helpers/operCompare";
import ParsedMessage from "../ParsedMessage.vue";

/** One user the facts are shown for, with the state of their lookups. */
export type FactSide = {
	model: UserModel;
	sources: Partial<Record<SourceId, SourceState>>;
};

/**
 * The user card's facts (irc/investigate.ts `UserModel`): a property
 * panel, two facts a row, the long ones across both. Given two users
 * (Compare), every fact is a row of its own with the two values side by
 * side under the card head's two nicks, a row whose values match is
 * marked, and Differences leaves those rows out.
 */
export default defineComponent({
	name: "InvestigateFacts",
	components: {ParsedMessage},
	props: {
		sides: {type: Array as PropType<FactSide[]>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		/** Compare's Differences: the rows whose values match are left out. */
		differences: {type: Boolean, default: false},
	},
	/** `sent`: a chip's Check or Who went to that window (operMenu.ts). */
	emits: {sent: (chan: number) => typeof chan === "number"},
	setup(props, {emit}) {
		const store = useStore();
		const now = useNow();
		const {t, tCount} = useI18n();
		const pair = computed(() => props.sides.length > 1);
		const place = (s: FactSide) =>
			commaList([s.model.user.country, s.model.user.city].filter((p): p is string => !!p));
		/** `asking…` while any of these sources is still out, else a dash. */
		const pending = (s: FactSide, ...ids: SourceId[]) =>
			ids.some((id) => s.sources[id] === "asking") ? t("oper.investigate.user.asking") : "—";
		/** Compare's "Bans near" tag: the live ones, else the services' count. */
		const bansNearTag = (s: FactSide) =>
			s.model.liveBans.length
				? tCount("oper.investigate.user.liveBanCount", s.model.liveBans.length)
				: tCount("oper.investigate.user.serviceBanCount", s.model.serviceBans.length);
		// "only #chan": a user in one channel, the channel's element inside the sentence.
		const onlyParts = computed(() =>
			frameSegments(t("oper.investigate.user.onlyChannel", {channel: KEEP}), ["channel"])
		);

		/** Both users have this fact, and it is the same (helpers/operCompare.ts). */
		const sameAs = (key: ComparedKey) => {
			const [a, b] = props.sides;
			return !!a && !!b && sameFact(a.model, b.model, key);
		};

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			const chan = operChanFor(props.network, store.state.activeChannel);
			openOperTargetMenu(event, props.network, chan, kind, value, (to) => emit("sent", to));
		};

		return {
			t,
			bansNearTag,
			onlyParts,
			separator: computed(() => t("oper.list.separator")),
			pair,
			longVersion: computed(() => (props.sides[0]?.model.user.version ?? "").length > 24),
			place,
			pending,
			sameAs,
			openMenu,
			absolute: (ms: number) => formatDateTime(ms),
			since: (ms: number) => sinceTime(ms, now.value),
			duration: formatDuration,
		};
	},
});
</script>
