import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, type SharedMsg} from "../../shared/types/msg";

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
		this.emit({type: "close", code: 1006, reason: "", willReconnect: false});
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.emit({type: "line", line}));
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

let dispatch: sinon.SinonSpy;
let ownsSpy = false;

function installSpy(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
	} else {
		dispatch = sinon.spy(socket, "dispatch");
		ownsSpy = true;
	}
}

function removeSpy(): void {
	if (ownsSpy) {
		dispatch.restore();
	}

	socket.removeAllListeners();
}

/** In #seance with bob, with the given capabilities. */
function setup(caps = "batch labeled-response message-tags server-time"): {
	client: IrcClient;
	transport: FakeTransport;
} {
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
		`:irc.test CAP * LS :${caps}`,
		`:irc.test CAP alice ACK :${caps}`,
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,Ll,imnpst CASEMAPPING=rfc1459 MODES=2 MAXBANS=50 WHOX :are supported by this server",
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	transport.sent.length = 0;
	dispatch.resetHistory();
	return {client, transport};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

function lastLabel(transport: FakeTransport): string {
	return /^@label=(\S+) /.exec(transport.sent.at(-1) ?? "")?.[1] ?? "";
}

type Profile = {network: string; nick: string; status: string; whois?: Record<string, unknown>};

function profiles(): Profile[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "whois:profile")
		.map((call) => call.args[1] as Profile);
}

/** Every line pushed to a window since the setup. */
function pushed(): SharedMsg[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg")
		.map((call) => (call.args[1] as {msg: SharedMsg}).msg);
}

describe("the user profile's quiet WHOIS", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("reads a labeled WHOIS into whois:profile and prints nothing", async function () {
		const {client, transport} = setup();
		client.requestProfile("bob");
		await settle();
		const label = lastLabel(transport);
		expect(transport.sent.at(-1)).to.equal(`@label=${label} WHOIS bob bob`);

		transport.lines(
			`@label=${label} :irc.test BATCH +w labeled-response`,
			"@batch=w :irc.test 311 alice bob bobby example.net * :Bob Example",
			"@batch=w :irc.test 319 alice bob :@#seance #linux",
			"@batch=w :irc.test 312 alice bob hub.test :Test hub",
			"@batch=w :irc.test 301 alice bob :lunch",
			"@batch=w :irc.test 671 alice bob :is using a secure connection",
			"@batch=w :irc.test 330 alice bob bobacct :is logged in as",
			"@batch=w :irc.test 317 alice bob 180 1700000000 :seconds idle, signon time",
			"@batch=w :irc.test 318 alice bob :End of /WHOIS list.",
			":irc.test BATCH -w"
		);
		await settle();

		const [profile] = profiles();
		expect(profile.status).to.equal("online");
		expect(profile.nick).to.equal("bob");
		expect(profile.whois).to.include({
			nick: "bob",
			ident: "bobby",
			hostname: "example.net",
			real_name: "Bob Example",
			server: "hub.test",
			away: "lunch",
			secure: true,
			account: "bobacct",
			channels: "@#seance #linux",
			logonTime: 1700000000000,
		});
		expect(pushed().filter((msg) => msg.type === MessageType.WHOIS)).to.be.empty;
		expect(pushed().filter((msg) => msg.type === MessageType.ERROR)).to.be.empty;
	});

	it("asks WHOWAS when the nick is offline, and prints no error", async function () {
		const {client, transport} = setup();
		client.requestProfile("carol");
		await settle();
		let label = lastLabel(transport);
		transport.lines(
			`@label=${label} :irc.test BATCH +a labeled-response`,
			"@batch=a :irc.test 401 alice carol :No such nick",
			"@batch=a :irc.test 318 alice carol :End of /WHOIS list.",
			":irc.test BATCH -a"
		);
		await settle();

		label = lastLabel(transport);
		expect(transport.sent.at(-1)).to.equal(`@label=${label} WHOWAS carol 1`);
		transport.lines(
			`@label=${label} :irc.test BATCH +b labeled-response`,
			"@batch=b :irc.test 314 alice carol carol old.example * :Carol",
			"@batch=b :irc.test 312 alice carol hub.test :Mon Nov 23 09:14:00 2026",
			"@batch=b :irc.test 369 alice carol :End of WHOWAS",
			":irc.test BATCH -b"
		);
		await settle();

		const [profile] = profiles();
		expect(profile.status).to.equal("offline");
		expect(profile.whois).to.include({nick: "carol", hostname: "old.example", whowas: true});
		expect(pushed()).to.be.empty;
	});

	it("says unavailable, sending nothing, without labeled-response", function () {
		const {client, transport} = setup("batch message-tags server-time");
		client.requestProfile("bob");
		expect(transport.sent).to.be.empty;
		expect(profiles().map((p) => p.status)).to.deep.equal(["unavailable"]);
	});

	it("leaves a typed /whois printing as before", function () {
		const {transport} = setup();
		transport.lines(
			":irc.test 311 alice bob bobby example.net * :Bob Example",
			":irc.test 318 alice bob :End of /WHOIS list."
		);
		expect(pushed().map((msg) => msg.type)).to.include(MessageType.WHOIS);
		expect(profiles()).to.be.empty;
	});
});
