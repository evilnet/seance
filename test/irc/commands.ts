import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import storage from "../../client/js/localStorage";
import {IrcClient, IrcClientOptions} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {commandNames} from "../../client/js/irc/commands";
import {loadAliases} from "../../client/js/helpers/aliases";
import {ignoreListFor} from "../../client/js/ignore";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {ChanType, SpecialChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import type {SharedNetworkChan} from "../../shared/types/network";

/** In-memory transport driven by the tests (same shape as test/irc/client.ts). */
class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	connectCalls = 0;
	closeCalls: {code: number; reason: string}[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.connectCalls++;
		this.state = "connecting";
	}

	send(line: string): void {
		if (this.state !== "open") {
			throw new Error("WsTransport: not open");
		}

		this.sent.push(line);
	}

	close(code = 1000, reason = ""): void {
		this.closeCalls.push({code, reason});
		this.state = "closed";
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.line(line));
	}

	closed(code: number, reason = ""): void {
		this.state = "closed";
		this.emit({
			type: "close",
			code,
			reason,
			wasClean: code === 1000,
			willReconnect: false,
			delayMs: undefined,
		});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	sentAfter(): string[];
}

/** Bus spy the client under test dispatches to (not the app bus, so this
 * file can run alongside test/irc/client.ts, which spies on that one). */
let dispatch: sinon.SinonSpy;
let uuidCounter = 0;

function setup(overrides: Partial<IrcClientOptions> = {}): Harness {
	const transport = new FakeTransport();
	const client = new IrcClient({
		bus: {dispatch},
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance key",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		// A fresh uuid per test keeps the (module-cached) ignore lists apart.
		uuid: `test-net-${++uuidCounter}`,
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
		...overrides,
	});
	let mark = 0;

	return {
		client,
		transport,
		sentAfter() {
			const result = transport.sent.slice(mark);
			mark = transport.sent.length;
			return result;
		},
	};
}

function payloads<T = any>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

function messages(chanId?: number): SharedMsg[] {
	return payloads<{chan: number; msg: SharedMsg}>("msg")
		.filter((p) => chanId === undefined || p.chan === chanId)
		.map((p) => p.msg);
}

function lastMessage(chanId?: number): SharedMsg {
	const list = messages(chanId);
	return list[list.length - 1];
}

