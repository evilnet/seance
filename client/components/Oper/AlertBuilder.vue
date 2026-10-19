<template>
	<div
		id="oper-alert-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request ? 'oper-alert-builder' : null"
		@click.self="close"
	>
		<form
			v-if="request && network"
			class="settings-modal oper-alert-builder"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
			@submit.prevent="submit"
		>
			<div class="settings-modal-header">
				<h1>
					{{ title }}<span class="oper-modal-network"> · {{ network.name }}</span>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close the alert builder"
					@click="close"
				>
					✕
				</button>
			</div>

			<div class="settings-modal-body">
				<div class="container oper-alert-form">
					<p v-if="!canAsk" class="oper-alert-note oper-muted">
						No oper service is set up for this network (the network's edit form,
						Services support): the command can be copied, not sent.
					</p>

					<div class="oper-alert-grid">
						<div class="oper-alert-field">
							<label class="oper-alert-label" for="oper-alert-name">Name</label>
							<input
								id="oper-alert-name"
								ref="nameField"
								v-model="name"
								class="input oper-mono"
								type="text"
								spellcheck="false"
								autocomplete="off"
								pattern="[A-Za-z0-9\-]+"
								placeholder="letters, digits, dashes"
								:readonly="!!request.edit"
								required
							/>
						</div>
						<div class="oper-alert-field">
							<label class="oper-alert-label" for="oper-alert-reaction"
								>Reaction</label
							>
							<select id="oper-alert-reaction" v-model="reaction" class="input">
								<option
									v-for="r in REACTIONS"
									:key="r.id"
									:value="r.id"
									:disabled="tooLow(r)"
									:title="tooLow(r) ? `needs O3 level ${r.level}` : undefined"
								>
									{{ r.label }} · {{ r.id }} · level {{ r.level
									}}{{ r.needs ? ` · needs ${r.needs}` : "" }}
								</option>
							</select>
						</div>
						<div class="oper-alert-field">
							<label class="oper-alert-label" for="oper-alert-expires">Expires</label>
							<select id="oper-alert-expires" v-model="expires" class="input">
								<option v-for="e in EXPIRIES" :key="e.id" :value="e.id">
									{{ e.label }}{{ e.id === "never" ? "" : ` (${e.id})` }}
								</option>
							</select>
						</div>
					</div>

					<div class="oper-alert-section">
						<div class="oper-alert-section-title">Match users who…</div>
						<ul class="oper-alert-rows">
							<li
								v-for="row in rows"
								:key="row.id"
								:class="['oper-alert-row', {off: !row.on}]"
								:data-key="row.key"
							>
								<input
									v-model="row.on"
									v-switch
									class="oper-alert-switch"
									type="checkbox"
									role="switch"
									:aria-label="`Use ${labelOf(row.key)}`"
									:aria-checked="row.on"
								/>
								<span class="oper-alert-row-label" :title="row.key">
									{{ labelOf(row.key) }}
									<span
										v-if="wide(row)"
										class="oper-wide"
										:title="`Wide on its own: ${wide(row)}`"
										>wide</span
									>
								</span>
								<input
									v-if="row.key !== 'log'"
									v-model="row.value"
									class="input oper-mono oper-alert-value"
									type="text"
									spellcheck="false"
									autocomplete="off"
									:placeholder="placeholderOf(row.key)"
									:aria-label="`Value for ${labelOf(row.key)}`"
								/>
								<button
									type="button"
									class="oper-alert-remove"
									:aria-label="`Remove ${labelOf(row.key)}`"
									title="Remove"
									@click="remove(row)"
								>
									✕
								</button>
							</li>
						</ul>
						<p v-if="rows.length === 0" class="oper-muted oper-alert-note">
							No criteria yet: add one below.
						</p>
						<div class="oper-alert-add">
							<label class="oper-muted" for="oper-alert-add">+ add</label>
							<select
								id="oper-alert-add"
								v-model="addKey"
								class="input"
								@change="add"
							>
								<option value="">a criterion…</option>
								<option v-for="c in remaining" :key="c.key" :value="c.key">
									{{ c.label }} ({{ c.key }})
								</option>
							</select>
						</div>
					</div>

					<div class="oper-alert-field">
						<label class="oper-alert-label" for="oper-alert-reason">Reason</label>
						<input
							id="oper-alert-reason"
							v-model="reason"
							class="input"
							type="text"
							maxlength="250"
							placeholder="Shown with the alert; see <you>"
						/>
					</div>

					<div class="oper-alert-field">
						<span class="oper-alert-label">The command</span>
						<pre class="oper-alert-command"><code>{{ command }}</code></pre>
					</div>

					<p
						:class="['oper-alert-matches', {warn: matches.warn, muted: !matches.count}]"
						role="status"
						aria-live="polite"
						:data-state="matches.state"
					>
						<template v-if="matches.state === 'asking'">Counting the matches…</template>
						<template v-else-if="matches.state === 'idle'"
							>Switch on a criterion to count the matches.</template
						>
						<template v-else-if="matches.state === 'failed'">{{
							matches.note
						}}</template>
						<template v-else>{{ matches.text }}</template>
					</p>
					<p v-if="matches.nicks.length" class="oper-alert-nicks">
						{{ nicksText }}
					</p>
				</div>
			</div>

			<div class="settings-modal-footer oper-alert-footer">
				<div class="oper-alert-actions">
					<button
						type="submit"
						class="btn btn-small oper-alert-submit"
						:disabled="!canSubmit"
					>
						{{ busy ? "Sending…" : request.edit ? "Replace alert" : "Add alert" }}
					</button>
					<button type="button" class="btn btn-small" @click="copy">Copy command</button>
					<button type="button" class="btn btn-small btn-cancel" @click="close">
						Cancel
					</button>
				</div>
				<span v-if="result" class="oper-alert-result" role="status">{{ result }}</span>
				<span v-if="problem" class="oper-alert-error" role="alert">{{ problem }}</span>
				<span v-if="toast" class="oper-toast" role="status">{{ toast }}</span>
			</div>
		</form>
	</div>
