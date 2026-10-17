import {expect} from "chai";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";

// NG's stylesheet (psng/styles.ts) on its text: each lifted group still while its class is absent, in phase while present.

/** The sheet's rules as [selector, body], comments out (the sheet has no nested at-rules). */
const rules = [
	...NG_STILL_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => [m[1].trim(), m[2]] as const);

describe("ps NG stylesheet (psng/styles.ts)", function () {
	for (const group of ["clouds", "stars", "fireflies", "smoke", "grass"]) {
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

	it("the weather, the birds and the sun get no lift yet", function () {
		for (const group of ["weather", "skeins", "daybirds", "sun"]) {
			expect(NG_STILL_CSS).to.not.contain(`psng-m-${group}`);
		}
	});

	it("never the glass, never a media query", function () {
		expect(NG_STILL_CSS).to.not.match(
			/backdrop-filter|#sidebar|#form|\.header|\.userlist|@media/
		);
	});
});
