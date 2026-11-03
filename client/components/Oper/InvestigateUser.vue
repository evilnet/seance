<template>
	<div class="oper-investigate-user">
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

		<dl class="oper-report-entries oper-facts oper-props">
			<div :class="['wide', {same: sameAs('host')}]">
				<dt>Host</dt>
				<dd>
					<template v-if="user.host">
						<span class="oper-mono">{{ user.ident ?? "?" }}@</span
						><button
							type="button"
							class="oper-chip oper-chip-host"
							title="Oper actions"
							@click.stop="openMenu($event, 'host', user.host)"
						>
							{{ user.host }}
						</button>
					</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('ip')}">
				<dt>IP</dt>
				<dd>
					<template v-if="user.ip">
						<button
							type="button"
							class="oper-chip oper-chip-ip"
							title="Oper actions"
							@click.stop="openMenu($event, 'ip', user.ip)"
						>
							{{ user.ip }}
						</button>
						<span v-if="place" class="oper-muted">{{ place }}</span>
					</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "userip", "lookups")
					}}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('server')}">
				<dt>Server</dt>
				<dd>
					<span v-if="user.server" class="oper-server">{{ user.server }}</span>
					<span v-else class="oper-muted">{{ pending("check", "whois") }}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('account')}">
				<dt>Account</dt>
				<dd>
					<template v-if="user.account">{{ user.account }}</template>
					<span v-else-if="user.authed === false" class="oper-tag">not authed</span>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('realname')}">
				<dt>Realname</dt>
				<dd>
					<template v-if="user.realname !== undefined">{{ user.realname }}</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div class="wide">
				<dt>Connected</dt>
				<dd>
					<template v-if="user.connectedAt !== undefined">
						<time
							:title="absolute(user.connectedAt)"
							:data-abs="absolute(user.connectedAt)"
							>{{ relative(user.connectedAt) }}</time
						>
						<span v-if="user.idle !== undefined" class="oper-muted">
							· idle {{ duration(user.idle) }}</span
						>
						<span v-if="user.nickAge" class="oper-muted">
							· nick age {{ user.nickAge }}</span
						>
					</template>
					<span v-else class="oper-muted">{{ pending("check", "whois") }}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('version')}">
				<dt>Version</dt>
				<dd>
					<template v-if="user.version">{{ user.version }}</template>
					<span v-else class="oper-muted">{{ pending("check", "lookups") }}</span>
				</dd>
			</div>
			<div>
				<dt>Modes</dt>
				<dd>
					<code v-if="user.modes" class="oper-mono oper-value">{{ user.modes }}</code>
					<span v-if="user.oper" class="oper-tag plain">oper</span>
					<span v-if="user.away" class="oper-tag warn">away</span>
					<span v-if="!user.modes && !user.oper" class="oper-muted">{{
						pending("check", "lookups")
					}}</span>
				</dd>
			</div>
			<div class="wide">
				<dt>Channels</dt>
				<dd class="oper-prop-flow">
					<template v-if="user.channels && user.channels.length">
						<span v-if="user.channels.length === 1" class="oper-muted">only </span
						><span v-for="(c, i) in user.channels" :key="c"
							><template v-if="i > 0">, </template
							><ParsedMessage :network="network" :text="c"
						/></span>
					</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div v-if="user.marks && user.marks.length" class="wide">
				<dt>Marks</dt>
				<dd>
					<span v-for="m in user.marks" :key="m" class="oper-tag plain">{{ m }}</span>
				</dd>
			</div>
			<div
				v-if="model.lastQuitHostmask"
				:class="['wide', {same: sameAs('lastQuitHostmask')}]"
			>
				<dt>Last quit</dt>
				<dd>
					<code class="oper-mono oper-value">{{ model.lastQuitHostmask }}</code>
				</dd>
			</div>
			<div v-if="model.hostmasks && model.hostmasks.length" class="wide">
				<dt>Hostmasks</dt>
				<dd>
					<code v-for="m in model.hostmasks" :key="m" class="oper-mono oper-value">{{
						m
					}}</code>
				</dd>
			</div>
		</dl>

		<section class="oper-card-section">
			<div class="oper-section-head">
				<h3 class="oper-report-section-title">Bans near this user</h3>
				<span v-if="bans.length || model.serviceBans.length" class="oper-count">{{
					bans.length || model.serviceBans.length
				}}</span>
			</div>
			<ul v-if="bans.length" class="oper-bans oper-rows">
				<li v-for="ban in bans" :key="ban.mask + ban.live" :class="{expired: !ban.live}">
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
				:class="['oper-empty', sources.stats === 'done' ? 'oper-empty-ok' : 'oper-muted']"
			>
				<template v-if="sources.stats === 'done'">
					No live G-line, shun or Z-line covers them{{
						model.recentBans.length ? "" : ", and the kept feed saw none set"
					}}.
				</template>
				<template v-else
					>The ban list could not be read ({{ notes.stats ?? "not asked" }}).</template
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
								@click.stop="openMenu($event, s.ip ? 'ip' : 'host', (s.ip ?? s.host)!)"
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
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {InvestigatedUser, SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {type BanNear, whenText} from "../../js/helpers/verdict";
import {formatDuration, relativeTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu, operChanFor} from "../../js/helpers/operMenu";
import localetime from "../../js/helpers/localetime";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

/**
 * One user as the user card shows them (irc/investigate.ts `UserModel`):
 * the facts grid, the bans near them, who was seen before with the same
 * IP, host, realname or account, and the verdict. Rendered twice, side
 * by side, by Compare — then `other` is the second user and every row
 * whose value matches theirs is tinted.
 */
export default defineComponent({
	name: "InvestigateUser",
	components: {ParsedMessage, Username},
	props: {
		model: {type: Object as PropType<UserModel>, required: true},
		sources: {
			type: Object as PropType<Partial<Record<SourceId, SourceState>>>,
			required: true,
		},
		notes: {type: Object as PropType<Partial<Record<SourceId, string>>>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		other: {type: Object as PropType<UserModel>, required: false},
	},
	setup(props) {
		const store = useStore();
		const now = useNow();
		const user = computed<InvestigatedUser>(() => props.model.user);

		const place = computed(() =>
			[user.value.country, user.value.city].filter(Boolean).join(", ")
		);

		/** `asking…` while any of these sources is still out, else a dash. */
		const pending = (...ids: SourceId[]) =>
			ids.some((id) => props.sources[id] === "asking") ? "asking…" : "—";

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
				parts.push(`${relativeTime(ban.setAt, now.value)}`);
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

		/** The compared user's value for a row, for the tint. */
		const valueOf = (model: UserModel, key: string): string | undefined => {
			if (key === "lastQuitHostmask") {
				return model.lastQuitHostmask;
			}

			const value = (model.user as unknown as Record<string, unknown>)[key];
			return typeof value === "string" ? value.toLowerCase() : undefined;
		};

		const sameAs = (key: string) => {
			if (!props.other) {
				return false;
			}

			const a = valueOf(props.model, key);
			const b = valueOf(props.other, key);
			return a !== undefined && a !== "" && a === b;
		};

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			const chan = operChanFor(props.network, store.state.activeChannel);
			openOperTargetMenu(event, props.network, chan, kind, value);
		};

		return {
			user,
			place,
			pending,
			bans,
			banText,
			view: computed(() => props.model.verdictView),
			sameAs,
			openMenu,
			when: (ms: number) => whenText(ms, now.value),
			absolute: (ms: number) => localetime(new Date(ms)),
			relative: (ms: number) => relativeTime(ms, now.value),
			duration: formatDuration,
		};
	},
});
</script>
