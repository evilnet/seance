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
			g.transport.line(":alice MODE alice :+o");
			expect(canSetChannelAvatar(g.client, "#voiced")).to.equal(true);
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

		it("says why when no answer came, the connection closed or a newer change took over", async function () {
			const codeOf = async (p: Promise<void>) => {
				try {
					await p;
					return "resolved";
				} catch (err) {
					return (err as AvatarSetError).code;
				}
			};

			const first = setChannelAvatar(h.client, "#seance", URL_C);
			const second = setChannelAvatar(h.client, "#seance", URL_A);
			expect(await codeOf(first)).to.equal("superseded");
			h.transport.closed();
			expect(await codeOf(second)).to.equal("closed");
			expect(await codeOf(setChannelAvatar(h.client, "#seance", URL_C))).to.equal(
				"unavailable"
			);
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

	describe("switching avatars on and off", function () {
		it("unsubscribes and forgets when off, subscribes and reads its own when on", function () {
			h.transport.line(`:irc.test METADATA bob avatar * :${URL_B}`);
			applyAvatarsEnabled(h.client, false);
			expect(h.sent()).to.deep.equal(["METADATA * UNSUB avatar"]);
			expect(avatarKnown(uuid(), "bob")).to.equal(false);
			applyAvatarsEnabled(h.client, true);
			expect(h.sent()).to.deep.equal(["METADATA * SUB avatar", "METADATA * GET avatar"]);
			const before = h.messages().length;
			h.transport.line(":irc.test 766 alice alice avatar :key not set");
			expect(h.messages().length).to.equal(before);
		});
	});
});
