// File sizes for humans. The IEC unit symbols (KiB, MiB, …) stay universal —
// like SI symbols they are the one notation every locale reads — while the
// number itself is written by the active locale's number formatting (decimal
// comma in de, …). Memoized per tag, like the i18n date formatters.
import {activeLocale} from "../i18n/core";

// "B", not "Bytes": a symbol like the others, so no locale reads an English
// word under 1 KiB.
const sizes = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

const cache = new Map<string, Intl.NumberFormat>();

function formatter(tag: string): Intl.NumberFormat {
	let fmt = cache.get(tag);

	if (!fmt) {
		// At most one decimal, no forced trailing zero, and no group
		// separators — a byte count reads "1023 B", not "1,023 B"
		// (the shape of the old parseFloat(size.toFixed(1)) output; the
		// decimal separator still follows the locale).
		fmt = new Intl.NumberFormat(tag, {maximumFractionDigits: 1, useGrouping: false});
		cache.set(tag, fmt);
	}

	return fmt;
}

export default (size: number) => {
	// Loosely inspired from https://stackoverflow.com/a/18650828/1935861
	const i = size > 0 ? Math.floor(Math.log(size) / Math.log(1024)) : 0;
	return `${formatter(activeLocale()).format(size / Math.pow(1024, i))} ${sizes[i]}`;
};
