import {expect} from "chai";
import sinon from "sinon";
import {
	effectiveHeight,
	KEYBOARD_RESET_DELAY_MS,
	keyboardUp,
	resetKeyboardSoon,
	settle,
} from "../../client/js/helpers/viewport";

const g = globalThis as {window?: unknown};

describe("visual viewport sizing (helpers/viewport.ts)", function () {
	it("trusts the visual viewport while a text field has focus", function () {
		// iOS before 27 keeps innerHeight at full height under the keyboard.
		expect(effectiveHeight(424, 793, true)).to.equal(424);
	});

	it("takes the larger viewport when nothing is focused", function () {
		// iOS 27 after an app switch: the visual viewport stays at the
		// keyboard-up 400 while innerHeight is back at 793.
		expect(effectiveHeight(400, 793, false)).to.equal(793);
		expect(effectiveHeight(793, 793, false)).to.equal(793);
	});

	describe("keyboardUp", function () {
		it("is the visual viewport shorter than the window while a text field has focus", function () {
			expect(keyboardUp(371, 665, true)).to.equal(true);
			// A hardware keyboard: only Safari's form bar, still over the home indicator.
			expect(keyboardUp(592, 665, true)).to.equal(true);
		});

		it("is not the caret alone", function () {
			// After iOS's shake-to-undo alert the field gets its focus back
			// without the keyboard (phone-measured 2026-09-12).
			expect(keyboardUp(665, 665, true)).to.equal(false);
			expect(keyboardUp(664, 665, true)).to.equal(false);
		});

		it("is never up without a focused text field", function () {
			// iOS 27 after an app switch: the visual viewport is stale at the
			// keyboard-up height while nothing has focus.
			expect(keyboardUp(400, 793, false)).to.equal(false);
		});
	});

	describe("settle", function () {
		let clock: sinon.SinonFakeTimers;

		beforeEach(function () {
			clock = sinon.useFakeTimers();
		});

		afterEach(function () {
			clock.restore();
		});

		it("applies now and once more at each delay", function () {
			const apply = sinon.spy();

			settle(apply, [50, 150]);
			expect(apply.callCount).to.equal(1);
			clock.tick(50);
			expect(apply.callCount).to.equal(2);
			clock.tick(100);
			expect(apply.callCount).to.equal(3);
			clock.tick(1000);
			expect(apply.callCount).to.equal(3);
		});

		it("can be stopped", function () {
			const apply = sinon.spy();

			settle(apply, [50, 150])();
			clock.tick(1000);
			expect(apply.callCount).to.equal(1);
		});
	});

	describe("resetKeyboardSoon", function () {
		let clock: sinon.SinonFakeTimers;

		beforeEach(function () {
			clock = sinon.useFakeTimers();
		});

		afterEach(function () {
			clock.restore();
		});

		// Set and removed inside each test: mocha's leak check runs between hooks.
		function inWindow(win: object, fn: () => void): void {
			g.window = win;

			try {
				fn();
			} finally {
				delete g.window;
			}
		}

		function shell(platform: string, calls: string[]) {
			return {
				seanceShell: {
					platform,
					call(plugin: string, method: string) {
						calls.push(`${plugin}.${method}`);
						return Promise.resolve({});
					},
					listen() {},
				},
			};
		}

		it("asks the iOS shell once, after the last of a burst of edits", function () {
			const calls: string[] = [];

			inWindow(shell("ios", calls), () => {
				// The send's clear, then the late Return taken back out.
				resetKeyboardSoon();
				clock.tick(70);
				resetKeyboardSoon();
				clock.tick(KEYBOARD_RESET_DELAY_MS - 1);
				expect(calls).to.deep.equal([]);
				clock.tick(1);
				expect(calls).to.deep.equal(["Keyboard.reset"]);
				clock.tick(1000);
				expect(calls).to.deep.equal(["Keyboard.reset"]);
			});
		});

		it("does nothing outside the iOS shell", function () {
			const calls: string[] = [];

			for (const win of [shell("android", calls), {}]) {
				inWindow(win, () => {
					resetKeyboardSoon();
					clock.tick(1000);
				});
			}

			expect(calls).to.deep.equal([]);
		});
	});
});
