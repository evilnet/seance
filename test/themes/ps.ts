import {expect} from "chai";
import fs from "fs";
import path from "path";
import {
	contrast,
	hexRgb,
	hexToOklch,
	luminance,
	oklchToHex,
	rgbHex,
} from "../../client/js/scenes/ps/colour";
import {momentFor, sunTimes} from "../../client/js/scenes/ps/engine";
import {
	DAY_BRIGHTNESS,
	DAY_GLASS_MARK,
	DAY_GLASS_TEXT,
	glassVars,
	GLASS_SURFACES as TINTED,
	MARK_SOLVE,
	SATURATE,
	TEXT_SOLVE,
	TINT_CAP,
	type GlassSurface,
} from "../../client/js/scenes/ps/glass";
import {GATES, liveLayers, type Gate} from "../../client/js/scenes/ps/layers";
import {paletteAt} from "../../client/js/scenes/ps/palette";
import {
	DECK_BAND,
	DECK_HEIGHT,
	LAND_SHARE,
	RAIN_DECK_HEIGHT,
	weatherLayers,
} from "../../client/js/scenes/ps/plains";
import {OVERCAST_FADE_MS, sceneMarkup, sceneVars} from "../../client/js/scenes/ps/scene";
import {
	checkedGrounds,
	dayGlassGrounds,
	glassGround,
	withPinned,
	type Light,
} from "../../tools/ps/legibility";
import bird from "../../tools/heart/rigs/bird.mjs";
import bunny from "../../tools/heart/rigs/bunny.mjs";
import deer from "../../tools/heart/rigs/deer.mjs";
import frog from "../../tools/heart/rigs/frog.mjs";
import horse from "../../tools/heart/rigs/horse.mjs";
import kitten from "../../tools/heart/rigs/kitten.mjs";
import ladybug from "../../tools/heart/rigs/ladybug.mjs";
import puppy from "../../tools/heart/rigs/puppy.mjs";

const css = fs.readFileSync(path.resolve(__dirname, "../../client/themes/ps.css"), "utf8");
const coffee = fs.readFileSync(path.resolve(__dirname, "../../client/themes/coffee.css"), "utf8");

describe("the ps theme (client/themes/ps.css)", function () {
	it("is coffee's rules with its own tokens", function () {
		expect(css.startsWith("/*")).to.be.true;
		expect(css).to.include('@import "coffee.css";');
		expect(css).to.include("color-scheme: light;");
		expect(css).to.match(/^\s*--chat-bg:/m);
	});
});

/* ---- reading the stylesheet ---- */

interface Rule {
	/** The at-rules around the rule, outermost first, joined by a space ("" at the top level). */
	at: string;
	selectors: string[];
	decls: Array<[string, string]>;
}

/** A selector list split on its top-level commas: the comma inside `:not(a, b)` stays put. */
function splitSelectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < list.length; i++) {
		if (list[i] === "(") {
			depth++;
		} else if (list[i] === ")") {
			depth--;
		} else if (list[i] === "," && depth === 0) {
			out.push(list.slice(start, i));
			start = i + 1;
		}
	}

	out.push(list.slice(start));
	return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Every style rule in `text`, comments dropped, with the at-rules around it (@media, @supports…). */
function rulesIn(text: string): Rule[] {
	const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: Rule[] = [];
	const at: string[] = [];
	let start = 0;

	for (let i = 0; i < src.length; i++) {
		if (src[i] === "{") {
			const prelude = src.slice(start, i).trim();

			if (prelude.startsWith("@")) {
				at.push(prelude);
				start = i + 1;
				continue;
			}

			const end = src.indexOf("}", i);
			out.push({
				at: at.join(" "),
				selectors: splitSelectors(prelude),
				decls: src
					.slice(i + 1, end)
					.split(";")
					.map((d) => d.trim())
					.filter(Boolean)
					.map((d) => [
						d.slice(0, d.indexOf(":")).trim(),
						d.slice(d.indexOf(":") + 1).trim(),
					]),
			});
			i = end;
			start = end + 1;
		} else if (src[i] === "}") {
			at.pop();
			start = i + 1;
		} else if (src[i] === ";") {
			start = i + 1; // the end of @import, or of a declaration in @font-face
		}
	}

	return out;
}

/** A selector's specificity: ids, classes (attributes and pseudo-classes too), types. */
type Specificity = [number, number, number];

function compareSpecificity(a: Specificity, b: Specificity): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Enough of Selectors 4 for the selectors these stylesheets write: :where() weighs nothing, :not()/:is()/:has() their heaviest argument. */
function specificity(selector: string): Specificity {
	const out: Specificity = [0, 0, 0];
	const rest = selector
		.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "")
		.replace(/:(?:not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, args: string) => {
			const heaviest = splitSelectors(args).map(specificity).sort(compareSpecificity).at(-1);
			heaviest?.forEach((n, i) => (out[i] += n));
			return "";
		})
		.replace(/\[[^\]]*\]/g, () => {
			out[1]++;
			return "";
		})
		.replace(/::[\w-]+/g, () => {
			out[2]++;
			return "";
		});
	out[0] += (rest.match(/#[\w-]+/g) ?? []).length;
	out[1] += (rest.match(/\.[\w-]+|:[\w-]+/g) ?? []).length;
	out[2] += (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
	return out;
}

/**
 * Which glass surface (GLASS_SURFACES) a selector's subject is, in any state
 * (:hover, a state class of #viewport or <html> around it), or null: the last
 * compound names it, and is not a pseudo-element of it or a chip the glass
 * leaves out (the pressed one, the "+").
 */
function subjectOf(selector: string): string | null {
	const compounds = selector.replace(/\((?:[^()]|\([^()]*\))*\)/g, "()").split(/\s*[\s>+~]\s*/);
	const last = compounds.at(-1) ?? "";
	const bare = (selector.split(/\s*[\s>+~]\s*(?![^(]*\))/).at(-1) ?? "").replace(
		/:not\((?:[^()]|\([^()]*\))*\)/g,
		""
	);
	const inChat = /(^|\s)#chat(?![\w-])/.test(selector);

	if (last.includes("::")) {
		return null;
	}

	if (/#sidebar(?![\w-])/.test(last)) {
		return "#sidebar";
	}

	if (/#form(?![\w-])/.test(last)) {
		return "#form";
	}

	if (inChat && /\.header(?![\w-])/.test(last)) {
		return "#chat .header";
	}

	if (inChat && /\.userlist(?![\w-])/.test(last)) {
		return "#chat .userlist";
	}

	if (inChat && /\.msg-reaction(?![\w-])/.test(bare) && !/\.self(?![\w-])/.test(bare)) {
		return "#chat .msg-reaction:not(.self, .msg-reaction-add)";
	}

	return null;
}

const rules = rulesIn(css);
const DAY = ":root";
const NIGHT = ':root[data-ps-light="night"]';
const REDUCED_TRANSPARENCY = "@media (prefers-reduced-transparency: reduce)";

/** The declarations every top-level rule naming `selector` gives it, in source order. */
function declsOf(selector: string, at = "", list = rules): Array<[string, string]> {
	return list
		.filter((r) => r.at === at && r.selectors.includes(selector))
		.flatMap((r) => r.decls);
}

/** The last value `selector` gets for `property`, or undefined. */
function valueOf(selector: string, property: string, at = ""): string | undefined {
	return declsOf(selector, at)
		.filter(([p]) => p === property)
		.at(-1)?.[1];
}

/**
 * The custom properties <html> holds in one light: coffee.css's :root, then
 * every top-level :root rule in ps.css, then (at night) its night rules.
 */
function paletteOf(light: "day" | "night"): Map<string, string> {
	const out = new Map<string, string>();

	const take = (decls: Array<[string, string]>) => {
		for (const [p, v] of decls) {
			if (p.startsWith("--")) {
				out.set(p, v);
			}
		}
	};

	take(declsOf(DAY, "", rulesIn(coffee)));
	take(declsOf(DAY));

	if (light === "night") {
		take(declsOf(NIGHT));
	}

	return out;
}

/** `value` with every var() replaced from `palette`, recursively. */
function resolve(palette: Map<string, string>, value: string, depth = 0): string {
	if (depth > 20) {
		throw new Error(`a var() cycle through ${value}`);
	}

	return value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback) => {
		const v = palette.get(name) ?? fallback;

		if (v === undefined) {
			throw new Error(`${name} is not defined`);
		}

		return resolve(palette, v, depth + 1);
	});
}

/** A resolved colour as [r, g, b, alpha]. */
function rgba(value: string): [number, number, number, number] {
	const v = value.trim();

	if (v === "transparent") {
		return [0, 0, 0, 0];
	}

	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];

	if (hex) {
		const six = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
		const [r, g, b] = [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16));
		return [r, g, b, 1];
	}

	const m = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(v);

	if (!m) {
		throw new Error(`not a colour this test reads: ${value}`);
	}

	const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
	return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

/** `colour` composited over the opaque `ground`, as #rrggbb. */
function over(colour: string, ground: string): string {
	const [r, g, b, a] = rgba(colour);
	const [R, G, B] = hexRgb(ground);
	return rgbHex(r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a));
}

/** The token list coffee.css reads, as the plan-1 test had it. */
const COFFEE_TOKENS = [
	"--chat-fg",
	"--chat-fg-muted",
	"--chat-fg-faint",
	"--chat-heading",
	"--chat-rule",
	"--chat-accent",
	"--chat-accent-fg",
	"--chat-accent-rule",
	"--chat-highlight-bg",
	"--chat-selection",
	"--composer-bg",
	"--composer-border",
	"--window-border",
	"--window-shadow",
	"--menu-bg",
	"--rail-bg-top",
	"--rail-bg-bottom",
	"--rail-fg",
	"--rail-fg-strong",
	"--rail-fg-active",
	"--rail-fg-muted",
	"--rail-item-active-bg",
	"--rail-item-hover-bg",
	"--rail-accent",
	"--rail-accent-fg",
	"--rail-badge-bg",
	"--rail-badge-fg",
	"--rail-input-bg",
	"--rail-input-border",
	"--event-join",
	"--event-quit",
	"--nick-default",
	"--notice-color",
	"--action-color",
	"--note-bg",
	"--note-fg",
	"--warn-bg",
	"--warn-fg",
	"--error-bg",
	"--error-fg",
	"--ok-bg",
	"--ok-fg",
	"--tint-soft",
	"--tint-strong",
	"--accent-tint-20",
	"--accent-tint-30",
	"--focus-ring",
	"--scrollbar-track",
	"--scrollbar-thumb",
	"--scrollbar-thumb-active",
	"--tok-comment",
	"--tok-keyword",
	"--tok-string",
	"--tok-number",
	"--tok-function",
	"--tok-operator",
	"--tok-punctuation",
	"--tok-tag",
	"--tok-attr",
];

/**
 * The surfaces, as Task 4's walk classified them
 * (.superpowers/sdd/2026-09-24-ps-plan2-chrome/task-4-report.md): glass is
 * tinted and blurred over the plains, solid is the glass's opaque colour.
 * The composer is one glass surface: its bars are its children. The chips
 * leave the pressed (.self) and add (+) chips their own tints.
 */
const GLASS_SURFACES = [
	"#sidebar",
	"#chat .header",
	"#chat .userlist",
	"#form",
	"#chat .msg-reaction:not(.self, .msg-reaction-add)",
];

const SOLID_SURFACES = [
	".settings-modal",
	"#help",
	"#changelog",
	"#connect",
	"#context-menu",
	".mentions-popup",
	".textcomplete-menu",
	".reaction-picker",
	".reaction-picker-heading",
	"#upload-preview",
	"#confirm-dialog",
	"#push-prompt",
	".scroll-down-arrow",
];

/** The dialogs whose .vue files hardcode white text, fine on coffee's dark body and not on paper. */
const WHITE_TEXT_DIALOGS = ["#confirm-dialog", "#upload-preview", "#push-prompt"];

/** By day each surface reads its own tint (--ps-g-tint: the scene's for that surface, or the generated one); at night the generated one. */
const TINT_DAY = "rgb(255 251 244 / var(--ps-g-tint))";
const TINT_NIGHT = "rgb(12 17 32 / var(--ps-g-tint-a))";
/** The glass's backdrop: brightened (--ps-g-lift) by day while the scene runs, never at night or without it. */
const GLASS_FILTER = `blur(0.625rem) var(--ps-g-lift,) saturate(${SATURATE})`;
/** Where the scene is running and it is day: the one place the backdrop is brightened. */
const DAY_SCENE = ':root[data-ps-light="day"]';
const PHONE =
	"@media (max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse)";
/** style.css's user list laid over a narrow chat pane, the condition verbatim. */
const OVERLAID = "@container chat (max-width: calc(50ch + 8.5rem + 84px))";
/**
 * The phone's two overlays (Task 8c), by style.css's own state classes: the
 * drawer while it is on screen (open, or following a swipe) and the user
 * list, which on the phone is laid over the chat whenever it is shown.
 */
const PHONE_OVERLAYS = [
	"#viewport.menu-open #sidebar",
	"#viewport.menu-dragging #sidebar",
	"#viewport.userlist-open #chat .userlist",
];
/** The same two overlays in any state, and the glass always on the phone's screen. */
const PHONE_OVERLAID = ["#sidebar", "#chat .userlist"];
const ALWAYS_ON = [
	"#chat .header",
	"#form",
	":root.ps-form-tall #form",
	"#chat .msg-reaction:not(.self, .msg-reaction-add)",
];
/** Which of the scene's day tints each glass surface reads (client/js/scenes/ps/glass.ts). */
const TINT_OF: Record<string, GlassSurface> = {
	"#chat .header": "header",
	"#form": "composer",
	"#sidebar": "side",
	"#chat .userlist": "side",
	"#chat .msg-reaction:not(.self, .msg-reaction-add)": "float",
};
const readsTint = (s: GlassSurface) => `var(--ps-g-tint-${s}, var(--ps-g-tint-a))`;

