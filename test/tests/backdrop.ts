import {expect} from "chai";
import fs from "fs";
import path from "path";

// A backdrop closes its modal through `v-backdrop`, which only counts a click
// pressed and released on it (client/js/helpers/backdrop.ts). `@click.self`
// also counts a drag that began inside the modal and ended past its edge.
describe("backdrops use v-backdrop, not @click.self", function () {
	const components = path.join(process.cwd(), "client", "components");

	function vueFiles(dir: string): string[] {
		return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? vueFiles(full) : entry.name.endsWith(".vue") ? [full] : [];
		});
	}

	it("no component closes on @click.self", function () {
		const files = vueFiles(components);
		expect(files.length).to.be.greaterThan(10);

		const offenders = files
			.filter((file) => /(@|v-on:)click\.self/.test(fs.readFileSync(file, "utf8")))
			.map((file) => path.relative(components, file));
		expect(offenders).to.deep.equal([]);
	});
});
