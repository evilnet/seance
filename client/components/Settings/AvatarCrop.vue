<template>
	<div
		id="avatar-crop-overlay"
		v-backdrop="cancel"
		class="screen-overlay opened"
		data-escape-close="avatar-crop"
	>
		<div id="avatar-crop" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
			<div id="avatar-crop-title" class="avatar-crop-title">{{ t("avatar.cropTitle") }}</div>
			<div class="avatar-crop-stage">
				<canvas
					ref="stage"
					class="avatar-crop-canvas"
					tabindex="0"
					:aria-label="t('avatar.cropAria')"
					@pointerdown="onPointerDown"
					@pointermove="onPointerMove"
					@pointerup="onPointerUp"
					@pointercancel="onPointerUp"
					@keydown="onKey"
					@wheel.prevent="onWheel"
				/>
			</div>
			<label class="avatar-crop-zoom">
				<span>{{ t("avatar.zoom") }}</span>
				<input
					v-model.number="zoom"
					type="range"
					min="1"
					:max="ZOOM_MAX"
					step="0.05"
					:disabled="!ready"
				/>
			</label>
			<p v-if="problem" class="avatar-crop-problem" role="alert">{{ problem }}</p>
			<p v-else class="avatar-crop-hint">{{ t("avatar.cropHint") }}</p>
			<div class="avatar-crop-buttons">
				<button type="button" class="btn btn-cancel" @click="cancel">
					{{ t("confirm.cancel") }}
				</button>
				<button
					type="button"
					class="btn btn-confirm"
					:disabled="!ready || busy"
					@click="confirm"
				>
					{{ t("avatar.uploadAndUse") }}
				</button>
			</div>
		</div>
	</div>
</template>

<style>
#avatar-crop {
	background: var(--window-bg-color);
	color: var(--body-color);
	border-radius: 0.75rem;
	padding: 1.25rem;
	margin: 0.625rem;
	width: min(24rem, calc(100% - 1.25rem));
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 0.875rem;
	box-shadow: 0 0.5rem 2rem rgb(0 0 0 / 50%);
}

.avatar-crop-title {
	font-size: 1.0625rem;
	font-weight: 600;
}

.avatar-crop-stage {
	display: flex;
	justify-content: center;
}

.avatar-crop-canvas {
	width: 16rem;
	max-width: 100%;
	aspect-ratio: 1;
	border-radius: var(--avatar-radius, 50%);
	cursor: grab;
	touch-action: none;
	background: color-mix(in srgb, var(--body-color) 8%, transparent);
}

.avatar-crop-canvas:active {
	cursor: grabbing;
}

.avatar-crop-zoom {
	display: flex;
	align-items: center;
	gap: 0.75rem;
}

.avatar-crop-zoom input {
	flex: 1;
}

.avatar-crop-hint,
.avatar-crop-problem {
	margin: 0;
	font-size: 0.8125rem;
	color: var(--body-color-muted);
}

