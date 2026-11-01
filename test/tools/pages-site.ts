import {expect} from "chai";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
	assemble,
	keepOnSite,
	kindOf,
	linkTo,
	renderIndex,
	renderStub,
} from "../../tools/pages-site.mjs";

/** The Pages site assembled from the workflow's builds (tools/pages-site.mjs). */
describe("Pages site assembly (tools/pages-site.mjs)", function () {
	const release = {name: "release", path: "", sha: "aaaaaaaa1111", version: "5.1.10"};
	const develop = {
		name: "develop",
		path: "develop",
		sha: "bbbbbbbb2222",
		version: "5.1.10-bbbbbbbb",
	};
	const pr = {
		name: "pr103",
		path: "pr103",
		number: 103,
		title: "oper: offer G-line and shun",
		url: "https://github.com/evilnet/seance/pull/103",
		sha: "cccccccc3333",
		version: "5.1.10-pr103.ccccccc",
	};

	it("knows a release from develop from a PR, and links each from previews/", function () {
		expect(kindOf(release)).to.equal("release");
		expect(kindOf(develop)).to.equal("develop");
		expect(kindOf(pr)).to.equal("pr");
		expect(kindOf({name: "develop", path: ""}), "a fork with no release").to.equal("develop");
		expect(linkTo(release)).to.equal("../");
		expect(linkTo(pr)).to.equal("../pr103/");
		expect(linkTo(release, "/seance/"), "absolute with the base path").to.equal("/seance/");
		expect(linkTo(pr, "/seance")).to.equal("/seance/pr103/");
	});

	it("lists the release, then develop, then PRs newest first, and escapes", function () {
		const html = renderIndex(
			[
				pr,
				{...pr, name: "pr98", path: "pr98", number: 98, title: "a <b> & c"},
				develop,
				release,
			],
			{
				repo: "evilnet/seance",
				builtAt: "2026-10-13T12:00:00Z",
			}
		);
		// The row labels, not the intro (which also says "develop").
		const order = [">Release 5.1.10</a>", ">develop</a>", ">#103 ", ">#98 "].map((s) =>
			html.indexOf(s)
		);
		expect(order.every((i) => i >= 0)).to.equal(true);
		expect([...order].sort((a, b) => a - b)).to.deep.equal(order);
		expect(html).to.include("a &lt;b&gt; &amp; c");
		expect(html).to.include('href="../pr103/"');
		expect(
			renderIndex([pr, release], {base: "/seance/"}),
			"absolute links on Pages"
		).to.include('href="/seance/pr103/"');
		expect(html).to.include("github.com/evilnet/seance/pulls");
	});

	it("leaves every build's source maps out of the site", function () {
		const dir = mkdtempSync(join(tmpdir(), "pages-site-"));

		try {
			const artifacts = join(dir, "artifacts");
			const out = join(dir, "out");
			const files = [
				"index.html",
				"js/bundle.js",
				"js/bundle.js.map",
				"js/translate-worker.js.map",
				"js/ort/ort-wasm-simd-threaded.jsep.mjs",
				"js/ort/ort-wasm-simd-threaded.jsep.mjs.map",
				"css/style.css",
				"css/style.css.map",
				// Names that merely contain "map" are no source maps.
				"js/sourcemap.js",
				"img/map.png",
				"js/emoji-map.json",
			];

			for (const e of [release, develop, pr]) {
				for (const file of files) {
					mkdirSync(join(artifacts, e.name, file, ".."), {recursive: true});
					writeFileSync(join(artifacts, e.name, file), file);
				}
			}

			assemble([release, develop, pr], artifacts, out, {
				now: new Date("2026-10-13T12:00:00Z"),
			});

			for (const e of [release, develop, pr]) {
				for (const file of files) {
					expect(existsSync(join(out, e.path, file)), `${e.name}: ${file}`).to.equal(
						!file.endsWith(".map")
					);
				}

				// The local build keeps its maps: only the site goes without.
				expect(existsSync(join(artifacts, e.name, "js", "bundle.js.map"))).to.equal(true);
			}

			expect(keepOnSite("/x/js/bundle.js.map")).to.equal(false);
			expect(keepOnSite("/x/js/bundle.js")).to.equal(true);
			expect(keepOnSite("/x/js"), "a directory is walked into").to.equal(true);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it("copies each build into its directory and stands in for a failed one", function () {
		const dir = mkdtempSync(join(tmpdir(), "pages-site-"));

		try {
			const artifacts = join(dir, "artifacts");
			const out = join(dir, "out");

			for (const e of [release, develop]) {
				mkdirSync(join(artifacts, e.name, "js"), {recursive: true});
				writeFileSync(join(artifacts, e.name, "index.html"), `<title>${e.name}</title>`);
				writeFileSync(join(artifacts, e.name, "js", "bundle.js"), "//");
			}

			const entries = assemble([release, develop, pr], artifacts, out, {
				repo: "evilnet/seance",
				runUrl: "https://github.com/evilnet/seance/actions/runs/1",
				base: "/seance/",
				now: new Date("2026-10-13T12:00:00Z"),
			});

			expect(readFileSync(join(out, "index.html"), "utf8")).to.include("release");
			expect(existsSync(join(out, "js", "bundle.js"))).to.equal(true);
			expect(readFileSync(join(out, "develop", "index.html"), "utf8")).to.include("develop");
			expect(entries.map((e: {failed: boolean}) => e.failed)).to.deep.equal([
				false,
				false,
				true,
			]);

			const stub = readFileSync(join(out, "pr103", "index.html"), "utf8");
			expect(stub).to.include("the build failed");
			expect(stub).to.include("actions/runs/1");
			expect(stub).to.equal(
				renderStub(pr, {
					runUrl: "https://github.com/evilnet/seance/actions/runs/1",
					base: "/seance/",
				})
			);

			const index = readFileSync(join(out, "previews", "index.html"), "utf8");
			expect(index).to.include("build failed");
			expect(index).to.include('href="/seance/develop/"');
			expect(stub).to.include('href="/seance/previews/"');
			expect(index).to.include("Assembled 2026-10-13T12:00:00Z");

			const json = JSON.parse(readFileSync(join(out, "previews.json"), "utf8")) as {
				builds: {name: string}[];
			};
			expect(json.builds.map((b) => b.name)).to.deep.equal(["release", "develop", "pr103"]);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
