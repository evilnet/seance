import {expect} from "chai";
import fs from "fs";
import path from "path";
import {contrast, luminance, mix} from "../../../client/js/scenes/ps/colour";
import {type Moment} from "../../../client/js/scenes/ps/engine";
import {DAY_GLASS_MARK} from "../../../client/js/scenes/ps/glass";
import {AREAS, INK_FAINT_HELD, publishedFor} from "../../../client/js/scenes/ps/grounds";
import {paletteAt, type Palette} from "../../../client/js/scenes/ps/palette";
import {
	bodyGrounds,
	checkedGrounds,
	CODE_BOX,
	dayGlassGrounds,
	eachChecked,
	effectiveGround,
	GLASS,
	glassGround,
	groundsAt,
	INK,
	INK_FAINT,
	LARGE_TEXT_STEPS,
	LIGHT_ROOT,
	LIGHT_SWEEP,
	lightSweepFloors,
	momentAt,
	pinnedMoments,
	sceneGrounds,
	SMALL_STEPS_ROOT,
	smallStepSweep,
	withPinned,
	type Checked,
	type CheckedGround,
	type Light,
	type Text,
} from "../../../tools/ps/legibility";
import {hexToOklch} from "../../../tools/ps/oklch";

/* The two lines a run against another sweep's copy of ps.css changes. */
const CSS_FILE = path.resolve(__dirname, "../../../client/themes/ps.css");
const SWEEP = LIGHT_SWEEP;

const css = fs.readFileSync(CSS_FILE, "utf8");
const blockOf = (name: string) =>
	css.slice(css.indexOf(`/* ps:${name}:start`), css.indexOf(`/* ps:${name}:end */`));
const messageBlock = blockOf("message-palette");
const glassBlock = blockOf("glass-palette");
const headerOf = (block: string) => block.slice(0, block.indexOf("*/"));
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
	selector: string;
	decls: Array<[string, string]>;
}

/** Every rule in `text`, comments dropped (a header glued to the first rule would hide its selector), with every declaration. */
function rulesOf(text: string): Rule[] {
	return [...uncommented(text).matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
		selector: m[1].trim(),
		decls: m[2]
			.split(";")
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
	}));
}

/** Both block headers: their worst grounds and the Review Focus pins. */
const headers = headerOf(messageBlock) + headerOf(glassBlock);

/** The moments the block headers name, as `doy D M min W`. */
const pinned = () => pinnedMoments(headers);

let merged: Checked | undefined;

/** The sparse sweep's grounds and every pinned moment's. */
function grounds(): Checked {
	merged ??= withPinned(checkedGrounds("sparse"), headers);
	return merged;
}

/** The lowest contrast `colour` meets over `list`, and where. */
function worst(colour: string, list: CheckedGround[]): {ratio: number; where: string} {
	const lc = luminance(colour);
	let best = {ratio: Infinity, where: ""};

	for (const g of list) {
		const ratio = (Math.max(lc, g.lum) + 0.05) / (Math.min(lc, g.lum) + 0.05);

		if (ratio < best.ratio) {
			best = {ratio, where: `${g.where}, ${g.name} (${g.hex})`};
		}
	}

	return best;
}

/** Faint white is white at 80 % over its own ground. */
function worstFaintWhite(list: CheckedGround[]): {ratio: number; where: string} {
	let best = {ratio: Infinity, where: ""};

	for (const g of list) {
		const ratio = contrast(mix(g.hex, "#ffffff", 0.8), g.hex);

		if (ratio < best.ratio) {
			best = {ratio, where: `${g.where}, ${g.name} (${g.hex})`};
		}
	}

	return best;
}

/** One colour the message block declares, with the floor and the grounds it is held to. */
interface Held {
	what: string;
	value: string;
	text: Text;
	floor: number;
	/** Over the bodies too, or the sky alone. */
	bodies: boolean;
	faintWhite: boolean;
	/** Drawn in a code box (--ps-code-bg): held against the box, not the plains. */
	box?: string;
}

const HEX = /^#[0-9a-f]{6}$/;
/** What a code box draws: the highlighter's tokens and the block's own text. */
const ON_CODE_BOX = /^--tok-[a-z]+$|^--md-code-color$/;

