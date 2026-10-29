<template>
	<li :aria-label="labelText" role="tab" :aria-selected="isActiveRoute" aria-controls="settings">
		<router-link v-slot:default="{navigate, isExactActive}" :to="'/settings/' + to" custom>
			<button
				:class="['icon', className, {active: isExactActive || isActiveRoute}]"
				:aria-label="labelText"
				:title="labelText"
				@click="navigate"
				@keypress.enter="navigate"
			>
				<span class="tab-label">{{ labelText }}</span>
			</button>
		</router-link>
	</li>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useRoute} from "vue-router";

export default defineComponent({
	name: "SettingTabListItem",
	props: {
		name: {
			type: String,
			required: true,
		},
		/** The tab's display label (aria-label and title too). Defaults to
		 * `name`, which stays the route identity the active state is
		 * computed from — translation must never overload identity. */
		label: {
			type: String,
			default: undefined,
		},
		className: {
			type: String,
			required: true,
		},
		to: {
			type: String,
			required: true,
		},
	},
	setup(props) {
		const route = useRoute();
		const isActiveRoute = computed(
			() =>
				route.name === props.name ||
				(props.name === "Networks" && route.name === "NetworkEdit")
		);
		const label = computed(() => props.label ?? props.name);

		return {
			route,
			isActiveRoute,
			labelText: label,
		};
	},
});
</script>
