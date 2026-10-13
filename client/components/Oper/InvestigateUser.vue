<template>
	<div class="oper-investigate-user">
		<dl class="oper-report-entries oper-facts">
			<div :class="{same: sameAs('host')}">
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
						<span v-if="place" class="oper-muted"> · {{ place }}</span>
						<span v-if="user.server" class="oper-muted">
							· <span class="oper-server">{{ user.server }}</span></span
						>
					</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "userip", "lookups")
					}}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('account')}">
				<dt>Account</dt>
				<dd>
					<template v-if="user.account">{{ user.account }}</template>
					<span v-else-if="user.authed === false" class="oper-muted">not authed</span>
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
			<div>
				<dt>Connected</dt>
				<dd>
					<template v-if="user.connectedAt !== undefined">
						<time :title="absolute(user.connectedAt)">{{
							relative(user.connectedAt)
						}}</time>
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
					<code v-if="user.modes" class="oper-mono">{{ user.modes }}</code>
					<span v-if="user.oper" class="oper-chip-static">oper</span>
					<span v-if="user.away" class="oper-chip-static">away</span>
					<span v-if="!user.modes && !user.oper" class="oper-muted">{{
						pending("check", "lookups")
					}}</span>
				</dd>
			</div>
			<div>
				<dt>Channels</dt>
				<dd>
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
			<div v-if="user.marks && user.marks.length">
				<dt>Marks</dt>
				<dd>
					<span class="oper-chips"
						><span v-for="m in user.marks" :key="m" class="oper-chip-static">{{
							m
						}}</span></span
					>
				</dd>
			</div>
			<div v-if="model.lastQuitHostmask" :class="{same: sameAs('lastQuitHostmask')}">
				<dt>Last quit</dt>
				<dd>
					<code class="oper-mono">{{ model.lastQuitHostmask }}</code>
				</dd>
			</div>
			<div v-if="model.hostmasks && model.hostmasks.length">
				<dt>Hostmasks</dt>
				<dd>
					<span class="oper-chips"
						><code v-for="m in model.hostmasks" :key="m" class="oper-mono">{{
							m
						}}</code></span
					>
				</dd>
			</div>
		</dl>

		<h3 class="oper-report-section-title">Bans near this user</h3>
		<ul v-if="bans.length" class="oper-bans">
			<li v-for="ban in bans" :key="ban.mask + ban.live" :class="{expired: !ban.live}">
				<button
					type="button"
					class="oper-chip oper-chip-mask"
					title="Oper actions"
					@click.stop="openMenu($event, 'mask', ban.mask)"
				>
					{{ ban.mask }}
				</button>
				<span class="oper-muted"> · {{ banText(ban) }}</span>
				<span v-if="ban.reason"> · "{{ ban.reason }}"</span>
			</li>
		</ul>
		<ul v-else-if="model.serviceBans.length" class="oper-bans">
			<li v-for="ban in model.serviceBans" :key="ban.mask">
				<button
					type="button"
					class="oper-chip oper-chip-mask"
					title="Oper actions"
					@click.stop="openMenu($event, 'mask', ban.mask)"
				>
					{{ ban.mask }}
				</button>
				<span class="oper-muted">
					· by {{ ban.issuedBy }}, {{ ban.issuedAgo }} ago, expires
					{{ ban.expiresIn === "never" ? "never" : "in " + ban.expiresIn }}</span
				>
				<span v-if="ban.reason"> · "{{ ban.reason }}"</span>
			</li>
		</ul>
		<!-- The server's list read is an answer; a gtrace still out does not take it back. -->
		<p
			v-else-if="
				sources.stats === 'asking' ||
				(sources.stats !== 'done' && sources.gtrace === 'asking')
			"
			class="oper-muted"
		>
			asking…
		</p>
		<p v-else class="oper-muted">
			<template v-if="sources.stats === 'done'">
				No live G-line, shun or Z-line covers them{{
					model.recentBans.length ? "" : ", and the kept feed saw none set"
				}}.
			</template>
			<template v-else
				>The ban list could not be read ({{ notes.stats ?? "not asked" }}).</template
			>
		</p>

		<h3 class="oper-report-section-title">Seen before</h3>
		<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
			Not in {{ model.snoopMissing }}: earlier sessions aren't kept.
		</p>
		<ul v-if="model.seen.length" class="oper-seen">
			<li v-for="s in model.seen" :key="s.nick">
				<span class="oper-muted">{{ when(s.time) }} · </span>
				<Username :user="{nick: s.nick, mode: ''}" :network="network" />
				<span v-if="s.ip || s.host" class="oper-muted">
					from <code class="oper-mono">{{ s.ip ?? s.host }}</code> ({{
						s.matched.includes("ip")
							? "this IP"
							: s.matched.includes("host")
							? "this host"
							: matchedText(s)
					}})</span
				>
				<span v-else class="oper-muted"> ({{ matchedText(s) }})</span>
				<span v-if="s.fate">, {{ s.fate }}</span>
			</li>
		</ul>
		<p v-else class="oper-muted">
			Nothing in the kept feed shares their IP, host, realname or account.
		</p>

		<p class="oper-verdict">{{ model.verdict || "…" }}</p>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {InvestigatedUser, SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {type BanNear, type SeenEntry, whenText} from "../../js/helpers/verdict";
import {formatDuration, relativeTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu} from "../../js/helpers/operMenu";
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

		const matchedText = (s: SeenEntry) =>
			s.matched.map((m) => (m === "ip" ? "this IP" : `this ${m}`)).join(", ");

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
			const chan = store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			openOperTargetMenu(event, props.network, chan, kind, value);
		};

		return {
			user,
			place,
			pending,
			bans,
			banText,
			matchedText,
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