/** The sweep the light nicks take below the default font-size step, if the light sweep needs one. */
const SMALL = smallStepSweep(SWEEP);

/** --ps-code-bg as each treatment's rule declares it. */
function codeBoxes(): Partial<Record<Text, string>> {
	const out: Partial<Record<Text, string>> = {};

	for (const {selector, decls} of rulesOf(messageBlock)) {
		const box = decls.find(([name]) => name === "--ps-code-bg");

		if (box && (selector === "#chat .chat" || selector === LIGHT_ROOT)) {
			out[selector === LIGHT_ROOT ? "light" : "ink"] = box[1];
		}
	}

	return out;
}

/**
 * Every declaration of the message block, classified, so that a colour
 * written in another form fails rather than slipping past: white and faint
 * white over every ground, other colours by LIGHT_SWEEP at night (the nicks
 * under SMALL_STEPS_ROOT by its small-step set), faint ink at 3:1 by day, and
 * what a code box draws against the box. Anything else it cannot read is an
 * error.
 */
function heldColours(): {held: Held[]; unread: string[]} {
	const floors = lightSweepFloors(SWEEP);
	const boxes = codeBoxes();
	const held: Held[] = [];
	const unread: string[] = [];

	for (const {selector, decls} of rulesOf(messageBlock)) {
		const text: Text = selector.includes('[data-ps-text="light"]') ? "light" : "ink";
		const nick = selector.includes(".user.color-");
		const small = selector.startsWith(`${SMALL_STEPS_ROOT} `);

		if (small && !SMALL) {
			unread.push(
				`${selector}: a small-step rule under LIGHT_SWEEP "${SWEEP}", which needs none`
			);
			continue;
		}

		for (const [name, value] of decls) {
			const what = `${selector} ${name}`;

			if (name === "color" && value === "var(--chat-fg)" && selector === "#chat .chat") {
				continue;
			}

			// The box itself is a surface: codeBoxes() reads it, the code test holds it opaque.
			if (name === "--ps-code-bg" && HEX.test(value)) {
				continue;
			}

			if (ON_CODE_BOX.test(name)) {
				const box = boxes[text];

				if (!HEX.test(value) || !box) {
					unread.push(`${what}: ${value} (code box ${box ?? "missing"})`);
				} else {
					held.push({
						what,
						value,
						text,
						floor: 4.5,
						bodies: true,
						faintWhite: false,
						box,
					});
				}
			} else if (
				text === "light" &&
				name === "--chat-fg-faint" &&
				value === "rgb(255 255 255 / 80%)"
			) {
				held.push({what, value: "#ffffff", text, floor: 3, bodies: true, faintWhite: true});
			} else if (!HEX.test(value)) {
				unread.push(`${what}: ${value}`);
			} else if (text === "ink") {
				const floor = name === "--chat-fg-faint" ? 3 : 4.5;
				held.push({what, value, text, floor, bodies: true, faintWhite: false});
			} else if (value === "#ffffff") {
				held.push({what, value, text, floor: 4.5, bodies: true, faintWhite: false});
			} else {
				const rule = small
					? lightSweepFloors(SMALL!).nicks
					: nick
					? floors.nicks
					: floors.colours;
				held.push({
					what,
					value,
					text,
					floor: rule.floor,
					bodies: rule.bodies,
					faintWhite: false,
				});
			}
		}
	}

	return {held, unread};
}

/** `rgb(r g b / n%)` as its hex and its strength; null in any other form. */
function rgbPercent(value: string): {hex: string; strength: number} | null {
	const m = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/.exec(value);

	if (!m) {
		return null;
	}

	const hex = `#${m
		.slice(1, 4)
		.map((c) => Number(c).toString(16).padStart(2, "0"))
		.join("")}`;
	return {hex, strength: Number(m[4]) / 100};
}

/** The washes ps.css paints on a mentioned row, by treatment. */
function mentionWashes(): Array<{text: Text; hex: string; strength: number}> {
	return rulesOf(css)
		.filter((r) => r.selector.includes(".msg.highlight"))
		.flatMap((r) =>
			r.decls
				.filter(([name]) => name === "background")
				.map(([, value]) => {
					const wash = rgbPercent(value);

					if (!wash) {
						throw new Error(`a mention wash this test cannot read: ${value}`);
					}

					const text: Text = r.selector.includes('data-ps-text="light"')
						? "light"
						: "ink";
					return {text, ...wash};
				})
		);
}

