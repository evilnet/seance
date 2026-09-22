import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {dispatchInput} from "../../client/js/irc/commands";
import {parseWhoFlags} from "../../client/js/irc/handlers/who";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, SharedMsg} from "../../shared/types/msg";

/** Minimal in-memory transport: only what registration and line feeding need. */
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

/** A registered client in #seance; `whox` puts WHOX in ISUPPORT. */
function setup(whox = true): {client: IrcClient; transport: FakeTransport} {
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
		":irc.test CAP * LS :multi-prefix",
		":irc.test CAP alice ACK :multi-prefix",
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		`:irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=beI,k,l,imnpst CASEMAPPING=rfc1459${
			whox ? " WHOX" : ""
		} :are supported by this server`,
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	transport.sent = [];
	dispatch.resetHistory();

	return {client, transport};
}

describe("WHO (handlers/who.ts, commands/who.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("parses nefarious2's flags column", function () {
		expect(parseWhoFlags("H")).to.include({away: false, oper: false, prefixes: ""});
		expect(parseWhoFlags("G*@+xzB")).to.include({
			away: true,
			oper: true,
			prefixes: "@+",
			secure: true,
			bot: true,
		});
	});

	it("/who asks for the WHOX fields with a token and shows one table in the channel", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who #seance");
		expect(transport.sent).to.deep.equal(["WHO #seance %tcuhsnfdar,1"]);

		transport.lines(
			":irc.test 354 alice 1 #seance alice host.example irc.test alice H@x 0 alice :Alice Example",
			":irc.test 354 alice 1 #seance ~bob 10.0.0.2 irc.other bob G+z 1 0 :Bob",
			":irc.test 315 alice #seance :End of /WHO list."
		);

		const msgs = messages(chan.id);
		expect(msgs).to.have.length(1);
		expect(msgs[0].type).to.equal(MessageType.WHO);
		expect(msgs[0].who!.target).to.equal("#seance");
		expect(msgs[0].who!.entries).to.deep.equal([
			{
				nick: "alice",
				ident: "alice",
				hostname: "host.example",
				server: "irc.test",
				channel: "#seance",
				flags: "H@x",
				away: false,
				oper: false,
				prefixes: "@",
				secure: false,
				bot: false,
				account: "alice",
				hops: 0,
				realname: "Alice Example",
			},
			{
				nick: "bob",
				ident: "~bob",
				hostname: "10.0.0.2",
				server: "irc.other",
				channel: "#seance",
				flags: "G+z",
				away: true,
				oper: false,
				prefixes: "+",
				secure: true,
				bot: false,
				account: undefined,
				hops: 1,
				realname: "Bob",
			},
		]);
		expect(messages(client.lobby.id)).to.be.empty;
	});

	it("/who without a mask is the current channel; elsewhere it is an error", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who");
		expect(transport.sent).to.deep.equal(["WHO #seance %tcuhsnfdar,1"]);

		dispatchInput(client, client.lobby, "/who");
		expect(transport.sent).to.have.length(1);
		const errors = messages(client.lobby.id);
		expect(errors).to.have.length(1);
		expect(errors[0].type).to.equal(MessageType.ERROR);
		expect(errors[0].text).to.match(/^Usage: \/who/);
	});

	it("without WHOX, a plain WHO and 352 rows", function () {
		const {client, transport} = setup(false);
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who #seance");
		expect(transport.sent).to.deep.equal(["WHO #seance"]);

		transport.lines(
			":irc.test 352 alice #seance ~bob 10.0.0.2 irc.other bob H*@ :2 Bob Builder",
			":irc.test 315 alice #seance :End of /WHO list."
		);

		const msgs = messages(chan.id);
		expect(msgs).to.have.length(1);
		expect(msgs[0].who!.entries).to.deep.equal([
			{
				nick: "bob",
				ident: "~bob",
				hostname: "10.0.0.2",
				server: "irc.other",
				channel: "#seance",
				flags: "H*@",
				away: false,
				oper: true,
				prefixes: "@",
				secure: false,
				bot: false,
				hops: 2,
				realname: "Bob Builder",
			},
		]);
	});

	it("a mask that is not a channel we are in reports where it was typed", function () {
		const {client, transport} = setup();

		dispatchInput(client, client.lobby, "/who *!*@*.example.org o");
		expect(transport.sent).to.deep.equal(["WHO *!*@*.example.org o %tcuhsnfdar,1"]);

		transport.lines(
			":irc.test 354 alice 1 * ~op host.example.org irc.test carol H* 0 carol :Carol",
			":irc.test 315 alice *!*@*.example.org :End of /WHO list."
		);

		const msgs = messages(client.lobby.id);
		expect(msgs).to.have.length(1);
		expect(msgs[0].who!.target).to.equal("*!*@*.example.org");
		expect(msgs[0].who!.entries[0]).to.include({nick: "carol", channel: undefined, oper: true});
	});

	it("no rows: one error line, no table", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who nobody");
		transport.line(":irc.test 315 alice nobody :End of /WHO list.");

		const msgs = messages(chan.id);
		expect(msgs).to.have.length(1);
		expect(msgs[0].type).to.equal(MessageType.ERROR);
		expect(msgs[0].text).to.equal("No one matched WHO nobody");
	});

	it("queries are answered in order, each with its own token", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who #seance");
		dispatchInput(client, client.lobby, "/who bob");
		expect(transport.sent).to.deep.equal([
			"WHO #seance %tcuhsnfdar,1",
			"WHO bob %tcuhsnfdar,2",
		]);

		transport.lines(
			":irc.test 354 alice 1 #seance alice host irc.test alice H@ 0 0 :Alice",
			":irc.test 315 alice #seance :End of /WHO list.",
			":irc.test 354 alice 2 #seance ~bob host irc.test bob H 0 0 :Bob",
			":irc.test 315 alice bob :End of /WHO list."
		);

		expect(messages(chan.id).map((m) => m.who!.target)).to.deep.equal(["#seance"]);
		expect(messages(client.lobby.id).map((m) => m.who!.target)).to.deep.equal(["bob"]);
	});

	it("a user's own %fields spec goes out as typed and comes back as text", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/who #seance %na");
		expect(transport.sent).to.deep.equal(["WHO #seance %na"]);

		transport.lines(
			":irc.test 354 alice bob 0",
			":irc.test 354 alice alice alice",
			":irc.test 315 alice #seance :End of /WHO list."
		);

		const msgs = messages(chan.id);
		expect(msgs.map((m) => m.text)).to.deep.equal(["bob 0", "alice alice"]);
		expect(msgs.every((m) => m.type === undefined || m.type === MessageType.MESSAGE)).to.be
			.true;
	});

	it("replies nobody asked for are plain text in the lobby", function () {
		const {client, transport} = setup();

		transport.lines(
			":irc.test 352 alice #seance ~bob host irc.test bob H :0 Bob",
			":irc.test 315 alice #seance :End of /WHO list."
		);

		const msgs = messages(client.lobby.id);
		expect(msgs.map((m) => m.text)).to.deep.equal([
			"#seance ~bob host irc.test bob H 0 Bob",
			"#seance End of /WHO list.",
		]);
		expect(msgs[0].showInActive).to.equal(true);
	});
});
