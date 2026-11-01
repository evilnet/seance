import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {
	batchCooldownMs,
	joinMultiline,
	MULTILINE_MAX_COOLDOWN_MS,
	MULTILINE_SETTLE_MS,
	parseMultilineValue,
	planMultiline,
} from "../../client/js/irc/multiline";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {IrcMessage, MAX_LINE_BYTES, parseLine, utf8ByteLength} from "../../client/js/irc/message";
import {MessageType, SharedMsg} from "../../shared/types/msg";

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

	send(line: string): void {
		this.sent.push(line);
	}

	close(): void {
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

	closed(): void {
		this.state = "closed";
		this.emit({type: "close", code: 1006, reason: "", wasClean: false, willReconnect: false});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

let dispatch: sinon.SinonSpy;
/** Whether this file installed the spy (test/irc/client.ts has a root-level one). */
let ownsSpy = false;

function installSpy(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
		return;
	}

	dispatch = sinon.spy(socket, "dispatch");
	ownsSpy = true;
}

function removeSpy(): void {
	if (ownsSpy) {
		dispatch.restore();
	}

	socket.removeAllListeners();
}

function messages(chanId: number): SharedMsg[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg")
		.map((call) => call.args[1] as {chan: number; msg: SharedMsg})
		.filter((p) => p.chan === chanId)
		.map((p) => p.msg);
}

const MULTILINE_VALUE = "max-bytes=16384,max-lines=100";
const OFFERED_CAPS = `batch message-tags server-time echo-message draft/multiline=${MULTILINE_VALUE}`;

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	chanId: number;
	/** Caps the client asked for in its `CAP REQ`. */
	requested: string[];
}

