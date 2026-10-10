<template>
	<div class="oper-notices">
		<template v-if="model">
			<h2>Server notice mask</h2>
			<p class="help">
				What the server sends you. Each switch is one bit of the mask; under it, the kinds
				of notice it carries and where each one shows: in the window you are looking at, in
				the network window (no unread), or nowhere.
			</p>
			<div class="oper-mask-readout">
				<span>
					Mask <code>{{ draft }}</code>
					<span class="oper-muted">(0x{{ draft.toString(16) }})</span>
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
					v-for="bit in model.bits"
					:key="bit.bit"
					:class="[
						'oper-bit',
						{on: (draft & bit.bit) !== 0, unavailable: unavailable(bit)},
					]"
				>
					<label class="oper-bit-head">
						<input
							type="checkbox"
							:checked="(draft & bit.bit) !== 0"
							:disabled="unavailable(bit) && (draft & bit.bit) === 0"
							@change="toggle(bit.bit)"
						/>
						<span class="oper-bit-label">{{ bit.label }}</span>
						<code class="oper-bit-name">{{ bit.name }}</code>
						<span :class="['oper-volume', 'oper-volume-' + bit.volume]">{{
							volume(bit.volume)
						}}</span>
						<span v-if="bit.operOnly" class="oper-tag">opers only</span>
					</label>
					<p class="oper-bit-desc">
						{{ bit.description }}
						<strong v-if="silent(bit)" class="oper-bit-warning"
							>Silent on this server: {{ bit.needsFeature }} is off.</strong
						>
					</p>
					<ul v-if="kindsOf(bit.name).length" class="oper-kinds">
						<li v-for="kind in kindsOf(bit.name)" :key="kind.kind">
							<span class="oper-kind-label">{{ kind.label }}</span>
							<select
								class="input oper-route"
								:value="routeOf(kind)"
								:aria-label="`Where ${kind.label} go`"
								@change="setKindRoute(kind, ($event.target as HTMLSelectElement).value)"
							>
								<option value="active">Active window</option>
								<option value="network">Network window</option>
								<option value="off">Nowhere</option>
							</select>
						</li>
					</ul>
				</li>
			</ul>
		</template>

		<h2>WALLOPS and the rest</h2>
		<ul class="oper-kinds oper-kinds-flat">
			<li v-for="kind in otherKinds" :key="kind.kind">
				<span class="oper-kind-label">{{ kind.label }}</span>
				<select
					class="input oper-route"
					:value="routeOf(kind)"
					:aria-label="`Where ${kind.label} go`"
					@change="setKindRoute(kind, ($event.target as HTMLSelectElement).value)"
				>
					<option value="active">Active window</option>
					<option value="network">Network window</option>
					<option value="off">Nowhere</option>
				</select>
			</li>
		</ul>
		<button type="button" class="btn btn-small" @click="resetAll">
			Reset every route to its default
		</button>

		<h2>Recent notices</h2>
		<div class="oper-recent-filters">
			<input
				v-model="filter"
				class="input"
				type="search"
				placeholder="Filter by text, nick, IP…"
				aria-label="Filter recent notices"
			/>
			<select v-model="categoryFilter" class="input" aria-label="Category">
				<option value="">Every category</option>
				<option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
			</select>
		</div>
		<p v-if="!recent.length" class="oper-muted">Nothing kept yet.</p>
		<ol v-else class="oper-recent">
			<li v-for="(entry, i) in shownRecent" :key="i" class="oper-recent-row">
				<time class="oper-recent-time" :title="absolute(entry.time)">{{
					clock(entry.time)
				}}</time>
				<span :class="['snotice-badge', 'snotice-' + badge(entry).family]">{{
					badge(entry).label
				}}</span>
				<span v-if="entry.type === 'wallops'" class="oper-recent-text"
					><strong>{{ entry.from }}</strong> {{ entry.text }}</span
				>
				<SnoticeText v-else :info="entry.snotice" :text="entry.text" :network="network" />
			</li>
		</ol>
		<p v-if="filteredRecent.length > shownRecent.length" class="oper-muted">
			Showing the newest {{ shownRecent.length }} of {{ filteredRecent.length }}.
		</p>
	</div>
</template>

<style>
.oper-notices h2 {
	margin-top: 1.5rem;
}

.oper-notices h2:first-child {
	margin-top: 0;
}

.oper-mask-readout {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem;
	align-items: baseline;
	margin-bottom: 0.5rem;
}

.oper-presets {
	display: flex;
	flex-wrap: wrap;
	gap: 0.4rem;
	margin-bottom: 1rem;
}

.oper-presets .btn {
	margin: 0;
}

.oper-presets .btn.active {
	border-color: var(--link-color);
	color: var(--link-color);
}

.oper-bits,
.oper-kinds {
	list-style: none;
	margin: 0;
	padding: 0;
}

.oper-bit {
	padding: 0.6rem 0;
	border-bottom: 1px solid color-mix(in srgb, var(--body-color-muted) 25%, transparent);
}

.oper-bit.unavailable .oper-bit-label {
	color: var(--body-color-muted);
}

.oper-bit-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	cursor: pointer;
}

.oper-bit-label {
	font-weight: 600;
}

.oper-bit-name {
	color: var(--body-color-muted);
	font-size: 0.8125em;
}

.oper-bit-desc {
	color: var(--body-color-muted);
	font-size: 0.875em;
	margin: 0.2rem 0 0 1.6rem;
}

.oper-bit-warning {
	display: block;
	color: var(--link-color);
	font-weight: 600;
}

