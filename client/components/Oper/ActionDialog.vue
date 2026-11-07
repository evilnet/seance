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
						<I18nFrame :text="t('oper.action.whoNow', {nick: KEEP, who: KEEP})">
							<template #nick
								><bdi>{{ request.nick }}</bdi></template
							>
							<template #who
								><span class="oper-action-who">{{ who }}</span></template
							>
						</I18nFrame>
					</p>
					<p v-else-if="looking" class="oper-action-hint">
						{{ t("oper.action.lookingUp", {nick: request.nick ?? ""}) }}
					</p>
					<label class="oper-action-label" for="oper-action-reason">{{
						t("oper.action.reason")
					}}</label>
					<input
						id="oper-action-reason"
						ref="firstField"
						v-model="reason"
						class="input"
						type="text"
						maxlength="250"
						:placeholder="t('oper.action.killReasonPlaceholder')"
						required
					/>
				</template>

				<template v-else>
					<label class="oper-action-label" for="oper-action-mask">{{
						t("oper.action.mask")
					}}</label>
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
								? t('oper.action.maskPlaceholderZline')
								: viaServices
								? t('oper.action.maskPlaceholderServices')
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
						{{ t("oper.action.lookingUp", {nick: request.nick ?? ""}) }}
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
						<span v-if="forceFlag && !viaServices && !canForce" class="oper-muted">{{
							t("oper.action.forceNeeds", {priv: `WIDE_${banType.toUpperCase()}`})
						}}</span>
					</label>

					<div class="oper-action-row">
						<div class="oper-action-field">
							<label class="oper-action-label" for="oper-action-duration">{{
								t("oper.action.duration")
							}}</label>
							<select
								id="oper-action-duration"
								v-model="durationChoice"
								class="input"
							>
								<option v-for="d in durations" :key="d.value" :value="d.value">
									{{ d.label }}
								</option>
								<option value="custom">
									{{ t("oper.action.durationCustom") }}
								</option>
							</select>
							<input
								v-if="durationChoice === 'custom'"
								v-model="customDuration"
								class="input"
								type="text"
								:placeholder="t('oper.action.durationPlaceholder')"
							/>
						</div>
						<div v-if="scopes.length > 1 && !viaServices" class="oper-action-field">
							<label class="oper-action-label" for="oper-action-scope">{{
								t("oper.action.scope")
							}}</label>
							<select id="oper-action-scope" v-model="scope" class="input">
								<option v-for="s in scopes" :key="s.value" :value="s.value">
									{{ s.label }}
								</option>
							</select>
						</div>
					</div>

					<label class="oper-action-label" for="oper-action-reason">{{
						t("oper.action.reason")
					}}</label>
					<input
						id="oper-action-reason"
						v-model="reason"
						class="input"
						type="text"
						maxlength="250"
						:placeholder="t('oper.action.banReasonPlaceholder')"
						required
					/>
				</template>

				<p v-if="problem" class="oper-action-error">{{ problem }}</p>
				<p v-if="result" class="oper-action-result">{{ result }}</p>
			</div>
			<div class="oper-action-buttons">
				<button
					type="button"
					class="oper-btn oper-btn-ghost oper-cancel"
					:disabled="busy"
					@click="dismiss"
				>
					{{ t("oper.action.cancel") }}
				</button>
				<button
					type="submit"
					class="oper-btn oper-btn-danger solid"
					:disabled="!canSubmit || busy"
				>
					{{ busy ? t("oper.action.sending") : actionLabel }}
				</button>
			</div>
		</form>
	</div>
</template>