/** A registered client in #seance with bob and carol present. */
function setup(offered: string = OFFERED_CAPS): Harness {
	const transport = new FakeTransport();
	const client = new IrcClient({
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

	client.connect();
	transport.open();
	transport.line(`:irc.test CAP * LS :${offered}`);

	const req = transport.sent.find((line) => line.startsWith("CAP REQ :"));
	const requested = req ? req.slice("CAP REQ :".length).split(" ") : [];

	if (requested.length > 0) {
		transport.line(`:irc.test CAP alice ACK :${requested.join(" ")}`);
	}

	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=beI,k,l,imnpst CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob carol",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	dispatch.resetHistory();
	transport.sent.length = 0;

	return {client, transport, requested, chanId: client.findChannel("#seance")!.id};
}

describe("multiline cap", function () {
	beforeEach(function () {
		installSpy();
	});

	afterEach(function () {
		removeSpy();
	});

	describe("parseMultilineValue", function () {
		it("parses the documented value", function () {
			expect(parseMultilineValue("max-bytes=16384,max-lines=100")).to.deep.equal({
				maxBytes: 16384,
				maxLines: 100,
			});
		});

		it("accepts the tokens in either order and ignores unknown ones", function () {
			expect(parseMultilineValue("max-lines=24,foo=bar,max-bytes=4096")).to.deep.equal({
				maxBytes: 4096,
				maxLines: 24,
			});
		});

		it("treats a missing or unusable max-lines as no line limit", function () {
			// The draft makes max-lines RECOMMENDED, not REQUIRED.
			expect(parseMultilineValue("max-bytes=16384")).to.deep.equal({
				maxBytes: 16384,
				maxLines: Infinity,
			});
			expect(parseMultilineValue("max-bytes=16384,max-lines=0")).to.deep.equal({
				maxBytes: 16384,
				maxLines: Infinity,
			});
			expect(parseMultilineValue("max-bytes=16384,max-lines=lots")).to.deep.equal({
				maxBytes: 16384,
				maxLines: Infinity,
			});
		});

		it("rejects a value without a usable max-bytes", function () {
			expect(parseMultilineValue("max-lines=100")).to.equal(undefined);
			expect(parseMultilineValue("")).to.equal(undefined);
			expect(parseMultilineValue(undefined)).to.equal(undefined);
			expect(parseMultilineValue("max-bytes=0,max-lines=100")).to.equal(undefined);
			expect(parseMultilineValue("max-bytes=-1,max-lines=100")).to.equal(undefined);
			expect(parseMultilineValue("max-bytes=lots,max-lines=100")).to.equal(undefined);
			expect(parseMultilineValue("max-bytes,max-lines")).to.equal(undefined);
			expect(parseMultilineValue("garbage")).to.equal(undefined);
		});
	});

	describe("negotiation", function () {
		it("requests draft/multiline and exposes its limits", function () {
			const {client, requested} = setup();

			expect(requested).to.include("draft/multiline");
			expect(client.multilineLimits()).to.deep.equal({maxBytes: 16384, maxLines: 100});
		});

		it("does not request the cap when its value is unusable", function () {
			const {client, requested} = setup(
				"batch message-tags server-time draft/multiline=max-lines=100"
			);

			expect(requested).to.not.include("draft/multiline");
			expect(client.multilineLimits()).to.equal(undefined);
		});

		it("has no limits when the server never offers the cap", function () {
			const {client, requested} = setup("batch message-tags server-time");

			expect(requested).to.not.include("draft/multiline");
			expect(client.multilineLimits()).to.equal(undefined);
		});

		it("has no limits without batch", function () {
			const {client, requested} = setup(
				`message-tags server-time draft/multiline=${MULTILINE_VALUE}`
			);

			expect(requested).to.include("draft/multiline");
			expect(client.multilineLimits()).to.equal(undefined);
		});

		it("has no limits without message-tags", function () {
			// The draft depends on `batch` *and* `message-tags`: without the
			// latter the server strips the `batch` tag off our lines and the
			// batch has no contents.
			const {client, requested} = setup(
				`batch server-time draft/multiline=${MULTILINE_VALUE}`
			);

			expect(requested).to.include("draft/multiline");
			expect(client.multilineLimits()).to.equal(undefined);
		});

		it("drops the limits when the cap is removed again", function () {
			const {client, transport} = setup();

			transport.line(":irc.test CAP alice DEL :draft/multiline");
			expect(client.multilineLimits()).to.equal(undefined);
		});
	});
});

describe("multiline batches", function () {
	beforeEach(function () {
		installSpy();
	});

	afterEach(function () {
		removeSpy();
	});

	function more(chanId: number): {messages: SharedMsg[]}[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === "more")
			.map((call) => call.args[1] as {chan: number; messages: SharedMsg[]})
			.filter((p) => p.chan === chanId);
	}

	function line(text: string, tags = "", nick = "bob"): string {
		return `@batch=ml${tags} :${nick}!b@h PRIVMSG #seance :${text}`;
	}

	describe("joinMultiline", function () {
		function parsed(...lines: string[]): IrcMessage[] {
			return lines.map((l) => {
				const msg = parseLine(l);

				if (!msg) {
					throw new Error(`bad test line: ${l}`);
				}

				return msg;
			});
		}

		it("joins lines with a line feed", function () {
			expect(joinMultiline(parsed(line("a"), line("b"), line("c")))).to.deep.equal({
				command: "PRIVMSG",
				target: "#seance",
				text: "a\nb\nc",
				source: "bob!b@h",
			});
		});

		it("appends a draft/multiline-concat line without a separator", function () {
			expect(
				joinMultiline(parsed(line("a"), line("b", ";draft/multiline-concat"), line("c")))
					?.text
			).to.equal("ab\nc");
		});

		it("rewraps an ACTION batch around the joined text", function () {
			expect(
				joinMultiline(parsed(line("\x01ACTION a\x01"), line("\x01ACTION b\x01")))?.text
			).to.equal("\x01ACTION a\nb\x01");
		});

		it("rejects an empty batch, mixed targets and mixed commands", function () {
			expect(joinMultiline([])).to.equal(undefined);
			expect(
				joinMultiline(parsed(line("a"), "@batch=ml :bob!b@h PRIVMSG #other :b"))
			).to.equal(undefined);
			expect(
				joinMultiline(parsed(line("a"), "@batch=ml :bob!b@h NOTICE #seance :b"))
			).to.equal(undefined);
			expect(joinMultiline(parsed(line("a"), "@batch=ml :bob!b@h TAGMSG #seance"))).to.equal(
				undefined
			);
		});
	});

	it("delivers a multiline batch as one message", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("first"),
			line("second"),
			line("third")
		);
		expect(messages(chanId), "nothing before the batch closes").to.have.length(0);

		transport.line(":irc.test BATCH -ml");

		const shown = messages(chanId);
		expect(shown).to.have.length(1);
		expect(shown[0].text).to.equal("first\nsecond\nthird");
		expect(shown[0].type).to.equal(MessageType.MESSAGE);
		expect(shown[0].from?.nick).to.equal("bob");
	});

	it("takes msgid, time and the reply tag from the batch opener", function () {
		const {transport, chanId} = setup();

		transport.lines(
			"@msgid=m1;time=2026-08-29T10:00:00.000Z;+draft/reply=parent :irc.test BATCH +ml draft/multiline #seance",
			"@batch=ml;msgid=ignored :bob!b@h PRIVMSG #seance :one",
			"@batch=ml :bob!b@h PRIVMSG #seance :two",
			":irc.test BATCH -ml"
		);

		const [shown] = messages(chanId);
		expect(shown.text).to.equal("one\ntwo");
		expect(shown.msgid).to.equal("m1");
		expect(shown.time.toISOString()).to.equal("2026-08-29T10:00:00.000Z");
		expect(shown.replyTo).to.equal("parent");
	});

	it("falls back to the first line's msgid, time and account", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			"@batch=ml;msgid=l1;time=2026-08-29T10:00:00.000Z;account=bobby :bob!b@h PRIVMSG #seance :one",
			"@batch=ml :bob!b@h PRIVMSG #seance :two",
			":irc.test BATCH -ml"
		);

		const [shown] = messages(chanId);
		expect(shown.text).to.equal("one\ntwo");
		expect(shown.msgid).to.equal("l1");
		expect(shown.time.toISOString()).to.equal("2026-08-29T10:00:00.000Z");
		expect(shown.fromAccount).to.equal("bobby");
	});

	it("compares the lines' targets with the network's casemapping", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("one"),
			"@batch=ml :bob!b@h PRIVMSG #SEANCE :two",
			":irc.test BATCH -ml"
		);

		expect(messages(chanId).map((m) => m.text)).to.deep.equal(["one\ntwo"]);
	});

	it("joins an ACTION batch into one action", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("\x01ACTION waves\x01"),
			line("\x01ACTION and bows\x01"),
			":irc.test BATCH -ml"
		);

		const [shown] = messages(chanId);
		expect(shown.type).to.equal(MessageType.ACTION);
		expect(shown.text).to.equal("waves\nand bows");
	});

	it("keeps a NOTICE batch a notice", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			"@batch=ml :bob!b@h NOTICE #seance :one",
			"@batch=ml :bob!b@h NOTICE #seance :two",
			":irc.test BATCH -ml"
		);

		const [shown] = messages(chanId);
		expect(shown.type).to.equal(MessageType.NOTICE);
		expect(shown.text).to.equal("one\ntwo");
	});

	it("answers no CTCP whose reply would carry a line feed", function () {
		const {client, transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("\x01PING abc"),
			line("def\x01"),
			":irc.test BATCH -ml"
		);

		// `PING` echoes its argument, which here spans lines. The request is
		// still shown: building the NOTICE would throw out of the handler,
		// and `IrcClient.handleMessage` only logs that — the message would be
		// lost with it.
		const shown = messages(client.lobby.id);

		expect(shown).to.have.length(1);
		expect(shown[0].type).to.equal(MessageType.CTCP_REQUEST);
		expect(transport.sent).to.deep.equal([]);
		expect(messages(chanId)).to.have.length(0);
	});

	it("marks our own echoed batch as self", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("mine", "", "alice"),
			line("too", "", "alice"),
			":irc.test BATCH -ml"
		);

		const [shown] = messages(chanId);
		expect(shown.self).to.equal(true);
		expect(shown.text).to.equal("mine\ntoo");
	});

	it("delivers the lines individually when a target does not match", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +ml draft/multiline #seance",
			line("one"),
			"@batch=ml :bob!b@h PRIVMSG #other :two",
			":irc.test BATCH -ml"
		);

		expect(messages(chanId).map((m) => m.text)).to.deep.equal(["one"]);
	});

	it("shows nothing for an empty batch", function () {
		const {transport, chanId} = setup();

		transport.lines(":irc.test BATCH +ml draft/multiline #seance", ":irc.test BATCH -ml");

		expect(messages(chanId)).to.have.length(0);
	});

	it("folds into an enclosing chathistory batch in its place", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +hist chathistory #seance",
			"@batch=hist;msgid=h1;time=2026-08-29T09:00:00.000Z :bob!b@h PRIVMSG #seance :before",
			"@batch=hist;msgid=h2;time=2026-08-29T09:01:00.000Z :irc.test BATCH +ml draft/multiline #seance",
			"@batch=ml :bob!b@h PRIVMSG #seance :one",
			"@batch=ml :bob!b@h PRIVMSG #seance :two",
			"@batch=hist :irc.test BATCH -ml",
			"@batch=hist;msgid=h3;time=2026-08-29T09:02:00.000Z :bob!b@h PRIVMSG #seance :after",
			":irc.test BATCH -hist"
		);

		const pages = more(chanId);
		expect(pages).to.have.length(1);
		expect(pages[0].messages.map((m) => m.text)).to.deep.equal(["before", "one\ntwo", "after"]);
		expect(pages[0].messages[1].msgid).to.equal("h2");
	});
});

