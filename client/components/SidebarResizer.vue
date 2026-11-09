<template>
	<div
		class="sidebar-resizer"
		role="separator"
		aria-orientation="vertical"
		tabindex="0"
		:aria-label="label"
		:title="label"
		@pointerdown="onPointerDown"
		@dblclick="resetSidebarWidth"
		@keydown="onKeydown"
	/>
</template>

<script lang="ts">
// The sidebar's edge beside the chat: drag it to make the sidebar narrower or
// wider, double-click it for the default width, or focus it and use the
// arrow keys (sidebarWidth.ts). Hidden on the phone layout, whose sidebar is
// a drawer.
import {computed, defineComponent} from "vue";
import {useI18n} from "../js/i18n";
import {resetSidebarWidth, setSidebarPx} from "../js/sidebarWidth";

export default defineComponent({
	name: "SidebarResizer",
	setup() {
		const {t} = useI18n();
		const label = computed(() => t("sidebar.resize"));

		const sidebar = (el: Element) => el.closest<HTMLElement>("#sidebar");

		/** The pointer's distance from the sidebar's start edge, in either direction of text. */
		const widthAt = (bar: HTMLElement, clientX: number) => {
			const rect = bar.getBoundingClientRect();
			const rtl = getComputedStyle(bar).direction === "rtl";
			return rtl ? rect.right - clientX : clientX - rect.left;
		};

		const onPointerDown = (e: PointerEvent) => {
			const handle = e.currentTarget as HTMLElement;
			const bar = sidebar(handle);

			if (!bar || e.button !== 0) {
				return;
			}

			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			document.documentElement.classList.add("sidebar-resizing");

			const move = (ev: PointerEvent) => setSidebarPx(widthAt(bar, ev.clientX), false);
			const end = (ev: PointerEvent) => {
				setSidebarPx(widthAt(bar, ev.clientX));
				document.documentElement.classList.remove("sidebar-resizing");
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", end);
				handle.removeEventListener("pointercancel", end);
			};

			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		};

		const onKeydown = (e: KeyboardEvent) => {
			const bar = sidebar(e.currentTarget as HTMLElement);

			if (!bar || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) {
				return;
			}

			e.preventDefault();
			const rtl = getComputedStyle(bar).direction === "rtl";
			const wider = (e.key === "ArrowRight") !== rtl;
			const step = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			setSidebarPx(bar.getBoundingClientRect().width + (wider ? step : -step));
		};

		return {label, onPointerDown, onKeydown, resetSidebarWidth};
	},
});
</script>
