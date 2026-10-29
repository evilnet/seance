<template>
	<div
		id="confirm-dialog-overlay"
		:class="{opened: !!data}"
		:data-escape-close="data ? 'confirm' : null"
	>
		<div v-if="data !== null" id="confirm-dialog">
			<div class="confirm-text">
				<div class="confirm-text-title">{{ data?.title }}</div>
				<p>{{ data?.text }}</p>
				<p v-if="data?.note" class="confirm-note">{{ data.note }}</p>
			</div>
			<div class="confirm-buttons">
				<button class="btn btn-cancel" @click="close(false)">
					{{ data?.cancel || t("confirm.cancel") }}
				</button>
				<button
					:class="['btn', data?.primary ? 'btn-confirm' : 'btn-danger']"
					@click="close(true)"
				>
					{{ data?.button }}
				</button>
			</div>
		</div>
	</div>
</template>

<style>
#confirm-dialog {
	background: var(--body-bg-color);
	color: #fff;
	margin: 10px;
	border-radius: 5px;
	max-width: 500px;
}

#confirm-dialog .confirm-text {
	padding: 15px;
	user-select: text;
}

#confirm-dialog .confirm-text-title {
	font-size: 1.25rem;
	font-weight: 700;
	margin-bottom: 10px;
}

#confirm-dialog .confirm-buttons {
	display: flex;
	justify-content: flex-end;
	padding: 15px;
	background: rgba(0, 0, 0, 0.3);
}

#confirm-dialog .confirm-buttons .btn {
	margin-bottom: 0;
	margin-inline-start: 10px;
}

#confirm-dialog .confirm-buttons .btn-cancel {
	border-color: transparent;
}

#confirm-dialog .confirm-note {
	margin-top: 0.5rem;
	font-weight: 700;
}
</style>

<script lang="ts">
import eventbus from "../js/eventbus";
import {useI18n} from "../js/i18n";
import {defineComponent, onMounted, onUnmounted, ref} from "vue";

type ConfirmDialogData = {
	title: string;
	text: string;
	button: string;
	/** A second paragraph, said apart (the download question's metered connection). */
	note?: string;
	/** The answer that is not the button's ("Not now"); "Cancel" when absent. */
	cancel?: string;
	/** The button is an ordinary action, not a destructive one: no danger colour. */
	primary?: boolean;
};

type ConfirmDialogCallback = {
	(confirmed: boolean): void;
};

export default defineComponent({
	name: "ConfirmDialog",
	setup() {
		const {t} = useI18n();
		const data = ref<ConfirmDialogData>();
		const callback = ref<ConfirmDialogCallback>();

		const open = (incoming: ConfirmDialogData, cb: ConfirmDialogCallback) => {
			// One dialog at a time: a question still open when another
			// arrives is answered no, rather than left waiting for ever
			// (a translation's download question holds requests on it).
			const previous = data.value ? callback.value : undefined;

			data.value = incoming;
			callback.value = cb;
			previous?.(false);
		};

		const close = (result: boolean) => {
			data.value = undefined;

			if (callback.value) {
				callback.value(!!result);
			}
		};

		const onEscape = (layer: string | null) => {
			if (layer === "confirm") {
				close(false);
			}
		};

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
			eventbus.on("confirm-dialog", open);
		});

		onUnmounted(() => {
			eventbus.off("escapekey", onEscape);
			eventbus.off("confirm-dialog", open);
		});

		return {
			t,
			data,
			close,
		};
	},
});
</script>
