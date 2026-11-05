// `[wire code, English name]`; the name a reader sees is resolved from the
// catalog in autocompletion.ts, which matches against both.
const colorCodeMap: [string, string][] = [
	["00", "White"],
	["01", "Black"],
	["02", "Blue"],
	["03", "Green"],
	["04", "Red"],
	["05", "Brown"],
	["06", "Magenta"],
	["07", "Orange"],
	["08", "Yellow"],
	["09", "Light Green"],
	["10", "Cyan"],
	["11", "Light Cyan"],
	["12", "Light Blue"],
	["13", "Pink"],
	["14", "Grey"],
	["15", "Light Grey"],
];

export default {
	colorCodeMap,
	commands: [] as string[],
};
