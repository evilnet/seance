import {expect} from "chai";
import {spawnSync} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {pathToFileURL} from "url";

/*
 * tools/ps/fetch-fonts.mjs, run as it is run (`node tools/ps/fetch-fonts.mjs`
 * from a checkout), in a scratch copy of the tree it writes into, with
 * `fetch` answered by a stand-in: Google's stylesheet as the endpoint shapes
 * it, a few bytes for each woff2, and each licence as GitHub serves it, with
 * CRLF line ends.
 */
const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "tools/ps/fetch-fonts.mjs");
const LICENCES = ["OFL-SourceSans3.txt", "OFL-Newsreader.txt"];

/** The stand-in `fetch`, as a module node preloads with --import. */
const STUB = `
const committed = ${JSON.stringify(
	Object.fromEntries(
		LICENCES.map((f) => [
			f.replace(/^OFL-|\.txt$/g, "").toLowerCase(),
			fs.readFileSync(path.join(ROOT, "client/themes/ps", f), "utf8"),
		])
	)
)};
const block = (subset, range) =>
	"/* " + subset + " */\\n@font-face {\\n  font-family: 'X';\\n  src: url(https://fonts.gstatic.com/s/x/" + subset + ".woff2) format('woff2');\\n  unicode-range: " + range + ";\\n}\\n";
const stylesheet =
	block("vietnamese", "U+0102-0103, U+1EA0-1EF9, U+20AB") +
	block("latin-ext", "U+0100-02BA, U+02BD-02C5") +
	block("latin", "U+0000-00FF, U+0131");
globalThis.fetch = async (input) => {
	const url = String(input);
	if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(stylesheet);
	if (url.endsWith(".woff2")) return new Response(new Uint8Array([119, 79, 70, 50]));
	const face = /\\/ofl\\/([^/]+)\\/OFL\\.txt$/.exec(url)?.[1];
	if (face && committed[face] !== undefined) {
		return new Response(committed[face].replace(/\\r?\\n/g, "\\r\\n"));
	}
	return new Response("", {status: 404, statusText: "not stubbed: " + url});
};
`;

describe("tools/ps/fetch-fonts.mjs", function () {
	this.timeout(20000);
	let dir = "";

	before(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-fetch-fonts-"));
		fs.mkdirSync(path.join(dir, "client/themes/ps"), {recursive: true});
		fs.copyFileSync(
			path.join(ROOT, "client/themes/ps.css"),
			path.join(dir, "client/themes/ps.css")
		);
		fs.writeFileSync(path.join(dir, "stub-fetch.mjs"), STUB);
	});

	after(function () {
		fs.rmSync(dir, {recursive: true, force: true});
	});

	it("writes each licence with LF line ends, so a re-fetch leaves the committed copy unchanged (GitHub serves them CRLF)", function () {
		const run = spawnSync(
			process.execPath,
			["--import", pathToFileURL(path.join(dir, "stub-fetch.mjs")).href, SCRIPT],
			{cwd: dir, encoding: "utf8"}
		);
		expect(run.status, run.stderr).to.equal(0);

		for (const file of LICENCES) {
			const written = fs.readFileSync(path.join(dir, "client/themes/ps", file), "utf8");
			expect(written, file).to.not.include("\r");
			expect(written, file).to.equal(
				fs.readFileSync(path.join(ROOT, "client/themes/ps", file), "utf8")
			);
		}
	});
});
