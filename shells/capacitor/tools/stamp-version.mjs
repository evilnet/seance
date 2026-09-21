// Stamps the native projects with the version the web build reports
// (webpack.config.ts `resolveBuild`): the nearest `v*` tag, `v` stripped, is the
// marketing version, and the commit count is the build number — monotonic,
// which is all App Store Connect and Play ask of it. Runs before every
// `cap sync` (`presync` in package.json); a checkout without tags keeps what
// the projects already say.
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

const version = git("describe", "--tags", "--match", "v*", "--abbrev=0")?.replace(/^v/, "");
const build = git("rev-list", "--count", "HEAD");

if (!version || !build) {
	console.log("stamp-version: no git tag or history, native versions left as they are");
	process.exit(0);
}

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

console.log(`stamp-version: ${version} (${build})`);
