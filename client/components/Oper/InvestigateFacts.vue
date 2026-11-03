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
			<dt>Host</dt>
			<dd v-for="s in sides" :key="s.model.target" class="oper-prop-flow">
				<template v-if="s.model.user.host">
					<span class="oper-mono">{{ s.model.user.ident ?? "?" }}@</span
					><button
						type="button"
						class="oper-chip oper-chip-host"
						title="Oper actions"
						@click.stop="openMenu($event, 'host', s.model.user.host)"
					>
						{{ s.model.user.host }}
					</button>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('ip')}">
			<dt>IP</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.ip">
					<button
						type="button"
						class="oper-chip oper-chip-ip"
						title="Oper actions"
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
			<dt>Server</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<span v-if="s.model.user.server" class="oper-server">{{
					s.model.user.server
				}}</span>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('account')}">
			<dt>Account</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.account">{{ s.model.user.account }}</template>
				<span v-else-if="s.model.user.authed === false" class="oper-tag">not authed</span>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair, same: sameAs('realname')}">
			<dt>Realname</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.realname !== undefined">{{
					s.model.user.realname
				}}</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div class="wide">
			<dt>Connected</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.connectedAt !== undefined">
					<time
						:title="absolute(s.model.user.connectedAt)"
						:data-abs="absolute(s.model.user.connectedAt)"
						>{{ since(s.model.user.connectedAt) }}</time
					>
					<span v-if="s.model.user.idle !== undefined" class="oper-muted">
						· idle {{ duration(s.model.user.idle) }}</span
					>
					<span v-if="s.model.user.nickAge" class="oper-muted">
						· nick age {{ s.model.user.nickAge }}</span
					>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois") }}</span>
			</dd>
		</div>
		<!-- One user, two facts a row: a long version takes the row, and Modes
		     with it, so no half row is left empty. -->
		<div :class="{wide: pair || longVersion, same: sameAs('version')}">
			<dt>Version</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.user.version">{{ s.model.user.version }}</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "lookups") }}</span>
			</dd>
		</div>
		<div :class="{wide: pair || longVersion}">
			<dt>Modes</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-if="s.model.user.modes" class="oper-mono oper-value">{{
					s.model.user.modes
				}}</code>
				<span v-if="s.model.user.oper" class="oper-tag plain">oper</span>
				<span v-if="s.model.user.away" class="oper-tag warn">away</span>
				<span v-if="!s.model.user.modes && !s.model.user.oper" class="oper-muted">{{
					pending(s, "check", "lookups")
				}}</span>
			</dd>
		</div>
		<div class="wide">
			<dt>Channels</dt>
			<dd v-for="s in sides" :key="s.model.target" class="oper-prop-flow">
				<template v-if="s.model.user.channels && s.model.user.channels.length">
					<span v-if="s.model.user.channels.length === 1" class="oper-muted">only </span
					><span v-for="(c, i) in s.model.user.channels" :key="c"
						><template v-if="i > 0">, </template
						><ParsedMessage :network="network" :text="c"
					/></span>
				</template>
				<span v-else class="oper-muted">{{ pending(s, "check", "whois", "lookups") }}</span>
			</dd>
		</div>
		<div v-if="sides.some((s) => s.model.user.marks?.length)" class="wide">
			<dt>Marks</dt>
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
			<dt>Last quit</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-if="s.model.lastQuitHostmask" class="oper-mono oper-value">{{
					s.model.lastQuitHostmask
				}}</code>
				<span v-else class="oper-muted">—</span>
			</dd>
		</div>
		<div v-if="sides.some((s) => s.model.hostmasks?.length)" class="wide">
			<dt>Hostmasks</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<code v-for="m in s.model.hostmasks ?? []" :key="m" class="oper-mono oper-value">{{
					m
				}}</code>
				<span v-if="!s.model.hostmasks?.length" class="oper-muted">—</span>
			</dd>
		</div>
		<div v-if="pair" class="wide">
			<dt>Bans near</dt>
			<dd v-for="s in sides" :key="s.model.target">
				<template v-if="s.model.liveBans.length || s.model.serviceBans.length">
					<span class="oper-tag bad">{{
						s.model.liveBans.length
							? `${s.model.liveBans.length} live`
							: `${s.model.serviceBans.length} by services`
					}}</span>
					<code class="oper-mono oper-value">{{
						(s.model.liveBans[0] ?? s.model.serviceBans[0]).mask
					}}</code>
				</template>
				<span v-else-if="s.sources.stats === 'asking'" class="oper-muted">asking…</span>
				<span v-else class="oper-muted">none</span>
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
import localetime from "../../js/helpers/localetime";
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
		const pair = computed(() => props.sides.length > 1);
		const place = (s: FactSide) =>
			[s.model.user.country, s.model.user.city].filter(Boolean).join(", ");
		/** `asking…` while any of these sources is still out, else a dash. */
		const pending = (s: FactSide, ...ids: SourceId[]) =>
			ids.some((id) => s.sources[id] === "asking") ? "asking…" : "—";

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
			pair,
			longVersion: computed(() => (props.sides[0]?.model.user.version ?? "").length > 24),
			place,
			pending,
			sameAs,
			openMenu,
			absolute: (ms: number) => localetime(new Date(ms)),
			since: (ms: number) => sinceTime(ms, now.value),
			duration: formatDuration,
		};
	},
});
</script>
