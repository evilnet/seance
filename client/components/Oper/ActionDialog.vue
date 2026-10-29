<template>
	<div
		id="oper-action-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request ? 'oper-action' : null"
		@click.self="close"
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

					<label v-if="maskCheck.needsForce && !viaServices" class="oper-action-check">
						<input v-model="force" v-switch type="checkbox" :disabled="!canForce" />
						{{ t("oper.action.force") }}
						<span v-if="!canForce" class="oper-muted">{{
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
				<button type="button" class="btn btn-cancel" @click="close">
					{{ t("oper.action.cancel") }}
				</button>
				<button type="submit" class="btn btn-danger" :disabled="!canSubmit || busy">
					{{ busy ? t("oper.action.sending") : actionLabel }}
				</button>
			</div>
		</form>
	</div>
</template>

<style>
#oper-action-dialog {
	background: var(--body-bg-color);
	color: var(--body-color);
	margin: 0.75rem;
	border-radius: 5px;
	width: min(32rem, calc(100vw - 1.5rem));
	max-height: calc(100% - 1.5rem);
	overflow-y: auto;
	user-select: text;
}

#oper-action-dialog .oper-action-body {
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

#oper-action-dialog .oper-action-mask {
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
	color: #e74c3c;
	font-size: 0.875rem;
	margin: 0.25rem 0 0;
}

#oper-action-dialog .oper-action-result {
	color: var(--link-color);
	margin: 0.25rem 0 0;
}

#oper-action-dialog .oper-action-buttons {
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
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import {operRequest, servicesBan} from "../../js/helpers/operRequest";
import {hasPriv, type OperActionRequest, userIp} from "../../js/helpers/operMenu";
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
		const busy = ref(false);
		const problem = ref("");
		const result = ref("");
		const rawSuggestions = ref<{mask: string; label: string}[]>([]);
		const preview = ref<{count: number; text: string} | null>(null);
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		let previewFor = "";

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

		const canSubmit = computed(() => {
			if (!request.value || reason.value.trim() === "") {
				return false;
			}

			if (request.value.action === "kill") {
				return true;
			}

			const s = seconds.value;
			return (
				!maskCheck.value.error &&
				(!maskCheck.value.needsForce || force.value || viaServices.value) &&
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
			problem.value = "";
			result.value = "";
			rawSuggestions.value = [];
			preview.value = null;
			previewFor = "";
			busy.value = false;
			scope.value = scopes.value[0]?.value ?? "*";
		};

		/** USERIP (real IP, ident) and USERHOST (real host) for the nick. */
		const lookUp = async (nick: string) => {
			const n = network.value;

			if (!n) {
				return;
			}

			looking.value = true;
			const [{ident, ip}, hostReply] = await Promise.all([
				userIp(n.uuid, nick),
				operRequest(n.uuid, `USERHOST ${nick}`, {untagged: ["302"]}),
			]);
			looking.value = false;
			const item = hostReply.lines
				.find((msg) => msg.command === "302")
				?.params.at(-1)
				?.trim()
				.split(" ")[0];
			const host = item ? /@(.*)$/.exec(item)?.[1] : undefined;

			if (request.value?.nick !== nick) {
				return; // the dialog moved on
			}

			rawSuggestions.value = maskSuggestions(banType.value, {ident, ip, host});

			if (!mask.value && suggestions.value.length > 0) {
				mask.value = suggestions.value[0].mask;
			}
		};

		const open = (incoming: OperActionRequest) => {
			request.value = incoming;
			reset();

			if (incoming.action !== "kill" && incoming.nick) {
				void lookUp(incoming.nick);
			}

			void nextTick(() => firstField.value?.focus());
		};

		const close = () => {
			request.value = null;
			clearTimeout(previewTimer);
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
			preview.value = null;
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

			if (!r || !n || !canSubmit.value) {
				return;
			}

			busy.value = true;
			problem.value = "";

			if (r.action === "kill") {
				const reply = await operRequest(
					n.uuid,
					killLine(r.nick ?? "", reason.value.trim())
				);
				busy.value = false;
				const error = errorText(reply.lines, reply.outcome);

				if (error) {
					problem.value = error;
					return;
				}

				result.value = t("oper.action.killed", {nick: r.nick ?? ""});
				setTimeout(close, 900);
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
				busy.value = false;

				switch (reply.outcome) {
					case "ok":
						result.value = t("oper.action.setViaDone", {
							type: NAMES[type],
							bot,
							reply: reply.text ?? "",
						});
						setTimeout(close, 1500);
						return;
					case "refused":
						// O3's own words; the title already says who answered.
						problem.value = reply.text ?? t("oper.action.botRefused", {bot});
						return;
					case "closed":
						problem.value = t("oper.action.notSentDown");
						return;
					default:
						problem.value = t("oper.services.botSilent", {bot});
						return;
				}
			}

			const line = banLine({
				type,
				mask: mask.value,
				scope: scope.value,
				seconds: seconds.value ?? 0,
				reason: reason.value.trim(),
				force: maskCheck.value.needsForce && force.value,
			});
			const reply = await operRequest(n.uuid, line);
			const error = errorText(reply.lines, reply.outcome);

			if (error) {
				busy.value = false;
				problem.value = error;
				return;
			}

			// Silence means it worked; listing it back says so for certain.
			const query = `${type.toUpperCase()} ${normaliseMask(type, mask.value)}`;
			const check = await operRequest(n.uuid, query, {end: LIST_END[type]});
			busy.value = false;
			const found = check.lines.some(
				(msg) => msg.command === (type === "zline" ? "548" : "280")
			);
			result.value = found
				? t("oper.action.setFor", {
						type: NAMES[type],
						duration: formatDuration(seconds.value ?? 0),
				  })
				: t("oper.action.sentUnlisted", {type: NAMES[type]});
			setTimeout(close, found ? 1200 : 2500);
		};

		const onEscape = (layer: string | null) => {
			if (layer === "oper-action") {
				close();
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
		});

		return {
			t,
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
			close,
			submit,
		};
	},
});
</script>
