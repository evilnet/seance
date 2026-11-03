import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ignoreListFor} from "../../client/js/ignore";
import {TYPING_INTERVAL_MS} from "../../client/js/irc/wire";
import type {TypingState} from "../../shared/types/msg";
import {ALL_CAPS, batch, joined, setup, stubStorage} from "./support";

interface TypingPayload {
	chan: number;
	nick: string;
	state: TypingState;
}

const NO_ECHO = ALL_CAPS.replace("echo-message ", "");

describe("Typing notifications (+typing, bus-contract §1.5)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		stubStorage();
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:00:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		socket.removeAllListeners();
	});

	/** A joined client and its #seance channel. */
	function inChannel(caps = ALL_CAPS) {
		const h = setup();
		const id = joined(h, caps);
		return {h, id, chan: h.client.channelById(id)!};
	}

	describe("outbound throttle (IrcClient.typing)", function () {
		it("sends the first active at once and re-sends it only after 3 s", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);

			clock.tick(1000);
			h.client.typing(chan, "active");
			clock.tick(1999);
			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal([]); // within 3 s: dropped, nothing scheduled

			clock.tick(1);
			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
		});

		it("delays a paused reported within 3 s to exactly 3 s after the last send", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "active");
			clock.tick(1000);
			h.client.typing(chan, "paused");
			h.sent();
			clock.tick(1999);
			expect(h.sent()).to.deep.equal([]);
			clock.tick(1);
			expect(h.sent()).to.deep.equal(["@+typing=paused TAGMSG #seance"]);

			// Once paused is out, a second paused is not a transition.
			clock.tick(TYPING_INTERVAL_MS);
			h.client.typing(chan, "paused");
			expect(h.sent()).to.deep.equal([]);
		});

		it("sends paused and done at once when the last send is 3 s old", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "active");
			clock.tick(TYPING_INTERVAL_MS);
			h.client.typing(chan, "paused");
			clock.tick(TYPING_INTERVAL_MS);
			h.client.typing(chan, "done");
			expect(h.sent()).to.deep.equal([
				"@+typing=active TAGMSG #seance",
				"@+typing=paused TAGMSG #seance",
				"@+typing=done TAGMSG #seance",
			]);
		});

		it("lets a done replace a scheduled paused", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "active");
			clock.tick(500);
			h.client.typing(chan, "paused");
			clock.tick(500);
			h.client.typing(chan, "done");
			h.sent();
			clock.tick(2000);
			expect(h.sent()).to.deep.equal(["@+typing=done TAGMSG #seance"]);

			// The session is over: a new active goes out at once.
			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
		});

		it("lets a later active cancel a scheduled paused/done", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "active");
			clock.tick(1000);
			h.client.typing(chan, "done");
			clock.tick(1000);
			h.client.typing(chan, "active"); // 2 s after the last send: dropped
			h.sent();
			clock.tick(5000);
			expect(h.sent()).to.deep.equal([]);

			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
		});

		it("drops paused/done when nothing was announced, and done after done", function () {
			const {h, chan} = inChannel();

			h.client.typing(chan, "done");
			h.client.typing(chan, "paused");
			clock.tick(10000);
			expect(h.sent()).to.deep.equal([]);

			h.client.typing(chan, "active");
			clock.tick(TYPING_INTERVAL_MS);
			h.client.typing(chan, "done");
			h.client.typing(chan, "done");
			clock.tick(TYPING_INTERVAL_MS);
			h.client.typing(chan, "done");
			expect(h.sent()).to.deep.equal([
				"@+typing=active TAGMSG #seance",
				"@+typing=done TAGMSG #seance",
			]);
		});

		it("resets the session when a message goes to the target (no done)", function () {
			const {h, id, chan} = inChannel();

			h.client.typing(chan, "active");
			clock.tick(1000);
			h.client.typing(chan, "paused");
			h.client.input(id, "hello");
			clock.tick(5000);
			expect(h.sent()).to.deep.equal([
				"@+typing=active TAGMSG #seance",
				"@label=s1 PRIVMSG #seance :hello",
			]);

			// A fresh session: active is not held back by the earlier send.
			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
		});

		it("keeps sessions per target", function () {
			const {h, chan} = inChannel();
			h.transport.line("@msgid=p1 :carol!carol@host PRIVMSG alice :psst");
			const query = h.client.findChannel("carol")!;

			h.client.typing(chan, "active");
			h.client.typing(query, "active");
			clock.tick(1000);
			h.client.typing(chan, "paused");
			h.client.input(query.id, "yes?");
			h.client.typing(query, "active");
			h.sent();
			clock.tick(2000);
			expect(h.sent()).to.deep.equal(["@+typing=paused TAGMSG #seance"]);
		});

		it("sends nothing to the lobby, without message-tags, or when disconnected", function () {
			const lobby = inChannel();
			lobby.h.client.typing(lobby.h.client.lobby, "active");
			expect(lobby.h.sent()).to.deep.equal([]);

			const noTags = inChannel(ALL_CAPS.replace("message-tags ", ""));
			noTags.h.client.typing(noTags.chan, "active");
			expect(noTags.h.sent()).to.deep.equal([]);

			const {h, chan} = inChannel();
			h.client.typing(chan, "active");
			clock.tick(1000);
			h.client.typing(chan, "paused"); // scheduled, then dropped with the connection
			h.transport.closed();
			h.dispatch.resetHistory();
			clock.tick(5000);
			h.client.typing(chan, "active");
			expect(h.transport.sent.filter((l) => l.includes("typing"))).to.deep.equal([
				"@+typing=active TAGMSG #seance",
			]);
			expect(h.payloads("msg")).to.have.length(0); // no "not connected" error from a late timer
		});

		it("does not report our own typing back to the UI without echo-message", function () {
			const {h, chan} = inChannel(NO_ECHO);

			h.client.typing(chan, "active");
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
			expect(h.payloads("typing")).to.have.length(0);
		});

		it("routes the typing bus emit to the owning client", function () {
			const {h, id} = inChannel();
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});

			socket.emit("typing", {target: id, state: "active"});
			socket.emit("typing", {target: 999, state: "active"});
			expect(h.sent()).to.deep.equal(["@+typing=active TAGMSG #seance"]);
		});
	});

	describe("inbound +typing (handlers/tagmsg.ts)", function () {
		it("dispatches typing for someone else in a channel", function () {
			const {h, id} = inChannel();

			h.transport.line("@+typing=active;msgid=t1 :carol!carol@host TAGMSG #seance");
			h.transport.line("@+typing=paused :carol!carol@host TAGMSG #seance");
			h.transport.line("@+typing=done :carol!carol@host TAGMSG #seance");

			expect(h.payloads<TypingPayload>("typing")).to.deep.equal([
				{chan: id, nick: "carol", state: "active"},
				{chan: id, nick: "carol", state: "paused"},
				{chan: id, nick: "carol", state: "done"},
			]);
			expect(h.payloads("msg")).to.have.length(0);
		});

		it("attaches private typing to the query with the other party", function () {
			const {h} = inChannel();
			h.transport.line("@msgid=p1 :carol!carol@host PRIVMSG alice :psst");
			const query = h.client.findChannel("carol")!;

			h.transport.line("@+typing=active :carol!carol@host TAGMSG alice");
			h.transport.line("@+typing=active :dave!dave@host TAGMSG alice"); // no query open

			expect(h.payloads<TypingPayload>("typing")).to.deep.equal([
				{chan: query.id, nick: "carol", state: "active"},
			]);
			expect(h.client.findChannel("dave")).to.equal(undefined);
		});

		it("ignores our own echo", function () {
			const {h} = inChannel();

			h.transport.line("@+typing=active :alice!alice@host.example TAGMSG #seance");
			h.transport.line("@+typing=active :alice!alice@host.example TAGMSG carol");

			expect(h.payloads("typing")).to.have.length(0);
		});

		it("ignores invalid values and unloaded targets", function () {
			const {h} = inChannel();

			h.transport.lines(
				"@+typing=typing :carol!carol@host TAGMSG #seance",
				"@+typing= :carol!carol@host TAGMSG #seance",
				"@+typing :carol!carol@host TAGMSG #seance",
				"@+typing=ACTIVE :carol!carol@host TAGMSG #seance",
				"@+typing=active :carol!carol@host TAGMSG #other"
			);

			expect(h.payloads("typing")).to.have.length(0);
			expect(h.payloads("msg")).to.have.length(0);
		});

		it("applies the ignore list", function () {
			const {h, id} = inChannel();
			ignoreListFor(h.client.uuid).add("carol!*@*");

			h.transport.line("@+typing=active :carol!carol@host TAGMSG #seance");
			h.transport.line("@+typing=active :dave!dave@host TAGMSG #seance");

			expect(h.payloads<TypingPayload>("typing")).to.deep.equal([
				{chan: id, nick: "dave", state: "active"},
			]);
		});

		it("handles a TAGMSG carrying both a typing tag and a reaction", function () {
			const {h, id} = inChannel();
			h.transport.line(
				"@time=2026-08-25T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
			);
			const msgId = h.lastMessage(id).id;

			h.transport.line(
				"@+typing=done;+draft/react=👍;+draft/reply=m1 :carol!carol@host TAGMSG #seance"
			);

			expect(h.payloads<TypingPayload>("typing")).to.deep.equal([
				{chan: id, nick: "carol", state: "done"},
			]);
			expect(h.payloads("msg:react")).to.deep.equal([
				{chan: id, id: msgId, text: "👍", nick: "carol", remove: false},
			]);
		});

		it("dispatches nothing during a chathistory replay", function () {
			const h = setup();
			const id = joined(h, ALL_CAPS, [
				"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :old",
				"@time=2026-08-25T11:00:05.000Z;msgid=h2;+typing=active :carol!carol@host TAGMSG #seance",
			]);
			h.client.open(id);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const label = h
				.sent()
				.find((l) => l.includes("CHATHISTORY"))
				?.match(/^@label=([^ ;]+)/)?.[1];
			batch(
				h,
				[
					"@time=2026-08-25T10:00:00.000Z;msgid=h0 :bob!bob@host PRIVMSG #seance :older",
					"@time=2026-08-25T10:00:05.000Z;msgid=h0t;+typing=active :carol!carol@host TAGMSG #seance",
				],
				{label}
			);

			expect(h.payloads("typing")).to.have.length(0);
			expect(h.payloads("more")).to.have.length(1);
		});
	});
});