describe("multiline sending", function () {
	beforeEach(function () {
		installSpy();
	});

	afterEach(function () {
		removeSpy();
	});

	/** The text a plan stands for, joined the way a receiver would join it. */
	function rejoin(lines: {text: string; concat: boolean}[]): string {
		return lines.map((l, i) => (i > 0 && !l.concat ? `\n${l.text}` : l.text)).join("");
	}

	function texts(plan: {text: string; concat: boolean}[][]): string[][] {
		return plan.map((batch) => batch.map((l) => l.text));
	}

	/** The offered caps with `draft/multiline` carrying `value`. */
	function offering(value: string, extra = "echo-message "): string {
		return `batch message-tags server-time ${extra}draft/multiline=${value}`;
	}

	/**
	 * Our own batch coming back, which is how the server says it took it and
	 * how the sender learns the next one may go out. The server rewrites the
	 * reference, so it is never the one we sent.
	 */
	function echoBatch(transport: FakeTransport, ref: string, ...lines: string[]): void {
		transport.line(`:alice!alice@host BATCH +${ref} draft/multiline #seance`);

		for (const line of lines) {
			transport.line(`@batch=${ref} :alice!alice@host PRIVMSG #seance :${line}`);
		}

		transport.line(`:alice!alice@host BATCH -${ref}`);
	}

	describe("planMultiline", function () {
		const LIMITS = {maxBytes: 16384, maxLines: 100};

		it("makes one line per line feed", function () {
			expect(planMultiline("a\nb", 0, LIMITS)).to.deep.equal([
				[
					{text: "a", concat: false},
					{text: "b", concat: false},
				],
			]);
		});

		it("keeps blank lines inside the message and drops trailing ones", function () {
			expect(texts(planMultiline("a\n\nb\n\n", 0, LIMITS))).to.deep.equal([["a", "", "b"]]);
		});

		it("plans nothing for a message of blank lines only", function () {
			expect(planMultiline("\n\n", 0, LIMITS)).to.deep.equal([]);
			expect(planMultiline("", 0, LIMITS)).to.deep.equal([]);
		});

		it("normalises CRLF and keeps CR and NUL off the wire", function () {
			expect(texts(planMultiline("a\r\nb\rc\0d", 0, LIMITS))).to.deep.equal([["a", "b c d"]]);
		});

		it("splits an over-long line into concat chunks that rejoin exactly", function () {
			const long = Array.from({length: 200}, (_, i) => `word${i}`).join(" ");
			const text = `${long}\ntail`;
			const plan = planMultiline(text, 100, LIMITS);

			expect(plan).to.have.length(1);

			const [batch] = plan;
			expect(batch.length).to.be.greaterThan(2);
			expect(batch[0].concat).to.equal(false);
			expect(batch[1].concat).to.equal(true);
			expect(batch[batch.length - 1]).to.deep.equal({text: "tail", concat: false});
			expect(rejoin(batch), "a plan rejoins to exactly what was typed").to.equal(text);

			for (const line of batch) {
				expect(utf8ByteLength(line.text)).to.be.at.most(MAX_LINE_BYTES - 100);
			}
		});

		it("cuts concat chunks between visible characters", function () {
			const flag = "\u{1F1E8}\u{1F1E6}";
			const text = "z" + flag.repeat(200);
			const plan = planMultiline(text, 100, {maxBytes: 16384, maxLines: 100});

			expect(rejoin(plan[0])).to.equal(text);

			for (const line of plan[0].slice(1)) {
				expect(line.text.split(flag).join("")).to.equal("");
			}
		});

		it("splits a line with no spaces at the byte budget", function () {
			const text = `${"x".repeat(30)}\ny`;
			const plan = planMultiline(text, MAX_LINE_BYTES - 10, {maxBytes: 16384, maxLines: 100});

			expect(texts(plan)).to.deep.equal([
				["x".repeat(10), "x".repeat(10), "x".repeat(10), "y"],
			]);
			expect(rejoin(plan[0])).to.equal(text);
		});

		it("opens a new batch past max-lines", function () {
			const text = ["l0", "l1", "l2", "l3", "l4", "l5", "l6"].join("\n");
			const plan = planMultiline(text, 0, {maxBytes: 16384, maxLines: 3});

			expect(texts(plan)).to.deep.equal([["l0", "l1", "l2"], ["l3", "l4", "l5"], ["l6"]]);
		});

		it("opens a new batch past max-bytes, line feeds counted", function () {
			// "aaa" + LF + "bbb" is 7 of 8 bytes; "ccc" needs 4 more.
			expect(
				texts(planMultiline("aaa\nbbb\nccc", 0, {maxBytes: 8, maxLines: 100}))
			).to.deep.equal([["aaa", "bbb"], ["ccc"]]);
		});

		it("starts a batch with a non-concat line even mid-paragraph", function () {
			const text = "abcdef";
			const plan = planMultiline(`${text}\nz`, MAX_LINE_BYTES - 2, {
				maxBytes: 16384,
				maxLines: 2,
			});

			expect(plan).to.deep.equal([
				[
					{text: "ab", concat: false},
					{text: "cd", concat: true},
				],
				[
					{text: "ef", concat: false},
					{text: "z", concat: false},
				],
			]);
		});

		it("counts the per-line body overhead against max-bytes", function () {
			// Each \x01ACTION …\x01 costs 9 bytes the server counts too.
			expect(
				texts(planMultiline("aaa\nbbb", 0, {maxBytes: 20, maxLines: 100}, 9))
			).to.deep.equal([["aaa"], ["bbb"]]);
		});

		it("never plans a line larger than one message may be", function () {
			// The line budget is clamped to max-bytes: a chunk over it could
			// never be sent, whatever the frame allows.
			const plan = planMultiline("abcdefghij\nz", 0, {maxBytes: 4, maxLines: 100});

			expect(texts(plan)).to.deep.equal([["abcd"], ["efgh"], ["ij", "z"]]);

			for (const line of plan.flat()) {
				expect(utf8ByteLength(line.text)).to.be.at.most(4);
			}
		});
	});

	describe("sendMessage", function () {
		it("sends a multi-line message as one batch", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "one\ntwo\nthree");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :one",
				"@batch=m1 PRIVMSG #seance :two",
				"@batch=m1 PRIVMSG #seance :three",
				"BATCH -m1",
			]);
		});

		it("puts the reply tag on the opener only", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "one\ntwo", {reply: "parent"});

			expect(transport.sent).to.deep.equal([
				"@+draft/reply=parent BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :one",
				"@batch=m1 PRIVMSG #seance :two",
				"BATCH -m1",
			]);
		});

		it("puts the edit tag on the opener of a multi-line edit", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "one\ntwo", {edit: "old"});

			expect(transport.sent[0]).to.equal(
				"@+seance/edit=old BATCH +m1 draft/multiline #seance"
			);
			expect(transport.sent[1]).to.equal("@batch=m1 PRIVMSG #seance :one");
		});

		it("tags continuation chunks with draft/multiline-concat", function () {
			const {client, transport, chanId} = setup();
			const long = Array.from({length: 200}, (_, i) => `word${i}`).join(" ");

			client.input(chanId, `${long}\ntail`);

			expect(transport.sent[0]).to.equal("BATCH +m1 draft/multiline #seance");
			expect(transport.sent[1]).to.match(/^@batch=m1 PRIVMSG #seance :word0 /);
			expect(transport.sent[2]).to.match(
				/^@batch=m1;draft\/multiline-concat PRIVMSG #seance :/
			);
			expect(transport.sent[transport.sent.length - 2]).to.equal(
				"@batch=m1 PRIVMSG #seance :tail"
			);
			expect(transport.sent[transport.sent.length - 1]).to.equal("BATCH -m1");

			for (const line of transport.sent) {
				expect(utf8ByteLength(line)).to.be.at.most(MAX_LINE_BYTES);
			}
		});

		it("opens a second batch when the message does not fit one, paced past the cooldown", function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const {client, transport, chanId} = setup(offering("max-bytes=16384,max-lines=2"));

				client.input(chanId, "one\ntwo\nthree");

				expect(transport.sent).to.deep.equal([
					"BATCH +m1 draft/multiline #seance",
					"@batch=m1 PRIVMSG #seance :one",
					"@batch=m1 PRIVMSG #seance :two",
					"BATCH -m1",
				]);

				transport.sent.length = 0;
				echoBatch(transport, "Gk1", "one", "two");

				// The server took the first batch, but it is still cooling down
				// from it; the second batch waits that out rather than going out
				// on the echo alone and being dropped mid-cooldown (multiline.ts).
				expect(transport.sent).to.deep.equal([]);

				clock.tick(
					batchCooldownMs({
						lines: [
							{text: "one", concat: false},
							{text: "two", concat: false},
						],
						action: false,
					})
				);

				expect(transport.sent).to.deep.equal([
					"BATCH +m2 draft/multiline #seance",
					"@batch=m2 PRIVMSG #seance :three",
					"BATCH -m2",
				]);
			} finally {
				clock.restore();
			}
		});

		it("paces a later message's batch past the previous message's cooldown", function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const {client, transport, chanId} = setup();

				// One whole message (a single batch), delivered.
				client.input(chanId, "one\ntwo");
				expect(transport.sent).to.deep.equal([
					"BATCH +m1 draft/multiline #seance",
					"@batch=m1 PRIVMSG #seance :one",
					"@batch=m1 PRIVMSG #seance :two",
					"BATCH -m1",
				]);
				transport.sent.length = 0;
				echoBatch(transport, "Gk1", "one", "two");

				// A second message, sent right after: the server is still cooling
				// down from the first, so its batch must wait — the cooldown gate
				// outlives the first message's queue (multiline.ts).
				client.input(chanId, "three\nfour");
				expect(transport.sent).to.deep.equal([]);

				clock.tick(
					batchCooldownMs({
						lines: [
							{text: "one", concat: false},
							{text: "two", concat: false},
						],
						action: false,
					})
				);

				expect(transport.sent).to.deep.equal([
					"BATCH +m2 draft/multiline #seance",
					"@batch=m2 PRIVMSG #seance :three",
					"@batch=m2 PRIVMSG #seance :four",
					"BATCH -m2",
				]);
			} finally {
				clock.restore();
			}
		});

		it("sends one line too long for a message as one batch of concat chunks", function () {
			const {client, transport, chanId} = setup();
			const long = Array.from({length: 120}, (_, i) => `word${i}`).join(" ");

			client.input(chanId, long);

			expect(transport.sent[0]).to.equal("BATCH +m1 draft/multiline #seance");
			expect(transport.sent[transport.sent.length - 1]).to.equal("BATCH -m1");
			const inner = transport.sent.slice(1, -1);
			expect(inner.length).to.be.greaterThan(1);
			expect(inner[0]).to.match(/^@batch=m1 PRIVMSG #seance :word0 /);

			for (const line of inner.slice(1)) {
				expect(line).to.match(/^@batch=m1;draft\/multiline-concat PRIVMSG #seance :/);
			}

			const rejoined = inner.map((line) => line.slice(line.indexOf(" :") + 2)).join("");
			expect(rejoined).to.equal(long);

			for (const line of transport.sent) {
				expect(utf8ByteLength(line)).to.be.at.most(MAX_LINE_BYTES);
			}
		});

		it("sends a long run with no spaces, a URL say, as one batch", function () {
			const {client, transport, chanId} = setup();
			const url = `https://example.com/${"a1".repeat(400)}`;

			client.input(chanId, url);

			expect(transport.sent[0]).to.equal("BATCH +m1 draft/multiline #seance");
			const inner = transport.sent.slice(1, -1);
			expect(inner.map((line) => line.slice(line.indexOf(" :") + 2)).join("")).to.equal(url);
		});

		it("batches a line that fits a batch but not one message with its tags", function () {
			const {client, transport} = setup();
			const reply = {"+draft/reply": "r".repeat(200)};
			const text = "x".repeat(290);

			client.sendMessage("#seance", text, {tags: reply});

			expect(transport.sent[0]).to.equal(
				`@+draft/reply=${"r".repeat(200)} BATCH +m1 draft/multiline #seance`
			);
			expect(transport.sent.slice(1)).to.deep.equal([
				`@batch=m1 PRIVMSG #seance :${text}`,
				"BATCH -m1",
			]);
		});

		it("sends a /me too long for a message as one batch of actions", function () {
			const {client, transport, chanId} = setup();
			const long = Array.from({length: 120}, (_, i) => `waves${i}`).join(" ");

			client.input(chanId, `/me ${long}`);

			expect(transport.sent[0]).to.equal("BATCH +m1 draft/multiline #seance");
			const inner = transport.sent.slice(1, -1);
			expect(inner.length).to.be.greaterThan(1);

			for (const line of inner) {
				expect(line).to.match(/ PRIVMSG #seance :\x01ACTION .*\x01$/);
				expect(utf8ByteLength(line)).to.be.at.most(MAX_LINE_BYTES);
			}

			const rejoined = inner
				.map((line) => line.slice(line.indexOf(" :\x01ACTION ") + 10, -1))
				.join("");
			expect(rejoined).to.equal(long);
		});

		it("sends an edit too long for a message as one batch carrying the edit", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "z".repeat(700), {edit: "old"});

			expect(transport.sent[0]).to.equal(
				"@+seance/edit=old BATCH +m1 draft/multiline #seance"
			);
			expect(transport.sent.filter((line) => / BATCH \+/.test(` ${line}`))).to.have.length(1);
			expect(transport.sent[transport.sent.length - 1]).to.equal("BATCH -m1");
		});

		it("counts the label in deciding what fits one message", function () {
			const {client, transport, chanId} = setup(`${OFFERED_CAPS} labeled-response`);
			// Fits one message without a label, not with one.
			const prefix = utf8ByteLength(":alice!alice@host PRIVMSG #seance :");
			const text = "q".repeat(MAX_LINE_BYTES - prefix);

			client.input(chanId, text);

			expect(transport.sent[0]).to.match(/^@label=s\d+ BATCH \+m1 draft\/multiline #seance$/);
			const copies = messages(chanId).filter((m) => m.pending);
			expect(copies.map((m) => m.text)).to.deep.equal([text]);
		});

		it("keeps a line that fits one message a plain PRIVMSG", function () {
			const {client, transport, chanId} = setup();
			const text = "y".repeat(300);

			client.input(chanId, text);

			expect(transport.sent).to.deep.equal([`PRIVMSG #seance :${text}`]);
		});

		it("splits a long line into separate messages without the capability", function () {
			const {client, transport, chanId} = setup(
				"batch message-tags server-time echo-message"
			);
			const long = Array.from({length: 120}, (_, i) => `word${i}`).join(" ");

			client.input(chanId, long);

			expect(transport.sent.length).to.be.greaterThan(1);

			for (const line of transport.sent) {
				expect(line).to.match(/^PRIVMSG #seance :word/);
			}
		});

		it("leaves room for a 75-byte host while ours is still unknown", function () {
			const {client, transport, chanId} = setup("batch message-tags server-time");
			client.host = ""; // nothing from the server has named our host yet

			client.input(chanId, "x".repeat(1000));

			// What a recipient gets is `:alice!alice@<host> PRIVMSG #seance :<text>`,
			// and nefarious2 cuts an untagged line at 510 bytes
			const source = ":alice!alice@".length + 75 + " PRIVMSG #seance :".length;
			const bodies = transport.sent.map((line) => line.slice("PRIVMSG #seance :".length));
			expect(bodies[0]).to.have.length(MAX_LINE_BYTES - source);
			expect(bodies.join("")).to.equal("x".repeat(1000));
		});

		it("sends one line without a batch", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "one\n");

			expect(transport.sent).to.deep.equal(["PRIVMSG #seance :one"]);
		});

		it("keeps the per-line behaviour without the capability", function () {
			const {client, transport, chanId} = setup(
				"batch message-tags server-time echo-message"
			);

			client.input(chanId, "one\ntwo\r\n\nthree");

			expect(transport.sent).to.deep.equal([
				"PRIVMSG #seance :one",
				"PRIVMSG #seance :two",
				"PRIVMSG #seance :three",
			]);
		});

		it("shows one local message when echo-message is off", function () {
			const {client, transport, chanId} = setup(
				offering("max-bytes=16384,max-lines=100", "")
			);

			client.input(chanId, "one\ntwo");

			expect(transport.sent).to.have.length(4);

			const shown = messages(chanId);
			expect(shown).to.have.length(1);
			expect(shown[0].text).to.equal("one\ntwo");
			expect(shown[0].self).to.equal(true);
			expect(shown[0].type).to.equal(MessageType.MESSAGE);
		});
	});

	describe("dispatchInput", function () {
		it("sends a multi-line action framed on every line", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/me waves\nand bows");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :\x01ACTION waves\x01",
				"@batch=m1 PRIVMSG #seance :\x01ACTION and bows\x01",
				"BATCH -m1",
			]);
		});

		it("sends a multi-line notice as a NOTICE batch", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/notice #other one\ntwo");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline #other",
				"@batch=m1 NOTICE #other :one",
				"@batch=m1 NOTICE #other :two",
				"BATCH -m1",
			]);
		});

		it("sends a multi-line /msg to the named target", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/msg bob one\ntwo");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline bob",
				"@batch=m1 PRIVMSG bob :one",
				"@batch=m1 PRIVMSG bob :two",
				"BATCH -m1",
			]);
		});

		it("runs any other command line by line", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/away gone\n/nick bobby");

			expect(transport.sent).to.deep.equal(["AWAY :gone", "NICK bobby"]);
		});

		it("takes the command name from the first line only", function () {
			const {client, transport, chanId} = setup();

			// Regression: `/me\nwaves` must not put a line feed on the wire.
			client.input(chanId, "/me\nwaves");

			expect(transport.sent).to.deep.equal(["PRIVMSG #seance :\x01ACTION waves\x01"]);
		});

		it("normalises CRLF before the command name is taken", function () {
			const {client, transport, chanId} = setup();

			// Regression: the command name used to be `me\r`, which is no
			// command, so the whole thing went out through the raw fallback
			// and `formatLine` threw on the line feed.
			client.input(chanId, "/me\r\nwaves");

			expect(transport.sent).to.deep.equal(["PRIVMSG #seance :\x01ACTION waves\x01"]);
		});

		it("normalises CRLF before the target is taken", function () {
			const {client, transport, chanId} = setup();

			// Regression: `splitTarget` splits at a space or a line feed, so
			// `bob\r` matched neither and the message was silently dropped.
			client.input(chanId, "/msg bob\r\nhi");

			expect(transport.sent).to.deep.equal(["PRIVMSG bob :hi"]);
		});

		it("batches a CRLF action like any other multi-line one", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/me waves\r\nand bows");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :\x01ACTION waves\x01",
				"@batch=m1 PRIVMSG #seance :\x01ACTION and bows\x01",
				"BATCH -m1",
			]);
		});

		it("treats a lone CR as a line separator too", function () {
			const {client, transport, chanId} = setup();

			// A paste can carry classic-Mac line endings; a CR is a separator,
			// never message content (`planMultiline` would make it a space).
			client.input(chanId, "/msg bob\rhi\rthere");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline bob",
				"@batch=m1 PRIVMSG bob :hi",
				"@batch=m1 PRIVMSG bob :there",
				"BATCH -m1",
			]);
		});

		it("normalises CR in an edit too", function () {
			const {client, transport, chanId} = setup();

			// The edit branch reads the same normalised text, so a CR is a
			// line break there as well — not the space `planMultiline` would
			// have made of it.
			client.input(chanId, "one\rtwo", {edit: "old"});

			expect(transport.sent).to.deep.equal([
				"@+seance/edit=old BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :one",
				"@batch=m1 PRIVMSG #seance :two",
				"BATCH -m1",
			]);
		});

		it("runs CRLF command lines one by one", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/away gone\r\n/nick bobby");

			expect(transport.sent).to.deep.equal(["AWAY :gone", "NICK bobby"]);
		});

		it("takes a /msg target up to the line feed", function () {
			const {client, transport, chanId} = setup();

			// Regression: the target used to be split on spaces only, so it
			// swallowed the line feed and `formatLine` threw out of `input`.
			client.input(chanId, "/msg bob\nhello world");

			expect(transport.sent).to.deep.equal(["PRIVMSG bob :hello world"]);
		});

		it("sends a /msg whose whole body is the second line", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/msg bob\nhello");

			expect(transport.sent).to.deep.equal(["PRIVMSG bob :hello"]);
		});

		it("batches a /msg body that spans lines of its own", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/msg bob\none\ntwo");

			expect(transport.sent).to.deep.equal([
				"BATCH +m1 draft/multiline bob",
				"@batch=m1 PRIVMSG bob :one",
				"@batch=m1 PRIVMSG bob :two",
				"BATCH -m1",
			]);
		});

		it("opens a /query for the target alone, never the whole line", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/query bob\nhello world");

			expect(transport.sent).to.deep.equal(["PRIVMSG bob :hello world"]);
			expect(client.channels.map((c) => c.name)).to.include("bob");
			expect(
				client.channels.every((c) => !/[\s]/.test(c.name)),
				"no garbage channel"
			).to.equal(true);
		});

		it("takes a /notice target up to the line feed", function () {
			const {client, transport, chanId} = setup();

			client.input(chanId, "/notice #other\nhello");

			expect(transport.sent).to.deep.equal(["NOTICE #other :hello"]);
		});

		it("puts the edit tag on the first opener only", function () {
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const {client, transport, chanId} = setup(offering("max-bytes=16384,max-lines=2"));

				// One edit replaces one message: the second batch is a new one.
				client.input(chanId, "one\ntwo\nthree", {edit: "old", reply: "parent"});

				expect(transport.sent[0]).to.equal(
					"@+seance/edit=old;+draft/reply=parent BATCH +m1 draft/multiline #seance"
				);

				transport.sent.length = 0;
				echoBatch(transport, "Gk1", "one", "two");
				clock.tick(
					batchCooldownMs({
						lines: [
							{text: "one", concat: false},
							{text: "two", concat: false},
						],
						action: false,
					})
				);

				expect(transport.sent[0]).to.equal(
					"@+draft/reply=parent BATCH +m2 draft/multiline #seance"
				);
			} finally {
				clock.restore();
			}
		});

		it("synthesises one action per batch without echo-message", function () {
			// Nothing comes back to say a batch was taken, so the next one
			// goes out when the first has been quiet for a settle period.
			const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

			try {
				const {client, transport, chanId} = setup(
					offering("max-bytes=16384,max-lines=2", "")
				);

				client.input(chanId, "/me one\ntwo\nthree");

				expect(transport.sent).to.deep.equal([
					"BATCH +m1 draft/multiline #seance",
					"@batch=m1 PRIVMSG #seance :\x01ACTION one\x01",
					"@batch=m1 PRIVMSG #seance :\x01ACTION two\x01",
					"BATCH -m1",
				]);

				transport.sent.length = 0;
				// Without echo-message the batch is taken to be delivered after a
				// settle period, and only then does the next one begin waiting out
				// the delivered batch's cooldown.
				clock.tick(
					MULTILINE_SETTLE_MS +
						batchCooldownMs({
							lines: [
								{text: "one", concat: false},
								{text: "two", concat: false},
							],
							action: true,
						})
				);

				expect(transport.sent).to.deep.equal([
					"BATCH +m2 draft/multiline #seance",
					"@batch=m2 PRIVMSG #seance :\x01ACTION three\x01",
					"BATCH -m2",
				]);

				const shown = messages(chanId);
				expect(shown.map((m) => m.text)).to.deep.equal(["one\ntwo", "three"]);
				expect(shown.every((m) => m.type === MessageType.ACTION)).to.equal(true);
				expect(shown.every((m) => m.self === true)).to.equal(true);
			} finally {
				clock.restore();
			}
		});
	});
});

