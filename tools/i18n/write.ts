// How the i18n tools write the files they generate (compile.ts: the
// compiled catalogs, available.ts, tags.json, call-sites.ts; targets.ts:
// targets.ts). `pnpm test` runs the build, which compiles, beside lint and
// typecheck, which read those very files, so a write must never leave a
// reader half a file, and a run that changes nothing must touch nothing.

import {readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";

/**
 * Write `content` to `path` unless the file already holds exactly that:
 * through a temporary file beside it and a rename (atomic on one
 * filesystem), so a reader sees the old file or the new one, never a part.
 * The temporary name ends in neither .json nor .ts, so no linter's glob
 * picks it up while it exists. Returns whether it wrote.
 */
export function writeIfChanged(path: string, content: string): boolean {
	let current: string | null = null;

	try {
		current = readFileSync(path, "utf8");
	} catch {
		// No file yet.
	}

	if (current === content) {
		return false;
	}

	const temp = `${path}.tmp-${process.pid}`;

	try {
		writeFileSync(temp, content);
		renameSync(temp, path);
	} catch (e) {
		rmSync(temp, {force: true});
		throw e;
	}

	return true;
}
