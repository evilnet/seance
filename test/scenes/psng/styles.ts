import {expect} from "chai";
import {NG_STILL_CSS, POSE_BEATS} from "../../../client/js/scenes/psng/styles";

// NG's stylesheet (psng/styles.ts) on its text: each lifted group still while its class is absent, in phase while present.

/** The sheet's rules as [selector, body], comments and @keyframes blocks out (no other nested at-rules). */
const rules = [
	...NG_STILL_CSS.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
		.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => [m[1].trim(), m[2]] as const);

describe("ps NG stylesheet (psng/styles.ts)", function () {
	it("no bird wanders: NG has no animation rule of its own on .ps-bird", function () {
		expect(NG_STILL_CSS).not.to.contain("ps-bird-wander");
		expect(NG_STILL_CSS).not.to.match(/\.ps-bird \{[^}]*animation/);
		expect(NG_STILL_CSS).not.to.match(/\.ps-bird[,)]/);
	});

	it("calm keeps no rules of its own for the seeds or the birds (calm is the clouds alone)", function () {
		expect(NG_STILL_CSS).not.to.contain("psng-calm .ps-seeds");
		expect(NG_STILL_CSS).not.to.contain("psng-calm .ps-bird");
	});

	for (const group of [
		"clouds",
		"stars",
		"fireflies",
		"smoke",
		"grass",
		"weather",
		"skeins",
		"daybirds",
		"sun",
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

	it("nothing transitions: the one transition rule is the catch-all none (the yurt's move is a cut)", function () {
		expect(rules.filter(([, body]) => body.includes("transition"))).to.deep.equal([
			["#theme-scene.psng *", "\n\ttransition: none !important;\n"],
		]);
	});

	it("the weather: every kind in flight lifted, out of the page without its class", function () {
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
			["skeins", ".psng-pose"],
			["daybirds", ".ps-buzzard"],
			["daybirds", ".psng-buzz-orbit"],
			["daybirds", ".psng-buzz-flap"],
			["daybirds", ".ps-lark-track"],
			["daybirds", ".psng-lark-fl"],
			["daybirds", ".psng-lark-ch"],
			["daybirds", ".psng-lark-cl"],
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

		// One pose at a time: a hard swap at a quarter (full) or a half (calm, larks), never steps(),
		// 80 beats to one iteration (plan 4 §10.5: WebKit works on the main thread at every iteration of
		// every animation), shown at 0.999 and hidden at 0.001 (an opacity of exactly 1 or 0 at a swap
		// repaints the bird).
		for (const [name, poses] of [
			["psng-pose4", 4],
			["psng-pose2", 2],
		] as const) {
			const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
				NG_STILL_CSS
			)?.[1];
			expect(block, name).to.be.a("string");
			const frames = [...block!.matchAll(/([\d.%,\s]+)\{\s*opacity: ([\d.]+);\s*\}/g)].map(
				(m) => ({
					at: m[1].split(",").map((x) => Number.parseFloat(x)),
					opacity: Number(m[2]),
				})
			);
			expect(frames, name).to.have.length(2 * POSE_BEATS);
			const beat = 100 / POSE_BEATS;

			for (let k = 0; k < POSE_BEATS; k++) {
				const on = frames[2 * k];
				const off = frames[2 * k + 1];
				const edge = k * beat + beat / poses;
				expect(on.opacity, `${name} beat ${k} shown`).to.equal(0.999);
				expect(off.opacity, `${name} beat ${k} hidden`).to.equal(0.001);
				expect(on.at[0], `${name} beat ${k} start`).to.be.closeTo(k * beat, 1e-4);
				expect(on.at[1], `${name} beat ${k} edge`)
					.to.be.closeTo(edge, 2e-4)
					.and.below(edge);
				expect(off.at[0], `${name} beat ${k} edge`).to.be.closeTo(edge, 1e-4);
				expect(off.at.at(-1), `${name} beat ${k} end`).to.be.closeTo((k + 1) * beat, 2e-4);
			}
		}

		for (const sel of [
			"#theme-scene.psng.psng-m-skeins .ps-bird .psng-pose",
			"#theme-scene.psng.psng-m-daybirds .ps-lark .psng-pose",
		]) {
			const rule = rules.find(([s]) => s === sel);
			expect(rule, sel).to.not.equal(undefined);
			expect(rule![1], sel).to.match(
				new RegExp(
					`animation: psng-pose[24] calc\\(var\\(--wdur\\) \\* ${POSE_BEATS}\\) linear infinite`
				)
			);
		}

		expect(NG_STILL_CSS).to.not.match(/psng-pose[^}]*steps\(/);
	});

	it("the larks' state boxes hold each state from its own stop to the next, on linear keyframes", function () {
		// Classic's ps-lark-fl/-ch/-cl (ps.css, steps(1, end)): the value from each stop until the next.
		const stops = [0, 63, 69, 73, 80, 82.5];
		const classic: Record<string, number[]> = {
			fl: [1, 0, 1, 0, 1, 0],
			ch: [0, 1, 0, 1, 0, 0],
			cl: [0, 0, 0, 0, 0, 1],
		};

		for (const [state, values] of Object.entries(classic)) {
			const block = new RegExp(`@keyframes psng-lark-${state}-h \\{([\\s\\S]*?)\\n\\}`).exec(
				NG_STILL_CSS
			)?.[1];
			expect(block, `psng-lark-${state}-h`).to.be.a("string");
			// Each frame: its percentages and its opacity.
			const frames = [...block!.matchAll(/([\d.%,\s]+)\{\s*opacity: ([\d.]+);\s*\}/g)].map(
				(m) => [m[1].split(",").map((p) => Number.parseFloat(p)), Number(m[2])] as const
			);
			expect(frames, state).to.have.length(stops.length);
			stops.forEach((stop, i) => {
				const until = i + 1 < stops.length ? Number((stops[i + 1] - 0.01).toFixed(2)) : 100;
				expect(frames[i][0], `${state} from ${stop}`).to.deep.equal([stop, until]);
				expect(frames[i][1], `${state} at ${stop}`).to.equal(values[i]);
			});

			const rule = rules.find(([sel]) =>
				sel
					.split(",")
					.some(
						(x) =>
							x.trim() ===
							`#theme-scene.psng.psng-m-daybirds .ps-lark .psng-lark-${state}`
					)
			);
			expect(rule, `the ${state} box's rule`).to.not.equal(undefined);
			expect(rule![1]).to.match(
				new RegExp(`animation: psng-lark-${state}-h var\\(--ld\\) linear infinite`)
			);
			expect(rule![1]).to.match(/animation-delay: calc\(var\(--ldl\) - var\(--psng-t\)\)/);
		}

		// Placed like a pose (position: absolute; inset: 0), so the chute and closed states draw where classic's do.
		const boxes = rules.find(
			([sel, body]) =>
				["fl", "ch", "cl"].every((k) => sel.includes(`.psng-lark-${k}`)) &&
				/position: absolute/.test(body)
		);
		expect(boxes, "the state boxes placed like a pose").to.not.equal(undefined);
		expect(boxes![1]).to.match(/inset: 0/);
		expect(NG_STILL_CSS).to.not.match(/steps\(/);
	});

	it("calm shows two of the sky's clouds and none of the wet weather's", function () {
		expect(NG_STILL_CSS).to.contain(".psng-calm .ps-cloud-field > .ps-cloud:nth-child(n + 4)");
		expect(NG_STILL_CSS).to.contain(".psng-calm .ps-cloud:not(.ps-cloud-field > .ps-cloud)");
	});

	it("never the glass, never a media query", function () {
		expect(NG_STILL_CSS).to.not.match(
			/backdrop-filter|#sidebar|#form|\.header|\.userlist|@media/
		);
	});
});
