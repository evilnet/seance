<template>
	<aside id="sidebar" ref="sidebar">
		<div class="scrollable-area">
			<div class="logo-container">
				<img src="img/logo-tile.png" class="logo" :alt="appName" role="presentation" />
				<span
					v-if="isDevelopment"
					:title="`${appName} has been built in development mode`"
					:style="{
						backgroundColor: '#ff9e18',
						color: '#000',
						padding: '2px',
						borderRadius: '4px',
						fontSize: '12px',
					}"
					>DEVELOPER</span
				>
				<button
					v-if="isDevelopment"
					class="devtools-toggle"
					type="button"
					title="Toggle eruda devtools"
					aria-label="Toggle eruda devtools"
					@click="toggleDevtools"
				>
					🐞
				</button>
			</div>
			<NetworkList />
		</div>
		<footer id="footer">
			<!-- `custom`: no <a> around the button, so the button is the one
			     control and carries the name (the tooltip span's aria-label is
			     only the tooltip's text). -->
			<span class="tooltipped tooltipped-n tooltipped-no-touch" aria-label="Settings"
				><router-link v-slot:default="{navigate, isActive}" to="/settings" custom>
					<button
						:class="['icon', 'settings', {active: isActive}]"
						role="tab"
						aria-controls="settings"
						aria-label="Settings"
						:aria-selected="isActive"
						@click="navigate"
					></button> </router-link
			></span>
			<span
				class="tooltipped tooltipped-n tooltipped-no-touch"
				:aria-label="
					store.state.serverConfiguration?.isUpdateAvailable
						? 'Help\n(update available)'
						: 'Help'
				"
				><router-link v-slot:default="{navigate, isActive}" to="/help" custom>
					<button
						role="tab"
						aria-controls="help"
						:aria-label="
							store.state.serverConfiguration?.isUpdateAvailable
								? 'Help, update available'
								: 'Help'
						"
						:aria-selected="route.name === 'Help'"
						:class="[
							'icon',
							'help',
							{notified: store.state.serverConfiguration?.isUpdateAvailable},
							{active: isActive},
						]"
						@click="navigate"
					></button> </router-link
			></span>
		</footer>
	</aside>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, PropType, ref} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../js/store";
import NetworkList from "./NetworkList.vue";
import {devtoolsAvailable, toggleDevtools} from "../js/devtools";

