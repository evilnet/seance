import {expect} from "chai";
import {afterHeldPage, holdPage} from "../../client/js/helpers/heldPages";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("held history pages (helpers/heldPages.ts)", function () {
	it("runs an update at once when no page is held for its channel", function () {
		const ran: string[] = [];
		afterHeldPage(1, () => ran.push("edit"));
		expect(ran).to.deep.equal(["edit"]);
	});

	it("holds updates for a channel until its page lands, in the order they came", async function () {
		const ran: string[] = [];
		const release = holdPage(2);
		afterHeldPage(2, () => ran.push("edit"));
		afterHeldPage(2, () => ran.push("react"));
		afterHeldPage(3, () => ran.push("other channel"));
		await flush();
		expect(ran).to.deep.equal(["other channel"]);

		ran.push("page lands");
		release();
		await flush();
		expect(ran).to.deep.equal(["other channel", "page lands", "edit", "react"]);

		// Once it has landed, updates run at once again.
		afterHeldPage(2, () => ran.push("later"));
		expect(ran.at(-1)).to.equal("later");
		release(); // a second call does nothing
	});

	it("queues a second held page behind the first", async function () {
		const ran: string[] = [];
		const first = holdPage(4);
		const second = holdPage(4);
		afterHeldPage(4, () => ran.push("update"));
		first();
		await flush();
		expect(ran).to.deep.equal([]);
		second();
		await flush();
		expect(ran).to.deep.equal(["update"]);
	});
});
