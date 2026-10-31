import {expect} from "chai";
import {backdropDirective} from "../../client/js/helpers/backdrop";

// A stand-in element: just enough of EventTarget for the directive.
class FakeElement {
	listeners = new Map<string, Set<(event: Event) => void>>();

	addEventListener(type: string, fn: (event: Event) => void) {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}

		this.listeners.get(type)!.add(fn);
	}

	removeEventListener(type: string, fn: (event: Event) => void) {
		this.listeners.get(type)?.delete(fn);
	}

	fire(type: string, target: unknown) {
		for (const fn of this.listeners.get(type) ?? []) {
			fn({type, target} as unknown as Event);
		}
	}
}

describe("v-backdrop", function () {
	const inner = {};
	let backdrop: FakeElement;
	let calls: number;

	const mount = (handler: () => void) => {
		(backdropDirective.mounted as any)(backdrop, {value: handler});
	};

	beforeEach(function () {
		backdrop = new FakeElement();
		calls = 0;
		mount(() => calls++);
	});

	it("closes on a click pressed and released on the backdrop", function () {
		backdrop.fire("pointerdown", backdrop);
		backdrop.fire("pointerup", backdrop);
		backdrop.fire("click", backdrop);
		expect(calls).to.equal(1);
	});

	it("ignores a drag that began inside and ended on the backdrop", function () {
		// The browser fires such a click on the common ancestor: the backdrop.
		backdrop.fire("pointerdown", inner);
		backdrop.fire("pointerup", backdrop);
		backdrop.fire("click", backdrop);
		expect(calls).to.equal(0);
	});

	it("ignores a press on the backdrop let go inside the modal", function () {
		backdrop.fire("pointerdown", backdrop);
		backdrop.fire("pointerup", inner);
		backdrop.fire("click", backdrop);
		expect(calls).to.equal(0);
	});

	it("ignores a click inside the modal", function () {
		backdrop.fire("pointerdown", inner);
		backdrop.fire("pointerup", inner);
		backdrop.fire("click", inner);
		expect(calls).to.equal(0);
	});

	it("ignores a click whose press it never saw (the one that opened it)", function () {
		backdrop.fire("click", backdrop);
		expect(calls).to.equal(0);
	});

	it("forgets a press once its click is over", function () {
		backdrop.fire("pointerdown", backdrop);
		backdrop.fire("pointerup", backdrop);
		backdrop.fire("click", backdrop);
		backdrop.fire("click", backdrop);
		expect(calls).to.equal(1);
	});

	it("takes its listeners off when unmounted", function () {
		(backdropDirective.unmounted as any)(backdrop);
		expect([...backdrop.listeners.values()].every((set) => set.size === 0)).to.equal(true);
	});
});
