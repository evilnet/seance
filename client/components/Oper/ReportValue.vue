<template>
	<span v-if="values.length > 1" class="oper-values"
		><ReportValue
			v-for="(item, i) in values"
			:key="i"
			:value="item"
			:network="network"
			:chan="chan"
	/></span>
	<template v-else-if="one">
		<Username
			v-if="one.t === 'nick'"
			:user="{nick: one.v, mode: ''}"
			:network="network"
			class="oper-nick"
		/>
		<button
			v-else-if="one.t === 'ip' || one.t === 'host' || one.t === 'mask'"
			type="button"
			:class="['oper-chip', 'oper-chip-' + one.t]"
			:title="chipTitle"
			@click.stop="openMenu($event, one.t, one.v)"
		>
			{{ one.v }}
		</button>
		<span v-else-if="one.t === 'server'" class="oper-server">{{ one.v }}</span>
		<span v-else-if="one.t === 'channel'" class="oper-channel"
			><span v-if="one.prefix" class="oper-channel-prefix">{{ one.prefix }}</span
			><ParsedMessage :network="network" :text="one.v"
		/></span>
		<time v-else-if="one.t === 'time'" class="oper-time" :title="absolute(one.v)"
			>{{ one.text ? absolute(one.v) : relative(one.v) }}
			<span v-if="one.text" class="oper-muted">({{ relative(one.v) }})</span></time
		>
		<time
			v-else-if="one.t === 'expiry'"
			:class="['oper-expiry', {expired: one.v > 0 && one.v <= now}]"
			:title="one.v ? absolute(one.v) : 'Never expires'"
			>{{ expiry(one.v) }}</time
		>
		<span v-else-if="one.t === 'duration'" class="oper-duration">{{ duration(one.v) }}</span>
		<span v-else-if="one.t === 'bytes'" class="oper-bytes" :title="`${one.v} bytes`">{{
			bytes(one.v)
		}}</span>
		<span v-else-if="one.t === 'number'" class="oper-number">{{ one.v.toLocaleString() }}</span>
		<span v-else-if="one.t === 'chips'" class="oper-chips"
			><span v-for="chip in one.v" :key="chip" class="oper-chip-static">{{
				chip
			}}</span></span
		>
		<span v-else-if="one.t === 'state'" :class="['oper-state', one.ok ? 'ok' : 'off']">{{
			one.v
		}}</span>
		<code v-else-if="one.t === 'mono'" class="oper-mono">{{ one.v }}</code>
		<span v-else class="oper-text">{{ one.v }}</span>
	</template>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ReportValue} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import {formatBytes, formatDuration, formatExpiry, relativeTime} from "../../js/helpers/operFormat";
import {openOperTargetMenu} from "../../js/helpers/operMenu";
import localetime from "../../js/helpers/localetime";
import useNow from "../../js/hooks/use-now";
import {useStore} from "../../js/store";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

/** One typed value of an oper report (shared/types/oper.ts), or a run of them. */
export default defineComponent({
	name: "ReportValue",
	components: {ParsedMessage, Username},
	props: {
		value: {
			type: [Object, Array] as PropType<ReportValue | ReportValue[] | undefined>,
			required: false,
		},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		/** Where the chips' actions send their commands; the active window when unset. */
		chan: {type: Number, required: false},
	},
	setup(props) {
		const store = useStore();
		const now = useNow();
		const values = computed<ReportValue[]>(() =>
			props.value === undefined
				? []
				: Array.isArray(props.value)
				? props.value
				: [props.value]
		);
		const one = computed(() => values.value[0]);

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			const chan =
				props.chan ?? store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			openOperTargetMenu(event, props.network, chan, kind, value);
		};

		return {
			values,
			one,
			now,
			openMenu,
			chipTitle: "Oper actions",
			absolute: (ms: number) => localetime(new Date(ms)),
			relative: (ms: number) => relativeTime(ms, now.value),
			expiry: (ms: number) => formatExpiry(ms, now.value),
			duration: formatDuration,
			bytes: formatBytes,
		};
	},
});
</script>
