<template>
	<div
		id="confirm-dialog-overlay"
		class="screen-overlay"
		:class="{opened: !!data}"
		:data-escape-close="data ? 'confirm' : null"
		@transitionend="onOverlayShown"
	>
		<div
			v-if="data"
			id="confirm-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
		>
			<div class="confirm-text">
				<div id="confirm-dialog-title" class="confirm-text-title">{{ data.title }}</div>
				<p>{{ data.text }}</p>
				<p v-if="data.note" class="confirm-note">{{ data.note }}</p>
				<p v-if="data.quote" class="confirm-quote">
					<I18nFrame :text="data.quote.frame"
						><template v-slot:reason
							><bdi>{{ data.quote.reason }}</bdi></template
						></I18nFrame
					>
				</p>
			</div>
			<div v-if="data.alt" class="confirm-buttons confirm-buttons-stacked">
				<button
					ref="confirmButton"
					:class="['btn', data.primary ? 'btn-confirm' : 'btn-danger']"
					@click="close(true)"
				>
					{{ data.button }}
				</button>
				<button class="btn btn-alt" @click="close(true, true)">
					{{ data.alt }}
				</button>
				<button ref="cancelButton" class="btn btn-cancel" @click="close(false)">
					{{ data.cancel || t("confirm.cancel") }}
				</button>
			</div>
			<div v-else class="confirm-buttons">
				<button ref="cancelButton" class="btn btn-cancel" @click="close(false)">
					{{ data.cancel || t("confirm.cancel") }}
				</button>
				<button
					ref="confirmButton"
					:class="['btn', data.primary ? 'btn-confirm' : 'btn-danger']"
					@click="close(true)"
				>
					{{ data.button }}
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

/* Three answers (the GPU fallback): one under the other, the main one first. */
#confirm-dialog .confirm-buttons-stacked {
	flex-direction: column;
	align-items: stretch;
	gap: 0.625rem;
}

#confirm-dialog .confirm-buttons-stacked .btn {
	margin-inline-start: 0;
}

/* The main answer is filled, the other two outlined (the button tokens'
   hover fill). */
#confirm-dialog .confirm-buttons-stacked .btn-confirm {
	background: var(--button-color);
	color: var(--button-text-color-hover);
}

#confirm-dialog .confirm-note {
	margin-top: 0.5rem;
	font-weight: 700;
}

#confirm-dialog .confirm-quote {
	margin-top: 0.5rem;
	margin-bottom: 0;
	font-size: 0.875rem;
	opacity: 0.8;
	overflow-wrap: anywhere;
}
</style>

<script lang="ts">
import eventbus from "../js/eventbus";
import {useI18n} from "../js/i18n";
import {defineComponent, nextTick, onMounted, onUnmounted, ref} from "vue";
import I18nFrame from "./I18nFrame.vue";

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
	/**
	 * A second yes (the GPU fallback's "Always use the CPU here"): the three
	 * answers stack, the button first, then this, then the cancel; the
	 * callback's `alt` says it was this one.
	 */
	alt?: string;
	/**
	 * A smaller line quoting someone else's words: `frame` is a t() result
	 * that KEEPs {reason}, and `reason` is shown in it verbatim, in a <bdi>
	 * (the browser's own text for a lost GPU).
	 */
	quote?: {frame: string; reason: string};
	/**
	 * A question nobody asked for by a click (the translation's download and
	 * GPU fallback questions): it waits behind whatever dialog is up rather
	 * than replacing it, and a dialog the user opens over it puts it back to
	 * wait instead of answering it no.
	 */
	wait?: boolean;
};

type ConfirmDialogCallback = {
	(confirmed: boolean, alt?: boolean): void;
};

export default defineComponent({
	name: "ConfirmDialog",
	components: {I18nFrame},
	setup() {
		const {t} = useI18n();
		const data = ref<ConfirmDialogData>();
		const callback = ref<ConfirmDialogCallback>();
		const confirmButton = ref<HTMLButtonElement | null>(null);
		const cancelButton = ref<HTMLButtonElement | null>(null);
		/** Questions waiting their turn (`wait`), oldest first. */
		const waiting: {data: ConfirmDialogData; callback: ConfirmDialogCallback}[] = [];
		/** What had the focus before the dialog opened: it gets it back. */
		let returnFocus: HTMLElement | null = null;

		/**
		 * The main answer takes the focus; a destructive dialog's cancel does,
		 * so Enter never deletes by accident. The overlay fades in with a
		 * `visibility` transition and a hidden button cannot take the focus,
		 * so this runs right after the render (a question replacing another,
		 * the overlay already shown) and again when the fade ends.
		 */
		const focusAnswer = () => {
			if (data.value) {
				(data.value.primary ? confirmButton.value : cancelButton.value)?.focus();
			}
		};

		const onOverlayShown = (event: TransitionEvent) => {
			if (event.target === event.currentTarget && event.propertyName === "opacity") {
				focusAnswer();
			}
		};

		const show = (incoming: ConfirmDialogData, cb: ConfirmDialogCallback) => {
			if (!data.value) {
				returnFocus =
					document.activeElement instanceof HTMLElement ? document.activeElement : null;
			}

			data.value = incoming;
			callback.value = cb;
			void nextTick(focusAnswer);
		};

		const open = (incoming: ConfirmDialogData, cb: ConfirmDialogCallback) => {
			if (data.value && callback.value) {
				// A question that waits its turn queues behind what is up.
				if (incoming.wait) {
					waiting.push({data: incoming, callback: cb});
					return;
				}

				// One dialog at a time: a question still open when another
				// arrives is answered no, rather than left waiting for ever
				// (a translation's download question holds requests on it) --
				// unless it is one that waits, which goes back to waiting.
				if (data.value.wait) {
					waiting.unshift({data: data.value, callback: callback.value});
				} else {
					const previous = callback.value;

					show(incoming, cb);
					previous(false);
					return;
				}
			}

			show(incoming, cb);
		};

		const close = (result: boolean, alt = false) => {
			const answer = callback.value;

			data.value = undefined;
			callback.value = undefined;
			answer?.(!!result, result && alt);

			// The answer may itself have opened a dialog; otherwise the next
			// waiting question, else the focus goes back where it was.
			if (data.value) {
				return;
			}

			const next = waiting.shift();

			if (next) {
				show(next.data, next.callback);
			} else if (returnFocus?.isConnected) {
				returnFocus.focus();
				returnFocus = null;
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
			confirmButton,
			cancelButton,
			onOverlayShown,
		};
	},
});
</script>
