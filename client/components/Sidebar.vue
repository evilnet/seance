<template>
	<aside id="sidebar" ref="sidebar">
		<div class="scrollable-area">
			<div class="logo-container">
				<img src="img/logo-tile.png" class="logo" :alt="appName" role="presentation" />
				<!-- The language selector's development-build entry point:
				     a popover holding the same LanguageSelect that Settings
				     -> Translation carries, reachable without leaving the
				     page. Production builds have the Settings one only. -->
				<span
					v-if="isDevelopment"
					class="tooltipped tooltipped-n tooltipped-no-touch"
					:aria-label="languageLabel"
				>
					<button
						class="locale-toggle"
						type="button"
						:aria-label="languageLabel"
						:aria-expanded="localeOpen"
						@click="toggleLocale"
					>
						🌐
					</button>
				</span>
				<span
					v-if="isDevelopment"
					:title="devBuildTitle"
					:style="{
						backgroundColor: '#ff9e18',
						color: '#000',
						padding: '2px',
						borderRadius: '4px',
						fontSize: '12px',
					}"
					>{{ t("sidebar.developerBadge") }}</span
				>
				<button
					v-if="isDevelopment"
					class="devtools-toggle"
					type="button"
					:title="devtoolsLabel"
					:aria-label="devtoolsLabel"
					@click="toggleDevtools"
				>
					🐞
				</button>
				<div
					v-if="isDevelopment && localeOpen"
					id="locale-popover"
					class="locale-popover"
					@keydown.esc="onLocaleKey"
				>
					<LanguageSelect
						:model-value="store.state.settings.locale"
						@change="onLocalePick"
					/>
				</div>
				<PresencePill />
			</div>
			<NetworkList />
		</div>
		<footer id="footer">
			<!-- `custom`: no <a> around the button, so the button is the one
			     control and carries the name (the tooltip span's aria-label is
			     only the tooltip's text). -->
			<span class="tooltipped tooltipped-n tooltipped-no-touch" :aria-label="settingsLabel"
				><router-link v-slot:default="{navigate, isActive}" to="/settings" custom>
					<button
						:class="['icon', 'settings', {active: isActive}]"
						role="tab"
						aria-controls="settings"
						:aria-label="settingsLabel"
						:aria-selected="isActive"
						@click="navigate"
					></button> </router-link
			></span>
			<span class="tooltipped tooltipped-n tooltipped-no-touch" :aria-label="helpLabel"
				><router-link v-slot:default="{navigate, isActive}" to="/help" custom>
					<button
						role="tab"
						aria-controls="help"
						:aria-label="helpLabel"
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
		<SidebarResizer />
	</aside>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, PropType, ref} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import NetworkList from "./NetworkList.vue";
import LanguageSelect from "./LanguageSelect.vue";
import eventbus from "../js/eventbus";
import PresencePill from "./PresencePill.vue";
import SidebarResizer from "./SidebarResizer.vue";
import {devtoolsAvailable, toggleDevtools} from "../js/devtools";

/** An open modal overlay (the oper cards, builder and dialog, the confirm
 * dialog, the upload preview…): they carry `.opened` while shown; the script
 * editor is mounted only while open, so its presence is enough. The
 * sidebar's own dimmer is not one; a swipe on it closes the sidebar. */
const OPEN_OVERLAY =
	'[id$="-overlay"].opened:not(#sidebar-overlay), #script-editor-overlay, #image-viewer.opened';

function inOpenOverlay(el: Element): boolean {
	return el.closest(OPEN_OVERLAY) !== null;
}

/** The panes the walk stops at: they scroll up and down (which computes
 * `overflow-x: auto` too), and one wide child must not take the swipe away
 * from the whole pane. */
const PANE = "#chat .chat, .window, #viewport";

/** `el` or the nearest ancestor inside its pane that scrolls sideways and has something to scroll. */
function sidewaysScroller(el: Element): Element | null {
	for (
		let node: Element | null = el;
		node && node !== document.body && !node.matches(PANE);
		node = node.parentElement
	) {
		if (node.scrollWidth > node.clientWidth + 1) {
			const overflowX = window.getComputedStyle(node).overflowX;

			if (overflowX === "auto" || overflowX === "scroll") {
				return node;
			}
		}
	}

	return null;
}

/**
 * Whether a swipe starting on `el` is the scroll of a sideways scroller
 * under it: only when that scroller can still move the way the swipe goes —
 * right to open (it is scrolled away from its start), left to close (it is
 * short of its end). One resting at its start gives an opening swipe nothing.
 * Right to left, the start is the right edge and `scrollLeft` runs from 0
 * down to minus the overflow, so the two directions swap. On a right-to-left
 * page the sidebar docks at the right edge, so opening it is a swipe to the
 * left and the directions swap once more.
 */
function scrollerTakesSwipe(el: Element, opening: boolean): boolean {
	const scroller = sidewaysScroller(el);

	if (!scroller) {
		return false;
	}

	const rtl = window.getComputedStyle(scroller).direction === "rtl";
	const fromStart = Math.abs(scroller.scrollLeft);
	const rightward = opening !== (document.documentElement.dir === "rtl");
	const towardStart = rightward !== rtl;

	return towardStart
		? fromStart > 0
		: fromStart < scroller.scrollWidth - scroller.clientWidth - 1;
}