describe("the ps theme's chrome: glass over the plains (docs/projects/ps-theme.md §6)", function () {
	it("defines every token coffee.css reads twice: the day palette on :root, the night one under :root[data-ps-light=night]", function () {
		const day = new Set(declsOf(DAY).map(([p]) => p));
		const night = new Set(declsOf(NIGHT).map(([p]) => p));

		for (const token of COFFEE_TOKENS) {
			expect(day.has(token), `${token} on :root`).to.be.true;
			expect(night.has(token), `${token} at night`).to.be.true;
		}
	});

	it("takes the spec's glass primaries, and the generated tint, soft ink and badge", function () {
		const spec = {
			day: {
				"--ps-g-solid": "#fbf8f2",
				"--ps-g-ink": "#1f2a3d",
				"--ps-g-edge": "rgb(255 255 255 / 55%)",
				"--ps-g-field": "rgb(255 255 255 / 72%)",
				"--ps-g-selected": "rgb(255 255 255 / 60%)",
				"--ps-g-accent": "#c2562b",
			},
			night: {
				"--ps-g-solid": "#121827",
				"--ps-g-ink": "#e9eef7",
				"--ps-g-edge": "rgb(255 255 255 / 9%)",
				"--ps-g-field": "rgb(255 255 255 / 7%)",
				// The spec's white 11 % lifted the ground toward the light text on it;
				// on the glass every wash deepens toward black at night (the user's pick, 2026-09-25).
				"--ps-g-selected": "rgb(0 0 0 / 60%)",
				"--ps-g-accent": "#d9784a",
			},
		};

		for (const light of ["day", "night"] as const) {
			const p = paletteOf(light);

			for (const [token, want] of Object.entries(spec[light])) {
				expect(resolve(p, `var(${token})`), `${light} ${token}`).to.equal(want);
			}

			for (const token of [
				"--ps-g-tint-a",
				"--ps-g-soft",
				"--ps-g-badge",
				"--ps-g-accent-text",
			]) {
				expect(p.has(token), `${light} ${token}`).to.be.true;
			}
		}

		// Generated, not hand-written: only the glass block declares the text accent, once a light.
		const block = css.slice(
			css.indexOf("/* ps:glass-palette:start"),
			css.indexOf("/* ps:glass-palette:end */")
		);
		const declared = (text: string) => text.match(/^\s*--ps-g-accent-text:/gm)?.length ?? 0;
		expect(declared(css), "in ps.css").to.equal(2);
		expect(declared(block), "in the glass block").to.equal(2);

		expect(resolve(paletteOf("day"), "var(--rail-badge-bg)")).to.equal(
			resolve(paletteOf("day"), "var(--ps-g-badge)")
		);
		expect(resolve(paletteOf("night"), "var(--rail-badge-bg)")).to.equal(
			resolve(paletteOf("night"), "var(--ps-g-badge)")
		);
	});

	it("clears the rail's gradient: the glass paints the sidebar", function () {
		for (const light of ["day", "night"] as const) {
			expect(resolve(paletteOf(light), "var(--rail-bg-top)")).to.equal("transparent");
			expect(resolve(paletteOf(light), "var(--rail-bg-bottom)")).to.equal("transparent");
		}
	});

	it("writes and marks with the text accent, and keeps the spec's accent for the open row's marker", function () {
		for (const light of ["day", "night"] as const) {
			const p = paletteOf(light);
			expect(resolve(p, "var(--chat-accent)"), light).to.equal(
				resolve(p, "var(--ps-g-accent-text)")
			);
			expect(resolve(p, "var(--rail-accent)"), light).to.equal(
				resolve(p, "var(--ps-g-accent)")
			);
		}

		expect(
			valueOf(".channel-list-item .connection-status-icon.is-connecting::before", "color")
		).to.equal("var(--ps-g-accent-text)");
		expect(
			valueOf(
				"#chat .msg-reaction:not(.self, .msg-reaction-add):focus-visible",
				"border-color"
			)
		).to.equal("var(--ps-g-accent-text)");
	});

	it("starts the phone's scrim at the drawer's inner edge, so the drawer frosts the plains, not the scrim", function () {
		const style = fs.readFileSync(
			path.resolve(__dirname, "../../client/css/style.css"),
			"utf8"
		);
		expect(style, "style.css's phone block, the same list").to.include(`${PHONE} {`);
		// Physical, as style.css places the drawer (right: 100% and a translate).
		expect(valueOf("#sidebar-overlay", "left", PHONE)).to.equal("var(--sidebar-width)");
	});

	it("washes the glass away from its text: lighter by day, toward black at night, the solid panels keeping their tints", function () {
		for (const s of ["#sidebar", "#chat .header", "#chat .userlist", "#form"]) {
			expect(valueOf(s, "--tint-soft"), s).to.equal("var(--ps-g-wash-soft)");
			expect(valueOf(s, "--tint-strong"), s).to.equal("var(--ps-g-wash-strong)");
		}

		const [day, night] = [paletteOf("day"), paletteOf("night")];

		for (const token of ["--ps-g-wash-soft", "--ps-g-wash-strong", "--rail-item-hover-bg"]) {
			expect(resolve(day, `var(${token})`), `day ${token}`).to.match(/^rgb\(255 255 255 \//);
			expect(resolve(night, `var(${token})`), `night ${token}`).to.match(/^rgb\(0 0 0 \//);
		}

		expect(resolve(night, "var(--rail-item-active-bg)")).to.match(/^rgb\(0 0 0 \//);
		// The solid panels' tints stay creama's and coffee's.
		expect(resolve(day, "var(--tint-strong)")).to.equal("rgb(0 0 0 / 8%)");
		expect(resolve(night, "var(--tint-strong)")).to.equal("rgb(255 255 255 / 8%)");
	});

	it("keeps the user list's blur while a disconnected conversation fades: the fade is on the messages and the jump-to-recent disc, and eases both ways", function () {
		expect(valueOf("#chat.disconnected .chat-content", "opacity")).to.equal("1");
		expect(valueOf("#chat.disconnected .chat-content > .chat", "opacity")).to.equal("0.55");
		// The transition on the base rule, as style.css puts it on .chat-content's:
		// under .disconnected alone it would fade out and snap back on reconnect.
		expect(valueOf("#chat .chat-content > .chat", "transition")).to.equal("opacity 0.3s ease");
		expect(valueOf("#chat.disconnected .chat-content > .chat", "transition")).to.equal(
			undefined
		);
		// The disc fades with the conversation it jumps in: the arrow, since
		// .scroll-down's own opacity is what shows and hides it. Its transition
		// keeps style.css's background and colour ones beside the fade.
		expect(valueOf("#chat.disconnected .scroll-down-arrow", "opacity")).to.equal("0.55");
		expect(valueOf("#chat.disconnected .scroll-down", "opacity")).to.equal(undefined);
		expect(valueOf("#chat .scroll-down-arrow", "transition")).to.equal(
			"background 0.2s, color 0.2s, opacity 0.3s ease"
		);
	});

	it("tints the upload preview's rows and thumbnail backing instead of greying them", function () {
		expect(valueOf("#upload-preview .upload-preview-item", "background")).to.equal(
			"var(--tint-soft)"
		);
		expect(valueOf("#upload-preview .upload-preview-media", "background")).to.equal(
			"var(--tint-strong)"
		);
	});

	it("sets the windows flush with the sidebar, square and flat: none of day.css's floating card", function () {
		// The user, 2026-09-25: "I don't like the pop-out look (the 3d look) of the channel frame,
		// the way it separates from the network panel; … I don't like the round corners".
		expect(valueOf("#viewport", "padding")).to.equal("0");
		expect(valueOf("#viewport.menu-open", "padding")).to.equal("0");
		expect(valueOf(".window", "border-radius")).to.equal("0");
		expect(valueOf(".window", "box-shadow")).to.equal("none");
		expect(valueOf("#loading .window", "margin")).to.equal("0");
	});

	it("gives ps the daylight fallback's canvas as its theme-color before the scene loads", function () {
		const config = fs.readFileSync(
			path.resolve(__dirname, "../../client/js/configuration.ts"),
			"utf8"
		);
		const canvas = valueOf(DAY, "--canvas-bg-color");
		expect(canvas).to.equal("#3f8fe6");
		expect(config).to.include(`{name: "ps", displayName: "ps", themeColor: "${canvas}"}`);
	});

	it("draws both badges alike, the generated fill and a white numeral: the mockup's one badge", function () {
		expect(valueOf(".channel-list-item .badge.highlight", "background")).to.equal(
			"var(--rail-badge-bg)"
		);
		expect(valueOf(".channel-list-item .badge.highlight", "color")).to.equal(
			"var(--rail-badge-fg)"
		);
	});

	for (const selector of GLASS_SURFACES) {
		it(`makes ${selector} glass: the tint, swapped at night, and a 0.625rem blur`, function () {
			expect(valueOf(selector, "background-color"), "the day tint").to.equal(TINT_DAY);
			expect(valueOf(`${NIGHT} ${selector}`, "background-color"), "the night tint").to.equal(
				TINT_NIGHT
			);

			for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
				expect(valueOf(selector, property), property).to.equal(GLASS_FILTER);
			}
		});
	}

	it("gives each glass surface its day tint: the scene's for that surface (glass.ts), the generated one without the scene", function () {
		expect(Object.keys(TINT_OF)).to.have.members(GLASS_SURFACES);

		for (const [selector, surface] of Object.entries(TINT_OF)) {
			expect(valueOf(selector, "--ps-g-tint"), selector).to.equal(readsTint(surface));
		}

		// (On the phone layout the always-on glass reads no scene tint, the
		// budget's fallback, and the two overlays read the chips': the next two
		// tests.)

		// A user list laid over a narrow pane, under style.css's own condition,
		// stands over the chat, the yurt included.
		const style = rulesIn(
			fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8")
		);
		expect(
			declsOf("#chat .userlist", OVERLAID, style),
			"style.css lays the list over the pane under the same condition"
		).to.deep.include(["position", "absolute"]);
		expect(valueOf("#chat .userlist", "--ps-g-tint", OVERLAID)).to.equal(readsTint("float"));

		// A composer risen above the near grass (the scene's ps-form-tall on <html>) stands over the yurt too.
		expect(valueOf(":root.ps-form-tall #form", "--ps-g-tint")).to.equal(readsTint("float"));
		expect(
			rules
				.filter((r) => r.selectors.some((s) => s.includes("ps-form-tall")))
				.map((r) => r.at),
			"at the top level, after #form's own; and restated by the phone's fallback"
		).to.deep.equal(["", PHONE]);
		// The band's top the scene measures against is the land's (plains.ts LAND_SHARE, ps.css .ps-land).
		const land = /^([\d.]+)%$/.exec(valueOf("#theme-scene .ps-land", "height") ?? "");
		expect(Number(land?.[1]) / 100, "the land's height").to.be.closeTo(LAND_SHARE, 1e-9);

		// The names the scene publishes are the ones read, and the fallback is the solver's cap.
		const names = Object.keys(glassVars({doy: 172, minute: 750, weather: "clear"}, "day"));
		expect(names.sort()).to.deep.equal(TINTED.map((s) => `--ps-g-tint-${s}`).sort());
		expect(resolve(paletteOf("day"), "var(--ps-g-tint-a)")).to.equal(String(TINT_CAP));
	});

	it("drops the glass's backdrop filter on the phone layout, the measured budget's fallback (spec §10): no blur and no brightening, and the always-on glass on the generated tint, never the scene's (the two overlays shown: the next test)", function () {
		// The composer risen above the grass is named too: its top-level rule
		// outranks a bare #form. The drawer and the user list are named bare:
		// put away they carry no filter either, and the next test's state
		// selectors give them their glass while they are shown.
		const surfaces = [...GLASS_SURFACES, ":root.ps-form-tall #form"];

		for (const selector of surfaces) {
			for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
				expect(valueOf(selector, property, PHONE), `${selector} ${property}`).to.equal(
					"none"
				);
			}

			// The scene's tints are solved through brightness(1.3), so without it
			// only the generated tint is proven (--ps-g-tint-a: the legibility
			// model's, which counts no filter); the night glass reads it already.
			// The drawer and the list keep the chips' in every state (the next test).
			if (!PHONE_OVERLAID.includes(selector)) {
				expect(valueOf(selector, "--ps-g-tint", PHONE), selector).to.equal(
					"var(--ps-g-tint-a)"
				);
			}
		}

		// (Which rules on the phone read a scene tint at all: the next test.)
		expect(resolve(paletteOf("day"), "var(--ps-g-tint-a)")).to.equal(String(TINT_CAP));
		expect(resolve(paletteOf("night"), "var(--ps-g-tint-a)")).to.equal("0.74");

		// It wins by coming last: every other rule that gives one of these
		// selectors a tint or a filter (the glass, its tints, the overlaid user
		// list, the risen composer) is written before it, with the same selector.
		// Reduced transparency's solid comes after it and still wins.
		for (const property of ["--ps-g-tint", "backdrop-filter", "-webkit-backdrop-filter"]) {
			const sets = (r: Rule) =>
				r.decls.some(([p]) => p === property) &&
				r.selectors.some((s) => surfaces.includes(s));
			const fallback = rules.findIndex((r) => r.at === PHONE && sets(r));
			const others = rules.filter(
				(r) => r.at !== PHONE && r.at !== REDUCED_TRANSPARENCY && sets(r)
			);
			expect(fallback, `${property}: the fallback sets it`).to.be.at.least(0);
			expect(others.length, `${property}: the rules it overrides`).to.be.at.least(1);

			for (const r of others) {
				expect(rules.indexOf(r), `${property}: ${r.selectors.join(", ")}`).to.be.below(
					fallback
				);
			}
		}
	});

	it("gives the phone's two overlays their glass back (Task 8c, spec §10.1): the drawer on screen and the overlaid user list take the chips' tint and the blur, brightened by day, while the always-on glass keeps the fallback", function () {
		// The state classes are the app's own: style.css's phone block moves the
		// drawer and shows the list by them.
		const style = rulesIn(
			fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8")
		);

		for (const selector of PHONE_OVERLAYS) {
			expect(
				style.some((r) => r.at === PHONE && r.selectors.includes(selector)),
				`style.css's phone block names ${selector}`
			).to.equal(true);
		}

		// As before the fallback (8077585b): the chips' tint, which holds over
		// every ground, since both lie over the chat, the yurt included, in
		// every state (a tint that changed on opening would ease over --ps-flip
		// while the drawer slid in); and, shown, the glass's one filter.
		for (const selector of PHONE_OVERLAID) {
			expect(valueOf(selector, "--ps-g-tint", PHONE), selector).to.equal(readsTint("float"));
		}

		for (const selector of PHONE_OVERLAYS) {
			expect(
				declsOf(selector, PHONE)
					.map(([p]) => p)
					.filter((p) => p !== "transition"),
				`${selector} sets the filter alone (and the drawer's states its timing: the next test)`
			).to.deep.equal(["-webkit-backdrop-filter", "backdrop-filter"]);

			for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
				expect(valueOf(selector, property, PHONE), `${selector} ${property}`).to.equal(
					GLASS_FILTER
				);
			}
		}

		// Brightened by day, blur and saturation alone at night: the lift is the day scene's only.
		const filterIn = (palette: Map<string, string>) =>
			resolve(palette, GLASS_FILTER).replace(/\s+/g, " ");
		const day = paletteOf("day");

		for (const [p, v] of declsOf(DAY_SCENE)) {
			day.set(p, v);
		}

		expect(filterIn(day), "by day").to.equal(
			`blur(0.625rem) brightness(${DAY_BRIGHTNESS}) saturate(${SATURATE})`
		);
		expect(filterIn(paletteOf("night")), "at night").to.equal(
			`blur(0.625rem) saturate(${SATURATE})`
		);

		// The shown overlays are the only glass on the phone, and the drawer and
		// the list the only surfaces there reading a scene tint, the chips' alone:
		// the header, the composer (risen or not) and the chips keep the fallback.
		for (const selector of ALWAYS_ON) {
			for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
				expect(valueOf(selector, property, PHONE), `${selector} ${property}`).to.equal(
					"none"
				);
			}

			expect(valueOf(selector, "--ps-g-tint", PHONE), selector).to.equal(
				"var(--ps-g-tint-a)"
			);
		}

		expect(
			rules
				.filter(
					(r) =>
						r.at === PHONE &&
						r.decls.some(([p, v]) => /backdrop-filter$/.test(p) && v !== "none")
				)
				.map((r) => r.selectors),
			"the glass on the phone"
		).to.deep.equal([PHONE_OVERLAYS]);
		const sceneTints = (r: Rule) =>
			r.decls.flatMap(([, v]) =>
				[...v.matchAll(new RegExp(`--ps-g-tint-(${TINTED.join("|")})\\b`, "g"))].map(
					(m) => m[1]
				)
			);
		expect(
			rules
				.filter((r) => r.at === PHONE && sceneTints(r).length > 0)
				.map((r) => ({selectors: r.selectors, tints: sceneTints(r)})),
			"the scene's tints read on the phone"
		).to.deep.equal([{selectors: PHONE_OVERLAID, tints: ["float"]}]);

		// Each shown state is a bare overlay under a state class of #viewport, an
		// id and a class more, so it outranks the bare rule's none; it is
		// written after it too.
		const bare = rules.findIndex(
			(r) => r.at === PHONE && r.selectors.join() === PHONE_OVERLAID.join()
		);
		const overlays = rules.findIndex(
			(r) => r.at === PHONE && r.selectors.includes(PHONE_OVERLAYS[0])
		);
		expect(bare, "the bare overlays' rule").to.be.at.least(0);
		expect(overlays, "after the bare rule").to.be.above(bare);

		for (const selector of PHONE_OVERLAYS) {
			const surface = /^#viewport\.[\w-]+ (.+)$/.exec(selector)?.[1] ?? "";
			expect(PHONE_OVERLAID, `${selector} is a bare overlay's state`).to.include(surface);
		}

		// The user list's sticky mode headings take the list's tint: nothing on the phone gives them their own.
		expect(declsOf("#chat .userlist .user-mode::before", PHONE)).to.deep.equal([]);

		// Reduced transparency still wins. A bare #sidebar there would lose to the
		// state selector on specificity, so it names each one itself, later.
		for (const selector of PHONE_OVERLAYS) {
			const at = rules.findIndex(
				(r) => r.at === REDUCED_TRANSPARENCY && r.selectors.includes(selector)
			);
			expect(at, `${selector} under reduced transparency, after the overlays`).to.be.above(
				overlays
			);

			for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
				expect(
					valueOf(selector, property, REDUCED_TRANSPARENCY),
					`${selector} ${property}`
				).to.equal("none");
			}

			expect(valueOf(selector, "background-color", REDUCED_TRANSPARENCY)).to.equal(
				"var(--ps-g-solid)"
			);
		}
	});

	it("keeps the phone drawer's blur until it has slid off screen, and blurs it at once when it opens", function () {
		// The slide is style.css's: the phone block moves the drawer with a
		// transform over this long.
		const style = rulesIn(
			fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8")
		);
		const styleValue = (selector: string, property: string, at = "") =>
			declsOf(selector, at, style)
				.filter(([p]) => p === property)
				.at(-1)?.[1];
		const slide = styleValue("#sidebar", "transition", PHONE);
		const ms = /^transform (\d+)ms$/.exec(slide ?? "")?.[1];
		expect(ms, `style.css's slide (${slide})`).to.not.equal(undefined);

		// Both states keep the glass's own list (the slide, and the flip), and
		// add the filter's: closing, it changes only once the slide is over (a
		// 0 s change that late); opening, at once. Dropped with the slide's
		// start, the words behind the drawer showed through it all the way out.
		const flat = (value?: string) => value?.replace(/\s+/g, " ");
		const glass = flat(valueOf("#sidebar", "transition"));
		expect(glass, "the glass's list, the slide first").to.match(/^transform (\d+)ms, /);
		expect(glass).to.include(`transform ${ms}ms`);
		expect(flat(valueOf("#sidebar", "transition", PHONE)), "closed").to.equal(
			`${glass}, -webkit-backdrop-filter 0s linear ${ms}ms, backdrop-filter 0s linear ${ms}ms`
		);
		expect(flat(valueOf("#viewport.menu-open #sidebar", "transition", PHONE)), "open").to.equal(
			`${glass}, -webkit-backdrop-filter 0s, backdrop-filter 0s`
		);

		// A drag follows the finger with no transition at all (style.css's
		// none), the open drawer's too: restated after the open rule, which is
		// as specific.
		expect(styleValue("#viewport.menu-dragging #sidebar", "transition", PHONE)).to.equal(
			"none"
		);
		const timed = (selector: string) =>
			rules.findIndex(
				(r) =>
					r.at === PHONE &&
					r.selectors.includes(selector) &&
					r.decls.some(([p]) => p === "transition")
			);
		expect(timed("#viewport.menu-dragging #sidebar")).to.be.above(
			timed("#viewport.menu-open #sidebar")
		);
		expect(valueOf("#viewport.menu-dragging #sidebar", "transition", PHONE)).to.equal("none");

		// The user list never slides: style.css shows it with display (none
		// until userlist-open), and a transition never runs from display: none.
		expect(styleValue("#chat .userlist", "display")).to.equal("none");
		expect(styleValue("#viewport.userlist-open #chat .userlist", "display")).to.equal("flex");
		expect(valueOf("#chat .userlist", "transition", PHONE)).to.equal(undefined);
	});

	it("brightens the backdrop by day, only while the scene runs: brightness(1.3) before the saturation, and nowhere else", function () {
		expect(valueOf(DAY_SCENE, "--ps-g-lift")).to.equal(`brightness(${DAY_BRIGHTNESS})`);
		const lifts = rules.filter((r) => r.decls.some(([p]) => p === "--ps-g-lift"));
		expect(
			lifts.map((r) => ({at: r.at, selectors: r.selectors})),
			"no other rule lifts it: not :root (the fallback), not the night"
		).to.deep.equal([{at: "", selectors: [DAY_SCENE]}]);
		// Every blur on the page reads the lift the same way, so none is brightened but by day.
		const filters = rules.flatMap((r) =>
			r.decls.filter(([p, v]) => /backdrop-filter$/.test(p) && v !== "none").map(([, v]) => v)
		);
		expect(filters.length).to.be.at.least(2);
		expect([...new Set(filters)]).to.deep.equal([GLASS_FILTER]);
	});

	for (const selector of SOLID_SURFACES) {
		it(`makes ${selector} solid: --ps-g-solid`, function () {
			expect(valueOf(selector, "background-color")).to.equal("var(--ps-g-solid)");
		});
	}

	it("resolves the solid to #fbf8f2 by day and #121827 at night", function () {
		expect(resolve(paletteOf("day"), "var(--ps-g-solid)")).to.equal("#fbf8f2");
		expect(resolve(paletteOf("night"), "var(--ps-g-solid)")).to.equal("#121827");
	});

	it("keeps the message toolbar solid with the column: :root's window colour by day, the night solid under the light treatment", function () {
		// The toolbar's icons are the column's colours (style.css #chat .msg-action:
		// --body-color-muted), so its box follows the column's treatment, not the
		// chrome's light: style.css paints it --window-bg-color, which is the solid on
		// :root and the night glass's solid inside the column under the light treatment.
		expect(resolve(paletteOf("day"), "var(--window-bg-color)")).to.equal("#fbf8f2");
		expect(valueOf(':root[data-ps-text="light"] #chat .chat', "--window-bg-color")).to.equal(
			"#121827"
		);
	});

	it("gives the dialogs with white text in their .vue files the glass ink, and the drop target", function () {
		for (const selector of WHITE_TEXT_DIALOGS) {
			expect(valueOf(selector, "color"), selector).to.equal("var(--ps-g-ink)");
		}
	});

	it("draws the jump-to-recent disc in the glass ink on the solid", function () {
		expect(valueOf(".scroll-down-arrow", "color")).to.equal("var(--ps-g-ink)");
	});

	it("never puts a backdrop filter on #status-bar-tint or an ancestor of it (html, body)", function () {
		for (const r of rules) {
			const blurs = r.decls.some(([p, v]) => /backdrop-filter$/.test(p) && v !== "none");

			if (blurs) {
				for (const s of r.selectors) {
					expect(s, "a blurred selector").to.not.include("#status-bar-tint");
					expect(s, "a blurred selector").to.not.match(
						/^(html|body|:root)(\[[^\]]*\])*$/
					);
				}
			}
		}

		expect(
			rules.filter((r) => r.selectors.some((s) => s.includes("#status-bar-tint"))),
			"no rule for the tint at all"
		).to.deep.equal([]);
	});

	it("turns the glass solid under prefers-reduced-transparency: no blur, --ps-g-solid, by day and at night", function () {
		for (const selector of GLASS_SURFACES) {
			for (const s of [selector, `${NIGHT} ${selector}`]) {
				expect(valueOf(s, "background-color", REDUCED_TRANSPARENCY), s).to.equal(
					"var(--ps-g-solid)"
				);
				expect(valueOf(s, "backdrop-filter", REDUCED_TRANSPARENCY), s).to.equal("none");
				expect(valueOf(s, "-webkit-backdrop-filter", REDUCED_TRANSPARENCY), s).to.equal(
					"none"
				);
			}
		}
	});

	it("keeps reduced transparency's solid winning in every state: no rule that paints a glass surface, in style.css, coffee.css or ps.css (the phone's fallback and overlays, the risen composer, the night glass), outranks its selector there or comes after it", function () {
		// The cascade, in order: style.css, then the theme (coffee.css, which
		// ps.css imports first, then ps.css). Reduced transparency's block is
		// the last thing in ps.css, so it wins every rule it at least equals in
		// specificity for the same element, in every state that rule is in.
		const read = (file: string) =>
			rulesIn(fs.readFileSync(path.resolve(__dirname, file), "utf8"));
		const cascade = [
			...read("../../client/css/style.css").map((r) => ({...r, file: "style.css"})),
			...rulesIn(coffee).map((r) => ({...r, file: "coffee.css"})),
			...rules.map((r) => ({...r, file: "ps.css"})),
		];
		const SOLID: Record<string, string> = {
			"background-color": "var(--ps-g-solid)",
			"backdrop-filter": "none",
			"-webkit-backdrop-filter": "none",
		};
		// A shorthand sets the colour too; only the solid itself agrees with the solid.
		const PAINTS = [...Object.keys(SOLID), "background"];
		const solid = rules.filter((r) => r.at === REDUCED_TRANSPARENCY);
		expect(solid.length, "one reduced-transparency rule").to.equal(1);
		const last = rules.indexOf(solid[0]);
		expect(last, "the reduced-transparency rule is ps.css's last").to.equal(rules.length - 1);

		for (const [property, value] of Object.entries(SOLID)) {
			for (const selector of GLASS_SURFACES) {
				expect(
					valueOf(selector, property, REDUCED_TRANSPARENCY),
					`${selector} ${property}`
				).to.equal(value);
			}
		}

		const painted: string[] = [];
		const losing: string[] = [];

		for (const r of cascade) {
			if (r.at === REDUCED_TRANSPARENCY) {
				continue;
			}

			const paints = r.decls.filter(
				([p, v]) => PAINTS.includes(p) && (SOLID[p] === undefined || v !== SOLID[p])
			);

			if (paints.length === 0) {
				continue;
			}

			for (const selector of r.selectors) {
				const surface = subjectOf(selector);

				if (!surface) {
					continue;
				}

				const where = `${r.file} ${r.at ? `${r.at} ` : ""}${selector} { ${paints
					.map(([p, v]) => `${p}: ${v}`)
					.join("; ")} }`;
				painted.push(where);
				expect(
					paints.every(([, v]) => !v.includes("!important")),
					`${where}: !important`
				).to.equal(true);
				// Reduced transparency's selector for the same element that applies
				// whenever this one does: this selector itself, or the bare surface.
				const beats = solid[0].selectors.some(
					(s) =>
						(s === selector || s === surface) &&
						compareSpecificity(specificity(s), specificity(selector)) >= 0
				);

				if (!beats) {
					losing.push(where);
				}
			}
		}

		// The glass itself, and every state and layout of it that paints.
		expect(painted.length, painted.join("\n")).to.be.at.least(GLASS_SURFACES.length * 2);
		expect(losing, losing.join("\n")).to.deep.equal([]);
	});

	it("no longer carries plan 1's chrome: the <3 rail, the paper header, the opaque user list", function () {
		expect(css).to.not.match(/#e6d9ff|#ffe3d1/i);
		expect(css).to.not.include("--ps-paper");
		expect(valueOf("#chat .userlist", "background-color")).to.not.equal(
			"var(--window-bg-color)"
		);
		expect(valueOf("#chat .header", "background")).to.equal(undefined);
	});

	it("clears the user list's count row, and veils its sticky headings with the list's own tint instead of the window colour", function () {
		expect(valueOf("#chat .userlist .count", "background-color")).to.equal("transparent");
		expect(valueOf("#chat .userlist .user-mode::before", "background-color")).to.equal(
			TINT_DAY
		);
		expect(valueOf(`${NIGHT} #chat .userlist .user-mode::before`, "background-color")).to.equal(
			TINT_NIGHT
		);
	});

	it("flips day and night over 0.8s, and at once under reduced motion", function () {
		expect(valueOf(DAY, "--ps-flip")).to.equal("0.8s");
		expect(valueOf(DAY, "--ps-flip", "@media (prefers-reduced-motion: reduce)")).to.equal("0s");

		// The jump-to-recent disc keeps style.css's own 0.2s: its fill changes on hover too.
		for (const selector of [
			...GLASS_SURFACES,
			...SOLID_SURFACES.filter((s) => s !== ".scroll-down-arrow"),
		]) {
			const transition = valueOf(selector, "transition") ?? "";

			for (const property of ["background-color", "color", "border-color"]) {
				expect(transition, `${selector} ${property}`).to.include(
					`${property} var(--ps-flip)`
				);
			}
		}
	});
});

/**
 * The chrome's own floors (spec §11): text at 4.5:1, marks and faint text
 * (placeholders, icons) at 3:1. The floors test (test/scenes/ps/legibility.ts)
 * holds the generated glass colours; this holds every other colour the chrome
 * draws, outside the message column, on the ground it draws it on: the solid
 * panels, the fields and washes on them, and the glass over the sparse sweep's
 * grounds — the sky, the bodies and the plains — by day at each surface's
 * computed tint over the brightened backdrop (the luminous glass,
 * client/js/scenes/ps/glass.ts), at night at the declared tint (a row's
 * selected or hovered wash, or a field, composited on top where one is).
 */
describe("the ps theme's chrome keeps its floors on the solid panels and on the glass (spec §6, §11)", function () {
	this.timeout(60000);

	const TEXT = 4.5;
	const MARK = 3;

	type Ground =
		| "solid"
		| "field"
		| "highlight"
		| "glass"
		| "glass+selected"
		| "glass+hover"
		| "glass+field"
		| "glass+tint-soft"
		| "glass+tint-strong";

	/**
	 * Where each wash's colour comes from: the token, read on the surface that
	 * paints it (a glass surface may restate a token for itself; the solid
	 * panels read the palette's).
	 */
	const WASH: Record<Exclude<Ground, "solid" | "glass">, [string, string]> = {
		field: ["", "--composer-bg"],
		highlight: ["", "--highlight-bg-color"],
		"glass+selected": ["#sidebar", "--rail-item-active-bg"],
		"glass+hover": ["#sidebar", "--rail-item-hover-bg"],
		"glass+field": ["#sidebar", "--rail-input-bg"],
		// The composer's reply, upload and connection bars (coffee.css #form .compose-bar…).
		"glass+tint-soft": ["#form", "--tint-soft"],
		// A hovered or keyboard-selected user in the list (coffee.css #chat .userlist .user.active).
		"glass+tint-strong": ["#chat .userlist", "--tint-strong"],
	};

	/** `value` resolved on `surface`: the palette, then what the surface's own rules restate. */
	function resolveOn(light: Light, surface: string, value: string): string {
		const p = paletteOf(light);

		if (surface) {
			const own = [...declsOf(surface)];

			if (light === "night") {
				own.push(...declsOf(`${NIGHT} ${surface}`));
			}

			for (const [name, v] of own) {
				if (name.startsWith("--")) {
					p.set(name, v);
				}
			}
		}

		return resolve(p, value);
	}

	const glassCache = new Map<Light, string[]>();

	/**
	 * The generated blocks' headers, whose pinned moments (their worst grounds,
	 * found by the dense sweep, and the Review Focus pins) join the sparse sweep,
	 * so the worst ground is always among the grounds checked.
	 */
	const headers = ["message-palette", "glass-palette"]
		.map((name) => css.slice(css.indexOf(`/* ps:${name}:start`)))
		.map((block) => block.slice(0, block.indexOf("*/")))
		.join("\n");

	/**
	 * The glass's grounds in one light over the sparse sweep and the pinned
	 * moments, one per colour. By day, the luminous glass as the scene draws
	 * it: each surface's grounds through the brightened backdrop at the tint
	 * that surface takes then (dayGlassGrounds; the declared tint is only the
	 * fallback without the scene, which the legibility test holds). At night,
	 * the declared tint.
	 */
	function glassGrounds(light: Light): string[] {
		if (!glassCache.has(light)) {
			const alpha = Number(resolve(paletteOf(light), "var(--ps-g-tint-a)"));
			const hexes =
				light === "day"
					? dayGlassGrounds("sparse", headers).map((g) => g.hex)
					: withPinned(checkedGrounds("sparse"), headers).glass[light].map((g) =>
							glassGround(g.hex, light, alpha)
					  );
			glassCache.set(light, [...new Set(hexes)]);
		}

		return glassCache.get(light)!;
	}

	function groundsOf(light: Light, ground: Ground): string[] {
		const solid = resolve(paletteOf(light), "var(--ps-g-solid)");

		if (ground === "solid") {
			return [solid];
		}

		if (ground === "glass") {
			return glassGrounds(light);
		}

		const [surface, token] = WASH[ground];
		const wash = resolveOn(light, surface, `var(${token})`);
		return ground === "field" || ground === "highlight"
			? [over(wash, solid)]
			: glassGrounds(light).map((g) => over(wash, g));
	}

	/** What the chrome draws in each token, and on what; coffee.css and style.css name the rules. */
	const USES: Array<{token: string; on: Ground[]; floor: number; what: string}> = [
		{token: "--rail-fg", on: ["glass"], floor: TEXT, what: "a channel's name"},
		{token: "--rail-fg-strong", on: ["glass"], floor: TEXT, what: "the lobby, a mentioned row"},
		{
			token: "--rail-fg-active",
			on: ["glass+selected", "glass+hover", "glass+field"],
			floor: TEXT,
			what: "the open row, a hovered one, the jump-to search",
		},
		{
			token: "--rail-fg-muted",
			on: ["glass", "glass+selected", "glass+hover"],
			floor: TEXT,
			what: "the lobby's nick (style.css .lobby-nick), also the footer's icons",
		},
		// The spec's accent itself (--ps-g-accent, --rail-accent) draws only what no
		// floor covers: the open row's marker, exempt as a redundant cue beside the
		// selected wash and the full ink (ruling, 2026-09-24), the caret and the
		// focus ring's glow. Every accent that has to read is the text accent.
		{
			token: "--ps-g-accent-text",
			on: ["glass", "glass+selected", "glass+hover"],
			floor: MARK,
			what: "the connecting icon (also on the open or hovered lobby row), a chip's focus border",
		},
		{
			token: "--event-quit",
			on: ["glass", "glass+selected", "glass+hover", "solid"],
			floor: TEXT,
			what: "a disconnected or parted row (also open or hovered); a settings error",
		},
		{
			token: "--event-join",
			on: ["glass", "glass+selected", "glass+hover"],
			floor: MARK,
			what: "the connected icon and the subscribed bell (also on the open lobby row), the typing pulse",
		},
		{token: "--event-join", on: ["solid"], floor: TEXT, what: "settings' success note"},
		{
			token: "--nick-default",
			on: ["glass", "glass+tint-strong", "solid", "highlight"],
			floor: TEXT,
			what: "a nick with no colour class (also a hovered one in the list)",
		},
		{
			token: "--body-color",
			on: ["glass", "glass+tint-soft", "solid", "field"],
			floor: TEXT,
			what: "the title, the composer and its bars, panel text, a field",
		},
		{
			token: "--body-color-muted",
			on: ["glass", "glass+tint-soft", "solid"],
			floor: TEXT,
			what: "the topic, the mode headings, the typing strip, the composer's bars, panel notes",
		},
		{token: "--chat-fg", on: ["highlight"], floor: TEXT, what: "a mention in the popover"},
		{
			token: "--chat-fg-faint",
			on: ["glass", "field"],
			floor: MARK,
			what: "the user count's icon (the placeholders have their own, --ps-g-placeholder)",
		},
		// Placeholders are text. Every one reads --ps-g-placeholder under ps (the
		// placeholders describe, below), on every ground an input stands on.
		{
			token: "--ps-g-placeholder",
			on: ["glass", "glass+field", "field", "solid"],
			floor: TEXT,
			what: "every placeholder: the composer, the user list's search and the topic on the glass; the jump-to search, the message search and the join form on the glass's field; the settings, connect and network forms on a panel's field; the emoji picker's search on the solid",
		},
		{token: "--window-heading-color", on: ["solid"], floor: TEXT, what: "a window's headings"},
		{
			token: "--link-color",
			on: ["glass", "solid"],
			floor: TEXT,
			what: "a link in the topic, in Help",
		},
		{
			token: "--button-color",
			on: ["glass", "solid"],
			floor: TEXT,
			what: "a button's label: the sidebar's Join, the panels' buttons",
		},
		{
			token: "--chat-accent",
			on: ["glass", "glass+tint-soft"],
			floor: MARK,
			what: "the send button, the reply bar's rule",
		},
		...[
			"--tok-comment",
			"--tok-keyword",
			"--tok-string",
			"--tok-number",
			"--tok-function",
			"--tok-operator",
			"--tok-punctuation",
			"--tok-tag",
			"--tok-attr",
		].map((token) => ({
			token,
			on: ["field"] as Ground[],
			floor: TEXT,
			what: "code in the Mentions popover",
		})),
	];

	/** Text on an opaque fill of its own. */
	const FILLS: Array<[string, string, string]> = [
		["--rail-badge-fg", "--rail-badge-bg", "the unread and the mention badge"],
		["--button-text-color-hover", "--button-color", "a hovered button"],
		["--note-fg", "--note-bg", "a note"],
		["--warn-fg", "--warn-bg", "a warning"],
		["--error-fg", "--error-bg", "an error"],
		["--ok-fg", "--ok-bg", "a success"],
	];

	for (const light of ["day", "night"] as const) {
		it(`holds every chrome colour on its grounds, ${
			light === "day" ? "by day" : "at night"
		}`, function () {
			const p = paletteOf(light);
			const failures: string[] = [];

			for (const use of USES) {
				const colour = resolve(p, `var(${use.token})`);

				for (const ground of use.on) {
					let worst = {ratio: Infinity, on: ""};

					for (const g of groundsOf(light, ground)) {
						const ratio = contrast(colour, g);

						if (ratio < worst.ratio) {
							worst = {ratio, on: g};
						}
					}

					if (worst.ratio < use.floor) {
						failures.push(
							`${use.token} ${colour} (${use.what}) on ${ground} ${
								worst.on
							}: ${worst.ratio.toFixed(2)} < ${use.floor}`
						);
					}
				}
			}

			// The glass block's nick sweep, on a hovered or keyboard-selected user in the list.
			const block = css.slice(
				css.indexOf("/* ps:glass-palette:start"),
				css.indexOf("/* ps:glass-palette:end */")
			);
			const prefix = light === "day" ? "" : `${NIGHT} `.replace(/[[\]]/g, "\\$&");
			const sweep = [
				...block.matchAll(
					new RegExp(
						`^${prefix}\\.user\\.color-(\\d+) \\{ color: (#[0-9a-f]{6}); \\}`,
						"gm"
					)
				),
			];
			expect(sweep, `the ${light} glass sweep`).to.have.length(32);
			const hovered = groundsOf(light, "glass+tint-strong");

			for (const [, n, hex] of sweep) {
				const ratio = Math.min(...hovered.map((g) => contrast(hex, g)));

				if (ratio < TEXT) {
					failures.push(
						`glass nick color-${n} ${hex} on glass+tint-strong (a hovered user): ${ratio.toFixed(
							2
						)} < ${TEXT}`
					);
				}
			}

			for (const [fg, bg, what] of FILLS) {
				const [f, b] = [resolve(p, `var(${fg})`), resolve(p, `var(${bg})`)];
				const ratio = contrast(f, b);

				if (ratio < TEXT) {
					failures.push(
						`${fg} ${f} on ${bg} ${b} (${what}): ${ratio.toFixed(2)} < ${TEXT}`
					);
				}
			}

			expect(failures, failures.join("\n")).to.deep.equal([]);
		});
	}

	it("solves the day glass's tint for the lightest colours written on it: the soft ink at 4.6, the join green's marks at 3.1, and nothing on the glass lighter", function () {
		const p = paletteOf("day");
		expect(
			resolve(p, "var(--ps-g-soft)"),
			"glass.ts's text is the generated soft ink"
		).to.equal(DAY_GLASS_TEXT);
		expect(resolve(p, "var(--event-join)"), "glass.ts's mark is the join green").to.equal(
			DAY_GLASS_MARK
		);

		/** The lowest ground luminance at which `hex` clears `solve` over a lighter ground. */
		const need = (hex: string, solve: number) => solve * (luminance(hex) + 0.05) - 0.05;
		const solved = Math.max(need(DAY_GLASS_TEXT, TEXT_SOLVE), need(DAY_GLASS_MARK, MARK_SOLVE));
		const block = css.slice(
			css.indexOf("/* ps:glass-palette:start"),
			css.indexOf("/* ps:glass-palette:end */")
		);
		const written: Array<[string, string, number]> = [
			...USES.filter((u) => u.on.some((g) => g.startsWith("glass"))).map(
				(u): [string, string, number] => [
					u.token,
					resolve(p, `var(${u.token})`),
					u.floor === TEXT ? TEXT_SOLVE : MARK_SOLVE,
				]
			),
			["the chips' ink", resolve(p, "var(--ps-g-ink)"), TEXT_SOLVE],
			...[...block.matchAll(/^\.user\.color-(\d+) \{ color: (#[0-9a-f]{6}); \}/gm)].map(
				([, n, hex]): [string, string, number] => [`nick color-${n}`, hex, TEXT_SOLVE]
			),
		];
		expect(written.length).to.be.at.least(32 + 10);

		for (const [what, hex, solve] of written) {
			expect(need(hex, solve), `${what} ${hex} at ${solve}`).to.be.at.most(solved);
		}
	});

	it("solves the night placeholder to 4.6 over its worst ground, the soft ink moved in OKLCH lightness alone, and leaves the day's the soft ink (the user's 'fix the night placeholder contrast too', 2026-09-26)", function () {
		// The glass is at its cap and rule 2 could not reach 4.5 on the glass's
		// field at night (the full moon behind); the user took the move past
		// rule 2 for the placeholders alone, so the soft ink's other uses stay.
		const soft = {
			day: resolve(paletteOf("day"), "var(--ps-g-soft)"),
			night: resolve(paletteOf("night"), "var(--ps-g-soft)"),
		};
		expect(resolve(paletteOf("day"), "var(--ps-g-placeholder)"), "by day").to.equal(soft.day);
		const night = resolve(paletteOf("night"), "var(--ps-g-placeholder)");
		expect(night, "at night, a colour of its own").to.match(/^#[0-9a-f]{6}$/);
		const [L, C, h] = hexToOklch(soft.night);
		const [L2, C2, h2] = hexToOklch(night);
		// Hue and chroma are the soft ink's; the six-digit hex rounds a chroma
		// this low (0.033) to within about 2° of hue (radians here).
		expect(Math.abs(h2 - h), "the soft ink's hue").to.be.below(0.035);
		expect(Math.abs(C2 - C), "the soft ink's chroma").to.be.below(0.001);
		// The move recorded in the spec (§2) and in ps.css: +0.0645 OKLCH L.
		expect(L2 - L, "the lightness move").to.be.closeTo(0.0645, 0.00005);

		const grounds = (["glass", "glass+field", "field", "solid"] as const).flatMap((g) =>
			groundsOf("night", g)
		);
		const lowest = (hex: string) => Math.min(...grounds.map((g) => contrast(hex, g)));
		expect(lowest(night), "solved to 4.6").to.be.at.least(TEXT_SOLVE);
		// The smallest such move (the generator's 0.0001 steps, hue and chroma kept).
		const less = oklchToHex(L + 0.0635, C, h)!;
		expect(lowest(less), `a step less, ${less}`).to.be.below(TEXT_SOLVE);
	});

	it("keeps every night wash on the glass at least as visible as it measures over plan 3's grounds, and never under 1.02 over the darkest ground", function () {
		// The contrast between the washed and the bare glass over the sparse sweep:
		// its median at least each wash's own, and its lowest above 1.02. A wash
		// toward the glass's own navy measured 1.000 over the darkest sky: it did
		// not show at all. Plan 2 chose each black as visible as the white it
		// replaced (white 11 / 6 / 4 / 8 %: medians 1.41 / 1.21 / 1.14 / 1.28)
		// over the sky and the bodies alone, the sun counted under the horizon and
		// no veil. Over plan 3's grounds — the plains' dark night land, the veil,
		// the sun hidden under the horizon — the same washes measure 1.30 / 1.15 /
		// 1.10 / 1.21, and parity with the white would take 91 / 38 / 24 / 54 %
		// black (task 5 report, a question for the user). Held here at what they
		// measure now, so they never grow fainter.
		const floors: Array<[Exclude<Ground, "solid" | "glass">, number]> = [
			["glass+selected", 1.3],
			["glass+hover", 1.15],
			["glass+tint-soft", 1.1],
			["glass+tint-strong", 1.21],
		];
		const bare = groundsOf("night", "glass");

		for (const [ground, median] of floors) {
			const washed = groundsOf("night", ground);
			const seen = bare.map((g, i) => contrast(g, washed[i])).sort((a, b) => a - b);
			expect(seen[Math.floor(seen.length / 2)], `${ground}, the median`).to.be.at.least(
				median
			);
			expect(seen[0], `${ground}, over the darkest ground`).to.be.at.least(1.02);
		}
	});

	it("carries the glass block's two nick sweeps, 32 each, and they read on the solid and on the Mentions popover's wash", function () {
		const block = css.slice(
			css.indexOf("/* ps:glass-palette:start"),
			css.indexOf("/* ps:glass-palette:end */")
		);

		for (const light of ["day", "night"] as const) {
			const prefix = light === "day" ? "" : `${NIGHT} `.replace(/[[\]]/g, "\\$&");
			const slots = [
				...block.matchAll(
					new RegExp(
						`^${prefix}\\.user\\.color-(\\d+) \\{ color: (#[0-9a-f]{6}); \\}`,
						"gm"
					)
				),
			];
			expect(
				slots.map((m) => Number(m[1])),
				`the glass block's ${light} sweep`
			).to.deep.equal(Array.from({length: 32}, (_, i) => i + 1));

			for (const ground of ["solid", "highlight"] as const) {
				const [g] = groundsOf(light, ground);

				for (const [, n, hex] of slots) {
					expect(contrast(hex, g), `${light} color-${n} on ${ground}`).to.be.at.least(
						TEXT
					);
				}
			}
		}
	});
});

describe("the ps theme's native controls follow day and night (the user's report, 2026-09-26)", function () {
	// "the select boxes in the ps theme are a light text on a light background
	// … right now it's night". The browser draws a select's option list itself,
	// from the select's and the options' own colours, in the page's colour
	// scheme.
	const SELECT = "select.input";
	const OPTION = "select option";
	const sheets = [
		["style.css", "../../client/css/style.css"],
		["coffee.css", "../../client/themes/coffee.css"],
	].map(([name, file]) => ({
		name,
		rules: rulesIn(fs.readFileSync(path.resolve(__dirname, file), "utf8")),
	}));

	it("declares the page's colour scheme by the hour: light by day and under the daylight fallback, dark at night, and nowhere else", function () {
		expect(valueOf(DAY, "color-scheme")).to.equal("light");
		expect(valueOf(NIGHT, "color-scheme")).to.equal("dark");
		const elsewhere = rules.filter(
			(r) =>
				r.decls.some(([p]) => p === "color-scheme") &&
				!(r.at === "" && (r.selectors.includes(DAY) || r.selectors.includes(NIGHT)))
		);
		expect(elsewhere.map((r) => [r.at, r.selectors])).to.deep.equal([]);
	});

	it("gives a select and its options an opaque ground and the ink, from the solid palette", function () {
		// The select wore the field's wash (white 7 % at night) and the options
		// nothing, so the list fell back to the platform's light default under
		// the night's light ink. The solid is opaque in both lights; the select
		// keeps the field as an image over it, so it still reads as a field.
		expect(valueOf(SELECT, "background-color")).to.equal("var(--ps-g-solid)");
		expect(valueOf(SELECT, "background-image")).to.equal(
			"linear-gradient(var(--composer-bg), var(--composer-bg))"
		);
		expect(valueOf(SELECT, "color")).to.equal("var(--ps-g-ink)");
		expect(valueOf(OPTION, "background-color")).to.equal("var(--ps-g-solid)");
		expect(valueOf(OPTION, "color")).to.equal("var(--ps-g-ink)");

		for (const light of ["day", "night"] as const) {
			const solid = resolve(paletteOf(light), "var(--ps-g-solid)");
			expect(rgba(solid)[3], `${light}: the solid is opaque`).to.equal(1);
		}
	});

	it("outranks every rule that paints an .input's field or its text, in style.css, coffee.css and ps.css", function () {
		const painting = [...sheets, {name: "ps.css", rules}].flatMap(({name, rules: list}) =>
			list
				.filter(
					(r) =>
						r.at === "" &&
						r.decls.some(([p]) =>
							["background", "background-color", "color"].includes(p)
						)
				)
				.flatMap((r) =>
					r.selectors.filter((s) => s === ".input").map((s) => `${name} ${s}`)
				)
		);
		expect(painting.length, "the .input rules").to.be.at.least(2);

		for (const rule of painting) {
			expect(
				compareSpecificity(specificity(SELECT), specificity(rule.split(" ")[1])),
				rule
			).to.be.above(0);
		}
	});

	it("holds the ink at 4.5 over the options' solid and the select's field on it, by day and at night", function () {
		for (const light of ["day", "night"] as const) {
			const p = paletteOf(light);
			const solid = resolve(p, "var(--ps-g-solid)");
			const ink = resolve(p, "var(--ps-g-ink)");
			const face = over(resolve(p, "var(--composer-bg)"), solid);
			expect(contrast(ink, solid), `${light}: an option`).to.be.at.least(4.5);
			expect(contrast(ink, face), `${light}: the select's face`).to.be.at.least(4.5);
		}
	});
});

describe("the ps theme's placeholders (the user's 'fix the night placeholder contrast too', 2026-09-26)", function () {
	// Every placeholder rule the app loads, in style.css, coffee.css and the
	// components' own styles, is restated in ps.css in --ps-g-placeholder:
	// the same selector, later in the cascade, so it wins at equal weight.
	const vue = (dir: string): string[] =>
		fs
			.readdirSync(dir, {withFileTypes: true})
			.flatMap((e) =>
				e.isDirectory()
					? vue(path.join(dir, e.name))
					: e.name.endsWith(".vue")
					? [path.join(dir, e.name)]
					: []
			);
	const sources = [
		path.resolve(__dirname, "../../client/css/style.css"),
		path.resolve(__dirname, "../../client/themes/coffee.css"),
		...vue(path.resolve(__dirname, "../../client/components")),
	].map((file) => {
		const text = fs.readFileSync(file, "utf8");
		const styles = file.endsWith(".vue")
			? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
			: text;
		return {file: path.basename(file), rules: rulesIn(styles)};
	});
	const placeholders = (list: Rule[]) =>
		list.flatMap((r) => r.selectors.filter((s) => s.endsWith("::placeholder")));

	it("restates every placeholder rule the app loads, and colours each one --ps-g-placeholder", function () {
		const theirs = [...new Set(sources.flatMap((s) => placeholders(s.rules)))];
		expect(theirs, "the app's placeholder rules").to.include.members([
			"::placeholder",
			".jump-to-input .input::placeholder",
			"form.message-search input::placeholder",
			".reaction-picker-input::placeholder",
		]);

		for (const selector of theirs) {
			expect(valueOf(selector, "color"), selector).to.equal("var(--ps-g-placeholder)");
		}

		// And no rule of ps.css colours a placeholder anything else.
		const colours = rules
			.filter((r) => placeholders([r]).length > 0)
			.flatMap((r) => r.decls.filter(([p]) => p === "color").map(([, v]) => v));
		expect(colours.length, "ps.css's placeholder rules").to.be.at.least(1);
		expect(colours.filter((v) => v !== "var(--ps-g-placeholder)")).to.deep.equal([]);
	});
});

describe("the ps theme's composer: one thin divider over the flat input (the user's 'a single thin line', 2026-09-26, and 'the thin divider is good', 2026-09-27)", function () {
	const style = rulesIn(
		fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8")
	);
	const theirs = [...style, ...rulesIn(coffee)];
	/** The last value `selector` gets for `property` at the top level of `list`. */
	const lastIn = (list: Rule[], selector: string, property: string) =>
		list
			.filter((r) => r.at === "" && r.selectors.includes(selector))
			.flatMap((r) => r.decls)
			.filter(([p]) => p === property)
			.at(-1)?.[1];

	it("draws the line between the messages and the composer once: #form's 1px top edge, in the edge, focused or not", function () {
		// style.css's 1px top border is the one line; ps.css colours it the
		// edge, as the header's foot and the side panels' edges.
		expect(lastIn(style, "#form", "border-top")).to.match(/^1px solid /);
		expect(valueOf("#form", "border-block-start-color")).to.equal("var(--ps-g-edge)");

		// style.css and coffee.css mark focus on the strip: the top edge in a
		// colour and a 2px inset band under it. ps.css takes both back at the
		// same weight, later in the cascade.
		expect(
			lastIn(theirs, "#form:focus-within", "box-shadow"),
			"the band ps.css undoes"
		).to.match(/^inset /);
		expect(valueOf("#form:focus-within", "border-block-start-color")).to.equal(
			"var(--ps-g-edge)"
		);
		expect(valueOf("#form:focus-within", "box-shadow")).to.equal("none");

		// Nothing in ps.css draws the strip's top edge otherwise, in any state.
		const widths = [
			"border",
			"border-width",
			"border-style",
			"border-top",
			"border-top-width",
			"border-top-style",
			"border-block",
			"border-block-width",
			"border-block-style",
			"border-block-start",
			"border-block-start-width",
			"border-block-start-style",
		];
		const edges = rules
			.filter((r) => r.selectors.some((s) => /#form(?![\w-])[^ ]*$/.test(s)))
			.flatMap((r) => r.decls)
			.filter(([p]) => widths.includes(p));
		expect(edges, "ps.css's widths or styles on #form's edge").to.deep.equal([]);
		const shadows = rules
			.filter((r) => r.selectors.some((s) => /#form(?![\w-])[^ ]*$/.test(s)))
			.flatMap((r) => r.decls)
			.filter(([p, v]) => p === "box-shadow" && v !== "none");
		expect(shadows, "ps.css's shadows on #form").to.deep.equal([]);
	});

	it("draws no second line with a bar open: the typing strip and the reply, upload and connection bars have no rule above or below them, nor a shadow", function () {
		const bars = [".typing-indicator", ".compose-bar", ".upload-bar", ".connection-bar"];
		const lines = [...theirs, ...rules]
			.filter((r) =>
				r.selectors.some((s) => bars.some((b) => s.endsWith(b) || s.includes(`${b}:`)))
			)
			.flatMap((r) => r.decls)
			.filter(
				([p]) =>
					/^border-(top|bottom|block)|^border$|^box-shadow$|^outline$/.test(p) &&
					!/-(left|right|inline)/.test(p)
			);
		expect(lines).to.deep.equal([]);
	});

	it("leaves #input style.css's flat textarea: no radius, edge, wash, padding, margin or height of its own in ps.css, in any state or at-rule (the user's 'nah i don't like the new input box', 2026-09-27)", function () {
		const field = [
			"border",
			"border-color",
			"border-width",
			"border-style",
			"border-radius",
			"background",
			"background-color",
			"padding",
			"padding-block",
			"padding-inline",
			"margin",
			"margin-block",
			"height",
			"min-height",
			"max-height",
		];
		const own = rules
			.filter((r) => r.selectors.some((s) => /#input(?![\w-])[^ ]*$/.test(s)))
			.flatMap((r) =>
				r.decls
					.filter(([p]) => field.includes(p))
					.map(
						([p, v]) =>
							`${r.at ? `${r.at} ` : ""}${r.selectors.join(", ")} { ${p}: ${v} }`
					)
			);
		expect(own, "ps.css's field on #input").to.deep.equal([]);
		// Nor on the buttons beside it: they sit on style.css's row as before.
		expect(
			rules.filter((r) => r.selectors.some((s) => s.includes("#form > .tooltipped"))),
			"ps.css's rules on the buttons' wrappers"
		).to.deep.equal([]);
		// And the field's own edge colour is gone from both palettes.
		expect(css, "the field's edge token").not.to.include("--ps-g-field-edge");
	});

	it("keeps the divider the one 1px edge line when the caret is in the composer, and the caret the accent", function () {
		expect(valueOf("#form #input", "caret-color")).to.equal("var(--ps-g-accent)");
		expect(valueOf("#form:focus-within", "border-block-start-color")).to.equal(
			"var(--ps-g-edge)"
		);
		expect(valueOf("#form:focus-within", "box-shadow")).to.equal("none");
		// No focus state of the input itself draws anything in ps.css.
		expect(
			rules.filter((r) => r.selectors.some((s) => /#input:focus/.test(s))),
			"ps.css's focus rules on #input"
		).to.deep.equal([]);
	});
});

describe("the ps theme's type", function () {
	const fontsBlock = css.slice(
		css.indexOf("/* ps:fonts:start"),
		css.indexOf("/* ps:fonts:end */")
	);

	/** A family as a font-family value names it: quoted where the name has a space or a figure (stylelint's always-where-recommended; `Source Sans 3` unquoted is not a valid family name at all, and the rule would be dropped). */
	const named = (family: string) => (/[\s\d]/.test(family) ? `"${family}"` : family);

	it("bundles Source Sans 3 (upright and italic) and Newsreader, Latin, Latin Extended and Vietnamese, as files that exist", function () {
		const faces = [...fontsBlock.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
		const has = (family: string, style: string) =>
			faces.filter(
				(f) =>
					f.includes(`font-family: ${named(family)};`) &&
					f.includes(`font-style: ${style}`)
			);

		/** Which subset a face is, by its unicode-range as Google serves it. */
		const subsetOf = (face: string) => {
			const range = face.match(/unicode-range:\s*([^;]+);/)?.[1].split(/,\s*/) ?? [];

			return range[0] === "U+0000-00FF"
				? "latin"
				: range[0] === "U+0100-02BA"
				? "latin-ext"
				: range.includes("U+1EA0-1EF9") // ạ … ỹ: "Nguyễn" needs this file
				? "vietnamese"
				: `unknown (${range[0]})`;
		};

		// Three styles of three files each, and nothing else.
		expect(faces, "the @font-face rules").to.have.length(9);

		for (const [family, style] of [
			["Source Sans 3", "normal"],
			["Source Sans 3", "italic"],
			["Newsreader", "normal"],
		]) {
			const set = has(family, style);
			// Vietnamese first: where the ranges overlap, the face defined last is
			// tried first, so the Latin files keep drawing what they drew before.
			expect(set.map(subsetOf), `${family} ${style}`).to.deep.equal([
				"vietnamese",
				"latin",
				"latin-ext",
			]);

			for (const face of set) {
				const file = face.match(/url\("ps\/([^"]+\.woff2)"\)/)?.[1];
				expect(file, `${family} ${style} src`).to.be.a("string");
				expect(file, `${family} ${style} file name`).to.match(
					new RegExp(`-${subsetOf(face)}\\.woff2$`)
				);
				expect(fs.existsSync(path.resolve(__dirname, "../../client/themes/ps", file!))).to
					.be.true;
			}
		}

		for (const licence of ["OFL-SourceSans3.txt", "OFL-Newsreader.txt"]) {
			expect(
				fs.existsSync(path.resolve(__dirname, "../../client/themes/ps", licence)),
				licence
			).to.be.true;
		}
	});

	it("no longer carries Nunito, Baloo 2, Mulish or Fraunces", function () {
		expect(css).to.not.match(/Nunito|Baloo|Mulish|Fraunces/);

		for (const f of [
			"nunito-variable.woff2",
			"nunito-variable-italic.woff2",
			"baloo2-variable.woff2",
			"OFL-Nunito.txt",
			"OFL-Baloo2.txt",
			...["latin", "latin-ext", "vietnamese"].flatMap((subset) => [
				`mulish-${subset}.woff2`,
				`mulish-italic-${subset}.woff2`,
				`fraunces-${subset}.woff2`,
			]),
			"OFL-Mulish.txt",
			"OFL-Fraunces.txt",
		]) {
			expect(fs.existsSync(path.resolve(__dirname, "../../client/themes/ps", f)), f).to.be
				.false;
		}
	});

	it("sets words in Source Sans 3 500 with 700 for bold, and names in Newsreader 700, each weight inside its face's files", function () {
		expect(css).to.match(/font-family:\s*"Source Sans 3",[^;]*;\s*font-weight:\s*500;/);
		expect(css).to.match(
			/b,\s*strong,\s*\.msg \.content b,\s*#chat \.msg\.highlight \.content \{\s*font-weight:\s*700;\s*\}/
		);
		// Bold is the words' heaviest weight in use: nothing asks for more.
		expect(css).to.not.match(/font-weight:\s*(800|900|bolder)\b/);
		expect(css).to.match(/font-family:\s*Newsreader,[^;]*;\s*font-weight:\s*700;/);

		/** Every weight range a family's @font-face rules declare, as [low, high]. */
		const ranges = (family: string) =>
			[...fontsBlock.matchAll(/@font-face\s*\{([^}]*)\}/g)]
				.map((m) => m[1])
				.filter((f) => f.includes(`font-family: ${named(family)};`))
				.map((f) => {
					const [low, high = low] = f
						.match(/font-weight:\s*([^;]+);/)![1]
						.trim()
						.split(/\s+/)
						.map(Number);
					return [low, high];
				});

		// No synthesised bold, and no weight snapped to a neighbour: every file
		// carries the weights the rules ask of it.
		for (const [family, weights] of [
			["Source Sans 3", [400, 500, 600, 700]],
			["Newsreader", [700]],
		] as const) {
			const declared = ranges(family);
			expect(declared, family).to.have.length.greaterThan(0);

			for (const [low, high] of declared) {
				for (const w of weights) {
					expect(w, `${family} ${low}–${high}`).to.be.within(low, high);
				}
			}
		}
	});

	/** The rules that set the names' face (Newsreader) and their selectors. */
	const namesSelectors = () =>
		rules
			.filter((r) => r.decls.some(([p, v]) => p === "font-family" && /^Newsreader\b/.test(v)))
			.flatMap((r) => r.selectors);

	it("sets a nick named inside a message's text in the text's own face, bold, in the nick's colour (the user's I2, 2026-09-26): the nick column keeps the names' face", function () {
		const IN_TEXT = "#chat .msg .content .user";
		const inText = rules.filter((r) => r.selectors.includes(IN_TEXT));
		expect(inText, IN_TEXT).to.have.length.greaterThan(0);

		for (const rule of inText) {
			// Only the in-text nick: nothing else is in its selector list.
			expect(rule.selectors, "the in-text nick rule's selectors").to.deep.equal([IN_TEXT]);
			expect(rule.at, "the in-text nick rule is top-level").to.equal("");
			// The nick's own colour stays the nick sweeps' (#chat .chat .user.color-N).
			expect(rule.decls.map(([p]) => p)).to.not.include("color");
		}

		// The text's face — whatever the text is set in (a monospace block's
		// monospace too) — and the words' bold.
		expect(valueOf(IN_TEXT, "font-family")).to.equal("inherit");
		expect(valueOf(IN_TEXT, "font-weight")).to.equal("700");

		// The names' face reaches the nick column, never a nick in the text.
		const names = namesSelectors();
		expect(names).to.include("#chat .msg .from .user");
		expect(names, "the bare #chat .msg .user reached the text too").to.not.include(
			"#chat .msg .user"
		);

		for (const selector of names) {
			expect(selector, "a names' face selector reaching the text").to.not.match(
				/\.content(?![\w-])/
			);
		}
	});

	it("keeps the in-text nick's style in the message text: it reaches no nick column, user list, sidebar or header", function () {
		const styled = rules
			.filter((r) => r.decls.some(([p, v]) => p === "font-family" && v === "inherit"))
			.flatMap((r) => r.selectors)
			.filter((s) => /\.user(?![\w-])/.test(s));
		expect(styled).to.deep.equal(["#chat .msg .content .user"]);

		for (const selector of styled) {
			expect(selector).to.not.match(/\.from(?![\w-])|\.userlist|#sidebar|\.header/);
		}

		// And the chrome's names keep theirs.
		expect(namesSelectors()).to.include.members([
			"#chat .msg .from .user",
			"#chat .header .title",
			".channel-list-item .name",
		]);
	});

	it("shows the theme's own faces in Settings → Appearance's font-size sample: its names in the names' face, its times and lines in the words' (the user's report, 2026-09-26)", function () {
		// Appearance.vue: <div class="font-size-sample"> of lines of
		// <span class="time">, <span class="from user"> and <span class="text">,
		// inside #settings, which the words' rule sets; the names' rule
		// named only the chat's and the sidebar's names, so the sample's drew
		// in the words' face at the component's bold.
		expect(namesSelectors()).to.include(".font-size-sample .from");

		const wordsRule = rules.find(
			(r) =>
				r.at === "" &&
				r.decls.some(([p, v]) => p === "font-family" && v.startsWith('"Source Sans 3"'))
		);
		expect(wordsRule?.selectors).to.include("#settings");

		for (const selector of namesSelectors()) {
			expect(selector, "the names' face on the sample's time or line").to.not.match(
				/\.font-size-sample\b.*\.(time|text)(?![\w-])/
			);
		}
	});
});

describe("the ps theme's stacked message rows (the user's B, 2026-10-06; the time first, 2026-10-08)", function () {
	const M = '[data-type="message"], [data-type="notice"]';
	const ROW = `#chat .chat .msg:is(${M})`;
	const SYS =
		'#chat .chat .msg:not([data-type="message"], [data-type="notice"], [data-type="condensed"])';
	const style = rulesIn(
		fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8")
	);

	it("starts every row with its time, in a column as wide in every row as the clock setting's widest time", function () {
		// the widest English time of each setting, 0.8em tabular figures, in the
		// text's ch (measured 2026-10-08: 3.62, 6.01, 5.63 and 8.02), with slack
		expect(valueOf("#chat", "--ps-time-w")).to.equal("4ch");
		expect(valueOf("#chat.time-12h", "--ps-time-w")).to.equal("6.5ch");
		expect(valueOf("#chat.time-seconds", "--ps-time-w")).to.equal("6ch");
		expect(valueOf("#chat.time-seconds.time-12h", "--ps-time-w")).to.equal("8.5ch");
		const column = "minmax(var(--ps-time-w), max-content)";
		expect(valueOf(ROW, "grid-template-columns")).to.match(
			new RegExp(`^${column.replace(/[()]/g, "\\$&")} `)
		);
		expect(valueOf(SYS, "grid-template-columns")).to.match(
			new RegExp(`^${column.replace(/[()]/g, "\\$&")} `)
		);
	});

	it("lays a message out as its time, then the nick, and the text on the next line under the nick", function () {
		expect(valueOf(ROW, "display")).to.equal("grid");
		expect(valueOf(ROW, "grid-template-areas")?.replace(/\s+/g, " ")).to.equal(
			'"time from" ". content"'
		);
		expect(valueOf(`${ROW} .from`, "grid-area")).to.equal("from");
		expect(valueOf(`${ROW} .time`, "grid-area")).to.equal("time");
		expect(valueOf(`${ROW} .content`, "grid-area")).to.equal("content");
		// logical, so a right-to-left page has its time at its own start
		expect(valueOf(ROW, "padding-inline")).to.equal("0.625rem");
		expect(valueOf(`${ROW} .content`, "padding-inline")).to.equal("0");
	});

	it("lines a mention up with the rows around it: its 5px bar is taken off the row's start", function () {
		const H = `#chat .chat .msg.highlight:is(${M})`;
		// style.css's bar, which this takes off
		expect(
			declsOf('#chat .chat-view[data-type="channel"] .msg.highlight', "", style).find(
				([p]) => p === "border-inline-start" || p === "border-left"
			)?.[1]
		).to.match(/^5px /);
		expect(valueOf(H, "padding-inline-start")).to.equal("calc(0.625rem - 5px)");
		expect(valueOf(`${H} .content`, "border")).to.equal("0");
		expect(valueOf(`${H} .time`, "padding")).to.equal("0");
	});

	it("never cuts a nick: it wraps rather than ending in an ellipsis", function () {
		expect(valueOf(`${ROW} .from`, "overflow")).to.equal("visible");
		expect(valueOf(`${ROW} .from`, "white-space")).to.equal("normal");
		expect(valueOf(`${ROW} .from`, "overflow-wrap")).to.equal("anywhere");
		// none of the shipped column's sizing is left in ps.css
		expect(valueOf("#chat .from", "flex-basis")).to.equal(undefined);
		expect(valueOf("#chat .content", "flex-basis")).to.equal(undefined);
		expect(valueOf("#chat.time-seconds .time", "width")).to.equal(undefined);
		expect(valueOf("#chat .chat .from", "margin")).to.equal(undefined);
	});

	it("shows a run of one sender's lines with the nick once, each line's time in its column when pointed at", function () {
		const run = `#chat .chat .msg.previous-source:is(${M})`;
		expect(valueOf(run, "grid-template-areas")).to.equal('"time content"');
		expect(valueOf(`${run} .from`, "display")).to.equal("none");
		const hidden = `${run} .time`;
		expect(valueOf(hidden, "visibility"), "kept in place, so nothing moves").to.equal("hidden");
		const shown = "#chat .chat .msg.previous-source:is(:hover, .actions-open) .time";
		expect(valueOf(shown, "visibility")).to.equal("visible");
		expect(
			rules.findIndex((r) => r.selectors.includes(shown)) -
				rules.findIndex((r) => r.selectors.includes(hidden)),
			"after the rule that hides it"
		).to.be.above(0);
		// a day's divider or the unread line between two of them starts a new run
		const after =
			"#chat .chat :is(.date-marker-container, .unread-marker) + .msg.previous-source";
		expect(valueOf(after, "grid-template-areas")?.replace(/\s+/g, " ")).to.equal(
			'"time from" ". content"'
		);
		expect(valueOf(`${after} .from`, "display")).to.equal("block");
		expect(valueOf(`${after} .time`, "visibility")).to.equal("visible");
		expect(
			compareSpecificity(specificity(`${after} .from`), specificity(`${run} .from`))
		).to.be.at.least(0);
		expect(
			rules.findIndex((r) => r.selectors.includes(`${after} .from`)) -
				rules.findIndex((r) => r.selectors.includes(`${run} .from`)),
			"after the rule that hides them"
		).to.be.above(0);
	});

	it("runs every other row as its time, its icon, then the text; a condensed summary's text stands with the nicks", function () {
		expect(valueOf(SYS, "display")).to.equal("grid");
		expect(valueOf(SYS, "grid-template-areas")).to.equal('"time from content"');
		expect(valueOf(`${SYS} .time`, "grid-area")).to.equal("time");
		expect(valueOf(`${SYS} .from`, "grid-area")).to.equal("from");
		expect(valueOf(`${SYS} .content`, "grid-area")).to.equal("content");
		expect(valueOf(`${SYS} .from`, "order"), "no reordering: the grid places it").to.equal(
			undefined
		);
		expect(valueOf("#chat .chat .condensed-summary", "grid-template-areas")).to.equal(
			'"time content"'
		);
		expect(valueOf("#chat .chat .condensed-summary .from", "display")).to.equal("none");
	});

	it("wins over style.css's narrow inline flow on the same elements, so the row is alike at every width", function () {
		const narrow = style.filter(
			(r) =>
				r.at.includes("@container chat (max-width: calc(50ch + 2.5rem))") &&
				r.selectors.some((sel) =>
					/^#chat \.(msg|time|from|content|condensed-summary)\b/.test(sel)
				)
		);
		expect(narrow.length, "style.css's narrow rules for the row").to.be.greaterThan(0);
		const theirs = narrow
			.flatMap((r) => r.selectors)
			.filter((sel) => !/highlight|who|table|condensed"\] \.msg/.test(sel))
			.map(specificity)
			.sort(compareSpecificity)
			.at(-1)!;
		const stacked = /^#chat \.chat \.(msg(?=[:.[])|condensed-summary)/;
		const ours = rules
			.filter((r) => r.at === "" && r.selectors.some((sel) => stacked.test(sel)))
			.flatMap((r) => r.selectors)
			.filter((sel) => stacked.test(sel))
			.map(specificity)
			.sort(compareSpecificity)[0];
		// At least as heavy: ps.css is linked after style.css, so at equal
		// weight the later rule wins.
		expect(
			compareSpecificity(ours, theirs),
			`ours ${ours.join()} against theirs ${theirs.join()}`
		).to.be.at.least(0);
	});
});

describe("the ps theme's motion", function () {
	it("fades messages in, raises the chrome, glows a mention, and stands down under reduced motion", function () {
		expect(css).to.include("@keyframes ps-fade");
		expect(css).to.match(/#chat \.msg \{[^}]*animation: ps-fade 340ms ease-out backwards/);
		expect(css).to.match(/#chat \.msg\.pending \{[^}]*animation-name: none/);
		expect(css).to.include("@keyframes ps-rise");
		expect(css).to.include("@keyframes ps-glow");
	});

	it("settles an own message up from where its pending copy stood, never through nothing", function () {
		// The echo replaces the pending copy as a new row; fading it in from 0
		// blinked every sent line out and back. It starts at style.css's
		// pending opacity instead, so the row only brightens.
		const style = fs.readFileSync(
			path.resolve(__dirname, "../../client/css/style.css"),
			"utf8"
		);
		const pending = /#chat \.msg\.pending \{[^}]*opacity: ([\d.]+);/.exec(style)?.[1];
		expect(pending, "style.css's pending opacity").to.equal("0.55");
		const settle = /@keyframes ps-settle \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		expect(settle).to.include(`from { opacity: ${pending}; }`);
		expect(settle).to.include("to { opacity: 1; }");
		expect(css).to.match(
			/#chat \.msg\.self:not\(\.pending\) \{[^}]*animation-name: ps-settle;/
		);
	});

	it("keeps the rest of its motion", function () {
		expect(css).to.include("@keyframes ps-rise");
		expect(css).to.include("@keyframes ps-glow");
		expect(css).to.match(
			/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none !important/
		);
	});
});

describe("the ps theme under reduced motion (spec §9): nothing moves, and the hour still shows", function () {
	const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
	const S = "#theme-scene";
	/**
	 * What exists only in flight. With every scene animation gone (the block's
	 * `animation: none !important`) each would stand parked where its box
	 * puts it — the buzzard on the sky, a skein and the seeds off an edge,
	 * the drops and flakes just above the top, a smoke puff at 0 — so each
	 * leaves the render tree instead.
	 */
	const HIDDEN = [
		".ps-skeins",
		".ps-daybirds",
		".ps-rain",
		".ps-snow",
		".ps-seeds",
		".ps-flash",
		".ps-smoke",
	];

	it("hides what only exists in flight: the birds, the rain, snow and seeds, the lightning and the smoke", function () {
		for (const layer of HIDDEN) {
			expect(valueOf(`${S} ${layer}`, "display", REDUCED_MOTION), layer).to.equal("none");
		}

		// Those are the layers the scene builds them in: every bird in the
		// skeins or the day birds, the smoke's puffs in theirs, and each of the
		// weather's particles and the flash in its own.
		const scene = sceneMarkup(false);
		expect(scene).to.match(
			/<div class="ps-skeins">(?:(?!<div class="ps-daybirds">)[\s\S])*class="ps-flock"/
		);
		expect(scene).to.match(
			/<div class="ps-daybirds">[\s\S]*class="ps-buzzard"[\s\S]*class="ps-lark"/
		);
		expect(scene).to.match(/<div class="ps-smoke"><i /);
		expect(weatherLayers("storm", false)).to.match(
			/class="ps-seeds"[\s\S]*class="ps-rain"[\s\S]*class="ps-flash"/
		);
		expect(weatherLayers("snow", false)).to.include('class="ps-snow"');
	});

	it("keeps the veil, the fireflies as still dots where they are, the grass at rest and the heat band: nothing else is hidden or moved", function () {
		// The veil stays, so a rainy day still looks rainy; a firefly is a
		// point of light like a star, and a still one still reads as one.
		const hiding = rules.filter(
			(r) => r.at === REDUCED_MOTION && r.decls.some(([p]) => p === "display")
		);
		expect(hiding.flatMap((r) => r.selectors).sort()).to.deep.equal(
			HIDDEN.map((layer) => `${S} ${layer}`).sort()
		);
		// Nothing under reduced motion places anything but a cloud's rest.
		const placing = rules.filter(
			(r) =>
				r.at === REDUCED_MOTION &&
				r.decls.some(([p]) => ["transform", "translate", "left", "top"].includes(p))
		);
		expect(placing.flatMap((r) => r.selectors)).to.deep.equal([`${S} .ps-cloud`]);
		// With the drift and the sway gone, each stands where its own rule puts
		// it: the fireflies where their drift starts, the blades upright.
		expect(valueOf(`${S} .ps-fireflies i`, "transform")).to.equal(undefined);
		expect(css).to.match(/@keyframes ps-ffdrift \{\s*from \{ transform: translate\(0, 0\); \}/);
		expect(valueOf(`${S} .ps-blades .ps-sway`, "transform")).to.equal(undefined);
	});

	it("lets no other rule show a hidden layer again", function () {
		const showing = rules.filter(
			(r) =>
				r.selectors.some((sel) => HIDDEN.some((layer) => sel.endsWith(layer))) &&
				r.decls.some(([p, v]) => p === "display" && v !== "none")
		);
		expect(showing.map((r) => [r.at, r.selectors])).to.deep.equal([]);
	});

	it("flips the words' treatment at once: every rule that eases their colour over 0.8 s stands down", function () {
		const eased = rules.filter(
			(r) =>
				r.at === "" &&
				r.decls.some(([p, v]) => p === "transition" && /\bcolor 0\.8s/.test(v))
		);
		expect(eased.length, "the words' ease").to.be.at.least(1);
		const stood = rules
			.filter(
				(r) =>
					r.at === REDUCED_MOTION &&
					r.decls.some(([p, v]) => p === "transition" && v === "none !important")
			)
			.flatMap((r) => r.selectors);

		for (const selector of eased.flatMap((r) => r.selectors)) {
			// `#chat .msg` covers every message row, `#chat .chat .msg` included.
			const covered =
				stood.includes(selector) ||
				(stood.includes("#chat .msg") && /^#chat( .+)? \.msg$/.test(selector));
			expect(covered, selector).to.equal(true);
		}
	});
});

describe("the ps theme's embers (spec §9)", function () {
	// The <3 theme's glitter is gone; embers take its two moments (an own
	// message arriving, a reaction arriving): a few small glowing sparks rise
	// and fade, CSS only, on pseudo-elements. The mockup's `.ember` and
	// `effect("embers")` (docs/resources/themes/ps-plains/mockup.html) are
	// the reference; its random offsets are fixed here, four sets for a send
	// and two for a reaction's chip.
	const MOTION_OK = "@media (prefers-reduced-motion: no-preference)";
	const CH = '#chat .chat-view[data-type="channel"]';
	const OWN = `${CH} .msg.self:is([data-type="message"], [data-type="action"]):not(.pending):last-child`;
	/** A send's four sparks, in the order they rise. */
	const SEND = [
		`${OWN}::before`,
		`${OWN}::after`,
		`${OWN} > .content::before`,
		`${OWN} > .content::after`,
	];
	/** A chip entering on its own (TransitionGroup), and the first chip of a group entering (Transition). */
	const CHIP = [
		`${CH} .reaction-enter-active .msg-reaction-text::before`,
		`${CH} .reaction-enter-active .msg-reaction-text::after`,
	];
	const GROUP = [
		`${CH} .reactions-enter-active .msg-reaction-text::before`,
		`${CH} .reactions-enter-active .msg-reaction-text::after`,
	];
	const SPARKS = [...SEND, ...CHIP, ...GROUP];
	const ENTER = [`${CH} .reaction-enter-active`, `${CH} .reactions-enter-active`];
	const UNCLIP = `${CH} .content:has(.reaction-enter-active, .reactions-enter-active)`;
	const style = fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8");

	/** Every declaration `selector` gets under no-preference, folded in source order. */
	const spark = (selector: string) => new Map(declsOf(selector, MOTION_OK));
	const seconds = (v: string) => (v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v));

	const rem = (v: string | undefined) => {
		expect(v, "an offset in rem").to.match(/^-?\d*\.?\d+rem$/);
		return parseFloat(v as string);
	};

	// A rule that only takes a pseudo-element away (`content: none`, the
	// stacked rows' undoing of style.css's spacer) draws nothing.
	const pseudoSelectors = rules
		.filter(
			(r) =>
				!(r.decls.length === 1 && r.decls[0][0] === "content" && r.decls[0][1] === "none")
		)
		.flatMap((r) => r.selectors)
		.filter((s) => /::(before|after)$/.test(s));
	const withoutNot = (s: string) => s.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");

	it("keeps the <3 theme's glitter gone: no burst tokens, no sparkle keyframes", function () {
		expect(css, "no burst tokens").to.not.match(/--ps-burst-/);
		expect(css, "no sparkle keyframes").to.not.match(/@keyframes [\w-]*sparkle/);
	});

	it("lights an own message's echo, never its pending copy: four sparks, on the row's and its text's pseudo-elements", function () {
		const onRows = pseudoSelectors.filter((s) => /\.msg(?![\w-])/.test(s));
		expect([...new Set(onRows)]).to.have.members(SEND);
		const onPending = pseudoSelectors.filter((s) => /\.pending(?![\w-])/.test(withoutNot(s)));
		expect(onPending, "no pseudo-element on a pending copy").to.deep.equal([]);

		for (const s of onRows) {
			expect(s, "the echo, not the pending copy").to.include(":not(.pending)");
			expect(s, "while it is the newest row").to.include(":last-child");
		}
	});

	it("lights a smaller burst as a reaction arrives: two sparks over the chip, off its text, for a chip entering alone and for the first of a group", function () {
		const onChips = pseudoSelectors.filter((s) => /msg-reaction|enter-active/.test(s));
		expect([...new Set(onChips)]).to.have.members([...CHIP, ...GROUP]);
		// Never the chip's own pseudo-elements: they are its tooltip (primer-tooltips).
		expect(onChips.filter((s) => /\.msg-reaction(?![\w-])[^ ]*::/.test(s))).to.deep.equal([]);

		for (const [a, b] of [
			[CHIP[0], GROUP[0]],
			[CHIP[1], GROUP[1]],
		]) {
			expect([...spark(b)], `${b} is ${a}`).to.deep.equal([...spark(a)]);
		}
	});

	it("holds the enter classes open for the chip's burst: style.css's pop restated, then a do-nothing hold as long as the latest spark", function () {
		const pop = /#chat \.reaction-enter-active \{\s*animation: ([^;]+);/.exec(style)?.[1];
		expect(pop, "style.css's pop").to.equal("reaction-pop 160ms ease-out");
		const latest = Math.max(
			...[...CHIP, ...GROUP].map((s) => {
				const d = spark(s);
				return (
					seconds(d.get("animation-delay") ?? "0s") +
					seconds(d.get("animation-duration") ?? "0s")
				);
			})
		);

		for (const s of ENTER) {
			const value = valueOf(s, "animation", MOTION_OK);
			const hold = /^reaction-pop 160ms ease-out, ps-ember-hold ([\d.]+m?s) linear$/.exec(
				value ?? ""
			);
			expect(hold, `${s}: ${value}`).to.not.equal(null);
			expect(seconds(hold![1]), `${s} holds past the latest spark`).to.be.at.least(latest);
			// It must outrank style.css's own enter rule, or the hold never applies.
			expect(
				compareSpecificity(specificity(s), specificity("#chat .reaction-enter-active"))
			).to.be.above(0);
		}

		const hold = rules.filter((r) => r.at === "@keyframes ps-ember-hold");
		expect(hold.map((r) => r.decls)).to.deep.equal([[["visibility", "visible"]]]);
	});

	it("widens the text column's clip while a chip's burst runs by just the sparks' rise and glow, never lifting style.css's anti-Zalgo clip", function () {
		expect(style).to.match(/#chat \.content \{[^}]*overflow: hidden;/);
		// clip, not visible: combining marks stacked past the margin stay cut
		// off, and clip makes no scroll container, as hidden did not need to be.
		expect(valueOf(UNCLIP, "overflow", MOTION_OK)).to.equal("clip");
		// The margin is the chip sparks' highest rise plus the glow's blur and
		// spread (their box-shadow): a spark starts inside the column, so that
		// is as far past its edge as any of it is drawn.
		const rise = Math.max(
			...[...CHIP, ...GROUP].map((s) => -rem(spark(s).get("--ps-ember-y")))
		);
		const [blur, spread] = (spark(CHIP[0]).get("box-shadow") ?? "")
			.split(" ")
			.slice(2, 4)
			.map((v) => rem(v));
		expect(valueOf(UNCLIP, "overflow-clip-margin", MOTION_OK)).to.equal(
			`${rise + blur + spread}rem`
		);
		const unclipped = rules.filter((r) =>
			r.decls.some(([p, v]) => /^overflow(-[xy])?$/.test(p) && v === "visible")
		);
		expect(
			unclipped.flatMap((r) => r.selectors).filter((s) => /\.content(?![\w-])/.test(s)),
			"nothing makes the text column overflow visibly"
		).to.deep.equal([]);
	});

	it("draws every spark as the mockup's ember: a 0.25rem dot of #ffc46e glowing, out of the flow and the pointer's way, filled both ways", function () {
		for (const s of SPARKS) {
			const d = spark(s);
			expect(d.get("content"), s).to.equal('""');
			expect(d.get("position"), s).to.equal("absolute");
			expect(d.get("width"), s).to.equal("0.25rem");
			expect(d.get("height"), s).to.equal("0.25rem");
			expect(d.get("border-radius"), s).to.equal("50%");
			expect(d.get("background"), s).to.equal("#ffc46e");
			expect(d.get("box-shadow"), s).to.equal("0 0 0.375rem 0.125rem rgb(255 160 70 / 65%)");
			expect(d.get("pointer-events"), s).to.equal("none");
			expect(d.get("top"), s).to.equal("40%");
			expect(d.get("animation"), s).to.match(
				/^ps-ember [\d.]+m?s cubic-bezier\(0\.25, 0\.6, 0\.35, 1\) both$/
			);
			expect(d.has("z-index"), `${s} paints with its row: an overlay above it stays above`).to
				.be.false;
		}
	});

	it("rises, drifts and fades as the mockup's keyframes: from translate(0, 0) scale(0.6) unseen, full at 15 %, to its own offsets at scale(0.2) unseen", function () {
		const frames = rules.filter((r) => r.at === "@keyframes ps-ember");
		const at = (key: string) => new Map(frames.find((r) => r.selectors.includes(key))?.decls);
		expect(frames.map((r) => r.selectors.join())).to.deep.equal(["0%", "15%", "100%"]);
		expect([...at("0%")]).to.have.deep.members([
			["opacity", "0"],
			["transform", "translate(0, 0) scale(0.6)"],
		]);
		expect([...at("15%")]).to.deep.equal([["opacity", "1"]]);
		expect([...at("100%")]).to.have.deep.members([
			["opacity", "0"],
			["transform", "translate(var(--ps-ember-x), var(--ps-ember-y)) scale(0.2)"],
		]);
	});

	it("gives each spark offsets of its own in rem, inside the mockup's ranges, a life of 1.9–2.8 s, 0.18 s apart, from 40 % of the height and the first 60 % of the width", function () {
		for (const [set, count] of [
			[SEND, 4],
			[CHIP, 2],
			[GROUP, 2],
		] as const) {
			expect(set).to.have.length(count);
			const seen = new Set<string>();

			set.forEach((s, i) => {
				const d = spark(s);
				// Rise 34–74 px and drift −8–22 px at 16 px (the mockup's), as rem.
				const x = rem(d.get("--ps-ember-x"));
				const y = rem(d.get("--ps-ember-y"));
				expect(x, `${s} drifts`).to.be.within(-0.5, 1.375);
				expect(y, `${s} rises`).to.be.within(-4.625, -2.125);
				expect(seconds(d.get("animation-duration") ?? ""), `${s} lives`).to.be.within(
					1.9,
					2.8
				);
				expect(seconds(d.get("animation-delay") ?? ""), `${s} is staggered`).to.be.closeTo(
					i * 0.18,
					1e-9
				);
				const left = d.get("left") ?? "";
				expect(left, s).to.match(/^\d+(\.\d+)?%$/);
				expect(parseFloat(left), `${s} starts in the first 60 %`).to.be.within(0, 60);
				seen.add(`${x} ${y} ${left}`);
			});

			expect(seen.size, "no two sparks alike").to.equal(count);
		}
	});

	it("exists only where motion is welcome: every ember rule under prefers-reduced-motion: no-preference, and nothing of it in the reduced-motion block", function () {
		const ours = rules.filter(
			(r) =>
				!r.at.startsWith("@keyframes") &&
				(r.selectors.some(
					(s) => s.startsWith(CH) && /enter-active|::(before|after)$/.test(s)
				) ||
					r.decls.some(([p, v]) => /ember/.test(`${p}:${v}`)))
		);
		expect(ours.length).to.be.at.least(SPARKS.length);

		for (const r of ours) {
			expect(r.at, r.selectors.join(", ")).to.equal(MOTION_OK);
		}

		const reduced = rules.filter((r) => r.at.includes("prefers-reduced-motion: reduce"));
		expect(
			reduced.filter((r) =>
				/ember|enter-active/.test(r.selectors.join() + JSON.stringify(r.decls))
			)
		).to.deep.equal([]);
	});

	it("stays out of a query, where the plains stand still (spec §5.7): every ember rule is a channel's", function () {
		const ours = rules.filter((r) => r.at === MOTION_OK);
		expect(ours.length).to.be.above(0);

		for (const r of ours) {
			for (const s of r.selectors) {
				expect(s.startsWith(`${CH} `), `${s}: a channel's conversation`).to.be.true;
			}
		}
	});
});

describe("the ps theme's scene", function () {
	const style = fs.readFileSync(path.resolve(__dirname, "../../client/css/style.css"), "utf8");

	it("is hidden by style.css for every theme, and shown by ps", function () {
		expect(style).to.match(/#theme-scene\s*\{\s*display:\s*none;\s*\}/);
		expect(css).to.match(/#theme-scene\s*\{[^}]*display:\s*block;/);
	});

	it("paints daylight when the scene is absent: sky and canvas from the midday stop, and a halo, outside any state selector", function () {
		expect(css).to.match(/#theme-scene\s*\{[^}]*var\(--ps-sky-top,\s*#3f8fe6\)/);
		const root = css.match(/:root\s*\{[^}]*--canvas-bg-color:\s*#3f8fe6;[^}]*\}/);
		expect(root, "a :root block defines the daylight canvas").to.not.equal(null);
		expect(css).to.match(/--ps-halo:\s*#ebf5fd;/);
		expect(css).to.not.match(/\[data-ps-(light|text)[^\]]*\][^{]*\{[^}]*--canvas-bg-color/);
	});

	it("stops every scene animation while paused and under reduced motion", function () {
		expect(css).to.match(
			/#theme-scene\.ps-paused \*\s*\{\s*animation-play-state:\s*paused !important;/
		);
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).to.match(/#theme-scene \*[^{]*\{\s*animation:\s*none !important;/);
	});

	it("takes a layer outside its window out of the render tree, and waits out exactly the fade ps.css gives it (layers.ts, spec §10)", function () {
		expect(valueOf("#theme-scene .ps-off", "display")).to.equal("none");
		// Where each gated layer's opacity transition is declared: the day birds share theirs.
		const fadeRule: Record<Gate, string> = {
			stars: "#theme-scene .ps-stars",
			sun: "#theme-scene .ps-sun",
			fireflies: "#theme-scene .ps-fireflies",
			smoke: "#theme-scene .ps-smoke",
			skeins: "#theme-scene .ps-skeins",
			flock0: "#theme-scene .ps-flock",
			flock1: "#theme-scene .ps-flock",
			flock2: "#theme-scene .ps-flock",
			buzzard: "#theme-scene .ps-daybirds > div",
			larks: "#theme-scene .ps-daybirds > div",
			seeds: "#theme-scene .ps-seeds",
			heatband: "#theme-scene .ps-heatband",
		};

		for (const gate of Object.keys(GATES) as Gate[]) {
			const {fadeMs} = GATES[gate];
			expect(valueOf(fadeRule[gate], "transition"), gate).to.equal(
				fadeMs > 0 ? `opacity ${fadeMs / 1000}s ease` : undefined
			);
		}

		// Nothing gives a gated layer a display of its own that could outrank the
		// gate and show it. Reduced motion's `display: none` (the layers that
		// exist only in flight) takes out more, never less.
		const gated = new Set(Object.values(GATES).map((g) => g.selector));
		const displays = rules.filter(
			(r) =>
				r.selectors.some((sel) => [...gated].some((g) => sel.endsWith(g))) &&
				r.decls.some(([p, v]) => p === "display" && v !== "none")
		);
		expect(displays.map((r) => r.selectors)).to.deep.equal([]);
	});

	it("paints each gated layer's opacity from the custom properties its gate reads (layers.ts liveLayers ↔ ps.css)", function () {
		// Every value the scene writes, each shown; then each alone at 0, to see
		// which gates it takes out: those are the properties liveLayers reads for
		// a gate.
		const m = momentFor({
			minute: 720,
			doy: 268,
			dayNumber: 20721,
			epochDays: 20721.5,
			weather: "clear",
		});
		const written = Object.keys(sceneVars(m, paletteAt(m)));
		const shown = Object.fromEntries(written.map((name) => [name, "3"]));
		const gates = Object.keys(GATES) as Gate[];
		expect(
			gates.filter((g) => !liveLayers(shown)[g]),
			"every gate live with every value shown"
		).to.deep.equal([]);
		const reads = new Map<Gate, string[]>(gates.map((g) => [g, []]));

		for (const name of written) {
			const live = liveLayers({...shown, [name]: "0"});

			for (const g of gates.filter((gate) => !live[gate])) {
				reads.get(g)!.push(name);
			}
		}

		// What each gated layer's opacity reads in ps.css, of the values the scene writes.
		const painted = (gate: Gate) => {
			const selector = `#theme-scene ${GATES[gate].selector}`;
			const values = rules
				.filter((r) => r.selectors.includes(selector))
				.flatMap((r) => r.decls)
				.filter(([p]) => p === "opacity")
				.map(([, v]) => v);
			expect(values, `${selector} has an opacity of its own`).to.not.deep.equal([]);
			return values.map((v) => ({
				value: v,
				vars: [...v.matchAll(/var\((--[\w-]+)/g)]
					.map((x) => x[1])
					.filter((n) => written.includes(n)),
			}));
		};

		// A flock is inside the skeins' layer (birds.ts skeinsMarkup), whose opacity fades it too.
		const WITHIN: Partial<Record<Gate, Gate>> = {
			flock0: "skeins",
			flock1: "skeins",
			flock2: "skeins",
		};
		expect(sceneMarkup(false)).to.match(
			/<div class="ps-skeins">(?:(?!<div class="ps-daybirds">)[\s\S])*class="ps-flock"/
		);

		for (const gate of gates) {
			const own = painted(gate);
			const theirs = reads.get(gate)!;
			expect(theirs, `${gate}: liveLayers reads the scene's values`).to.not.deep.equal([]);

			for (const {value, vars} of own) {
				expect(
					vars,
					`${gate}: opacity: ${value} reads a value the scene writes`
				).to.not.deep.equal([]);
				expect(
					theirs,
					`${gate}: opacity: ${value} reads what its gate reads`
				).to.include.members(vars);
			}

			const outer = WITHIN[gate];
			const shownBy = [...own, ...(outer ? painted(outer) : [])].flatMap((o) => o.vars);
			expect(
				shownBy,
				`${gate}: every value its gate reads fades it in ps.css`
			).to.include.members(theirs);
		}
	});

	it("gives every scene element its own box-sizing, the border-box html gives it, so none inherits it explicitly (task 8b)", function () {
		// style.css's `*, *::before, *::after { box-sizing: inherit }` marks every
		// element as explicitly inheriting, and Chromium then restyles an
		// element's children whenever it is restyled, and at several times the
		// cost: each animated element dragged its subtree into every frame.
		expect(style).to.match(/html\s*\{[^}]*box-sizing:\s*border-box;/);
		expect(style).to.match(/\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*inherit;/);
		const own = rules.filter(
			(r) =>
				r.at === "" &&
				r.selectors.join(", ") === "#theme-scene, #theme-scene *" &&
				r.decls.some(([p, v]) => p === "box-sizing" && v === "border-box")
		);
		expect(own, "one rule for the scene and everything in it").to.have.length(1);
		// And nothing in the scene asks for another box.
		const other = rules.filter(
			(r) =>
				r.selectors.some((sel) => sel.startsWith("#theme-scene")) &&
				r.decls.some(([p, v]) => p === "box-sizing" && v !== "border-box")
		);
		expect(other.map((r) => r.selectors)).to.deep.equal([]);
	});

	it("no longer paints a meadow on the message area or reads the channel seed", function () {
		expect(css).to.not.include("--channel-seed");
		expect(css).to.not.include("data-scene");
		expect(css).to.not.include("ps-rainbow");
		expect(css).to.not.include("ps-clouds");
	});
});

describe("the ps theme's private view (spec §5.7): the plains frosted and still in a query", function () {
	const FROST = "#theme-scene .ps-frost";
	const PRIVATE = "#theme-scene.ps-private .ps-frost";
	const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

	it("lays the one wrapper over the whole scene and positions every layer inside it, as when they were the root's own", function () {
		expect(valueOf(FROST, "position")).to.equal("absolute");
		expect(valueOf(FROST, "inset")).to.equal("0");
		expect(valueOf(`${FROST} > *`, "position")).to.equal("absolute");
		// Not a container: what travels across the scene still moves in cqw/cqh of #theme-scene.
		expect(declsOf(FROST).map(([p]) => p)).to.not.include("container-type");
		expect(sceneMarkup(false)).to.match(/^<div class="ps-frost">/);
	});

	it("frosts the wrapper in a query: blurred 18 px as rem and desaturated to 0.85", function () {
		expect(valueOf(PRIVATE, "filter")).to.equal("blur(1.125rem) saturate(0.85)");
	});

	it("scales it just past the blur's edge: the mockup's margin of 1.44 blurs at the 390 px phone, filter first", function () {
		// The filter blurs in the wrapper's own space and the scale enlarges
		// the result, blur and all: the window's edge falls D(s − 1)/(2s) inside
		// the wrapper's, which is to be 1.44 σ, the margin the approved mockup's
		// scale(1.08) left at its 700 px window (700 · 0.08 / 2.16 / 18).
		const sigma = Number(/blur\(([\d.]+)rem\)/.exec(valueOf(PRIVATE, "filter") ?? "")?.[1]);
		const scale = Number(/^scale\(([\d.]+)\)$/.exec(valueOf(PRIVATE, "transform") ?? "")?.[1]);
		const phone = 390 / 20; // the phone the spec measures, at the default font-size step, in rem
		const mockup = (700 * 0.08) / (2 * 1.08) / 18;
		expect(mockup).to.be.closeTo(1.44, 0.005);
		const need = phone / (phone - 2 * 1.44 * sigma);
		expect(scale, "no less than the margin needs").to.be.at.least(need);
		expect(scale - need, "and no more than a hundredth over it").to.be.below(0.01);
		// The noon sun (10 % from the top) keeps its centre in the window: 50 − 40 s > 0.
		expect(50 - 40 * scale).to.be.above(0);
	});

	it("eases the frost in and out over the theme's flip, and gives the wrapper no filter, transform or layer outside a query", function () {
		expect(valueOf(FROST, "transition")).to.equal(
			"filter var(--ps-flip), transform var(--ps-flip)"
		);

		for (const property of [
			"filter",
			"transform",
			"will-change",
			"backdrop-filter",
			"opacity",
		]) {
			expect(valueOf(FROST, property), property).to.equal(undefined);
		}

		// Only these rules name the wrapper, and only the private one frosts it.
		const naming = rules.filter((r) => r.selectors.some((s) => s.includes(".ps-frost")));
		expect(naming.map((r) => [r.at, r.selectors.join(", ")])).to.deep.equal([
			["", FROST],
			["", `${FROST} > *`],
			["", PRIVATE],
		]);
	});

	it("comes at once under reduced motion: the flip is 0 s and the scene's `transition: none` covers the wrapper", function () {
		const stills = rules.filter(
			(r) => r.at === REDUCED_MOTION && r.selectors.includes("#theme-scene *")
		);
		expect(stills.flatMap((r) => r.decls)).to.deep.include(["transition", "none !important"]);
		expect(declsOf(":root", REDUCED_MOTION)).to.deep.include(["--ps-flip", "0s"]);
	});

	it("frosts the scene's layers alone: nothing under ps-private reaches the root's sky and canvas, <html> or the chrome", function () {
		const underPrivate = rules.flatMap((r) =>
			r.selectors.filter((s) => s.includes("ps-private")).map((s) => [r.at, s])
		);
		expect(underPrivate).to.deep.equal([["", PRIVATE]]);
		// The still is the hidden page's own pause (scene.ts sets ps-paused too): no rule of its own.
		expect(css).to.not.match(/ps-private[^{]*\{[^}]*animation/);
	});
});

describe("the ps theme's words over the plains (spec §7)", function () {
	/** The eight-way ring of offsets `o` (rem) at `pct` % black, blurred 0.0625rem. */
	const ring = (o: string, pct: number) =>
		[
			[o, "0"],
			[`-${o}`, "0"],
			["0", o],
			["0", `-${o}`],
			[o, o],
			[`-${o}`, o],
			[o, `-${o}`],
			[`-${o}`, `-${o}`],
		].map(([x, y]) => `${x} ${y} 0.0625rem rgb(0 0 0 / ${pct}%)`);

	it("draws white words over the soft shadow, the user's B (eight 1px offsets at 78 %) and under it the faint wider ring (eight 2px offsets at 28 %, the user's pick 2026-09-25), in that order: the first shadow paints on top", function () {
		const shadow = valueOf(':root[data-ps-text="light"] #chat .chat .msg', "text-shadow");
		expect(shadow, "the light treatment's text-shadow").to.not.equal(undefined);
		expect(shadow!.split(/,\s*(?![^()]*\))/)).to.deep.equal([
			"0 0.0625rem 0.094rem rgb(0 0 0 / 70%)",
			"0 0 0.1875rem rgb(0 0 0 / 45%)",
			"0 0.0625rem 0.625rem rgb(0 0 0 / 35%)",
			...ring("0.0625rem", 78),
			...ring("0.125rem", 28),
		]);

		for (const other of [
			':root[data-ps-text="light"] #chat .chat .show-more',
			':root[data-ps-text="light"] #chat .chat .search-status',
			':root[data-ps-text="light"] #chat .chat .search-scope-note',
		]) {
			expect(valueOf(other, "text-shadow"), other).to.equal(shadow);
		}
	});
});

describe("the ps theme's plains (plan 3: the land, the river, the near grass, the fireflies)", function () {
	const S = "#theme-scene";

	it("makes the scene a size container, so what travels across it moves in cqw/cqh", function () {
		expect(valueOf(S, "container-type")).to.equal("size");
	});

	it("fills every land area from the colour the palette publishes for it", function () {
		const AREAS: Record<string, string> = {
			"ps-l-mount2": "var(--ps-mount2)",
			"ps-l-mount": "var(--ps-mount)",
			"ps-l-far": "var(--ps-far)",
			"ps-l-shrub": "var(--ps-shrub)",
			"ps-l-riverbed": "var(--ps-riverbed)",
			"ps-l-bedstone": "var(--ps-bedstone)",
			"ps-l-hill2": "var(--ps-hill2)",
			"ps-l-tuft2": "var(--ps-tuft2)",
			"ps-l-tree": "var(--ps-tree)",
			"ps-l-trunk": "var(--ps-trunk)",
			"ps-l-hill1": "var(--ps-hill1)",
			"ps-l-tuft1": "var(--ps-tuft1)",
			"ps-l-tuft-lit": "var(--ps-tuft-lit)",
			"ps-l-grass": "var(--ps-grass)",
		};

		for (const [name, fill] of Object.entries(AREAS)) {
			expect(valueOf(`${S} .${name}`, "fill"), name).to.equal(fill);
		}

		expect(valueOf(`${S} .ps-blades path`, "fill")).to.equal("var(--ps-blade)");
		// The river's sky is its own fill attribute (plains.ts); a class fill would cover it.
		expect(valueOf(`${S} .ps-l-river`, "fill")).to.equal(undefined);
	});

	it("mixes no area colour in CSS: color-mix is left to the lines (the rims, the river's glint)", function () {
		const LINES = [`${S} .ps-l-rim`, `${S} .ps-l-river-hi`];
		const areas = rules.filter((r) =>
			r.selectors.some(
				(sel) =>
					/^#theme-scene \.(ps-l-|ps-blades|ps-ground|ps-fireflies)/.test(sel) &&
					!LINES.includes(sel)
			)
		);
		expect(areas.length, "the land's rules").to.be.at.least(15);

		for (const r of areas) {
			for (const [p, v] of r.decls) {
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.include("color-mix");
			}
		}
	});

	it("runs the river by the season: the water's opacity is --ps-water and the stones' its complement", function () {
		expect(valueOf(`${S} .ps-l-river`, "opacity")).to.match(/^var\(--ps-water(, 1)?\)$/);
		expect(valueOf(`${S} .ps-l-bedstone`, "opacity")).to.match(
			/^calc\(1 - var\(--ps-water(, 1)?\)\)$/
		);
		expect(valueOf(`${S} .ps-l-river-hi`, "opacity")).to.include("var(--ps-water");
		expect(valueOf(`${S} .ps-l-river-hi`, "stroke")).to.equal("var(--ps-river-hi)");
	});

	it("lights the far tufts and the rims from the published levels", function () {
		expect(valueOf(`${S} .ps-l-tuft-lit`, "opacity")).to.equal("var(--ps-tuft-lit-op)");
		expect(valueOf(`${S} .ps-l-rim`, "stroke")).to.equal("var(--ps-glow)");
		expect(valueOf(`${S} .ps-l-rim`, "opacity")).to.include("var(--ps-glow-op");
	});

	it("puts the land on the window's lower 56 % and the near grass on its lower 19 %", function () {
		expect(valueOf(`${S} .ps-land`, "bottom")).to.equal("0");
		expect(valueOf(`${S} .ps-land`, "height")).to.equal("56%");
		expect(valueOf(`${S} .ps-land`, "width")).to.equal("100%");
		expect(valueOf(`${S} .ps-blades`, "bottom")).to.equal("0");
		expect(valueOf(`${S} .ps-blades`, "height")).to.equal("19%");
		expect(valueOf(`${S} .ps-blades`, "width")).to.equal("100%");
	});

	it("keeps the ground group whole and positions what is inside it", function () {
		expect(valueOf(`${S} .ps-ground`, "inset")).to.equal("0");
		expect(valueOf(`${S} .ps-ground > *`, "position")).to.equal("absolute");
	});

	it("fades the flowers by the season and the dark", function () {
		const opacity = valueOf(`${S} .ps-blades circle`, "opacity") ?? "";
		expect(opacity).to.match(/var\(--ps-flowers(, 1)?\)/);
		expect(opacity).to.include("var(--ps-dark)");
	});

	it("sways the blades by the weather's angle with its own keyframes", function () {
		expect(valueOf(`${S} .ps-blades .ps-sway`, "animation")).to.match(/^ps-sway /);
		const frames = css.match(/@keyframes ps-sway\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
		expect(frames).to.include("skewX(");
		expect(frames).to.include("var(--ps-sway");
		expect(css.match(/@keyframes ps-sway\b/g), "one ps-sway").to.have.length(1);
		expect(css, "no bare sway keyframes").to.not.match(/@keyframes sway\b/);
	});

	it("shows the fireflies by the published level, small and drifting in rem", function () {
		expect(valueOf(`${S} .ps-fireflies`, "opacity")).to.match(/^var\(--ps-ff-op(, 0)?\)$/);
		const fly = declsOf(`${S} .ps-fireflies i`);
		expect(fly.length).to.be.greaterThan(0);

		for (const [p, v] of fly) {
			expect(v, `.ps-fireflies i { ${p} }`).to.not.match(/\d px|\dpx/);
		}

		expect(css).to.match(/@keyframes ps-ffdrift\b/);
		expect(css).to.match(/@keyframes ps-ffblink\b/);
	});
});

describe("the ps theme's yurt and its smoke (plan 3, spec §5.3)", function () {
	const S = "#theme-scene";
	const YURT = `${S} .ps-yurt`;
	const SMOKE = `${S} .ps-smoke`;
	/**
	 * The place: what scene.ts measured (yurt.ts clamps it so the whole yurt
	 * is on screen); before that, 70 % of the scene clamped the same way. The
	 * yurt is 21 % of the scene's height tall, so half its width is
	 * 21cqh × 120/170.
	 */
	const PLACE =
		"var(--ps-yurt-left, clamp(calc(21cqh * 120 / 170), 70%, calc(100% - 21cqh * 120 / 170)))";

	it("stands on the ground band at the place the scene measures, 70 % before it has one", function () {
		expect(valueOf(YURT, "left")).to.equal(PLACE);
		expect(valueOf(YURT, "bottom")).to.equal("17%");
		expect(valueOf(YURT, "height")).to.equal("21%");
		expect(valueOf(YURT, "aspect-ratio")).to.equal("240 / 170");
		expect(valueOf(YURT, "transform")).to.equal("translateX(-50%)");
	});

	it("puts the smoke at the pipe, on the same place: the yurt's top plus 22/170 of its height", function () {
		expect(valueOf(SMOKE, "left")).to.equal(PLACE);
		expect(valueOf(SMOKE, "bottom")).to.equal("calc(17% + 21% * 148 / 170)");
		expect(valueOf(SMOKE, "opacity")).to.match(/^var\(--ps-smoke-op(, 0)?\)$/);
	});

	it("never transitions its place: the yurt and the smoke transition opacity only", function () {
		for (const sel of [YURT, SMOKE]) {
			const all = rules.filter((r) => r.selectors.some((s) => s.startsWith(sel)));
			const transitions = all.flatMap((r) =>
				r.decls.filter(([p]) => p.startsWith("transition")).map(([p, v]) => `${p}: ${v}`)
			);
			expect(valueOf(sel, "transition"), sel).to.match(/^opacity [\d.]+s/);

			for (const t of transitions) {
				if (t === "transition: none !important") {
					continue; // reduced motion
				}

				expect(t, sel).to.not.match(/\b(left|transform|inset|all|bottom|translate)\b/);
				expect(t, sel).to.match(/^transition: opacity\b/);
			}

			// Nor may an animation carry it.
			expect(valueOf(sel, "animation"), sel).to.equal(undefined);
		}
	});

	it("hides the yurt and its smoke while it moves (ps-yurt-moving)", function () {
		expect(valueOf(`${S}.ps-yurt-moving .ps-yurt`, "opacity")).to.equal("0");
		expect(valueOf(`${S}.ps-yurt-moving .ps-smoke`, "opacity")).to.equal("0");
	});

	it("fills the felt, roof, band, door and the rest from the colours the palette publishes", function () {
		const PAINT: Array<[string, string, string]> = [
			["ps-y-felt-l", "stop-color", "var(--ps-felt-shade)"],
			["ps-y-felt-c", "stop-color", "var(--ps-felt)"],
			["ps-y-roof-t", "stop-color", "var(--ps-roof-top)"],
			["ps-y-roof-b", "stop-color", "var(--ps-roof-bottom)"],
			["ps-y-band", "fill", "var(--ps-band)"],
			["ps-y-roof", "stroke", "var(--ps-roof-stroke)"],
			["ps-y-band-mark", "fill", "var(--ps-band-mark)"],
			["ps-y-rope", "stroke", "var(--ps-rope)"],
			["ps-y-rib", "stroke", "var(--ps-rib)"],
			["ps-y-door", "fill", "var(--ps-door)"],
			["ps-y-door-orn", "stroke", "var(--ps-door-orn)"],
			["ps-y-crown", "fill", "var(--ps-crown)"],
			["ps-y-pipe", "fill", "var(--ps-pipe)"],
			["ps-y-stone", "fill", "var(--ps-stone)"],
			["ps-y-wood", "fill", "var(--ps-wood)"],
		];

		for (const [name, property, value] of PAINT) {
			expect(valueOf(`${S} .${name}`, property), name).to.equal(value);
		}
	});

	it("mixes no colour in CSS: every yurt and smoke colour is published", function () {
		const own = rules.filter((r) =>
			r.selectors.some((sel) =>
				/^#theme-scene(\.ps-yurt-moving)? \.(ps-yurt|ps-y-|ps-smoke)/.test(sel)
			)
		);
		expect(own.length, "the yurt's rules").to.be.at.least(18);

		for (const r of own) {
			for (const [p, v] of r.decls) {
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.include("color-mix");
			}
		}
	});

	it("snows on the roof by --ps-snowcap and glows at night by --ps-night-glow", function () {
		expect(valueOf(`${S} .ps-y-snow`, "opacity")).to.match(/^var\(--ps-snowcap(, 0)?\)$/);
		expect(valueOf(`${S} .ps-y-lit`, "opacity")).to.match(/^var\(--ps-night-glow(, 0)?\)$/);
		expect(valueOf(`${S} .ps-y-spill`, "opacity")).to.equal(undefined);
	});

	it("lights a pool at the door by --ps-night-glow, the only light before the door (the user's pick, 2026-09-25)", function () {
		expect(valueOf(`${S} .ps-y-pool`, "opacity")).to.match(/^var\(--ps-night-glow(, 0)?\)$/);
	});

	it("draws no worn path to the door, by day or night: nothing reads as a beam (the user, 2026-09-25)", function () {
		// "there is still a beam of light visible from the door, even in the day. there
		// shouldnt be a hard beam, I want the soft glow at the door, and not in the day."
		expect(css).to.not.include("ps-y-path");
		expect(css).to.not.include("--ps-path");
	});

	it("keeps the pool dark by day and lit at night", function () {
		const glowAt = (minute: number) => {
			const m = momentFor({
				minute,
				doy: 270,
				dayNumber: 20723,
				epochDays: 20723,
				weather: "clear",
			});
			return Number(sceneVars(m, paletteAt(m))["--ps-night-glow"]);
		};

		const {rise, set} = sunTimes(270);
		// The pool's opacity is the published glow itself.
		expect(glowAt((rise + set) / 2), "noon").to.equal(0);
		expect(glowAt(30), "midnight").to.be.greaterThan(0.9);
	});

	it("raises the smoke in rem from the published smoke colour", function () {
		const puff = declsOf(`${S} .ps-smoke i`);
		expect(puff.length).to.be.greaterThan(0);
		expect(valueOf(`${S} .ps-smoke i`, "background")).to.include("var(--ps-smoke)");
		// Its own name: the chrome's message entrance is already ps-rise.
		expect(valueOf(`${S} .ps-smoke i`, "animation")).to.match(/^ps-smoke-rise /);
		expect(css.match(/@keyframes ps-smoke-rise\b/g), "one ps-smoke-rise").to.have.length(1);

		for (const [p, v] of puff) {
			expect(v, `.ps-smoke i { ${p} }`).to.not.match(/\dpx/);
		}

		const frames = css.match(/@keyframes ps-smoke-rise\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
		expect(frames).to.include("translate(calc(-50% + 2.125rem), -6rem) scale(3.1)");
		expect(frames).to.not.match(/\dpx/);
	});
});

describe("the ps theme's clouds and weather (plan 3 task 4, spec §5.1, §5.5)", function () {
	const S = "#theme-scene";
	/** Every rule of the clouds, the veil and the weather layer, plain or under a root class. */
	const WEATHER_RULE =
		/^#theme-scene(\.ps-(windy|storm|hot))? \.(ps-cloud|ps-overcast|ps-deck|ps-veil|ps-weather|ps-rain|ps-snow|ps-seeds|ps-flash|ps-heatband|ps-heat-haze)\b/;
	const own = rules.filter((r) => r.selectors.some((sel) => WEATHER_RULE.test(sel)));
	const frames = (name: string) =>
		css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";

	it("bends the ground with the heat haze only on a hot day, and leaves the near grass out of it", function () {
		expect(valueOf(`${S}.ps-hot .ps-ground`, "filter")).to.equal('url("#ps-heat")');
		expect(valueOf(`${S} .ps-ground`, "filter")).to.equal(undefined);
		// Nothing else takes the haze, and nothing filters the blades.
		const hazed = rules.filter((r) => r.decls.some(([, v]) => v.includes("#ps-heat")));
		expect(hazed.map((r) => r.selectors)).to.deep.equal([[`${S}.ps-hot .ps-ground`]]);
		const blades = rules.filter((r) => r.selectors.some((sel) => sel.includes(".ps-blades")));
		expect(blades.flatMap((r) => r.decls).filter(([p]) => p === "filter")).to.deep.equal([]);
	});

	it("keeps the haze's svg in the page but out of sight: no size, never display: none", function () {
		const decls = declsOf(`${S} .ps-heat-haze`);
		expect(decls.length).to.be.greaterThan(0);
		expect(valueOf(`${S} .ps-heat-haze`, "width")).to.equal("0");
		expect(valueOf(`${S} .ps-heat-haze`, "height")).to.equal("0");
		expect(decls.filter(([p]) => p === "display")).to.deep.equal([]);
	});

	it("speeds the blades to 2.4 s and the clouds to 0.4 of their time on a windy day", function () {
		expect(valueOf(`${S}.ps-windy .ps-blades .ps-sway`, "animation-duration")).to.equal("2.4s");
		expect(valueOf(`${S}.ps-windy .ps-cloud`, "animation-duration")).to.equal(
			"calc(var(--cd) * 0.4)"
		);
	});

	it("drifts each cloud across the scene at its own height, in cqw", function () {
		expect(valueOf(`${S} .ps-cloud-field`, "inset")).to.equal("0");
		expect(valueOf(`${S} .ps-cloud`, "position")).to.equal("absolute");
		expect(valueOf(`${S} .ps-cloud`, "top")).to.equal("var(--cy)");
		expect(valueOf(`${S} .ps-cloud`, "width")).to.equal("var(--cw)");
		expect(valueOf(`${S} .ps-cloud`, "height")).to.equal("calc(var(--cw) * 0.42)");
		expect(valueOf(`${S} .ps-cloud`, "animation")).to.equal(
			"ps-drift var(--cd) linear var(--cdl) infinite"
		);
		// A cloud stands at left: 0, so it enters and leaves out of sight only
		// if the loop starts a whole cloud (and its blur) past the left edge
		// and ends past the right one: starting at -30% put 70% of it on the
		// screen at once, and every loop popped it in.
		const drift = frames("ps-drift");
		expect(drift).to.include("from { transform: translateX(calc(-100% - 0.25rem)); }");
		expect(drift).to.include("to { transform: translateX(calc(100cqw + 0.25rem)); }");
	});

	it("rests each cloud under reduced motion where its delay puts it in its drift, not piled at the left edge", function () {
		// With `animation: none` a cloud stood at its box's place, left: 0 with
		// no transform, all five at the left edge. Frozen instead on ps-drift's
		// own path at --cp (plains.ts), the fraction of its loop it would be at.
		const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

		/** A sum of lengths ("-100% - 0.25rem") as its coefficient for each unit, all of it read. */
		const linear = (expr: string) => {
			const flat = expr.replace(/\s+/g, "");
			const terms = [...flat.matchAll(/([+-]?)([\d.]+)(cqw|%|rem)/g)];
			expect(terms.map((t) => t[0]).join(""), expr).to.equal(flat);
			const out: Record<string, number> = {};

			for (const [, sign, n, unit] of terms) {
				out[unit] = (out[unit] ?? 0) + (sign === "-" ? -1 : 1) * Number(n);
			}

			return out;
		};

		const minus = (a: Record<string, number>, b: Record<string, number>) => {
			const out: Record<string, number> = {};

			for (const unit of new Set([...Object.keys(a), ...Object.keys(b)])) {
				const v = (a[unit] ?? 0) - (b[unit] ?? 0);

				if (v !== 0) {
					out[unit] = v;
				}
			}

			return out;
		};

		const end = (which: string) =>
			new RegExp(`${which} \\{ transform: translateX\\(calc\\((.+?)\\)\\); \\}`).exec(
				frames("ps-drift")
			)?.[1] ?? "";
		const from = linear(end("from"));
		const to = linear(end("to"));
		const rest = valueOf(`${S} .ps-cloud`, "transform", REDUCED_MOTION) ?? "";
		const frozen = /^translateX\(calc\(\((.+)\) \* var\(--cp\) ([+-] .+)\)\)$/.exec(rest);
		expect(frozen, `the rest place (${rest})`).to.not.equal(null);
		expect(linear(frozen![1]), "the drift's length").to.deep.equal(minus(to, from));
		expect(linear(frozen![2]), "from the drift's start").to.deep.equal(from);

		// Nothing else places a cloud: the drift moves it by its animation
		// alone, and reduced motion's `animation: none !important` on every
		// scene element leaves the transform to this rule.
		const placing = rules.filter(
			(r) =>
				r.selectors.some((s) => /\.ps-cloud$/.test(s)) &&
				r.decls.some(([p]) => p === "transform" || p === "translate" || p === "left")
		);
		expect(placing.map((r) => [r.at, r.selectors, r.decls])).to.deep.equal([
			["", [`${S} .ps-cloud`], declsOf(`${S} .ps-cloud`)],
			[REDUCED_MOTION, [`${S} .ps-cloud`], [["transform", rest]]],
		]);
		expect(valueOf(`${S} .ps-cloud`, "transform"), "moving, no transform of its own").to.equal(
			undefined
		);
		expect(
			rules
				.filter((r) => r.at === REDUCED_MOTION && r.selectors.includes(`${S} *`))
				.flatMap((r) => r.decls.map(([p]) => p))
		).to.deep.equal(["animation", "transition"]);
	});

	it("paints the clouds from the published cloud colours, greyed by the weather in the palette", function () {
		expect(valueOf(`${S} .ps-cloud i`, "background")).to.equal(
			"linear-gradient(180deg, var(--ps-cloud) 40%, var(--ps-cloud-under) 100%)"
		);
	});

	describe("the weather's own clouds (plan 4 task 3: rain and storms are cloudier)", function () {
		/** Every rule of the overcast and its deck. */
		const overcast = rules.filter((r) =>
			r.selectors.some((sel) => /\.ps-(overcast|deck)\b/.test(sel))
		);
		/** The rules of the day's sets, which fade in and out at local midnight (scene.ts). */
		const SET = /\.ps-overcast-set\b/;
		const sets = overcast.filter((r) => r.selectors.some((sel) => SET.test(sel)));
		/** And the rules that draw: the overcast's box, the deck and its billows. */
		const drawn = overcast.filter((r) => !sets.includes(r));

		it("lays the overcast over the cloud field's own box, so its clouds drift on the five's geometry", function () {
			expect(valueOf(`${S} .ps-overcast`, "position")).to.equal("absolute");
			expect(valueOf(`${S} .ps-overcast`, "inset")).to.equal("0");
			// Its clouds are .ps-cloud, drawn, drifted and rested by the five's rules.
			expect(
				overcast.flatMap((r) => r.selectors).filter((s) => s.includes(".ps-cloud"))
			).to.deep.equal([]);
		});

		it("stretches the storm's deck across the top of the sky, about a third of the way down, its band over the top DECK_BAND %", function () {
			expect(valueOf(`${S} .ps-deck`, "position")).to.equal("absolute");
			expect(valueOf(`${S} .ps-deck`, "inset")).to.equal("0 0 auto");
			// DECK_HEIGHT %, the figure plains' test hangs the billows within;
			// rain's lighter deck is RAIN_DECK_HEIGHT %, shallower.
			expect(valueOf(`${S} .ps-deck`, "height")).to.equal(`${DECK_HEIGHT}%`);
			expect(DECK_HEIGHT).to.be.within(30, 36);
			expect(declsOf(`${S} .ps-deck.ps-deck-rain`)).to.deep.equal([
				["height", `${RAIN_DECK_HEIGHT}%`],
			]);
			expect(valueOf(`${S} .ps-deck`, "background")).to.equal(
				`linear-gradient(180deg, var(--ps-cloud-under), var(--ps-cloud)) top / 100% ${DECK_BAND}% no-repeat`
			);
			expect(valueOf(`${S} .ps-deck i`, "position")).to.equal("absolute");
			expect(valueOf(`${S} .ps-deck i`, "border-radius")).to.equal("50%");
			// Its billows are drawn as the clouds' blobs are: light over, the underside below.
			expect(valueOf(`${S} .ps-deck i`, "background")).to.equal(
				valueOf(`${S} .ps-cloud i`, "background")
			);
			expect(valueOf(`${S} .ps-deck`, "filter")).to.equal(
				valueOf(`${S} .ps-cloud`, "filter")
			);
		});

		it("paints only the two cloud colours, opaque: no new ground for the words (spec §11)", function () {
			expect(drawn.length).to.be.at.least(3);

			for (const r of drawn) {
				for (const [p, v] of r.decls) {
					const where = `${r.selectors.join(", ")} { ${p}: ${v} }`;
					expect(p, where).to.not.match(/^(opacity|mask|mix-blend-mode|backdrop-filter)/);
					expect(v, where).to.not.match(
						/transparent|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix/i
					);
					const colours = [...v.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
					expect(
						colours.filter((c) => !/^--ps-cloud(-under)?$/.test(c)),
						where
					).to.deep.equal([]);
				}
			}
		});

		it("holds the deck still: it neither drifts nor animates, so reduced motion has nothing to rest", function () {
			for (const r of drawn) {
				for (const [p] of r.decls) {
					expect(p, r.selectors.join(", ")).to.not.match(
						/^(animation|transition|transform|translate|will-change)/
					);
				}
			}

			expect(overcast.filter((r) => r.at !== "").map((r) => r.selectors)).to.deep.equal([]);
		});

		it("fades a day's set out and the next one in over OVERCAST_FADE_MS, and nothing else in the overcast is ever translucent", function () {
			// Each day's clouds are one set on the overcast's box (scene.ts
			// puts them there); at local midnight in view the outgoing takes
			// .ps-leaving and the incoming comes in with .ps-arriving, both at 0,
			// and the opacity eases between. That fade is the overcast's one
			// translucency: 2 s, at midnight, under the night treatment (spec §11).
			expect(declsOf(`${S} .ps-overcast-set`)).to.deep.equal([
				["position", "absolute"],
				["inset", "0"],
				["transition", `opacity ${OVERCAST_FADE_MS / 1000}s ease`],
			]);
			expect(declsOf(`${S} .ps-overcast-set.ps-arriving`)).to.deep.equal([["opacity", "0"]]);
			expect(declsOf(`${S} .ps-overcast-set.ps-leaving`)).to.deep.equal([["opacity", "0"]]);
			expect(sets.flatMap((r) => r.selectors).sort()).to.deep.equal(
				[
					`${S} .ps-overcast-set`,
					`${S} .ps-overcast-set.ps-arriving`,
					`${S} .ps-overcast-set.ps-leaving`,
				].sort()
			);
		});
	});

	it("veils the scene in the weather's colour and opacity, --ps-veil-c and --ps-veil", function () {
		expect(valueOf(`${S} .ps-veil`, "inset")).to.equal("0");
		expect(valueOf(`${S} .ps-veil`, "background")).to.match(/^var\(--ps-veil-c(, #5a6478)?\)$/);
		expect(valueOf(`${S} .ps-veil`, "opacity")).to.match(/^var\(--ps-veil(, 0)?\)$/);
	});

	it("shows each weather's particles at the weather's own level", function () {
		expect(valueOf(`${S} .ps-rain`, "opacity")).to.match(/^var\(--ps-rain-op(, 0)?\)$/);
		expect(valueOf(`${S} .ps-snow`, "opacity")).to.match(/^var\(--ps-snow-op(, 0)?\)$/);
		expect(valueOf(`${S} .ps-seeds`, "opacity")).to.match(/^var\(--ps-wind-op(, 0)?\)$/);
		expect(valueOf(`${S} .ps-heatband`, "opacity")).to.match(/^var\(--ps-heat-op(, 0)?\)$/);
	});

	it("flashes the lightning only under .ps-storm, the mockup's 9 s", function () {
		expect(valueOf(`${S} .ps-flash`, "animation")).to.equal(undefined);
		expect(valueOf(`${S} .ps-flash`, "opacity")).to.equal("0");
		expect(valueOf(`${S}.ps-storm .ps-flash`, "animation")).to.equal(
			"ps-flash 9s linear infinite"
		);
		const flash = frames("ps-flash");
		expect(flash).to.match(/0%,\s*90%,\s*100%\s*\{\s*opacity:\s*0;/);
		expect(flash).to.match(/91%\s*\{\s*opacity:\s*0\.5;/);
	});

	it("never holds the lightning lit: a stopped scene does not show it", function () {
		expect(valueOf(`${S}.ps-paused .ps-flash`, "visibility")).to.equal("hidden");
	});

	it("moves the rain, the snow and the seeds in cqw/cqh from the mockup's 1180 × 700 window", function () {
		expect(valueOf(`${S} .ps-rain i`, "animation")).to.equal(
			"ps-drop var(--rd) linear var(--rdl) infinite"
		);
		expect(frames("ps-drop")).to.include("translate(-3.9cqw, 118cqh)");
		expect(valueOf(`${S} .ps-snow i`, "animation")).to.equal(
			"ps-flake var(--fd) linear var(--fdl) infinite"
		);
		expect(frames("ps-flake")).to.include("translate(var(--fx), 114.3cqh)");
		expect(valueOf(`${S} .ps-seeds i`, "animation")).to.equal(
			"ps-seed var(--sd) linear var(--sdl) infinite"
		);
		expect(frames("ps-seed")).to.include("translate(111.9cqw, var(--sy))");
	});

	it("puts no px in a translate of these rules or their keyframes: travel in cqw/cqh, marks in rem", function () {
		expect(own.length, "the clouds' and the weather's rules").to.be.at.least(14);

		for (const r of own) {
			for (const [p, v] of r.decls) {
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.match(/\dpx/);
			}
		}

		for (const name of [
			"ps-drift",
			"ps-drop",
			"ps-flake",
			"ps-seed",
			"ps-shimmer",
			"ps-flash",
		]) {
			const body = frames(name);
			expect(body, name).to.not.equal("");
			expect(body, name).to.not.match(/\dpx/);

			for (const t of body.match(/translate[XY]?\([^;]*\)/g) ?? []) {
				expect(t, name).to.match(/cq[wh]|%|\b0\b|var\(/);
			}
		}
	});

	it("mixes no area colour in CSS: the clouds and the veil are published colours", function () {
		expect(own.length, "the clouds' and the weather's rules").to.be.at.least(14);

		for (const r of own) {
			for (const [p, v] of r.decls) {
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.include("color-mix");
			}
		}
	});

	it("keeps its keyframes' names its own, once each", function () {
		for (const name of [
			"ps-drift",
			"ps-drop",
			"ps-flake",
			"ps-seed",
			"ps-shimmer",
			"ps-flash",
		]) {
			expect(css.match(new RegExp(`@keyframes ${name}\\b`, "g")), name).to.have.length(1);
		}
	});
});

describe("the ps theme's birds (plan 3 task 6, spec §5.4: the user's N2, D1 buzzard and D2 larks)", function () {
	const S = "#theme-scene";
	/** Every rule of the birds, plain or under a root class. */
	const BIRD_RULE =
		/^#theme-scene(\.ps-west)? \.(ps-skeins|ps-bird-defs|ps-flock|ps-skein|ps-skein-sway|ps-bird|ps-daybirds|ps-buzzard|ps-lark|ps-lark-track|ps-lark-bird)\b/;
	const own = rules.filter((r) => r.selectors.some((sel) => BIRD_RULE.test(sel)));
	const FRAMES = [
		"ps-skein-fly",
		"ps-skein-west",
		"ps-skein-sway",
		"ps-bird-wander",
		"ps-buzz-drift",
		"ps-lark-fly",
		"ps-lark-fl",
		"ps-lark-ch",
		"ps-lark-cl",
	];
	const frames = (name: string) =>
		css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";

	it("shows the skeins' layer at the published level, on the sky above the land, fading over 1.4 s", function () {
		expect(valueOf(`${S} .ps-skeins`, "inset")).to.equal("0 0 45%");
		expect(valueOf(`${S} .ps-skeins`, "opacity")).to.equal("var(--ps-skeins-op, 0)");
		expect(valueOf(`${S} .ps-skeins`, "transition")).to.equal("opacity 1.4s ease");
	});

	it("keeps the belly gradient's svg in the page but of no size, never display: none", function () {
		expect(valueOf(`${S} .ps-bird-defs`, "width")).to.equal("0");
		expect(valueOf(`${S} .ps-bird-defs`, "height")).to.equal("0");
		expect(declsOf(`${S} .ps-bird-defs`).filter(([p]) => p === "display")).to.deep.equal([]);
	});

	it("flies the first --ps-skein-count flocks, a rem box each, across the scene in cqw", function () {
		expect(valueOf(`${S} .ps-flock`, "top")).to.equal("var(--fy)");
		expect(valueOf(`${S} .ps-flock`, "width")).to.equal("12.5rem");
		expect(valueOf(`${S} .ps-flock`, "height")).to.equal("5.625rem");
		expect(valueOf(`${S} .ps-flock`, "opacity")).to.equal(
			"clamp(0, var(--ps-skein-count, 0) - var(--fi), 1)"
		);
		expect(valueOf(`${S} .ps-flock`, "transition")).to.equal("opacity 1.8s ease");
		expect(valueOf(`${S} .ps-flock`, "animation")).to.equal(
			"ps-skein-fly var(--fd) linear var(--fdl) infinite"
		);
		// The mockup's −240 → 1340 px of its 1180 px window: its 200 px box
		// and 40 px (3.4cqw) more off the left edge, 160 px (13.6cqw) past the right.
		const fly = frames("ps-skein-fly");
		expect(fly).to.match(/from\s*\{\s*transform:\s*translateX\(calc\(-100% - 3\.4cqw\)\);/);
		expect(fly).to.match(/to\s*\{\s*transform:\s*translateX\(113\.6cqw\);/);
	});

	it("mirrors the whole flock to fly west under ps-west, over the same track the other way", function () {
		expect(valueOf(`${S}.ps-west .ps-flock`, "animation-name")).to.equal("ps-skein-west");
		const west = frames("ps-skein-west");
		expect(west).to.match(/from\s*\{\s*transform:\s*translateX\(113\.6cqw\) scaleX\(-1\);/);
		expect(west).to.match(
			/to\s*\{\s*transform:\s*translateX\(calc\(-100% - 3\.4cqw\)\) scaleX\(-1\);/
		);
	});

	it("rests a flock where its flight starts, off the scene's edge, so a stopped flock is never parked on the sky", function () {
		expect(valueOf(`${S} .ps-flock`, "transform")).to.equal("translateX(calc(-100% - 3.4cqw))");
		expect(valueOf(`${S}.ps-west .ps-flock`, "transform")).to.equal(
			"translateX(113.6cqw) scaleX(-1)"
		);
	});

	it("scales and pales each skein from its leader's end, and sways it with keyframes of its own", function () {
		expect(valueOf(`${S} .ps-skein`, "transform")).to.equal("scale(var(--fs, 1))");
		expect(valueOf(`${S} .ps-skein`, "transform-origin")).to.equal("100% 50%");
		expect(valueOf(`${S} .ps-skein`, "opacity")).to.equal("var(--fo, 1)");
		expect(valueOf(`${S} .ps-skein-sway`, "animation")).to.equal(
			"ps-skein-sway var(--sd) ease-in-out var(--sdl) infinite alternate"
		);
		expect(frames("ps-skein-sway")).to.include("translateY(-0.3125rem) rotate(-1.4deg)");
		expect(frames("ps-skein-sway")).to.include("translateY(0.375rem) rotate(1.2deg)");
		// Not the grass's: the approved mockup named these `sway` and the later one won.
		expect(own.flatMap((r) => r.decls).filter(([, v]) => /\bps-sway\b/.test(v))).to.deep.equal(
			[]
		);
	});

	it("paints the skeins in the moonlit colours scene.ts publishes, the alpha on the whole bird", function () {
		expect(valueOf(`${S} .ps-bird svg`, "opacity")).to.equal("var(--ps-bird-alpha, 0.8)");
		expect(valueOf(`${S} .ps-bird svg`, "overflow")).to.equal("visible");
		expect(valueOf(`${S} .ps-bird .ps-b-far`, "fill")).to.equal("var(--ps-bird-wing)");
		expect(valueOf(`${S} .ps-bird .ps-b-far`, "opacity")).to.equal("0.55");
		expect(valueOf(`${S} .ps-bird .ps-b-near`, "fill")).to.equal("var(--ps-bird-wing)");
		expect(valueOf(`${S} .ps-bird .ps-b-body`, "fill")).to.equal('url("#ps-b-belly")');
		expect(valueOf(`${S} .ps-bird`, "animation")).to.equal(
			"ps-bird-wander var(--wd) ease-in-out var(--wdl) infinite alternate"
		);
	});

	it("inks the day birds from --ps-db-ink, each shown by its own published switch", function () {
		expect(valueOf(`${S} .ps-daybirds svg`, "fill")).to.equal("var(--ps-db-ink)");
		expect(valueOf(`${S} .ps-daybirds .ps-b-far`, "opacity")).to.equal("0.55");
		expect(valueOf(`${S} .ps-daybirds > div`, "transition")).to.equal("opacity 1.4s ease");
		expect(valueOf(`${S} .ps-buzzard`, "opacity")).to.equal("var(--ps-buzzard-op, 0)");
		expect(valueOf(`${S} .ps-lark`, "opacity")).to.equal("var(--ps-lark-op, 0)");
	});

	it("circles the buzzard at the mockup's place and size, drifting with the wind in cqw/cqh", function () {
		expect(valueOf(`${S} .ps-buzzard`, "left")).to.equal("29%");
		expect(valueOf(`${S} .ps-buzzard`, "top")).to.equal("17%");
		expect(valueOf(`${S} .ps-buzzard`, "width")).to.equal("8.125rem");
		expect(valueOf(`${S} .ps-buzzard`, "height")).to.equal("4.375rem");
		expect(valueOf(`${S} .ps-buzzard`, "animation")).to.equal(
			"ps-buzz-drift 170s ease-in-out -70s infinite alternate"
		);
		expect(frames("ps-buzz-drift")).to.include("translate(-5.08cqw, 1.14cqh)");
		expect(frames("ps-buzz-drift")).to.include("translate(5.93cqw, -1.43cqh)");
	});

	it("raises the larks up their own track and rests them hidden, so a stopped lark is never left in the grass", function () {
		expect(valueOf(`${S} .ps-lark`, "top")).to.equal("24%");
		expect(valueOf(`${S} .ps-lark`, "height")).to.equal("62%");
		expect(valueOf(`${S} .ps-lark`, "width")).to.equal("0.75rem");
		expect(valueOf(`${S} .ps-lark-track`, "opacity")).to.equal("0");
		expect(valueOf(`${S} .ps-lark-track`, "animation")).to.equal(
			"ps-lark-fly var(--ld) ease-in-out var(--ldl) infinite"
		);
		expect(valueOf(`${S} .ps-lark-bird`, "width")).to.equal("0.8125rem");
		expect(valueOf(`${S} .ps-lark-bird`, "height")).to.equal("0.5688rem");
		const fly = frames("ps-lark-fly");
		expect(fly).to.include("translate(0.375rem, -24%)");
		expect(fly).to.include("translate(-0.6875rem, -94%)");

		for (const set of ["fl", "ch", "cl"]) {
			expect(valueOf(`${S} .ps-lark .ps-lark-${set}`, "animation"), set).to.equal(
				`ps-lark-${set} var(--ld) steps(1, end) var(--ldl) infinite`
			);
		}
	});

	it("puts no px in the birds' rules or their keyframes: travel in cqw/cqh or %, marks in rem", function () {
		expect(own.length, "the birds' rules").to.be.at.least(18);

		for (const r of own) {
			for (const [p, v] of r.decls) {
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.match(/\dpx/);
				expect(v, `${r.selectors.join(", ")} { ${p} }`).to.not.include("color-mix");
			}
		}

		for (const name of FRAMES) {
			const body = frames(name);
			expect(body, name).to.not.equal("");
			expect(body, name).to.not.match(/\dpx/);

			for (const t of body.match(/translate[XY]?\([^;]*\)/g) ?? []) {
				expect(t, name).to.match(/cq[wh]|%|rem|\b0\b|var\(/);
			}
		}
	});

	it("keeps its keyframes' names its own, once each", function () {
		for (const name of FRAMES) {
			expect(css.match(new RegExp(`@keyframes ${name}\\b`, "g")), name).to.have.length(1);
		}
	});
});

describe("the ps theme's animals", function () {
	/** The cast (tools/heart/README.md); the teddy and the dolphin are held. */
	const CAST = ["horse", "deer", "puppy", "bunny", "kitten", "frog", "ladybug", "bird"];

	it("declares the eight animals' files, and every file it names exists", function () {
		for (const animal of CAST) {
			expect(css).to.include(`--ps-${animal}: url("ps/${animal}.svg");`);
			expect(css).to.include(`--ps-${animal}-far: url("ps/${animal}-far.svg");`);
			expect(css, `--ps-${animal}-h`).to.match(new RegExp(`--ps-${animal}-h: \\d*\\.\\d+;`));
		}

		for (const [, file] of css.matchAll(/url\("(ps\/[^"]+\.svg)"\)/g)) {
			expect(
				fs.existsSync(path.resolve(__dirname, "../../client/themes/", file)),
				`${file} exists`
			).to.be.true;
		}

		// The teddy bear and the dolphin were held: their rigs stay, their
		// files are gone (test/tools/heart/files.ts), and the theme must not
		// reach for either. Tokens and urls, not the bare word — the docs may
		// well end up explaining in a comment here why neither is cast.
		for (const held of ["teddy", "dolphin"]) {
			expect(css, `no --ps-${held} token`).to.not.include(`--ps-${held}`);
			expect(css, `no ps/${held} file`).to.not.include(`url("ps/${held}`);
		}
	});
});

describe("the ps theme's animals, switched off in the scene's animal layer", function () {
	it("casts a horse and a bunny near and a deer far off", function () {
		const root = css.match(/:root\s*\{[^}]*--ps-slot-a:[^}]*\}/)?.[0] ?? "";
		expect(root).to.include("--ps-slot-a: var(--ps-horse);");
		expect(root).to.include("--ps-slot-b: var(--ps-bunny);");
		expect(root).to.include("--ps-slot-f: var(--ps-deer-far);");
	});

	it("paints the three slots as the animal layer's background layers", function () {
		const layer = css.match(/#theme-scene \.ps-animals\s*\{[^}]*\}/)?.[0] ?? "";
		expect(layer).to.match(
			/background-image:\s*var\(--ps-slot-b\),\s*var\(--ps-slot-a\),\s*var\(--ps-slot-f\);/
		);
	});

	it("empties every slot with one block after the cast, which nothing after it undoes", function () {
		const off =
			/#theme-scene \.ps-animals\s*\{\s*--ps-slot-a:\s*none;\s*--ps-slot-b:\s*none;\s*--ps-slot-f:\s*none;\s*\}/g;
		const matches = [...css.matchAll(off)];
		expect(matches, "exactly one off block").to.have.length(1);
		const after = css.slice(matches[0].index! + matches[0][0].length);
		expect(after).to.not.match(/--ps-slot-[abf]:\s*var\(/);
	});
});

/**
 * The rig-to-CSS coupling, from the rigs' side.
 *
 * An animal's size and travel on screen are four numbers that have to move
 * together: the rig's `viewBox.h` and `stage.aspect`, the theme's
 * `--ps-<animal>-h`, and the far slot the cast gives it. The generator's
 * audit can see the two in the rig and nothing at all in the stylesheet, and
 * that gap has already cost a round — four boxes grew to stop clipping their
 * animals (`lib/build.mjs` `boxOverflow`) and every one of them needed a
 * hand-made edit here that nothing would have missed if it had been skipped.
 *
 * So each cast rig records what the theme must say (`theme` in
 * `tools/heart/rigs/<animal>.mjs`) and this block derives the expectation
 * from it rather than restating it: grow a box, forget the token, and the
 * failure names the number to write.
 */
describe("the ps theme's animals are the size their rigs say", function () {
	/** The cast, by the name its tokens and files use. */
	const RIGS: Record<string, any> = {horse, deer, puppy, bunny, kitten, frog, ladybug, bird};

	/** A distant visitor is 0.7 of its animal (the animal tokens' comment in ps.css). */
	const FAR_RATIO = 0.7;

	/** The :root block that casts the scene's animal layer. */
	const cast = () => {
		const block = css.match(/:root\s*\{[^}]*--ps-slot-a:[^}]*\}/);
		expect(block, "the cast's :root block").to.not.equal(null);
		return block![0];
	};

	for (const [name, def] of Object.entries(RIGS)) {
		describe(name, function () {
			it("was sized against the box the rig still has", function () {
				expect(def.theme, `${name}'s rig declares no theme block`).to.be.an("object");
				const {height, box} = def.theme;
				const now = def.rig.viewBox.h;
				expect(
					box,
					`${name}'s box is ${now} but --ps-${name}-h (${height}) was picked ` +
						`against ${box}: scale the token by ${now}/${box} to ` +
						`${Number(((height * now) / box).toFixed(4))}, scale stage.aspect by ` +
						`${box}/${now}, and set theme.box to ${now}`
				).to.equal(now);
			});

			it("is the height in ps.css that its rig says it is", function () {
				expect(css, `--ps-${name}-h`).to.include(`--ps-${name}-h: ${def.theme.height};`);
			});

			it("crosses the stage width its rig says it does", function () {
				const width = def.sequence.stage.aspect * def.rig.viewBox.h;
				expect(
					Math.abs(width - def.theme.stageWidth) / def.theme.stageWidth,
					`${name}'s stage is aspect ${def.sequence.stage.aspect} × box ` +
						`${def.rig.viewBox.h} = ${width.toFixed(1)} rig units, not the ` +
						`${def.theme.stageWidth} it was drawn for: scale stage.aspect to ` +
						`${Number((def.theme.stageWidth / def.rig.viewBox.h).toFixed(4))}`
				).to.be.below(0.001);
			});
		});
	}

	it("gives each near slot the height token of the animal in it", function () {
		const body = cast();

		for (const slot of ["a", "b"]) {
			const animal = body.match(new RegExp(`--ps-slot-${slot}: var\\(--ps-([a-z]+)\\);`));
			expect(animal, `slot ${slot} casts an animal`).to.not.equal(null);
			expect(body, `slot ${slot} is a ${animal![1]}`).to.include(
				`--ps-slot-${slot}-h: var(--ps-${animal![1]}-h);`
			);
		}
	});

	it("derives the distant visitor's height from its animal's own token", function () {
		const body = cast();
		const animal = body.match(/--ps-slot-f: var\(--ps-([a-z]+)-far\);/);
		expect(animal, "slot f casts a distant visitor").to.not.equal(null);
		expect(body, `the visitor is a ${animal![1]}`).to.include(
			`--ps-slot-f-h: calc(${FAR_RATIO} * var(--ps-${animal![1]}-h));`
		);
	});
});
