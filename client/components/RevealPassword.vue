<template>
	<div>
		<slot :is-visible="isVisible" />
		<span
			ref="revealButton"
			type="button"
			:class="[
				'reveal-password tooltipped tooltipped-n tooltipped-no-delay',
				{'reveal-password-visible': isVisible},
			]"
			:aria-label="visibilityLabel"
			@click="onClick"
		>
			<span :aria-label="visibilityLabel" />
		</span>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, ref} from "vue";
import {useI18n} from "../js/i18n";

export default defineComponent({
	name: "RevealPassword",
	setup() {
		const isVisible = ref(false);
		const {t} = useI18n();

		const onClick = () => {
			isVisible.value = !isVisible.value;
		};

		const visibilityLabel = computed(() =>
			isVisible.value ? t("input.hidePassword") : t("input.showPassword")
		);

		return {
			isVisible,
			visibilityLabel,
			onClick,
		};
	},
});
</script>