export default defineComponent({
	name: "Sidebar",
	components: {
		NetworkList,
	},
	props: {
		overlay: {type: Object as PropType<HTMLElement | null>, required: true},
	},
	setup(props) {
		const isDevelopment = devtoolsAvailable;

		const store = useStore();
		const route = useRoute();

		const touchStartPos = ref<Touch | null>();
		const touchCurPos = ref<Touch | null>();
		const touchStartTime = ref<number>(0);
		const menuWidth = ref<number>(0);
		const menuIsMoving = ref<boolean>(false);
		const menuIsAbsolute = ref<boolean>(false);

		const sidebar = ref<HTMLElement | null>(null);

		const toggle = (state: boolean) => {
			store.commit("sidebarOpen", state);
		};

		const onTouchMove = (e: TouchEvent) => {
			const touch = (touchCurPos.value = e.touches.item(0));

			if (
				!touch ||
				!touchStartPos.value ||
				!touchStartPos.value.screenX ||
				!touchStartPos.value.screenY
			) {
				return;
			}

			let distX = touch.screenX - touchStartPos.value.screenX;
			const distY = touch.screenY - touchStartPos.value.screenY;

			if (!menuIsMoving.value) {
				// tan(45°) is 1. Gestures in 0°-45° (< 1) are considered horizontal, so
				// menu must be open; gestures in 45°-90° (>1) are considered vertical, so
				// chat windows must be scrolled.
				if (Math.abs(distY / distX) >= 1) {
					// eslint-disable-next-line no-use-before-define
					onTouchEnd();
					return;
				}

				const devicePixelRatio = window.devicePixelRatio || 2;

				if (Math.abs(distX) > devicePixelRatio) {
					store.commit("sidebarDragging", true);
					menuIsMoving.value = true;
				}
			}

			// Do not animate the menu on desktop view
			if (!menuIsAbsolute.value) {
				return;
			}

			if (store.state.sidebarOpen) {
				distX += menuWidth.value;
			}

			if (distX > menuWidth.value) {
				distX = menuWidth.value;
			} else if (distX < 0) {
				distX = 0;
			}

			if (sidebar.value) {
				sidebar.value.style.transform = "translate3d(" + distX.toString() + "px, 0, 0)";
			}

			if (props.overlay) {
				props.overlay.style.opacity = `${distX / menuWidth.value}`;
			}
		};

		/** Owns the <body> listeners of the drag in flight. */
		let drag: AbortController | undefined;

		/**
		 * End the drag and put everything back. `settled` is false when the
		 * system took the touches (`touchcancel`): no toggle for a gesture
		 * that went to iOS's own edge swipe.
		 */
		const endDrag = (settled: boolean) => {
			const start = touchStartPos.value;
			const current = touchCurPos.value;

			// A null check, not a falsy one: `screenX` is 0 at the left edge,
			// which is exactly where the gesture that opens the pane begins.
			if (settled && start && current) {
				const diff = current.screenX - start.screenX;
				const absDiff = Math.abs(diff);

				if (
					absDiff > menuWidth.value / 2 ||
					(Date.now() - touchStartTime.value < 180 && absDiff > 50)
				) {
					toggle(diff > 0);
				}
			}

			drag?.abort();
			drag = undefined;

			store.commit("sidebarDragging", false);

			touchStartPos.value = null;
			touchCurPos.value = null;
			touchStartTime.value = 0;
			menuIsMoving.value = false;

			void nextTick(() => {
				if (sidebar.value) {
					sidebar.value.style.transform = "";
				}

				if (props.overlay) {
					props.overlay.style.opacity = "";
				}
			});
		};

		const onTouchEnd = () => endDrag(true);

		// iOS reports a touch its own edge gesture took with `touchcancel`. (A
		// left-edge swipe gets a plain `touchend` instead; router.ts keeps the
		// history one deep so that gesture has nowhere to go.)
		const onTouchCancel = () => endDrag(false);

		const onTouchStart = (e: TouchEvent) => {
			if (!sidebar.value) {
				return;
			}

			// Dragging a selection handle is a horizontal drag too; the swipe
			// stands down while there is a selection to protect (a tap
			// collapses it).
			const selection = window.getSelection();

			if (selection && !selection.isCollapsed) {
				return;
			}

			// A field's own selection is not in `getSelection()` (WebKit reports
			// it collapsed), and the composer sits where the pane comes in from:
			// no swipe starts inside a text field.
			const target = e.target;

			if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) {
				return;
			}

			touchStartPos.value = touchCurPos.value = e.touches.item(0);

			if (e.touches.length !== 1) {
				onTouchEnd();
				return;
			}

			const styles = window.getComputedStyle(sidebar.value);

			menuWidth.value = parseFloat(styles.width);
			menuIsAbsolute.value = styles.position === "absolute";

			if (
				!store.state.sidebarOpen ||
				(touchStartPos.value?.screenX && touchStartPos.value.screenX > menuWidth.value)
			) {
				touchStartTime.value = Date.now();
				drag = new AbortController();

				const options = {passive: true, signal: drag.signal};

				document.body.addEventListener("touchmove", onTouchMove, options);
				document.body.addEventListener("touchend", onTouchEnd, options);
				document.body.addEventListener("touchcancel", onTouchCancel, options);
			}
		};

		onMounted(() => {
			document.body.addEventListener("touchstart", onTouchStart, {passive: true});
		});

		onUnmounted(() => {
			document.body.removeEventListener("touchstart", onTouchStart);
			drag?.abort(); // a drag in flight must not leave listeners on <body>
		});

		const appName = computed(() => store.state.branding.appName);

		return {
			appName,
			isDevelopment,
			toggleDevtools,
			store,
			route,
			sidebar,
			toggle,
			onTouchStart,
			onTouchMove,
			onTouchEnd,
		};
	},
});
</script>
