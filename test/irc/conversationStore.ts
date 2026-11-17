import {expect} from "chai";
import sinon from "sinon";
import storage from "../../client/js/localStorage";
import {
	ConversationStore,
	JOURNAL_PREFIX,
	LEGACY_LOG_PREFIX,
	MAX_LINES,
	MemoryBackend,
	flushConversationStores,
	forgetNetworkConversations,
	lineKey,
	preloadConversations,
	setConversationsEnabled,
	useConversationBackend,
} from "../../client/js/irc/conversationStore";
import {requestMore} from "../../client/js/irc/history";
import * as saved from "../../client/js/irc/saved-networks";
import type {StorageBackend} from "../../client/js/irc/saved-networks";
import {ChanState} from "../../shared/types/chan";
import {MessageType, type SharedMsg} from "../../shared/types/msg";
import {ALL_CAPS, Harness, batch, joined, labelOf, register, setup} from "./support";

class MemoryStorage implements StorageBackend {
	data = new Map<string, string>();

	get(key: string): string | null {
		return this.data.get(key) ?? null;
	}

	set(key: string, value: string): void {
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}
}

const fold = (s: string) => s.toLowerCase();
const UUID = "store-net";

function line(n: number, text = `line ${n}`, extra: Partial<SharedMsg> = {}): SharedMsg {
	return {
		id: 0,
		type: MessageType.MESSAGE,
		text,
		time: new Date(Date.UTC(2026, 10, 1, 12, 0, n)),
		from: {nick: "bob", mode: ""},
		msgid: `m${n}`,
		users: [],
		...extra,
	};
}

/** What a page load would find for `name` (a fresh store on the same backend). */
function reloaded(
	name: string,
	uuid = UUID
): {texts: (string | undefined)[]; store: ConversationStore} {
	const store = new ConversationStore(uuid, fold);
	return {texts: store.restoredMessages(name).map((m) => m.text), store};
}

