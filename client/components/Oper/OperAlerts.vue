<template>
	<div class="oper-alerts">
		<section v-for="section in SECTIONS" :key="section.id" class="oper-alerts-section">
			<h2>{{ section.label }}</h2>
			<ul class="oper-lines">
				<li
					v-for="line in linesIn(section.id)"
					:key="line.id"
					class="oper-line"
					:data-line="line.id"
				>
					<div class="oper-line-text">
						<span class="oper-line-label">{{ line.label }}</span>
						<span v-if="line.hint" class="oper-line-hint">{{ line.hint }}</span>
					</div>
					<div class="oper-line-ctl">
						<span v-if="tmpOf(line)" class="oper-line-tmp">{{ tmpOf(line) }}</span>
						<div
							class="oper-seg oper-route-seg"
							role="radiogroup"
							:aria-label="`Where ${line.label.toLowerCase()} show`"
						>
							<button
								v-for="pos in POSITIONS"
								:key="pos.route"
								type="button"
								role="radio"
								:aria-checked="routeOf(line) === pos.route"
								:class="{tmp: pos.route === routeOf(line) && !!tmpOf(line)}"
								:title="pos.title"
								@click="choose($event, line, pos.route)"
							>
								{{ pos.label }}
							</button>
						</div>
					</div>
				</li>
			</ul>
		</section>

		<details v-if="rest.length" class="oper-fold">
			<summary>
				Everything else · {{ rest.length }} {{ rest.length === 1 ? "kind" : "kinds" }}
			</summary>
			<ul class="oper-lines oper-lines-rest">
				<li v-for="line in rest" :key="line.id" class="oper-line" :data-line="line.id">
					<div class="oper-line-text">
						<span class="oper-line-label">{{ line.label }}</span>
					</div>
					<div class="oper-line-ctl">
						<span v-if="tmpOf(line)" class="oper-line-tmp">{{ tmpOf(line) }}</span>
						<div
							class="oper-seg oper-route-seg"
							role="radiogroup"
							:aria-label="`Where ${line.label.toLowerCase()} show`"
						>
							<button
								v-for="pos in POSITIONS"
								:key="pos.route"
								type="button"
								role="radio"
								:aria-checked="routeOf(line) === pos.route"
								:class="{tmp: pos.route === routeOf(line) && !!tmpOf(line)}"
								:title="pos.title"
								@click="choose($event, line, pos.route)"
							>
								{{ pos.label }}
							</button>
						</div>
					</div>
				</li>
			</ul>
		</details>

		<section v-if="x3" class="oper-alerts-section oper-o3">
			<div class="oper-o3-head">
				<h2>{{ operBot }} alerts</h2>
				<button type="button" class="btn btn-small oper-o3-new" @click="newAlert">
					New {{ operBot }} alert…
				</button>
			</div>
			<details class="oper-fold oper-o3-fold" @toggle="onToggle">
				<summary>
					Your {{ operBot }} alerts<template v-if="alerts.state === 'done'">
						· {{ alerts.list.length }}</template
					>
				</summary>
				<p v-if="alerts.state === 'asking'" class="oper-muted oper-o3-note">
					Asking {{ operBot }}…
				</p>
				<p v-else-if="alerts.state === 'failed'" class="oper-muted oper-o3-note">
					{{ alerts.note }}
				</p>
				<p
					v-else-if="alerts.state === 'done' && alerts.list.length === 0"
					class="oper-muted oper-o3-note"
				>
					No alerts of yours.
				</p>
				<ul v-else-if="alerts.state === 'done'" class="oper-lines oper-o3-list">
					<li
						v-for="a in alerts.list"
						:key="a.name"
						class="oper-line oper-o3-alert"
						:data-alert="a.name"
					>
						<div class="oper-line-text">
							<span class="oper-line-label">
								<code>{{ a.name }}</code> · {{ a.reaction }} · by {{ a.owner }} ·
								{{ expiresText(a) }}
							</span>
							<span class="oper-line-hint oper-mono">{{ a.criteria }}</span>
							<span v-if="a.triggered" class="oper-line-hint"
								>last fired
								{{ a.triggered === "Never" ? "never" : `${a.triggered} ago` }}</span
							>
						</div>
						<div class="oper-line-ctl">
							<template v-if="deleting === a.name">
								<span class="oper-o3-confirm">Delete {{ a.name }}?</span>
								<button
									type="button"
									class="btn btn-small btn-danger"
									:disabled="busy"
									@click="confirmDelete(a)"
								>
									Delete
								</button>
								<button
									type="button"
									class="btn btn-small btn-cancel"
									@click="deleting = ''"
								>
									Keep
								</button>
							</template>
							<template v-else>
								<button type="button" class="btn btn-small" @click="edit(a)">
									Edit
								</button>
								<button
									type="button"
									class="btn btn-small"
									@click="deleting = a.name"
								>
									Delete
								</button>
							</template>
						</div>
					</li>
				</ul>
				<p v-if="alerts.result" class="oper-o3-result" role="status">
					{{ alerts.result }}
				</p>
			</details>
		</section>

		<details v-if="model" class="oper-fold oper-raw">
			<summary>Raw mask and presets</summary>
			<div class="oper-mask-readout">
				<span>
					Mask <code :title="`0x${draft.toString(16)}`">{{ draft }}</code>
				</span>
				<span v-if="pending" class="oper-muted">Applying…</span>
				<span v-else-if="!hasS" class="oper-muted"
					>Server notices are off (+s not set).</span
				>
			</div>
			<div class="oper-presets" role="group" aria-label="Presets">
				<button
					v-for="p in presets"
					:key="p.label"
					type="button"
					:class="['btn', 'btn-small', {active: p.mask === draft}]"
					:title="`${p.mask} (0x${p.mask.toString(16)})`"
					@click="apply(p.mask)"
				>
					{{ p.label }}
				</button>
				<button type="button" class="btn btn-small" @click="apply(0)">Off</button>
			</div>
			<ul class="oper-bits">
				<li
					v-for="bit in shownBits"
					:key="bit.bit"
					:class="[
						'oper-bit',
						{on: (draft & bit.bit) !== 0, unavailable: unavailable(bit)},
					]"
					:data-bit="bit.name"
				>
					<label class="oper-bit-head">
						<input
							v-switch
							type="checkbox"
							:checked="(draft & bit.bit) !== 0"
							:disabled="unavailable(bit) && (draft & bit.bit) === 0"
							@change="toggle(bit.bit)"
						/>
						<span class="oper-bit-label">{{ bit.label }}</span>
						<span v-if="silent(bit)" class="oper-muted">silent here</span>
					</label>
				</li>
			</ul>
		</details>
	</div>
