<template>
	<div
		class="sidebar-resizer"
		role="separator"
		aria-orientation="vertical"
		tabindex="0"
		:aria-label="label"
		:aria-valuenow="valueNow"
		:aria-valuemin="MIN_REM"
		:aria-valuemax="MAX_REM"
		:title="hint"
		@pointerdown="onPointerDown"
		@dblclick="onReset"
		@keydown="onKeydown"
	/>
</template>

<script lang="ts">
// The sidebar's edge beside the chat: drag it to make the sidebar narrower or
// wider, double-click it for the default width, or focus it and use the
// arrow keys (sidebarWidth.ts). Hidden on the phone layout, whose sidebar is
// a drawer.
import {computed, defineComponent, ref} from "vue";
import {useI18n} from "../js/i18n";
import {
	MAX_REM,
	MIN_REM,
	resetSidebarWidth,
	restoreSidebarWidth,
	rootPx,
	setSidebarPx,
	storedSidebarRem,
} from "../js/sidebarWidth";

export default defineComponent({
	name: "SidebarResizer",
	setup() {
		const {t} = useI18n();
		const label = computed(() => t("sidebar.resize"));
		const hint = computed(() => t("sidebar.resizeHint"));
		/** The width in rem, for assistive tech; the default's own when nothing is saved. */
		const width = ref<number | null>(storedSidebarRem());
		// style.css's default, 7rem + 108px, in rem at the root size now.
		const valueNow = computed(() => Math.round(width.value ?? 7 + 108 / rootPx()));

		const sidebar = (el: Element) => el.closest<HTMLElement>("#sidebar");
		const isRtl = (el: Element) => getComputedStyle(el).direction === "rtl";

		/** The drag in progress: one pointer at a time. */
		let drag: {id: number; startX: number; startWidth: number; moved: boolean} | null = null;

		const onPointerDown = (e: PointerEvent) => {
			const handle = e.currentTarget as HTMLElement;
			const bar = sidebar(handle);

			if (!bar || e.button !== 0 || drag) {
				return;
			}

			e.preventDefault();
			drag = {
				id: e.pointerId,
				startX: e.clientX,
				startWidth: bar.getBoundingClientRect().width,
				moved: false,
			};
			const rtl = isRtl(bar);
			handle.setPointerCapture(e.pointerId);
			document.documentElement.classList.add("sidebar-resizing");

			// The width the pointer has moved it to, the grab point kept.
			const widthAt = (x: number) =>
				drag!.startWidth + (rtl ? drag!.startX - x : x - drag!.startX);

			const move = (ev: PointerEvent) => {
				if (ev.pointerId !== drag?.id) {
					return;
				}

				if (Math.abs(ev.clientX - drag.startX) >= 2) {
					drag.moved = true;
				}

				if (drag.moved) {
					setSidebarPx(widthAt(ev.clientX), false);
				}
			};
			const up = (ev: PointerEvent) => {
				if (ev.pointerId !== drag?.id) {
					return;
				}

				// A click without a move changes nothing (a double-click's first half too).
				if (drag.moved) {
					width.value = setSidebarPx(widthAt(ev.clientX));
				}

				drag = null;
				handle.releasePointerCapture(ev.pointerId);
			};
			// Cancelled (the system took the pointer) or capture lost: the
			// width goes back to what it was, unsaved.
			const lost = (ev: PointerEvent) => {
				if (ev.pointerId !== e.pointerId) {
					return;
				}

				if (drag) {
					restoreSidebarWidth();
					drag = null;
				}

				document.documentElement.classList.remove("sidebar-resizing");
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.removeEventListener("pointercancel", lost);
				handle.removeEventListener("lostpointercapture", lost);
			};

			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
			handle.addEventListener("pointercancel", lost);
			handle.addEventListener("lostpointercapture", lost);
		};

		const onReset = () => {
			resetSidebarWidth();
			width.value = null;
		};

		const onKeydown = (e: KeyboardEvent) => {
			const bar = sidebar(e.currentTarget as HTMLElement);

			if (!bar || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) {
				return;
			}

			e.preventDefault();
			const wider = (e.key === "ArrowRight") !== isRtl(bar);
			const step = rootPx();
			width.value = setSidebarPx(bar.getBoundingClientRect().width + (wider ? step : -step));
		};

		return {label, hint, valueNow, MIN_REM, MAX_REM, onPointerDown, onReset, onKeydown};
	},
});
</script>
