// The search panel beside the chat (Windows/SearchResults.vue, shown by
// RoutedChat on the /chan-:id/search route). Where the two do not fit side by
// side it takes the chat's place instead: over the whole screen in the phone
// layout, over the chat's own box (the sidebar left where it is) in a desktop
// window too narrow for both. Covering the chat, opening a hit tucks it away
// rather than closing it: the header's magnifier brings it back with its
// results, Cancel or Escape ends the search.
import {computed, onMounted, onUnmounted, ref, watch, type Ref} from "vue";
import {isPhoneLayout, PHONE_LAYOUT_QUERY} from "./helpers/device";

export const searchTucked = ref(false);

/** The phone layout, where the panel covers the chat instead of sitting beside it. */
export const phoneLayout = ref(isPhoneLayout());

/**
 * A desktop window with too little room beside the sidebar for search and a
 * readable chat: the panel covers the chat's box (SearchResults.vue measures
 * it, {@link searchFitsBeside} decides). False in the phone layout, which
 * covers the screen its own way.
 */
const searchCoversChat = ref(false);

/** The panel's width beside the chat, in rem, and its share of the window between. */
export const SEARCH_MIN_REM = 20;
export const SEARCH_MAX_REM = 30;
export const SEARCH_SHARE = 0.34;

/** The least chat worth keeping beside the panel, in rem. */
export const CHAT_MIN_REM = 15;

/** The panel's width beside the chat in a window `viewportPx` wide (its CSS flex-basis). */
export function searchBesideWidth(viewportPx: number, remPx: number): number {
	return Math.min(
		SEARCH_MAX_REM * remPx,
		Math.max(SEARCH_MIN_REM * remPx, SEARCH_SHARE * viewportPx)
	);
}

/**
 * Whether the panel goes beside the chat: `roomPx` is what the sidebar leaves
 * the two of them, `viewportPx` the window's width. Below that the panel
 * covers the chat rather than squeezing it, so nothing beside them (the
 * sidebar) ever gives way to it.
 */
export function searchFitsBeside(roomPx: number, viewportPx: number, remPx: number): boolean {
	return roomPx >= searchBesideWidth(viewportPx, remPx) + CHAT_MIN_REM * remPx;
}

/** Whether the panel takes the chat's place: the chat is not read meanwhile. */
export const searchCovers = computed(() => phoneLayout.value || searchCoversChat.value);

/**
 * What the sidebar leaves search and the chat, measured in either layout:
 * beside, the chat, the panel and the theme's gap between them (bourbaki's
 * #viewport gap); covering, the chat alone. The two agree, so the choice made
 * from it cannot flip back and forth.
 */
export function roomBesideSidebar(m: {
	chatPx: number;
	panelPx: number;
	gapPx: number;
	covering: boolean;
}): number {
	return m.covering ? m.chatPx : m.chatPx + m.panelPx + m.gapPx;
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
	window.matchMedia(PHONE_LAYOUT_QUERY).addEventListener("change", (event) => {
		phoneLayout.value = event.matches;
	});
}

/** The chat's box in #viewport's, in px: where a covering panel goes. */
export interface ChatBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Keep {@link searchCoversChat} true to the window while the panel is up, and
 * give the box it covers. What the sidebar leaves is measured, not worked out
 * from its width, so a theme's margin around it (ps on the Mac), the Mac
 * app's zoom of it and a width the user dragged all count. Beside the chat
 * that room is the chat and the panel; over it, the chat alone. Either way
 * it is the same number, so the choice cannot flip back and forth.
 */
export function useSearchFit(
	panel: Ref<HTMLElement | undefined>,
	probe: Ref<HTMLElement | undefined>
): Ref<ChatBox | null> {
	const box = ref<ChatBox | null>(null);
	let observer: ResizeObserver | null = null;
	let observedChat: Element | null = null;
	let frame = 0;

	const measure = () => {
		frame = 0;
		const viewport = document.getElementById("viewport");
		const chat = document.getElementById("chat-container");

		// Chat.vue's root can be a new element after a route change.
		if (observer && chat && chat !== observedChat) {
			if (observedChat) {
				observer.unobserve(observedChat);
			}

			observer.observe(chat);
			observedChat = chat;
		}

		// The phone layout covers the screen its own way, and a panel a hit
		// tucked away stays tucked until this has decided for the new layout.
		if (phoneLayout.value || !panel.value || !viewport || !chat) {
			searchCoversChat.value = false;
			box.value = null;
			return;
		}

		const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		const area = viewport.getBoundingClientRect();
		const own = chat.getBoundingClientRect();
		const panelPx = panel.value.getBoundingClientRect().width;
		const room = roomBesideSidebar({
			chatPx: own.width,
			panelPx,
			// A hidden panel (tucked) leaves no gap beside the chat.
			gapPx: panelPx > 0 ? parseFloat(getComputedStyle(viewport).columnGap) || 0 : 0,
			// What the page shows now, not what was last decided.
			covering: panel.value.classList.contains("covering"),
		});
		const covers = !searchFitsBeside(room, area.width, rem);

		searchCoversChat.value = covers;
		box.value = covers
			? {
					left: own.left - area.left,
					top: own.top - area.top,
					width: own.width,
					height: own.height,
			  }
			: null;

		// Beside the chat there is nothing to tuck behind.
		if (!covers) {
			searchTucked.value = false;
		}
	};

	// In the next frame, not inside the observer's callback: what it changes
	// resizes what it observes, which the browser would report as a loop.
	const schedule = () => {
		if (!frame) {
			frame = requestAnimationFrame(measure);
		}
	};

	onMounted(() => {
		observer = new ResizeObserver(schedule);

		// The probe is 1rem wide: a text size change moves the threshold even
		// where no box changes size (the sidebar closed, the panel covering).
		for (const el of [panel.value, probe.value, document.getElementById("viewport")]) {
			if (el) {
				observer.observe(el);
			}
		}

		measure();
	});

	// Into the phone layout the box goes at once, so the screen overlay's own
	// placement is not overridden for a frame. Out of it the panel counts as
	// covering until the next frame decides, so the chat it covered is not
	// marked read in between.
	watch(phoneLayout, (phone) => {
		box.value = null;
		searchCoversChat.value = !phone;
		schedule();
	});

	onUnmounted(() => {
		cancelAnimationFrame(frame);
		observer?.disconnect();
		searchCoversChat.value = false;
	});

	return box;
}
