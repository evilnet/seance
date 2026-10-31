/**
 * The script editor's code field (Settings/ScriptEdit.vue): CodeMirror 6
 * with the Lua mode, line numbers, undo history and bracket matching. Its
 * tokens carry the same `tok-*` classes Prism gives a code block in chat, so
 * every theme's `--tok-*` palette colours both alike. Loaded on demand as its
 * own chunk (`js/code-editor.js`) through `loadLuaEditor()` in ScriptEdit.vue:
 * nothing of CodeMirror is fetched until a script is opened.
 */

import {EditorState} from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	placeholder,
} from "@codemirror/view";
import {
	bracketMatching,
	indentOnInput,
	indentUnit,
	StreamLanguage,
	syntaxHighlighting,
} from "@codemirror/language";
import {defaultKeymap, history, historyKeymap, indentMore} from "@codemirror/commands";
import {lua} from "@codemirror/legacy-modes/mode/lua";
import {tagHighlighter, tags} from "@lezer/highlight";

export interface LuaEditorOptions {
	parent: HTMLElement;
	doc: string;
	/** Edits that would make the code longer than this are refused. */
	maxLength: number;
	/** Attributes for the editable element (aria-label, aria-describedby). */
	attributes: Record<string, string>;
	onChange(doc: string): void;
	/** The editor lost the caret: the edit is committed. */
	onBlur(): void;
}

export interface LuaEditor {
	destroy(): void;
}

const INDENT = "    ";

// The Lua mode names keywords, strings, comments, numbers and the standard
// library's globals (`print`, `string`, …); the rest is plain text.
const highlighter = tagHighlighter([
	{tag: tags.keyword, class: "tok-keyword"},
	{tag: tags.string, class: "tok-string"},
	{tag: tags.comment, class: "tok-comment"},
	{tag: tags.number, class: "tok-number"},
	{tag: tags.standard(tags.variableName), class: "tok-function"},
]);

// Colours from the theme's tokens, so the editor follows it light or dark.
const theme = EditorView.theme({
	"&": {
		height: "100%",
		color: "var(--md-code-color)",
		backgroundColor: "transparent",
		fontSize: "0.875rem",
	},
	"&.cm-focused": {
		outline: "none",
	},
	".cm-scroller": {
		fontFamily:
			'Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New", monospace',
		lineHeight: "1.45",
	},
	".cm-content": {
		padding: "0.5rem 0",
		caretColor: "var(--body-color)",
	},
	".cm-line": {
		padding: "0 0.5rem",
	},
	".cm-cursor, .cm-dropCursor": {
		borderLeftColor: "var(--body-color)",
	},
	".cm-gutters": {
		backgroundColor: "rgb(128 128 128 / 8%)",
		color: "var(--body-color-muted)",
		border: "none",
	},
	".cm-lineNumbers .cm-gutterElement": {
		padding: "0 0.5rem 0 0.75rem",
	},
	// The caret's line, only while the caret is here.
	".cm-activeLine, .cm-activeLineGutter": {
		backgroundColor: "transparent",
	},
	"&.cm-focused .cm-activeLine, &.cm-focused .cm-activeLineGutter": {
		backgroundColor: "rgb(128 128 128 / 8%)",
	},
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
		{
			backgroundColor: "rgb(128 128 128 / 30%)",
		},
	".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
		backgroundColor: "rgb(128 128 128 / 25%)",
		outline: "1px solid rgb(128 128 128 / 50%)",
	},
	".cm-placeholder": {
		color: "var(--body-color-muted)",
	},
});

// Tab indents: four spaces at the caret, or the selected lines. Shift+Tab
// is left to the browser, so it leaves the field and the keyboard is never
// trapped in it.
function tabIndent(view: EditorView): boolean {
	if (view.state.selection.ranges.some((range) => !range.empty)) {
		return indentMore(view);
	}

	view.dispatch({
		...view.state.replaceSelection(INDENT),
		scrollIntoView: true,
		userEvent: "input",
	});
	return true;
}

export function createLuaEditor(options: LuaEditorOptions): LuaEditor {
	const view = new EditorView({
		parent: options.parent,
		state: EditorState.create({
			doc: options.doc,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				drawSelection(),
				history(),
				indentOnInput(),
				bracketMatching(),
				indentUnit.of(INDENT),
				StreamLanguage.define(lua),
				syntaxHighlighting(highlighter),
				placeholder("-- Write your Lua code here"),
				keymap.of([{key: "Tab", run: tabIndent}, ...defaultKeymap, ...historyKeymap]),
				EditorState.changeFilter.of((tr) => tr.newDoc.length <= options.maxLength),
				EditorView.contentAttributes.of({
					spellcheck: "false",
					autocapitalize: "off",
					autocorrect: "off",
					...options.attributes,
				}),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						options.onChange(update.state.doc.toString());
					}

					if (update.focusChanged && !update.view.hasFocus) {
						options.onBlur();
					}
				}),
				theme,
			],
		}),
	});

	return {
		destroy: () => view.destroy(),
	};
}
