import {expect} from "chai";
import {insertMessage, removePending} from "../../client/js/helpers/messageUpdates";
import type {SharedMsg} from "../../shared/types/msg";

function msg(id: number, pending = false): SharedMsg {
	return {id, time: new Date(id * 1000), users: [], ...(pending ? {pending: true} : {})};
}

function ids(messages: SharedMsg[]): number[] {
	return messages.map((m) => m.id);
}

describe("Pending messages in the message list (helpers/messageUpdates.ts)", function () {
	describe("insertMessage", function () {
		it("appends when nothing is pending", function () {
			const messages = [msg(1), msg(2)];
			insertMessage(messages, msg(3));
			expect(ids(messages)).to.deep.equal([1, 2, 3]);
		});

		it("keeps a pending message at the bottom", function () {
			const messages = [msg(1), msg(2, true)];
			insertMessage(messages, msg(3));
			expect(ids(messages)).to.deep.equal([1, 3, 2]);
		});

		it("puts a new pending message after the ones already waiting", function () {
			const messages = [msg(1), msg(2, true)];
			insertMessage(messages, msg(3, true));
			expect(ids(messages)).to.deep.equal([1, 2, 3]);
		});

		it("inserts before the whole trailing pending block", function () {
			const messages = [msg(1), msg(2, true), msg(3, true)];
			insertMessage(messages, msg(4));
			expect(ids(messages)).to.deep.equal([1, 4, 2, 3]);
		});

		it("leaves a copy standing in an edited message's place where it is", function () {
			// 2 is hidden behind its pending edit 3 (applyEdit): they are the
			// edited message, not the slot for the next echo.
			const messages = [msg(1), {...msg(2), supersededBy: 3}, msg(3, true)];
			insertMessage(messages, msg(4));
			expect(ids(messages)).to.deep.equal([1, 2, 3, 4]);

			insertMessage(messages, msg(5, true));
			insertMessage(messages, msg(6));
			expect(ids(messages)).to.deep.equal([1, 2, 3, 4, 6, 5]);
		});

		it("only looks at the trailing block", function () {
			const messages = [msg(1, true), msg(2)];
			insertMessage(messages, msg(3));
			expect(ids(messages)).to.deep.equal([1, 2, 3]);
		});

		it("puts an older id ahead of the rows with newer ids (a catch-up gap)", function () {
			const messages = [msg(1), msg(9), msg(10)];
			insertMessage(messages, msg(5));
			insertMessage(messages, msg(6));
			expect(ids(messages)).to.deep.equal([1, 5, 6, 9, 10]);
		});

		it("puts an older id ahead of the pending block as well", function () {
			const messages = [msg(1), msg(9), msg(10, true)];
			insertMessage(messages, msg(5));
			expect(ids(messages)).to.deep.equal([1, 5, 9, 10]);
		});

		it("never splits an edited message from the edit standing in its place", function () {
			// 2 is hidden behind its edit 9 (applyEdit), which counts as 2.
			const messages = [msg(1), {...msg(2), supersededBy: 9}, msg(9), msg(10)];
			insertMessage(messages, msg(5));
			expect(ids(messages)).to.deep.equal([1, 2, 9, 5, 10]);

			const before = [msg(1), {...msg(6), supersededBy: 9}, msg(9), msg(10)];
			insertMessage(before, msg(5));
			expect(ids(before)).to.deep.equal([1, 5, 6, 9, 10]);
		});

		it("works on an empty list", function () {
			const messages: SharedMsg[] = [];
			insertMessage(messages, msg(1, true));
			insertMessage(messages, msg(2));
			expect(ids(messages)).to.deep.equal([2, 1]);
		});
	});

	describe("removePending", function () {
		it("removes the pending message with that id", function () {
			const messages = [msg(1), msg(2, true), msg(3, true)];
			expect(removePending(messages, 2)).to.equal(true);
			expect(ids(messages)).to.deep.equal([1, 3]);
		});

		it("leaves a message that is not pending alone", function () {
			const messages = [msg(1), msg(2)];
			expect(removePending(messages, 1)).to.equal(false);
			expect(ids(messages)).to.deep.equal([1, 2]);
		});

		it("shows the original again when the copy that stood in for it goes", function () {
			const messages = [msg(1), {...msg(2), supersededBy: 3}, msg(3, true)];
			expect(removePending(messages, 3)).to.equal(true);
			expect(ids(messages)).to.deep.equal([1, 2]);
			expect(messages[1].supersededBy).to.equal(undefined);
		});

		it("leaves an original hidden behind something else", function () {
			const messages = [msg(1), {...msg(2), supersededBy: 9}, msg(3, true)];
			removePending(messages, 3);
			expect(messages[1].supersededBy).to.equal(9);
		});

		it("reports a miss", function () {
			const messages = [msg(1), msg(2, true)];
			expect(removePending(messages, 9)).to.equal(false);
			expect(ids(messages)).to.deep.equal([1, 2]);
		});
	});
});
