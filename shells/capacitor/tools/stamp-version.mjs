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
	} catch (e) {
		return null;
	}
}

const MATCH = "v[0-9]*.[0-9]*.[0-9]*";
const tag = git("describe", "--tags", "--match", MATCH, "--abbrev=0");
const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");

if (!parts) {
	console.log(`stamp-version: no ${MATCH} tag in reach, native versions left as they are`);
	process.exit(0);
}

const [, major, minor, patch] = parts.map(Number);
const version = `${major}.${minor}.${patch}`;
// `describe` counts what is between the tag and HEAD; `--abbrev=0` dropped it.
const since = Number(git("rev-list", "--count", `${tag}..HEAD`) ?? "0");

if (minor > 99 || patch > 99 || since > 999) {
	throw new Error(
		`stamp-version: ${tag} +${since} does not fit the build number (minor/patch < 100, commits since the tag < 1000)`
	);
}

const build = major * 10_000_000 + minor * 100_000 + patch * 1_000 + since;

function stamp(file, replacements) {
	const path = resolve(root, file);
	let text = readFileSync(path, "utf8");

	for (const [pattern, replacement] of replacements) {
		if (!pattern.test(text)) {
			throw new Error(`${file}: ${pattern} not found`);
		}

		text = text.replace(pattern, replacement);
	}

	writeFileSync(path, text);
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
