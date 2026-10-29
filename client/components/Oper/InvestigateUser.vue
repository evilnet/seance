<template>
	<div class="oper-investigate-user">
		<dl class="oper-report-entries oper-facts">
			<div :class="{same: sameAs('host')}">
				<dt>{{ t("oper.investigate.user.host") }}</dt>
				<dd>
					<template v-if="user.host">
						<span class="oper-mono">{{ user.ident ?? "?" }}@</span
						><button
							type="button"
							class="oper-chip oper-chip-host"
							:title="t('oper.investigate.user.operActions')"
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
				<dt>{{ t("oper.investigate.user.ip") }}</dt>
				<dd>
					<template v-if="user.ip">
						<button
							type="button"
							class="oper-chip oper-chip-ip"
							:title="t('oper.investigate.user.operActions')"
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
				<dt>{{ t("oper.investigate.user.account") }}</dt>
				<dd>
					<template v-if="user.account">{{ user.account }}</template>
					<span v-else-if="user.authed === false" class="oper-muted">{{
						t("oper.investigate.user.notAuthed")
					}}</span>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('realname')}">
				<dt>{{ t("oper.investigate.user.realname") }}</dt>
				<dd>
					<template v-if="user.realname !== undefined">{{ user.realname }}</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div>
				<dt>{{ t("oper.investigate.user.connected") }}</dt>
				<dd>
					<template v-if="user.connectedAt !== undefined">
						<time :title="absolute(user.connectedAt)">{{
							relative(user.connectedAt)
						}}</time>
						<span v-if="user.idle !== undefined" class="oper-muted">
							·
							{{
								t("oper.investigate.user.idle", {duration: duration(user.idle)})
							}}</span
						>
						<span v-if="user.nickAge" class="oper-muted">
							· {{ t("oper.investigate.user.nickAge", {age: user.nickAge}) }}</span
						>
					</template>
					<span v-else class="oper-muted">{{ pending("check", "whois") }}</span>
				</dd>
			</div>
			<div :class="{same: sameAs('version')}">
				<dt>{{ t("oper.investigate.user.version") }}</dt>
				<dd>
					<template v-if="user.version">{{ user.version }}</template>
					<span v-else class="oper-muted">{{ pending("check", "lookups") }}</span>
				</dd>
			</div>
			<div>
				<dt>{{ t("oper.investigate.user.modes") }}</dt>
				<dd>
					<code v-if="user.modes" class="oper-mono">{{ user.modes }}</code>
					<span v-if="user.oper" class="oper-chip-static">{{
						t("oper.investigate.user.chipOper")
					}}</span>
					<span v-if="user.away" class="oper-chip-static">{{
						t("oper.investigate.user.chipAway")
					}}</span>
					<span v-if="!user.modes && !user.oper" class="oper-muted">{{
						pending("check", "lookups")
					}}</span>
				</dd>
			</div>
			<div>
				<dt>{{ t("oper.investigate.user.channels") }}</dt>
				<dd>
					<template v-if="user.channels && user.channels.length">
						<template v-if="user.channels.length === 1"
							><span class="oper-muted">{{ onlyParts[0] }}</span
							><ParsedMessage :network="network" :text="user.channels[0]" /><span
								class="oper-muted"
								>{{ onlyParts[1] }}</span
							></template
						>
						<template v-else
							><span v-for="(c, i) in user.channels" :key="c"
								><template v-if="i > 0">{{ separator }}</template
								><ParsedMessage :network="network" :text="c" /></span
						></template>
					</template>
					<span v-else class="oper-muted">{{
						pending("check", "whois", "lookups")
					}}</span>
				</dd>
			</div>
			<div v-if="user.marks && user.marks.length">
				<dt>{{ t("oper.investigate.user.marks") }}</dt>
				<dd>
					<span class="oper-chips"
						><span v-for="m in user.marks" :key="m" class="oper-chip-static">{{
							m
						}}</span></span
					>
				</dd>
			</div>
			<div v-if="model.lastQuitHostmask" :class="{same: sameAs('lastQuitHostmask')}">
				<dt>{{ t("oper.investigate.user.lastQuit") }}</dt>
				<dd>
					<code class="oper-mono">{{ model.lastQuitHostmask }}</code>
				</dd>
			</div>
			<div v-if="model.hostmasks && model.hostmasks.length">
				<dt>{{ t("oper.investigate.user.hostmasks") }}</dt>
				<dd>
					<span class="oper-chips"
						><code v-for="m in model.hostmasks" :key="m" class="oper-mono">{{
							m
						}}</code></span
					>
				</dd>
			</div>
		</dl>

		<h3 class="oper-report-section-title">{{ t("oper.investigate.user.bansNear") }}</h3>
		<ul v-if="bans.length" class="oper-bans">
			<li v-for="ban in bans" :key="ban.mask + ban.live" :class="{expired: !ban.live}">
				<button
					type="button"
					class="oper-chip oper-chip-mask"
					:title="t('oper.investigate.user.operActions')"
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
					:title="t('oper.investigate.user.operActions')"
					@click.stop="openMenu($event, 'mask', ban.mask)"
				>
					{{ ban.mask }}
				</button>
				<span class="oper-muted">
					·
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
					}}</span
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
			{{ t("oper.investigate.user.asking") }}
		</p>
		<p v-else class="oper-muted">
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

		<h3 class="oper-report-section-title">{{ t("oper.investigate.user.seenBefore") }}</h3>
		<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
			{{ t("oper.investigate.user.snoopMissing", {channel: model.snoopMissing}) }}
		</p>
		<ul v-if="model.seen.length" class="oper-seen">
			<li v-for="s in model.seen" :key="s.nick">
				<span class="oper-muted">{{ when(s.time) }} · </span>
				<Username :user="{nick: s.nick, mode: ''}" :network="network" />
				<span v-if="s.ip || s.host" class="oper-muted">
					<!-- The frame follows the nick: its space is ours to give. -->
					{{ " " + fromParts(s)[0] }}<code class="oper-mono">{{ s.ip ?? s.host }}</code
					>{{ fromParts(s)[1] }}</span
				>
				<span v-else class="oper-muted"> ({{ matchedText(s) }})</span>
				<span v-if="s.fate">, {{ fateText(s.fate) }}</span>
			</li>
		</ul>
		<p v-else class="oper-muted">
			{{ t("oper.investigate.user.nothingSeen") }}
		</p>

		<p class="oper-verdict">{{ model.verdict || "…" }}</p>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import type {InvestigatedUser, SourceId, SourceState, UserModel} from "../../js/irc/investigate";
