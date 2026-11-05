// The search panel beside the chat (Windows/SearchResults.vue, shown by
// RoutedChat on the /chan-:id/search route). On a phone it covers the chat, so
// opening a hit tucks it away rather than closing it: the header's magnifier
// brings it back with its results, Cancel or Escape ends the search.
import {ref} from "vue";

export const searchTucked = ref(false);