describe("multiline cooldown", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		installSpy();
		clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
	});

	afterEach(function () {
		clock.restore();
		removeSpy();
	});

	// nefarious2 charges a cooldown for every multiline batch it delivers and
	// answers one opened inside that window with `FAIL BATCH
	// MULTILINE_COOLDOWN <seconds>`, dropping it whole (`ircd/m_batch.c`).
	// The message must arrive late, not go missing.
	const ONE_PER_BATCH =
		"batch message-tags server-time echo-message draft/multiline=max-bytes=16384,max-lines=1";

	function cooldown(transport: FakeTransport, seconds: number): void {
		transport.line(
			`:irc.test FAIL BATCH MULTILINE_COOLDOWN ${seconds} :Multiline batch cooldown active; retry after the listed seconds`
		);
	}

	it("re-sends a cooled-down batch instead of losing it", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		transport.sent.length = 0;
		cooldown(transport, 3);

		expect(transport.sent).to.deep.equal([]);

		clock.tick(3000);
		expect(transport.sent).to.deep.equal([]); // the margin has not elapsed

		clock.tick(1000);
		expect(transport.sent).to.deep.equal([
			"BATCH +m2 draft/multiline #seance",
			"@batch=m2 PRIVMSG #seance :one",
			"BATCH -m2",
		]);
	});

	it("says nothing about a cooldown it can wait out", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		cooldown(transport, 3);

		expect(messages(client.lobby.id)).to.have.length(0);
		// Only the pending copies of the message itself, which stay up while
		// the batches wait (test/irc/pending.ts).
		expect(messages(chanId).filter((m) => !m.pending)).to.have.length(0);
	});

	it("keeps the rest of the message behind the batch it re-sends", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo\nthree");
		transport.sent.length = 0;
		cooldown(transport, 1);
		clock.tick(2000);

		// The first batch again, not the second: order is the message.
		expect(transport.sent).to.deep.equal([
			"BATCH +m2 draft/multiline #seance",
			"@batch=m2 PRIVMSG #seance :one",
			"BATCH -m2",
		]);
	});

	it("shows a re-sent batch once, not once per attempt", function () {
		const {client, transport, chanId} = setup(
			"batch message-tags server-time draft/multiline=max-bytes=16384,max-lines=1"
		);

		client.input(chanId, "one\ntwo");
		cooldown(transport, 1);
		clock.tick(2000);

		expect(messages(chanId).map((m) => m.text)).to.deep.equal(["one"]);
	});

	it("reports a cooldown with nothing on the wire to re-send", function () {
		const {client, transport} = setup();

		cooldown(transport, 3);

		const shown = messages(client.lobby.id);
		expect(shown).to.have.length(1);
		expect(shown[0].type).to.equal(MessageType.ERROR);
		expect(shown[0].text).to.match(/^Message not sent: /);
		expect(shown[0].text).to.include("cooldown");
	});

	it("gives up on a cooldown longer than it will wait", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		transport.sent.length = 0;
		cooldown(transport, MULTILINE_MAX_COOLDOWN_MS / 1000 + 1);

		expect(messages(client.lobby.id)).to.have.length(1);

		// Nothing is left queued behind a batch that is not going out.
		clock.tick(MULTILINE_MAX_COOLDOWN_MS * 2);
		expect(transport.sent).to.deep.equal([]);
	});

	it("drops what a hard failure was part of", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo\nthree");
		transport.sent.length = 0;
		transport.line(":irc.test FAIL BATCH MULTILINE_INVALID :Multiline batch is invalid");

		expect(messages(client.lobby.id)).to.have.length(1);

		clock.tick(60000);
		expect(transport.sent).to.deep.equal([]);
	});

	it("sends a message typed behind a waiting batch after it, not before", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		client.input(chanId, "short");

		// Only the first batch is out; "short" waits behind the second.
		expect(transport.sent).to.deep.equal([
			"BATCH +m1 draft/multiline #seance",
			"@batch=m1 PRIVMSG #seance :one",
			"BATCH -m1",
		]);

		transport.sent.length = 0;
		clock.tick(60000);

		expect(transport.sent).to.deep.equal([
			"BATCH +m2 draft/multiline #seance",
			"@batch=m2 PRIVMSG #seance :two",
			"BATCH -m2",
			"PRIVMSG #seance :short",
		]);
	});

	it("shows a held message's copy at once, after the batches ahead of it", function () {
		const {client, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		client.input(chanId, "short");

		const shown = messages(chanId);
		expect(shown.map((m) => m.text)).to.deep.equal(["one", "two", "short"]);
		expect(shown.every((m) => m.pending)).to.equal(true);
	});

	it("sends a message at once once no batch is waiting", function () {
		const {client, transport, chanId} = setup();

		client.input(chanId, "x".repeat(700));
		client.input(chanId, "short");

		// The batch is on the wire and its cooldown pending: the server reads
		// "short" after it all the same.
		expect(transport.sent[transport.sent.length - 2]).to.equal("BATCH -m1");
		expect(transport.sent[transport.sent.length - 1]).to.equal("PRIVMSG #seance :short");
	});

	it("still sends a held message when the batch ahead of it fails", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		client.input(chanId, "short");
		transport.sent.length = 0;
		transport.line(":irc.test FAIL BATCH MULTILINE_INVALID :Multiline batch is invalid");

		expect(transport.sent).to.deep.equal(["PRIVMSG #seance :short"]);

		clock.tick(60000);
		expect(transport.sent).to.deep.equal(["PRIVMSG #seance :short"]);
	});

	it("drops the queue when the transport closes", function () {
		const {client, transport, chanId} = setup(ONE_PER_BATCH);

		client.input(chanId, "one\ntwo");
		transport.sent.length = 0;
		cooldown(transport, 1);
		transport.closed();
		clock.tick(60000);

		expect(transport.sent).to.deep.equal([]);
	});
});

