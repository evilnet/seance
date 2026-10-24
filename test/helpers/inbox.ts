import {expect} from "chai";
import {
	MAX_ENTRIES,
	MAX_PER_CONVERSATION,
	EXCERPT_FROM,
	addEntries,
	conversationKey,
	dropMessage,
	entryFor,
	excerptText,
	entryKey,
	groupByConversation,
	parseDismissed,
	parseStored,
	pruneRead,
	type Dismissal,
} from "../../client/js/helpers/inbox";
import type {InboxEntry} from "../../shared/types/mention";
import {MessageType, type SharedMsg} from "../../shared/types/msg";

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
	return {
		network: "net-1",
		target: "#seance",
		msgid: "m1",
		time: "2026-10-23T12:00:00.000Z",
		type: MessageType.MESSAGE,
		text: "alice: hi",
		from: {nick: "bob", mode: ""},
		...over,
	};
}

const minute = (i: number) => new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString();

describe("helpers/inbox.ts", function () {
	it("conversationKey folds case by rfc1459", function () {
		expect(conversationKey("n", "#A[b]")).to.equal(conversationKey("n", "#a{B}"));
		expect(conversationKey("n", "#a")).to.not.equal(conversationKey("m", "#a"));
	});

	describe("entryKey", function () {
		it("is the network and msgid when there is one", function () {
			expect(entryKey(entry())).to.equal("net-1/m1");
		});

		it("is the conversation alone for a private one, whatever line it shows", function () {
			expect(entryKey(entry({query: true, target: "Carol"}))).to.equal(
				entryKey(entry({query: true, target: "carol", msgid: "other"}))
			);
		});

		it("is the conversation, time and nick without a msgid", function () {
			expect(entryKey(entry({msgid: undefined, target: "#Seance"}))).to.equal(
				"net-1/#seance/2026-10-23T12:00:00.000Z/bob"
			);
		});
	});

	describe("entryFor", function () {
		const msg = {
			id: 7,
			time: new Date("2026-10-23T12:00:00.000Z"),
			text: "alice: hi",
			msgid: "m1",
			from: {nick: "bob", mode: ""},
			type: MessageType.MESSAGE,
			users: [],
		} as unknown as SharedMsg;

		it("keeps what survives a reload, never the session-local id", function () {
			const made = entryFor("net-1", "#seance", msg)!;
			expect(made).to.deep.equal(entry());
			expect(made).to.not.have.property("id");
		});

		it("flags a private conversation's entry and keeps its whole line", function () {
			const long = {...msg, text: `${"x ".repeat(100)}alice`};
			const made = entryFor("net-1", "carol", long, {query: true, findMention: () => 200})!;
			expect(made.query).to.equal(true);
			expect(made.text).to.equal(long.text);
		});

		it("makes nothing of our own line or a line without a sender", function () {
			expect(entryFor("net-1", "#seance", {...msg, self: true})).to.equal(null);
			expect(entryFor("net-1", "#seance", {...msg, from: undefined})).to.equal(null);
		});
	});

	describe("addEntries", function () {
		it("deduplicates by key and orders by time", function () {
			const a = entry({msgid: "a", time: minute(2)});
			const b = entry({msgid: "b", time: minute(1)});
			const list = addEntries([a], [b, {...a, text: "again"}]);
			expect(list.map((e) => e.msgid)).to.deep.equal(["b", "a"]);
			expect(list[1].text).to.equal("again");
		});

		it("keeps lines of the same instant in the order they came", function () {
			const t = minute(1);
			const list = addEntries(
				[entry({msgid: "a", time: t})],
				[entry({msgid: "b", time: t}), entry({msgid: "c", time: t})]
			);
			expect(list.map((e) => e.msgid)).to.deep.equal(["a", "b", "c"]);
		});

		it("keeps a conversation's newest, so a busy query cannot push the rest out", function () {
			const query = Array.from({length: MAX_PER_CONVERSATION + 30}, (_, i) =>
				entry({msgid: `q${i}`, target: "carol", time: minute(10 + i)})
			);
			const channel = entry({msgid: "c", time: minute(1)});
			const list = addEntries([channel], query);
			expect(list.filter((e) => e.target === "carol")).to.have.length(MAX_PER_CONVERSATION);
			expect(list[list.length - 1].msgid).to.equal(`q${MAX_PER_CONVERSATION + 29}`);
			expect(list.map((e) => e.msgid)).to.include("c");
		});

		it("keeps the newest overall", function () {
			const many = Array.from({length: MAX_ENTRIES + 5}, (_, i) =>
				entry({msgid: `m${i}`, target: `#c${i % 10}`, time: minute(i)})
			);
			const list = addEntries([], many);
			expect(list).to.have.length(MAX_ENTRIES);
			expect(list[0].msgid).to.equal("m5");
		});

		it("shows a private conversation's newest line, whatever order lines come in", function () {
			const q = (msgid: string, time: string) =>
				entry({query: true, target: "carol", msgid, time});
			const list = addEntries([q("b", minute(2))], [q("a", minute(1)), q("c", minute(3))]);
			expect(list.map((e) => e.msgid)).to.deep.equal(["c"]);
			expect(addEntries(list, [q("a", minute(1))]).map((e) => e.msgid)).to.deep.equal(["c"]);
		});

		it("lets a private conversation's next line past the dismissal of an earlier one", function () {
			const first = entry({query: true, target: "carol", msgid: "a", time: minute(1)});
			const gone: Dismissal[] = [
				{key: entryKey(first), network: "net-1", target: "carol", time: minute(1)},
			];
			expect(addEntries([], [first], gone)).to.deep.equal([]);
			const next = {...first, msgid: "b", time: minute(2)};
			expect(addEntries([], [next], gone)).to.deep.equal([next]);
		});

		it("never brings back a dismissed entry", function () {
			const gone: Dismissal[] = [
				{key: "net-1/m1", network: "net-1", target: "#seance", time: entry().time},
			];
			expect(addEntries([], [entry()], gone)).to.deep.equal([]);
		});
	});

	describe("dropMessage", function () {
		const list = [
			entry({msgid: "a"}),
			entry({msgid: "b", from: {nick: "Carol", mode: ""}}),
			entry({msgid: "a", network: "net-2"}),
			entry({query: true, target: "dave", msgid: "q"}),
		];

		it("drops the entry showing the message, in that conversation only", function () {
			expect(dropMessage(list, "net-1", "#Seance", "a").map((e) => e.msgid)).to.deep.equal([
				"b",
				"a",
				"q",
			]);
			expect(dropMessage(list, "net-1", "dave", "q")).to.have.length(3);
			expect(dropMessage(list, "net-1", "#elsewhere", "a")).to.have.length(4);
		});

		it("for an edit, only when its sender wrote the message", function () {
			expect(dropMessage(list, "net-1", "#seance", "b", "mallory")).to.have.length(4);
			expect(dropMessage(list, "net-1", "#seance", "b", "carol")).to.have.length(3);
		});
	});

	describe("excerptText", function () {
		const lead = "one two three four five six seven eight nine ten ".repeat(3);
		const text = `${lead}hey alice, look`;
		const find = (plain: string) => plain.indexOf("alice");

		it("keeps a line whose mention is near its start, formatting and all", function () {
			expect(excerptText("\x02hey\x02 alice", find)).to.equal("\x02hey\x02 alice");
			expect(excerptText(text)).to.equal(text);
		});

		it("starts a long line at a word a little before the mention", function () {
			expect(find(text)).to.be.greaterThan(EXCERPT_FROM);
			const cut = excerptText(text, find);
			expect(cut).to.match(/^…[a-z]/);
			expect(text.endsWith(cut.slice(1))).to.equal(true);
			expect(cut.indexOf("alice")).to.be.lessThan(40);
		});

		it("drops the formatting of a line it cuts", function () {
			const cut = excerptText(`\x0304${text}\x03`, find);
			expect(cut).to.not.match(/[\x00-\x1f]/);
		});
	});

	describe("pruneRead", function () {
		it("drops the conversation's entries at or before the time, by casemapping", function () {
			const list = [
				entry({msgid: "old", time: "2026-10-23T12:00:00.000Z"}),
				entry({msgid: "at", time: "2026-10-23T12:01:00.000Z"}),
				entry({msgid: "new", time: "2026-10-23T12:02:00.000Z"}),
				entry({msgid: "other", target: "#other", time: "2026-10-23T11:00:00.000Z"}),
				entry({msgid: "elsewhere", network: "net-2", time: "2026-10-23T11:00:00.000Z"}),
			];
			const left = pruneRead(list, "net-1", "#SEANCE", new Date("2026-10-23T12:01:00.000Z"));
			expect(left.map((e) => e.msgid)).to.deep.equal(["new", "other", "elsewhere"]);
		});

		it("forgets a dismissal the read point has passed", function () {
			const gone: Dismissal[] = [
				{key: "k", network: "net-1", target: "#seance", time: minute(1)},
			];
			expect(pruneRead(gone, "net-1", "#seance", new Date(minute(2)))).to.deep.equal([]);
		});
	});

	it("groupByConversation: newest conversation first, each oldest first", function () {
		const list = [
			entry({msgid: "a1", target: "#a", time: "2026-10-23T12:00:00.000Z"}),
			entry({msgid: "b1", target: "#b", time: "2026-10-23T12:01:00.000Z"}),
			entry({msgid: "a2", target: "#A", time: "2026-10-23T12:03:00.000Z"}),
			entry({msgid: "a0", target: "#a", time: "2026-10-23T11:00:00.000Z"}),
			entry({msgid: "c1", network: "net-2", target: "#a", time: "2026-10-23T12:02:00.000Z"}),
		];
		const groups = groupByConversation(list);
		expect(groups.map((g) => g.key)).to.deep.equal(["net-1/#a", "net-2/#a", "net-1/#b"]);
		expect(groups[0].entries.map((e) => e.msgid)).to.deep.equal(["a0", "a1", "a2"]);
	});

	describe("parsing what was stored", function () {
		it("reads what it wrote", function () {
			expect(parseStored(JSON.stringify([entry()]))).to.deep.equal([entry()]);
			const gone = [{key: "k", network: "n", target: "#t", time: minute(0)}];
			expect(parseDismissed(JSON.stringify(gone))).to.deep.equal(gone);
		});

		it("drops entries in the old shape and anything unreadable", function () {
			const old = {
				chanId: 3,
				msgId: 9,
				type: "message",
				time: "2026-10-23T12:00:00.000Z",
				text: "hi",
				from: {nick: "bob"},
			};
			expect(parseStored(JSON.stringify([old, entry()]))).to.deep.equal([entry()]);
			expect(parseStored("{not json")).to.deep.equal([]);
			expect(parseStored(JSON.stringify({}))).to.deep.equal([]);
			expect(parseStored(null)).to.deep.equal([]);
			expect(parseDismissed(JSON.stringify([{key: 1}]))).to.deep.equal([]);
		});
	});
});