<style>
:is(#oper-action-dialog, #ban-dialog) {
	/* The window's colour pair, like the cards': --body-bg-color is the
	 * sidebar's, dark under day's dark-on-light text. */
	background: var(--window-bg-color);
	color: var(--body-color);
	margin: 0.75rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 0.75rem;
	box-shadow: 0 1.5rem 3rem -1rem rgb(0 0 0 / 50%);
	width: min(32rem, calc(100vw - 1.5rem));
	max-height: calc(100% - 1.5rem);

	/* The body scrolls, the buttons stay: with the keyboard up the dialog
	 * is a short band and Cancel / the submit must not scroll away. */
	display: flex;
	flex-direction: column;
	overflow: hidden;
	user-select: text;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-body {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 1.25rem 1.5rem 1.5rem;
	display: flex;
	flex-direction: column;
	gap: 0.45rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-title {
	font-size: 1.125rem;
	font-weight: 600;
	margin-bottom: 0.5rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-label {
	color: var(--body-color-muted);
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	margin-top: 0.75rem;
}

:is(#oper-action-dialog, #ban-dialog) .input {
	margin: 0;
	width: 100%;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-mask,
:is(#oper-action-dialog, #ban-dialog) .oper-action-who {
	font-family: monospace;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-suggestions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.35rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-row {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-field {
	flex: 1 1 10rem;
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-check {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.4rem;
	margin-top: 0.4rem;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-hint,
:is(#oper-action-dialog, #ban-dialog) .oper-action-preview {
	color: var(--body-color-muted);
	font-size: 0.875rem;
	margin: 0;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-preview.wide {
	color: var(--oper-amber);
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-error {
	color: var(--oper-red);
	font-size: 0.875rem;
	margin: 0.25rem 0 0;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-result {
	color: var(--body-color);
	margin: 0.25rem 0 0;
}

:is(#oper-action-dialog, #ban-dialog) .oper-action-buttons {
	flex-shrink: 0;
	display: flex;
	justify-content: flex-end;
	gap: 0.5rem;
	padding: 0.9rem 1.5rem;
	background: var(--oper-sunk);
	box-shadow: inset 0 1px 0 var(--oper-line);
}
</style>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import eventbus from "../../js/eventbus";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";
import {useStore} from "../../js/store";
import {operRequest, servicesBan} from "../../js/helpers/operRequest";
import {clientForNetwork} from "../../js/irc/manager";
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
	components: {I18nFrame},
	setup() {
		const store = useStore();
		const {t, tCount} = useI18n();
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

			if (r.action === "kill") {
				return r.nick ? t("oper.action.titleKill", {nick: r.nick}) : t("oper.action.kill");
			}

			const vars = {type: NAMES[r.action], nick: r.nick ?? "", bot: serviceBot.value};

			if (viaServices.value) {
				return r.nick
					? t("oper.action.titleBanVia", vars)
					: t("oper.action.titleBanViaNoNick", vars);
			}

			return r.nick ? t("oper.action.titleBan", vars) : NAMES[r.action];
		});
		const actionLabel = computed(() => {
			if (request.value?.action === "kill") {
				return t("oper.action.kill");
			}

			const vars = {type: NAMES[banType.value], bot: serviceBot.value};
			return viaServices.value ? t("oper.action.setVia", vars) : t("oper.action.set", vars);
		});
		const durations = computed(() => [
			{value: "3600", label: t("oper.action.duration1h")},
			{value: "21600", label: t("oper.action.duration6h")},
			{value: "86400", label: t("oper.action.duration1d")},
			{value: "259200", label: t("oper.action.duration3d")},
			{value: String(BAN_MAX_SECONDS), label: t("oper.action.duration7d")},
		]);
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
				out.push({value: "*", label: t("oper.action.scopeNetwork")});
			}

			if (!n || hasPriv(n, `LOCAL_${type}`)) {
				out.push({value: "", label: t("oper.action.scopeServer")});
			}

			return out.length ? out : [{value: "*", label: t("oper.action.scopeNetwork")}];
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
				? t("oper.action.confirmUnchecked")
				: viaServices.value
				? t("oper.action.confirmWideVia")
				: t("oper.action.force")
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

			// The network's casemapping: `[bob]` is `{bob}` on rfc1459.
			const client = clientForNetwork(n.uuid);
			const same = client ? (x: string, y: string) => client.namesEqual(x, y) : undefined;
			// This dialog's answer only: one closed since (or reopened for
			// the same nick on another network) has moved the generation on.
			const asked = generation;
			looking.value = true;
			const [{ident, ip}, hostReply] = await Promise.all([
				userIp(n.uuid, nick, same),
				operRequest(n.uuid, `USERHOST ${nick}`, {untagged: ["302"]}),
			]);

			if (asked !== generation) {
				return; // the dialog moved on
			}

			looking.value = false;
			const held = userhostItem(hostReply.lines, "302", nick, same);
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
		// By target, the most recent few: Alice's typed reason survives
		// opening Bob's dialog in between.
		const drafts = new Map<
			string,
			{
				mask: string;
				reason: string;
				durationChoice: string;
				customDuration: string;
				scope: string;
			}
		>();
		const MAX_DRAFTS = 8;
		const keyOf = (r: OperActionRequest) =>
			`${r.network} ${r.action} ${r.nick ?? ""} ${r.mask ?? ""}`;

		const restoreDraft = (r: OperActionRequest) => {
			const draft = drafts.get(keyOf(r));

			if (!draft) {
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
				drafts.delete(keyOf(r)); // re-inserted last: the newest
				drafts.set(keyOf(r), {
					mask: mask.value,
					reason: reason.value,
					durationChoice: durationChoice.value,
					customDuration: customDuration.value,
					scope: scope.value,
				});

				if (drafts.size > MAX_DRAFTS) {
					drafts.delete(drafts.keys().next().value as string);
				}
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
				preview.value = {count: 0, text: t("oper.action.previewNobody")};
				return;
			}

			const report = profileById(n.oper?.profile).checkReport(reply.lines, `CHECK ${target}`);
			const rows = report?.sections.find((s) => s.table)?.table?.rows ?? [];
			const nicks = rows
				.map((row) => (row.nick && "v" in row.nick ? String(row.nick.v) : ""))
				.filter(Boolean);
			const shown = nicks.slice(0, 8).join(t("oper.list.separator"));
			const vars = {nicks: shown, more: nicks.length - 8};
			preview.value = report?.error
				? null
				: {
						count: nicks.length,
						text:
							nicks.length === 1
								? t("oper.action.previewOne", {nicks: shown})
								: nicks.length >= 20
								? tCount("oper.action.previewWide", nicks.length, vars)
								: nicks.length > 8
								? tCount("oper.action.previewMore", nicks.length, vars)
								: tCount("oper.action.previewMany", nicks.length, vars),
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
				return t("oper.action.serverSilent");
			}

			if (outcome === "closed") {
				return t("oper.action.notSentDown");
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

				result.value = t("oper.action.killed", {nick: r.nick ?? ""});
				drafts.delete(keyOf(r));
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
						result.value = t("oper.action.setViaDone", {
							type: NAMES[type],
							bot,
							reply: reply.text ?? "",
						});
						drafts.delete(keyOf(r));
						eventbus.emit("oper:acted", {network: r.network, nick: r.nick});
						closeSoon(1500);
						return;
					case "refused":
						// O3's own words; the title already says who answered.
						sendProblem.value = reply.text ?? t("oper.action.botRefused", {bot});
						return;
					case "closed":
						sendProblem.value = t("oper.action.notSentDown");
						return;
					default:
						sendProblem.value = t("oper.services.botSilent", {bot});
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
			drafts.delete(keyOf(r));
			eventbus.emit("oper:acted", {network: r.network, nick: r.nick});
			const found = check.lines.some(
				(msg) => msg.command === (type === "zline" ? "548" : "280")
			);
			result.value = found
				? t("oper.action.setFor", {
						type: NAMES[type],
						duration: formatDuration(seconds.value ?? 0),
				  })
				: t("oper.action.sentUnlisted", {type: NAMES[type]});
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
			t,
			KEEP,
			durations,
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
