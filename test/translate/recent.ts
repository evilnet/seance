import {expect} from "chai";
import {
	RECENT_LINES,
	recentLanguages,
	suggestedLanguage,
	type RecentEntry,
	type RecentMessage,
} from "../../client/js/translate/recent";

function channel(froms: (string | null)[], extra: Partial<RecentMessage> = {}) {
	const messages: RecentMessage[] = [];
	const entries: Record<number, RecentEntry> = {};

	froms.forEach((from, i) => {
		messages.push({id: i + 1, type: "message", ...extra});

		if (from !== null) {
			entries[i + 1] = {status: "done", from};
		}
	});

	return {messages, entries};
}

describe("translate/recent", () => {
	it("counts others' placed lines, most first", () => {
		const {messages, entries} = channel(["pt", "pt", "es", "", null, "pt"]);

		expect(recentLanguages(messages, entries)).to.deep.equal([
			{code: "pt", count: 3},
			{code: "es", count: 1},
		]);
	});

	it("leaves out the user's own lines, events and dropped entries", () => {
		const {messages, entries} = channel(["pt", "pt"]);

		messages.push({id: 10, type: "message", self: true});
		entries[10] = {status: "done", from: "de"};
		messages.push({id: 11, type: "join"});
		entries[11] = {status: "done", from: "de"};
		messages.push({id: 12, type: "action"});
		entries[12] = {status: "dropped", from: "de"};

		expect(recentLanguages(messages, entries)).to.deep.equal([{code: "pt", count: 2}]);
	});

	it("looks only at the newest lines", () => {
		const old = Array.from({length: 10}, () => "de");
		const recent = Array.from({length: RECENT_LINES}, () => "pt");
		const {messages, entries} = channel([...old, ...recent]);

		expect(recentLanguages(messages, entries)).to.deep.equal([
			{code: "pt", count: RECENT_LINES},
		]);
	});

	it("suggests the clear majority that is not the reader's language", () => {
		expect(
			suggestedLanguage(
				[
					{code: "pt", count: 6},
					{code: "en", count: 3},
				],
				"en"
			)
		).to.equal("pt");
	});

	it("suggests nothing for the reader's own language, a quiet or a mixed channel", () => {
		expect(suggestedLanguage([{code: "en", count: 9}], "en")).to.equal(null);
		expect(suggestedLanguage([{code: "pt", count: 4}], "en")).to.equal(null);
		expect(
			suggestedLanguage(
				[
					{code: "pt", count: 5},
					{code: "es", count: 4},
					{code: "de", count: 3},
				],
				"en"
			)
		).to.equal(null);
		expect(suggestedLanguage([], "en")).to.equal(null);
	});
});
