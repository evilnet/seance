import {expect} from "chai";
import sinon from "sinon";
import {OnScreen, type OnScreenChange, linesToRead} from "../../client/js/translate/onScreen";

describe("translate/onScreen", () => {
	function watched() {
		const screen = new OnScreen();
		const heard: OnScreenChange[] = [];

		screen.onChange((change) => heard.push(change));

		return {screen, heard};
	}

	it("the conversation on screen is the one shown in a visible page", () => {
		const {screen, heard} = watched();

		screen.show(7);
		expect(screen.current()).to.equal(7);

		// A phone sends the app to the background: the channel stays active,
		// but nothing is on screen.
		screen.setPageShown(false);
		expect(screen.current()).to.equal(null);
		// Another channel picked while hidden changes nothing anyone sees.
		screen.show(8);
		screen.setPageShown(true);
		expect(screen.current()).to.equal(8);

		expect(heard).to.deep.equal([
			{kind: "conversation", from: null, to: 7},
			{kind: "conversation", from: 7, to: null},
			{kind: "conversation", from: null, to: 8},
		]);
	});

	it("Settings open (no active channel) is nothing on screen", () => {
		const {screen} = watched();

		screen.show(3);
		screen.show(null);
		expect(screen.current()).to.equal(null);
	});

	it("hears lines coming into view only for the conversation on screen", () => {
		const {screen, heard} = watched();

		screen.show(1);
		heard.length = 0;
		screen.setLine(1, 10, true);
		screen.setLine(2, 20, true);
		// The same line again: nothing new to read. A line leaving is heard
		// as itself, and only once.
		screen.setLine(1, 10, true);
		screen.setLine(1, 10, false);
		screen.setLine(1, 10, false);
		screen.setLine(2, 20, false);
		screen.setLine(2, 20, true);

		expect(heard).to.deep.equal([
			{kind: "lines", chanId: 1},
			{kind: "left", chanId: 1, messageId: 10},
		]);
		expect([...screen.inView(1)]).to.deep.equal([]);
		// Kept for the one in the background, for when it is opened.
		expect([...screen.inView(2)]).to.deep.equal([20]);
		screen.forget(2);
		expect([...screen.inView(2)]).to.deep.equal([]);
	});

	it("a listener that throws does not stop the others", () => {
		const screen = new OnScreen();
		const heard: OnScreenChange[] = [];

		screen.onChange(() => {
			throw new Error("boom");
		});
		screen.onChange((change) => heard.push(change));

		const stub = sinon.stub(console, "error");

		try {
			screen.show(1);
		} finally {
			stub.restore();
		}

		expect(heard).to.have.length(1);
	});

	describe("linesToRead", () => {
		const messages = [1, 2, 3, 4, 5, 6].map((id) => ({id}));

		it("the wanted lines in view, newest first", () => {
			expect(
				linesToRead(messages, new Set([2, 3, 5, 9]), () => true, 40).map((m) => m.id)
			).to.deep.equal([5, 3, 2]);
		});

		it("passes over what is not wanted, and stops at the cap", () => {
			expect(
				linesToRead(messages, new Set([1, 2, 3, 4, 5, 6]), (m) => m.id !== 5, 3).map(
					(m) => m.id
				)
			).to.deep.equal([6, 4, 3]);
		});

		it("what is on the visible part first, then the margin, each newest first", () => {
			expect(
				linesToRead(
					messages,
					new Set([1, 2, 3, 4, 5, 6]),
					() => true,
					4,
					new Set([1, 2])
				).map((m) => m.id)
			).to.deep.equal([2, 1, 6, 5]);
		});

		it("keeps which lines are on the visible part, and forgets them with the rest", () => {
			const screen = new OnScreen();

			screen.setVisible(1, 10, true);
			screen.setVisible(1, 11, true);
			screen.setVisible(1, 10, false);
			expect([...screen.visible(1)]).to.deep.equal([11]);
			screen.forget(1);
			expect([...screen.visible(1)]).to.deep.equal([]);
		});

		it("nothing in view, nothing to read", () => {
			expect(linesToRead(messages, new Set(), () => true, 40)).to.deep.equal([]);
			expect(linesToRead(messages, new Set([1]), () => true, 0)).to.deep.equal([]);
		});
	});
});
