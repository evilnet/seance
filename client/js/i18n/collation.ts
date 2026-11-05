// Vue-free collation, memoized per tag+options — the sort-side twin of
// dates.ts. Sidebar sorts (stored channel/network order, the insertion
// order new channels join at) build their Intl.Collator from here, so the
// active locale's alphabet decides the order. A locale change takes effect
// on the next sort: the new tag keys a new collator.
//
// This directory is skipped by tools/i18n/check.ts's call-site scan; there
// are no catalog keys here — collation comes from Intl, not translations.

import {activeLocale} from "./core";

const cache = new Map<string, Intl.Collator>();

/** A collator for the active locale, memoized per tag + options. */
export function collator(options?: Intl.CollatorOptions): Intl.Collator {
	const tag = activeLocale();
	const key =
		tag +
		"|" +
		(options
			? Object.entries(options)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(",")
			: "");
	let instance = cache.get(key);

	if (!instance) {
		instance = new Intl.Collator(tag, options);
		cache.set(key, instance);
	}

	return instance;
}
