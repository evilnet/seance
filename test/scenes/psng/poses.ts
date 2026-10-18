import {expect} from "chai";
import {dayBirdsMarkup, skeinsMarkup} from "../../../client/js/scenes/ps/birds";
import {ngBirds, poseStack, wingTiming, larkStates} from "../../../client/js/scenes/psng/poses";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";

// The birds' wingbeats as pose stacks (psng/poses.ts), read off classic's own markup (birds.ts).

const birdSvgs = skeinsMarkup().match(/<svg viewBox="0 0 32 20"[\s\S]*?<\/svg>/g) ?? [];
const larkSvgs = dayBirdsMarkup().match(/<svg viewBox="0 0 20 14"[\s\S]*?<\/svg>/g) ?? [];

describe("ps NG birds (psng/poses.ts)", function () {
	it("classic's markup has 38 skein birds and 3 larks", function () {
		expect(birdSvgs).to.have.length(38);
		expect(larkSvgs).to.have.length(3);
	});

	it("wingTiming: a bird's and a lark's dur, begin, one beat and the beat's poses", function () {
		const bird = wingTiming(birdSvgs[0]);
		const dur = Number(/dur="([\d.]+)s"/.exec(birdSvgs[0])![1]);
		const begin = Number(/begin="(-?[\d.]+)s"/.exec(birdSvgs[0])![1]);
		expect(bird?.dur).to.equal(dur);
		expect(bird?.begin).to.equal(begin);
		expect(bird?.begin).to.be.at.most(0);
		// A goose of the first skein beats at 0.46 s × (0.92..1.08).
		expect(bird?.beat).to.be.within(0.46 * 0.92 - 0.01, 0.46 * 1.08 + 0.01);
		expect(bird?.poses).to.have.length(4);

		const lark = wingTiming(larkSvgs[0]);
		expect(lark?.dur).to.be.a("number").greaterThan(0);
		expect(lark?.begin).to.be.a("number").at.most(0);
		// A lark beats at 0.14..0.17 s (lark() `per`).
		expect(lark?.beat).to.be.within(0.139, 0.171);
		expect(lark?.poses).to.have.length(2);
	});

	it("every bird and every lark yields a timing, its beat no longer than its cycle", function () {
		for (const svg of [...birdSvgs, ...larkSvgs]) {
			const t = wingTiming(svg);
			expect(t, svg.slice(0, 60)).to.not.equal(null);
			expect(t!.beat).to.be.greaterThan(0).and.at.most(t!.dur);
		}
	});

	it("a bird with no wing animation has no timing", function () {
		expect(wingTiming('<svg viewBox="0 0 32 20"><path d="M0,0"/></svg>')).to.equal(null);
	});

	it("poseStack: one psng-pose box per pose, each wing drawn at that pose, no SMIL", function () {
		const svg = birdSvgs[0];
		const t = wingTiming(svg)!;
		const stack = poseStack(svg, t.poses);
		const boxes =
			stack.match(/<div class="psng-pose [^"]*"[^>]*>[\s\S]*?<\/svg><\/div>/g) ?? [];
		expect(boxes).to.have.length(4);
		expect(stack).to.not.contain("<animate");

		boxes.forEach((box, i) => {
			expect(box).to.contain(`psng-pose-${i}`);
			expect(box).to.contain(`--pi:${i};`);
			expect(box).to.contain(`--pf:${i / 4};`);
			expect(box).to.contain(`--wdur:${t.beat}s;`);
			expect(box).to.contain(`--wbegin:${t.begin}s`);
			// Both wings, far and near, at this pose; the body as it was.
			const wings = [...box.matchAll(/class="ps-b-(far|near)"[^>]* d="([^"]*)"/g)];
			expect(wings.map((w) => w[2])).to.deep.equal([t.poses[i], t.poses[i]]);
			expect(box).to.contain('class="ps-b-body"');
		});
	});

	it("ngBirds: every bird and lark a stack, the buzzard in boxes, no SMIL left in either layer", function () {
		const out = ngBirds(
			`<div class="ps-skeins">${skeinsMarkup()}</div><div class="ps-daybirds">${dayBirdsMarkup()}</div>`
		);
		expect(out).to.not.match(/<animate|<set/);
		expect(out.match(/class="psng-pose psng-pose-/g)).to.have.length(38 * 4 + 3 * 2);
		expect(out.match(/class="ps-bird"/g)).to.have.length(38);
		expect(out).to.contain('<div class="ps-buzzard"><div class="psng-buzz-plane">');
		expect(out).to.contain('class="psng-buzz-orbit"');
		expect(out).to.contain('class="psng-buzz-flap"');
		// The larks' three wing sets are three state boxes each.
		expect(out.match(/class="psng-lark-ch"/g)).to.have.length(3);
		expect(out.match(/class="ps-lark-track"/g)).to.have.length(3);
	});

	it("larkStates: three HTML state boxes, the flap a pose stack, no animated group left", function () {
		const svgs = dayBirdsMarkup().match(/<svg viewBox="0 0 20 14"[\s\S]*?<\/svg>/g)!;
		expect(svgs).to.have.length(3);
		const body = /<path d="(M3\.4,6\.7[^"]*)"\/>/.exec(svgs[0])![1];

		for (const svg of svgs) {
			const out = larkStates(svg);
			const t = wingTiming(svg)!;
			expect(out).to.not.match(/<animate|<set/);
			expect(out).to.not.match(/ps-lark-(fl|ch|cl)/);
			expect(out).to.not.match(/<g class=/);
			const boxes = [...out.matchAll(/<div class="psng-lark-(fl|ch|cl)">/g)].map((m) => m[1]);
			expect(boxes).to.deep.equal(["fl", "ch", "cl"]);
			// The flap: wingTiming's two poses, each copy holding both wings at its pose and the body.
			const fl = /<div class="psng-lark-fl">([\s\S]*?)<div class="psng-lark-ch">/.exec(
				out
			)![1];
			expect(t.poses).to.have.length(2);
			expect(fl.match(/class="psng-pose psng-pose-/g)).to.have.length(2);
			// One body path per <svg>, in every state.
			const svgsOut = out.match(/<svg[\s\S]*?<\/svg>/g)!;
			expect(svgsOut).to.have.length(4);

			for (const one of svgsOut) {
				expect(one.split(`d="${body}"`).length - 1, one).to.equal(1);
			}
		}
	});

	it("the buzzard: its flap keyframes are classic's values at its keyTimes, its timings carried over", function () {
		const smil = /<animateTransform[^>]*type="scale"[^>]*>/.exec(dayBirdsMarkup())![0];
		const keyTimes = /keyTimes="([^"]*)"/.exec(smil)![1].split(";").map(Number);
		const values = /values="([^"]*)"/
			.exec(smil)![1]
			.split(";")
			.map((v) => Number(v.split(" ")[1]));
		const block = /@keyframes psng-buzz-flap \{([\s\S]*?)\n\}/.exec(NG_STILL_CSS)![1];
		const frames = [
			...block.matchAll(/([\d.]+)%(?:,\s*100%)? \{\s*transform: scaleY\(([\d.]+)\)/g),
		].map((m) => [Number(m[1]) / 100, Number(m[2])]);
		// The last two SMIL keys (1.95 s and 52 s) are one held value: the CSS says "3.75%, 100%".
		expect(frames.map((f) => f[1])).to.deep.equal(values.slice(0, -1));
		frames.forEach(([at], i) => expect(at, `key ${i}`).to.be.closeTo(keyTimes[i], 0.0001));
		const out = ngBirds(dayBirdsMarkup());
		expect(out).to.contain("--psng-od:26s;--psng-ob:-4s");
		expect(out).to.contain("--psng-fd:52s;--psng-fb:-9s");
	});

	it("ngBirds leaves markup without birds as it was", function () {
		const other = '<div class="ps-sun"><svg><animate attributeName="x"/></svg></div>';
		expect(ngBirds(other)).to.equal(other);
	});
});
