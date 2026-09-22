// Stamps the native projects with the version the web build reports
// (webpack.config.ts `resolveBuild`): the nearest `vX.Y.Z` tag, `v` stripped,
// is the marketing version, and the build number is derived from it.
//
// Both stores ask one thing of a build number: that it never goes down. The
// commit count alone does not give that — it is a property of the branch, so
// a release cut from a branch with fewer commits than the last upload had
// would be rejected. The tag is the same number on every branch that can see
// it, so it carries the weight:
//
//   major * 10_000_000 + minor * 100_000 + patch * 1_000 + commits since the tag
//
// The last term only separates the builds between two tags (TestFlight wants
// a fresh number per upload) and is bounded so it can never reach the next
// patch. Runs before every `cap sync` (`presync` in package.json); a checkout
// without a matching tag keeps what the projects already say.
//
//   ios/App/App.xcodeproj/project.pbxproj   MARKETING_VERSION / CURRENT_PROJECT_VERSION
//   android/app/build.gradle                versionName / versionCode

import {execFileSync} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
	try {
		return execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "ignore"]})
			.toString()
			.trim();
	} catch {
		return null;
	}
}

const MATCH = "v[0-9]*.[0-9]*.[0-9]*";
// One call answers both questions: `v5.1.6-29-g96bc3e42` away from the tag,
// a bare `v5.1.6` on it. `--abbrev=0` would throw the count away.
const described = git("describe", "--tags", "--match", MATCH);
const parts = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?$/.exec(described ?? "");

if (!parts) {
	console.log(`stamp-version: no ${MATCH} tag in reach, native versions left as they are`);
	process.exit(0);
}

const [, major, minor, patch, ahead] = parts.map(Number);
const version = `${major}.${minor}.${patch}`;
const tag = `v${version}`;
const since = ahead || 0;

// One row per field: its value, what it is worth, and the largest it may be
// before it would carry into the field above. PLAY_MAX is Play's ceiling on a
// versionCode; App Store Connect sets none.
const FIELDS = [
	{name: "major", value: major, worth: 10_000_000, max: 209},
	{name: "minor", value: minor, worth: 100_000, max: 99},
	{name: "patch", value: patch, worth: 1_000, max: 99},
	{name: "commits since the tag", value: since, worth: 1, max: 999},
];
const PLAY_MAX = 2_100_000_000;

for (const field of FIELDS) {
	if (field.value > field.max) {
		throw new Error(
			`stamp-version: ${tag} +${since} does not fit the build number (${field.name} must be <= ${field.max})`
		);
	}
}

const build = FIELDS.reduce((total, field) => total + field.value * field.worth, 0);

if (build > PLAY_MAX) {
	throw new Error(
		`stamp-version: ${tag} +${since} is ${build}, over Play's ${PLAY_MAX} versionCode ceiling`
	);
}

function stamp(file, replacements) {
	const path = resolve(root, file);
	const original = readFileSync(path, "utf8");
	let text = original;

	for (const [pattern, replacement] of replacements) {
		// The stamp target vanishing means the generator changed shape, which
		// is worth stopping for rather than silently shipping a stale version.
		if (!pattern.test(text)) {
			throw new Error(`${file}: ${pattern} not found`);
		}

		text = text.replace(pattern, replacement);
	}

	// Only when it actually moved: an identical rewrite still bumps the mtime,
	// and Xcode regenerates its build description off the project file's stat.
	if (text !== original) {
		writeFileSync(path, text);
	}
}

stamp("ios/App/App.xcodeproj/project.pbxproj", [
	[/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`],
	[/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`],
]);
stamp("android/app/build.gradle", [
	[/versionName "[^"]*"/, `versionName "${version}"`],
	[/versionCode \d+/, `versionCode ${build}`],
]);

console.log(`stamp-version: ${version} (${build}), ${tag} +${since}`);
