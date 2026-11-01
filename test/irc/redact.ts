import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, batch, joined, labelOf, setup, stubStorage} from "./support";

interface RedactPayload {
	chan: number;
	id: number;
	by: string;
	reason?: string;
	time: Date;
}

const NO_REDACT = ALL_CAPS.replace(" draft/message-redaction", "");

describe("Message deletion (REDACT, handlers/redact.ts)", function () {
	beforeEach(function () {
		stubStorage();
	});

	afterEach(function () {
		sinon.restore();
		socket.removeAllListeners();
	});

	describe("outbound", function () {
		it("sends REDACT with and without a reason, via /redact and /delete", function () {
			const h = setup();
			const id = joined(h);

			h.client.input(id, "/redact m1 oops, wrong channel");
			h.client.input(id, "/delete m2");
			expect(h.sent()).to.deep.equal([
				"REDACT #seance m1 :oops, wrong channel",
				"REDACT #seance m2",
			]);
		});

		it("routes the msg:redact bus emit to the owning client", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});

			socket.emit("msg:redact", {target: id, msgid: "m1", reason: "typo"});
			socket.emit("msg:redact", {target: id, msgid: "m2"});
			socket.emit("msg:redact", {target: 999, msgid: "m3"});
			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :typo", "REDACT #seance m2"]);
		});

		it("needs a msgid", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/redact");
			expect(h.lastMessage(id).text).to.match(/^Usage/);
			expect(h.sent()).to.deep.equal([]);
		});

		it("reports an error when draft/message-redaction is not active", function () {
			const h = setup();
			const id = joined(h, NO_REDACT);

			expect(h.client.canRedact).to.equal(false);
			expect(h.client.redact(h.client.channelById(id)!, "m1")).to.equal(false);
			const msg = h.lastMessage(id);
			expect(msg.type).to.equal(MessageType.ERROR);
			expect(msg.text).to.match(/draft\/message-redaction/);
			expect(h.sent()).to.deep.equal([]);
		});

		it("refuses outside channels", function () {
			const h = setup();
			joined(h);
			const query = h.client.announceChannel("bob", ChanType.QUERY);

			expect(h.client.redact(query, "m1")).to.equal(false);
			expect(h.lastMessage(query.id).text).to.equal(
				"Messages can only be deleted in channels."
			);
			h.client.input(h.client.lobby.id, "/redact m1");
			expect(h.lastMessage(h.client.lobby.id).type).to.equal(MessageType.ERROR);
			expect(h.sent()).to.deep.equal([]);
		});
	});

	describe("inbound", function () {
		it("resolves a REDACT of a loaded message to msg:redact (untagged live line: time is now)", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=m1 :bob!bob@host PRIVMSG #seance :oops");
			const target = h.lastMessage(id).id;
			const before = Date.now();
			h.transport.line(":bob!bob@host REDACT #seance m1 :typo");

			const [payload] = h.payloads<RedactPayload>("msg:redact");
			expect(payload.chan).to.equal(id);
			expect(payload.id).to.equal(target);
			expect(payload.by).to.equal("bob");
			expect(payload.reason).to.equal("typo");
			expect(payload.time.getTime()).to.be.at.least(before);
			expect(h.messages(id)).to.have.length(1); // no extra line

			h.transport.line(":bob!bob@host REDACT #seance m1");
			const [, again] = h.payloads<RedactPayload>("msg:redact");
			expect(again).to.not.have.property("reason");
		});

		it("shows a plain line for a REDACT of a message we never loaded", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":bob!bob@host REDACT #seance unknown :spam");

			expect(h.payloads("msg:redact")).to.have.length(0);
			const msg = h.lastMessage(id);
			expect(msg.text).to.equal("bob deleted a message (spam)");
			expect(msg.type).to.equal(undefined);

			h.transport.line(":bob!bob@host REDACT #seance unknown2");
			expect(h.lastMessage(id).text).to.equal("bob deleted a message");
		});

		it("ignores REDACTs for channels we are not in", function () {
			const h = setup();
			joined(h);
			h.transport.line(":bob!bob@host REDACT #other m1 :x");

			expect(h.payloads("msg:redact")).to.have.length(0);
			expect(h.messages()).to.have.length(0);
		});

		it("applies REDACTs replayed in a chathistory batch after delivery and drops unknown ones", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const label = labelOf(h.sent());
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :old",
					"@time=2026-08-25T11:00:05.000Z;msgid=h2 :bob!bob@host REDACT #seance h1 :edited",
					"@time=2026-08-25T11:00:06.000Z;msgid=h3 :bob!bob@host REDACT #seance gone :never loaded",
				],
				{label}
			);

			const [more] =
				h.payloads<{messages: {id: number; msgid?: string; text?: string}[]}>("more");
			expect(more.messages.map((m) => m.msgid)).to.deep.equal(["h1"]);
			const [payload, ...rest] = h.payloads<RedactPayload>("msg:redact");
			expect(rest).to.have.length(0);
			expect(payload.id).to.equal(more.messages[0].id);
			expect(payload.by).to.equal("bob");
			expect(payload.reason).to.equal("edited");
			expect(payload.time.toISOString()).to.equal("2026-08-25T11:00:05.000Z");
			expect(h.messages(id)).to.have.length(0); // the unknown one is dropped, not shown
			const events = h.events();
			expect(events.indexOf("more")).to.be.lessThan(events.indexOf("msg:redact"));
		});
	});

	describe("FAIL REDACT", function () {
		it("explains each code in the channel the context names", function () {
			const h = setup();
			const id = joined(h);
			const cases: [string, RegExp][] = [
				["REDACT_FORBIDDEN #seance m1 :You are not authorized", /not allowed to delete/],
				["UNKNOWN_MSGID #seance nope :Message not found", /no longer has that message/],
				["REDACT_WINDOW_EXPIRED #seance m1 :Too old", /too old to delete/],
				["DISABLED #seance m1 :Redaction disabled", /disabled on this server/],
			];

			for (const [tail, expected] of cases) {
				h.transport.line(`@time=2026-08-25T12:00:00.000Z FAIL REDACT ${tail}`);
				const msg = h.lastMessage(id);
				expect(msg.type).to.equal(MessageType.ERROR);
				expect(msg.text).to.match(/^Could not delete message: /);
				expect(msg.text).to.match(expected);
			}

			expect(h.messages(h.client.lobby.id)).to.have.length(0);
		});

		it("falls back to the lobby (shown in the active window) when the context is not a loaded channel", function () {
			const h = setup();
			joined(h);
			h.transport.line("FAIL REDACT INVALID_TARGET bob :Cannot redact from this target");

			const msg = h.lastMessage(h.client.lobby.id);
			expect(msg.text).to.equal(
				"Could not delete message: Messages can only be deleted in channels."
			);
			expect(msg.showInActive).to.equal(true);

			h.transport.line("FAIL REDACT SOMETHING_NEW #seance m1 :Server says no");
			expect(h.lastMessage().text).to.equal("Could not delete message: Server says no");

			// A code it does not know, and no words from the server: say the code
			h.transport.line("FAIL REDACT SOMETHING_NEW");
			expect(h.lastMessage().text).to.equal("Could not delete message: SOMETHING_NEW");
			h.transport.line("FAIL REDACT SOMETHING_NEW bob m1 :");
			expect(h.lastMessage().text).to.equal("Could not delete message: SOMETHING_NEW");
		});
	});
});
