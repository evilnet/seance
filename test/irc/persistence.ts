import {expect} from "chai";
import sinon from "ts-sinon";
import {
	RESTORE_MAX_WAIT_MS,
	RESTORE_QUIET_MS,
	RESTORE_WAIT_MS,
	awaitingRestoration,
} from "../../client/js/irc/persistence";
import {ChanState} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, Harness, batch, labelOf, register, setup} from "./support";

const CAPS = ALL_CAPS + " draft/persistence";
// `STATUS <client-setting> <effective>`; the effective state is the last one.
const HOLD = [":irc.test PERSISTENCE STATUS DEFAULT ON"];

/** Types of the messages the UI got for `chanId`. */
function types(h: Harness, chanId: number): MessageType[] {
	return h.messages(chanId).map((m) => m.type as MessageType);
}

/** The server's post-JOIN burst for #seance with `topic`, as a re-join or inside a batch. */
function joinBurst(topic: string, tag = ""): string[] {
	return [
		`${tag}:alice!alice@host JOIN #seance`,
		`${tag}:irc.test 332 alice #seance :${topic}`,
		`${tag}:irc.test 333 alice #seance bob!bob@host 1756000000`,
		`${tag}:irc.test 353 alice = #seance :@alice bob`,
		`${tag}:irc.test 366 alice #seance :End of /NAMES list.`,
	];
}

/** The `draft/persistence` batch restoring #seance (and optionally more channels). */
function restore(h: Harness, topic: string, extra: string[] = []): void {
	const tag = "@batch=p1 ";
	h.transport.line(":irc.test BATCH +p1 draft/persistence");
	h.transport.line(
		"@batch=p1;time=2026-08-20T10:00:00.000Z;msgid=j1 :alice!alice@host JOIN #seance alice :Alice"
	);

	for (const line of joinBurst(topic, tag).slice(1)) {
		h.transport.line(line);
	}

	for (const line of extra) {
		h.transport.line(tag + line);
	}

	h.transport.line(":irc.test BATCH -p1");
}

