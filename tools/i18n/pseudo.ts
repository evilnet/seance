// Deterministic pseudo-translation: accented lookalikes, doubled length
// (catches truncation/overflow), RLE+PDF wrapped so every string renders
// right-to-left. Plural categories all carry the same text (compile.ts's
// qqx step copies one text over every category). The generator behind the
// qqx rig: compile.ts maps every en entry through pseudo() on every run,
// and the toolchain test pins the compiled qqx.json against it.

const RLE = "\u202B";
const PDF = "\u202C";

const LOOKALIKE: Record<string, string> = {
	a: "à",
	b: "ḃ",
	c: "ċ",
	d: "ḋ",
	e: "é",
	f: "ḟ",
	g: "ġ",
	h: "ḣ",
	i: "ï",
	j: "ĵ",
	k: "ķ",
	l: "ľ",
	m: "ṁ",
	n: "ñ",
	o: "ö",
	p: "ṗ",
	q: "q́",
	r: "ŕ",
	s: "ś",
	t: "ţ",
	u: "ü",
	v: "ṽ",
	w: "ẃ",
	x: "x́",
	y: "ý",
	z: "ź",
};

const MIRROR: Record<string, string> = {
	"(": ")",
	")": "(",
	"[": "]",
	"]": "[",
	"{": "}",
	"}": "{",
	"<": ">",
	">": "<",
};

/** Pseudo-translate one string; {name} interpolation tokens stay verbatim. */
export function pseudo(input: string): string {
	// Odd indices are the captured {name} tokens: they skip the mapping so a
	// pseudo-localized string still interpolates at runtime.
	const body = input
		.split(/(\{\w+\})/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: [...part].map((c) => MIRROR[c] ?? LOOKALIKE[c.toLowerCase()] ?? c).join("")
		)
		.join("");
	return RLE + body + body + PDF; // doubled: see truncation, brackets flipped
}