.avatar-crop-problem {
	color: var(--oper-red, #c0392b);
}

.avatar-crop-buttons {
	display: flex;
	justify-content: flex-end;
	gap: 0.5rem;
}
</style>

<script lang="ts">
// Crop a chosen picture to a square avatar (avatars/image.ts): drag or the
// arrow keys to move it, the slider, the wheel or +/- to zoom. Hands the
// encoded blob to its parent, which uploads it.
import {defineComponent, onMounted, onUnmounted, PropType, ref, watch} from "vue";
import eventbus from "../../js/eventbus";
import {useI18n} from "../../js/i18n";
import {
	AVATAR_MIN_SOURCE,
	clampCrop,
	cropSide,
	drawCrop,
	encodeAvatar,
	initialCrop,
	sourceProblem,
	ZOOM_MAX,
	type Crop,
} from "../../js/avatars/image";

export default defineComponent({
	name: "AvatarCrop",
	props: {
		file: {type: Object as PropType<File>, required: true},
	},
	emits: ["done", "cancel"],
	setup(props, {emit}) {
		const {t} = useI18n();
		const stage = ref<HTMLCanvasElement>();
		const zoom = ref(1);
		const ready = ref(false);
		const busy = ref(false);
		const problem = ref("");
		let bitmap: ImageBitmap | null = null;
		let crop: Crop = {cx: 0, cy: 0, zoom: 1};
		let drag: {x: number; y: number; id: number} | null = null;

		const width = () => bitmap?.width ?? 0;
		const height = () => bitmap?.height ?? 0;

		const redraw = () => {
			const canvas = stage.value;

			if (!canvas || !bitmap) {
				return;
			}

			const px = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)) || 256;

			if (canvas.width !== px) {
				canvas.width = px;
				canvas.height = px;
			}

			drawCrop(canvas, bitmap, width(), height(), crop);
		};

		const move = (next: Partial<Crop>) => {
			crop = clampCrop(width(), height(), {...crop, ...next});
			zoom.value = crop.zoom;
			redraw();
		};

		/** Source pixels per CSS pixel of the stage. */
		const scale = () =>
			cropSide(width(), height(), crop.zoom) / (stage.value?.clientWidth || 256);

		onMounted(async () => {
			const why = sourceProblem(props.file);

			if (why) {
				problem.value = why === "tooLarge" ? t("avatar.tooLarge") : t("avatar.notImage");
				return;
			}

			try {
				bitmap = await createImageBitmap(props.file);
			} catch {
				problem.value = t("avatar.notImage");
				return;
			}

			if (Math.min(bitmap.width, bitmap.height) < AVATAR_MIN_SOURCE) {
				problem.value = t("avatar.tooSmall", {size: String(AVATAR_MIN_SOURCE)});
				return;
			}

			crop = initialCrop(bitmap.width, bitmap.height);
			ready.value = true;
			redraw();
			stage.value?.focus();
		});

		watch(zoom, (value) => {
			if (ready.value && value !== crop.zoom) {
				move({zoom: value});
			}
		});

		const onPointerDown = (event: PointerEvent) => {
			if (!ready.value) {
				return;
			}

			drag = {x: event.clientX, y: event.clientY, id: event.pointerId};
			(event.target as HTMLElement).setPointerCapture(event.pointerId);
		};

		const onPointerMove = (event: PointerEvent) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}

			const s = scale();
			move({
				cx: crop.cx - (event.clientX - drag.x) * s,
				cy: crop.cy - (event.clientY - drag.y) * s,
			});
			drag = {...drag, x: event.clientX, y: event.clientY};
		};

		const onPointerUp = () => {
			drag = null;
		};

		const onKey = (event: KeyboardEvent) => {
			const step = 8 * scale();
			const moves: Record<string, Partial<Crop>> = {
				ArrowLeft: {cx: crop.cx - step},
				ArrowRight: {cx: crop.cx + step},
				ArrowUp: {cy: crop.cy - step},
				ArrowDown: {cy: crop.cy + step},
				"+": {zoom: crop.zoom + 0.1},
				"=": {zoom: crop.zoom + 0.1},
				"-": {zoom: crop.zoom - 0.1},
			};
			const next = moves[event.key];

			if (next && ready.value) {
				event.preventDefault();
				move(next);
			}
		};

		const onWheel = (event: WheelEvent) => {
			if (ready.value) {
				move({zoom: crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)});
			}
		};

		const cancel = () => emit("cancel");

		const onEscape = (layer: string | null) => {
			if (layer === "avatar-crop") {
				cancel();
			}
		};

		eventbus.on("escapekey", onEscape);
		onUnmounted(() => {
			bitmap?.close();
			eventbus.off("escapekey", onEscape);
		});

		const confirm = async () => {
			if (!bitmap || busy.value) {
				return;
			}

			busy.value = true;
			const blob = await encodeAvatar(bitmap, width(), height(), crop);
			busy.value = false;

			if (!blob) {
				problem.value = t("avatar.encodeFailed");
				return;
			}

			emit("done", blob);
		};

		return {
			t,
			stage,
			zoom,
			ready,
			busy,
			problem,
			ZOOM_MAX,
			onPointerDown,
			onPointerMove,
			onPointerUp,
			onKey,
			onWheel,
			cancel,
			confirm,
		};
	},
});
</script>
