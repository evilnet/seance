import {expect} from "chai";
import sinon from "sinon";
import {ALL_CAPS, register, setup, type Harness} from "./support";
import {
	applyAvatarsEnabled,
	AvatarSetError,
	canSetChannelAvatar,
	setChannelAvatar,
	setOwnAvatar,
	SET_TIMEOUT_MS,
} from "../../client/js/irc/avatars";
import {
	avatarKnown,
	avatarOf,
	markAvatarsStale,
	setAvatarValue,
} from "../../client/js/avatars/registry";
import {setAvatarsEnabled, useStorageBackend} from "../../client/js/avatars/prefs";
import {dispatchInput} from "../../client/js/irc/commands";
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

	it("ignores a private value", function () {
		h.transport.line(`:irc.test METADATA bob avatar private :${URL_B}`);
		h.transport.line(`:irc.test METADATA #seance avatar private :${URL_B}`);
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

	it("shows that reply where the user is", function () {
		h.transport.line(`:irc.test 761 alice bob avatar * :${URL_B}`);
		expect(h.lastMessage().showInActive).to.equal(true);
	});

	it("shows a reply about its own avatar that it did not ask for in the server window only", function () {
		h.transport.line(`:irc.test 761 alice alice avatar * :${URL_A}`);
		const before = h.messages().length;
		// Another device of the account read its own avatar: this one hears it.
		h.transport.line(`:irc.test 761 alice alice avatar * :${URL_A}`);

		expect(h.messages().length).to.equal(before + 1);
		expect(h.lastMessage().showInActive).to.equal(false);
		expect(h.lastMessage().text).to.include(URL_A);
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

	describe("a channel's avatar", function () {
		const URL_C = "https://files.example/seance.webp";
		const chanId = (name: string) => h.client.findChannel(name)!.id;
		/** What went out about metadata (a join also asks its history, opening it its modes). */
		const sentMetadata = () => h.sent().filter((line) => line.startsWith("METADATA"));

		/** Join `chan`; `burst` lines go between the JOIN and the NAMES. */
		function join(chan: string, burst: string[] = [], names = "@alice bob") {
			h.transport.lines(
				`:alice!alice@host.example JOIN ${chan} alice :Alice`,
				...burst,
				`:irc.test 353 alice = ${chan} :${names}`,
				`:irc.test 366 alice ${chan} :End of /NAMES list.`
			);
		}

		it("takes the value the join burst and later changes carry", function () {
			join("#art", [`:irc.test METADATA #art avatar * :${URL_C}`]);
			expect(avatarOf(uuid(), "#ART")?.value).to.equal(URL_C);
			expect(avatarKnown(uuid(), "#art")).to.equal(true);
			h.transport.line(":irc.test METADATA #art avatar *");
			expect(avatarOf(uuid(), "#art")?.value).to.equal("");
			expect(sentMetadata()).to.deep.equal([]);
		});

		it("asks, quietly, for a picture known from before that the burst did not repeat", function () {
			setAvatarValue(uuid(), "#old", URL_C);
			markAvatarsStale(uuid()); // as a new connection's 001 does
			join("#old");
			expect(sentMetadata()).to.deep.equal(["METADATA #old GET avatar"]);
			const before = h.messages().length;
			h.transport.line(":irc.test 766 alice #old avatar :key not set");
			expect(h.messages().length).to.equal(before);
			expect(avatarOf(uuid(), "#old")?.value).to.equal("");
			expect(avatarKnown(uuid(), "#old")).to.equal(true);
		});

		it("keeps quiet the answer to a GET sent before the burst said it", function () {
			// A logged-in user hears the channel's metadata after the NAMES; a
			// picture known from before is asked at the 366 all the same.
			setAvatarValue(uuid(), "#old", URL_C);
			markAvatarsStale(uuid());
			join("#old");
			expect(sentMetadata()).to.deep.equal(["METADATA #old GET avatar"]);
			h.transport.line(`:irc.test METADATA #old avatar * :${URL_A}`);
			const before = h.messages().length;
			h.transport.line(`:irc.test 761 alice #old avatar * :${URL_A}`);
			expect(h.messages().length).to.equal(before);
			expect(avatarOf(uuid(), "#old")?.value).to.equal(URL_A);
		});

		it("asks nothing when the burst said it, or nothing was known", function () {
			setAvatarValue(uuid(), "#said", URL_C);
			markAvatarsStale(uuid());
			join("#said", [`:irc.test METADATA #said avatar * :${URL_C}`]);
			join("#plain");
			expect(sentMetadata()).to.deep.equal([]);
		});

		it("asks once when a channel is opened without one known", function () {
			join("#plain");
			h.client.open(chanId("#plain"));
			expect(sentMetadata()).to.deep.equal(["METADATA #plain GET avatar"]);
			h.transport.line(`:irc.test 761 alice #plain avatar * :${URL_C}`);
			expect(avatarOf(uuid(), "#plain")?.value).to.equal(URL_C);
			h.client.open(0);
			h.client.open(chanId("#plain"));
			expect(sentMetadata()).to.deep.equal([]);
		});

		it("forgets it when we leave the channel", function () {
			join("#art", [`:irc.test METADATA #art avatar * :${URL_C}`]);
			h.transport.line(":alice!alice@host.example PART #art");
			expect(avatarOf(uuid(), "#art")).to.equal(undefined);
		});

		it("takes a restored channel's own avatar from the SYNC's answer", function () {
			h.transport.lines(
				":irc.test BATCH +p1 draft/persistence",
				"@batch=p1 :alice!alice@host.example JOIN #held alice :Alice",
				"@batch=p1 :irc.test 353 alice = #held :@alice bob",
				"@batch=p1 :irc.test 366 alice #held :End of /NAMES list.",
				":irc.test BATCH -p1"
			);
			expect(sentMetadata()).to.deep.equal(["METADATA #held SYNC"]);
			h.transport.lines(
				":irc.test BATCH +m metadata",
				`@batch=m :irc.test METADATA #held avatar * :${URL_C}`,
				`@batch=m :irc.test METADATA bob avatar * :${URL_B}`,
				":irc.test BATCH -m"
			);
			expect(avatarOf(uuid(), "#held")?.value).to.equal(URL_C);
			expect(avatarKnown(uuid(), "#held")).to.equal(true);
		});

		it("SYNCs again, once avatars are back on, a channel it had SYNCed", function () {
			h.transport.lines(
				":irc.test BATCH +p1 draft/persistence",
				"@batch=p1 :irc.test 353 alice = #seance :@alice bob",
				"@batch=p1 :irc.test 366 alice #seance :End of /NAMES list.",
				":irc.test BATCH -p1"
			);
			expect(sentMetadata()).to.deep.equal(["METADATA #seance SYNC"]);
			setAvatarsEnabled(uuid(), false);
			applyAvatarsEnabled(h.client, false);
			setAvatarsEnabled(uuid(), true);
			applyAvatarsEnabled(h.client, true);
			expect(sentMetadata()).to.include("METADATA #seance SYNC");
		});

		it("keeps drawing it once we are kicked, and asks again on the rejoin", function () {
			join("#art", [`:irc.test METADATA #art avatar * :${URL_C}`]);
			h.transport.line(":bob!bob@host.example KICK #art alice :out");
			expect(avatarOf(uuid(), "#art")?.value).to.equal(URL_C);
			expect(avatarKnown(uuid(), "#art")).to.equal(false);
			h.sent();
			join("#art");
			expect(sentMetadata()).to.deep.equal(["METADATA #art GET avatar"]);
			h.transport.line(":irc.test 766 alice #art avatar :key not set");
			expect(avatarOf(uuid(), "#art")?.value).to.equal("");
		});

		it("is asked of nobody where avatars are switched off", function () {
			setAvatarsEnabled(uuid(), false);
			join("#plain");
			h.client.open(chanId("#plain"));
			expect(sentMetadata()).to.deep.equal([]);
		});

		it("is ours to set as a half-op and up, or an IRC operator", function () {
			const g = setup();
			register(g, CAPS, [
				":irc.test 005 alice PREFIX=(ohv)@%+ :are supported by this server",
			]);
			g.transport.lines(
				":alice!alice@host.example JOIN #half alice :Alice",
				":irc.test 353 alice = #half :%alice",
				":irc.test 366 alice #half :End of /NAMES list.",
				":alice!alice@host.example JOIN #voiced alice :Alice",
				":irc.test 353 alice = #voiced :+alice @bob",
				":irc.test 366 alice #voiced :End of /NAMES list."
			);
			expect(canSetChannelAvatar(g.client, "#half")).to.equal(true);
			expect(canSetChannelAvatar(g.client, "#voiced")).to.equal(false);
			expect(canSetChannelAvatar(g.client, "#nowhere")).to.equal(false);
			// A local operator is refused; a global one in the channel is not.
			g.transport.line(":alice MODE alice :+O");
			expect(canSetChannelAvatar(g.client, "#voiced")).to.equal(false);
			g.transport.line(":alice MODE alice :-O+o");
			expect(canSetChannelAvatar(g.client, "#voiced")).to.equal(true);
			// Only as a member, oper or not.
			expect(canSetChannelAvatar(g.client, "#nowhere")).to.equal(false);
			g.transport.line(":bob!bob@host.example KICK #voiced alice :out");
			expect(canSetChannelAvatar(g.client, "#voiced")).to.equal(false);
			expect(canSetChannelAvatar(h.client, "#seance")).to.equal(true); // @alice, no half-ops
		});

		it("resolves a SET on the 761, which is not shown", async function () {
			const done = setChannelAvatar(h.client, "#seance", URL_C);
			expect(h.sent()).to.deep.equal([`METADATA #seance SET avatar :${URL_C}`]);
			const before = h.messages().length;
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
			h.transport.line(`:irc.test METADATA #seance avatar * :${URL_C}`);
			await done;
			expect(h.messages().length).to.equal(before);
			expect(avatarOf(uuid(), "#seance")?.value).to.equal(URL_C);
		});

		it("clears with a bare SET and resolves on 766", async function () {
			const done = setChannelAvatar(h.client, "#seance", "");
			expect(h.sent()).to.deep.equal(["METADATA #seance SET avatar"]);
			h.transport.line(":irc.test 766 alice #seance avatar :key not set");
			await done;
			expect(avatarOf(uuid(), "#seance")?.value).to.equal("");
		});

		it("does not take our own avatar's reply for the channel's", async function () {
			const done = setChannelAvatar(h.client, "#seance", URL_A);
			let settled = false;
			void done.then(() => (settled = true));
			h.transport.line(`:irc.test METADATA alice avatar * :${URL_A}`);
			await Promise.resolve();
			expect(settled).to.equal(false);
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_A}`);
			await done;
		});

		for (const [label, fail, code] of [
			[
				"refused",
				":irc.test FAIL METADATA KEY_NO_PERMISSION #seance avatar :You don't have permission to set metadata on this target",
				"KEY_NO_PERMISSION",
			],
			[
				"on a channel we cannot see",
				":irc.test FAIL METADATA INVALID_TARGET #seance :Invalid target",
				"INVALID_TARGET",
			],
		] as const) {
			it(`rejects with the server's reason and code when ${label}, which is not shown`, async function () {
				const done = setChannelAvatar(h.client, "#seance", URL_C);
				const before = h.messages().length;
				h.transport.line(fail);
				let error: unknown;

				try {
					await done;
				} catch (err) {
					error = err;
				}

				expect(error).to.be.instanceOf(AvatarSetError);
				expect((error as AvatarSetError).message).to.equal(
					fail.slice(fail.lastIndexOf(":") + 1)
				);
				expect((error as AvatarSetError).code).to.equal(code);
				expect(h.messages().length).to.equal(before);
			});
		}

		const codeOf = async (p: Promise<void>) => {
			try {
				await p;
				return "resolved";
			} catch (err) {
				return (err as AvatarSetError).code;
			}
		};

		it("settles two SETs in flight each by its own answer", async function () {
			const first = setChannelAvatar(h.client, "#seance", URL_C);
			const upkeep = setChannelAvatar(h.client, "#seance", URL_A);
			const own = setOwnAvatar(h.client, URL_B);
			h.transport.lines(
				`:irc.test 761 alice #seance avatar * :${URL_C}`,
				`:irc.test 761 alice alice avatar * :${URL_B}`,
				":irc.test FAIL METADATA KEY_NO_PERMISSION #seance avatar :You don't have permission"
			);
			expect(await codeOf(first)).to.equal("resolved");
			expect(await codeOf(own)).to.equal("resolved");
			expect(await codeOf(upkeep)).to.equal("KEY_NO_PERMISSION");
		});

		it("says why when the connection closed or it was not connected", async function () {
			const pending = setChannelAvatar(h.client, "#seance", URL_A);
			h.transport.closed();
			expect(await codeOf(pending)).to.equal("closed");
			expect(await codeOf(setChannelAvatar(h.client, "#seance", URL_C))).to.equal(
				"unavailable"
			);
		});

		it("keeps quiet an answer that comes after the timeout", async function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const late = setChannelAvatar(h.client, "#seance", URL_C);
				clock.tick(SET_TIMEOUT_MS);
				expect(await codeOf(late)).to.equal("timeout");
				const before = h.messages().length;
				h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
				expect(h.messages().length).to.equal(before);
				expect(avatarOf(uuid(), "#seance")?.value).to.equal(URL_C);
			} finally {
				clock.restore();
			}
		});

		it("is not settled by another op's change to the same picture", async function () {
			const done = setChannelAvatar(h.client, "#seance", URL_C);
			h.transport.line(`:irc.test METADATA #seance avatar * :${URL_C}`);
			h.transport.line(
				":irc.test FAIL METADATA KEY_NO_PERMISSION #seance avatar :You don't have permission"
			);
			expect(await codeOf(done)).to.equal("KEY_NO_PERMISSION");
		});

		it("is not settled by a FAIL about another target, which is shown", async function () {
			const done = setChannelAvatar(h.client, "#seance", URL_C);
			let settled = false;
			void done.then(() => (settled = true));
			const before = h.messages().length;
			h.transport.line(
				":irc.test FAIL METADATA KEY_NO_PERMISSION #other avatar :You don't have permission"
			);
			await Promise.resolve();
			expect(settled).to.equal(false);
			expect(h.messages().length).to.be.greaterThan(before);
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
			expect(await codeOf(done)).to.equal("resolved");
		});

		it("gives a SET and a GET of one channel each its own INVALID_TARGET", async function () {
			join("#gone");
			const done = setChannelAvatar(h.client, "#gone", URL_C);
			h.client.open(chanId("#gone"));
			expect(sentMetadata()).to.deep.equal([
				`METADATA #gone SET avatar :${URL_C}`,
				"METADATA #gone GET avatar",
			]);
			const before = h.messages().length;
			// The SET's, first: not the GET's to swallow.
			h.transport.line(":irc.test FAIL METADATA INVALID_TARGET #gone :Invalid target");
			expect(await codeOf(done)).to.equal("INVALID_TARGET");
			h.transport.line(":irc.test FAIL METADATA INVALID_TARGET #gone :Invalid target");
			expect(h.messages().length).to.equal(before);
		});

		it("shows the user's own /metadata, sent before a SET of the channel, and settles the SET on its own answer", async function () {
			const chan = h.client.findChannel("#seance")!;
			dispatchInput(h.client, chan, "/metadata #seance get avatar");
			expect(h.sent()).to.deep.equal(["metadata #seance get avatar"]);
			const done = setChannelAvatar(h.client, "#seance", URL_C);
			let settled = false;
			void done.then(() => (settled = true));
			const before = h.messages().length;
			h.transport.line(":irc.test 766 alice #seance avatar :key not set");
			await Promise.resolve();
			expect(settled).to.equal(false);
			expect(h.messages().length).to.be.greaterThan(before);
			const shown = h.messages().length;
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
			expect(await codeOf(done)).to.equal("resolved");
			expect(h.messages().length).to.equal(shown);
		});

		it("is not settled by another device's answer, which says another value", async function () {
			// A shared session hears the answers to the account's other devices.
			const done = setChannelAvatar(h.client, "#seance", URL_C);
			let settled = false;
			void done.then(() => (settled = true));
			const before = h.messages().length;
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_A}`);
			await Promise.resolve();
			expect(settled).to.equal(false);
			expect(h.messages().length).to.be.greaterThan(before);
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
			expect(await codeOf(done)).to.equal("resolved");
		});

		it("puts a FAIL naming no target on the oldest SET", async function () {
			const own = setOwnAvatar(h.client, URL_A);
			const chan = setChannelAvatar(h.client, "#seance", URL_C);
			h.transport.line(":irc.test FAIL METADATA VALUE_INVALID :value is too long");
			expect(await codeOf(own)).to.equal("VALUE_INVALID");
			h.transport.line(`:irc.test 761 alice #seance avatar * :${URL_C}`);
			expect(await codeOf(chan)).to.equal("resolved");
		});

		it("fails at once, not at the timeout, when the line could not be sent", async function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				// The transport refuses a line over its limit while open.
				sinon.stub(h.transport, "send").throws(new RangeError("line is 600 bytes"));
				let code = "";

				await setChannelAvatar(h.client, "#seance", URL_C).catch((err: unknown) => {
					code = (err as AvatarSetError).code;
				});
				expect(code).to.equal("unsent");
				expect(clock.countTimers()).to.equal(0);
			} finally {
				clock.restore();
			}
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

		it("asks again, once back on, for what it had asked before", function () {
			h.transport.line(":bob!bob@host.example PRIVMSG #seance :hi");
			expect(h.sent()).to.deep.equal(["METADATA bob GET avatar"]);
			h.transport.line(`:irc.test 761 alice bob avatar * :${URL_B}`);
			setAvatarsEnabled(uuid(), false);
			applyAvatarsEnabled(h.client, false);
			setAvatarsEnabled(uuid(), true);
			applyAvatarsEnabled(h.client, true);
			h.sent();
			h.transport.line(":bob!bob@host.example PRIVMSG #seance :back");
			expect(h.sent()).to.deep.equal(["METADATA bob GET avatar"]);
		});
	});
});
