import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {CATCHUP_STEP_COST_MS, MARKER_HOLD_MS} from "../../client/js/irc/catchup";
import {MARKREAD_DEBOUNCE_MS} from "../../client/js/irc/handlers/markread";
import * as saved from "../../client/js/irc/saved-networks";
import {
	MAX_CHARS,
	MAX_MESSAGES,
	MAX_QUERIES,
	QUERY_LOG_PREFIX,
	QueryLog,
	SAVE_DELAY_MS,
	setQueryLogEnabled,
	StorageBackend,
	useStorageBackend,
} from "../../client/js/irc/querylog";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";

/** In-memory stand-in for the localStorage wrapper. */
class MemoryBackend implements StorageBackend {
	data = new Map<string, string>();

	get(key: string): string | null {
		return this.data.has(key) ? (this.data.get(key) as string) : null;
	}

	set(key: string, value: string): void {
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}

	keys(): string[] {
		return [...this.data.keys()];
	}
}

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.state = "connecting";
	}

	send(raw: string): void {
		this.sent.push(raw);
	}

	close(): void {
		this.state = "closed";
	}

	probe(): void {
		// nothing to probe
	}

	abandon(): void {
		this.state = "closed";
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(raw: string): void {
		this.emit({type: "line", line: raw});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const UUID = "22222222-2222-4222-8222-222222222222";
const fold = (s: string) => s.toLowerCase();

function line(overrides: Partial<SharedMsg> = {}): SharedMsg {
	return {
		id: 1,
		time: new Date("2026-09-26T10:00:00.000Z"),
		type: MessageType.MESSAGE,
		from: {nick: "bob", mode: ""},
		text: "hi",
		...overrides,
	};
}

/** `n` lines a minute apart from 10:00, msgids m0…m(n-1). */
function lines(n: number, text = (i: number) => `line ${i}`): SharedMsg[] {
	return Array.from({length: n}, (_, i) =>
		line({
			msgid: `m${i}`,
			time: new Date(Date.UTC(2026, 8, 26, 10, i)),
			text: text(i),
		})
	);
}

describe("Query log (irc/querylog.ts)", function () {
	let backend: MemoryBackend;
	let savedBackend: MemoryBackend;
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		backend = new MemoryBackend();
		savedBackend = new MemoryBackend();
		useStorageBackend(backend);
		saved.useStorageBackend(savedBackend);
		clock = sinon.useFakeTimers({
			now: Date.UTC(2026, 8, 26, 12),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		setQueryLogEnabled(true);
		useStorageBackend(null);
		saved.useStorageBackend(null);
	});

	const stored = (): unknown => JSON.parse(backend.get(QUERY_LOG_PREFIX + UUID) ?? "null");

	describe("the log", function () {
		it("keeps messages, actions and notices, writes on a trailing throttle and reads them back", function () {
			const log = new QueryLog(UUID, fold);
			log.append("Bob", line({msgid: "a", text: "hello"}));
			log.append("bob", line({msgid: "b", type: MessageType.ACTION, text: "waves"}));
			log.append("bob", line({msgid: "c", type: MessageType.NOTICE, text: "note"}));
			log.append("bob", line({msgid: "d", type: MessageType.ERROR, text: "no"}));
			log.append("bob", line({msgid: "e", type: undefined, text: "status"}));
			log.append("bob", line({msgid: "f", pending: true, text: "sending"}));

			expect(stored()).to.equal(null);
			clock.tick(SAVE_DELAY_MS);

			const again = new QueryLog(UUID, fold);
			expect(again.names()).to.deep.equal(["Bob"]);
			const back = again.messages("BOB");
			expect(back.map((m) => [m.msgid, m.type, m.text])).to.deep.equal([
				["a", MessageType.MESSAGE, "hello"],
				["b", MessageType.ACTION, "waves"],
				["c", MessageType.NOTICE, "note"],
			]);
			expect(back[0].time).to.be.an.instanceOf(Date);
			expect(back[0].from).to.deep.equal({nick: "bob", mode: ""});
			expect(back[0].previews).to.equal(undefined);
			log.dispose();
			again.dispose();
		});

		it("drops a line it already holds by msgid and keeps lines in time order", function () {
			const log = new QueryLog(UUID, fold);
			const [a, b, c] = lines(3);
			log.append("bob", c);
			log.append("bob", a); // an older page arrives later
			log.append("bob", b);
			log.append("bob", {...b, text: "again"});

			expect(log.messages("bob").map((m) => m.text)).to.deep.equal([
				"line 0",
				"line 1",
				"line 2",
			]);
			log.dispose();
		});

		it(`keeps the newest ${MAX_MESSAGES} lines of a query`, function () {
			const log = new QueryLog(UUID, fold);
			lines(MAX_MESSAGES + 5).forEach((m) => log.append("bob", m));

			const kept = log.messages("bob");
			expect(kept).to.have.length(MAX_MESSAGES);
			expect(kept[0].text).to.equal("line 5");
			log.dispose();
		});

		it(`keeps the ${MAX_QUERIES} most recently active queries`, function () {
			const log = new QueryLog(UUID, fold);

			for (let i = 0; i <= MAX_QUERIES; i++) {
				log.append(
					`nick${i}`,
					line({msgid: `q${i}`, time: new Date(Date.UTC(2026, 8, 26, 10, i))})
				);
			}

			log.flush();
			const names = new QueryLog(UUID, fold).names();
			expect(names).to.have.length(MAX_QUERIES);
			expect(names[0]).to.equal(`nick${MAX_QUERIES}`);
			expect(names).not.to.include("nick0");
			log.dispose();
		});

		it("stays inside its size budget, oldest conversation first", function () {
			const log = new QueryLog(UUID, fold);
			const long = "x".repeat(2000);

			// Two conversations of ~120 lines × 2 kB: both cannot fit.
			for (let i = 0; i < 120; i++) {
				log.append(
					"old",
					line({msgid: `o${i}`, time: new Date(Date.UTC(2026, 8, 25, 10, i)), text: long})
				);
				log.append(
					"new",
					line({msgid: `n${i}`, time: new Date(Date.UTC(2026, 8, 26, 10, i)), text: long})
				);
			}

			log.flush();
			const raw = backend.get(QUERY_LOG_PREFIX + UUID) as string;
			expect(raw.length).to.be.at.most(MAX_CHARS);
			const again = new QueryLog(UUID, fold);
			expect(again.names()).to.deep.equal(["new"]);
			expect(again.messages("new").at(-1)?.msgid).to.equal("n119");
			log.dispose();
		});

		it("folds an edit into the line it replaces and follows redactions and reactions", function () {
			const log = new QueryLog(UUID, fold);
			const [a, b] = lines(2);
			log.append("bob", a);
			log.append("bob", b);
			log.append(
				"bob",
				line({
					msgid: "e1",
					time: new Date(Date.UTC(2026, 8, 26, 11)),
					text: "line 0, fixed",
				})
			);

			log.edit("bob", "m0", "e1");
			log.react("bob", "m1", "👍", "alice", false);
			log.react("bob", "m1", "👍", "Bob", false);
			log.react("bob", "m1", "👍", "ALICE", true);

			let kept = log.messages("bob");
			expect(kept.map((m) => m.text)).to.deep.equal(["line 0, fixed", "line 1"]);
			expect(kept[0].editedAt?.toISOString()).to.equal("2026-09-26T11:00:00.000Z");
			expect(log.aliases("bob")).to.deep.equal([["e1", 0]]);
			expect(kept[1].reactions).to.deep.equal([{text: "👍", nicks: ["Bob"]}]);

			// A redaction reaches the line by its edit's msgid too.
			log.redact("bob", "e1");
			kept = log.messages("bob");
			expect(kept.map((m) => m.msgid)).to.deep.equal(["m1"]);
			log.dispose();
		});

		it("forgets a closed query, and a removed network's whole log", function () {
			const log = new QueryLog(UUID, fold);
			log.append("bob", line({msgid: "a"}));
			log.append("carol", line({msgid: "b"}));
			log.forget("BOB");
			log.flush();
			expect(new QueryLog(UUID, fold).names()).to.deep.equal(["carol"]);

			saved.save({
				uuid: UUID,
				name: "",
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
			saved.remove(UUID);
			expect(stored()).to.equal(null);
			expect(log.names()).to.deep.equal([]);
			log.dispose();
		});

		it("switched off: deletes every kept conversation and keeps nothing more", function () {
			const log = new QueryLog(UUID, fold);
			log.append("bob", line({msgid: "a"}));
			log.flush();
			// A network no client holds right now: its log goes too.
			const other = `${QUERY_LOG_PREFIX}33333333-3333-4333-8333-333333333333`;
			backend.set(other, JSON.stringify({v: 1, queries: []}));
			backend.set("thelounge.networks", "[]");

			setQueryLogEnabled(false);
			expect(stored()).to.equal(null);
			expect(backend.get(other)).to.equal(null);
			expect(backend.get("thelounge.networks")).to.equal("[]"); // nothing else touched
			expect(log.names()).to.deep.equal([]);

			log.append("bob", line({msgid: "b"}));
			clock.tick(SAVE_DELAY_MS);
			expect(stored()).to.equal(null);
			expect(new QueryLog(UUID, fold).names()).to.deep.equal([]);

			// On again: kept from then on, nothing from while it was off.
			setQueryLogEnabled(true);
			log.append("bob", line({msgid: "c"}));
			clock.tick(SAVE_DELAY_MS);
			expect(new QueryLog(UUID, fold).messages("bob").map((m) => m.msgid)).to.deep.equal([
				"c",
			]);
			log.dispose();
		});

		it("writes nothing for a network that is not saved", function () {
			const log = new QueryLog(UUID, fold, () => false);
			log.append("bob", line({msgid: "a"}));
			clock.tick(SAVE_DELAY_MS);
			expect(stored()).to.equal(null);
			expect(log.messages("bob")).to.have.length(1);
			log.dispose();
		});
	});

	describe("in the client", function () {
		let dispatch: sinon.SinonSpy;
		let ownsSpy = false;
		const clients: IrcClient[] = [];

		beforeEach(function () {
			const current = (socket as unknown as Record<string, unknown>).dispatch;

			if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
				dispatch = current as sinon.SinonSpy;
				ownsSpy = false;
			} else {
				dispatch = sinon.spy(socket, "dispatch");
				ownsSpy = true;
			}

			dispatch.resetHistory();
			saved.save({
				uuid: UUID,
				name: "",
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#seance",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
		});

		afterEach(function () {
			clients.splice(0).forEach((c) => c.queryLog.dispose());

			if (ownsSpy) {
				dispatch.restore();
			}
		});

		function payloads<T>(event: string): T[] {
			return dispatch
				.getCalls()
				.filter((call) => call.args[0] === event)
				.map((call) => call.args[1] as T);
		}

		/** A client on the saved network, registered. */
		function page(caps = "message-tags server-time echo-message"): {
			client: IrcClient;
			transport: FakeTransport;
		} {
			const transport = new FakeTransport();
			const client = new IrcClient({
				uuid: UUID,
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#seance",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
				ids: new IdAllocator(),
				transportFactory: () => transport,
				highlights: () => ({keywords: [], exceptions: []}),
			});
			clients.push(client);
			client.connect();
			transport.open();
			transport.line(`:irc.test CAP * LS :${caps}`);
			transport.line(`:irc.test CAP alice ACK :${caps}`);
			transport.line(":irc.test 001 alice :Welcome");
			transport.line(":irc.test 422 alice :MOTD File is missing");
			return {client, transport};
		}

		it("brings a private conversation back after a reload, window and lines", function () {
			const first = page();
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			first.transport.line(
				"@time=2026-09-26T11:01:00.000Z;msgid=p2 :alice!a@h PRIVMSG bob :yes"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			// The page is reloaded: a new client for the same saved network.
			dispatch.resetHistory();
			const second = page();
			const network =
				payloads<{network: {channels: {name: string; type: ChanType}[]}}>("network")[0];
			expect(network.network.channels.map((c) => [c.name, c.type])).to.deep.include([
				"bob",
				ChanType.QUERY,
			]);

			const query = second.client.findChannel("bob")!;
			const more =
				payloads<{chan: number; messages: SharedMsg[]; moreAvailable: boolean}>("more");
			expect(more).to.have.length(1);
			expect(more[0].chan).to.equal(query.id);
			expect(more[0].moreAvailable).to.equal(false);
			expect(more[0].messages.map((m) => [m.text, m.self ?? false])).to.deep.equal([
				["are you there?", false],
				["yes", true],
			]);
			expect(more[0].messages.every((m) => m.id < 0)).to.equal(true);
			// Known by msgid, so a server replay of the same lines is deduplicated.
			expect(query.idOf("p1")).to.equal(more[0].messages[0].id);
		});

		it("keeps an unread private message unread across a reload, until it is read elsewhere", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			const query = first.client.findChannel("bob")!;
			first.client.open(query.id); // read it
			first.client.open(first.client.lobby.id);
			first.transport.line(
				"@time=2026-09-26T11:05:00.000Z;msgid=p2 :bob!b@h PRIVMSG alice :hello?"
			);
			expect(query.shared.unread).to.equal(1);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			dispatch.resetHistory();
			const second = page(caps);
			const restored = second.client.findChannel("bob")!;
			expect(restored.shared.unread, "p2 was never read").to.equal(1);
			expect(restored.shared.highlight).to.equal(1);
			expect(payloads<{chan: number; unread: number}>("markread").pop()).to.include({
				chan: restored.id,
				unread: 1,
			});

			// The server is asked for the query's marker, behind the channels,
			// and lowers the count: p2 was read on another device.
			clock.tick(CATCHUP_STEP_COST_MS * 10);
			expect(second.transport.sent).to.include("MARKREAD bob");
			second.transport.line(":irc.test MARKREAD bob timestamp=2026-09-26T11:05:00.000Z");
			expect(restored.shared.unread).to.equal(0);
		});

		it("still asks for a query's read marker when it is opened with nobody looking", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			first.transport.line(
				"@time=2026-09-26T11:01:00.000Z;msgid=p2 :carol!c@h PRIVMSG alice :hi"
			);
			first.transport.line(
				"@time=2026-09-26T11:02:00.000Z;msgid=p3 :dave!d@h PRIVMSG alice :hey"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			// The markers go out as the fake-lag clock has room; dave's waits.
			const second = page(caps);
			const dave = second.client.findChannel("dave")!;
			expect(second.transport.sent).not.to.include("MARKREAD dave");

			// A cold start on a deep link with the page hidden: the open reads nothing.
			second.client.setAttended(false);
			second.client.open(dave.id);
			expect(dave.shared.unread).to.equal(1);

			clock.tick(CATCHUP_STEP_COST_MS * 10);
			expect(second.transport.sent).to.include("MARKREAD bob");
			expect(second.transport.sent).to.include("MARKREAD dave");
		});
		it("queues no marker fetch for a server without read markers, and spends no slot", function () {
			const caps =
				"message-tags server-time echo-message batch labeled-response draft/chathistory=100";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const second = page(caps);
			expect(second.client.findChannel("bob")!.shared.unread).to.equal(1);
			clock.tick(CATCHUP_STEP_COST_MS * 2);
			expect(second.transport.sent.filter((l) => l.startsWith("MARKREAD"))).to.deep.equal([]);

			// The JOIN echoes after the slot a marker would have taken: the
			// channel's catch-up goes out on it, held behind nothing.
			const n = second.transport.sent.length;
			second.transport.line(":alice!a@h JOIN #seance");
			expect(second.transport.sent.slice(n).some((l) => l.includes("CHATHISTORY"))).to.equal(
				true
			);
		});

		it("asks for a query's marker once per connection, however often autojoin runs", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const second = page(caps);
			clock.tick(CATCHUP_STEP_COST_MS * 10);
			const asked = () => second.transport.sent.filter((l) => l === "MARKREAD bob").length;
			expect(asked()).to.equal(1);

			// A held session's restoration runs autojoin() again, seconds later.
			second.client.autojoin();
			clock.tick(CATCHUP_STEP_COST_MS * 10);
			expect(asked()).to.equal(1);
		});

		it("asks at once for the marker of a query a late replay leaves unread", function () {
			const caps =
				"message-tags server-time echo-message batch labeled-response draft/chathistory=100 draft/read-marker draft/persistence";
			const h = page(caps);
			h.transport.line(":alice!a@h JOIN #seance");
			clock.tick(10 * 60 * 1000); // the queue drained long ago
			const n = h.transport.sent.length;
			h.transport.line(":irc.test BATCH +r evilnet.github.io/bouncer-replay");
			h.transport.line("@batch=r :irc.test BATCH +c chathistory bob");
			h.transport.line(
				"@batch=c;time=2026-09-26T11:02:00.000Z;msgid=p2 :bob!b@h PRIVMSG alice :hello?"
			);
			h.transport.line(":irc.test BATCH -c");
			h.transport.line(":irc.test BATCH -r");
			expect(h.client.findChannel("bob")!.shared.unread).to.equal(1);
			expect(h.transport.sent.slice(n), "no slot to wait for").to.include("MARKREAD bob");
		});

		it("a query opened with someone looking keeps its fetch, which then has nothing to lower", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			first.transport.line(
				"@time=2026-09-26T11:01:00.000Z;msgid=p2 :carol!c@h PRIVMSG alice :hi"
			);
			first.transport.line(
				"@time=2026-09-26T11:02:00.000Z;msgid=p3 :dave!d@h PRIVMSG alice :hey"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const second = page(caps);
			const dave = second.client.findChannel("dave")!;
			expect(second.transport.sent).not.to.include("MARKREAD dave");
			second.client.open(dave.id);
			expect(dave.shared.unread).to.equal(0);
			clock.tick(CATCHUP_STEP_COST_MS * 10);
			expect(second.transport.sent.filter((l) => l === "MARKREAD dave")).to.deep.equal([]);
		});
		it("a query's marker never holds up a channel's catch-up", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const second = page(caps);
			const sent = second.transport.sent;
			expect(sent).to.include("JOIN #seance");
			expect(sent, "held until the JOIN echoes").not.to.include("MARKREAD bob");

			// The channel's catch-up goes out on its echo, whatever the
			// query's marker has spent of the clock.
			second.transport.line(":alice!a@h JOIN #seance");
			expect(sent).to.include("MARKREAD #seance");
			expect(sent.indexOf("MARKREAD #seance")).to.be.lessThan(
				sent.indexOf("MARKREAD bob") === -1 ? Infinity : sent.indexOf("MARKREAD bob")
			);

			clock.tick(CATCHUP_STEP_COST_MS * 10);
			expect(sent.filter((l) => l === "MARKREAD bob")).to.have.length(1);
		});
		it("asks for a query's marker after MARKER_HOLD_MS when a JOIN never echoes", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			// #seance's JOIN is refused: no echo ever releases the hold.
			const second = page(caps);
			second.transport.line(":irc.test 474 alice #seance :Cannot join channel (+b)");
			clock.tick(MARKER_HOLD_MS - 1);
			expect(second.transport.sent).not.to.include("MARKREAD bob");
			clock.tick(1);
			expect(second.transport.sent).to.include("MARKREAD bob");
		});

		it("keeps a query read here read across a reload on a server without read markers", function () {
			const first = page();
			first.client.open(first.client.announceChannel("bob", ChanType.QUERY).id);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			first.transport.line(
				"@time=2026-09-26T11:01:00.000Z;msgid=p2 :bob!b@h PRIVMSG alice :hi"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const bob = page().client.findChannel("bob")!;
			expect(bob.shared.unread).to.equal(0);
			expect(bob.shared.highlight).to.equal(0);
		});

		it("marks a query read before registration once the connection registers", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const transport = new FakeTransport();
			const second = new IrcClient({
				uuid: UUID,
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#seance",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
				ids: new IdAllocator(),
				transportFactory: () => transport,
				highlights: () => ({keywords: [], exceptions: []}),
			});
			clients.push(second);
			// The reloaded page lands on the query once the network is
			// announced, before its socket registers.
			second.connect();
			const bob = second.findChannel("bob")!;
			second.open(bob.id);
			transport.open();
			transport.line(`:irc.test CAP * LS :${caps}`);
			transport.line(`:irc.test CAP alice ACK :${caps}`);
			clock.tick(MARKREAD_DEBOUNCE_MS);
			expect(transport.sent.filter((l) => l.startsWith("MARKREAD"))).to.deep.equal([]);
			transport.line(":irc.test 001 alice :Welcome");
			transport.line(":irc.test 422 alice :MOTD File is missing");
			expect(transport.sent).to.include("MARKREAD bob timestamp=2026-09-26T11:00:00.000Z");
			clock.tick(SAVE_DELAY_MS);
			second.queryLog.dispose();

			expect(page(caps).client.findChannel("bob")!.shared.unread).to.equal(0);
		});

		it("keeps a private message read as it arrived read across a reload", function () {
			const caps = "message-tags server-time echo-message draft/read-marker";
			const first = page(caps);
			first.client.open(first.client.announceChannel("bob", ChanType.QUERY).id);
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :are you there?"
			);
			clock.tick(SAVE_DELAY_MS);
			first.client.queryLog.dispose();

			const second = page(caps);
			expect(second.client.findChannel("bob")!.shared.unread).to.equal(0);
		});

		it("follows an edit and a reaction in a query, and forgets a closed one", function () {
			const first = page();
			first.transport.line(
				"@time=2026-09-26T11:00:00.000Z;msgid=p1 :bob!b@h PRIVMSG alice :helo"
			);
			first.transport.line(
				"@time=2026-09-26T11:00:05.000Z;msgid=p2;+seance/edit=p1 :bob!b@h PRIVMSG alice :hello"
			);
			first.transport.line("@+draft/react=👋;+draft/reply=p1 :alice!a@h TAGMSG bob");
			clock.tick(SAVE_DELAY_MS);

			const log = new QueryLog(UUID, fold);
			const kept = log.messages("bob");
			expect(kept.map((m) => m.text)).to.deep.equal(["hello"]);
			expect(kept[0].reactions).to.deep.equal([{text: "👋", nicks: ["alice"]}]);
			log.dispose();

			first.client.removeChannel(first.client.findChannel("bob")!);
			clock.tick(SAVE_DELAY_MS);
			expect(stored()).to.equal(null);
		});
	});
});