import {
	type BanNear,
	fateText,
	type Matched,
	type SeenEntry,
	whenText,
} from "../../js/helpers/verdict";
import {commaList} from "../../js/helpers/operList";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import {formatDuration, relativeTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu} from "../../js/helpers/operMenu";
import {formatDateTime} from "../../js/i18n/dates";
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
		const {t} = useI18n();
		const user = computed<InvestigatedUser>(() => props.model.user);

		const place = computed(() =>
			commaList([user.value.country, user.value.city].filter(Boolean) as string[])
		);

		/** `asking…` while any of these sources is still out, else a dash. */
		const pending = (...ids: SourceId[]) =>
			ids.some((id) => props.sources[id] === "asking")
				? t("oper.investigate.user.asking")
				: "—";

		/** The text around the one channel in `only #chan`. */
		const onlyParts = computed(() =>
			frameSegments(t("oper.investigate.user.onlyChannel", {channel: KEEP}), ["channel"])
		);
		const separator = computed(() => t("oper.list.separator"));

		const bans = computed<BanNear[]>(() => [
			...props.model.liveBans,
			...props.model.recentBans,
		]);

		/** `G-line by rubin, 3 d ago, never expires`: the ban's type, then its details. */
		const banText = (ban: BanNear) => {
			const parts: string[] = [];

			if (ban.by) {
				parts.push(t("oper.investigate.user.banBy", {by: ban.by}));
			}

			if (ban.setAt !== undefined) {
				parts.push(relativeTime(ban.setAt, now.value));
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

		const thisText = (m: Matched) => {
			switch (m) {
				case "ip":
					return t("oper.investigate.user.thisIp");
				case "host":
					return t("oper.investigate.user.thisHost");
				case "realname":
					return t("oper.investigate.user.thisRealname");
				default:
					return t("oper.investigate.user.thisAccount");
			}
		};

		const matchedText = (s: SeenEntry) => commaList(s.matched.map(thisText));

		/** The text around the address in `from 1.2.3.4 (this IP)`. */
		const fromParts = (s: SeenEntry) => {
			const matched = s.matched.includes("ip")
				? thisText("ip")
				: s.matched.includes("host")
				? thisText("host")
				: matchedText(s);
			return frameSegments(t("oper.investigate.user.seenFrom", {address: KEEP, matched}), [
				"address",
			]);
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
			const chan = store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			openOperTargetMenu(event, props.network, chan, kind, value);
		};

		return {
			t,
			user,
			place,
			pending,
			onlyParts,
			separator,
			fromParts,
			fateText,
			bans,
			banText,
			matchedText,
			sameAs,
			openMenu,
			when: (ms: number) => whenText(ms, now.value),
			absolute: (ms: number) => formatDateTime(new Date(ms)),
			relative: (ms: number) => relativeTime(ms, now.value),
			duration: formatDuration,
		};
	},
});
</script>
