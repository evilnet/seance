/**
 * The `PERSISTENCE ATTACH <profile> [<msgid>]` catch-up cursor: tracking the
 * newest msgid we hold, keeping it in localStorage, offering it in the flush
 * that carries `CAP END`, and taking the server's replay as new messages
 * instead of asking per channel (client/js/irc/persistence.ts).
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import {CURSOR_SAVE_INTERVAL_MS} from "../../client/js/irc/client";
import {requestHistory, requestMore} from "../../client/js/irc/history";
import {MARKREAD_DEBOUNCE_MS} from "../../client/js/irc/handlers/markread";
import * as saved from "../../client/js/irc/saved-networks";
import type {StorageBackend} from "../../client/js/irc/saved-networks";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import {ALL_CAPS, Harness, batch, joined, labelOf, register, setup} from "./support";

/** In-memory stand-in for the localStorage wrapper, counting writes. */
class MemoryBackend implements StorageBackend {
	data = new Map<string, string>();
	writes = 0;

	get(key: string): string | null {
		return this.data.has(key) ? (this.data.get(key) as string) : null;
	}

	set(key: string, value: string): void {
		this.writes++;
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}
}

const UUID = "attach-cursor-net";
const PERSISTENCE_WITH_CURSOR = "draft/persistence=attach,detach,list,attach-cursor";
const PERSISTENCE_NO_CURSOR = "draft/persistence=attach,detach,list";
const SASL_CAPS = `${ALL_CAPS} sasl=PLAIN ${PERSISTENCE_WITH_CURSOR}`;
/** `STATUS <client-setting> <effective>`: the session is held. */
const HOLD = [":irc.test PERSISTENCE STATUS DEFAULT ON"];

/** Store a saved network for {@link UUID}, optionally with a cursor. */
function store(cursor?: {msgid: string; time: number}): void {
	saved.save({
		uuid: UUID,
		name: "",
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "plain",
		saslAccount: "alice",
		saslPassword: "",
		...(cursor ? {cursor} : {}),
	});
}

/** A client that authenticates with SASL PLAIN, under {@link UUID}. */
function saslClient(overrides: Record<string, unknown> = {}): Harness {
	return setup({
		uuid: UUID,
		sasl: "plain",
		saslAccount: "alice",
		saslPassword: "s3cret",
		...overrides,
	});
}