.oper-volume,
.oper-tag {
	font-size: 0.75em;
	border: 1px solid currentcolor;
	border-radius: 0.6em;
	padding: 0 0.45em;
	color: var(--body-color-muted);
}

.oper-volume-high {
	color: var(--link-color);
}

.oper-kinds {
	margin: 0.4rem 0 0 1.6rem;
}

.oper-kinds li {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	padding: 0.15rem 0;
}

.oper-kinds-flat {
	margin: 0 0 0.75rem;
}

.oper-kind-label {
	font-size: 0.9375em;
}

.input.oper-route {
	width: auto;
	min-width: 10rem;
	margin: 0;
	padding-top: 0.15rem;
	padding-bottom: 0.15rem;
}

.oper-recent-filters {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-bottom: 0.5rem;
}

.oper-recent-filters .input {
	margin: 0;
	flex: 1 1 12rem;
}

.oper-recent {
	list-style: none;
	margin: 0;
	padding: 0;
	font-size: 0.9375em;
}

.oper-recent-row {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	padding: 0.15rem 0;
}

.oper-recent-time {
	color: var(--body-color-muted);
	font-variant-numeric: tabular-nums;
	flex-shrink: 0;
}

.oper-recent-row .snotice-badge {
	flex-shrink: 0;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, PropType, ref, watch} from "vue";
import dayjs from "dayjs";
import type {Route, SnoticeInfo} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import socket from "../../js/socket";
import {profileById} from "../../js/irc/profiles";
import type {NoticeKind, SnomaskBit} from "../../js/irc/profiles/types";
import {allNoticeKinds, UNKNOWN_KIND, WALLOPS_KINDS} from "../../js/irc/snotice";
import {getOperPrefs, resetRoutes, setRoute} from "../../js/irc/operprefs";
import {categoryBadge, wallopsBadge} from "../../js/helpers/operFormat";
import localetime from "../../js/helpers/localetime";
import SnoticeText from "./SnoticeText.vue";

type Entry = {time: number; type: string; text: string; from?: string; snotice: SnoticeInfo};

/** How many recent notices render at once (the ring keeps up to 2000). */
const RECENT_LIMIT = 300;

export default defineComponent({
	name: "OperNotices",
	components: {SnoticeText},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const profile = computed(() => profileById(props.network.oper?.profile));
		const model = computed(() => profile.value.snomask);
		const hasS = computed(() => (props.network.oper?.umodes ?? "").includes("s"));

		// The mask as the switches show it: the server's, until the oper
		// toggles; their changes go out together a moment later.
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

		const volume = (v: string) => (v === "none" ? "silent" : `${v} volume`);

		// Routes: the stored choices, mirrored here so the selects react.
		const routes = ref<Record<string, Route>>({
			...(getOperPrefs(props.network.uuid).routes ?? {}),
		});
		const kinds = computed(() => allNoticeKinds(profile.value));
		const kindsOf = (category: string) => kinds.value.filter((k) => k.category === category);
		const otherKinds = computed(() => {
			const bitNames = new Set((model.value?.bits ?? []).map((b) => b.name));
			return kinds.value.filter((k) => !bitNames.has(k.category));
		});
		const routeOf = (kind: NoticeKind): Route => routes.value[kind.kind] ?? kind.route;

		const setKindRoute = (kind: NoticeKind, value: string) => {
			const route = value as Route;
			setRoute(props.network.uuid, kind.kind, route === kind.route ? undefined : route);
			routes.value = {...(getOperPrefs(props.network.uuid).routes ?? {})};
		};

		const resetAll = () => {
			resetRoutes(props.network.uuid);
			routes.value = {};
		};

		// Recent notices: the IRC layer's ring (irc/noticelog.ts).
		const recent = ref<Entry[]>([]);
		const filter = ref("");
		const categoryFilter = ref("");

		const onNotices = (data: {network: string; entries: Entry[]}) => {
			if (data.network === props.network.uuid) {
				recent.value = data.entries;
			}
		};

		onMounted(() => {
			socket.on("oper:notices", onNotices);
			socket.emit("oper:notices:get", {network: props.network.uuid});
		});

		onUnmounted(() => {
			socket.off("oper:notices", onNotices);

			if (timer !== undefined) {
				clearTimeout(timer);
				send();
			}
		});

		const categories = computed(() =>
			Array.from(new Set(recent.value.map((e) => e.snotice.category))).sort()
		);
		const filteredRecent = computed(() => {
			const needle = filter.value.trim().toLowerCase();

			return recent.value.filter(
				(e) =>
					(!categoryFilter.value || e.snotice.category === categoryFilter.value) &&
					(!needle ||
						e.text.toLowerCase().includes(needle) ||
						(e.from ?? "").toLowerCase().includes(needle))
			);
		});
		const shownRecent = computed(() => filteredRecent.value.slice(-RECENT_LIMIT).reverse());

		const badge = (e: Entry) =>
			e.type === "wallops"
				? {label: wallopsBadge(e.snotice.kind), family: "wallops"}
				: categoryBadge(e.snotice.category);

		return {
			model,
			hasS,
			draft,
			pending,
			apply,
			toggle,
			silent,
			unavailable,
			presets,
			volume,
			kindsOf,
			otherKinds,
			routeOf,
			setKindRoute,
			resetAll,
			recent,
			filter,
			categoryFilter,
			categories,
			filteredRecent,
			shownRecent,
			badge,
			clock: (t: number) => dayjs(t).format("HH:mm:ss"),
			absolute: (t: number) => localetime(new Date(t)),
			WALLOPS_KINDS,
			UNKNOWN_KIND,
		};
	},
});
</script>