export default defineComponent({
	name: "Sidebar",
	components: {
		NetworkList,
		LanguageSelect,
		PresencePill,
		SidebarResizer,
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

		/**
		 * Which way the pane slides: the sidebar docks at the inline-start
		 * edge, which is the left one in LTR and the right one in RTL. -1 in
		 * RTL maps inline progress to and from screen coordinates.
		 */
		const slideDir = () => (document.documentElement.dir === "rtl" ? -1 : 1);

		/** Owns the <body> listeners of the drag in flight. */
		let drag: AbortController | undefined;
		/** Where the drag in flight started, for the sideways-scroller check. */
		let dragTarget: Element | null = null;

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

			const dirFactor = slideDir();

			// distX is drag progress in the inline direction (positive = the
			// pane is being revealed); the angle check below only compares
			// magnitudes, so the sign flip does not move its threshold.
			let distX = dirFactor * (touch.screenX - touchStartPos.value.screenX);
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
					// A sideways swipe in something that scrolls sideways (an
					// oper report's table, its raw lines, a code block) is that
					// scroll. Asked here, once the gesture is known to be
					// horizontal, not on every touchstart: the walk reads layout.
					if (dragTarget && scrollerTakesSwipe(dragTarget, !store.state.sidebarOpen)) {
						// eslint-disable-next-line no-use-before-define
						endDrag(false);
						return;
					}

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

			// The pane's rest position is the slid-away transform, so the drag
			// runs from `-menuWidth` (hidden) to 0 (shown), mirrored by the
			// direction factor; the class state takes over on release.
			if (sidebar.value) {
				sidebar.value.style.transform =
					"translate3d(" +
					(dirFactor * (distX - menuWidth.value)).toString() +
					"px, 0, 0)";
			}

			if (props.overlay) {
				props.overlay.style.opacity = `${distX / menuWidth.value}`;
			}
		};

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
					// Positive inline progress opens the pane: a rightward
					// swipe in LTR, a leftward one in RTL.
					toggle(diff * slideDir() > 0);
				}
			}

			drag?.abort();
			drag = undefined;
			dragTarget = null;

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

			// A second finger (a pinch, a two-finger swipe) cancels a drag in
			// flight, wherever it lands: nothing toggles.
			if (e.touches.length !== 1) {
				endDrag(false);
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

			// Nothing behind an open dialog or card is the sidebar's to move.
			if (target instanceof Element && inOpenOverlay(target)) {
				return;
			}

			dragTarget = target instanceof Element ? target : null;
			touchStartPos.value = touchCurPos.value = e.touches.item(0);

			const styles = window.getComputedStyle(sidebar.value);

			menuWidth.value = parseFloat(styles.width);
			menuIsAbsolute.value = styles.position === "absolute";

			// The drag engages anywhere except the pane's own docked strip:
			// measured from the start edge, which is the left one in LTR and
			// the right one in RTL. (Distance 0 at the docked edge counts as
			// no gesture, mirroring the old screenX 0 check.)
			const rtl = document.documentElement.dir === "rtl";
			const dockX = touchStartPos.value
				? rtl
					? window.innerWidth - touchStartPos.value.screenX
					: touchStartPos.value.screenX
				: 0;

			if (!store.state.sidebarOpen || (dockX && dockX > menuWidth.value)) {
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

		// Footer and dev-mode labels, reactive on a locale change.
		const {t} = useI18n();
		const settingsLabel = computed(() => t("sidebar.settings"));
		const helpLabel = computed(() =>
			store.state.serverConfiguration?.isUpdateAvailable
				? t("sidebar.helpUpdate")
				: t("sidebar.help")
		);
		const devtoolsLabel = computed(() => t("sidebar.toggleDevtools"));
		const devBuildTitle = computed(() => t("sidebar.devBuildTitle", {app: appName.value}));

		// The globe beside the logo: the most primitive language access —
		// no settings navigation, works on the connect form and over a dead
		// network alike. The panel reuses LanguageSelect (the same list the
		// connect form and Appearance render); a pick applies at once and
		// closes the panel. Escape and a click outside close it.
		const localeOpen = ref(false);
		const languageLabel = computed(() => t("sidebar.language"));

		const closeLocale = () => {
			localeOpen.value = false;
		};

		const toggleLocale = () => {
			localeOpen.value = !localeOpen.value;

			if (localeOpen.value) {
				void nextTick(() => {
					(
						document
							.getElementById("locale-popover")
							?.querySelector("select") as HTMLSelectElement | null
					)?.focus();
				});
			}
		};

		const onLocalePick = (tag: string) => {
			void store.dispatch("settings/update", {name: "locale", value: tag});
			closeLocale();
		};

		// Escape with the focus inside the panel: keybinds.ts deliberately
		// ignores Escape inside form fields, so the panel listens for its
		// own (the select bubbles the keydown up here).
		const onLocaleKey = () => {
			closeLocale();
		};

		onMounted(() => eventbus.on("escapekey", closeLocale));
		onUnmounted(() => eventbus.off("escapekey", closeLocale));

		return {
			appName,
			isDevelopment,
			toggleDevtools,
			t,
			settingsLabel,
			helpLabel,
			devtoolsLabel,
			devBuildTitle,
			localeOpen,
			languageLabel,
			toggleLocale,
			onLocalePick,
			onLocaleKey,
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
