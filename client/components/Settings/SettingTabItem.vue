<template>
	<li :aria-label="name" role="tab" :aria-selected="isActiveRoute" aria-controls="settings">
		<router-link v-slot:default="{navigate, isExactActive}" :to="'/settings/' + to" custom>
			<button
				:class="['icon', className, {active: isExactActive || isActiveRoute}]"
				:aria-label="name"
				:title="name"
				@click="navigate"
			>
				<span class="tab-label">{{ name }}</span>
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
				(props.name === "Networks" && route.name === "NetworkEdit") ||
				(props.name === "Scripts" && route.name === "ScriptEdit")
		);

		return {
			route,
			isActiveRoute,
		};
	},
});
</script>
