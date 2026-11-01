<template>
	<div class="oper-me">
		<p class="oper-me-status">
			<span class="oper-me-level">{{ levelLabel }}</span>
			<span v-if="network.oper?.umodes" class="oper-me-sep">·</span>
			<code v-if="network.oper?.umodes">+{{ network.oper.umodes }}</code>
			<span class="oper-me-sep">·</span>
			<span class="oper-me-profile">{{ profileName }}</span>
		</p>

		<details class="oper-fold oper-me-privs" :open="privs.length <= 12">
			<summary>
				{{
					network.oper?.privsKnown
						? t("oper.me.privileges", {count: privs.length})
						: t("oper.me.privilegesUnknown")
				}}
				<button type="button" class="btn btn-small oper-refresh" @click.prevent="refresh">
					{{ t("oper.me.refresh") }}
				</button>
			</summary>
			<p v-if="!network.oper?.privsKnown" class="oper-muted">
				{{ t("oper.me.privsNotReported") }}
			</p>
			<p v-else-if="!privs.length" class="oper-muted">{{ t("oper.me.privsNone") }}</p>
			<p v-else class="oper-chips oper-privs">
				<span v-for="p in privs" :key="p" class="oper-chip-static" :title="privHelp(p)">{{
					p
				}}</span>
			</p>
		</details>

		<h2>{{ t("oper.me.userModes") }}</h2>
		<ul class="oper-umodes">
			<li v-for="m in modes" :key="m.letter" :class="{unavailable: !allowed(m)}">
				<label :title="m.description">
					<input
						v-switch
						type="checkbox"
						:checked="has(m.letter)"
						:disabled="!allowed(m) && !has(m.letter)"
						@change="set(m.letter, ($event.target as HTMLInputElement).checked)"
					/>
					<code>+{{ m.letter }}</code>
					<span class="oper-umode-text">
						<span class="oper-umode-label">{{ m.label }}</span>
						<span class="sr-only">. {{ m.description }}</span>
						<span v-if="!allowed(m)" class="oper-umode-needs">{{
							t("oper.me.needsPriv", {priv: m.priv ?? ""})
						}}</span>
					</span>
				</label>
			</li>
		</ul>
	</div>
</template>

<style>
.oper-me-status {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0.4rem;
	margin: 0 0 1rem;
	font-size: 1.0625em;
}

.oper-me-sep,
.oper-me-profile {
	color: var(--body-color-muted);
}

