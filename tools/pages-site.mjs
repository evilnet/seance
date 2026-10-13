// Assemble the GitHub Pages site from the builds the Pages workflow made
// (.github/workflows/pages.yml): the release (or develop) at the root, a
// `develop/` tree, one `pr<N>/` tree per open pull request, a `previews/`
// index page that lists them, and `previews.json` for scripts. A build whose
// job failed gets a stub page in its place, linking to the run, rather than
// vanishing from the site.
//
//   node tools/pages-site.mjs <plan.json> <artifacts dir> <out dir> [run url]
//
// `SITE_BASE` (the Pages base path, `/seance/`) makes every link on the
// index absolute; without it they are relative to `previews/`.
//
// `plan.json` is the workflow's build list: `[{name, path, title, sha,
// version, url?, number?}]`, `path` being where the build lives on the site
// ("" for the root). `<artifacts dir>/<name>/` holds each build's `public/`
// tree where the job succeeded. Kept dependency-free; the pure parts are
// exported for test/tools/pages-site.ts.

import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

/** Escape text for an HTML page. */
export function escapeHtml(text) {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c])
	);
}

/**
 * The link to a build from the index: absolute when the site's base path is
 * known (`/seance/pr103/`), else `../` from `previews/` and the path.
 */
export function linkTo(entry, base) {
	const dir = entry.path ? `${entry.path}/` : "";

	if (base) {
		return `${base.endsWith("/") ? base : `${base}/`}${dir}`;
	}

	return `../${dir}`;
}

/** What a build is, in a word: a release, the develop branch, or a PR. */
export function kindOf(entry) {
	if (entry.number !== undefined) {
		return "pr";
	}

	return entry.path === "" && entry.name !== "develop" ? "release" : "develop";
}

const STYLE = `
:root { color-scheme: light dark; --fg: #26211c; --bg: #f6f3ee; --muted: #6d655c; --rule: #dcd5cb; --accent: #b4661a; }
@media (prefers-color-scheme: dark) { :root { --fg: #ebe6df; --bg: #17151a; --muted: #a39b91; --rule: #332e2a; --accent: #e6a33c; } }
body { margin: 0; padding: 1.5rem 1rem 3rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
p { color: var(--muted); margin: 0 0 1.25rem; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 1rem; padding: 0.75rem 0; border-top: 1px solid var(--rule); align-items: baseline; }
li a.open { font-size: 1.1rem; font-weight: 600; color: var(--accent); text-decoration: none; }
li a.open:hover { text-decoration: underline; }
li .meta { grid-column: 1 / -1; color: var(--muted); font-size: 0.9rem; }
li .meta a { color: inherit; }
li .failed { color: #c0392b; font-weight: 600; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
`;

/** The `previews/index.html` page: every build, newest PR first. */
export function renderIndex(entries, {repo, builtAt, runUrl, base} = {}) {
	const order = (e) => (kindOf(e) === "release" ? 0 : kindOf(e) === "develop" ? 1 : 2);
	const sorted = [...entries].sort(
		(a, b) => order(a) - order(b) || (b.number ?? 0) - (a.number ?? 0)
	);
	const rows = sorted.map((e) => {
		const kind = kindOf(e);
		const label =
			kind === "pr"
				? `#${e.number} ${e.title ?? ""}`
				: kind === "release"
				? `Release ${e.version ?? ""}`
				: "develop";
		const where = e.path ? `/${e.path}/` : "/";
		const pr = e.url ? ` · <a href="${escapeHtml(e.url)}">pull request</a>` : "";
		const status = e.failed
			? ` · <span class="failed">build failed</span>${
					runUrl ? ` (<a href="${escapeHtml(runUrl)}">log</a>)` : ""
			  }`
			: "";

		return `<li><a class="open" href="${escapeHtml(linkTo(e, base))}">${escapeHtml(
			label
		)}</a><code>${escapeHtml(where)}</code><span class="meta"><code>${escapeHtml(
			(e.sha ?? "").slice(0, 8)
		)}</code> · v${escapeHtml(e.version ?? "")}${pr}${status}</span></li>`;
	});

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seance previews</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Seance previews</h1>
<p>Every open pull request${
		repo
			? ` on <a href="https://github.com/${escapeHtml(repo)}/pulls">${escapeHtml(repo)}</a>`
			: ""
	} as a working build, beside the release and <code>develop</code>.${
		builtAt ? ` Assembled ${escapeHtml(builtAt)}.` : ""
	} All of them share this site's storage, so a network saved in one is there in the others.</p>
<ul>
${rows.join("\n")}
</ul>
</main>
</body>
</html>
`;
}

/** The page that stands in for a build whose job failed. */
export function renderStub(entry, {runUrl, base} = {}) {
	const label = entry.number !== undefined ? `#${entry.number} ${entry.title ?? ""}` : entry.name;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seance preview: build failed</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(label)}: the build failed</h1>
<p>Commit <code>${escapeHtml((entry.sha ?? "").slice(0, 8))}</code> did not build.${
		runUrl ? ` <a href="${escapeHtml(runUrl)}">The run's log</a> says why.` : ""
	} The last good build was not kept; push a fix and this page is replaced.</p>
<p><a href="${escapeHtml(linkTo({path: "previews"}, base))}">Every preview</a></p>
</main>
</body>
</html>
`;
}

/**
 * Copy each build into place and write the index. Returns the entries with
 * `failed` set where no build was found.
 */
export function assemble(plan, artifactsDir, outDir, {repo, runUrl, base, now = new Date()} = {}) {
	mkdirSync(outDir, {recursive: true});
	const entries = plan.map((entry) => {
		const from = join(artifactsDir, entry.name);
		const to = join(outDir, entry.path);
		const built = existsSync(join(from, "index.html"));

		mkdirSync(to, {recursive: true});

		if (built) {
			cpSync(from, to, {recursive: true});
		} else {
			writeFileSync(join(to, "index.html"), renderStub(entry, {runUrl, base}));
		}

		return {...entry, failed: !built};
	});

	const builtAt = now.toISOString().replace(/\.\d+Z$/, "Z");
	mkdirSync(join(outDir, "previews"), {recursive: true});
	writeFileSync(
		join(outDir, "previews", "index.html"),
		renderIndex(entries, {repo, builtAt, runUrl, base})
	);
	writeFileSync(
		join(outDir, "previews.json"),
		JSON.stringify({builtAt, repo, builds: entries}, null, "\t") + "\n"
	);

	return entries;
}

const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));

if (invoked) {
	const [planFile, artifactsDir, outDir, runUrl] = process.argv.slice(2);

	if (!planFile || !artifactsDir || !outDir) {
		console.error("usage: pages-site.mjs <plan.json> <artifacts dir> <out dir> [run url]");
		process.exit(2);
	}

	const plan = JSON.parse(readFileSync(planFile, "utf8"));
	const entries = assemble(plan, artifactsDir, outDir, {
		repo: process.env.GITHUB_REPOSITORY,
		base: process.env.SITE_BASE,
		runUrl,
	});

	for (const e of entries) {
		console.log(`${e.failed ? "FAILED " : "ok     "} /${e.path} ${e.name} ${e.version ?? ""}`);
	}
}
