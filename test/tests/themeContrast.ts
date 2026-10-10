import {expect} from "chai";
import fs from "fs";
import path from "path";

// Increase Contrast points the muted text tokens at the full text colour on
// :root (the end of style.css). A theme that re-maps one of them on a
// narrower selector outranks that there, so it has to restate the reset for
// the same selector under html[data-contrast="more"] (zelenzy's dialogs).
describe("Increase Contrast reaches every theme", function () {
	const TOKENS = ["--body-color-muted", "--chat-fg-muted", "--chat-fg-faint", "--rail-fg-muted"];
	const themes = path.join(process.cwd(), "client", "themes");

	/** Innermost rules as [selector, body], comments and @imports removed. */
	function rules(css: string): [string, string][] {
		const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/g, "");
		return [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [
			m[1].trim().replace(/\s+/g, " "),
			m[2],
		]);
	}

	for (const file of fs.readdirSync(themes).filter((f) => f.endsWith(".css"))) {
		it(file, function () {
			const all = rules(fs.readFileSync(path.join(themes, file), "utf8"));

			for (const [selector, body] of all) {
				if (selector === ":root" || selector.includes('html[data-contrast="more"]')) {
					continue;
				}

				for (const token of TOKENS) {
					if (!new RegExp(`${token}\\s*:`).test(body)) {
						continue;
					}

					// A selector on the root element itself takes the attribute
					// on the same element (html[data-contrast="more"]:root[…]).
					const scoped = selector.startsWith(":root")
						? `html[data-contrast="more"]${selector}`
						: `html[data-contrast="more"] ${selector}`;
					const reset = all.find(
						([s, b]) =>
							s.split(",").some((part) => part.trim() === scoped) &&
							new RegExp(`${token}\\s*:`).test(b)
					);
					expect(reset, `${selector} re-maps ${token}`).to.not.equal(undefined);
				}
			}
		});
	}
});
