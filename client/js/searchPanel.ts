// The search panel beside the chat (Windows/SearchResults.vue, shown by
// RoutedChat on the /chan-:id/search route). On a phone it covers the chat, so
// opening a hit tucks it away rather than closing it: the header's magnifier
// brings it back with its results, Cancel or Escape ends the search.
import {ref} from "vue";
import {isPhoneLayout, PHONE_LAYOUT_QUERY} from "./helpers/device";

export const searchTucked = ref(false);

/** The phone layout, where the panel covers the chat instead of sitting beside it. */
export const phoneLayout = ref(isPhoneLayout());

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
	window.matchMedia(PHONE_LAYOUT_QUERY).addEventListener("change", (event) => {
		phoneLayout.value = event.matches;

		// Beside the chat there is nothing to tuck behind.
		if (!event.matches) {
			searchTucked.value = false;
		}
	});
}
