<template>
	<div
		id="oper-action-overlay"
		v-backdrop="dismiss"
		class="screen-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request ? 'oper-action' : null"
	>
		<form
			v-if="request && network"
			id="oper-action-dialog"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
			@submit.prevent="submit"
		>
			<div class="oper-action-body">
				<div class="oper-action-title">{{ title }}</div>

				<template v-if="request.action === 'kill'">
					<p v-if="who" class="oper-action-hint">
						{{ request.nick }} is <span class="oper-action-who">{{ who }}</span> right
						now.
					</p>
					<p v-else-if="looking" class="oper-action-hint">
						Looking up {{ request.nick }}…
					</p>
					<label class="oper-action-label" for="oper-action-reason">Reason</label>
					<input
						id="oper-action-reason"
						ref="firstField"
						v-model="reason"
						class="input"
						type="text"
						maxlength="250"
						placeholder="Shown to the user and on the network"
						required
					/>
				</template>

				<template v-else>
					<label class="oper-action-label" for="oper-action-mask">Mask</label>
					<input
						id="oper-action-mask"
						ref="firstField"
						v-model="mask"
						class="input oper-action-mask"
						type="text"
						spellcheck="false"
						autocomplete="off"
						:placeholder="
							banType === 'zline'
								? '203.0.113.7 or 203.0.113.0/24'
								: viaServices
								? 'user@host or *@ip (no CIDR)'
								: 'user@host, *@ip, $Rrealname'
						"
					/>
					<div v-if="suggestions.length" class="oper-action-suggestions">
						<button
							v-for="s in suggestions"
							:key="s.mask"
							type="button"
							:class="['oper-chip', {active: s.mask === mask}]"
							:title="s.label"
							@click="mask = s.mask"
						>
							{{ s.mask }}
						</button>
					</div>
					<p v-else-if="looking" class="oper-action-hint">
						Looking up {{ request.nick }}…
					</p>
					<p v-if="maskCheck.error" class="oper-action-error">{{ maskCheck.error }}</p>
					<p
						v-else-if="preview"
						:class="['oper-action-preview', {wide: preview.count >= 20}]"
					>
						{{ preview.text }}
					</p>

					<label v-if="mustConfirm" class="oper-action-check">
						<input
							v-model="force"
							v-switch
							type="checkbox"
							:disabled="forceFlag && !viaServices && !canForce"
						/>
						{{ confirmLabel }}
						<span v-if="forceFlag && !viaServices && !canForce" class="oper-muted"
							>(needs the WIDE_{{ banType.toUpperCase() }} privilege)</span
						>
					</label>

					<div class="oper-action-row">
						<div class="oper-action-field">
							<label class="oper-action-label" for="oper-action-duration"
								>Duration</label
							>
							<select
								id="oper-action-duration"
								v-model="durationChoice"
								class="input"
							>
								<option v-for="d in DURATIONS" :key="d.value" :value="d.value">
									{{ d.label }}
								</option>
								<option value="custom">Custom…</option>
							</select>
							<input
								v-if="durationChoice === 'custom'"
								v-model="customDuration"
								class="input"
								type="text"
								placeholder="e.g. 2d12h (7d at most)"
							/>
						</div>
						<div v-if="scopes.length > 1 && !viaServices" class="oper-action-field">
							<label class="oper-action-label" for="oper-action-scope"
								>Applies to</label
							>
							<select id="oper-action-scope" v-model="scope" class="input">
								<option v-for="s in scopes" :key="s.value" :value="s.value">
									{{ s.label }}
								</option>
							</select>
						</div>
					</div>

					<label class="oper-action-label" for="oper-action-reason">Reason</label>
					<input
						id="oper-action-reason"
						v-model="reason"
						class="input"
						type="text"
						maxlength="250"
						placeholder="Shown to the user"
						required
					/>
				</template>

				<p v-if="problem" class="oper-action-error">{{ problem }}</p>
				<p v-if="result" class="oper-action-result">{{ result }}</p>
			</div>
			<div class="oper-action-buttons">
				<button type="button" class="btn btn-cancel" :disabled="busy" @click="dismiss">
					Cancel
				</button>
				<button type="submit" class="btn btn-danger" :disabled="!canSubmit || busy">
					{{ busy ? "Sending…" : actionLabel }}
				</button>
			</div>
		</form>
	</div>
