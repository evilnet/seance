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

					<label v-if="maskCheck.needsForce" class="oper-action-check">
						<input v-model="force" type="checkbox" :disabled="!canForce" />
						Force this wide mask
						<span v-if="!canForce" class="oper-muted"
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
						<div v-if="scopes.length > 1" class="oper-action-field">
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
				<button type="button" class="btn btn-cancel" @click="close">Cancel</button>
				<button type="submit" class="btn btn-danger" :disabled="!canSubmit || busy">
					{{ busy ? "Sending…" : actionLabel }}
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
import {useStore} from "../../js/store";
import {operRequest} from "../../js/helpers/operRequest";
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
		const busy = ref(false);
		const problem = ref("");
		const result = ref("");
		const suggestions = ref<{mask: string; label: string}[]>([]);
		const preview = ref<{count: number; text: string} | null>(null);
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		let previewFor = "";

		const network = computed(() =>
			request.value ? store.getters.findNetwork(request.value.network) : undefined
		);
		const banType = computed<BanType>(() =>
			request.value && request.value.action !== "kill" ? request.value.action : "gline"
		);
		const title = computed(() => {
			const r = request.value;

			if (!r) {
				return "";
			}

			const what = r.action === "kill" ? "Kill" : NAMES[r.action];
			return r.nick ? `${what} ${r.nick}` : what;
		});
		const actionLabel = computed(() =>
			request.value?.action === "kill" ? "Kill" : `Set ${NAMES[banType.value]}`
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
				(!maskCheck.value.needsForce || force.value) &&
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
			suggestions.value = [];
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

			suggestions.value = maskSuggestions(banType.value, {ident, ip, host});

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

				result.value = `Killed ${r.nick}.`;
				setTimeout(close, 900);
				return;
			}

			const type = banType.value;
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
				? `${NAMES[type]} set for ${formatDuration(seconds.value ?? 0)}.`
				: `${NAMES[type]} sent; the server does not list it yet.`;
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