</template>

<script lang="ts">
import {
	computed,
	defineComponent,
	nextTick,
	onMounted,
	onUnmounted,
	ref,
	shallowRef,
	watch,
} from "vue";
import eventbus from "../../js/eventbus";
import {useStore} from "../../js/store";
import {clientForNetwork} from "../../js/irc/manager";
import {
	addAlert,
	canAsk as canAskClient,
	describeFailure,
	operLevel,
	opersAmong,
	replaceAlert,
	tracePrint,
	type LookupResult,
} from "../../js/irc/alerts";
import type {CommandReply} from "../../js/irc/services/types";
import {
	type AlertBuilderRequest,
	buildCommand,
	buildCriteria,
	CRITERIA,
	criterionDef,
	type CriterionRow,
	DEFAULT_EXPIRY,
	defaultName,
	defaultReason,
	EXPIRIES,
	type ExpiryId,
	formFromAlert,
	isValidName,
	matchesText,
	newRow,
	type ReactionDef,
	REACTIONS,
	reactionTooLow,
	rowsFromFacts,
	wideReason,
} from "../../js/helpers/alertBuilder";

/** How long after the last edit the criteria are counted. */
const TRACE_DEBOUNCE_MS = 600;
/** How long a success stays up before the builder closes. */
const CLOSE_AFTER_MS = 1500;
const TOAST_MS = 2000;
/** How many matched nicks are listed before "+N more". */
const NICKS_SHOWN = 20;

interface Matches {
	state: "idle" | "asking" | "done" | "failed";
	count: number;
	text: string;
	warn: boolean;
	nicks: string[];
	note: string;
}

/**
 * The alert builder (docs/projects/oper-tools.md, "The alert builder"):
 * O3's `addalert` as a form in an overlay over the whole app, opened by
 * the `oper:alert-builder` eventbus event — from a card's "Alert on
 * this…" with its facts, empty from the Alerts tab, or on an existing
 * alert to replace it. The form logic is helpers/alertBuilder.ts, the wire
 * side irc/alerts.ts: the exact command is assembled live, a `trace print`
 * of the criteria runs 600 ms after the last edit and says who matches
 * right now (and which of them are opers, from one WHO), and nothing
 * reaches O3 until Add. Closed by ✕, Escape, the backdrop or Cancel.
 */