</template>

<style>
#oper-action-dialog {
	/* The window's colour pair, like the cards': --body-bg-color is the
	 * sidebar's, dark under day's dark-on-light text. */
	background: var(--window-bg-color);
	color: var(--body-color);
	margin: 0.75rem;
	border-radius: 5px;
	width: min(32rem, calc(100vw - 1.5rem));
	max-height: calc(100% - 1.5rem);

	/* The body scrolls, the buttons stay: with the keyboard up the dialog
	 * is a short band and Cancel / the submit must not scroll away. */
	display: flex;
	flex-direction: column;
	overflow: hidden;
	user-select: text;
}

#oper-action-dialog .oper-action-body {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 1rem;
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
}

#oper-action-dialog .oper-action-title {
	font-size: 1.25rem;
	font-weight: 700;
	margin-bottom: 0.5rem;
}

#oper-action-dialog .oper-action-label {
	color: var(--body-color-muted);
	font-size: 0.875rem;
	margin-top: 0.5rem;
}

#oper-action-dialog .input {
	margin: 0;
	width: 100%;
}

#oper-action-dialog .oper-action-mask,
#oper-action-dialog .oper-action-who {
	font-family: monospace;
}

#oper-action-dialog .oper-action-suggestions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.35rem;
}

#oper-action-dialog .oper-action-row {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
}

#oper-action-dialog .oper-action-field {
	flex: 1 1 10rem;
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
}

#oper-action-dialog .oper-action-check {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.4rem;
	margin-top: 0.4rem;
}

#oper-action-dialog .oper-action-hint,
#oper-action-dialog .oper-action-preview {
	color: var(--body-color-muted);
	font-size: 0.875rem;
	margin: 0;
}

#oper-action-dialog .oper-action-preview.wide {
	color: var(--link-color);
}

#oper-action-dialog .oper-action-error {
	color: var(--error-fg, color-mix(in oklab, #e74c3c 60%, var(--body-color)));
	font-size: 0.875rem;
	margin: 0.25rem 0 0;
}

#oper-action-dialog .oper-action-result {
	color: var(--link-color);
	margin: 0.25rem 0 0;
}

#oper-action-dialog .oper-action-buttons {
	flex-shrink: 0;
	display: flex;
	justify-content: flex-end;
	gap: 0.6rem;
	padding: 0.8rem 1rem;
	background: rgb(0 0 0 / 30%);
}

#oper-action-dialog .oper-action-buttons .btn {
	margin: 0;
}

#oper-action-dialog .btn-cancel {
	border-color: transparent;
}
</style>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import eventbus from "../../js/eventbus";
import {useStore} from "../../js/store";
import {operRequest, servicesBan} from "../../js/helpers/operRequest";
import {hasPriv, type OperActionRequest, userhostItem, userIp} from "../../js/helpers/operMenu";
import {
	BAN_MAX_SECONDS,
	banLine,
	type BanType,
	checkMask,
	formatDuration,
	killLine,
	maskSuggestions,
	normaliseMask,
	parseDuration,
} from "../../js/irc/profiles/nefarious/bans";
import {profileById} from "../../js/irc/profiles";
import {servicesProfileFor} from "../../js/irc/services/index";
import {hasVirtualKeyboard} from "../../js/helpers/device";
import {lineBudget, lineTooLongText} from "../../js/helpers/operLine";
import {errorOf} from "../../js/irc/profiles/report";
import type {IrcMessage} from "../../js/irc/message";

const DURATIONS = [
	{value: "3600", label: "1 hour"},
	{value: "21600", label: "6 hours"},
	{value: "86400", label: "1 day"},
	{value: "259200", label: "3 days"},
	{value: String(BAN_MAX_SECONDS), label: "7 days (the most)"},
];

