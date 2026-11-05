import {expect} from "chai";
import fs from "fs";
import path from "path";

// Whatever covers the screen carries `.screen-overlay`, and one rule in
// style.css keeps it clear of the native shell's status bar, notch and
// navigation bar. Without the class a new modal's title and ✕ sit under the
// clock: every modal used to join a list of ids, and every new one was left
// out. A component that opens a dialog, an overlay or a sheet on <body> must
// carry the class, or say here why it keeps clear of the bars by itself.
describe("overlays carry .screen-overlay", function () {
	const components = path.join(process.cwd(), "client", "components");

	const exempt: Record<string, string> = {
		// Fixed over the whole screen on purpose (the image runs under the
		// bars); its controls take the insets themselves in style.css.
		"ImageViewer.vue": "controls inset in style.css",
		// A popover at its anchor; its phone sheet has its own inset rule
		// (`html[data-shell="native"] .reaction-picker.sheet`).
		"ReactionPicker.vue": "anchored popover, own sheet rule",
		// A popover under the @ button; its phone layout takes the insets in
		// its own native rule (Mentions.vue).
		"Mentions.vue": "anchored popover, own phone rule",
		// A popover at its chip; its phone sheet sits on the bottom edge and
		// has its own inset rule (`html[data-shell="native"]
		// .source-language-picker--sheet`).
		"SourceLanguagePicker.vue": "anchored popover, own sheet rule",
		// The connect form is a page, not an overlay: its link-approval
		// dialog is the window itself, laid out inside #viewport's padding.
		"Windows/Connect.vue": "a page inside #viewport",
	};

	function vueFiles(dir: string): string[] {
		return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? vueFiles(full) : entry.name.endsWith(".vue") ? [full] : [];
		});
	}

	const covers = /role="dialog"|aria-modal|id="[\w-]*-overlay"|<Teleport\s+to="body"/;

	for (const file of vueFiles(components)) {
		const name = path.relative(components, file).split(path.sep).join("/");
		const template = fs.readFileSync(file, "utf8").split(/<script\b|<style\b/)[0];

		if (!covers.test(template) || exempt[name]) {
			continue;
		}

		it(name, function () {
			expect(template, `${name} covers the screen without .screen-overlay`).to.match(
				/class="[^"]*\bscreen-overlay\b/
			);
		});
	}
});
