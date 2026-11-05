<script lang="ts">
// A translated sentence with elements inside it: `text` is the frame (a t()
// result that KEEPs the named placeholders) and each {name} in it is
// rendered by the slot of that name, wherever the translation puts it. One
// whole phrase per key, so a translator orders the sentence -- "{target} は
// {nick} にキックされました" -- and the elements follow:
//
//   <I18nFrame :text="t('system.kick', {nick: KEEP, target: KEEP})">
//     <template v-slot:nick><Username :user="message.from" /></template>
//     <template v-slot:target><Username :user="message.target" /></template>
//   </I18nFrame>
//
// Renders no element of its own. A placeholder without a slot stays text.
import {defineComponent, Fragment, h} from "vue";
import {framePieces} from "../js/i18n/core";

export default defineComponent({
	name: "I18nFrame",
	props: {
		text: {
			type: String,
			required: true,
		},
	},
	setup(props, {slots}) {
		return () =>
			h(
				Fragment,
				framePieces(props.text, Object.keys(slots)).map((piece) =>
					typeof piece === "string" ? piece : h(Fragment, slots[piece.name]?.() ?? [])
				)
			);
	},
});
</script>
