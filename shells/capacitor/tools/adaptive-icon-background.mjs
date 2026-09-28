// After `capacitor-assets generate`: the Android adaptive icon's background
// layer as a plain colour, not the inset bitmap the generator writes. The
// generator insets both layers by 16.7%, so its background bitmap leaves
// the outer sixth of the icon transparent and the launcher paints that ring
// in its own accent colour. A colour layer fills the whole canvas, every
// mask shape, and is what the Android 12+ launch screen samples too.
//
// It also adds the <monochrome> layer the generator does not write, which is
// what a themed launcher (Android 13+) draws: the art's alpha, tinted by the
// wallpaper, so the same inset foreground stands in for it.
//
//   node tools/adaptive-icon-background.mjs [#colour]   (default: the tile)

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const res = resolve(dirname(fileURLToPath(import.meta.url)), "../android/app/src/main/res");
const colour = process.argv[2] ?? "#0D0E14";

if (!/^#[0-9a-f]{6}$/i.test(colour)) {
	throw new Error(`not a colour: ${colour}`);
}

writeFileSync(
	resolve(res, "values/ic_launcher_background.xml"),
	`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${colour.toUpperCase()}</color>\n</resources>`
);

for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
	const path = resolve(res, "mipmap-anydpi-v26", name);
	const generated = readFileSync(path, "utf8");
	const background = /<background>[\s\S]*?<\/background>|<background [^>]*\/>/;

	if (!background.test(generated)) {
		throw new Error(`${name}: no <background> to replace`);
	}

	let xml = generated.replace(
		background,
		'<background android:drawable="@color/ic_launcher_background"/>'
	);

	if (!xml.includes("<monochrome")) {
		const foreground = /<foreground>([\s\S]*?)<\/foreground>/.exec(xml);

		if (!foreground) {
			throw new Error(`${name}: no <foreground> to mirror as <monochrome>`);
		}

		xml = xml.replace(
			"</adaptive-icon>",
			`    <monochrome>${foreground[1]}</monochrome>\n</adaptive-icon>`
		);
	}

	writeFileSync(path, xml);
}

console.log(`adaptive icon background: ${colour}`);