const groundsFor = (h: Held, list: CheckedGround[]) =>
	h.bodies ? list : list.filter((g) => g.body !== "moon" && g.body !== "sun");

/** A colour drawn in a code box, against the box. */
const onBox = (h: Held) => ({ratio: contrast(h.value, h.box!), where: `the code box ${h.box}`});

/** The glass block's declared values. */
function glassDeclared() {
	const rules = rulesOf(glassBlock);

	const tokens = (selector: string) => {
		const rule = rules.find((r) => r.selector === selector)!;
		return Object.fromEntries(rule.decls);
	};

	const nicks = (prefix: string) =>
		rules
			.filter((r) => new RegExp(`^${prefix}\\.user\\.color-\\d+$`).test(r.selector))
			.map((r) => ({selector: r.selector, decls: r.decls}));
	const night = ':root[data-ps-light="night"]';
	return {
		rules,
		day: {tokens: tokens(":root"), nicks: nicks("")},
		night: {tokens: tokens(night), nicks: nicks(`${night.replace(/[[\]]/g, "\\$&")} `)},
	};
}

/** The glass grounds of one light at its declared opacity. */
function underGlass(light: Light, list = grounds().glass[light]): CheckedGround[] {
	const alpha = Number(glassDeclared()[light].tokens["--ps-g-tint-a"]);
	return list.map((g) => {
		const hex = glassGround(g.hex, light, alpha);
		return {...g, hex, lum: luminance(hex)};
	});
}