/** The numerics a single-mask list query ends with: found, not found. */
const LIST_END: Record<BanType, string[]> = {
	gline: ["281", "521"],
	shun: ["545", "543"],
	zline: ["549", "547"],
};

const NAMES: Record<BanType, string> = {gline: "G-line", shun: "Shun", zline: "Z-line"};

/**
 * Kill a user, or G-line, shun or Z-line a mask, from a menu (helpers/
 * operMenu.ts): the mask suggested from what the oper can see (USERIP's real
 * IP, USERHOST's real host), checked against the server's width rules before
 * sending, the users it matches previewed with CHECK, and the result
 * confirmed by listing it back — nefarious2 answers a ban with silence.
 *
 * On a network whose services support names an oper service (X3's O3), a
 * G-line or shun goes through that bot instead (`services:ban`,
 * irc/services.ts): O3 takes no CIDR and no force, speaks its own
 * duration syntax, and answers in words, which are shown as they came.
 * KILL and Z-line stay on the server (X3 has no Z-line).
 */
export default defineComponent({
	name: "OperActionDialog",
	setup() {
		const store = useStore();
		const request = ref<OperActionRequest | null>(null);
		const firstField = ref<HTMLInputElement | null>(null);
		const mask = ref("");
		const reason = ref("");
		const durationChoice = ref("3600");
		const customDuration = ref("");
		const scope = ref("*");
		const force = ref(false);
		const looking = ref(false);
		/** `ident@host` of whoever holds the nick now (USERHOST), shown on a kill. */
		const who = ref("");
		const busy = ref(false);
		// What the server or the bot said went wrong; `problem` adds the
		// dialog's own reason not to send (a line over the byte cap).
		const sendProblem = ref("");
		const result = ref("");
		const rawSuggestions = ref<{mask: string; label: string}[]>([]);
		const preview = ref<{count: number; text: string} | null>(null);
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		let previewFor = "";
		// The close a moment after a success: cleared on open and close, so a
		// late one never closes the next dialog opened.
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		/** Bumped on every open and close: an answer to an earlier dialog's
		 * submit finds it changed and leaves this one alone. */
		let generation = 0;

		const network = computed(() =>
			request.value ? store.getters.findNetwork(request.value.network) : undefined
		);
		const banType = computed<BanType>(() =>
			request.value && request.value.action !== "kill" ? request.value.action : "gline"
		);
		/** The oper service a G-line or shun goes through, when the network has one. */
		const serviceBot = computed(() => {
			const services = network.value?.services;
			const r = request.value;

			if (!services || !r || r.action === "kill" || r.action === "zline") {
				return "";
			}

			return services.package === "x3" ? services.bots.oper.trim() : "";
		});
		const viaServices = computed(() => serviceBot.value !== "");
		const title = computed(() => {
			const r = request.value;

			if (!r) {
				return "";
			}

			const what = r.action === "kill" ? "Kill" : NAMES[r.action];
			const via = viaServices.value ? ` via ${serviceBot.value}` : "";
			return r.nick ? `${what} ${r.nick}${via}` : `${what}${via}`;
		});
		const actionLabel = computed(() =>
			request.value?.action === "kill"
				? "Kill"
				: `Set ${NAMES[banType.value]}${
						viaServices.value ? ` via ${serviceBot.value}` : ""
				  }`
		);
		// O3 rejects CIDR masks: only `*@ip`, `ident@ip` and `*@host` are offered there.
		const suggestions = computed(() =>
			viaServices.value
				? rawSuggestions.value.filter((s) => !/\/\d+$/.test(s.mask))
				: rawSuggestions.value
		);

		const maskCheck = computed(() => checkMask(banType.value, mask.value));
		const canForce = computed(
			() => !!network.value && hasPriv(network.value, `WIDE_${banType.value.toUpperCase()}`)
		);
		const seconds = computed(() =>
			durationChoice.value === "custom"
				? parseDuration(customDuration.value)
				: Number(durationChoice.value)
		);
		const scopes = computed(() => {
			const n = network.value;
			const type = banType.value.toUpperCase();
			const out: {value: string; label: string}[] = [];

			if (!n || hasPriv(n, type)) {
				out.push({value: "*", label: "The whole network"});
			}

			if (!n || hasPriv(n, `LOCAL_${type}`)) {
				out.push({value: "", label: "This server only"});
			}

			return out.length ? out : [{value: "*", label: "The whole network"}];
		});

		/** The server's force (`!`): a mask wide by its shape, or by the 20+ it matches now. */
		const forceFlag = computed(
			() => maskCheck.value.needsForce || (preview.value?.count ?? 0) >= 20
		);
		/** Realname, version and channel masks: no shape rule and no preview. */
		const unchecked = computed(() => /^(\$|[#&])/.test(mask.value.trim()));
		/**
		 * A wide ban is confirmed by hand, whichever way it goes: forced on
		 * the server, or through O3 (which has no force, so the switch is
		 * the only gate), or a mask nobody can preview.
		 */
		const mustConfirm = computed(
			() => request.value?.action !== "kill" && (forceFlag.value || unchecked.value)
		);
		const confirmLabel = computed(() =>
			unchecked.value && !forceFlag.value
				? "Yes, ban everyone this matches (it can't be previewed)"
				: viaServices.value
				? "Yes, set this wide mask"
				: "Force this wide mask"
		);

		/** The exact line Submit sends (without the label the IRC layer adds). */
		const outgoingLine = computed(() => {
			const r = request.value;

			if (!r) {
				return "";
			}

			const why = reason.value.trim();

			if (r.action === "kill") {
				return killLine(r.nick ?? "", why);
			}

			const type = banType.value;
			const profile = servicesProfileFor(network.value?.services);

			if (viaServices.value && type !== "zline" && profile) {
				return profile.banCommand(serviceBot.value, {
					type,
					mask: normaliseMask(type, mask.value),
					seconds: seconds.value ?? 0,
					reason: why,
				});
			}

			return banLine({
				type,
				mask: mask.value,
				scope: scope.value,
				seconds: seconds.value ?? 0,
				reason: why,
				force: forceFlag.value && force.value,
			});
		});
		const budget = computed(() => lineBudget(outgoingLine.value));
		const problem = computed(() => sendProblem.value || lineTooLongText(budget.value));

		const canSubmit = computed(() => {
			// A result in means it was sent: a second press would send it again.
			if (!request.value || reason.value.trim() === "" || result.value) {
				return false;
			}

			if (budget.value.over > 0) {
				return false;
			}

			if (request.value.action === "kill") {
				return true;
			}

			const s = seconds.value;
			return (
				!maskCheck.value.error &&
				(!mustConfirm.value || force.value) &&
				s !== undefined &&
				s > 0 &&
				s <= BAN_MAX_SECONDS
			);
		});

		const reset = () => {
			mask.value = request.value?.mask ?? "";
			reason.value = "";
			durationChoice.value = "3600";
			customDuration.value = "";
			force.value = false;
			who.value = "";
			sendProblem.value = "";
			result.value = "";
			rawSuggestions.value = [];
			preview.value = null;
			previewFor = "";
			busy.value = false;
			looking.value = false;
			scope.value = scopes.value[0]?.value ?? "*";
		};

		/** USERIP (real IP, ident) and USERHOST (real host) for the nick. */
		const lookUp = async (nick: string) => {
			const n = network.value;

			if (!n) {
				return;
			}

			// This dialog's answer only: one closed since (or reopened for
			// the same nick on another network) has moved the generation on.
			const asked = generation;
			looking.value = true;
			const [{ident, ip}, hostReply] = await Promise.all([
				userIp(n.uuid, nick),
				operRequest(n.uuid, `USERHOST ${nick}`, {untagged: ["302"]}),
			]);

			if (asked !== generation) {
				return; // the dialog moved on
			}

			looking.value = false;
			const held = userhostItem(hostReply.lines, "302", nick);
			const host = held?.host;
			who.value = held ? `${held.user}@${held.host}` : "";

			if (request.value?.action === "kill") {
				return;
			}

			rawSuggestions.value = maskSuggestions(banType.value, {ident, ip, host});

			if (!mask.value && suggestions.value.length > 0) {
				mask.value = suggestions.value[0].mask;
			}
		};

		// What was typed survives a dismiss (Cancel, the backdrop, Escape,
		// Android's Back) and comes back when the same dialog opens again;
		// a success forgets it. One draft at a time, as the note's.
		let draft:
			| {
					key: string;
					mask: string;
					reason: string;
					durationChoice: string;
					customDuration: string;
					scope: string;
			  }
			| undefined;
		const keyOf = (r: OperActionRequest) =>
			`${r.network} ${r.action} ${r.nick ?? ""} ${r.mask ?? ""}`;

		const restoreDraft = (r: OperActionRequest) => {
			if (draft?.key !== keyOf(r)) {
				draft = undefined;
				return;
			}

			mask.value = draft.mask;
			reason.value = draft.reason;
			durationChoice.value = draft.durationChoice;
			customDuration.value = draft.customDuration;
			scope.value = draft.scope;
		};

		const open = (incoming: OperActionRequest) => {
			clearTimeout(closeTimer);
			generation++;
			request.value = incoming;
			reset();

			restoreDraft(incoming);

			// A kill too: the dialog says who holds the nick now, so a nick
			// clicked in an old line is not taken for whoever has it today.
			if (incoming.nick) {
				void lookUp(incoming.nick);
			}

			// Not on a touch phone: the keyboard would come up over the buttons.
			if (!hasVirtualKeyboard()) {
				void nextTick(() => firstField.value?.focus());
			}
		};

		const close = () => {
			generation++;
			request.value = null;
			clearTimeout(previewTimer);
			clearTimeout(closeTimer);
			previewFor = "";
		};

		/** Cancel, the backdrop, Escape: not while a line is out (it cannot be called back). */
		const dismiss = () => {
			if (busy.value) {
				return;
			}

			const r = request.value;

			if (r && !result.value) {
				draft = {
					key: keyOf(r),
					mask: mask.value,
					reason: reason.value,
					durationChoice: durationChoice.value,
					customDuration: customDuration.value,
					scope: scope.value,
				};
			}

			close();
		};

		const closeSoon = (ms: number) => {
			clearTimeout(closeTimer);
			closeTimer = setTimeout(close, ms);
		};

		/** Who the mask matches now, from a CHECK host search (no CHECK: no preview). */
		const runPreview = async () => {
			const n = network.value;
			const value = normaliseMask(banType.value, mask.value);

			if (!n || maskCheck.value.error || value.startsWith("$") || /^[#&]/.test(value)) {
				preview.value = null;
				return;
			}

			if (!hasPriv(n, "CHECK")) {
				preview.value = null;
				return;
			}

			previewFor = value;
			const target = banType.value === "zline" ? `*@${value}` : value;
			const reply = await operRequest(n.uuid, `CHECK ${target}`, {end: ["291", "292"]});

			if (previewFor !== value) {
				return;
			}

			if (reply.lines.some((msg) => msg.command === "292")) {
				preview.value = {count: 0, text: "Matches nobody connected right now."};
				return;
			}

			const report = profileById(n.oper?.profile).checkReport(reply.lines, `CHECK ${target}`);
			const rows = report?.sections.find((s) => s.table)?.table?.rows ?? [];
			const nicks = rows
				.map((row) => (row.nick && "v" in row.nick ? String(row.nick.v) : ""))
				.filter(Boolean);
			const shown = nicks.slice(0, 8).join(", ");
			const more = nicks.length > 8 ? ` and ${nicks.length - 8} more` : "";
			const wide =
				nicks.length >= 20 ? " — the server refuses 20 or more without force." : "";
			preview.value = report?.error
				? null
				: {
						count: nicks.length,
						text:
							nicks.length === 1
								? `Matches 1 user: ${shown}.`
								: `Matches ${nicks.length} users: ${shown}${more}.${wide}`,
				  };
		};

		watch([mask, banType], () => {
			// A CHECK still out for the old mask must not land on the new one.
			preview.value = null;
			previewFor = "";
			clearTimeout(previewTimer);

			if (request.value && request.value.action !== "kill" && mask.value.trim()) {
				previewTimer = setTimeout(() => void runPreview(), 500);
			}
		});

		const errorText = (lines: IrcMessage[], outcome: string): string | undefined => {
			const error = errorOf(lines);

			if (error) {
				return error;
			}

			if (outcome === "timeout") {
				return "The server did not answer.";
			}

			if (outcome === "closed") {
				return "Not sent: the connection is down.";
			}

			return undefined;
		};

		const submit = async () => {
			const r = request.value;
			const n = network.value;

			if (!r || !n || !canSubmit.value || busy.value) {
				return;
			}

			busy.value = true;
			sendProblem.value = "";
			const asked = generation;

			if (r.action === "kill") {
				const reply = await operRequest(n.uuid, outgoingLine.value);

				if (asked !== generation) {
					return;
				}

				busy.value = false;
				const error = errorText(reply.lines, reply.outcome);

				if (error) {
					sendProblem.value = error;
					return;
				}

				result.value = `Killed ${r.nick}.`;
				draft = undefined;
				eventbus.emit("oper:acted", {network: r.network, nick: r.nick});
				closeSoon(900);
				return;
			}

			const type = banType.value;

			if (viaServices.value && type !== "zline") {
				const bot = serviceBot.value;
				const reply = await servicesBan(n.uuid, {
					type,
					mask: normaliseMask(type, mask.value),
					seconds: seconds.value ?? 0,
					reason: reason.value.trim(),
				});

				if (asked !== generation) {
					return;
				}

				busy.value = false;

				switch (reply.outcome) {
					case "ok":
						result.value = `${NAMES[type]} set via ${bot}: ${reply.text ?? ""}`;
						draft = undefined;
						eventbus.emit("oper:acted", {network: r.network, nick: r.nick});
						closeSoon(1500);
						return;
					case "refused":
						// O3's own words; the title already says who answered.
						sendProblem.value = reply.text ?? `${bot} refused it.`;
						return;
					case "closed":
						sendProblem.value = "Not sent: the connection is down.";
						return;
					default:
						sendProblem.value = `${bot} did not answer.`;
						return;
				}
			}

			const reply = await operRequest(n.uuid, outgoingLine.value);

			if (asked !== generation) {
				return;
			}

			const error = errorText(reply.lines, reply.outcome);

			if (error) {
				busy.value = false;
				sendProblem.value = error;
				return;
			}

			// Silence means it worked; listing it back says so for certain.
			const query = `${type.toUpperCase()} ${normaliseMask(type, mask.value)}`;
			const check = await operRequest(n.uuid, query, {end: LIST_END[type]});

			if (asked !== generation) {
				return;
			}

			busy.value = false;
			draft = undefined;
			eventbus.emit("oper:acted", {network: r.network, nick: r.nick});
			const found = check.lines.some(
				(msg) => msg.command === (type === "zline" ? "548" : "280")
			);
			result.value = found
				? `${NAMES[type]} set for ${formatDuration(seconds.value ?? 0)}.`
				: `${NAMES[type]} sent; the server does not list it yet.`;
			closeSoon(found ? 1200 : 2500);
		};

		const onEscape = (layer: string | null) => {
			if (layer === "oper-action") {
				dismiss();
			}
		};

		onMounted(() => {
			eventbus.on("oper:action", open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("oper:action", open);
			eventbus.off("escapekey", onEscape);
			clearTimeout(previewTimer);
			clearTimeout(closeTimer);
		});

		return {
			DURATIONS,
			request,
			network,
			firstField,
			mask,
			reason,
			durationChoice,
			customDuration,
			scope,
			scopes,
			force,
			canForce,
			looking,
			busy,
			problem,
			result,
			suggestions,
			preview,
			banType,
			viaServices,
			title,
			actionLabel,
			maskCheck,
			canSubmit,
			who,
			forceFlag,
			mustConfirm,
			confirmLabel,
			close,
			dismiss,
			submit,
		};
	},
});
</script>