describe("Conversations kept on the device (irc/conversationStore.ts)", function () {
	let backend: MemoryBackend;

	beforeEach(function () {
		backend = new MemoryBackend();
		useConversationBackend(backend);
		setConversationsEnabled(true);
	});

	afterEach(async function () {
		await flushConversationStores();
		setConversationsEnabled(true);
		useConversationBackend(null);
		sinon.restore();
	});

	describe("the store", function () {
		it("keeps a channel's and a private chat's lines the same way, and gives them back", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("#Seance", "channel", line(1));
			store.append("#seance", "channel", line(2));
			store.append("Bob", "query", line(3));
			await store.flush();

			const again = new ConversationStore(UUID, fold);
			expect(again.windows().map((w) => [w.name, w.kind])).to.deep.equal([
				["Bob", "query"],
				["#seance", "channel"],
			]);
			expect(again.restoredMessages("#SEANCE").map((m) => m.text)).to.deep.equal([
				"line 1",
				"line 2",
			]);
			expect(again.restoredMessages("bob")[0].time).to.be.instanceOf(Date);
			expect(again.restoredMessages("bob")[0].msgid).to.equal("m3");
		});

		it("keeps events, and neither pending copies nor the client's own status text", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append(
				"#seance",
				"channel",
				line(1, "", {type: MessageType.JOIN, text: undefined})
			);
			store.append("#seance", "channel", line(2, "typing…", {pending: true}));
			store.append("#seance", "channel", line(3, "you are not connected", {type: undefined}));
			store.append("#seance", "channel", line(4, "oops", {type: MessageType.ERROR}));
			await store.flush();

			expect(
				reloaded("#seance")
					.store.restoredMessages("#seance")
					.map((m) => m.type)
			).to.deep.equal([MessageType.JOIN]);
		});

		it("orders by time, whatever order the lines came in", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("#seance", "channel", line(5));
			store.append("#seance", "channel", line(2)); // an older page, later
			store.append("#seance", "channel", line(9));
			await store.flush();
			expect(reloaded("#seance").texts).to.deep.equal(["line 2", "line 5", "line 9"]);
		});

		it("matches a line without a msgid by time, sender, kind and text", async function () {
			const bare = (n: number, text: string) => line(n, text, {msgid: undefined});
			const store = new ConversationStore(UUID, fold);
			store.append("#seance", "channel", bare(1, "hi"));
			store.append("#seance", "channel", bare(1, "hi")); // the same line again
			store.append("#seance", "channel", bare(1, "ho")); // another, in the same ms
			store.append("#seance", "channel", bare(2, "hi")); // the same words, later
			await store.flush();
			expect(reloaded("#seance").texts).to.deep.equal(["hi", "ho", "hi"]);
			expect(lineKey(bare(1, "hi"), fold)).to.equal(lineKey(bare(7, "hi"), fold));
		});

		it("keeps the newest lines only, oldest out first", async function () {
			const store = new ConversationStore(UUID, fold);

			for (let i = 0; i < MAX_LINES + 150; i++) {
				store.append("#seance", "channel", {
					...line(0, `n${i}`),
					msgid: `x${i}`,
					time: new Date(Date.UTC(2026, 10, 1) + i * 1000),
				});
			}

			await store.flush();
			const kept = backend.lines.get(`${UUID}\n#seance`)!;
			expect(kept).to.have.length(MAX_LINES);
			expect(kept[0].msg.text).to.equal("n150");
			expect(kept[kept.length - 1].msg.text).to.equal(`n${MAX_LINES + 149}`);
		});

		it("hands out older lines a page at a time", async function () {
			const store = new ConversationStore(UUID, fold);

			for (let i = 1; i <= 30; i++) {
				store.append("#seance", "channel", line(i));
			}

			const page = await store.older(
				"#seance",
				new Date(Date.UTC(2026, 10, 1, 12, 0, 20)),
				5
			);
			expect(page.map((m) => m.text)).to.deep.equal([
				"line 16",
				"line 17",
				"line 18",
				"line 19",
				"line 20",
			]);
		});

		it("follows an edit, a reaction and a deletion, by msgid", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1, "teh plan"));
			store.append("bob", "query", line(2, "keep me"));
			store.append("bob", "query", line(3, "the plan", {msgid: "e1"}));
			store.edit("bob", "m1", "e1");
			store.react("bob", "m2", "👍", "Carol", false);
			store.react("bob", "m2", "👍", "carol", false); // once per nick
			store.append("bob", "query", line(4, "delete me"));
			store.redact("bob", "m4");
			await store.flush();

			const again = new ConversationStore(UUID, fold);
			const messages = again.restoredMessages("bob");
			expect(messages.map((m) => m.text)).to.deep.equal(["the plan", "keep me"]);
			expect(messages[0].msgid).to.equal("m1");
			expect(messages[0].editedAt).to.be.instanceOf(Date);
			expect(messages[1].reactions).to.deep.equal([{text: "👍", nicks: ["Carol"]}]);
			// The edit's msgid still finds the line it became (history dedupe).
			expect(again.restoredAliases("bob")).to.deep.equal([["e1", 0]]);
		});

		it("deletes a kept line that is no longer loaded", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("#seance", "channel", line(1));
			await store.flush();

			// Another page, which never loaded it.
			const later = new ConversationStore(UUID, fold);
			later.redact("#seance", "m1");
			await later.flush();
			expect(reloaded("#seance").texts).to.deep.equal([]);
		});

		it("keeps the read point, which only moves forward", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1));
			store.setRead("bob", "query", new Date(5000));
			store.setRead("bob", "query", new Date(3000));
			await store.flush();
			expect(new ConversationStore(UUID, fold).meta("bob")!.read).to.equal(5000);
		});

		it("a closed window keeps its lines, hidden and read, until it is opened again", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1));
			store.append("#seance", "channel", line(2));
			store.append("#gone", "channel", line(3));
			store.setJoined("#gone", true, "sesame");
			store.close("bob", line(1).time);
			store.close("#gone");
			await store.flush();

			const again = new ConversationStore(UUID, fold);
			expect(again.windows().map((w) => w.name)).to.deep.equal(["#seance"]);
			// Remembered, not shown, not joined by itself.
			expect(again.meta("#gone")).to.include({closed: true, joined: false});
			expect(again.meta("#gone")!.key).to.equal(undefined);
			expect(again.restoredMessages("#gone").map((m) => m.text)).to.deep.equal(["line 3"]);
			// The private chat as the channel: its lines are there, and read.
			expect(again.meta("bob")).to.include({closed: true, read: line(1).time.getTime()});
			expect(again.meta("bob")!.clearedAt).to.equal(undefined);
			expect(again.restoredMessages("bob").map((m) => m.text)).to.deep.equal(["line 1"]);

			// Asked for again, and joined again: both windows are open, with
			// what was kept.
			again.reopen("bob", "query");
			again.setJoined("#gone", true);
			await again.flush();
			const third = new ConversationStore(UUID, fold);
			expect(
				third
					.windows()
					.map((w) => w.name)
					.sort()
			).to.deep.equal(["#gone", "#seance", "bob"]);
			expect(third.restoredMessages("#gone").map((m) => m.text)).to.deep.equal(["line 3"]);
			expect(third.restoredMessages("bob").map((m) => m.text)).to.deep.equal(["line 1"]);
			await flushConversationStores();

			forgetNetworkConversations(UUID);
			await backend.run("readonly", () => Promise.resolve());
			expect(new ConversationStore(UUID, fold).windows()).to.deep.equal([]);
		});

		it("a line said in a closed private chat opens it again", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1));
			store.close("bob", line(1).time);
			store.append("bob", "query", line(2));
			await store.flush();

			const again = new ConversationStore(UUID, fold);
			expect(again.windows().map((w) => w.name)).to.deep.equal(["bob"]);
			expect(again.restoredMessages("bob").map((m) => m.text)).to.deep.equal([
				"line 1",
				"line 2",
			]);
		});

		it("clearing keeps what was cleared from coming back, and takes what is newer", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("#seance", "channel", line(1));
			store.append("#seance", "channel", line(2));
			store.clear("#seance", line(2).time);
			store.append("#seance", "channel", line(1)); // a history page brings it again
			store.append("#seance", "channel", line(3));
			await store.flush();

			const again = new ConversationStore(UUID, fold);
			expect(again.restoredMessages("#seance").map((m) => m.text)).to.deep.equal(["line 3"]);
			expect(again.meta("#seance")!.clearedAt).to.equal(line(2).time.getTime());
		});

		it("a full disk: deletions still land, the oldest lines make room, the rest is written", async function () {
			const store = new ConversationStore(UUID, fold);

			for (let i = 0; i < 300; i++) {
				store.append("#seance", "channel", {
					...line(0, `n${i}`),
					msgid: `x${i}`,
					time: new Date(Date.UTC(2026, 10, 1) + i * 1000),
				});
			}

			await store.flush();
			store.redact("#seance", "x299");
			store.append("#seance", "channel", line(50, "after the squeeze"));
			store.append("bob", "query", line(60, "arrives and is cleared"));
			store.clear("bob", line(60).time);
			backend.failNext = "QuotaExceededError";
			await store.flush();

			const kept = backend.lines.get(`${UUID}\n#seance`)!.map((l) => l.msg.text);
			expect(kept).to.not.include("n299");
			expect(kept).to.include("after the squeeze");
			expect(kept[0]).to.equal("n149"); // the oldest half went
			expect(backend.lines.get(`${UUID}\nbob`) ?? []).to.have.length(0);
		});

		it("keeps nothing for a network that is not saved", async function () {
			const store = new ConversationStore(UUID, fold, () => false);
			store.append("#seance", "channel", line(1));
			await store.flush();
			expect(backend.convs.size).to.equal(0);
		});

		it("switched off, deletes everything and keeps nothing more", async function () {
			const store = new ConversationStore(UUID, fold);
			store.append("#seance", "channel", line(1));
			await store.flush();

			setConversationsEnabled(false);
			store.append("#seance", "channel", line(2));
			await store.flush();
			await backend.run("readonly", () => Promise.resolve());
			expect(backend.convs.size).to.equal(0);
			expect(backend.lines.size).to.equal(0);
			expect(new ConversationStore(UUID, fold).windows()).to.deep.equal([]);
		});
	});

	describe("two copies of the app", function () {
		it("do not overwrite each other's conversations (BUG-120)", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);
			a.append("carol", "query", line(1, "around?"));
			b.append("bob", "query", line(7, "hi"));
			b.setRead("bob", "query", line(7).time);
			await a.flush();
			await b.flush();
			a.append("carol", "query", line(2, "yes"));
			await a.flush();

			const again = new ConversationStore(UUID, fold);
			expect(again.restoredMessages("carol").map((m) => m.text)).to.deep.equal([
				"around?",
				"yes",
			]);
			expect(again.restoredMessages("bob").map((m) => m.text)).to.deep.equal(["hi"]);
			expect(again.meta("bob")!.read).to.equal(line(7).time.getTime());
		});

		it("keep one copy of a line both received, with or without a msgid", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);

			for (const store of [a, b]) {
				store.append("dave", "query", line(9));
				store.append("dave", "query", line(10, "bare", {msgid: undefined}));
			}

			await a.flush();
			await b.flush();
			expect(reloaded("dave").texts).to.deep.equal(["line 9", "bare"]);
		});

		it("one's late copy of a line does not undo the other's edit or reaction", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);
			a.append("bob", "query", line(1, "teh plan"));
			a.append("bob", "query", line(2, "the plan", {msgid: "e1"}));
			a.edit("bob", "m1", "e1");
			a.react("bob", "m1", "👍", "carol", false);
			await a.flush();

			// The other tab gets the same lines from a history page, later.
			b.append("bob", "query", line(1, "teh plan"));
			b.append("bob", "query", line(2, "the plan", {msgid: "e1"}));
			b.edit("bob", "m1", "e1");
			await b.flush();

			const messages = new ConversationStore(UUID, fold).restoredMessages("bob");
			expect(messages.map((m) => m.text)).to.deep.equal(["the plan"]);
			expect(messages[0].reactions).to.deep.equal([{text: "👍", nicks: ["carol"]}]);
		});

		it("a line one deleted does not come back with the other's late copy, or from a journal", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);
			a.append("#seance", "channel", line(1));
			a.append("#seance", "channel", line(2, "delete me"));
			await a.flush();
			b.append("#seance", "channel", line(2, "delete me")); // queued in B
			a.redact("#seance", "m2");
			await a.flush();
			await b.flush();
			expect(reloaded("#seance").texts).to.deep.equal(["line 1"]);

			// A deletion that arrives before its line (another tab's history page).
			a.redact("#seance", "m9");
			await a.flush();
			b.append("#seance", "channel", line(9));
			await b.flush();
			expect(reloaded("#seance").texts).to.deep.equal(["line 1"]);
		});

		it("what one cleared stays cleared when the other, unaware, writes older lines", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);
			a.append("#seance", "channel", line(1));
			a.append("#seance", "channel", line(2));
			await a.flush();
			a.clear("#seance", line(2).time);
			await a.flush();
			// B never heard of the clear: only the transaction can refuse these.
			b.append("#seance", "channel", line(1));
			b.append("#seance", "channel", line(3));
			await b.flush();
			expect(reloaded("#seance").texts).to.deep.equal(["line 3"]);
		});

		it("a write that was queued when the other removed the network is dropped", async function () {
			const a = new ConversationStore(UUID, fold);
			const b = new ConversationStore(UUID, fold);
			b.append("#seance", "channel", line(1));
			forgetNetworkConversations(UUID); // tab A; B has not heard
			await backend.run("readonly", () => Promise.resolve());
			a.dispose();
			// B was reset by the same call here; a real second tab still holds its queue.
			b.append("#seance", "channel", line(2));
			await b.flush();
			expect(backend.lines.get(`${UUID}\n#seance`) ?? []).to.have.length(0);
		});
	});

	describe("a page that goes away before the database answers", function () {
		it("leaves what it could not write in localStorage, and the next page takes it in", async function () {
			const data = new Map<string, string>();
			sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
			sinon
				.stub(storage, "set")
				.callsFake((key: string, value: string) => void data.set(key, value));
			sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
			sinon.stub(storage, "keys").callsFake(() => [...data.keys()]);

			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1, "said just before the reload"));
			store.journal(); // pagehide: synchronous
			expect([...data.keys()].filter((k) => k.startsWith(JOURNAL_PREFIX))).to.have.length(1);

			// The page is gone; its write never reached the database.
			const next = new MemoryBackend();
			useConversationBackend(next);
			await preloadConversations();
			expect(data.size).to.equal(0);
			const messages = new ConversationStore(UUID, fold).restoredMessages("bob");
			expect(messages.map((m) => m.text)).to.deep.equal(["said just before the reload"]);
			expect(messages[0].time).to.be.instanceOf(Date);
		});

		it("takes its journal away again when the write lands after all", async function () {
			const data = new Map<string, string>();
			sinon
				.stub(storage, "set")
				.callsFake((key: string, value: string) => void data.set(key, value));
			sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
			sinon.stub(storage, "keys").callsFake(() => [...data.keys()]);

			const store = new ConversationStore(UUID, fold);
			store.append("bob", "query", line(1));
			const done = flushConversationStores(); // the tab was only hidden
			expect(data.size).to.equal(1);
			await done;
			expect(data.size).to.equal(0);
			expect(reloaded("bob").texts).to.deep.equal(["line 1"]);
		});
	});

	describe("the boot snapshot", function () {
		it("goes to a network's first store only, and is read again when that store goes away", async function () {
			const first = new ConversationStore(UUID, fold);
			first.append("#seance", "channel", line(1));
			await first.flush();
			first.dispose();
			await preloadConversations();

			// The page's client for this network.
			const client = new ConversationStore(UUID, fold);
			expect(client.blind).to.equal(false);
			expect(client.restoredMessages("#seance").map((m) => m.text)).to.deep.equal(["line 1"]);
			client.append("#seance", "channel", line(2));
			client.append("bob", "query", line(3));
			client.close("bob", line(3).time);

			// A second one while the first lives must not start from page-load state.
			const early = new ConversationStore(UUID, fold);
			expect(early.blind).to.equal(true);
			expect(early.windows()).to.deep.equal([]);
			early.dispose();

			// `/quit`, then the network is connected again: a new client.
			client.dispose();
			await client.flush();
			await backend.run("readonly", () => Promise.resolve());
			await new Promise((resolve) => setTimeout(resolve, 0));
			const next = new ConversationStore(UUID, fold);
			expect(next.blind).to.equal(false);
			expect(next.windows().map((w) => w.name)).to.deep.equal(["#seance"]);
			expect(next.restoredMessages("#seance").map((m) => m.text)).to.deep.equal([
				"line 1",
				"line 2",
			]);
			// And its writes land: the epochs are current.
			next.append("#seance", "channel", line(4));
			await next.flush();
			expect(backend.lines.get(`${UUID}\n#seance`)).to.have.length(3);
		});

		it("a store made without it vouches for nothing", async function () {
			const first = new ConversationStore(UUID, fold);
			first.append("#seance", "channel", line(1));
			await first.flush();
			await preloadConversations();
			new ConversationStore(UUID, fold).dispose(); // takes the snapshot
			const blind = new ConversationStore(UUID, fold);
			expect(blind.blind).to.equal(true);
			blind.append("#seance", "channel", line(5));
			blind.setFilled("#seance", "channel", true);
			await blind.flush();
			expect(backend.convs.get(`${UUID}\n#seance`)!.filled ?? false).to.equal(false);
		});
	});

	describe("the log it replaced", function () {
		it("is moved in once, read point and folded edits included, then deleted", async function () {
			const data = new Map<string, string>();
			sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
			sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
			sinon.stub(storage, "keys").callsFake(() => [...data.keys()]);
			data.set(
				LEGACY_LOG_PREFIX + UUID,
				JSON.stringify({
					v: 1,
					queries: [
						{
							name: "Bob",
							touched: 2000,
							read: 1500,
							messages: [
								{
									msgid: "o1",
									aka: ["e1"],
									time: "2026-11-01T12:00:01.000Z",
									type: "message",
									nick: "Bob",
									text: "the plan",
									editedAt: "2026-11-01T12:00:05.000Z",
								},
								{
									time: "2026-11-01T12:00:02.000Z",
									type: "action",
									text: "waves",
									self: true,
								},
							],
						},
					],
				})
			);

			await preloadConversations();
			expect(data.size).to.equal(0);

			const store = new ConversationStore(UUID, fold);
			const messages = store.restoredMessages("bob");
			expect(messages.map((m) => [m.type, m.text, m.self])).to.deep.equal([
				["message", "the plan", undefined],
				["action", "waves", true],
			]);
			expect(store.meta("bob")!.read).to.equal(1500);
			expect(store.restoredAliases("bob")).to.deep.equal([["e1", 0]]);
		});

		it("is deleted unread when conversations are not kept", async function () {
			const data = new Map<string, string>([[LEGACY_LOG_PREFIX + UUID, "{}"]]);
			sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
			sinon.stub(storage, "keys").callsFake(() => [...data.keys()]);
			setConversationsEnabled(false);
			await preloadConversations();
			expect(data.size).to.equal(0);
		});
	});

	describe("a page load is a reconnect", function () {
		const NET = "reload-net";
		let n = 0;

		function savedNet(join = "#seance"): string {
			const uuid = `${NET}-${++n}`;
			saved.save({
				uuid,
				name: "",
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join,
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
			return uuid;
		}

		const said = (i: number, text = `line ${i}`, target = "#seance") => {
			const minute = String(i).padStart(2, "0");
			return `@time=2026-08-25T12:${minute}:00.000Z;msgid=s${i} :bob!bob@host PRIVMSG ${target} :${text}`;
		};

		/** A page that joined #seance, saw `lines`, and went away. */
		async function firstPage(uuid: string, lines: string[]): Promise<Harness> {
			const h = setup({uuid});
			joined(h, ALL_CAPS);
			h.transport.lines(...lines);
			await flushConversationStores();
			h.client.conversations.dispose();
			return h;
		}

		beforeEach(function () {
			saved.useStorageBackend(new MemoryStorage());
		});

		afterEach(function () {
			saved.useStorageBackend(null);
		});

		it("shows every window's lines before any connection", async function () {
			const uuid = savedNet();
			await firstPage(uuid, [said(1), said(2), said(3, "psst", "alice")]);

			const h = setup({uuid});
			h.client.connect(); // announces; the socket is not open
			const pages = h.payloads<{chan: number; messages: SharedMsg[]}>("more");
			const chan = h.client.findChannel("#seance")!;
			const query = h.client.findChannel("bob")!;
			expect(
				pages.find((p) => p.chan === chan.id)!.messages.map((m) => m.text)
			).to.include.members(["line 1", "line 2"]);
			expect(
				pages.find((p) => p.chan === query.id)!.messages.map((m) => m.text)
			).to.deep.equal(["psst"]);
			expect(h.transport.sent).to.deep.equal([]);
		});

		it("the JOIN is quiet and starts the catch-up walk, which adds only what is new", async function () {
			const uuid = savedNet();
			await firstPage(uuid, [said(1), said(2)]);

			const h = setup({uuid});
			register(h, ALL_CAPS);
			h.dispatch.resetHistory();
			h.transport.lines(
				"@time=2026-08-25T12:30:00.000Z;msgid=join-2 :alice!alice@host JOIN #seance",
				":irc.test 353 alice = #seance :@alice bob",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			const sent = h.sent();
			// The walk (LATEST 100, appended), not a first fill (LATEST 50).
			expect(sent.find((l) => l.includes("CHATHISTORY"))).to.match(
				/CHATHISTORY LATEST #seance \* 100$/
			);
			batch(h, [said(2), said(3), said(4)], {label: labelOf(sent)});

			const chan = h.client.findChannel("#seance")!;
			expect(h.messages(chan.id).map((m) => m.text)).to.deep.equal(["line 3", "line 4"]);
			expect(h.messages(chan.id).some((m) => m.type === MessageType.JOIN)).to.equal(false);
			expect(chan.historyFilled).to.equal(true);
		});

		it("a walk that does not reach the kept lines leaves a gap marker, kept across the next load", async function () {
			const uuid = savedNet();
			await firstPage(uuid, [said(1), said(2)]);

			const h2 = setup({uuid});
			register(h2, ALL_CAPS);
			h2.transport.lines(
				"@time=2026-08-25T12:50:00.000Z;msgid=join-3 :alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			let asked = h2.sent();

			for (let page = 0; page < 5; page++) {
				const base = 40 - page * 2;
				batch(h2, [said(base - 1), said(base)], {label: labelOf(asked), ref: `p${page}`});
				asked = h2.sent();
			}

			const chan = h2.client.findChannel("#seance")!;
			const shown = h2.messages(chan.id);
			expect(shown[0].text).to.equal("line 31");
			expect(shown[0].gapBefore).to.equal(true);
			expect(shown.filter((m) => m.gapBefore)).to.have.length(1);
			await flushConversationStores();

			const again = new ConversationStore(uuid, (s) => s.toLowerCase());
			const kept = again.restoredMessages("#seance");
			expect(kept.find((m) => m.text === "line 31")!.gapBefore).to.equal(true);
			expect(kept.find((m) => m.text === "line 2")!.gapBefore).to.equal(undefined);
		});

		it("loading a gap puts the missing lines in place and takes the marker away", async function () {
			const uuid = savedNet();
			await firstPage(uuid, [said(1), said(2)]);
			const h = setup({uuid});
			register(h, ALL_CAPS);
			h.transport.lines(
				"@time=2026-08-25T12:50:00.000Z;msgid=join-2 :alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			let asked = h.sent();

			for (let page = 0; page < 5; page++) {
				const base = 40 - page * 2;
				batch(h, [said(base - 1), said(base)], {label: labelOf(asked), ref: `p${page}`});
				asked = h.sent();
			}

			const chan = h.client.findChannel("#seance")!;
			const marked = h.messages(chan.id).find((m) => m.gapBefore)!;
			h.dispatch.resetHistory();

			// The divider's control.
			const {requestFill} = await import("../../client/js/irc/history");
			expect(requestFill(h.client, chan, marked.id)).to.equal(true);
			asked = h.sent();
			expect(asked[0]).to.match(/CHATHISTORY BEFORE #seance msgid=s31 100$/);
			batch(h, [said(2), said(3), said(4)], {label: labelOf(asked)});

			const filled = h.messages(chan.id);
			expect(filled.map((m) => m.text)).to.deep.equal(["line 3", "line 4"]);
			// Between the kept lines and the marked one, by id.
			expect(filled.every((m) => m.id < marked.id)).to.equal(true);
			expect(h.payloads("msg:gap")).to.deep.equal([
				{chan: chan.id, id: marked.id, gap: false},
			]);
			await flushConversationStores();
			const kept = new ConversationStore(uuid, (s) => s.toLowerCase()).restoredMessages(
				"#seance"
			);
			expect(kept.some((m) => m.gapBefore)).to.equal(false);
			expect(
				kept
					.map((m) => m.text)
					.filter(Boolean)
					.slice(0, 4)
			).to.deep.equal(["line 1", "line 2", "line 3", "line 4"]);
		});

		it("joins a channel joined by hand again, and leaves one we were kicked from parted", async function () {
			const uuid = savedNet();
			const first = setup({uuid});
			joined(first, ALL_CAPS);
			first.transport.lines(
				"@time=2026-08-25T12:01:00.000Z;msgid=j2 :alice!alice@host JOIN #byhand",
				":irc.test 366 alice #byhand :End of /NAMES list.",
				"@time=2026-08-25T12:02:00.000Z;msgid=j3 :alice!alice@host JOIN #rough",
				":irc.test 366 alice #rough :End of /NAMES list.",
				said(3, "in here", "#rough"),
				"@time=2026-08-25T12:04:00.000Z;msgid=k1 :bob!bob@host KICK #rough alice :out"
			);
			await flushConversationStores();
			first.client.conversations.dispose();

			const h = setup({uuid});
			expect(h.client.findChannel("#byhand")!.autoJoin).to.equal(true);
			const rough = h.client.findChannel("#rough")!;
			expect(rough.autoJoin).to.equal(false);
			expect(rough.state).to.equal(ChanState.PARTED);
			register(h, ALL_CAPS);
			const join = h.transport.sent.find((l) => l.startsWith("JOIN "))!;
			expect(join).to.include("#byhand");
			expect(join).to.not.include("#rough");
		});

		it("a closed channel is hidden and not joined; joined again, its lines are back and the walk starts from them", async function () {
			const uuid = savedNet("");
			const first = setup({uuid, join: ""});
			register(first, ALL_CAPS);
			first.transport.lines(
				"@time=2026-08-25T12:00:30.000Z;msgid=j1 :alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list.",
				said(1),
				said(2)
			);
			first.client.removeChannel(first.client.findChannel("#seance")!);
			await flushConversationStores();
			first.client.conversations.dispose();

			const h = setup({uuid, join: ""});
			expect(h.client.findChannel("#seance")).to.equal(undefined);
			register(h, ALL_CAPS);
			expect(h.transport.sent.filter((l) => l.startsWith("JOIN")).join()).to.not.include(
				"#seance"
			);
			h.sent();
			h.dispatch.resetHistory();

			// The user joins it again.
			h.transport.lines(
				"@time=2026-08-25T12:30:00.000Z;msgid=j2 :alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			const chan = h.client.findChannel("#seance")!;
			const page = h
				.payloads<{chan: number; messages: SharedMsg[]}>("more")
				.find((p) => p.chan === chan.id)!;
			expect(page.messages.map((m) => m.text).filter(Boolean)).to.deep.equal([
				"line 1",
				"line 2",
			]);
			const asked = h.sent();
			expect(asked.find((l) => l.includes("CHATHISTORY"))).to.match(
				/CHATHISTORY LATEST #seance \* 100$/
			);
			batch(h, [said(2), said(3)], {label: labelOf(asked)});
			expect(
				h
					.messages(chan.id)
					.map((m) => m.text)
					.filter(Boolean)
			).to.deep.equal(["line 3"]);
			await flushConversationStores();
			expect(
				new ConversationStore(uuid, (s) => s.toLowerCase()).windows().map((w) => w.name)
			).to.include("#seance");
		});

		it("a channel only this device remembers is left to a held session, and dropped after a refusal", async function () {
			const uuid = savedNet("#lobby");
			const first = setup({uuid, join: "#lobby"});
			register(first, ALL_CAPS);
			first.transport.lines(
				"@time=2026-08-25T12:00:30.000Z;msgid=j1 :alice!alice@host JOIN #byhand",
				":irc.test 366 alice #byhand :End of /NAMES list.",
				"@time=2026-08-25T12:00:40.000Z;msgid=j2 :alice!alice@host JOIN #locked",
				":irc.test 366 alice #locked :End of /NAMES list."
			);
			await flushConversationStores();
			first.client.conversations.dispose();

			// Nothing holds our channels: both are joined, and a refusal
			// ends it for the next load.
			const h = setup({uuid, join: "#lobby"});
			expect(h.client.findChannel("#byhand")!.fromStore).to.equal(true);
			register(h, ALL_CAPS);
			const joins = h.transport.sent.filter((l) => l.startsWith("JOIN")).join();
			expect(joins).to.include("#byhand");
			expect(joins).to.include("#locked");
			h.transport.line(":irc.test 475 alice #locked :Cannot join channel (+k)");
			await flushConversationStores();
			h.client.conversations.dispose();
			const again = new ConversationStore(uuid, (s) => s.toLowerCase());
			expect(again.meta("#locked")!.joined).to.equal(false);
			expect(again.meta("#byhand")!.joined).to.equal(true);
			again.dispose();

			// A held session: what it does not give back stays parted.
			const held = setup({uuid, join: "#lobby"});
			register(held, ALL_CAPS);
			held.sent();
			held.client.persistenceHold = true;
			held.client.autojoin();
			const later = held.sent().join();
			expect(later).to.include("#lobby");
			expect(later).to.not.include("#byhand");
		});

		it("a page that could not read the device marks the gap above its first page", async function () {
			const uuid = savedNet();
			await firstPage(uuid, [said(1), said(2)]);
			await preloadConversations();
			new ConversationStore(uuid, (s) => s.toLowerCase()).dispose(); // the share is gone

			const h = setup({uuid});
			expect(h.client.conversations.blind).to.equal(true);
			register(h, ALL_CAPS);
			h.transport.lines(
				"@time=2026-08-25T12:50:00.000Z;msgid=join-9 :alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			const asked = h.sent();
			h.dispatch.resetHistory();
			batch(h, [said(40), said(41)], {label: labelOf(asked)});
			const page = h.payloads<{messages: SharedMsg[]}>("more")[0];
			expect(page.messages.map((m) => [m.text, m.gapBefore])).to.deep.equal([
				["line 40", true],
				["line 41", undefined],
			]);
		});

		it("Clear history is not undone by a page load or a history page", async function () {
			const uuid = savedNet();
			const first = setup({uuid});
			const id = joined(first, ALL_CAPS);
			first.transport.lines(said(1), said(2));
			first.client.clearHistory(first.client.findChannel("#seance")!);
			first.transport.line(said(5));
			await flushConversationStores();
			first.client.conversations.dispose();
			void id;

			const h = setup({uuid});
			h.client.connect();
			const chan = h.client.findChannel("#seance")!;
			const page = h
				.payloads<{chan: number; messages: SharedMsg[]}>("more")
				.find((p) => p.chan === chan.id)!;
			expect(page.messages.map((m) => m.text)).to.deep.equal(["line 5"]);

			// "Show older" from the server: what was cleared is not brought back.
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${ALL_CAPS}`);
			const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
			h.transport.lines(
				`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`,
				":irc.test 001 alice :Welcome",
				":irc.test 005 alice CHANTYPES=#& CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server",
				":irc.test 422 alice :MOTD File is missing"
			);
			h.sent();
			h.dispatch.resetHistory();
			const firstId = page.messages[0].id;
			expect(requestMore(h.client, chan, firstId)).to.equal(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const asked = h.sent();
			expect(asked[0]).to.match(/CHATHISTORY BEFORE #seance/);
			batch(h, [said(1), said(2)], {label: labelOf(asked)});
			const more = h.payloads<{messages: SharedMsg[]; moreAvailable?: boolean}>("more");
			expect(more[more.length - 1].messages).to.deep.equal([]);
			expect(more[more.length - 1].moreAvailable).to.equal(false);
		});

		it("show older reads the device first, without a connection", async function () {
			const uuid = savedNet();
			const first = setup({uuid});
			joined(first, ALL_CAPS);
			const lines: string[] = [];

			for (let i = 1; i <= 150; i++) {
				lines.push(
					`@time=2026-08-25T13:00:00.${String(i).padStart(
						3,
						"0"
					)}Z;msgid=d${i} :bob!bob@host PRIVMSG #seance :d${i}`
				);
			}

			first.transport.lines(...lines);
			await flushConversationStores();
			first.client.conversations.dispose();

			const h = setup({uuid});
			h.client.connect();
			const chan = h.client.findChannel("#seance")!;
			const restored = h
				.payloads<{chan: number; messages: SharedMsg[]; device?: boolean}>("more")
				.find((p) => p.chan === chan.id)!;
			expect(restored.messages).to.have.length(100);
			expect(restored.messages[0].text).to.equal("d51");
			expect(restored.device).to.equal(true);

			h.dispatch.resetHistory();
			expect(requestMore(h.client, chan, restored.messages[0].id)).to.equal(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const older = h.payloads<{messages: SharedMsg[]; device?: boolean}>("more")[0];
			// The page's own JOIN line was kept too, as the oldest line there is.
			expect(older.messages[0].type).to.equal(MessageType.JOIN);
			expect(older.messages[1].text).to.equal("d1");
			expect(older.messages[older.messages.length - 1].text).to.equal("d50");
			expect(h.transport.sent).to.deep.equal([]);
		});
	});
});
