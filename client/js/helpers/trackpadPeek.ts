// Messenger's times by trackpad: a two-finger swipe over the conversation
// toward the pane's start slides it aside and shows every row's time, as
// the finger's swipe does on a phone and as Messages does on a Mac
// (trackpadSwipe.ts reads the wheel, MessageList.vue draws it, style.css
// § By finger and trackpad). The swipe's travel in CSS px, 0 when there is
// none.
import {ref} from "vue";

export const trackpadPeek = ref(0);