describe("Session persistence and quiet re-joins (irc/persistence.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-27T12:00:00.000Z")});
	});

	afterEach(function () {
		clock.restore();
	});

	describe("draft/persistence", function () {
		it("requests the cap; STATUS ON before the MOTD end holds the autojoin back, silently", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
			expect(req).to.include("draft/persistence");
			expect(h.client.persistenceHold).to.equal(true);
			expect(awaitingRestoration(h.client)).to.equal(true);
			expect(h.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
			expect(h.messages().some((m) => /^Session persistence/.test(m.text ?? ""))).to.equal(
				false
			);
		});

		it("reads the effective state, in either the one- or two-argument form", function () {
			const two = setup();
			register(two, CAPS, [":irc.test PERSISTENCE STATUS ON OFF"]);
			expect(two.client.persistenceHold).to.equal(false);
			// A setting of ON not in force may be an alias, told right behind
			// the MOTD: the autojoin waits a quiet period for its note, then
			// JOINs what never came — not the full wait for a held session.
			expect(two.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
			clock.tick(RESTORE_QUIET_MS - 1);
			expect(two.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
			clock.tick(1);
			expect(two.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([
				"JOIN #seance",
			]);

			// nefarious2 before 7a47da1: the effective state on its own.
			const one = setup();
			register(one, CAPS, [":irc.test PERSISTENCE STATUS ON"]);
			expect(one.client.persistenceHold).to.equal(true);
			expect(awaitingRestoration(one.client)).to.equal(true);
		});

		it("auto-enables persistence (PERSISTENCE SET ON) when logged in via SASL", function () {
			const h = setup({sasl: "plain", saslAccount: "acc", saslPassword: "pw"});
			h.client.connect();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${CAPS} sasl=PLAIN`);
			const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
			h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
			h.transport.line("AUTHENTICATE +");
			h.transport.lines(
				":irc.test 900 alice alice!alice@host acc :You are now logged in as acc",
				":irc.test 903 alice :SASL authentication successful"
			);

			// 001/005/422: onRegistered fires at the MOTD end and sends SET ON.
			h.transport.lines(
				":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
				":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 STATUSMSG=@+ :are supported by this server",
				":irc.test 422 alice :MOTD File is missing"
			);

			// SET ON goes out post-001 (onRegistered): the SET handler needs
			// the account flag, which pre-CAP-END connections do not carry.
			const sent = h.sent();
			const setIdx = sent.indexOf("PERSISTENCE SET ON");
			expect(setIdx, "SET ON sent").to.be.at.least(0);
			expect(sent.indexOf("CAP END")).to.be.lessThan(setIdx);

			// The ack + the STATUS that follows are ours: silent.
			h.transport.lines(":irc.test PERSISTENCE SET ON", ":irc.test PERSISTENCE STATUS ON ON");
			expect(h.messages().some((m) => /Session persistence/i.test(m.text ?? ""))).to.equal(
				false
			);
		});

		it("skips SET ON when the registration STATUS says the account's setting is already ON", function () {
			const signIn = (status: string, after: string[] = []) => {
				const h = setup({sasl: "plain", saslAccount: "acc", saslPassword: "pw"});
				h.client.connect();
				h.transport.open();
				h.transport.line(`:irc.test CAP * LS :${CAPS} sasl=PLAIN`);
				const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
				h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
				h.transport.line("AUTHENTICATE +");
				h.transport.lines(
					":irc.test 900 alice alice!alice@host acc :You are now logged in as acc",
					":irc.test 903 alice :SASL authentication successful",
					":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
					`:irc.test PERSISTENCE STATUS ${status}`,
					":irc.test 422 alice :MOTD File is missing",
					...after
				);
				// Decided once the restoration is in, or was never coming.
				clock.tick(RESTORE_MAX_WAIT_MS);
				return h.transport.sent.includes("PERSISTENCE SET ON");
			};

			// Every command after 001 costs fake lag; this one would change nothing.
			expect(signIn("ON ON")).to.equal(false);
			// ON but not in force (no session, the bouncer off): SET ON creates one.
			expect(signIn("ON OFF")).to.equal(true);
			// …unless this connection is an alias of another device's session,
			// which is held: the alias reads `ON OFF` too.
			expect(
				signIn("ON OFF", [
					":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session s1 as alias on irc.test",
				])
			).to.equal(false);
			// DEFAULT follows the server's default; ON pins it for the account.
			expect(signIn("DEFAULT ON")).to.equal(true);
			expect(signIn("OFF OFF")).to.equal(true);
			// A build that sends the effective state alone: cannot tell, so ask.
			expect(signIn("ON")).to.equal(true);
		});

		it("does not auto-enable persistence without SASL", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			expect(h.transport.sent.some((l) => l.startsWith("PERSISTENCE SET"))).to.equal(false);
		});

		it("STATUS OFF (or no STATUS) JOINs at once", function () {
			const off = setup();
			register(off, CAPS, [":irc.test PERSISTENCE STATUS DEFAULT OFF"]);
			expect(off.client.persistenceHold).to.equal(false);
			expect(off.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([
				"JOIN #seance",
			]);

			const none = setup();
			register(none, CAPS);
			expect(none.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([
				"JOIN #seance",
			]);
		});

		it("held but nothing restored: JOINs after RESTORE_WAIT_MS", function () {
			const h = setup();
			h.client.open(h.client.findChannel("#seance")!.id);
			register(h, CAPS, HOLD);
			clock.tick(RESTORE_WAIT_MS - 1);
			expect(h.sent()).to.deep.equal([]);
			clock.tick(1);
			expect(awaitingRestoration(h.client)).to.equal(false);
			const lines = h.sent();
			expect(lines[0]).to.equal("JOIN #seance");
			// The active channel's catch-up is pipelined behind it as usual.
			expect(lines[1]).to.match(/CHATHISTORY LATEST #seance/);
		});

		it("the restoration batch is applied as state, and only the rest is JOINed", function () {
			const h = setup({join: "#seance,#other"});
			const seance = h.client.findChannel("#seance")!;
			h.client.open(seance.id);
			register(h, CAPS, HOLD);
			restore(h, "Welcome");

			expect(seance.state).to.equal(ChanState.JOINED);
			expect(Array.from(seance.users.keys())).to.deep.equal(["alice", "bob"]);
			expect(seance.shared.topic).to.equal("Welcome");
			// A fresh client had no topic: that is news. Our JOIN is not.
			expect(types(h, seance.id)).to.deep.equal([
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
			]);
			expect(awaitingRestoration(h.client)).to.equal(false);

			const sent = h.sent();
			expect(sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal(["JOIN #other"]);
			// The restored channel gets its catch-up (active: at once) and modes.
			expect(sent.some((l) => /CHATHISTORY LATEST #seance/.test(l))).to.equal(true);
			expect(sent).to.include("MODE #seance");
			expect(sent.filter((l) => l.includes("#other"))).to.deep.equal(["JOIN #other"]);
		});

		it("a drop and a resumed session: nothing is shown, history is fetched from LATEST back to the newest line", function () {
			const h = setup();
			const seance = h.client.findChannel("#seance")!;
			h.client.open(seance.id);
			register(h, CAPS, HOLD);
			restore(h, "Welcome");
			batch(
				h,
				["@time=2026-08-27T11:59:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"],
				{
					label: labelOf(h.sent()),
				}
			);
			h.dispatch.resetHistory();

			h.transport.closed();
			expect(seance.state).to.equal(ChanState.PARTED);
			expect(seance.rejoining).to.equal(true);
			register(h, CAPS, HOLD);
			h.dispatch.resetHistory();
			restore(h, "Welcome");

			expect(seance.state).to.equal(ChanState.JOINED);
			expect(seance.users.size).to.equal(2);
			expect(h.messages(seance.id)).to.deep.equal([]);
			expect(h.sent().filter((l) => !l.startsWith("MODE"))).to.have.length(1);
			expect(h.transport.sent[h.transport.sent.length - 2]).to.match(
				/CHATHISTORY LATEST #seance \* \d+$/
			);
			expect(h.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
		});

		it("a second burst after an alias attach repeats nothing (the reported symptom)", function () {
			const h = setup();
			const seance = h.client.findChannel("#seance")!;
			h.client.open(seance.id);
			register(h, CAPS, HOLD);
			restore(h, "Not Just Linux");

			// Fresh page load: the topic is news the first time.
			expect(types(h, seance.id)).to.deep.equal([
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
			]);
			h.dispatch.resetHistory();
			const afterFirst = h.transport.sent.length;

			// Attached as an alias because another client of the account holds
			// the session: the note, then the whole burst a second time.
			h.transport.line(
				":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ7 as alias on irc.test"
			);
			h.transport.lines(...joinBurst("Not Just Linux"));

			expect(h.messages()).to.deep.equal([]);
			// …and nothing is asked for again (history, marker, modes).
			expect(h.transport.sent.slice(afterFirst)).to.deep.equal([]);
			expect(seance.state).to.equal(ChanState.JOINED);
			expect(seance.users.size).to.equal(2);
		});

		it("an alias attach (STATUS ON OFF, then the note after the MOTD) JOINs nothing the server hands back", function () {
			const h = setup();
			const seance = h.client.findChannel("#seance")!;
			// nefarious2's alias path: STATUS before the MOTD end, the note and
			// the channel state after it (bounce_setup_local_alias).
			register(h, CAPS, [":irc.test PERSISTENCE STATUS ON OFF"]);
			h.transport.line(
				":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ7 as alias on irc.test"
			);
			restore(h, "Not Just Linux");
			clock.tick(RESTORE_MAX_WAIT_MS);

			expect(h.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
			expect(seance.state).to.equal(ChanState.JOINED);
		});

		it("holds the autojoin through an unbatched burst and its bouncer note", function () {
			const h = setup({join: "#seance,#other"});
			register(h, CAPS, HOLD);

			// No batch: the burst arrives line by line, the note in the middle.
			clock.tick(RESTORE_WAIT_MS - RESTORE_QUIET_MS);
			h.transport.line(
				":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ7 as alias on irc.test"
			);
			expect(h.messages().filter((m) => /BOUNCER/.test(m.text ?? ""))).to.deep.equal([]);
			clock.tick(RESTORE_QUIET_MS - 1);
			h.transport.lines(...joinBurst("Welcome"));
			expect(h.sent().filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);

			clock.tick(RESTORE_QUIET_MS);
			expect(awaitingRestoration(h.client)).to.equal(false);
			// Only the channel the server did not give back.
			expect(h.sent().filter((l) => l.startsWith("JOIN"))).to.deep.equal(["JOIN #other"]);
		});

		it("never holds the autojoin past RESTORE_MAX_WAIT_MS", function () {
			const h = setup();
			register(h, CAPS, HOLD);

			for (let elapsed = 0; elapsed < RESTORE_MAX_WAIT_MS; elapsed += RESTORE_QUIET_MS - 1) {
				clock.tick(RESTORE_QUIET_MS - 1);
				h.transport.line(":alice!alice@host JOIN #seance");
			}

			clock.tick(RESTORE_MAX_WAIT_MS);
			expect(awaitingRestoration(h.client)).to.equal(false);
		});

		it("hides the attach note on a server that sent no PERSISTENCE STATUS", function () {
			// The unsolicited STATUS is not on every build's alias-attach
			// path; the note behind the MOTD is routine either way (the
			// reported symptom: one line per switch back to the app).
			const h = setup();
			register(h, CAPS);
			expect(h.client.persistenceHold).to.equal(false);
			h.dispatch.resetHistory();
			h.transport.line(
				":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ7 as alias on irc.test"
			);
			expect(h.messages()).to.deep.equal([]);
		});

		it("reports a bouncer note that is not part of a reattach", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			clock.tick(RESTORE_MAX_WAIT_MS);
			h.dispatch.resetHistory();
			h.transport.line(
				":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ7 as alias on irc.test"
			);
			expect(h.lastMessage(h.client.lobby.id).text).to.match(/^BOUNCER: Attached to session/);
		});

		it("a channel the server restored that we did not know is announced", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			restore(h, "Welcome", [
				":alice!alice@host JOIN #extra",
				":irc.test 353 alice = #extra :@alice",
				":irc.test 366 alice #extra :End of /NAMES list.",
			]);
			const extra = h.client.findChannel("#extra")!;
			expect(extra.state).to.equal(ChanState.JOINED);
			expect(
				h.payloads<{chan: {name: string}}>("join").map((p) => p.chan.name)
			).to.deep.equal(["#extra"]);
			expect(types(h, extra.id)).to.deep.equal([]);
		});

		it("the batch also satisfies a later STATUS query in the lobby", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			h.dispatch.resetHistory();
			h.transport.line(":irc.test PERSISTENCE STATUS DEFAULT OFF");
			expect(h.client.persistenceHold).to.equal(false);
			expect(h.lastMessage(h.client.lobby.id).text).to.match(
				/^Session persistence .*: OFF \(your setting: DEFAULT\)$/
			);

			h.transport.line(":irc.test PERSISTENCE SET ON");
			expect(h.lastMessage(h.client.lobby.id).text).to.equal(
				"Session persistence set to: ON"
			);
		});

		it("a close while waiting cancels the pending autojoin", function () {
			const h = setup();
			register(h, CAPS, HOLD);
			h.transport.closed();
			clock.tick(RESTORE_WAIT_MS * 2);
			expect(awaitingRestoration(h.client)).to.equal(false);
			expect(h.transport.sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
		});
	});

	describe("/topic", function () {
		it("shows the reply even when the topic has not changed", function () {
			const h = setup();
			register(h);
			h.transport.lines(...joinBurst("Welcome"));
			const seance = h.client.findChannel("#seance")!;
			h.dispatch.resetHistory();

			// An unasked-for repeat stays hidden…
			h.transport.line(":irc.test 332 alice #seance :Welcome");
			expect(h.messages(seance.id)).to.deep.equal([]);

			// …but the answer to /topic is what the user asked for.
			h.client.input(seance.id, "/topic");
			expect(h.sent()).to.include("TOPIC #seance");
			h.transport.lines(
				":irc.test 332 alice #seance :Welcome",
				":irc.test 333 alice #seance bob!bob@host 1756000000"
			);
			expect(types(h, seance.id)).to.deep.equal([
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
			]);
		});

		it("says so when there is no topic", function () {
			const h = setup();
			register(h);
			h.transport.lines(":alice!alice@host JOIN #seance");
			const seance = h.client.findChannel("#seance")!;
			h.dispatch.resetHistory();
			h.transport.line(":irc.test 331 alice #seance :No topic is set");
			expect(h.messages(seance.id)).to.deep.equal([]);

			h.client.input(seance.id, "/topic");
			h.transport.line(":irc.test 331 alice #seance :No topic is set");
			expect(h.lastMessage(seance.id).text).to.equal("No topic is set.");
		});
	});

	describe("re-join after a drop (no persistence)", function () {
		function connectedWithTopic(): Harness {
			const h = setup();
			register(h);
			h.transport.lines(...joinBurst("Welcome"));
			const seance = h.client.findChannel("#seance")!;
			expect(types(h, seance.id)).to.deep.equal([
				MessageType.JOIN,
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
			]);
			h.dispatch.resetHistory();
			h.sent();
			return h;
		}

		it("hides our JOIN and an unchanged topic, refills the user list", function () {
			const h = connectedWithTopic();
			const seance = h.client.findChannel("#seance")!;
			h.transport.closed();
			expect(seance.rejoining).to.equal(true);
			register(h);
			h.dispatch.resetHistory();
			h.transport.lines(...joinBurst("Welcome"));

			expect(seance.state).to.equal(ChanState.JOINED);
			expect(seance.users.size).to.equal(2);
			expect(h.messages(seance.id)).to.deep.equal([]);
			expect(seance.rejoining).to.equal(false);
			expect(seance.topicQuiet).to.equal(false);

			// A repeat stays hidden however it arrives; /topic has its own test.
			h.transport.lines(
				":irc.test 332 alice #seance :Welcome",
				":irc.test 333 alice #seance bob!bob@host 1756000000"
			);
			expect(h.messages(seance.id)).to.deep.equal([]);
		});

		it("shows a topic that changed while we were away", function () {
			const h = connectedWithTopic();
			const seance = h.client.findChannel("#seance")!;
			h.transport.closed();
			register(h);
			h.dispatch.resetHistory();
			h.transport.lines(...joinBurst("New topic"));

			expect(seance.shared.topic).to.equal("New topic");
			expect(types(h, seance.id)).to.deep.equal([
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
			]);
			expect(h.payloads("topic")).to.deep.equal([{chan: seance.id, topic: "New topic"}]);
		});

		it("PERSISTENCE LIST sessions reach the UI as persistence:sessions, not the lobby", function () {
			const h = setup();
			register(h, CAPS);
			h.dispatch.resetHistory();

			h.transport.lines(
				":irc.test PERSISTENCE SESSION sess1 ACTIVE alice #seance,#foo :active on irc.test",
				":irc.test PERSISTENCE ENDOFLIST"
			);

			const lists = h.payloads<{sessions: any[]}>("persistence:sessions");
			expect(lists).to.have.lengthOf(1);
			expect(lists[0].sessions).to.deep.equal([
				{
					sessid: "sess1",
					state: "ACTIVE",
					nick: "alice",
					channels: ["#seance", "#foo"],
					info: "active on irc.test",
				},
			]);
			// Session bookkeeping is panel-only: nothing in any channel buffer.
			expect(h.dispatch.calledWith("msg")).to.equal(false);
		});

		it("LIST rows before ENDOFLIST buffer, and a stray ENDOFLIST dispatches an empty list", function () {
			const h = setup();
			register(h, CAPS);
			h.dispatch.resetHistory();

			// ENDOFLIST without a LIST in flight: the panel gets an empty list.
			h.transport.line(":irc.test PERSISTENCE ENDOFLIST");
			expect(h.payloads("persistence:sessions")).to.deep.equal([{sessions: []}]);

			// A HELD row arrives after its list closed: buffered, not dispatched.
			h.dispatch.resetHistory();
			h.transport.line(":irc.test PERSISTENCE SESSION sess2 HELD alice * :held");
			expect(h.dispatch.calledWith("persistence:sessions")).to.equal(false);

			h.transport.line(":irc.test PERSISTENCE ENDOFLIST");
			const lists = h.payloads<{sessions: any[]}>("persistence:sessions");
			expect(lists[0].sessions).to.deep.equal([
				{
					sessid: "sess2",
					state: "HELD",
					nick: "alice",
					channels: [],
					info: "held",
				},
			]);
		});

		it("PERSISTENCE DETACH ack refreshes the panel with an empty list", function () {
			const h = setup();
			register(h, CAPS);
			h.dispatch.resetHistory();

			h.transport.line(":irc.test PERSISTENCE DETACH OK");
			expect(h.payloads("persistence:sessions")).to.deep.equal([{sessions: []}]);
		});

		it("a deliberate disconnect and reconnect shows the JOIN as before", function () {
			const h = connectedWithTopic();
			const seance = h.client.findChannel("#seance")!;
			h.client.disconnect();
			h.transport.closed();
			expect(seance.rejoining).to.equal(false);
			register(h);
			h.dispatch.resetHistory();
			h.transport.lines(...joinBurst("Welcome"));
			// The JOIN is news (we left on purpose); the topic we still hold is not.
			expect(types(h, seance.id)).to.deep.equal([MessageType.JOIN]);
		});
	});
});