/** CAP LS / REQ / ACK and the SASL exchange, up to (and including) 903. */
function authenticate(h: Harness, caps = SASL_CAPS, ok = true): void {
	h.client.connect();
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${caps}`);
	const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	h.transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	h.transport.line("AUTHENTICATE +");

	if (ok) {
		h.transport.lines(
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
	} else {
		h.transport.line(":irc.test 904 alice :SASL authentication failed");
	}
}

/** The numerics after CAP END; `beforeMotd` goes between 005 and 422. */
function finishRegistration(h: Harness, beforeMotd: string[] = []): void {
	h.transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 STATUSMSG=@+ CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server",
		...beforeMotd,
		":irc.test 422 alice :MOTD File is missing"
	);
}

/** The `draft/persistence` batch giving #seance back, as after a drop. */
function restore(h: Harness): void {
	h.transport.lines(
		":irc.test BATCH +p1 draft/persistence",
		"@batch=p1;time=2026-08-20T10:00:00.000Z;msgid=j1 :alice!alice@host JOIN #seance alice :Alice",
		"@batch=p1 :irc.test 353 alice = #seance :@alice bob",
		"@batch=p1 :irc.test 366 alice #seance :End of /NAMES list.",
		":irc.test BATCH -p1"
	);
}

/**
 * The server's cursor replay: an outer `bouncer-replay` batch wrapping one
 * `chathistory` batch per target. The inner opener carries the stray
 * trailing `;` nefarious2 puts in the tag (`replay.c` `replay_open_batch`).
 */
function bouncerReplay(h: Harness, target: string, lines: string[]): void {
	h.transport.lines(
		":irc.test BATCH +outer evilnet.github.io/bouncer-replay",
		`@batch=outer; :irc.test BATCH +inner chathistory ${target}`,
		...lines.map((line) => `@batch=inner;${line.slice(1)}`),
		"@batch=outer :irc.test BATCH -inner",
		":irc.test BATCH -outer"
	);
}

function chathistory(lines: string[]): string[] {
	return lines.filter((l) => l.includes("CHATHISTORY"));
}

describe("PERSISTENCE ATTACH catch-up cursor (irc/persistence.ts)", function () {
	let backend: MemoryBackend;
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		backend = new MemoryBackend();
		saved.useStorageBackend(backend);
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-28T12:00:00.000Z")});
	});

	afterEach(function () {
		clock.restore();
		saved.useStorageBackend(null);
	});

	describe("tracking the newest msgid", function () {
		it("advances on live messages and never goes backwards on older history", function () {
			const h = setup();
			const id = joined(h, ALL_CAPS, [
				"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :older",
			]);
			expect(h.client.cursor?.msgid).to.equal("join-1"); // the JOIN echo is newer

			h.transport.line(
				"@time=2026-08-28T11:59:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
			);
			expect(h.client.cursor).to.deep.equal({
				msgid: "m1",
				time: Date.parse("2026-08-28T11:59:00.000Z"),
			});

			// A page of older history is prepended: the cursor stays put.
			const chan = h.client.findChannel("#seance")!;
			requestHistory(h.client, chan, {
				subcommand: "BEFORE",
				ref: {msgid: "h1", time: new Date("2026-08-28T11:00:00.000Z")},
				limit: 100,
				mode: "prepend",
			});
			batch(
				h,
				["@time=2026-08-28T10:00:00.000Z;msgid=h0 :bob!bob@host PRIVMSG #seance :ancient"],
				{label: labelOf(h.sent())}
			);
			expect(h.client.cursor?.msgid).to.equal("m1");
			expect(id).to.equal(chan.id);
		});

		it("advances on the appended catch-up, and ignores messages without a msgid", function () {
			const h = setup();
			joined(h);
			h.transport.line(":bob!bob@host PRIVMSG #seance :untagged");
			expect(h.client.cursor?.msgid).to.equal("join-1");

			bouncerReplay(h, "#seance", [
				"@time=2026-08-28T11:30:00.000Z;msgid=r1 :bob!bob@host PRIVMSG #seance :missed",
			]);
			expect(h.client.cursor).to.deep.equal({
				msgid: "r1",
				time: Date.parse("2026-08-28T11:30:00.000Z"),
			});
		});

		it("counts the catch-up as unread, through our own JOIN at its end", function () {
			const h = setup();
			joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.client.open(h.client.lobby.id);
			const lastRead = chan.shared.firstUnread;

			bouncerReplay(h, "#seance", [
				"@time=2026-08-28T11:30:00.000Z;msgid=r1 :bob!bob@host PRIVMSG #seance :missed",
				"@time=2026-08-28T11:31:00.000Z;msgid=r2 :bob!bob@host PRIVMSG #seance :alice: you there?",
				"@time=2026-08-28T11:32:00.000Z;msgid=r3 :alice!alice@host JOIN #seance",
			]);
			expect(chan.shared.unread).to.equal(2);
			expect(chan.shared.highlight).to.equal(1);
			expect(chan.shared.firstUnread, "the new-messages line stays above them").to.equal(
				lastRead
			);
		});
	});

	describe("persisting it", function () {
		it("writes at most once per interval, and flushes when the transport closes", function () {
			store();
			const h = saslClient();
			backend.writes = 0;
			authenticate(h);
			finishRegistration(h);
			h.transport.lines(
				"@time=2026-08-28T12:00:01.000Z;msgid=join-1 :alice!alice@host JOIN #seance",
				"@time=2026-08-28T12:00:02.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :one",
				"@time=2026-08-28T12:00:03.000Z;msgid=m2 :bob!bob@host PRIVMSG #seance :two"
			);
			expect(backend.writes).to.equal(0); // still throttled

			clock.tick(CURSOR_SAVE_INTERVAL_MS);
			expect(backend.writes).to.equal(1);
			expect(saved.get(UUID)?.cursor).to.deep.equal({
				msgid: "m2",
				time: Date.parse("2026-08-28T12:00:03.000Z"),
			});

			h.transport.line(
				"@time=2026-08-28T12:00:04.000Z;msgid=m3 :bob!bob@host PRIVMSG #seance :three"
			);
			h.transport.closed();
			expect(saved.get(UUID)?.cursor?.msgid).to.equal("m3");
			expect(backend.writes).to.equal(2);

			// Nothing left armed: the flush cancelled the throttle.
			clock.tick(CURSOR_SAVE_INTERVAL_MS * 2);
			expect(backend.writes).to.equal(2);
		});

		it("is loaded back on the next client and survives an unrelated save", function () {
			store({msgid: "m9", time: 123});
			const h = saslClient();
			expect(h.client.cursor).to.deep.equal({msgid: "m9", time: 123});

			saved.save({...saved.get(UUID)!, name: "Test net"});
			expect(saved.get(UUID)?.cursor).to.deep.equal({msgid: "m9", time: 123});

			saved.remove(UUID);
			expect(saved.get(UUID)).to.equal(undefined);
		});

		it("keeps the cursor in memory when the network was never saved", function () {
			const h = setup();
			joined(h);
			h.transport.line(
				"@time=2026-08-28T12:00:02.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :one"
			);
			clock.tick(CURSOR_SAVE_INTERVAL_MS);
			expect(h.client.cursor?.msgid).to.equal("m1");
			expect(backend.data.size).to.equal(0);
		});
	});

	describe("offering it", function () {
		it("sends PERSISTENCE ATTACH in the same flush as CAP END, after 903", function () {
			store({msgid: "m9", time: 123});
			const h = saslClient();
			authenticate(h);

			const sent = h.transport.sent;
			const attach = sent.indexOf("PERSISTENCE ATTACH default m9");
			expect(attach, "ATTACH sent").to.be.greaterThan(-1);
			expect(sent[attach + 1]).to.equal("CAP END");
			expect(sent[attach - 1]).to.match(/^AUTHENTICATE /);
			expect(h.client.attachCursor).to.equal("m9");
			expect(h.client.serverReplay).to.equal(false);

			// The ack is silent and switches the catch-up off.
			h.dispatch.resetHistory();
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			expect(h.client.serverReplay).to.equal(true);
			expect(h.messages()).to.deep.equal([]);
		});

		it("does not send it without the attach-cursor token", function () {
			store({msgid: "m9", time: 123});
			const h = saslClient();
			authenticate(h, `${ALL_CAPS} sasl=PLAIN ${PERSISTENCE_NO_CURSOR}`);
			finishRegistration(h);

			expect(h.transport.sent.some((l) => l.startsWith("PERSISTENCE ATTACH"))).to.equal(
				false
			);
			expect(h.transport.sent).to.include("PERSISTENCE SET ON");
			expect(h.transport.sent).to.include("CAP END");
			expect(h.client.attachCursor).to.equal(undefined);
		});

		it("does not send it without a stored cursor", function () {
			store();
			const h = saslClient();
			authenticate(h);
			expect(h.transport.sent.some((l) => l.startsWith("PERSISTENCE ATTACH"))).to.equal(
				false
			);
		});

		it("does not send a msgid the server could not store (>= 64 bytes)", function () {
			store({msgid: "x".repeat(64), time: 123});
			const h = saslClient();
			authenticate(h);
			expect(h.transport.sent.some((l) => l.startsWith("PERSISTENCE ATTACH"))).to.equal(
				false
			);

			// One byte shorter fits.
			const ok = saslClient({uuid: UUID});
			saved.setCursor(UUID, {msgid: "y".repeat(63), time: 124});
			ok.client.cursor = {msgid: "y".repeat(63), time: 124};
			authenticate(ok);
			expect(ok.transport.sent).to.include(`PERSISTENCE ATTACH default ${"y".repeat(63)}`);
		});

		it("does not send it when SASL failed, or when there is no SASL at all", function () {
			store({msgid: "m9", time: 123});
			// A deploy that lets a failed login through anyway (otherwise the
			// connection is dropped before `CAP END`, see client-sasl.ts).
			const failed = saslClient({saslDisconnectOnFail: false});
			authenticate(failed, SASL_CAPS, false);
			expect(failed.transport.sent.some((l) => l.startsWith("PERSISTENCE"))).to.equal(false);
			expect(failed.transport.sent).to.include("CAP END");

			const anonymous = setup({uuid: UUID});
			anonymous.client.cursor = {msgid: "m9", time: 123};
			register(anonymous, `${ALL_CAPS} ${PERSISTENCE_WITH_CURSOR}`);
			expect(anonymous.transport.sent.some((l) => l.startsWith("PERSISTENCE"))).to.equal(
				false
			);
		});

		it("falls back silently when the server refuses the ATTACH", function () {
			store({msgid: "m9", time: 123});
			const h = saslClient();
			authenticate(h);
			h.dispatch.resetHistory();
			h.transport.line(
				":irc.test FAIL PERSISTENCE ACCOUNT_REQUIRED ATTACH :You must SASL-authenticate before PERSISTENCE ATTACH"
			);
			expect(h.client.serverReplay).to.equal(false);
			expect(h.client.attachCursor).to.equal(undefined);
			expect(h.messages()).to.deep.equal([]);
		});

		it("shows nothing for CURSOR_UNKNOWN, and keeps expecting the replay", function () {
			store({msgid: "m9", time: 123});
			const h = saslClient();
			authenticate(h);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			h.dispatch.resetHistory();

			h.transport.line(
				":irc.test FAIL PERSISTENCE CURSOR_UNKNOWN m9 :Cursor msgid not found; replaying from last activity"
			);
			expect(h.messages()).to.deep.equal([]);
			expect(h.client.serverReplay).to.equal(true);
		});

		it("still shows a PERSISTENCE failure that is not about the cursor", function () {
			const h = setup();
			register(h, `${ALL_CAPS} ${PERSISTENCE_WITH_CURSOR}`);
			h.transport.line(
				":irc.test FAIL PERSISTENCE INVALID_PARAMETERS SET :Unknown PERSISTENCE subcommand"
			);
			expect(h.lastMessage(h.client.lobby.id).text).to.match(
				/^PERSISTENCE: Unknown PERSISTENCE subcommand \(SET\) \[FAIL INVALID_PARAMETERS\]$/
			);
		});
	});

	describe("the server-driven replay", function () {
		/** Registered with the cursor accepted and #seance restored. */
		function resumed(): Harness {
			store({msgid: "m9", time: Date.parse("2026-08-28T11:00:00.000Z")});
			const h = saslClient();
			authenticate(h);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			restore(h);
			h.dispatch.resetHistory();
			h.sent();
			return h;
		}

		it("history arriving in the channel being looked at marks it read", function () {
			const h = saslClient();
			h.client.open(h.client.findChannel("#seance")!.id);
			authenticate(h, `${SASL_CAPS} draft/read-marker`);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			restore(h); // a quiet JOIN: no line of its own to read
			batch(
				h,
				[
					"@time=2026-08-28T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :one",
					"@time=2026-08-28T11:01:00.000Z;msgid=h2 :bob!bob@host PRIVMSG #seance :two",
				],
				{label: labelOf(h.transport.sent)}
			);
			h.sent();
			clock.tick(MARKREAD_DEBOUNCE_MS);
			expect(h.sent()).to.include("MARKREAD #seance timestamp=2026-08-28T11:01:00.000Z");
		});

		it("appends the replay as messages, not as older history, and dedupes by msgid", function () {
			const h = resumed();
			const id = h.client.findChannel("#seance")!.id;
			bouncerReplay(h, "#seance", [
				"@time=2026-08-28T11:30:00.000Z;msgid=r1 :bob!bob@host PRIVMSG #seance :missed one",
				"@time=2026-08-28T11:31:00.000Z;msgid=r2 :bob!bob@host PRIVMSG #seance :missed two",
			]);

			expect(h.payloads("more")).to.deep.equal([]);
			const messages: SharedMsg[] = h.messages(id);
			expect(messages.map((m) => m.text)).to.deep.equal(["missed one", "missed two"]);
			expect(messages.map((m) => m.id)).to.deep.equal(messages.map((m) => m.id).sort());
			expect(messages.every((m) => m.id > 0)).to.equal(true);
			expect(messages.every((m) => !m.highlight)).to.equal(true);
			expect(h.client.findChannel("#seance")!.newestRef?.msgid).to.equal("r2");
			expect(h.client.cursor?.msgid).to.equal("r2");

			// A second delivery of the same batch adds nothing.
			h.dispatch.resetHistory();
			bouncerReplay(h, "#seance", [
				"@time=2026-08-28T11:31:00.000Z;msgid=r2 :bob!bob@host PRIVMSG #seance :missed two",
				"@time=2026-08-28T11:32:00.000Z;msgid=r3 :bob!bob@host PRIVMSG #seance :missed three",
			]);
			expect(h.messages(id).map((m) => m.text)).to.deep.equal(["missed three"]);
		});

		it("opens a query window for a private message in the gap", function () {
			const h = resumed();
			bouncerReplay(h, "bob", [
				"@time=2026-08-28T11:30:00.000Z;msgid=p1 :bob!bob@host PRIVMSG alice :you there?",
			]);
			const query = h.client.findChannel("bob")!;
			expect(query, "query window opened").to.not.equal(undefined);
			expect(h.messages(query.id).map((m) => m.text)).to.deep.equal(["you there?"]);
		});

		it("asks for a query's read marker once the replay leaves it unread", function () {
			store({msgid: "m9", time: Date.parse("2026-08-28T11:00:00.000Z")});
			const h = saslClient();
			authenticate(h, `${SASL_CAPS} draft/read-marker`);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			restore(h);
			clock.tick(MARKREAD_DEBOUNCE_MS * 10);
			h.sent();

			// The private message was read on another device: only the
			// server's marker can say so.
			bouncerReplay(h, "bob", [
				"@time=2026-08-28T11:30:00.000Z;msgid=p1 :bob!bob@host PRIVMSG alice :you there?",
			]);
			const query = h.client.findChannel("bob")!;
			expect(query.shared.unread).to.equal(1);
			clock.tick(MARKREAD_DEBOUNCE_MS * 10);
			expect(h.sent()).to.include("MARKREAD bob");
			h.transport.line(":irc.test MARKREAD bob timestamp=2026-08-28T11:30:00.000Z");
			expect(query.shared.unread).to.equal(0);
		});

		it("hides the closing NOTICE while the session is settling, and shows it later", function () {
			const h = resumed();
			h.transport.line(
				":irc.test NOTICE alice :Session resumed. Replayed 4 message(s) from 2 channel(s)."
			);
			expect(h.messages()).to.deep.equal([]);

			// Outside the settling window it is an ordinary server notice.
			clock.tick(60_000);
			h.transport.line(
				":irc.test NOTICE alice :Session resumed. Replayed 4 message(s) from 2 channel(s)."
			);
			expect(h.lastMessage(h.client.lobby.id).text).to.match(/^Session resumed\./);
			expect(h.lastMessage(h.client.lobby.id).type).to.equal(MessageType.NOTICE);
		});
	});

	describe("standing down the per-channel catch-up", function () {
		/** Connect, hold #seance with a message, drop; then re-register. */
		function reconnect(h: Harness, caps = SASL_CAPS, accept = true): void {
			h.client.open(h.client.findChannel("#seance")!.id);
			authenticate(h, caps);
			finishRegistration(h);
			h.transport.lines(
				"@time=2026-08-28T12:00:01.000Z;msgid=join-1 :alice!alice@host JOIN #seance",
				":irc.test 353 alice = #seance :@alice bob",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			batch(h, [], {label: labelOf(h.sent())});
			h.transport.line(
				"@time=2026-08-28T12:00:02.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
			);

			h.transport.closed();
			authenticate(h, caps);

			if (accept) {
				h.transport.line(":irc.test PERSISTENCE ATTACH default");
			} else {
				h.transport.line(
					":irc.test FAIL PERSISTENCE INVALID_PARAMETERS ATTACH default :No such profile"
				);
			}

			finishRegistration(h, HOLD);
			h.sent();
			restore(h);
		}

		it("asks for no CHATHISTORY when the cursor was accepted", function () {
			const h = saslClient();
			reconnect(h);

			expect(h.client.serverReplay).to.equal(true);
			expect(h.transport.sent).to.include("PERSISTENCE ATTACH default m1");
			expect(chathistory(h.sent())).to.deep.equal([]);
			expect(h.sent().filter((l) => l.startsWith("JOIN"))).to.deep.equal([]);
		});

		it("re-asks a `more` page the drop swallowed, once the server gave the channel back", function () {
			const h = saslClient();
			h.client.open(h.client.findChannel("#seance")!.id);
			authenticate(h);
			finishRegistration(h);
			h.transport.lines(
				"@time=2026-08-28T12:00:01.000Z;msgid=join-1 :alice!alice@host JOIN #seance",
				":irc.test 353 alice = #seance :@alice bob",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			batch(h, [], {label: labelOf(h.sent())});
			h.transport.line(
				"@time=2026-08-28T12:00:02.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
			);

			// The user scrolls up; the socket dies before the page comes back.
			const chan = h.client.findChannel("#seance")!;
			expect(requestMore(h.client, chan, chan.idByMsgid.get("m1")!)).to.equal(true);
			expect(chathistory(h.sent())[0]).to.match(/CHATHISTORY BEFORE #seance msgid=m1 100$/);
			h.transport.closed();

			authenticate(h);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			h.sent();
			restore(h);

			// The cursor's replay covers the gap, so the channel asks for no
			// LATEST — but the lost page is asked again.
			expect(h.client.serverReplay).to.equal(true);
			const asked = chathistory(h.sent());
			expect(asked).to.have.length(1);
			expect(asked[0]).to.match(/CHATHISTORY BEFORE #seance msgid=m1 100$/);
		});

		it("keeps the old dance when the cursor was refused", function () {
			const h = saslClient();
			reconnect(h, SASL_CAPS, false);

			expect(h.client.serverReplay).to.equal(false);
			expect(chathistory(h.sent())).to.have.length(1);
			// The resumed session's AWAY (presence.ts: no mute list to wait
			// for here) goes out once on the reconnect, at registration: after
			// CAP END and before what the registration starts (the catch-up,
			// and PERSISTENCE SET once the restoration is in).
			const all = h.transport.sent;
			const end = all.lastIndexOf("CAP END");
			expect(all.slice(end).filter((l) => l === "AWAY")).to.have.length(1);
			expect(all.slice(end, end + 2)).to.deep.equal(["CAP END", "AWAY"]);
			expect(all.slice(end)).to.include("PERSISTENCE SET ON");
			expect(
				all.slice(end).some((l) => /CHATHISTORY LATEST #seance \* \d+$/.test(l))
			).to.equal(true);
		});

		it("keeps the old dance when the server has no attach-cursor token", function () {
			const h = saslClient();
			reconnect(h, `${ALL_CAPS} sasl=PLAIN ${PERSISTENCE_NO_CURSOR}`);

			expect(h.transport.sent.some((l) => l.startsWith("PERSISTENCE ATTACH"))).to.equal(
				false
			);
			expect(h.transport.sent).to.include("PERSISTENCE SET ON");
			expect(chathistory(h.sent())).to.have.length(1);
		});

		it("still fills a channel it holds nothing for, and catches up one it joins itself", function () {
			store({msgid: "m9", time: Date.parse("2026-08-28T11:00:00.000Z")});
			const h = saslClient({join: "#seance,#other"});
			authenticate(h);
			h.transport.line(":irc.test PERSISTENCE ATTACH default");
			finishRegistration(h, HOLD);
			h.client.open(h.client.findChannel("#seance")!.id);
			h.sent();
			restore(h);

			const sent = h.sent();
			// #seance was restored but this page load holds nothing for it:
			// the LATEST fill still goes out.
			expect(chathistory(sent).some((l) => /CHATHISTORY LATEST #seance/.test(l))).to.equal(
				true
			);
			// #other was not restored: the autojoin covers it as before.
			expect(sent.filter((l) => l.startsWith("JOIN"))).to.deep.equal(["JOIN #other"]);

			// …and its reply is still older history, not part of the replay,
			// even though the server's catch-up is running.
			batch(
				h,
				["@time=2026-08-28T09:00:00.000Z;msgid=old1 :bob!bob@host PRIVMSG #seance :older"],
				{label: labelOf(sent)}
			);
			const id = h.client.findChannel("#seance")!.id;
			expect(h.payloads<{chan: number}>("more").map((p) => p.chan)).to.deep.equal([id]);
			expect(h.messages(id)).to.deep.equal([]);
		});
	});
});
