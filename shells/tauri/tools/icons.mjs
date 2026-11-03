// `pnpm icons`: src-tauri/icons/ (and the phone projects' icons) from the deploy's logo (public/img/icon-512.png),
// so a rebrand carries over. On a Mac the .icns is then made again from the
// logo cut to the Mac's rounded square (macos-icon.swift); Windows and Linux
// show the square as it is. A build elsewhere keeps the square .icns, which
// only a Mac reads.

import {execFileSync} from "node:child_process";
import {copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const logo = "../../public/img/icon-512.png";
const out = "src-tauri/icons";
const tauri = (...args) =>
	execFileSync("tauri", args, {stdio: "inherit", shell: process.platform === "win32"});

// Without -o it also writes the phones' icons into gen/android and gen/apple.
tauri("icon", logo);

if (process.platform === "darwin") {
	const dir = mkdtempSync(join(tmpdir(), "seance-icon-"));

	try {
		const shaped = join(dir, "macos.png");
		execFileSync("swift", ["tools/macos-icon.swift", logo, shaped], {stdio: "inherit"});
		tauri("icon", shaped, "-o", join(dir, "icons"));
		copyFileSync(join(dir, "icons", "icon.icns"), join(out, "icon.icns"));
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}
