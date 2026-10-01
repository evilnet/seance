import {expect} from "chai";
import {
	FADE_MS,
	FOLLOW_REM,
	SETTLE_MS,
	YURT_AT,
	YURT_DEFAULT,
	yurtFollower,
	yurtMove,
	yurtPlace,
	type YurtEffects,
} from "../../../client/js/scenes/ps/yurt";

describe("ps yurt: where it stands (yurt.ts)", function () {
	it("keeps the brief's numbers", function () {
		expect(YURT_AT).to.equal(0.72);
		expect(YURT_DEFAULT).to.equal(0.7);
		expect(FADE_MS).to.equal(400);
		expect(FOLLOW_REM).to.equal(1.5);
		expect(SETTLE_MS).to.equal(1000);
	});

	describe("yurtPlace", function () {
		it("stands at 72 % of the message column, from the column's left", function () {
			expect(yurtPlace({left: 300, width: 800}, null, 1200, 267)).to.equal(876);
			expect(
				yurtPlace({left: 300, width: 800}, 500, 1200, 267),
				"a column wins over the last place"
			).to.equal(876);
		});

		it("keeps its last place with no column on screen", function () {
			expect(yurtPlace(null, 500, 1200, 267)).to.equal(500);
		});

		it("stands at 70 % of the scene before any column was measured", function () {
			expect(yurtPlace(null, null, 1200, 267)).to.equal(840);
		});

		it("keeps the whole yurt inside the scene", function () {
			// A phone: a 390-wide scene, a 250-wide yurt, a column that would put it at 406.
			const column = {left: 0, width: 406 / YURT_AT};
			expect(yurtPlace(column, null, 390, 250)).to.equal(265);
			expect(yurtPlace({left: -200, width: 100}, null, 390, 250), "the left edge").to.equal(
				125
			);
			expect(yurtPlace(null, 380, 390, 250), "a last place").to.equal(265);
			expect(yurtPlace(null, null, 390, 250), "the default: 273 → 265").to.equal(265);
			expect(yurtPlace(null, null, 1200, 267), "room to spare: untouched").to.equal(840);
		});

		it("stands in the middle when the yurt is wider than the scene", function () {
			expect(yurtPlace({left: 0, width: 300}, null, 200, 250)).to.equal(100);
		});
	});

	describe("yurtMove", function () {
		it("follows a change under 1.5 rem at once", function () {
			expect(yurtMove(500, 510, 20, false)).to.equal("follow");
			expect(yurtMove(510, 500, 20, false)).to.equal("follow");
			expect(yurtMove(500, 529.9, 20, false)).to.equal("follow");
		});

		it("fades for a change of 1.5 rem or more", function () {
			expect(yurtMove(500, 540, 20, false)).to.equal("fade");
			expect(yurtMove(540, 500, 20, false)).to.equal("fade");
			expect(yurtMove(500, 530, 20, false), "exactly 1.5 rem").to.equal("fade");
		});

		it("measures the threshold in the page's rem", function () {
			expect(yurtMove(500, 540, 32, false)).to.equal("follow");
			expect(yurtMove(500, 520, 12, false)).to.equal("fade");
		});

		it("retargets any change while a fade is running: no second fade", function () {
			expect(yurtMove(500, 510, 20, true)).to.equal("retarget");
			expect(yurtMove(500, 900, 20, true)).to.equal("retarget");
			expect(yurtMove(500, 500, 20, true)).to.equal("retarget");
		});
	});
});

/**
 * A scripted clock for the follower: timers by virtual milliseconds, frames
 * one batch at a time, and a log of every effect in order.
 */