</template>

<style>
.oper-alerts h2 {
	margin: 0 0 0.25rem;
	font-size: 1em;
	color: var(--body-color-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.oper-alerts-section + .oper-alerts-section {
	margin-top: 1.25rem;
}

.oper-lines {
	list-style: none;
	margin: 0;
	padding: 0;
}

.oper-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 0.3rem 1rem;
	padding: 0.45rem 0;
	border-bottom: 1px solid color-mix(in srgb, var(--body-color-muted) 25%, transparent);
}

.oper-line-text {
	flex: 1 1 12rem;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.oper-line-hint {
	color: var(--body-color-muted);
	font-size: 0.8125em;
}

.oper-line-ctl {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	margin-left: auto;
}

.oper-line-tmp {
	color: var(--oper-amber);
	font-size: 0.8125em;
	white-space: nowrap;
}

.oper-lines-rest .oper-line-label {
	font-size: 0.9375em;
}

.oper-fold {
	margin-top: 1.25rem;
}

.oper-fold > summary {
	cursor: pointer;
	color: var(--body-color-muted);
	padding: 0.4rem 0;
}

.oper-fold > summary:hover,
.oper-fold[open] > summary {
	color: var(--body-color);
}

.oper-raw .oper-mask-readout {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem;
	align-items: baseline;
	margin: 0.25rem 0 0.5rem;
}

.oper-presets {
	display: flex;
	flex-wrap: wrap;
	gap: 0.4rem;
	margin-bottom: 0.75rem;
}

.oper-presets .btn {
	margin: 0;
}

.oper-presets .btn.active {
	border-color: var(--link-color);
	color: var(--link-color);
}

.oper-bits {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
	gap: 0.15rem 1rem;
}

.oper-bit.unavailable .oper-bit-label {
	color: var(--body-color-muted);
}

.oper-bit-head {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	cursor: pointer;
	padding: 0.15rem 0;
}

/* The oper service's own alerts: the New button beside the heading, the
 * list folded, Delete asked once inline. */
.oper-alerts-section.oper-o3 {
	margin-top: 1.25rem;
}

.oper-o3-head {
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 0.5rem 1rem;
}

.oper-o3-head h2 {
	flex: 1 1 auto;
	margin: 0;
}

.oper-o3 .oper-fold {
	margin-top: 0.25rem;
}

.oper-o3 .btn-small {
	margin: 0;
	padding: 0.3em 0.75em;
	font-size: 0.875em;
	line-height: 1.4;
	border-width: 1px;
	letter-spacing: 0;
	text-transform: none;
}

.oper-o3 .btn-cancel {
	border-color: transparent;
}

.oper-o3-note,
.oper-o3-result {
	margin: 0.4rem 0 0;
	font-size: 0.9375em;
}

.oper-o3-result {
	color: var(--link-color);
}

.oper-o3-confirm {
	color: var(--oper-amber);
	font-size: 0.875em;
}

.oper-o3-alert .oper-line-hint.oper-mono {
	overflow-wrap: anywhere;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, PropType, ref, watch} from "vue";
import type {Route} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import socket from "../../js/socket";
import eventbus from "../../js/eventbus";
import {profileById} from "../../js/irc/profiles";
import type {AlertLine, NoticeKind, SnomaskBit} from "../../js/irc/profiles/types";
import {allNoticeKinds} from "../../js/irc/snotice";
import {routeFor, sweepTemporaryRoutes, temporaryRouteFor} from "../../js/irc/operprefs";
import {alertLinesFor, lineRoute, untilText, type RestLine} from "../../js/helpers/operAlerts";
import {applyNoticeRoute, hereItems} from "../../js/helpers/operMenu";
import useNow from "../../js/hooks/use-now";
import {clientForNetwork} from "../../js/irc/manager";
import {delAlert, describeFailure, listAlerts} from "../../js/irc/alerts";
import type {ServiceAlert} from "../../js/irc/services/types";
import type {AlertBuilderRequest} from "../../js/helpers/alertBuilder";

interface AlertsState {
	state: "idle" | "asking" | "done" | "failed";
	list: ServiceAlert[];
	note: string;
	/** The last delete's verdict, in the bot's words. */
	result: string;
}

const SECTIONS: {id: "actions" | "network"; label: string}[] = [
	{id: "actions", label: "Oper actions"},
	{id: "network", label: "The network"},
];

const POSITIONS: {route: Route; label: string; title: string}[] = [
	{route: "active", label: "Here", title: "In the window you are looking at"},
	{route: "network", label: "Network", title: "In the network window, no unread"},
	{route: "off", label: "Off", title: "Never shown; the server stops sending it when it can"},
];

type Line = AlertLine | RestLine;

/**
 * The Alerts tab (docs/projects/oper-tools.md, "The panel, redrawn"): what
 * reaches you and how loudly, in plain words — each line a Here / Network
 * / Off control over a few notice kinds (helpers/operAlerts.ts). Here asks
 * how long; a temporary choice shows warmer with what it has left. Off
 * clears the server bit once every kind on it is off
 * (helpers/operMenu.ts `reconcileSnomask`). The raw mask and the presets
 * are folded away at the bottom.
 */
export default defineComponent({
	name: "OperAlerts",
	components: {},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const now = useNow();
		const profile = computed(() => profileById(props.network.oper?.profile));
		const model = computed(() => profile.value.snomask);
		const kinds = computed(() => allNoticeKinds(profile.value));
		const kindIndex = computed(() => new Map(kinds.value.map((k) => [k.kind, k])));
		const alertLines = computed(() => alertLinesFor(profile.value));
		const rest = computed(() => alertLines.value.rest);
		const linesIn = (section: "actions" | "network") =>
			alertLines.value.lines.filter((l) => l.section === section);

		// The stored routes are read on every render of this version: a
		// change here, or from a notice's badge (`oper:routes`), bumps it.
		const version = ref(0);
		const reload = () => version.value++;

		const onRoutes = (data: {network: string}) => {
			if (data.network === props.network.uuid) {
				reload();
			}
		};

		const kindsOf = (line: Line): NoticeKind[] =>
			line.kinds.map((k) => kindIndex.value.get(k)).filter((k): k is NoticeKind => !!k);

		const routeOfKind = (kind: NoticeKind): Route => {
			void version.value;
			return routeFor(props.network.uuid, kind.kind, kind.route, now.value);
		};

		const routeOf = (line: Line): Route =>
			lineRoute(line, (k) =>
				routeOfKind(
					kindIndex.value.get(k) ?? {kind: k, label: k, category: "", route: "network"}
				)
			);

		const tmpOf = (line: Line): string => {
			void version.value;
			const entry = temporaryRouteFor(props.network.uuid, line.kinds[0], now.value);
			return entry ? untilText(entry.until, now.value) : "";
		};

		const choose = (event: MouseEvent, line: Line, route: Route) => {
			const target = kindsOf(line);

			if (route === "active") {
				eventbus.emit("contextmenu:items", {
					event,
					items: hereItems("oper-route-active", (until) =>
						applyNoticeRoute(props.network, target, "active", until)
					),
				});
				return;
			}

			applyNoticeRoute(props.network, target, route);
		};

		// --- The raw mask (what the old switchboard did): the server's,
		// until the oper toggles; their changes go out together a moment later.
		const hasS = computed(() => (props.network.oper?.umodes ?? "").includes("s"));
		const draft = ref(props.network.oper?.snomask ?? 0);
		const pending = ref(false);
		let timer: ReturnType<typeof setTimeout> | undefined;

		watch(
			() => props.network.oper?.snomask,
			(mask) => {
				if (!pending.value) {
					draft.value = mask ?? 0;
				}
			}
		);

		const send = () => {
			timer = undefined;
			socket.emit("oper:snomask", {network: props.network.uuid, mask: draft.value});
			// The 008 answer moves `snomask`; until then the switches hold.
			setTimeout(() => {
				pending.value = false;
				draft.value = props.network.oper?.snomask ?? draft.value;
			}, 1500);
		};

		const apply = (mask: number) => {
			draft.value = mask;
			pending.value = true;
			clearTimeout(timer);
			timer = setTimeout(send, 400);
		};

		const toggle = (bit: number) => apply(draft.value ^ bit);

		const features = computed(() => props.network.oper?.features ?? {});
		const silent = (bit: SnomaskBit) =>
			!!bit.needsFeature && features.value[bit.needsFeature] === "FALSE";
		const unavailable = (bit: SnomaskBit) => !!bit.dead || !!bit.debugOnly;
		const shownBits = computed(() =>
			(model.value?.bits ?? []).filter((b) => !unavailable(b) || (draft.value & b.bit) !== 0)
		);

		const presets = computed(() => {
			const m = model.value;

			if (!m) {
				return [];
			}

			const named = (...names: string[]) =>
				m.bits.filter((b) => names.includes(b.name)).reduce((acc, b) => acc | b.bit, 0);
			const operDefault = Number(features.value[m.operDefaultFeature ?? ""]) || m.operDefault;

			return [
				{label: "Oper default", mask: operDefault},
				{label: "Ban watch", mask: named("GLINE", "AUTO", "OPERKILL")},
				{label: "Linking", mask: named("NETWORK", "OLDSNO")},
				{label: "Everything", mask: m.all},
			];
		});

		// --- The oper service's own alerts (irc/alerts.ts), X3 only: listed
		// when the fold opens, Edit reopens the builder on one, Delete asks
		// once inline. The builder announces `oper:alerts-changed`.
		const x3 = computed(() => props.network.services?.package === "x3");
		const operBot = computed(() => props.network.services?.bots.oper || "O3");
		const alerts = ref<AlertsState>({state: "idle", list: [], note: "", result: ""});
		const deleting = ref("");
		const busy = ref(false);
		const folded = ref(true);

		const load = async () => {
			const client = clientForNetwork(props.network.uuid);

			if (!client) {
				alerts.value = {...alerts.value, state: "failed", note: "The network is gone."};
				return;
			}

			alerts.value = {...alerts.value, state: "asking"};
			const answer = await listAlerts(client);

			if (answer.kind !== "reply") {
				alerts.value = {
					...alerts.value,
					state: "failed",
					list: [],
					note: describeFailure(client, answer),
				};
				return;
			}

			alerts.value = {...alerts.value, state: "done", list: answer.value ?? [], note: ""};
		};

		const onToggle = (event: Event) => {
			folded.value = !(event.target as HTMLDetailsElement).open;

			if (!folded.value && alerts.value.state !== "asking") {
				void load();
			}
		};

		const onAlertsChanged = (data: {network: string}) => {
			if (data.network === props.network.uuid && !folded.value) {
				void load();
			}
		};

		const newAlert = () => {
			const req: AlertBuilderRequest = {network: props.network.uuid};
			eventbus.emit("oper:alert-builder", req);
		};

		const edit = (alert: ServiceAlert) => {
			const req: AlertBuilderRequest = {network: props.network.uuid, edit: alert};
			eventbus.emit("oper:alert-builder", req);
		};

		const confirmDelete = async (alert: ServiceAlert) => {
			const client = clientForNetwork(props.network.uuid);

			if (!client || busy.value) {
				return;
			}

			busy.value = true;

			try {
				const answer = await delAlert(client, alert.name);
				alerts.value = {
					...alerts.value,
					result:
						answer.kind === "reply"
							? answer.value?.text ?? `${operBot.value} did not answer.`
							: describeFailure(client, answer),
				};

				if (answer.kind === "reply" && answer.value?.ok) {
					alerts.value = {
						...alerts.value,
						list: alerts.value.list.filter((a) => a.name !== alert.name),
					};
				}
			} finally {
				busy.value = false;
				deleting.value = "";
			}
		};

		const expiresText = (alert: ServiceAlert) => {
			if (!alert.expires) {
				return "never expires";
			}

			const at = Date.parse(
				alert.expires.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (\S+)$/, "$1T$2$3")
			);

			if (!Number.isFinite(at)) {
				return `expires ${alert.expires}`;
			}

			const left = Math.round((at - now.value) / 3_600_000);
			return left <= 0
				? "expired"
				: left < 48
				? `expires in ${left} h`
				: `expires in ${Math.round(left / 24)} d`;
		};

		onMounted(() => {
			sweepTemporaryRoutes(props.network.uuid);
			eventbus.on("oper:routes", onRoutes);
			eventbus.on("oper:alerts-changed", onAlertsChanged);
		});

		onUnmounted(() => {
			eventbus.off("oper:routes", onRoutes);
			eventbus.off("oper:alerts-changed", onAlertsChanged);

			if (timer !== undefined) {
				clearTimeout(timer);
				send();
			}
		});

		return {
			x3,
			operBot,
			alerts,
			deleting,
			busy,
			onToggle,
			newAlert,
			edit,
			confirmDelete,
			expiresText,
			SECTIONS,
			POSITIONS,
			model,
			rest,
			linesIn,
			routeOf,
			tmpOf,
			choose,
			hasS,
			draft,
			pending,
			apply,
			toggle,
			silent,
			unavailable,
			shownBits,
			presets,
		};
	},
});
</script>