describe("ps: the words over the plains and on the glass keep their floors: every 7th day and the season anchors, every 10 minutes, all six weathers, and every moment the generated blocks pin; against the sky, the bodies and the plains", function () {
	this.timeout(60000);

	it("finds both generated blocks, and grounds for every surface and state", function () {
		expect(messageBlock.length).to.be.greaterThan(100);
		expect(glassBlock.length).to.be.greaterThan(100);
		expect(pinned().length).to.be.greaterThan(10);
		const g = grounds();

		for (const list of [g.column.ink, g.column.light, g.glass.day, g.glass.night]) {
			expect(list.length).to.be.greaterThan(1000);
		}

		expect(contrast(INK, "#ffffff")).to.be.greaterThan(4.5);
	});

	it("checks the plains' areas as well as the sky and the bodies, through the treatment in force (plan 3, the rulings table)", function () {
		for (const where of [
			"doy 172 750 min clear",
			"doy 172 0 min clear",
			"doy 32 750 min snow",
		]) {
			const m = momentAt(where);
			const at = groundsAt(m, paletteAt(m), where);
			const names = [...at.column.ink, ...at.column.light].map((g) => g.name);

			for (const area of ["skyTop", ...AREAS]) {
				expect(
					names.some((n) => n === area || n.startsWith(`${area} `)),
					`${where}: ${area}`
				).to.equal(true);
			}
		}
	});

	it("never counts the sun under the horizon line: the land hides it", function () {
		const g = grounds();

		for (const list of [g.column.ink, g.column.light, g.glass.day, g.glass.night]) {
			expect(
				list.filter((x) => x.body === "sun" && x.below).map((x) => x.where)
			).to.deep.equal([]);
		}
	});

	it("pins the stormy noon, the golden hour, a clear noon and a snowy noon, and holds every column colour of the treatment in force there", function () {
		const PINS = {
			"stormy noon": {where: "doy 121 750 min storm", text: "light"},
			"golden hour": {where: "doy 295 1010 min clear", text: "light"},
			"clear noon": {where: "doy 172 750 min clear", text: "light"},
			"snowy noon": {where: "doy 32 750 min snow", text: "ink"},
		} as const;

		for (const [name, pin] of Object.entries(PINS)) {
			expect(headerOf(messageBlock), `the message block pins the ${name}`).to.include(
				pin.where
			);
			const m = momentAt(pin.where);
			const p = paletteAt(m);
			expect(publishedFor(p, m).text, name).to.equal(pin.text);
			const list = groundsAt(m, p, pin.where).column[pin.text];
			expect(list.length, name).to.be.greaterThan(20);

			for (const h of heldColours().held.filter((x) => x.text === pin.text)) {
				const w = h.box
					? onBox(h)
					: h.faintWhite
					? worstFaintWhite(groundsFor(h, list))
					: worst(h.value, groundsFor(h, list));
				expect(w.ratio, `${name}: ${h.what} ${h.value} at ${w.where}`).to.be.at.least(
					h.floor
				);
			}
		}
	});

	it("holds the spec's own ink wherever the words are ink (only where it holds: in practice snowy days), and white and faint white wherever they are light (every other moment, day and night), over every checked ground (a failure here is reported, not tuned)", function () {
		const g = grounds();
		expect(worst(INK, g.column.ink).ratio).to.be.at.least(4.5);
		expect(worst("#ffffff", g.column.light).ratio).to.be.at.least(4.5);
		expect(worstFaintWhite(g.column.light).ratio).to.be.at.least(3);
	});

	it("reads every declaration of the message block, in the forms it holds, and counts them", function () {
		const {held, unread} = heldColours();
		expect(unread).to.deep.equal([]);
		const rules = rulesOf(messageBlock);
		const count = (selector: string) =>
			rules.find((r) => r.selector === selector)!.decls.length;
		// 19 tokens, the code box, nine code tokens and `color` for the ink treatment; the
		// same 19, the box and the nine tokens for the light one.
		expect(count("#chat .chat")).to.equal(30);
		expect(count(LIGHT_ROOT)).to.equal(29);
		const nicks = (prefix: string) =>
			rules.filter((r) => r.selector.startsWith(`${prefix} .user.color-`));
		expect(nicks("#chat .chat").map((r) => r.decls.length)).to.deep.equal(Array(32).fill(1));
		expect(nicks(LIGHT_ROOT).map((r) => r.decls.length)).to.deep.equal(Array(32).fill(1));
		// Under names-large, a second light set for the steps below the default.
		const small = nicks(SMALL_STEPS_ROOT);
		expect(small.map((r) => r.decls.length)).to.deep.equal(SMALL ? Array(32).fill(1) : []);
		expect(rules.length).to.equal(66 + small.length);
		expect(held.length).to.equal(28 + 28 + 64 + small.length);
		const names = held.map((h) => h.what);
		expect(names).to.include("#chat .chat --chat-fg");
		expect(names).to.include("#chat .chat --link-color");
		expect(names).to.include(`${LIGHT_ROOT} --link-color`);
		expect(names).to.include(`${LIGHT_ROOT} --chat-fg-faint`);
	});

	it("gives the names below the default font-size step (tiny, small, medium, or no step yet) their own light set, after the light rules and before the action and notice rules", function () {
		// Bold Newsreader is WCAG large text from the default step up (fontSize.ts).
		expect(LARGE_TEXT_STEPS).to.deep.equal(["large", "xlarge", "huge"]);
		expect(SMALL_STEPS_ROOT).to.equal(
			':root:where(:not([data-font-size="large"], [data-font-size="xlarge"], [data-font-size="huge"]))[data-ps-text="light"] #chat .chat'
		);
		const selectors = rulesOf(messageBlock).map((r) => r.selector);
		const small = selectors.filter((sel) => sel.startsWith(`${SMALL_STEPS_ROOT} `));

		if (!SMALL) {
			expect(small).to.deep.equal([]);
			return;
		}

		expect(small).to.deep.equal(
			Array.from({length: 32}, (_, i) => `${SMALL_STEPS_ROOT} .user.color-${i + 1}`)
		);
		// Same specificity as the light nick rules (:where weighs nothing), so order decides.
		expect(selectors.indexOf(small[0])).to.be.above(
			selectors.indexOf(`${LIGHT_ROOT} .user.color-32`)
		);
		const after = css.slice(css.indexOf("/* ps:message-palette:end */"));
		expect(after).to.include(':root #chat .chat .msg[data-type="action"] .user');
		expect(after).to.include(':root #chat .chat .msg[data-type="notice"] .user');
	});

	it("paints the column's code boxes with their own opaque surface, not the chrome's, in both treatments", function () {
		expect(codeBoxes()).to.deep.equal(CODE_BOX);

		for (const box of Object.values(codeBoxes())) {
			expect(box).to.match(HEX);
		}

		// Outside the block: the rule that puts every code box on it.
		const rule = rulesOf(css).find((r) => r.selector.startsWith("#chat .chat code,"));
		expect(rule, "the code box rule").to.not.equal(undefined);
		expect(rule!.selector.split(/,\s*/)).to.deep.equal([
			"#chat .chat code",
			"#chat .chat pre",
			"#chat .chat .irc-monospace",
			'#chat .chat .msg[data-type="monospace_block"] .text',
		]);
		expect(rule!.decls).to.deep.equal([["background", "var(--ps-code-bg)"]]);
	});

	it("underlines links in the column under the light treatment (all day but on snowy days, and all night), when their colour no longer marks them", function () {
		const rule = rulesOf(css).find((r) => r.selector === `${LIGHT_ROOT} a`);
		expect(rule, "the light treatment's link rule").to.not.equal(undefined);
		expect(Object.fromEntries(rule!.decls)).to.include({"text-decoration": "underline"});
	});

	it("rules the words' treatment on the faint ink the column draws: grounds.ts's INK_FAINT_HELD is the generated --chat-fg-faint", function () {
		const faint = rulesOf(messageBlock)
			.find((r) => r.selector === "#chat .chat")!
			.decls.find(([name]) => name === "--chat-fg-faint")![1];
		expect(INK_FAINT_HELD).to.equal(faint);
	});

	it("keeps every rule-2 colour within 0.08 OKLCH lightness of the spec's", function () {
		const L = (hex: string) => hexToOklch(hex)[0];
		const glass = glassDeclared();
		const faint = rulesOf(messageBlock)
			.find((r) => r.selector === "#chat .chat")!
			.decls.find(([name]) => name === "--chat-fg-faint")![1];

		for (const [what, now, spec] of [
			["day --ps-g-soft", glass.day.tokens["--ps-g-soft"], GLASS.day.soft],
			["night --ps-g-soft", glass.night.tokens["--ps-g-soft"], GLASS.night.soft],
			["--chat-fg-faint", faint, INK_FAINT],
		]) {
			expect(now, what).to.match(HEX);
			expect(
				Math.abs(L(now) - L(spec)),
				`${what} ${now} against the spec's ${spec}`
			).to.be.at.most(0.08);
		}
	});

	it("keeps the chrome's hand-moved secondaries within 0.08 OKLCH lightness of creama's (by day) and coffee's (at night)", function () {
		const L = (hex: string) => hexToOklch(hex)[0];
		/**
		 * The last value a top-level rule of exactly `selector` in `text` gives
		 * `name` (an `@import` before the first rule is not part of its selector).
		 */
		const token = (text: string, selector: string, name: string) =>
			rulesOf(text)
				.filter((r) => r.selector.split(";").at(-1)!.trim() === selector)
				.flatMap((r) => r.decls)
				.filter(([n]) => n === name)
				.at(-1)?.[1];
		const theme = (file: string) =>
			fs.readFileSync(path.resolve(__dirname, "../../../client/themes", file), "utf8");
		const SOURCE = {
			day: {text: theme("creama.css"), selector: ":root", palette: ":root"},
			night: {
				text: theme("coffee.css"),
				selector: ":root",
				palette: ':root[data-ps-light="night"]',
			},
		};
		// ps.css's two palettes, the chrome section: each moved under rule 2 by hand.
		const MOVED: Array<[Light, string]> = [
			["day", "--event-join"],
			["day", "--event-quit"],
			["day", "--nick-default"],
			["day", "--tok-comment"],
			["night", "--nick-default"],
			["night", "--tok-comment"],
		];
		// Past rule 2 on purpose: a disconnected or parted row's name read 3.15:1 over
		// the brightest night glass in coffee's #e08a72, and the smallest move that
		// holds 4.5, +0.106, is past the 0.08; the user's decision 2A (2026-09-25).
		// Pinned to the value decided, so no other move slips through with it.
		const DECIDED: Array<[Light, string, string]> = [["night", "--event-quit", "#feaf98"]];

		const moved = (light: Light, name: string) => {
			const source = SOURCE[light];
			const was = token(source.text, source.selector, name);
			const now = token(css, source.palette, name);
			expect(was, `${light} ${name} in its source theme`).to.match(HEX);
			expect(now, `${light} ${name} in ps.css`).to.match(HEX);
			expect(now, `${light} ${name} moved`).to.not.equal(was);
			return {was: was!, now: now!, dL: Math.abs(L(now!) - L(was!))};
		};

		for (const [light, name] of MOVED) {
			const {was, now, dL} = moved(light, name);
			expect(dL, `${light} ${name} ${now} against ${was}`).to.be.at.most(0.08);
		}

		for (const [light, name, decided] of DECIDED) {
			expect(moved(light, name).now, `${light} ${name}, the user's decision`).to.equal(
				decided
			);
		}
	});

	it("holds every ink-treatment colour at 4.5:1, and faint ink at 3:1, over the moments the words are ink", function () {
		for (const h of heldColours().held.filter((x) => x.text === "ink")) {
			const w = h.box ? onBox(h) : worst(h.value, grounds().column.ink);
			expect(w.ratio, `${h.what} ${h.value} at ${w.where}`).to.be.at.least(h.floor);
		}
	});

	it(`holds every light-treatment colour to its floor under LIGHT_SWEEP "${SWEEP}", over the moments the words are light`, function () {
		for (const h of heldColours().held.filter((x) => x.text === "light")) {
			const list = groundsFor(h, grounds().column.light);
			const w = h.box
				? onBox(h)
				: h.faintWhite
				? worstFaintWhite(list)
				: worst(h.value, list);
			expect(w.ratio, `${h.what} ${h.value} at ${w.where}`).to.be.at.least(h.floor);
		}
	});

	it("holds every colour on a mentioned row, under the washes ps.css paints by day and by night", function () {
		const washes = mentionWashes();
		expect(washes.map((w) => w.text).sort()).to.deep.equal(["ink", "light"]);

		for (const wash of washes) {
			// The wash is mixed over the ground as the treatment leaves it: for these
			// washes and treatments that is the harder order (the ground ends up
			// darker by day, lighter by night) than the wash under the layer.
			const washed = grounds().column[wash.text].map((g) => {
				const hex = mix(g.hex, wash.hex, wash.strength);
				return {...g, hex, lum: luminance(hex)};
			});

			// A code box is opaque: the wash never reaches what it draws.
			for (const h of heldColours().held.filter((x) => x.text === wash.text && !x.box)) {
				const list = groundsFor(h, washed);
				const w = h.faintWhite ? worstFaintWhite(list) : worst(h.value, list);
				expect(w.ratio, `${h.what} ${h.value} on a mention at ${w.where}`).to.be.at.least(
					h.floor
				);
			}
		}
	});

	it("holds the reaction row's \"+\" to 4.5:1 at rest and hovered, in both treatments, over the sky, the bodies and a mention's wash", function () {
		// The "+" (.msg-reaction-add) is not glass (its chip keeps style.css's
		// grey tint) and it is the button's only label: text, at 4.5. style.css
		// draws it in --body-color-muted at an opacity (hovered: --body-color at
		// 1), over the chips' tint, under the column's layer. An element's
		// opacity composites the whole chip over the ground it stands on, so
		// the glyph is mix(ground, colour, opacity) and the pixels round it
		// mix(ground, layer over chip over ground, opacity).
		const style = fs.readFileSync(
			path.resolve(__dirname, "../../../client/css/style.css"),
			"utf8"
		);
		const last = (text: string, selector: string, name: string) =>
			rulesOf(text)
				.filter((r) => r.selector === selector)
				.flatMap((r) => r.decls)
				.filter(([n]) => n === name)
				.at(-1)?.[1];
		const opacity = Number(
			last(css, "#chat .msg-reaction-add", "opacity") ??
				last(style, "#chat .msg-reaction-add", "opacity")
		);
		const tint = rgbPercent(last(style, "#chat .msg-reaction", "background") ?? "");
		expect(opacity, "the +'s opacity").to.be.within(0, 1);
		expect(tint, "the chips' tint").to.not.equal(null);
		const token = (selector: string, name: string) =>
			rulesOf(messageBlock)
				.find((r) => r.selector === selector)!
				.decls.find(([n]) => n === name)![1];
		const COLOUR: Record<Text, {rest: string; hover: string}> = {
			ink: {
				rest: token("#chat .chat", "--body-color-muted"),
				hover: token("#chat .chat", "--body-color"),
			},
			light: {
				rest: token(LIGHT_ROOT, "--body-color-muted"),
				hover: token(LIGHT_ROOT, "--body-color"),
			},
		};
		const washes = mentionWashes();
		const worstOf: Record<string, {ratio: number; where: string}> = {};

		const visit = (m: Moment, p: Palette, where: string) => {
			const {text, halo} = publishedFor(p, m);

			for (const g of sceneGrounds(m, p)) {
				const unders = [
					{hex: g.hex, on: ""},
					...washes
						.filter((w) => w.text === text)
						.map((w) => ({hex: mix(g.hex, w.hex, w.strength), on: ", a mention"})),
				];

				for (const under of unders) {
					const chip = mix(under.hex, tint!.hex, tint!.strength);
					const layered = effectiveGround(chip, text, halo);

					for (const [state, colour, op] of [
						["rest", COLOUR[text].rest, opacity],
						["hover", COLOUR[text].hover, 1],
					] as const) {
						const ratio = contrast(
							mix(under.hex, colour, op),
							mix(under.hex, layered, op)
						);
						const key = `${text} ${state}`;

						if (!worstOf[key] || ratio < worstOf[key].ratio) {
							worstOf[key] = {ratio, where: `${where}, ${g.name}${under.on}`};
						}
					}
				}
			}
		};

		eachChecked(visit, "sparse");

		for (const where of pinned()) {
			const m = momentAt(where);
			visit(m, paletteAt(m), where);
		}

		expect(Object.keys(worstOf).sort()).to.deep.equal([
			"ink hover",
			"ink rest",
			"light hover",
			"light rest",
		]);

		for (const [key, w] of Object.entries(worstOf)) {
			expect(w.ratio, `the "+" (${key}, opacity ${opacity}) at ${w.where}`).to.be.at.least(
				4.5
			);
		}
	});

	it("reads the glass block: a token rule and 32 nicks for each light, nothing else", function () {
		const g = glassDeclared();
		expect(g.rules.length).to.equal(66);

		for (const light of ["day", "night"] as const) {
			expect(Object.keys(g[light].tokens).sort()).to.deep.equal([
				"--ps-g-accent-text",
				"--ps-g-badge",
				"--ps-g-soft",
				"--ps-g-tint-a",
			]);
			const alpha = Number(g[light].tokens["--ps-g-tint-a"]);
			expect(alpha).to.be.within(GLASS[light].base, GLASS[light].cap);
			expect(g[light].tokens["--ps-g-soft"]).to.match(HEX);
			expect(g[light].tokens["--ps-g-badge"]).to.match(HEX);
			expect(g[light].tokens["--ps-g-accent-text"]).to.match(HEX);
			expect(g[light].nicks.map((n) => n.decls.length)).to.deep.equal(Array(32).fill(1));

			for (const n of g[light].nicks) {
				expect(n.decls[0][0]).to.equal("color");
				expect(n.decls[0][1], n.selector).to.match(HEX);
			}
		}
	});

	it("holds the luminous day glass at the tints the scene computes: ink, soft ink, the text accent and every nick at 4.5:1 over each surface's grounds through the brightened backdrop, the soft ink at 4.6", function () {
		const g = glassDeclared().day;
		const list = dayGlassGrounds("sparse", headers);
		expect(list.length).to.be.greaterThan(1000);
		expect(new Set(list.map((x) => x.surface))).to.have.lengthOf(4);

		for (const [what, colour] of [
			["ink", GLASS.day.ink],
			["--ps-g-soft", g.tokens["--ps-g-soft"]],
			["--ps-g-accent-text", g.tokens["--ps-g-accent-text"]],
			...g.nicks.map((n) => [n.selector, n.decls[0][1]]),
		]) {
			const w = worst(colour, list);
			expect(w.ratio, `day glass ${what} ${colour} at ${w.where}`).to.be.at.least(4.5);
		}

		// What the tint is solved to (glass.ts TEXT_SOLVE): the page's "worst glass text over the year, 4.60".
		const soft = worst(g.tokens["--ps-g-soft"], list);
		expect(Number(soft.ratio.toFixed(4)), soft.where).to.be.at.least(4.6);
	});

	for (const light of ["day", "night"] as const) {
		it(`holds the ${light} glass at its declared opacity (by day the fallback without the scene): ink, soft ink, the text accent and every nick at 4.5:1, the badge's white numeral at 4.5:1; and the text accent on the solid panel`, function () {
			const g = glassDeclared()[light];
			const list = underGlass(light);

			for (const [what, colour] of [
				["ink", GLASS[light].ink],
				["--ps-g-soft", g.tokens["--ps-g-soft"]],
				["--ps-g-accent-text", g.tokens["--ps-g-accent-text"]],
				...g.nicks.map((n) => [n.selector, n.decls[0][1]]),
			]) {
				const w = worst(colour, list);
				expect(w.ratio, `${light} glass ${what} ${colour} at ${w.where}`).to.be.at.least(
					4.5
				);
			}

			expect(contrast("#ffffff", g.tokens["--ps-g-badge"])).to.be.at.least(4.5);
			expect(
				contrast(g.tokens["--ps-g-accent-text"], GLASS[light].solid),
				`${light} --ps-g-accent-text on the solid ${GLASS[light].solid}`
			).to.be.at.least(4.5);
		});
	}

	it("holds the join green's marks at 3:1 on the day glass at its declared opacity, unfiltered: the phone's always-on glass (the header, the composer, the chips: no backdrop filter, the generated tint, spec §10.1)", function () {
		// The day glass's lightest mark (glass.ts DAY_GLASS_MARK, ps.css's day
		// --event-join: the connected icon, the subscribed bell, the typing
		// pulse). Through the luminous glass the tint is solved for it
		// (test/themes/ps.ts); without the filter only this tint carries it. At
		// night the chrome's floors test holds it on the declared tint already.
		const w = worst(DAY_GLASS_MARK, underGlass("day"));
		expect(w.ratio, `${DAY_GLASS_MARK} at ${w.where}`).to.be.at.least(3);
	});

	/** The moment a header pins by name, e.g. `dusk: doy 29 445 min clear`. */
	const pin = (name: string) => {
		const m = new RegExp(`${name}: (doy \\d+ \\d+ min [a-z]+)`).exec(headerOf(glassBlock));

		if (!m) {
			throw new Error(`the glass block's header pins no ${name} moment`);
		}

		return {where: m[1], moment: momentAt(m[1])};
	};

	it("Review Focus 1, dusk: at the darkest moment still under day glass, the glass ink and soft ink hold over the dusk sky", function () {
		const {where, moment} = pin("dusk");
		const p = paletteAt(moment);
		expect(publishedFor(p, moment).light, where).to.equal("day");
		expect(p.dark, where).to.be.above(0.49);
		const list = underGlass("day", groundsAt(moment, p, where).glass.day);
		expect(list.length).to.be.at.least(3);

		for (const colour of [GLASS.day.ink, glassDeclared().day.tokens["--ps-g-soft"]]) {
			const w = worst(colour, list);
			expect(w.ratio, `${colour} at ${w.where}`).to.be.at.least(4.5);
		}
	});

	it("Review Focus 2, moon: the moon's disc at full strength behind night glass, the glass ink and soft ink hold", function () {
		const {where, moment} = pin("moon");
		const p = paletteAt(moment);
		expect(publishedFor(p, moment).light, where).to.equal("night");
		const discs = bodyGrounds(moment, p).filter((g) => g.body === "moon");
		expect(discs.map((g) => g.name).join()).to.include("#fdfaf0 at 1.00");
		const list = underGlass(
			"night",
			groundsAt(moment, p, where).glass.night.filter((g) => g.body === "moon")
		);

		for (const colour of [GLASS.night.ink, glassDeclared().night.tokens["--ps-g-soft"]]) {
			const w = worst(colour, list);
			expect(w.ratio, `${colour} at ${w.where}`).to.be.at.least(4.5);
		}
	});
});