function harness() {
	let now = 0;
	const timers: Array<{at: number; fn: () => void; live: boolean}> = [];
	let frames: Array<{fn: () => void; live: boolean}> = [];
	const log: string[] = [];

	const fx: YurtEffects = {
		place: (px) => log.push(`place ${px}`),
		hide: (on) => log.push(on ? "hide" : "show"),
		now: () => now,
		after(ms, fn) {
			const t = {at: now + ms, fn, live: true};
			timers.push(t);

			return () => {
				t.live = false;
			};
		},
		nextFrame(fn) {
			const f = {fn, live: true};
			frames.push(f);

			return () => {
				f.live = false;
			};
		},
	};

	return {
		fx,
		log,
		/** Move the clock on by `ms`, firing each timer that falls due. */
		advance(ms: number) {
			now += ms;

			for (const t of timers) {
				if (t.live && t.at <= now) {
					t.live = false;
					t.fn();
				}
			}
		},
		/** Run the frame callbacks queued so far. */
		frame() {
			const due = frames;
			frames = [];

			for (const f of due) {
				if (f.live) {
					f.fn();
				}
			}
		},
		pending: () => timers.filter((t) => t.live).length + frames.filter((f) => f.live).length,
	};
}

describe("ps yurt: following the column (yurtFollower)", function () {
	/** A desktop window: 1280 wide, 20 px rem, a 267 px yurt. */
	const S = {width: 1280, rem: 20, yurtWidth: 267};
	/** The column beside a sidebar of 250 px, the user list open (850 wide) or closed (1030). */
	const OPEN = {left: 250, width: 850};
	const CLOSED = {left: 250, width: 1030};
	const AT_OPEN = yurtPlace(OPEN, null, S.width, S.yurtWidth); // 862
	const AT_CLOSED = yurtPlace(CLOSED, null, S.width, S.yurtWidth); // 991.6

	/** A follower seen long ago, with nothing measured yet (the page opened on Settings). */
	function settled() {
		const h = harness();
		const f = yurtFollower(h.fx);
		f.seen();
		h.advance(SETTLE_MS * 5);
		return {h, f};
	}

	/** A follower already standing where the open list puts it, its load window long gone. */
	function standing() {
		const {h, f} = settled();
		f.measure(OPEN, S);
		h.advance(FADE_MS);
		h.frame();
		h.log.length = 0;
		expect(f.place).to.equal(AT_OPEN);
		expect(f.fading).to.equal(false);
		return {h, f};
	}

	it("leaves ps.css's 70 % standing until a column is measured", function () {
		const h = harness();
		const f = yurtFollower(h.fx);
		f.seen();
		f.measure(null, S);
		f.measure({left: 250, width: 0}, S); // a column not laid out is no column
		expect(h.log).to.deep.equal([]);
		expect(f.place).to.equal(null);
	});

	describe("the load: the first measured place, within 1 s of first being seen", function () {
		it("is taken at once, with no fade (an ordinary load onto a channel)", function () {
			const h = harness();
			const f = yurtFollower(h.fx);
			f.seen();
			h.advance(300);
			f.measure(OPEN, S); // 862 is 34 px from 896: past the threshold, still no fade
			expect(h.log).to.deep.equal([`place ${AT_OPEN}`]);
			expect(f.fading).to.equal(false);
			expect(h.pending()).to.equal(0);
		});

		it("is taken at once up to 1 s after, and faded to after that", function () {
			const at = (ms: number) => {
				const h = harness();
				const f = yurtFollower(h.fx);
				f.seen();
				h.advance(ms);
				f.measure(OPEN, S);
				return h.log;
			};

			expect(at(SETTLE_MS)).to.deep.equal([`place ${AT_OPEN}`]);
			expect(at(SETTLE_MS + 1)).to.deep.equal(["hide"]);
		});

		it("is taken at once before the scene has been seen at all (mounted into a hidden page)", function () {
			const h = harness();
			const f = yurtFollower(h.fx);
			h.advance(60000);
			f.measure(OPEN, S);
			expect(h.log).to.deep.equal([`place ${AT_OPEN}`]);
		});

		it("counts from the first time it is seen only: a later return to the page opens no window", function () {
			const {h, f} = settled();
			f.seen(); // hidden and shown again
			f.measure(OPEN, S);
			expect(h.log).to.deep.equal(["hide"]);
		});

		it("covers the first place only: a large change inside the window still fades", function () {
			const h = harness();
			const f = yurtFollower(h.fx);
			f.seen();
			f.measure(OPEN, S);
			h.advance(200);
			f.measure(CLOSED, S);
			expect(h.log).to.deep.equal([`place ${AT_OPEN}`, "hide"]);
		});
	});

	describe("a scene not laid out yet (display: none until ps.css applies)", function () {
		/** #theme-scene before ps.css shows it: no box, and so no yurt box either. */
		const HIDDEN = {width: 0, rem: 20, yurtWidth: 0};

		it("places nothing against a scene of no width, and leaves the load's window unspent", function () {
			const h = harness();
			const f = yurtFollower(h.fx);
			f.seen();
			f.measure(OPEN, HIDDEN); // the column's first observation, the scene not shown yet
			expect(h.log).to.deep.equal([]);
			expect(f.place).to.equal(null);
			expect(f.fading).to.equal(false);
			expect(h.pending()).to.equal(0);
			h.advance(300);
			f.measure(OPEN, S); // ps.css applied: the scene's own observation
			expect(h.log, "the first place, taken at once").to.deep.equal([`place ${AT_OPEN}`]);
			expect(f.fading).to.equal(false);
		});

		it("ignores a scene of no width at any time: the place kept, no fade started", function () {
			const {h, f} = standing();
			f.measure(CLOSED, HIDDEN);
			f.measure(null, HIDDEN);
			expect(h.log).to.deep.equal([]);
			expect(f.place).to.equal(AT_OPEN);
			expect(f.fading).to.equal(false);
		});
	});

	describe("no column and a narrower scene (a window narrowed on Settings)", function () {
		// The yurt is 267 px wide, so its centre stays 133.5 px inside the far edge.

		it("follows the clamp at once when it moves the yurt under 1.5 rem", function () {
			const {h, f} = standing(); // at 862
			f.measure(null, {...S, width: 990}); // 990 − 133.5 = 856.5: 5.5 px
			expect(h.log).to.deep.equal(["place 856.5"]);
			expect(f.place).to.equal(856.5);
		});

		it("fades to the clamped place when the clamp moves it further", function () {
			const {h, f} = standing();
			f.measure(null, {...S, width: 800}); // 666.5: 195.5 px
			expect(h.log).to.deep.equal(["hide"]);
			h.advance(FADE_MS);
			h.frame();
			expect(h.log).to.deep.equal(["hide", "place 666.5", "show"]);
			expect(f.place).to.equal(666.5);
		});

		it("clamps a running fade's landing instead", function () {
			const {h, f} = standing();
			f.measure(CLOSED, S); // fading to 991.6
			f.measure(null, {...S, width: 1100}); // the column goes and the scene narrows: 966.5
			h.advance(FADE_MS);
			h.frame();
			expect(h.log).to.deep.equal(["hide", "place 966.5", "show"]);
		});

		it("keeps its place when the scene grows", function () {
			const {h, f} = standing();
			f.measure(null, {...S, width: 1600});
			expect(h.log).to.deep.equal([]);
			expect(f.place).to.equal(AT_OPEN);
		});

		it("leaves ps.css's 70 % to clamp itself while nothing is placed", function () {
			const {h, f} = settled();
			f.measure(null, {...S, width: 400});
			expect(h.log).to.deep.equal([]);
			expect(f.place).to.equal(null);
		});
	});

	it("follows at once when the first column, after the load, puts it within 1.5 rem of 70 %", function () {
		const {h, f} = settled();
		const near = {left: 0, width: (S.width * YURT_DEFAULT + 10) / YURT_AT};
		f.measure(near, S);
		expect(h.log).to.deep.equal([`place ${yurtPlace(near, null, S.width, S.yurtWidth)}`]);
		expect(f.fading).to.equal(false);
	});

	it("fades from 70 % to the first column's far third when the page opened on Settings (review focus 4)", function () {
		const {h, f} = settled();
		f.measure(null, S); // Settings: no column
		f.measure(OPEN, S); // a channel opens: 862 is 34 px from 896
		expect(h.log).to.deep.equal(["hide"]);
		h.advance(FADE_MS - 1);
		expect(h.log, "unmoved while it fades out").to.deep.equal(["hide"]);
		h.advance(1);
		expect(h.log).to.deep.equal(["hide", `place ${AT_OPEN}`]);
		h.frame();
		expect(h.log, "shown on the frame after the jump").to.deep.equal([
			"hide",
			`place ${AT_OPEN}`,
			"show",
		]);
		expect(f.fading).to.equal(false);
		expect(h.pending()).to.equal(0);
	});

	it("measures the move from the clamped default on a narrow scene", function () {
		// A phone: 70 % of 390 is 273, clamped to 265 for a 250 px yurt; a column
		// putting it at 281 is 16 px away (under 1.5 rem), then clamped to 265 too.
		const h = harness();
		const f = yurtFollower(h.fx);
		f.seen();
		h.advance(SETTLE_MS * 5);
		f.measure({left: 0, width: 390}, {width: 390, rem: 20, yurtWidth: 250});
		expect(h.log).to.deep.equal(["place 265"]);
	});

	it("follows a small change at once, with no fade", function () {
		const {h, f} = standing();
		f.measure({left: 250, width: 870}, S);
		expect(h.log).to.deep.equal([`place ${250 + 0.72 * 870}`]);
	});

	it("fades out, jumps unseen and fades in for a large change", function () {
		const {h, f} = standing();
		f.measure(CLOSED, S);
		expect(h.log).to.deep.equal(["hide"]);
		expect(f.fading).to.equal(true);
		h.advance(FADE_MS);
		h.frame();
		expect(h.log).to.deep.equal(["hide", `place ${AT_CLOSED}`, "show"]);
		expect(f.place).to.equal(AT_CLOSED);
	});

	it("ends where the last of two quick toggles puts it, placed once, while hidden (review focus 2)", function () {
		const {h, f} = standing();
		// close, open, close, open inside one fade: back where it started.
		f.measure(CLOSED, S);
		h.advance(100);
		f.measure(OPEN, S);
		h.advance(100);
		f.measure(CLOSED, S);
		h.advance(100);
		f.measure(OPEN, S);
		h.advance(100);
		h.frame();
		expect(h.log).to.deep.equal(["hide", `place ${AT_OPEN}`, "show"]);
		expect(f.place).to.equal(AT_OPEN);
		expect(f.fading).to.equal(false);
	});

	it("ends at the far place when the toggles stop there", function () {
		const {h, f} = standing();
		f.measure(CLOSED, S);
		h.advance(100);
		f.measure(OPEN, S);
		h.advance(100);
		f.measure(CLOSED, S);
		h.advance(200);
		h.frame();
		expect(h.log).to.deep.equal(["hide", `place ${AT_CLOSED}`, "show"]);
	});

	it("takes a change between the jump and the next frame before it shows the yurt", function () {
		const {h, f} = standing();
		f.measure(CLOSED, S);
		h.advance(FADE_MS);
		f.measure(OPEN, S); // the timer has fired; the class is still on
		expect(f.fading).to.equal(true);
		h.frame();
		expect(h.log).to.deep.equal(["hide", `place ${AT_CLOSED}`, `place ${AT_OPEN}`, "show"]);
		expect(f.place).to.equal(AT_OPEN);
	});

	it("keeps its place when the column goes, and a pending jump still lands", function () {
		const {h, f} = standing();
		f.measure(null, S);
		expect(h.log, "no column: nothing moves").to.deep.equal([]);
		f.measure(CLOSED, S);
		f.measure(null, S);
		h.advance(FADE_MS);
		h.frame();
		expect(h.log).to.deep.equal(["hide", `place ${AT_CLOSED}`, "show"]);
	});

	it("follows again once a fade has ended", function () {
		const {h, f} = standing();
		f.measure(CLOSED, S);
		h.advance(FADE_MS);
		h.frame();
		h.log.length = 0;
		f.measure({left: 250, width: 1020}, S);
		expect(h.log).to.deep.equal([`place ${250 + 0.72 * 1020}`]);
	});

	it("leaves no timer or frame behind when stopped mid-fade", function () {
		const {h, f} = standing();
		f.measure(CLOSED, S);
		f.stop();
		expect(h.pending()).to.equal(0);
		h.advance(FADE_MS * 2);
		h.frame();
		expect(h.log).to.deep.equal(["hide"]);

		const g = standing();
		g.f.measure(CLOSED, S);
		g.h.advance(FADE_MS); // between the jump and the frame
		g.f.stop();
		expect(g.h.pending()).to.equal(0);
	});
});
