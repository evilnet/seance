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
				Privileges · {{ network.oper?.privsKnown ? privs.length : "?" }}
				<button type="button" class="btn btn-small oper-refresh" @click.prevent="refresh">
					Refresh
				</button>
			</summary>
			<p v-if="!network.oper?.privsKnown" class="oper-muted">Not reported yet.</p>
			<p v-else-if="!privs.length" class="oper-muted">None.</p>
			<p v-else class="oper-chips oper-privs">
				<span v-for="p in privs" :key="p" class="oper-chip-static" :title="privHelp(p)">{{
					p
				}}</span>
			</p>
		</details>

		<h2>User modes</h2>
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
						<span v-if="!allowed(m)" class="oper-umode-needs">needs {{ m.priv }}</span>
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
import {profileById} from "../../js/irc/profiles";

interface UserMode {
	letter: string;
	label: string;
	description: string;
	/** The privilege nefarious2 wants before it lets you set it. */
	priv?: string;
}

/** nefarious2's user modes an oper may want to flip (docs/resources/nefarious2-oper.md §3). */
const NEFARIOUS_MODES: UserMode[] = [
	{
		letter: "s",
		label: "Server notices",
		description: "Receive the server notices your mask selects.",
	},
	{letter: "w", label: "WALLOPS", description: "Receive WALLOPS and WALLUSERS."},
	{
		letter: "g",
		label: "Desync reports",
		description: "Receive DESYNCH reports (protocol violations).",
	},
	{letter: "d", label: "Deaf", description: "Receive no channel messages."},
	{letter: "D", label: "No private messages", description: "Refuse every private message."},
	{
		letter: "R",
		label: "Logged-in senders only",
		description: "Private messages only from users logged in to an account.",
	},
	{
		letter: "q",
		label: "Common channels only",
		description: "Private messages and invites only from users you share a channel with.",
	},
	{letter: "p", label: "Hide channels", description: "Your channels are not listed in WHOIS."},
	{
		letter: "I",
		label: "Hide idle time",
		description: "Your idle time is not shown in WHOIS.",
		priv: "HIDE_IDLE",
	},
	{
		letter: "W",
		label: "WHOIS notices",
		description: "Be told when someone does a /whois on you.",
		priv: "WHOIS_NOTICE",
	},
	{
		letter: "H",
		label: "Hide oper status",
		description: "Not shown as an oper in WHOIS, WHO or message tags.",
		priv: "HIDE_OPER",
	},
	{
		letter: "X",
		label: "Extra oper powers",
		description: "Kick and deop network services, join through modes.",
		priv: "XTRAOP",
	},
];

const GENERIC_MODES: UserMode[] = [
	{letter: "s", label: "Server notices", description: "Receive server notices."},
	{letter: "w", label: "WALLOPS", description: "Receive WALLOPS."},
	{
		letter: "i",
		label: "Invisible",
		description: "Not shown to users who share no channel with you.",
	},
];

const PRIV_HELP: Record<string, string> = {
	KILL: "KILL any user",
	LOCAL_KILL: "KILL users on this server",
	GLINE: "Set network-wide G-lines",
	LOCAL_GLINE: "Set G-lines on this server",
	WIDE_GLINE: "Force wide G-line masks",
	SHUN: "Set network-wide shuns",
	ZLINE: "Set network-wide Z-lines",
	CHECK: "Use /check",
	WHOX: "Use WHO's x flag (see invisible users)",
	SEE_CHAN: "See secret channels",
	LIST_CHAN: "List secret channels",
	REHASH: "Rehash this server",
	REMOTEREHASH: "Rehash other servers",
	OPMODE: "Set channel modes with OPMODE",
	JUPE: "Jupe servers",
	SET: "Change server features",
	REMOVE: "Force-remove bans",
	TEMPSHUN: "Temporarily shun a user",
	PROPAGATE: "Global oper",
	DISPLAY: "Shown as an oper",
	SEE_OPERS: "See hidden opers",
};

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
		const modes = computed(() =>
			profile.value.id === "nefarious2" ? NEFARIOUS_MODES : GENERIC_MODES
		);
		const privs = computed(() => [...(props.network.oper?.privs ?? [])].sort());

		const levelLabel = computed(() => {
			switch (props.network.oper?.level) {
				case "admin":
					return "Administrator";
				case "global":
					return "Global operator";
				case "local":
					return "Local operator (this server)";
				case "service":
					return "Network service";
				default:
					return "Not an operator";
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
			modes,
			privs,
			levelLabel,
			profileName: computed(() => profile.value.name),
			has,
			allowed,
			set,
			refresh,
			privHelp: (p: string) => PRIV_HELP[p] ?? p,
		};
	},
});
</script>
