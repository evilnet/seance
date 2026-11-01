<script lang="ts">
import {computed, defineComponent, h, nextTick, ref, VNode, watch} from "vue";
import {useI18n} from "../js/i18n";
import {excerptRange, MIN_GUESS_LINES, splitLines} from "../js/helpers/ircmessageparser/codeLines";
import type {Highlighted} from "../js/helpers/ircmessageparser/highlighter";

// One row per line, so the gutter can count them in CSS and a copy of the
// block yields only the code. Highlighting arrives late or not at all: the
// highlighter, the grammar and the language guesser are all webpack chunks, and
// an installed app offline has none of them (the service worker precaches the
// shell, not these). Until then — and forever, for a language nobody named and
// nothing recognised — the block is plain monospace text.
export default defineComponent({
	name: "CodeBlock",
	props: {
		code: {type: String, required: true},
		lang: {type: String, default: undefined},
		// The name a `lang:file` fence tag carried: what the label shows
		file: {type: String, default: undefined},
	},
	setup(props) {
		const {t, tCount} = useI18n();
		// The Prism id the block is being shown as, set only once it really is
		const id = ref<string | undefined>(undefined);
		const tokens = ref<Highlighted | undefined>(undefined);
		const plain = computed(() => splitLines(props.code));
		// What the block is shown as: a `lang:file` tag's file, else the
		// highlighter's id for the language — the tag as typed until the tokens
		// land (`js` becomes `javascript`), the guesser's answer only once there
		// is one. It rides the block as `data-lang`, which the stylesheet shows
		// in the corner.
		const label = computed(() => props.file ?? id.value ?? props.lang);
		// Both from the plain text, never from the tokens: the gutter must not
		// jitter when highlighting lands.
		const numbered = computed(() => plain.value.length >= 2);
		const gutter = computed(() => `${String(plain.value.length).length}ch`);
		const lines = computed<Highlighted>(
			() => tokens.value ?? plain.value.map((text) => (text ? [{text}] : []))
		);

		// A long block shows its first lines and a toggle. The cut is decided
		// from the plain text, like the gutter, so it does not move when the
		// tokens land; the slice is the last thing that happens, so the
		// highlighter still sees — and highlights — the whole code once.
		// `slice(0, undefined)` is the whole array, which is exactly what an
		// expanded block, or one that shrank under the threshold, wants.
		const cut = computed(() => excerptRange(plain.value.length));
		const expanded = ref(false);
		const shown = computed<Highlighted>(() =>
			expanded.value ? lines.value : lines.value.slice(0, cut.value)
		);
		// The block's own element, for the scroll bookkeeping below
		const block = ref<HTMLElement | null>(null);

		// Flipping the block changes the height of something in the middle of
		// the timeline, so the scroll position is restored around it. Two
		// cases: a reader who was at the bottom of the channel stays at the
		// bottom (new messages keep arriving there), and anyone else keeps the
		// block's top edge exactly where it was on screen.
		async function toggle() {
			const el = block.value;
			// Both `.chat` elements in the app — `MessageList`'s and the one
			// `Chat.vue` renders for a special window — are the scroller.
			const scroller = el?.closest(".chat") as HTMLElement | null | undefined;
			// `MessageList`'s own `handleScroll` formula, verbatim: the two
			// have to agree, or this and `channel.scrolledToBottom` disagree
			// about the same scroller.
			const atBottom =
				!!scroller &&
				scroller.scrollHeight - scroller.scrollTop - scroller.offsetHeight <= 30;
			const top = el ? el.getBoundingClientRect().top : 0;

			expanded.value = !expanded.value;

			await nextTick();

			if (!scroller || !el) {
				return;
			}

			if (atBottom) {
				scroller.scrollTop = scroller.scrollHeight;
				return;
			}

			// `scrollTop` is read now and not before the flip: the browser's
			// own scroll anchoring may already have moved it, and a stale
			// reading would undo what it did.
			scroller.scrollTop += el.getBoundingClientRect().top - top;
		}

		// An edit replaces the text under the same component instance, so this
		// is a watch and not `onMounted`: the tokens of the text before it must
		// not stay on screen. `resolve` awaits chunk fetches, so a run that
		// started for text that is gone drops what it found.
		let generation = 0;

		watch(
			[() => props.code, () => props.lang],
			() => {
				generation += 1;
				tokens.value = undefined;
				id.value = undefined;

				// A tagless one-liner is never guessed: nothing to fetch
				if (props.lang || plain.value.length >= MIN_GUESS_LINES) {
					void resolve(generation);
				}
			},
			{immediate: true}
		);

		// Nothing in here is worth a broken render, and nobody awaits the
		// promise, so the whole body is guarded: offline, a chunk that is gone,
		// a grammar that throws — the block simply stays plain.
		async function resolve(mine: number) {
			const code = props.code;

			try {
				const highlighter = await import(
					/* webpackChunkName: "highlighter" */ "../js/helpers/ircmessageparser/highlighter"
				);

				// A tag is taken at its word; only an untagged block is guessed
				const lang = props.lang
					? highlighter.normalizeLang(props.lang)
					: await highlighter.guessLanguage(code);

				if (!lang || mine !== generation) {
					return;
				}

				if (!(await highlighter.ensureLanguage(lang)) || mine !== generation) {
					return;
				}

				const highlighted = highlighter.highlight(code, lang);

				if (!highlighted) {
					return;
				}

				tokens.value = highlighted;
				// `data-lang` is what the block is shown as, so it goes up with
				// the tokens and not before them
				id.value = lang;
			} catch {
				// The block stays plain
			}
		}

		return () => {
			const rows: VNode[] = shown.value.map((line) =>
				h(
					"span",
					{class: ["md-line"]},
					line.map((token): VNode | string =>
						token.type
							? h("span", {class: ["tok-" + token.type]}, token.text)
							: token.text
					)
				)
			);

			// The caption — the file a `lang:file` tag named, else the language,
			// once it is known — is the block's own first child: a bar of its own
			// above the rows, in the message's typeface and a muted size, so it
			// reads as a label and never as an empty first line of code.
			if (label.value !== undefined) {
				rows.unshift(h("span", {class: ["md-code-head"]}, label.value));
			}

			if (cut.value !== undefined) {
				rows.push(
					h(
						"button",
						{
							type: "button",
							class: ["md-code-toggle"],
							"aria-expanded": expanded.value ? "true" : "false",
							onClick: toggle,
						},
						expanded.value
							? t("code.showLess")
							: tCount("code.showAllLines", plain.value.length)
					)
				);
			}

			return h(
				"code",
				{
					ref: block,
					class: [
						"md-code-block",
						numbered.value ? "md-code-block--numbered" : undefined,
					],
					style: numbered.value ? {"--md-gutter": gutter.value} : undefined,
					"data-lang": label.value,
				},
				rows
			);
		};
	},
});
</script>
