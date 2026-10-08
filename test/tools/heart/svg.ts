import {expect} from "chai";
import {
	animalSvg,
	decodePath,
	encodePath,
	fmt,
	mix,
	stillSvg,
} from "../../../tools/heart/lib/svg.mjs";

describe("tools/heart svg", function () {
	it("mixes colours in sRGB", function () {
		expect(mix("#000000", "#ffffff", 0.5)).to.equal("#808080");
		expect(mix("#d97a9c", "#dbeeff", 0.35)).to.equal("#daa3bf");
	});

	it("encodes an outline as integer relative deltas that decode exactly", function () {
		const pts = [0.4, 0.6, 10.2, 0.4, 10.1, 9.9, -0.2, 10.4];
		expect(encodePath(pts)).to.equal("M0,1l10,-1l0,10l-10,0z");
		expect(decodePath(encodePath(pts))).to.deep.equal([
			[0, 1],
			[10, 0],
			[10, 10],
			[0, 10],
		]);
		expect(encodePath(pts, 2, 2)).to.equal("M1,1l19,19z");
	});

	it("formats numbers to four decimals without trailing zeros", function () {
		expect(fmt(0.5)).to.equal("0.5");
		expect(fmt(1 / 3)).to.equal("0.3333");
		expect(fmt(2)).to.equal("2");
	});

	const spec = {
		viewBox: {x: 0, y: 20, w: 100, h: 80},
		k: 2,
		stageW: 800,
		layers: [
			{cls: "far", fill: "#aaa"},
			{cls: "near", fill: "#333"},
		],
		clips: [
			{
				id: "s1",
				begin: "2s;s2.end+40s",
				repeat: 3,
				dur: 0.5,
				keyTimes: [0, 0.5, 1],
				values: [
					["M0,0l1,1z", "M5,5l2,2z"],
					["M0,0l2,1z", "M5,5l3,2z"],
					["M0,0l1,1z", "M5,5l2,2z"],
				],
			},
			{
				id: "s2",
				begin: "s1.end",
				repeat: 1,
				dur: 1,
				keyTimes: [0, 1],
				values: [
					["M0,0l1,1z", "M5,5l2,2z"],
					["M0,0l1,2z", "M5,5l2,3z"],
				],
			},
		],
		travel: {
			period: 45,
			first: 2,
			onStage: 40,
			tExit: 35,
			fade: 1,
			// as fadeTimes({first: 2, onStage: 40, tExit: 35, period: 45}) computes it
			// (build.ts's fadeTimes tests pin the function itself; this mirrors its output)
			fadeKeyTimes: [0, 2 / 45, 3 / 45, 36 / 45, 37 / 45, 1],
			keyTimes: [0, 0.1, 0.5, 1],
			xs: [-200, -200, 900, 900],
		},
		flip: {at: 0.3},
		hearts: null,
	};

	it("writes the stage, the chained clips on every path and the travel", function () {
		const svg = animalSvg(spec);
		expect(svg).to.include('viewBox="0 40 1600 160"');
		expect(svg.match(/<path /g)).to.have.length(2);
		expect(svg.lastIndexOf('fill="#333"')).to.be.greaterThan(svg.lastIndexOf('fill="#aaa"'));
		// ids and the chain live on the near path; the far path syncs to its begins
		expect(svg).to.include('<animate id="s1" attributeName="d"');
		expect(svg).to.include('begin="2s;s2.end+40s"');
		expect(svg).to.include('begin="s1.end"');
		expect(svg.match(/begin="s1\.begin"/g)).to.have.length(1);
		expect(svg.match(/repeatCount="3"/g)).to.have.length(2);
		expect(svg).to.include(
			'values="M0,0l1,1z;M0,0l2,1z;M0,0l1,1z" keyTimes="0;0.5;1" dur="0.5s"'
		);
		expect(svg).to.include(
			'type="translate" calcMode="linear" values="-200 0;-200 0;900 0;900 0" keyTimes="0;0.1;0.5;1" dur="45s"'
		);
		expect(svg).to.include(
			'type="scale" additive="sum" calcMode="discrete" values="1 1;-1 1" keyTimes="0;0.3"'
		);
		expect(svg).to.include('transform="translate(100 0)"');
		expect(svg).to.include('transform="translate(-100 0)"');
	});

	it("renders the opacity animate from travel.fadeKeyTimes, invisible before its first sample", function () {
		const svg = animalSvg(spec);
		expect(svg).to.include('<g opacity="0">');
		// animalSvg only renders spec.travel.fadeKeyTimes (fmt'd) — it does not
		// recompute them from first/tExit/fade itself; build.ts's fadeTimes
		// tests cover that computation, including the short-visit guard
		expect(svg).to.include(
			'<animate attributeName="opacity" calcMode="linear" values="0;0;1;1;0;0" ' +
				'keyTimes="0;0.0444;0.0667;0.8;0.8222;1" dur="45s" repeatCount="indefinite"/>'
		);
		// the fade animate comes before the travel translate on the outer group
		expect(svg.indexOf('attributeName="opacity"')).to.be.lessThan(
			svg.indexOf('attributeName="transform" type="translate" calcMode="linear"')
		);
	});

	it("omits the flip when the sequence never turns and adds hearts when asked", function () {
		expect(animalSvg({...spec, flip: null})).to.not.include('type="scale"');
		const withHearts = animalSvg({
			...spec,
			hearts: {
				d: "M0,0l1,1z",
				fill: "#e07",
				x: 160,
				y: 40,
				rise: 50,
				begin: "s2.begin+0.4s;s2.begin+2s",
			},
		});
		expect(withHearts).to.include('fill="#e07" opacity="0" transform="translate(160 40)"');
		expect(withHearts).to.include(
			'values="0 0;0 -50" dur="1.4s" begin="s2.begin+0.4s;s2.begin+2s"'
		);
	});

	/**
	 * The outer `<g opacity="0">` — the one carrying the travel and the fade —
	 * split from what follows it, by counting `<g`/`</g>` depth to its own
	 * close rather than by string index, so the nesting is asserted as
	 * structure.
	 */
	function outerGroup(svg: string) {
		const open = svg.indexOf('<g opacity="0">');
		expect(open, "the outer group").to.be.greaterThan(-1);
		let depth = 0;
		let i = open;

		while (i < svg.length) {
			if (svg.startsWith("<g", i)) {
				depth++;
				i = svg.indexOf(">", i) + 1;
			} else if (svg.startsWith("</g>", i)) {
				depth--;
				i += 4;

				if (depth === 0) {
					return {inside: svg.slice(open, i), after: svg.slice(i)};
				}
			} else {
				i++;
			}
		}

		throw new Error("the outer group never closes");
	}

	it("paints decor after the animal, outside the group that travels and fades", function () {
		const decor = [
			{d: "M0,60h100v20h-100z", fill: "#8ec"},
			{d: "M0,64q50,10 100,0z", fill: "#cef"},
		];
		const svg = animalSvg({...spec, decor});
		// rig coordinates, so the same k the outline paths are encoded with
		expect(svg).to.include('<path fill="#8ec" transform="scale(2)" d="M0,60h100v20h-100z"/>');
		expect(svg).to.include('<path fill="#cef" transform="scale(2)" d="M0,64q50,10 100,0z"/>');
		expect(svg.match(/<path /g)).to.have.length(4);

		const {inside, after} = outerGroup(svg);
		// that group is the one that moves and fades, and holds the animal
		expect(inside).to.include('attributeName="transform" type="translate"');
		expect(inside).to.include('attributeName="opacity"');
		expect(inside).to.include('fill="#aaa"');
		expect(inside).to.include('fill="#333"');
		// neither decor path is inside it: decor neither travels nor fades
		expect(inside).to.not.include('fill="#8ec"');
		expect(inside).to.not.include('fill="#cef"');
		// both follow every animal path, in the order the spec gave them
		expect(after).to.include('fill="#8ec"');
		expect(after).to.include('fill="#cef"');
		expect(after.indexOf('fill="#8ec"')).to.be.lessThan(after.indexOf('fill="#cef"'));
	});

	it("writes nothing at all for a spec with no decor", function () {
		expect(animalSvg({...spec, decor: undefined})).to.equal(animalSvg(spec));
		expect(animalSvg({...spec, decor: []})).to.equal(animalSvg(spec));
	});

	it("writes a still as plain paths in the rig's own box", function () {
		const still = stillSvg({
			viewBox: spec.viewBox,
			k: 2,
			layers: spec.layers,
			frame: ["M0,0l1,1z", "M5,5l2,2z"],
		});
		expect(still).to.equal(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 40 200 160"><path fill="#aaa" d="M0,0l1,1z"/><path fill="#333" d="M5,5l2,2z"/></svg>\n'
		);
	});
});
