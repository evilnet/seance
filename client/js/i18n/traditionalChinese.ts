/** A Chinese tag written in Traditional characters: the script subtag
 * decides (`zh-Hant-CN` is Traditional, `zh-Hans-TW` Simplified), and
 * without one the regions that write Traditional — Taiwan, Hong Kong,
 * Macau. A module of its own, free of the catalogs, so the translation
 * layer (translate/languages.ts) can share it; client/js/prepaint.js
 * restates it. */
export function isTraditionalChinese(tag: string): boolean {
	const parts = tag.toLowerCase().split(/[-_]/);

	if (parts[0] !== "zh") {
		return false;
	}

	if (parts.includes("hant")) {
		return true;
	}

	return !parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part));
}
