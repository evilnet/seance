import {expect} from "chai";
import {
	inputKind,
	installInputModality,
	isTouchInput,
	kindOf,
	onInputKindChange,
	type InputKind,
} from "../../client/js/helpers/inputModality";

type FakePointer = {type?: string; pointerType?: string; buttons?: number};

describe("input modality (helpers/inputModality.ts)", function () {
	it("calls a finger touch and a mouse a pointer", function () {
		expect(kindOf({type: "pointerdown", pointerType: "touch", buttons: 1})).to.equal("touch");
		expect(kindOf({type: "pointermove", pointerType: "mouse", buttons: 0})).to.equal("pointer");
		expect(kindOf({type: "pointerdown", pointerType: "mouse", buttons: 1})).to.equal("pointer");
		expect(kindOf({type: "pointermove", pointerType: ""}), "a synthetic event").to.equal(null);
		expect(kindOf({type: "pointermove"})).to.equal(null);
	});

	it("calls a pen a pointer only while it hovers", function () {
		expect(kindOf({type: "pointermove", pointerType: "pen", buttons: 0}), "hovering").to.equal(
			"pointer"
		);
		expect(kindOf({type: "pointerdown", pointerType: "pen", buttons: 1}), "a tap").to.equal(
			null
		);
		expect(kindOf({type: "pointermove", pointerType: "pen", buttons: 1}), "a drag").to.equal(
			null
		);
	});

	it("follows the last pointer, whatever the device's primary input, and writes it on the root", function () {
		const listeners = new Map<string, (e: FakePointer) => void>();
		const g = globalThis as Record<string, unknown>;
		g.window = {
			addEventListener: (type: string, fn: (e: FakePointer) => void) =>
				listeners.set(type, fn),
		};
		const heard: InputKind[] = [];
		const off = onInputKindChange((kind) => heard.push(kind));

		try {
			const root = {dataset: {} as Record<string, string>};
			// A touchscreen laptop whose browser calls its primary input touch.
			installInputModality(root as unknown as HTMLElement, "touch");
			expect(root.dataset.input).to.equal("touch");
			expect(isTouchInput()).to.equal(true);

			listeners.get("pointermove")!({type: "pointermove", pointerType: "mouse", buttons: 0});
			expect(root.dataset.input, "the trackpad moved").to.equal("pointer");
			expect(inputKind()).to.equal("pointer");

			listeners.get("pointermove")!({type: "pointermove"});
			expect(root.dataset.input, "a synthetic event changes nothing").to.equal("pointer");

			listeners.get("pointerdown")!({type: "pointerdown", pointerType: "touch", buttons: 1});
			expect(root.dataset.input, "a finger on the screen").to.equal("touch");

			listeners.get("pointerdown")!({type: "pointerdown", pointerType: "pen", buttons: 1});
			expect(root.dataset.input, "a pen's tap changes nothing").to.equal("touch");

			listeners.get("pointermove")!({type: "pointermove", pointerType: "pen", buttons: 0});
			expect(root.dataset.input, "a pen hovering").to.equal("pointer");

			expect(heard, "every kind written, the initial one first").to.deep.equal([
				"touch",
				"pointer",
				"touch",
				"pointer",
			]);
		} finally {
			off();
			delete g.window;
		}
	});
});