describe("commands without the cap", function () {
	beforeEach(function () {
		installSpy();
	});

	afterEach(function () {
		removeSpy();
	});

	/** No `draft/multiline`: every line is its own input, as it always was. */
	function plain(): Harness {
		return setup("batch message-tags server-time echo-message");
	}

	it("sends a plain /msg unchanged", function () {
		const {client, transport, chanId} = plain();

		client.input(chanId, "/msg bob hi");

		expect(transport.sent).to.deep.equal(["PRIVMSG bob :hi"]);
	});

	it("keeps the space a /msg body starts with", function () {
		const {client, transport, chanId} = plain();

		// Characterisation of the `splitTarget` rewrite: the target comes off
		// at *one* space, so a second one is body. The old `rest.split(" ")`
		// plus `args.join(" ")` produced the same line — `["", "hi"]` joins to
		// `" hi"` — but nothing pinned it. (`/notice` below did change.)
		client.input(chanId, "/msg #c  hi");

		expect(transport.sent).to.deep.equal(["PRIVMSG #c : hi"]);
	});

	it("keeps the space a /notice body starts with", function () {
		const {client, transport, chanId} = plain();

		// The one accepted change without the cap: the old `/notice` refused
		// to send when `args[1]` was falsy, and the empty token between the
		// two spaces is exactly that, so the message was dropped. Verified
		// against the pre-`splitTarget` command (848075ab).
		client.input(chanId, "/notice #c  hi");

		expect(transport.sent).to.deep.equal(["NOTICE #c : hi"]);
	});

	it("sends nothing for a /msg without a body", function () {
		const {client, transport, chanId} = plain();

		client.input(chanId, "/msg #c");

		expect(transport.sent).to.deep.equal([]);
	});

	it("opens a /query without a body and sends nothing", function () {
		const {client, transport, chanId} = plain();

		client.input(chanId, "/query nick");

		expect(transport.sent).to.deep.equal([]);
		expect(client.channels.map((c) => c.name)).to.include("nick");
	});

	it("refuses a /query target with a tab in it", function () {
		const {client, transport, chanId} = plain();

		// A tab is the other shape the target split changed, deliberately:
		// `args.shift()` made `bob\thi` the whole target and `openQuery`
		// announced a channel by that name (verified against 848075ab);
		// `splitTarget` splits at a space or a line feed only, so a tab
		// leaves no target at all and `openQuery` refuses whitespace anyway.
		client.input(chanId, "/query bob\thi");

		expect(transport.sent).to.deep.equal([]);
		expect(
			client.channels.every((c) => !/\s/.test(c.name)),
			"no garbage channel"
		).to.equal(true);
		expect(messages(chanId).map((m) => m.text)).to.deep.equal([
			"You cannot open a query window without an argument.",
		]);
	});
});

