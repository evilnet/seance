import {expect} from "chai";
import sinon from "sinon";
import {ALL_CAPS, register, setup, type Harness} from "./support";
import {applyAvatarsEnabled, setOwnAvatar, SET_TIMEOUT_MS} from "../../client/js/irc/avatars";
import {avatarKnown, avatarOf} from "../../client/js/avatars/registry";
import {setAvatarsEnabled, useStorageBackend} from "../../client/js/avatars/prefs";
import {MUTE_READ_DELAY_MS} from "../../client/js/irc/muteRead";

const CAPS = `${ALL_CAPS} draft/metadata-2 extended-join account-notify account-tag`;
const URL_A = "https://files.example/alice.webp";
const URL_B = "https://pics.example.net/bob.webp";

describe("avatars on the wire (irc/avatars.ts)", function () {
	let h: Harness;

	beforeEach(function () {
		const data = new Map<string, string>();
		useStorageBackend({
			get: (key) => data.get(key) ?? null,
			set: (key, value) => void data.set(key, value),
			remove: (key) => void data.delete(key),
		});
		h = setup();
		register(h, CAPS);
		h.transport.lines(
			":alice!alice@host.example JOIN #seance alice :Alice",
			":irc.test 353 alice = #seance :@alice bob carol",
			":irc.test 366 alice #seance :End of /NAMES list."
		);
		h.sent();
		h.dispatch.resetHistory();
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	const uuid = () => h.client.uuid;

	it("records a value from the subscription", function () {
		h.transport.line(`:irc.test METADATA bob avatar * :${URL_B}`);
		expect(avatarOf(uuid(), "Bob")?.value).to.equal(URL_B);
		h.transport.line(":irc.test METADATA bob avatar *");
		expect(avatarOf(uuid(), "bob")?.value).to.equal("");
		expect(avatarKnown(uuid(), "bob")).to.equal(true);
	});

	it("ignores a private value and a channel's", function () {
		h.transport.line(`:irc.test METADATA bob avatar private :${URL_B}`);
		h.transport.line(`:irc.test METADATA #seance avatar * :${URL_B}`);
		expect(avatarKnown(uuid(), "bob")).to.equal(false);
		expect(avatarKnown(uuid(), "#seance")).to.equal(false);
	});

	it("asks once for the avatar of someone it has not heard about, and keeps the reply quiet", function () {
		h.transport.line(":bob!bob@host.example PRIVMSG #seance :hi");
		expect(h.sent()).to.deep.equal(["METADATA bob GET avatar"]);
		h.transport.line(":bob!bob@host.example PRIVMSG #seance :again");
		expect(h.sent()).to.deep.equal([]);
		const before = h.messages().length;
		h.transport.line(`:irc.test 761 alice bob avatar * :${URL_B}`);
		expect(h.messages().length).to.equal(before);
		expect(avatarOf(uuid(), "bob")?.value).to.equal(URL_B);
	});

	it("keeps a 766 for its own GET quiet too", function () {
		h.transport.line(":carol!carol@host.example PRIVMSG #seance :hi");
		expect(h.sent()).to.deep.equal(["METADATA carol GET avatar"]);
		const before = h.messages().length;
		h.transport.line(":irc.test 766 alice carol avatar :key not set");
		expect(h.messages().length).to.equal(before);
		expect(avatarKnown(uuid(), "carol")).to.equal(true);
	});

	it("does not ask about a nick whose avatar the burst already gave", function () {
		h.transport.line(`:irc.test METADATA bob avatar * :${URL_B}`);
		h.transport.line(":bob!bob@host.example PRIVMSG #seance :hi");
		expect(h.sent()).to.deep.equal([]);
	});

	it("does not ask about servers or itself", function () {
		h.transport.line(":irc.test NOTICE #seance :maintenance");
		h.transport.line(":alice!alice@host.example PRIVMSG #seance :me");
		expect(h.sent()).to.deep.equal([]);
	});

	it("shows a user's own /metadata reply about someone else", function () {
		const before = h.messages().length;
		h.transport.line(`:irc.test 761 alice bob avatar * :${URL_B}`);
		expect(h.messages().length).to.be.greaterThan(before);
	});

	it("notes accounts from the account tag, extended-join and account-notify", function () {
		h.transport.line("@account=bobacct :bob!bob@host.example PRIVMSG #seance :hi");
		expect(avatarOf(uuid(), "bob")?.account).to.equal("bobacct");
		h.transport.line(":bob!bob@host.example PRIVMSG #seance :logged out");
		expect(avatarOf(uuid(), "bob")?.account).to.equal(null);
		h.transport.line(":dave!dave@host.example JOIN #seance daveacct :Dave");
		expect(avatarOf(uuid(), "dave")?.account).to.equal("daveacct");
		h.transport.line(":dave!dave@host.example ACCOUNT *");
		expect(avatarOf(uuid(), "dave")?.account).to.equal(null);
	});

	it("follows a nick change and forgets a user who quits", function () {
		h.transport.line(`:irc.test METADATA bob avatar * :${URL_B}`);
		h.transport.line(":bob!bob@host.example NICK robert");
		expect(avatarKnown(uuid(), "bob")).to.equal(false);
		expect(avatarOf(uuid(), "robert")?.value).to.equal(URL_B);
		h.transport.line(":robert!bob@host.example QUIT :bye");
		expect(avatarKnown(uuid(), "robert")).to.equal(false);
	});

	it("forgets a user who parts the only shared channel", function () {
		h.transport.line(`:irc.test METADATA carol avatar * :${URL_B}`);
		h.transport.line(":carol!carol@host.example PART #seance");
		expect(avatarKnown(uuid(), "carol")).to.equal(false);
	});

	describe("from history", function () {
		const replay = (...lines: string[]) =>
			h.transport.lines(
				":irc.test BATCH +h chathistory #seance",
				...lines.map(
					(line, i) => `@batch=h;time=2026-11-25T07:0${i}:00.000Z;msgid=o${i} ${line}`
				),
				":irc.test BATCH -h"
			);

		it("asks for the avatar of a replayed line's sender who is still in the channel, once", function () {
			replay(
				":bob!bob@host.example PRIVMSG #seance :from before",
				":bob!bob@host.example PRIVMSG #seance :\u0001ACTION waves\u0001"
			);
			expect(h.sent()).to.deep.equal(["METADATA bob GET avatar"]);
			h.transport.line(":bob!bob@host.example PRIVMSG #seance :and now");
			expect(h.sent()).to.deep.equal([]);
		});

		it("does not ask about someone who has left, nor about ourselves", function () {
			replay(
				":dave!dave@host.example PRIVMSG #seance :gone since",
				":alice!alice@host.example PRIVMSG #seance :mine"
			);
			expect(h.sent()).to.deep.equal([]);
		});

		it("does not ask about a member whose avatar the burst already gave", function () {
			h.transport.line(`:irc.test METADATA carol avatar * :${URL_A}`);
			replay(":carol!carol@host.example PRIVMSG #seance :from before");
			expect(h.sent()).to.deep.equal([]);
		});

		it("asks for the senders of the lines the device kept, at the end of the member list", function () {
			const restored = sinon.stub(h.client.conversations, "restoredMessages").returns([
				{type: "message", from: {nick: "bob", mode: ""}, text: "kept"},
				{type: "action", from: {nick: "carol", mode: ""}, text: "waves"},
				{type: "join", from: {nick: "carol", mode: ""}, text: ""},
				{type: "message", from: {nick: "dave", mode: ""}, text: "left since"},
				{type: "message", from: {nick: "alice", mode: ""}, self: true, text: "mine"},
			] as ReturnType<typeof h.client.conversations.restoredMessages>);

			try {
				h.transport.lines(
					":irc.test 353 alice = #seance :@alice bob carol",
					":irc.test 366 alice #seance :End of /NAMES list."
				);
				expect(h.sent()).to.deep.equal([
					"METADATA bob GET avatar",
					"METADATA carol GET avatar",
				]);
			} finally {
				restored.restore();
			}
		});

		const restoration = (...inside: string[]) =>
			h.transport.lines(
				":irc.test BATCH +p1 draft/persistence",
				...inside.map((line) => `@batch=p1 ${line}`),
				":irc.test BATCH -p1"
			);

		it("asks a held session's restored channel for all its members' avatars with one SYNC", function () {
			restoration(
				":irc.test 353 alice = #seance :@alice bob carol",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			expect(h.sent()).to.deep.equal(["METADATA #seance SYNC"]);

			// The answer: a metadata batch of the members' values.
			h.transport.lines(
				":irc.test BATCH +m metadata",
				`@batch=m :irc.test METADATA bob avatar * :${URL_B}`,
				":irc.test BATCH -m"
			);
			expect(avatarOf(uuid(), "bob")?.value).to.equal(URL_B);

			// Its members are covered: their lines from history ask nothing more,
			// and a second restoration of the channel does not SYNC again.
			replay(
				":bob!bob@host.example PRIVMSG #seance :from before",
				":carol!carol@host.example PRIVMSG #seance :me too"
			);
			restoration(
				":irc.test 353 alice = #seance :@alice bob carol",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			expect(h.sent()).to.deep.equal([]);
		});

		it("sends no SYNC after an ordinary join's NAMES, whose burst says the values", function () {
			h.transport.lines(
				":irc.test 353 alice = #seance :@alice bob carol",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			expect(h.sent().filter((l) => l.includes("SYNC"))).to.deep.equal([]);
		});

		it("sends no SYNC where avatars are switched off", function () {
			setAvatarsEnabled(uuid(), false);
			restoration(
				":irc.test 353 alice = #seance :@alice bob carol",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			expect(h.sent().filter((l) => l.includes("SYNC"))).to.deep.equal([]);
		});

		it("asks nothing from history where avatars are switched off", function () {
			setAvatarsEnabled(uuid(), false);
			replay(":bob!bob@host.example PRIVMSG #seance :from before");
			expect(h.sent()).to.deep.equal([]);
		});
	});

	it("asks nothing where avatars are switched off", function () {
		setAvatarsEnabled(uuid(), false);
		h.transport.line(":bob!bob@host.example PRIVMSG #seance :hi");
		expect(h.sent()).to.deep.equal([]);
	});

	describe("own avatar", function () {
		it("resolves when the server confirms the SET", async function () {
			const done = setOwnAvatar(h.client, URL_A);
			expect(h.sent()).to.deep.equal([`METADATA * SET avatar :${URL_A}`]);
			const before = h.messages().length;
			h.transport.line(`:irc.test 761 alice alice avatar * :${URL_A}`);
			await done;
			expect(h.messages().length).to.equal(before);
			expect(avatarOf(uuid(), "alice")?.value).to.equal(URL_A);
		});

		it("clears with a bare SET and resolves on 766", async function () {
			const done = setOwnAvatar(h.client, "");
			expect(h.sent()).to.deep.equal(["METADATA * SET avatar"]);
			h.transport.line(":irc.test 766 alice alice avatar :key not set");
			await done;
			expect(avatarOf(uuid(), "alice")?.value).to.equal("");
		});

		it("rejects with the server's reason on a FAIL, which is not shown", async function () {
			const done = setOwnAvatar(h.client, URL_A);
			const before = h.messages().length;
			h.transport.line(":irc.test FAIL METADATA VALUE_INVALID avatar :Value is too long");
			let reason = "";

			try {
				await done;
			} catch (err) {
				reason = (err as Error).message;
			}

			expect(reason).to.equal("Value is too long");
			expect(h.messages().length).to.equal(before);
		});

		it("rejects when the connection closes or the server never answers", async function () {
			const closed = setOwnAvatar(h.client, URL_A);
			h.transport.closed();
			let reason = "";

			try {
				await closed;
			} catch (err) {
				reason = (err as Error).message;
			}

			expect(reason).to.equal("closed");

			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const g = setup();
				register(g, CAPS);
				const late = setOwnAvatar(g.client, URL_A);
				clock.tick(SET_TIMEOUT_MS);
				let why = "";

				try {
					await late;
				} catch (err) {
					why = (err as Error).message;
				}

				expect(why).to.equal("timeout");
			} finally {
				clock.restore();
			}
		});

		it("refuses before 001 or without metadata-2", async function () {
			const g = setup();
			register(g, ALL_CAPS);
			let reason = "";

			try {
				await setOwnAvatar(g.client, URL_A);
			} catch (err) {
				reason = (err as Error).message;
			}

			expect(reason).to.equal("unavailable");
		});
	});

	describe("subscribed after the autojoin", function () {
		it("SYNCs each joined channel when a connection without an account subscribes 10 s in", function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});

			try {
				const g = setup();
				register(g, CAPS);
				g.transport.lines(
					":alice!alice@host.example JOIN #seance alice :Alice",
					":irc.test 353 alice = #seance :@alice bob carol",
					":irc.test 366 alice #seance :End of /NAMES list."
				);
				g.sent();
				clock.tick(MUTE_READ_DELAY_MS);
				clock.tick(10_000); // the background queue's turn
				const sent = g.sent();
				expect(sent).to.include("METADATA * SUB avatar");
				expect(sent).to.include("METADATA #seance SYNC");
				expect(sent.indexOf("METADATA #seance SYNC")).to.be.above(
					sent.indexOf("METADATA * SUB avatar")
				);
			} finally {
				clock.restore();
			}
		});
	});

	describe("switching avatars on and off", function () {
		it("unsubscribes and forgets when off, subscribes, reads its own and SYNCs its channels when on", function () {
			h.transport.line(`:irc.test METADATA bob avatar * :${URL_B}`);
			applyAvatarsEnabled(h.client, false);
			expect(h.sent()).to.deep.equal(["METADATA * UNSUB avatar"]);
			expect(avatarKnown(uuid(), "bob")).to.equal(false);
			applyAvatarsEnabled(h.client, true);
			expect(h.sent()).to.deep.equal([
				"METADATA * SUB avatar",
				"METADATA * GET avatar",
				"METADATA #seance SYNC",
			]);
			const before = h.messages().length;
			h.transport.line(":irc.test 766 alice alice avatar :key not set");
			expect(h.messages().length).to.equal(before);
		});
	});
});