export default defineComponent({
	name: "AlertBuilder",
	setup() {
		const store = useStore();
		const request = shallowRef<AlertBuilderRequest | undefined>();
		const name = ref("");
		const reaction = ref("notice");
		const expires = ref<ExpiryId>(DEFAULT_EXPIRY);
		const rows = ref<CriterionRow[]>([]);
		const reason = ref("");
		const addKey = ref("");
		const level = ref<number | undefined>();
		const busy = ref(false);
		const result = ref("");
		const problem = ref("");
		const toast = ref("");
		const nameField = ref<HTMLInputElement | null>(null);
		const matches = ref<Matches>({
			state: "idle",
			count: 0,
			text: "",
			warn: false,
			nicks: [],
			note: "",
		});
		let traceTimer: ReturnType<typeof setTimeout> | undefined;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		let toastTimer: ReturnType<typeof setTimeout> | undefined;
		let traceGeneration = 0;
		let traceBusy = false;
		let traceDirty = false;

		const network = computed(() =>
			request.value ? store.getters.findNetwork(request.value.network) : undefined
		);
		const client = () => (request.value ? clientForNetwork(request.value.network) : undefined);
		const canAsk = computed(() => {
			void request.value;
			const c = client();
			return !!c && canAskClient(c);
		});
		const bot = computed(() => network.value?.services?.bots.oper || "O3");

		const title = computed(() =>
			request.value?.edit
				? `Replace alert ${request.value.edit.name}`
				: request.value?.channel
				? `Alert on ${request.value.channel}`
				: request.value?.nick
				? `Alert on ${request.value.nick}`
				: `New ${bot.value} alert`
		);

		const command = computed(() =>
			buildCommand({
				name: name.value,
				reaction: reaction.value,
				expires: expires.value,
				rows: rows.value,
				reason: reason.value,
			})
		);
		const criteria = computed(() => buildCriteria(rows.value));
		const remaining = computed(() =>
			CRITERIA.filter((c) => !rows.value.some((r) => r.key === c.key))
		);
		const canSubmit = computed(
			() =>
				!busy.value &&
				canAsk.value &&
				isValidName(name.value) &&
				criteria.value !== "" &&
				!!network.value?.status.connected
		);
		const nicksText = computed(() => {
			const list = matches.value.nicks;
			const shown = list.slice(0, NICKS_SHOWN).join(", ");
			return list.length > NICKS_SHOWN
				? `${shown} +${list.length - NICKS_SHOWN} more`
				: shown;
		});

		const labelOf = (key: string) => criterionDef(key)?.label ?? key;
		const placeholderOf = (key: string) => criterionDef(key)?.placeholder ?? "";
		const wide = (row: CriterionRow) => wideReason(row, rows.value);
		const tooLow = (r: ReactionDef) => reactionTooLow(r, level.value);

		const say = (text: string) => {
			toast.value = text;
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => (toast.value = ""), TOAST_MS);
		};

		// ---------------------------------------------------- the count line

		const setMatches = (m: Partial<Matches>) => {
			matches.value = {...matches.value, ...m};
		};

		const runTrace = async () => {
			const c = client();
			const text = criteria.value;

			if (!c || !text) {
				setMatches({state: "idle", count: 0, nicks: [], text: "", warn: false});
				return;
			}

			if (!canAskClient(c)) {
				setMatches({
					state: "failed",
					count: 0,
					nicks: [],
					note: "No oper service is set up for this network.",
				});
				return;
			}

			if (traceBusy) {
				traceDirty = true;
				return;
			}

			traceBusy = true;
			traceDirty = false;
			const generation = ++traceGeneration;
			setMatches({state: "asking"});

			try {
				const answer = await tracePrint(c, text);

				if (generation !== traceGeneration || !request.value) {
					return;
				}

				if (answer.kind !== "reply" || !answer.value) {
					setMatches({
						state: "failed",
						count: 0,
						nicks: [],
						note:
							answer.kind === "reply"
								? `${bot.value} did not answer.`
								: describeFailure(c, answer),
					});
					return;
				}

				if (answer.value.error) {
					setMatches({state: "failed", count: 0, nicks: [], note: answer.value.error});
					return;
				}

				const nicks = answer.value.users.map((u) => u.nick);
				const flagged = answer.value.users.filter((u) => u.flags?.includes("*"));
				const opers =
					flagged.length > 0 || nicks.length === 0
						? flagged.map((u) => u.nick)
						: await opersAmong(c, nicks);

				if (generation !== traceGeneration) {
					return;
				}

				const worded = matchesText(answer.value.count, opers);
				setMatches({state: "done", count: answer.value.count, nicks, ...worded});
			} finally {
				traceBusy = false;

				// Edited while it ran: count again, with what stands now.
				if (traceDirty && generation === traceGeneration) {
					void runTrace();
				}
			}
		};

		const scheduleTrace = () => {
			clearTimeout(traceTimer);
			traceTimer = setTimeout(() => {
				traceTimer = undefined;
				void runTrace();
			}, TRACE_DEBOUNCE_MS);
		};

		watch(criteria, () => {
			if (request.value) {
				scheduleTrace();
			}
		});

		// -------------------------------------------------------- the rows

		const remove = (row: CriterionRow) => {
			rows.value = rows.value.filter((r) => r !== row);
		};

		const add = () => {
			const key = addKey.value;

			if (key && !rows.value.some((r) => r.key === key)) {
				const value =
					key === "chantarget" || key === "channel" ? request.value?.channel ?? "" : "";
				rows.value = [...rows.value, newRow(key, value)];
			}

			addKey.value = "";
		};

		// A reaction that needs a criterion brings its row along.
		watch(reaction, (id) => {
			const needs = REACTIONS.find((r) => r.id === id)?.needs;

			if (needs && !rows.value.some((r) => r.key === needs)) {
				rows.value = [...rows.value, newRow(needs, request.value?.channel ?? "")];
			}
		});

		// ------------------------------------------------------ open, close

		const open = (req: AlertBuilderRequest) => {
			const c = clientForNetwork(req.network);
			const me = c?.nick ?? "";

			clearTimeout(closeTimer);
			request.value = req;
			result.value = "";
			problem.value = "";
			busy.value = false;
			level.value = undefined;
			traceGeneration++;
			traceBusy = false;
			traceDirty = false;
			setMatches({state: "idle", count: 0, text: "", warn: false, nicks: [], note: ""});

			if (req.edit) {
				const form = formFromAlert(req.edit);
				name.value = form.name;
				reaction.value = form.reaction;
				expires.value = form.expires;
				rows.value = form.rows;
				reason.value = form.reason;
			} else {
				name.value = defaultName(req);
				reaction.value = "notice";
				expires.value = DEFAULT_EXPIRY;
				rows.value = rowsFromFacts(req.facts ?? []);
				reason.value = defaultReason({channel: req.channel, me});
			}

			if (c) {
				void operLevel(c).then((found) => {
					if (request.value === req) {
						level.value = found;
					}
				});
			}

			scheduleTrace();
			void nextTick(() => nameField.value?.focus());
		};

		const close = () => {
			clearTimeout(traceTimer);
			clearTimeout(closeTimer);
			traceTimer = undefined;
			traceGeneration++;
			request.value = undefined;
		};

		// ---------------------------------------------------------- submit

		const verdictText = (r: LookupResult<CommandReply>, c: ReturnType<typeof client>) => {
			if (r.kind !== "reply") {
				return c ? describeFailure(c, r) : "";
			}

			return r.value?.text ?? `${bot.value} did not answer.`;
		};

		const submit = async () => {
			const c = client();
			const req = request.value;

			if (!c || !req || !canSubmit.value) {
				return;
			}

			busy.value = true;
			result.value = "";
			problem.value = "";

			try {
				if (req.edit) {
					const both = await replaceAlert(
						c,
						req.edit.name,
						command.value,
						buildCommand(formFromAlert(req.edit))
					);
					const deleted = verdictText(both.deleted, c);
					const added = both.added ? verdictText(both.added, c) : "";
					const ok = both.added?.kind === "reply" && !!both.added.value?.ok;
					const restored = !both.restored
						? ""
						: both.restored.kind === "reply" && both.restored.value?.ok
						? "The old alert was put back."
						: `The old alert could not be put back: ${verdictText(both.restored, c)}`;
					const text = [deleted, added, restored].filter(Boolean).join(" ");

					if (ok) {
						result.value = text;
					} else {
						problem.value = text;
					}

					if (ok || (both.deleted.kind === "reply" && both.deleted.value?.ok)) {
						eventbus.emit("oper:alerts-changed", {network: req.network});
					}

					if (ok) {
						closeTimer = setTimeout(close, CLOSE_AFTER_MS);
					}

					return;
				}

				const answer = await addAlert(c, command.value);
				const text = verdictText(answer, c);

				if (answer.kind === "reply" && answer.value?.ok) {
					result.value = text;
					eventbus.emit("oper:alerts-changed", {network: req.network});
					closeTimer = setTimeout(close, CLOSE_AFTER_MS);
				} else {
					problem.value = text;
				}
			} finally {
				busy.value = false;
			}
		};

		const copy = async () => {
			const text = command.value;

			try {
				await navigator.clipboard.writeText(text);
				say("Copied.");
			} catch {
				say("Couldn't copy; select the command instead.");
			}
		};

		const onEscape = (layer: string | null) => {
			if (layer === "oper-alert-builder") {
				close();
			}
		};

		onMounted(() => {
			eventbus.on("oper:alert-builder", open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("oper:alert-builder", open);
			eventbus.off("escapekey", onEscape);
			clearTimeout(traceTimer);
			clearTimeout(closeTimer);
			clearTimeout(toastTimer);
		});

		return {
			REACTIONS,
			EXPIRIES,
			request,
			network,
			title,
			canAsk,
			name,
			reaction,
			expires,
			rows,
			reason,
			addKey,
			remaining,
			command,
			matches,
			nicksText,
			busy,
			result,
			problem,
			toast,
			nameField,
			canSubmit,
			labelOf,
			placeholderOf,
			wide,
			tooLow,
			remove,
			add,
			submit,
			copy,
			close,
		};
	},
});
</script>