.oper-me h2 {
	margin: 1.25rem 0 0.5rem;
	font-size: 1em;
	color: var(--body-color-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.oper-me-privs {
	margin-top: 0;
}

.oper-me-privs > summary {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	font-size: 1em;
	color: var(--body-color-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.oper-me-privs > summary .oper-refresh {
	margin: 0;
	text-transform: none;
	letter-spacing: normal;
}

.oper-me-privs .oper-privs {
	margin: 0.25rem 0 0;
}

.oper-umodes {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
	gap: 0.2rem 1rem;
}

.oper-umodes li.unavailable .oper-umode-label {
	color: var(--body-color-muted);
}

.oper-umodes label {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	cursor: pointer;
	padding: 0.2rem 0;
}

.oper-umode-text {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.oper-umode-needs {
	color: var(--body-color-muted);
	font-size: 0.8125em;
}
</style>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork} from "../../js/types";
import socket from "../../js/socket";
import {hasPriv} from "../../js/helpers/operMenu";
import {profileById, profileName} from "../../js/irc/profiles";
import {useI18n} from "../../js/i18n";

interface UserMode {
	letter: string;
	label: string;
	description: string;
	/** The privilege nefarious2 wants before it lets you set it. */
	priv?: string;
}

/** nefarious2's user modes an oper may want to flip (docs/resources/nefarious2-oper.md §3). */
const NEFARIOUS_MODES: {letter: string; priv?: string}[] = [
	{letter: "s"},
	{letter: "w"},
	{letter: "g"},
	{letter: "d"},
	{letter: "D"},
	{letter: "R"},
	{letter: "q"},
	{letter: "p"},
	{letter: "I", priv: "HIDE_IDLE"},
	{letter: "W", priv: "WHOIS_NOTICE"},
	{letter: "H", priv: "HIDE_OPER"},
	{letter: "X", priv: "XTRAOP"},
];

const GENERIC_MODES: {letter: string; priv?: string}[] = [
	{letter: "s"},
	{letter: "w"},
	{letter: "i"},
];

/**
 * The Me tab (docs/projects/oper-tools.md, "The panel, redrawn"): one line
 * of status, the privileges folded, the user modes as a small grid with
 * the explanation on hover (and read out to a screen reader).
 */
export default defineComponent({
	name: "OperMe",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const profile = computed(() => profileById(props.network.oper?.profile));
		const {t, locale} = useI18n();
		const nefarious = computed(() => profile.value.id === "nefarious2");

		/** A mode's label and the explanation on hover, in words. */
		const modeText = (letter: string): {label: string; description: string} => {
			switch (letter) {
				case "s":
					return {
						label: t("oper.me.mode.s"),
						description: nefarious.value
							? t("oper.me.mode.sHelp")
							: t("oper.me.mode.sHelpGeneric"),
					};
				case "w":
					return {
						label: t("oper.me.mode.w"),
						description: nefarious.value
							? t("oper.me.mode.wHelp")
							: t("oper.me.mode.wHelpGeneric"),
					};
				case "g":
					return {label: t("oper.me.mode.g"), description: t("oper.me.mode.gHelp")};
				case "d":
					return {label: t("oper.me.mode.d"), description: t("oper.me.mode.dHelp")};
				case "D":
					return {
						label: t("oper.me.mode.DUpper"),
						description: t("oper.me.mode.DUpperHelp"),
					};
				case "R":
					return {
						label: t("oper.me.mode.RUpper"),
						description: t("oper.me.mode.RUpperHelp"),
					};
				case "q":
					return {label: t("oper.me.mode.q"), description: t("oper.me.mode.qHelp")};
				case "p":
					return {label: t("oper.me.mode.p"), description: t("oper.me.mode.pHelp")};
				case "I":
					return {
						label: t("oper.me.mode.IUpper"),
						description: t("oper.me.mode.IUpperHelp"),
					};
				case "W":
					return {
						label: t("oper.me.mode.WUpper"),
						description: t("oper.me.mode.WUpperHelp"),
					};
				case "H":
					return {
						label: t("oper.me.mode.HUpper"),
						description: t("oper.me.mode.HUpperHelp"),
					};
				case "X":
					return {
						label: t("oper.me.mode.XUpper"),
						description: t("oper.me.mode.XUpperHelp"),
					};
				case "i":
					return {label: t("oper.me.mode.i"), description: t("oper.me.mode.iHelp")};
				default:
					return {label: letter, description: ""};
			}
		};

		const modes = computed((): UserMode[] =>
			(nefarious.value ? NEFARIOUS_MODES : GENERIC_MODES).map((m) => ({
				...m,
				...modeText(m.letter),
			}))
		);

		/** What a privilege allows, on hover; an unknown one is its own name. */
		const privHelp = (p: string): string => {
			switch (p) {
				case "KILL":
					return t("oper.me.priv.KILL");
				case "LOCAL_KILL":
					return t("oper.me.priv.LOCAL_KILL");
				case "GLINE":
					return t("oper.me.priv.GLINE");
				case "LOCAL_GLINE":
					return t("oper.me.priv.LOCAL_GLINE");
				case "WIDE_GLINE":
					return t("oper.me.priv.WIDE_GLINE");
				case "SHUN":
					return t("oper.me.priv.SHUN");
				case "ZLINE":
					return t("oper.me.priv.ZLINE");
				case "CHECK":
					return t("oper.me.priv.CHECK");
				case "WHOX":
					return t("oper.me.priv.WHOX");
				case "SEE_CHAN":
					return t("oper.me.priv.SEE_CHAN");
				case "LIST_CHAN":
					return t("oper.me.priv.LIST_CHAN");
				case "REHASH":
					return t("oper.me.priv.REHASH");
				case "REMOTEREHASH":
					return t("oper.me.priv.REMOTEREHASH");
				case "OPMODE":
					return t("oper.me.priv.OPMODE");
				case "JUPE":
					return t("oper.me.priv.JUPE");
				case "SET":
					return t("oper.me.priv.SET");
				case "REMOVE":
					return t("oper.me.priv.REMOVE");
				case "TEMPSHUN":
					return t("oper.me.priv.TEMPSHUN");
				case "PROPAGATE":
					return t("oper.me.priv.PROPAGATE");
				case "DISPLAY":
					return t("oper.me.priv.DISPLAY");
				case "SEE_OPERS":
					return t("oper.me.priv.SEE_OPERS");
				default:
					return p;
			}
		};

		const privs = computed(() => [...(props.network.oper?.privs ?? [])].sort());

		const levelLabel = computed(() => {
			switch (props.network.oper?.level) {
				case "admin":
					return t("oper.me.level.admin");
				case "global":
					return t("oper.me.level.global");
				case "local":
					return t("oper.me.level.local");
				case "service":
					return t("oper.me.level.service");
				default:
					return t("oper.me.level.none");
			}
		});

		const has = (letter: string) => (props.network.oper?.umodes ?? "").includes(letter);
		const allowed = (m: UserMode) => !m.priv || hasPriv(props.network, m.priv);

		const set = (letter: string, on: boolean) => {
			socket.emit("input", {
				target: props.network.channels[0].id,
				text: `/umode ${on ? "+" : "-"}${letter}`,
			});
		};

		const refresh = () => socket.emit("oper:refresh", {network: props.network.uuid});

		return {
			t,
			modes,
			privs,
			levelLabel,
			profileName: computed(() => {
				void locale.value; // the generic profile's name is translated
				return profileName(profile.value);
			}),
			has,
			allowed,
			set,
			refresh,
			privHelp,
		};
	},
});
</script>
