import {expect} from "chai";
import {TOPIC_ENTRY_BASE, isTopicEntryId, topicEntryId} from "../../client/js/translate/topic";

describe("translate/topic", () => {
	it("gives every channel a topic id below every history id", () => {
		expect(topicEntryId(1)).to.equal(TOPIC_ENTRY_BASE - 1);
		expect(topicEntryId(7)).to.not.equal(topicEntryId(8));
		expect(isTopicEntryId(topicEntryId(1))).to.equal(true);
		expect(isTopicEntryId(topicEntryId(123456))).to.equal(true);
	});

	it("tells a message id from a topic id", () => {
		expect(isTopicEntryId(1)).to.equal(false);
		expect(isTopicEntryId(-1)).to.equal(false);
		expect(isTopicEntryId(-999_999_999)).to.equal(false);
	});
});
