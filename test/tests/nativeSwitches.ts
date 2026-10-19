import {expect} from "chai";
import fs from "fs";
import path from "path";

// Every checkbox is an on/off switch in the native shells, marked by the
// `v-switch` directive as it mounts (client/js/helpers/nativeSwitches.ts).
// A checkbox without it would stay a web checkbox there.
describe("checkboxes carry v-switch", function () {
	const components = path.join(process.cwd(), "client", "components");

	function vueFiles(dir: string): string[] {
		return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? vueFiles(full) : entry.name.endsWith(".vue") ? [full] : [];
		});
	}

	for (const file of vueFiles(components)) {
		const source = fs.readFileSync(file, "utf8");
		const boxes = [...source.matchAll(/<input\b[^>]*>/g)]
			.map((m) => m[0])
			.filter((tag) => /type="checkbox"/.test(tag));

		if (boxes.length === 0) {
			continue;
		}

		it(path.relative(components, file), function () {
			for (const tag of boxes) {
				expect(tag, tag.replace(/\s+/g, " ")).to.match(/\sv-switch[\s/>]/);
			}
		});
	}
});