/** Register (with echo-message) and join #seance with a small NAMES burst. */
function joined(h: Harness, isupportExtra = "", capsExtra = ""): number {
	const ls = `echo-message multi-prefix ${capsExtra}`.trim();
	// ACK names the caps without their LS values.
	const ack = ls
		.split(" ")
		.map((cap) => cap.split("=")[0])
		.join(" ");

	h.client.connect();
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${ls}`);
	h.transport.line(`:irc.test CAP alice ACK :${ack}`);
	h.transport.lines(
		":irc.test 001 alice :Welcome",
		`:irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 ${isupportExtra} :are supported`,
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host.example JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob +carol",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	h.sentAfter();
	return h.client.findChannel("#seance")!.id;
}

describe("irc commands", function () {
	beforeEach(function () {
		dispatch = sinon.spy();
		const data = new Map<string, string>();
		sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
		sinon
			.stub(storage, "set")
			.callsFake((key: string, value: string) => void data.set(key, value));
		sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
	});

	afterEach(function () {
		sinon.restore();
		socket.unhandle("network:new");
	});

	it("lists every new command for autocompletion", function () {
		const names = commandNames();

		for (const name of [
			"/alias",
			"/ban",
			"/unban",
			"/banlist",
			"/kickban",
			"/exceptlist",
			"/kick",
			"/whois",
			"/list",
			"/mode",
			"/umode",
			"/op",
			"/deop",
			"/hop",
			"/dehop",
			"/voice",
			"/devoice",
			"/notice",
			"/ctcp",
			"/away",
			"/back",
			"/invite",
			"/invitelist",
			"/kill",
			"/rejoin",
			"/cycle",
			"/ignore",
			"/unignore",
			"/ignorelist",
			"/mute",
			"/unmute",
			"/disconnect",
			"/connect",
			"/server",
		]) {
			expect(names, name).to.include(name);
		}
	});

	describe("/ban family", function () {
		it("sends MODE +b / -b / b and KICK+ban for kickban", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ban *!*@evil.example");
			h.client.input(id, "/unban *!*@evil.example");
			h.client.input(id, "/banlist");
			h.client.input(id, "/kickban troll go away");
			h.client.input(id, "/kickban troll");
			h.client.input(id, "/exceptlist");
			expect(h.sentAfter()).to.deep.equal([
				"MODE #seance +b *!*@evil.example",
				"MODE #seance -b *!*@evil.example",
				"MODE #seance b",
				"KICK #seance troll :go away",
				"MODE #seance +b troll",
				"KICK #seance troll",
				"MODE #seance +b troll",
				"MODE #seance e",
			]);
		});

		it("uses the EXCEPTS mode letter for /exceptlist", function () {
			const h = setup();
			const id = joined(h, "EXCEPTS=X");
			h.client.input(id, "/exceptlist");
			expect(h.sentAfter()).to.deep.equal(["MODE #seance X"]);

			h.client.input(1, "/exceptlist");
			expect(lastMessage(1).text).to.equal(
				"exceptlist command can only be used in channels."
			);
			expect(h.sentAfter()).to.deep.equal([]);
		});

		it("rejects use outside channels and missing arguments", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(1, "/ban troll");
			expect(lastMessage(1).type).to.equal(MessageType.ERROR);
			expect(lastMessage(1).text).to.equal("ban command can only be used in channels.");

			h.client.input(id, "/unban");
			expect(lastMessage(id).text).to.equal("Usage: /unban <nick>");
			expect(h.sentAfter()).to.deep.equal([]);
		});
	});

	describe("/kick", function () {
		it("kicks with and without a reason, only in channels", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/kick bob");
			h.client.input(id, "/kick bob be nice");
			h.client.input(id, "/kick");
			expect(h.sentAfter()).to.deep.equal(["KICK #seance bob", "KICK #seance bob :be nice"]);

			h.client.input(1, "/kick bob");
			expect(lastMessage(1).text).to.equal("kick command can only be used in channels.");
			expect(h.sentAfter()).to.deep.equal([]);
		});
	});

	describe("/whois", function () {
		it("doubles a single nick so the remote server answers with idle time", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/whois bob");
			h.client.input(id, "/whois irc.other bob");
			h.client.input(id, "/whois");
			expect(h.sentAfter()).to.deep.equal(["WHOIS bob bob", "WHOIS irc.other bob", "WHOIS"]);
		});

		it("assembles the numerics into one whois message where the user is", function () {
			const h = setup();
			joined(h);
			h.transport.lines(
				":irc.test 311 alice bob ~bob host.example * :Bob Example",
				":irc.test 319 alice bob :@#seance +#other",
				":irc.test 319 alice bob :#third",
				":irc.test 312 alice bob irc.test :Test server",
				":irc.test 313 alice bob :is an IRC operator",
				":irc.test 301 alice bob :gone fishing",
				":irc.test 330 alice bob bobacct :is logged in as",
				":irc.test 338 alice bob ~real@10.0.0.1 10.0.0.1 :Actual user@host, Actual IP",
				":irc.test 378 alice bob :is connecting from *@real.example 10.0.0.2",
				":irc.test 379 alice bob :is using modes +iw",
				":irc.test 671 alice bob :is using a secure connection",
				":irc.test 276 alice bob :has client certificate fingerprint abc123",
				":irc.test 320 alice bob :is a cool person",
				":irc.test 307 alice bob :is a registered nick",
				":irc.test 317 alice bob 120 1700000000 :seconds idle, signon time",
				":irc.test 318 alice bob :End of /WHOIS list."
			);

			// No query window opens; the summary follows the user instead.
			expect(payloads("join")).to.have.length(0);

			const msg = lastMessage(1);
			expect(msg.type).to.equal(MessageType.WHOIS);
			expect(msg.showInActive).to.equal(true);
			expect(msg.whois).to.include({
				nick: "bob",
				ident: "~bob",
				hostname: "host.example",
				real_name: "Bob Example",
				channels: "@#seance +#other #third",
				server: "irc.test",
				server_info: "Test server",
				operator: "is an IRC operator",
				away: "gone fishing",
				account: "bobacct",
				actual_ip: "10.0.0.2",
				actual_hostname: "real.example",
				actual_username: "~real",
				modes: "is using modes +iw",
				secure: true,
				registered_nick: "is a registered nick",
				idle: "120",
				logon: "1700000000",
				logonTime: 1700000000 * 1000,
			});
			expect(msg.whois.certfps).to.deep.equal(["has client certificate fingerprint abc123"]);
			expect(msg.whois.special).to.deep.equal(["is a cool person"]);
			expect(msg.whois.idleTime).to.be.closeTo(Date.now() - 120 * 1000, 2000);
			expect(msg.whois.whowas).to.equal(undefined);
		});

		it("reports an unknown nick in the lobby without opening a window", function () {
			const h = setup();
			joined(h);
			h.transport.line(":irc.test 318 alice no/such :End of /WHOIS list.");
			expect(payloads("join")).to.have.length(0);
			expect(lastMessage(1).type).to.equal(MessageType.ERROR);
			expect(lastMessage(1).text).to.equal("No such nick: no/such");
			expect(lastMessage(1).showInActive).to.equal(true);
		});

		it("marks WHOWAS results and keeps the newest session", function () {
			const h = setup();
			joined(h);
			h.transport.lines(
				":irc.test 314 alice bob ~new host.new * :Newer",
				":irc.test 314 alice bob ~old host.old * :Older",
				":irc.test 369 alice bob :End of WHOWAS"
			);
			expect(payloads("join")).to.have.length(0);
			const msg = lastMessage(1);
			expect(msg.type).to.equal(MessageType.WHOIS);
			expect(msg.whois).to.include({whowas: true, ident: "~new", hostname: "host.new"});
		});

		it("shows a standalone 301 once in the query window", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/query bob");
			const query = h.client.findChannel("bob")!;
			h.transport.line(":irc.test 301 alice bob :gone fishing");
			h.transport.line(":irc.test 301 alice bob :gone fishing");
			const away = messages(query.id).filter((m) => m.type === MessageType.AWAY);
			expect(away).to.have.length(1);
			expect(away[0].text).to.equal("gone fishing");
			expect(away[0].from?.nick).to.equal("bob");
		});
	});

	describe("reply routing", function () {
		it("shows an asked-for topic again, following the user", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":irc.test 332 alice #seance :Welcome");
			expect(lastMessage(id).type).to.equal(MessageType.TOPIC);
			expect(lastMessage(id).showInActive).to.equal(undefined);

			h.client.input(id, "/topic");
			expect(h.sentAfter()).to.deep.equal(["TOPIC #seance"]);
			h.transport.lines(
				":irc.test 332 alice #seance :Welcome",
				":irc.test 333 alice #seance bob!bob@host 1756000000"
			);
			const [topic, setBy] = messages(id).slice(-2);
			expect(topic.type).to.equal(MessageType.TOPIC);
			expect(topic.showInActive).to.equal(true);
			expect(setBy.type).to.equal(MessageType.TOPIC_SET_BY);
			expect(setBy.showInActive).to.equal(true);
		});

		it("queries and sets the topic of a named channel", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				":alice!alice@host.example JOIN #other",
				":irc.test 366 alice #other :End of /NAMES list."
			);
			const other = h.client.findChannel("#other")!;
			h.sentAfter();

			h.client.input(id, "/topic #other");
			h.client.input(id, "/topic #other fresh paint");
			expect(h.sentAfter()).to.deep.equal(["TOPIC #other", "TOPIC #other :fresh paint"]);

			h.transport.line(":irc.test 332 alice #other :fresh paint");
			expect(lastMessage(other.id).type).to.equal(MessageType.TOPIC);
			expect(lastMessage(other.id).showInActive).to.equal(true);
		});

		it("shows the topic of a channel we are not in, in the lobby, once", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/topic #secret");
			expect(h.sentAfter()).to.deep.equal(["TOPIC #secret"]);

			h.transport.line(":irc.test 332 alice #secret :Hidden gem");
			expect(lastMessage(1).text).to.equal("Topic for #secret: Hidden gem");
			expect(lastMessage(1).showInActive).to.equal(true);

			// Unasked, the same numeric is state with nowhere to go.
			const before = messages().length;
			h.transport.line(":irc.test 332 alice #secret :Hidden gem");
			expect(messages()).to.have.length(before);

			h.client.input(id, "/topic #void");
			h.transport.line(":irc.test 331 alice #void :No topic is set");
			expect(lastMessage(1).text).to.equal("No topic is set for #void.");
			expect(lastMessage(1).showInActive).to.equal(true);
		});

		it("shows the modes of a channel we are not in, in the lobby, once", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/mode #secret");
			expect(h.sentAfter()).to.deep.equal(["MODE #secret"]);

			h.transport.line(":irc.test 324 alice #secret +ntk hunter2");
			expect(lastMessage(1).type).to.equal(MessageType.MODE_CHANNEL);
			expect(lastMessage(1).text).to.equal("#secret +ntk hunter2");
			expect(lastMessage(1).showInActive).to.equal(true);

			const before = messages().length;
			h.transport.line(":irc.test 324 alice #secret +ntk hunter2");
			expect(messages()).to.have.length(before);
		});

		it("shows unhandled numerics where the user is", function () {
			const h = setup();
			joined(h);
			h.transport.line(":irc.test 391 alice irc.test :Thursday afternoon");
			expect(lastMessage(1).type).to.equal(MessageType.UNHANDLED);
			expect(lastMessage(1).text).to.equal("391 irc.test Thursday afternoon");
			expect(lastMessage(1).showInActive).to.equal(true);
		});

		it("confirms /away and /back where the user is", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/away gone fishing");
			h.transport.line(":irc.test 306 alice :You have been marked as being away");
			expect(lastMessage(1).type).to.equal(MessageType.AWAY);
			expect(lastMessage(1).self).to.equal(true);
			expect(lastMessage(1).text).to.equal("You have been marked as being away");
			expect(lastMessage(1).showInActive).to.equal(true);

			h.client.input(id, "/back");
			h.transport.line(":irc.test 305 alice :You are no longer marked as being away");
			expect(lastMessage(1).type).to.equal(MessageType.BACK);
			expect(lastMessage(1).showInActive).to.equal(true);
		});
	});

	describe("/list", function () {
		it("sends LIST and builds the Channel List special window", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/list >10");
			expect(h.sentAfter()).to.deep.equal(["LIST >10"]);

			h.transport.line(":irc.test 321 alice Channel :Users  Name");
			const [join] = payloads<{chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(join.chan.type).to.equal(ChanType.SPECIAL);
			expect(join.chan.special).to.equal(SpecialChanType.CHANNELLIST);
			expect(join.chan.name).to.equal("Channel List");
			expect(join.chan.data).to.deep.equal({
				text: "Loading channel list, this can take a moment...",
			});
			expect(join.shouldOpen).to.equal(false);

			h.transport.lines(
				":irc.test 322 alice #small 3 :tiny",
				":irc.test 322 alice #big 42 :",
				":irc.test 322 alice #mid 10"
			);
			const specials = payloads<{chan: number; data: any}>("msg:special");
			expect(specials).to.have.length(3);
			expect(specials[2]).to.deep.equal({
				chan: join.chan.id,
				data: {text: "Loaded 3 channels..."},
			});

			h.transport.line(":irc.test 323 alice :End of /LIST");
			const final = payloads<{chan: number; data: any}>("msg:special").pop();
			expect(final?.data).to.deep.equal([
				{channel: "#big", num_users: 42, topic: ""},
				{channel: "#mid", num_users: 10, topic: ""},
				{channel: "#small", num_users: 3, topic: "tiny"},
			]);
			expect(h.client.findChannel("Channel List")!.shared.data).to.deep.equal(final?.data);
		});
	});

	describe("/mode family", function () {
		it("fills in the target for bare mode changes", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/mode +m");
			h.client.input(id, "/mode");
			h.client.input(id, "/mode #other +o bob");
			h.client.input(1, "/mode +i");
			h.client.input(id, "/umode -i");
			expect(h.sentAfter()).to.deep.equal([
				"MODE #seance +m",
				"MODE #seance",
				"MODE #other +o bob",
				"MODE alice +i",
				"MODE alice -i",
			]);
		});

		it("batches prefix shortcuts per the MODES limit", function () {
			const h = setup();
			const id = joined(h, "MODES=2");
			h.client.input(id, "/op bob carol dave");
			h.client.input(id, "/devoice  bob");
			h.client.input(id, "/hop bob");
			h.client.input(id, "/dehop bob");
			expect(h.sentAfter()).to.deep.equal([
				"MODE #seance +oo bob carol",
				"MODE #seance +o dave",
				"MODE #seance -v bob",
				"MODE #seance +h bob",
				"MODE #seance -h bob",
			]);
		});

		it("sends one MODE when MODES is unknown and validates the shortcuts", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/voice bob carol");
			expect(h.sentAfter()).to.deep.equal(["MODE #seance +vv bob carol"]);

			h.client.input(id, "/deop");
			expect(lastMessage(id).text).to.equal("Usage: /deop <nick> [...nick]");
			h.client.input(1, "/op bob");
			expect(lastMessage(1).text).to.equal("op command can only be used in channels.");
			expect(h.sentAfter()).to.deep.equal([]);
		});
	});

	describe("/notice and /ctcp", function () {
		it("sends NOTICE and ignores incomplete input", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/notice bob hello there");
			h.client.input(id, "/notice bob");
			expect(h.sentAfter()).to.deep.equal(["NOTICE bob :hello there"]);
		});

		it("sends a CTCP request and notes it locally", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ctcp bob version");
			h.client.input(id, "/ctcp bob ping 12345");
			expect(h.sentAfter()).to.deep.equal([
				"PRIVMSG bob :\x01VERSION\x01",
				"PRIVMSG bob :\x01PING 12345\x01",
			]);
			const note = messages(id).find((m) => m.type === MessageType.CTCP_REQUEST);
			expect(note?.ctcpMessage).to.equal('"VERSION" to bob');
			expect(note?.from).to.deep.equal({nick: "alice", mode: "@"});

			h.client.input(id, "/ctcp bob");
			expect(lastMessage(id).text).to.equal("Usage: /ctcp <nick> <ctcp_type>");
		});
	});

	describe("/away, /back, /kill, /invite", function () {
		it("sends AWAY with a reason, a placeholder space, or nothing for /back", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/away lunch time");
			h.client.input(id, "/away");
			h.client.input(id, "/back");
			expect(h.sentAfter()).to.deep.equal(["AWAY :lunch time", "AWAY : ", "AWAY"]);
		});

		it("sends KILL with the reason", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/kill troll spamming");
			h.client.input(id, "/kill");
			expect(h.sentAfter()).to.deep.equal(["KILL troll :spamming"]);
		});

		it("invites to the current or a named channel", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/invite bob");
			h.client.input(1, "/invite bob #other");
			h.client.input(id, "/invitelist");
			expect(h.sentAfter()).to.deep.equal([
				"INVITE bob #seance",
				"INVITE bob #other",
				"MODE #seance I",
			]);

			h.client.input(1, "/invite bob");
			expect(lastMessage(1).text).to.equal(
				"invite command can only be used in channels or by specifying a target."
			);
			h.client.input(1, "/invitelist");
			expect(lastMessage(1).text).to.equal(
				"invitelist command can only be used in channels."
			);
			expect(h.sentAfter()).to.deep.equal([]);
		});

		it("uses the INVEX mode letter for /invitelist", function () {
			const h = setup();
			const id = joined(h, "INVEX=X");
			h.client.input(id, "/invitelist");
			expect(h.sentAfter()).to.deep.equal(["MODE #seance X"]);
		});
	});

	describe("/rejoin", function () {
		it("parts and re-joins with the channel key", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/cycle");
			expect(h.sentAfter()).to.deep.equal(["PART #seance :Rejoining", "JOIN #seance key"]);

			h.client.input(1, "/rejoin");
			expect(lastMessage(1).text).to.equal("You can only rejoin channels.");
			expect(h.sentAfter()).to.deep.equal([]);
		});
	});

	describe("/ignore, /unignore, /ignorelist", function () {
		it("adds and removes entries with the old server's messages", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ignore Troll!*@evil.example");
			expect(lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(lastMessage(id).text).to.equal(
				"\u0002troll!*@evil.example\u000f added to ignorelist"
			);
			expect(ignoreListFor(h.client.uuid).list).to.have.length(1);

			h.client.input(id, "/ignore troll!abc@evil.example");
			expect(lastMessage(id).text).to.equal("The specified user/hostmask is already ignored");
			h.client.input(id, "/ignore alice");
			expect(lastMessage(id).text).to.equal("You can't ignore yourself");
			h.client.input(id, "/ignore");
			expect(lastMessage(id).text).to.equal("Usage: /ignore <nick>[!ident][@host]");

			h.client.input(id, "/unignore nobody");
			expect(lastMessage(id).text).to.equal("The specified user/hostmask is not ignored");
			h.client.input(id, "/unignore troll!*@evil.example");
			expect(lastMessage(id).text).to.equal(
				"Successfully removed \u0002troll!*@evil.example\u000f from ignorelist"
			);
			expect(ignoreListFor(h.client.uuid).list).to.have.length(0);
			expect(h.sentAfter()).to.deep.equal([]);
		});

		it("drops PRIVMSG, NOTICE and ACTION from ignored senders", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ignore *!*@*.evil.example");
			const before = messages().length;

			h.transport.lines(
				":troll!t@lair.evil.example PRIVMSG #seance :hi",
				":troll!t@lair.evil.example PRIVMSG alice :psst",
				":troll!t@lair.evil.example NOTICE #seance :notice",
				":troll!t@lair.evil.example PRIVMSG #seance :\x01ACTION waves\x01"
			);
			expect(messages()).to.have.length(before);
			expect(h.client.findChannel("troll")).to.equal(undefined);

			h.transport.line(":bob!b@nice.example PRIVMSG #seance :hello");
			expect(lastMessage(id).text).to.equal("hello");
		});

		it("still shows our own and server messages while ignoring", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ignore *!*@*");
			h.transport.line(":alice!alice@host.example PRIVMSG #seance :me too");
			expect(lastMessage(id).text).to.equal("me too");
			expect(lastMessage(id).self).to.equal(true);
			h.transport.line(":irc.test NOTICE alice :server notice");
			expect(lastMessage(1).text).to.equal("server notice");
		});

		it("works while disconnected", function () {
			const h = setup();
			h.client.input(1, "/ignore troll");
			expect(lastMessage(1).text).to.equal("\u0002troll!*@*\u000f added to ignorelist");
		});

		it("opens and refreshes the Ignored users window", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/ignorelist");
			expect(lastMessage(id).text).to.equal("Ignorelist is empty");

			h.client.input(id, "/ignore troll");
			h.client.input(id, "/ignorelist");
			const [join] = payloads<{chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(join.chan.type).to.equal(ChanType.SPECIAL);
			expect(join.chan.special).to.equal(SpecialChanType.IGNORELIST);
			expect(join.chan.name).to.equal("Ignored users");
			expect(join.chan.data).to.have.length(1);
			expect(join.chan.data[0].hostmask).to.equal("troll!*@*");
			expect(join.chan.data[0].when).to.be.a("number");

			h.client.input(id, "/ignore spammer");
			h.client.input(id, "/ignorelist");
			const [special] = payloads<{chan: number; data: {hostmask: string}[]}>("msg:special");
			expect(special.chan).to.equal(join.chan.id);
			expect(special.data.map((e) => e.hostmask)).to.deep.equal(["troll!*@*", "spammer!*@*"]);
		});
	});

	describe("/mute and /unmute", function () {
		it("flags the current or named channels through the mute hook", function () {
			const setMuteStatus = sinon.spy();
			const h = setup({setMuteStatus});
			const id = joined(h);
			h.client.input(id, "/mute");
			expect(h.client.findChannel("#seance")!.shared.muted).to.equal(true);
			expect(setMuteStatus.args).to.deep.equal([[id, true]]);

			h.client.input(1, "/unmute #SEANCE");
			expect(h.client.findChannel("#seance")!.shared.muted).to.equal(false);
			expect(setMuteStatus.args).to.deep.equal([
				[id, true],
				[id, false],
			]);
		});

		it("reports channels that are not open", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/mute #nope");
			expect(lastMessage(id).text).to.equal("No open channel or user found for #nope");
			h.client.input(id, "/mute #nope #seance #nah");
			expect(lastMessage(id).text).to.equal("No open channels or users found for #nope,#nah");
			expect(h.client.findChannel("#seance")!.shared.muted).to.equal(false);
		});

		it("works while disconnected", function () {
			const h = setup();
			h.client.input(1, "/mute");
			expect(h.client.lobby.shared.muted).to.equal(true);
		});
	});

	describe("/disconnect and /connect", function () {
		it("quits with the reason and closes without reconnecting", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/disconnect back later");
			expect(h.sentAfter()).to.deep.equal(["QUIT :back later"]);
			expect(h.transport.closeCalls).to.have.length(1);
			expect(h.client.isQuitting).to.equal(true);

			h.transport.closed(1000);
			h.client.input(1, "/disconnect");
			expect(h.transport.closeCalls).to.have.length(2);
		});

		it("reconnects the current network with no arguments", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/connect");
			expect(lastMessage(id).text).to.equal("You are already connected.");
			expect(h.transport.connectCalls).to.equal(1);

			h.client.input(id, "/disconnect");
			h.transport.closed(1000);
			h.client.input(1, "/connect");
			expect(h.transport.connectCalls).to.equal(2);
			expect(h.client.state).to.equal("connecting");
		});

		it("asks the manager for a new network via network:new", function () {
			const created: unknown[] = [];
			socket.handle("network:new", (data) => void created.push(data));
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/connect irc.other +7443");
			h.client.input(id, "/server irc.plain 8067");
			h.client.input(id, "/server irc.default");
			expect(created).to.deep.equal([
				{
					host: "irc.other",
					port: 7443,
					tls: true,
					nick: "alice",
					join: "",
					sasl: "",
					saslAccount: "",
					saslPassword: "",
				},
				{
					host: "irc.plain",
					port: 8067,
					tls: false,
					nick: "alice",
					join: "",
					sasl: "",
					saslAccount: "",
					saslPassword: "",
				},
				{
					host: "irc.default",
					port: 8067,
					tls: false,
					nick: "alice",
					join: "",
					sasl: "",
					saslAccount: "",
					saslPassword: "",
				},
			]);
			expect(h.sentAfter()).to.deep.equal([]);
		});
	});

	describe("/alias", function () {
		it("says so when there are no aliases", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias");
			expect(lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(lastMessage(id).text).to.contain("No aliases defined");
			expect(h.sentAfter()).to.deep.equal([]);
		});

		it("adds an alias, and nothing reaches the server", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias greet /say Hello, $1!");
			expect(lastMessage(id).text).to.equal("Alias /greet added.");
			expect(loadAliases()).to.deep.equal([{name: "greet", body: "/say Hello, $1!"}]);
			expect(h.sentAfter()).to.deep.equal([]);
		});

		it("overwrites in place, matching the name case-insensitively", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias greet /say hi");
			h.client.input(id, "/alias wave /me waves");
			h.client.input(id, "/alias GREET /say hello");
			expect(lastMessage(id).text).to.equal("Alias /GREET updated.");
			expect(loadAliases()).to.deep.equal([
				{name: "GREET", body: "/say hello"},
				{name: "wave", body: "/me waves"},
			]);
		});

		it("lists every alias verbatim in a monospace block", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias greet /say Hello, $1!");
			h.client.input(id, "/alias wave /me waves");
			h.client.input(id, "/alias");
			expect(lastMessage(id).type).to.equal(MessageType.MONOSPACE_BLOCK);
			expect(lastMessage(id).text).to.equal("/greet /say Hello, $1!\n/wave /me waves");
		});

		it("shows one alias, continuation lines of a multi-line body indented", function () {
			const h = setup();
			// The whole multi-line input is one /alias only under draft/multiline.
			const id = joined(
				h,
				"",
				"batch message-tags draft/multiline=max-bytes=4096,max-lines=24"
			);
			h.client.input(id, "/alias hi /say hello\n/me waves");
			h.client.input(id, "/alias hi");
			expect(lastMessage(id).type).to.equal(MessageType.MONOSPACE_BLOCK);
			expect(lastMessage(id).text).to.equal("/hi /say hello\n    /me waves");
		});

		it("accepts the name typed with its slash", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias /greet /say hi");
			expect(loadAliases()).to.deep.equal([{name: "greet", body: "/say hi"}]);
		});

		it("rejects an invalid name and an unknown lookup", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/alias bad!name /say hi");
			expect(lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(loadAliases()).to.deep.equal([]);

			h.client.input(id, "/alias nosuch");
			expect(lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(lastMessage(id).text).to.contain("No alias /nosuch");
		});

		it("works disconnected, from the lobby", function () {
			const h = setup();
			const lobby = h.client.lobby.id;
			h.client.input(lobby, "/alias greet /say hi");
			expect(lastMessage(lobby).text).to.equal("Alias /greet added.");
			expect(loadAliases()).to.deep.equal([{name: "greet", body: "/say hi"}]);
		});
	});
});
