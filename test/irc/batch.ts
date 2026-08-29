import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {
	OpenBatch,
	openBatchesOf,
	registerBatchHandler,
	unregisterBatchHandler,
} from "../../client/js/irc/handlers/batch";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
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

/** A registered client in #seance with bob and carol present. */
function setup(): {client: IrcClient; transport: FakeTransport; chanId: number} {
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
	transport.lines(
		":irc.test CAP * LS :batch message-tags server-time",
		":irc.test CAP alice ACK :batch message-tags server-time",
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=beI,k,l,imnpst CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob carol",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	dispatch.resetHistory();
	transport.sent.length = 0;

	return {client, transport, chanId: client.findChannel("#seance")!.id};
}

describe("BATCH handling (handlers/batch.ts)", function () {
	const received: OpenBatch[] = [];

	beforeEach(function () {
		installSpy();
		received.length = 0;
		registerBatchHandler("seance-test", (_client, batch) => {
			received.push(batch);
		});
	});

	afterEach(function () {
		unregisterBatchHandler("seance-test");
		removeSpy();
	});

	it("buffers tagged lines and delivers them as a unit on close", function () {
		const {client, transport, chanId} = setup();

		transport.lines(
			"@label=abc :irc.test BATCH +b1 seance-test #seance extra",
			"@batch=b1 :bob!b@h PRIVMSG #seance :one",
			"@batch=b1;time=2026-08-20T10:00:00.000Z :carol!c@h PRIVMSG #seance :two"
		);
		expect(messages(chanId), "nothing delivered before close").to.have.length(0);
		expect(received).to.have.length(0);
		expect(openBatchesOf(client).has("b1")).to.equal(true);

		transport.line(":irc.test BATCH -b1");

		expect(received).to.have.length(1);
		const [batch] = received;
		expect(batch.ref).to.equal("b1");
		expect(batch.type).to.equal("seance-test");
		expect(batch.params).to.deep.equal(["#seance", "extra"]);
		expect(batch.tags.get("label")).to.equal("abc");
		expect(batch.messages.map((m) => m.params[1])).to.deep.equal(["one", "two"]);
		expect(batch.messages[1].tags.get("time")).to.equal("2026-08-20T10:00:00.000Z");
		expect(messages(chanId), "handled types are not unwrapped").to.have.length(0);
		expect(openBatchesOf(client).has("b1")).to.equal(false);
	});

	it("unwraps unknown batch types in order when they close", function () {
		const {client, transport, chanId} = setup();
		const chan = client.findChannel("#seance")!;

		transport.lines(
			":irc.test BATCH +ns netsplit irc.test irc2.test",
			"@batch=ns :bob!b@h QUIT :irc.test irc2.test",
			"@batch=ns :carol!c@h QUIT :irc.test irc2.test"
		);
		expect(messages(chanId)).to.have.length(0);
		expect(chan.findUser("bob"), "not applied before close").to.not.equal(undefined);

		transport.line(":irc.test BATCH -ns");

		const quits = messages(chanId);
		expect(quits.map((m) => m.type)).to.deep.equal([MessageType.QUIT, MessageType.QUIT]);
		expect(quits.map((m) => m.from?.nick)).to.deep.equal(["bob", "carol"]);
		expect(chan.findUser("bob")).to.equal(undefined);
		expect(chan.findUser("carol")).to.equal(undefined);
	});

	it("folds a nested unhandled batch into its parent and unwraps everything in order", function () {
		const {transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH +outer some-type",
			"@batch=outer :bob!b@h PRIVMSG #seance :first",
			"@batch=outer :irc.test BATCH +inner some-nested-type #seance",
			"@batch=inner :carol!c@h PRIVMSG #seance :second",
			"@batch=inner :carol!c@h PRIVMSG #seance :third",
			"@batch=outer :irc.test BATCH -inner",
			"@batch=outer :bob!b@h PRIVMSG #seance :fourth"
		);
		expect(messages(chanId), "nothing until the outer batch closes").to.have.length(0);

		transport.line(":irc.test BATCH -outer");

		expect(messages(chanId).map((m) => m.text)).to.deep.equal([
			"first",
			"second",
			"third",
			"fourth",
		]);
	});

	it("delivers a nested batch with a handler on its own close, not via the parent", function () {
		const {transport, chanId} = setup();

		transport.lines(
			"@label=lbl :irc.test BATCH +outer labeled-response",
			"@batch=outer :irc.test BATCH +inner seance-test #seance",
			"@batch=inner :bob!b@h PRIVMSG #seance :inside",
			"@batch=outer :irc.test BATCH -inner"
		);

		expect(received).to.have.length(1);
		expect(received[0].parent?.type).to.equal("labeled-response");
		expect(received[0].parent?.tags.get("label")).to.equal("lbl");
		expect(received[0].messages.map((m) => m.params[1])).to.deep.equal(["inside"]);

		transport.line(":irc.test BATCH -outer");
		expect(
			messages(chanId),
			"the handled inner batch is not unwrapped by the parent"
		).to.have.length(0);
		expect(received).to.have.length(1);
	});

	it("ignores malformed markers and closes for unknown references", function () {
		const {client, transport, chanId} = setup();

		transport.lines(
			":irc.test BATCH",
			":irc.test BATCH +",
			":irc.test BATCH -nope",
			":irc.test BATCH ?weird seance-test",
			":bob!b@h PRIVMSG #seance :still alive"
		);

		expect(openBatchesOf(client).size).to.equal(0);
		expect(received).to.have.length(0);
		expect(messages(chanId).map((m) => m.text)).to.deep.equal(["still alive"]);
	});

	it("passes lines tagged with an unknown batch reference straight through", function () {
		const {transport, chanId} = setup();

		transport.line("@batch=ghost :bob!b@h PRIVMSG #seance :not buffered");

		expect(messages(chanId).map((m) => m.text)).to.deep.equal(["not buffered"]);
	});

	it("drops open batches when the transport closes", function () {
		const {client, transport} = setup();

		transport.lines(
			":irc.test BATCH +b1 seance-test #seance",
			"@batch=b1 :bob!b@h PRIVMSG #seance :lost"
		);
		expect(openBatchesOf(client).size).to.equal(1);

		transport.closed();
		expect(openBatchesOf(client).size).to.equal(0);

		transport.open();
		transport.line(":irc.test BATCH -b1");
		expect(received).to.have.length(0);
	});
});
