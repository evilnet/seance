import {expect} from "chai";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";

// NG's stylesheet (psng/styles.ts) on its text: each lifted group still while its class is absent, in phase while present.

/** The sheet's rules as [selector, body], comments and @keyframes blocks out (no other nested at-rules). */
const rules = [
	...NG_STILL_CSS.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
		.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => [m[1].trim(), m[2]] as const);

describe("ps NG stylesheet (psng/styles.ts)", function () {
	for (const group of [
		"clouds",
		"stars",
		"fireflies",
		"smoke",
		"grass",
		"weather",
		"skeins",
		"daybirds",
	]) {
		it(`${group}: still without psng-m-${group}, in phase with it`, function () {
			const still = rules.filter(
				([sel, body]) =>
					sel.includes(`:not(.psng-m-${group})`) &&
					/animation: none !important/.test(body)
			);
			const lifted = rules.filter(
				([sel, body]) =>
					sel.includes(`.psng-m-${group} `) &&
					/animation-delay:[^;]*var\(--psng-t\)/.test(body)
			);
			expect(still, "a still rule").to.have.length.greaterThan(0);
			expect(lifted, "a lifted rule").to.have.length.greaterThan(0);
		});
	}

	it("every transition off; everything else still; the rest at its place", function () {
		expect(rules).to.deep.include([
			"#theme-scene.psng *",
			"\n\ttransition: none !important;\n",
		]);
		const catchAll = rules.find(([sel]) => sel.startsWith("#theme-scene.psng *:not("));
		expect(catchAll?.[1]).to.contain("animation: none !important");
		expect(NG_STILL_CSS).to.contain("var(--cp)");
	});

	it("the weather: every kind in flight lifted, out of the page without its class, the seeds out in calm", function () {
		const lifted = (what: string) =>
			rules.some(
				([sel, body]) =>
					sel.startsWith("#theme-scene.psng.psng-m-weather ") &&
					sel.includes(what) &&
					/animation-delay:[^;]*var\(--psng-t\)/.test(body)
			);

		for (const what of [
			".psng-rain-tile",
			".ps-snow i",
			".ps-seeds i",
			".ps-flash",
			".ps-heatband",
		]) {
			expect(lifted(what), what).to.equal(true);
		}

		const catchAll = rules.find(([sel]) => sel.startsWith("#theme-scene.psng *:not("));
		expect(catchAll?.[0]).to.contain(
			".psng-rain-tile, .ps-snow i, .ps-seeds i, .ps-flash, .ps-heatband"
		);
		const hidden = (sel: string) =>
			rules.some(
				([s, body]) =>
					s
						.split(",")
						.map((x) => x.trim())
						.includes(sel) && /display: none/.test(body)
			);

		for (const layer of [".ps-rain", ".ps-snow", ".ps-seeds", ".ps-flash"]) {
			expect(hidden(`#theme-scene.psng:not(.psng-m-weather) ${layer}`), layer).to.equal(true);
			expect(hidden(`#theme-scene.psng ${layer}`), `${layer} not hidden for good`).to.equal(
				false
			);
		}

		expect(hidden("#theme-scene.psng.psng-calm .ps-seeds"), "calm: seeds out").to.equal(true);
		expect(rules).to.deep.include([
			"#theme-scene.psng.psng-calm .ps-seeds i",
			"\n\tanimation: none !important;\n",
		]);
		expect(NG_STILL_CSS, "the tiles fall one tile height").to.match(
			/@keyframes psng-rain-fall \{[\s\S]*?to \{\s*transform: translateY\(100%\);/
		);
	});

	it("the birds: every moving part lifted in phase, out of the page without its group", function () {
		const lifted = (group: string, what: string) =>
			rules.some(
				([sel, body]) =>
					sel.startsWith(`#theme-scene.psng.psng-m-${group} `) &&
					sel.includes(what) &&
					/animation-delay:[^;]*var\(--psng-t\)/.test(body)
			);
		const parts: Array<[string, string]> = [
			["skeins", ".ps-flock"],
			["skeins", ".ps-skein-sway"],
			["skeins", ".ps-bird"],
			["skeins", ".psng-pose"],
			["daybirds", ".ps-buzzard"],
			["daybirds", ".psng-buzz-orbit"],
			["daybirds", ".psng-buzz-flap"],
			["daybirds", ".ps-lark-track"],
			["daybirds", ".ps-lark-fl"],
			["daybirds", ".psng-pose"],
		];
		const catchAll = rules.find(([sel]) => sel.startsWith("#theme-scene.psng *:not("))![0];

		for (const [group, what] of parts) {
			expect(lifted(group, what), `${group} ${what}`).to.equal(true);
			expect(catchAll, `${what} exempt`).to.contain(what);
		}

		// The skein sway reads its own --sdl, never the smoke's or the seeds'.
		expect(rules).to.deep.include([
			"#theme-scene.psng.psng-m-skeins .ps-skein-sway",
			"\n\tanimation-delay: calc(var(--sdl) - var(--psng-t));\n",
		]);

		for (const group of ["skeins", "daybirds"]) {
			const hidden = rules.some(
				([s, body]) =>
					s
						.split(",")
						.map((x) => x.trim())
						.includes(`#theme-scene.psng:not(.psng-m-${group}) .ps-${group}`) &&
					/display: none/.test(body)
			);
			expect(hidden, group).to.equal(true);
		}

		// One pose at a time: a hard swap at a quarter (full) or a half (calm, larks), never steps().
		expect(NG_STILL_CSS).to.match(
			/@keyframes psng-pose4 \{\s*0%,\s*24\.99% \{\s*opacity: 1;\s*\}\s*25%,\s*100% \{\s*opacity: 0;/
		);
		expect(NG_STILL_CSS).to.match(
			/@keyframes psng-pose2 \{\s*0%,\s*49\.99% \{\s*opacity: 1;\s*\}\s*50%,\s*100% \{\s*opacity: 0;/
		);
		expect(NG_STILL_CSS).to.not.match(/psng-pose[^}]*steps\(/);
	});

	it("the sun gets no lift yet", function () {
		expect(NG_STILL_CSS).to.not.contain("psng-m-sun");
	});

	it("never the glass, never a media query", function () {
		expect(NG_STILL_CSS).to.not.match(
			/backdrop-filter|#sidebar|#form|\.header|\.userlist|@media/
		);
	});
});
