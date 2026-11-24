<template>
	<!-- The reply mark: a line down from the message above and across into
	     this one, the way a tree of replies is drawn (the user's pick,
	     2026-11-24, over the ↩ character). 1em square in the text's colour,
	     so it follows the font size and the theme; style.css mirrors it in a
	     right-to-left interface. Decoration: the button around it carries the
	     words. -->
	<svg
		class="reply-elbow"
		viewBox="0 0 16 16"
		width="1em"
		height="1em"
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M3 2v6.5a2 2 0 0 0 2 2h8" />
		<path d="M10.5 8l2.5 2.5-2.5 2.5" />
	</svg>
</template>

<script lang="ts">
import {defineComponent} from "vue";

export default defineComponent({
	name: "ReplyElbow",
});
</script>