describe("multiline errors", function () {
	beforeEach(function () {
		installSpy();
	});

	afterEach(function () {
		removeSpy();
	});

	// The lines below are the draft's own § Errors examples
	// (https://ircv3.net/specs/extensions/multiline): MAX_BYTES and MAX_LINES
	// carry the limit as their context, INVALID_TARGET carries
	// `<batch-target> <provided-target>`, MULTILINE_INVALID carries nothing.
	// The client splits proactively, so none of these should ever arrive —
	// which is exactly why they must not arrive as raw protocol noise.
	it("explains a max-lines failure in the active window", function () {
		const {client, transport, chanId} = setup();

		transport.line(
			"@time=2026-08-29T12:00:00.000Z :irc.test FAIL BATCH MULTILINE_MAX_LINES 10 :Multiline batch max-lines exceeded"
		);

		const shown = messages(client.lobby.id);

		expect(shown).to.have.length(1); // once: not also as a raw FAIL
		expect(shown[0].type).to.equal(MessageType.ERROR);
		expect(shown[0].text).to.match(/^Message not sent: /);
		expect(shown[0].text).to.match(/too many lines/);
		expect(shown[0].text).to.include("10");
		expect(shown[0].showInActive).to.equal(true);
		expect(shown[0].time).to.deep.equal(new Date("2026-08-29T12:00:00.000Z"));
		expect(messages(chanId)).to.have.length(0);
	});

	it("explains a max-bytes failure in the active window", function () {
		const {client, transport} = setup();

		transport.line(
			":irc.test FAIL BATCH MULTILINE_MAX_BYTES 40000 :Multiline batch max-bytes exceeded"
		);

		const shown = messages(client.lobby.id);

		expect(shown).to.have.length(1);
		expect(shown[0].type).to.equal(MessageType.ERROR);
		expect(shown[0].text).to.match(/too long/);
		expect(shown[0].text).to.include("40000");
		expect(shown[0].showInActive).to.equal(true);
	});

	it("shows an invalid-target failure in the channel the batch named", function () {
		const {client, transport, chanId} = setup();

		transport.line(
			":irc.test FAIL BATCH MULTILINE_INVALID_TARGET #seance #other :Invalid multiline target"
		);

		const shown = messages(chanId);

		expect(shown).to.have.length(1);
		expect(shown[0].type).to.equal(MessageType.ERROR);
		expect(shown[0].text).to.match(/same target/);
		expect(shown[0].showInActive).to.equal(false);
		expect(messages(client.lobby.id)).to.have.length(0);
	});

	it("passes the server's own words on for MULTILINE_INVALID", function () {
		const {client, transport} = setup();

		transport.line(
			":irc.test FAIL BATCH MULTILINE_INVALID :Invalid multiline batch with blank lines only"
		);

		const shown = messages(client.lobby.id);

		expect(shown).to.have.length(1);
		expect(shown[0].text).to.equal(
			"Message not sent: Invalid multiline batch with blank lines only"
		);
		expect(shown[0].showInActive).to.equal(true);
	});

	it("uses the server's words for an unknown MULTILINE_ code too", function () {
		const {client, transport} = setup();

		transport.line(":irc.test FAIL BATCH MULTILINE_SOMETHING_NEW :Server says no");

		expect(messages(client.lobby.id)[0].text).to.equal("Message not sent: Server says no");
	});

	// Not in the draft: nefarious2 answers every multi-line message that also
	// reached a client without the capability with `WARN BATCH
	// MULTILINE_FALLBACK <target> :Message truncated for N legacy recipients`
	// (observed live 2026-08-29, docs/resources/nefarious2-websocket.md).
	// It arrives once per message and names nothing the sender can do, so the
	// generic WARN line would put a red error under every multi-line message.
	it("says nothing about the server's MULTILINE_FALLBACK warning", function () {
		const {client, transport, chanId} = setup();

		transport.line(
			":irc.test WARN BATCH MULTILINE_FALLBACK #seance :Message truncated for 2 legacy recipients"
		);

		expect(messages(client.lobby.id)).to.have.length(0);
		expect(messages(chanId)).to.have.length(0);
	});

	it("still shows a BATCH warning it has never seen", function () {
		const {client, transport} = setup();

		transport.line(":irc.test WARN BATCH MULTILINE_SOMETHING_NEW #seance :Heads up");

		expect(messages(client.lobby.id)[0].text).to.equal(
			"BATCH: Heads up (#seance) [WARN MULTILINE_SOMETHING_NEW]"
		);
	});

	it("leaves other BATCH failures to the generic standard-reply line", function () {
		const {client, transport} = setup();

		transport.line(":irc.test FAIL BATCH UNKNOWN_BATCH_TYPE :Not a multiline problem");

		const shown = messages(client.lobby.id);

		expect(shown).to.have.length(1);
		expect(shown[0].text).to.equal("BATCH: Not a multiline problem [FAIL UNKNOWN_BATCH_TYPE]");
	});
});
