import {expect} from "chai";
import {yieldToPage} from "../../client/js/translate/yieldToPage";

describe("translate/yieldToPage", () => {
	it("resolves only after a real task boundary, never among microtasks", async () => {
		let done = false;
		const yielded = yieldToPage().then(() => {
			done = true;
		});

		for (let i = 0; i < 100; i++) {
			await Promise.resolve();
		}

		expect(done).to.equal(false);
		await yielded;
		expect(done).to.equal(true);
	});

	it("uses scheduler.yield where the platform has it", async () => {
		const global = globalThis as {scheduler?: unknown};
		let calls = 0;

		global.scheduler = {
			yield() {
				calls += 1;
				return Promise.resolve();
			},
		};

		try {
			await yieldToPage();
		} finally {
			delete global.scheduler;
		}

		expect(calls).to.equal(1);
	});
});
