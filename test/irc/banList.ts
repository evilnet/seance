import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {banModeLines, changeBans, kickLine} from "../../client/js/irc/banList";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {utf8ByteLength} from "../../client/js/irc/message";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {SharedBanList} from "../../shared/types/ban-list";
import {MessageType, type SharedMsg} from "../../shared/types/msg";
import {ChanType} from "../../shared/types/chan";

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

function events(): {list: SharedBanList; open: boolean}[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "channel:bans")
		.map((call) => call.args[1] as {list: SharedBanList; open: boolean});
}

const masks = (list: SharedBanList | undefined) => list?.rows.map((row) => row.mask);
const last = () => events().at(-1);

/** In #seance as an op, MODES=2, with the given capabilities. */
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

/** The label of the last line sent. */
function lastLabel(transport: FakeTransport): string {
	return /^@label=(\S+) /.exec(transport.sent.at(-1) ?? "")?.[1] ?? "";
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

/** Answer the last line sent: what the server said, then its ACK. */
async function answer(transport: FakeTransport, ...replies: string[]): Promise<void> {
	await settle();
	const label = lastLabel(transport);
	transport.lines(...replies, `@label=${label} :irc.test ACK`);
	await settle();
}

const ECHO = ":alice!alice@host MODE #seance";

describe("channel bans (banList.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	describe("the list", function () {
		it("asks with a label and keeps the answer, opening no window", async function () {
			const {client, transport} = setup();

			client.requestBanList("#seance");
			expect(transport.sent).to.deep.equal(["@label=r1 MODE #seance b"]);
			expect(last()?.list.status).to.equal("loading");

			transport.lines(
				"@label=r1 :irc.test 367 alice #seance *!*@spam.example bob 1700000000",
				"@label=r1 :irc.test 367 alice #seance ~a:troll chanserv",
				"@label=r1 :irc.test 368 alice #seance :End of Channel Ban List"
			);
			await settle();

			const bans = last();
			expect(bans?.open).to.equal(false);
			expect(bans?.list.status).to.equal("done");
			expect(bans?.list.limit).to.equal(50);
			expect(bans?.list.rows).to.deep.equal([
				{mask: "*!*@spam.example", by: "bob", at: 1700000000000},
				{mask: "~a:troll", by: "chanserv", at: undefined},
			]);
			expect(
				client.channels.filter((c) => c.shared.type === ChanType.SPECIAL)
			).to.have.length(0);
		});

		it("says what the server said when it refuses", async function () {
			const {client, transport} = setup();

			client.requestBanList("#nowhere");
			transport.lines("@label=r1 :irc.test 403 alice #nowhere :No such channel");
			await settle();

			expect(last()?.list.status).to.equal("error");
			expect(last()?.list.note).to.contain("No such channel");
		});

		it("opens the window for /banlist and for a typed /mode #chan b", async function () {
			const {client, transport} = setup();

			client.input(client.findChannel("#seance")!.id, "/banlist");
			expect(events()[0].open, "at once").to.equal(true);
			transport.lines("@label=r1 :irc.test 368 alice #seance :End of Channel Ban List");
			await settle();
			expect(events().at(-1)?.open, "and not again").to.equal(false);

			transport.lines(
				":irc.test 367 alice #seance typed!*@* bob 1",
				":irc.test 368 alice #seance :End of Channel Ban List"
			);
			expect(events().at(-1)?.open, "nobody asked this one").to.equal(true);
		});

		it("works without labeled-response", function () {
			const {client, transport} = setup("multi-prefix");

			client.requestBanList("#seance");
			expect(transport.sent).to.deep.equal(["MODE #seance b"]);
			transport.lines(
				":irc.test 367 alice #seance a!*@* bob 1",
				":irc.test 368 alice #seance :End of Channel Ban List"
			);

			expect(masks(last()?.list)).to.deep.equal(["a!*@*"]);
			expect(last()?.open).to.equal(false);
		});

		it("is forgotten when the connection goes", async function () {
			const {client, transport} = setup();

			client.requestBanList("#seance");
			transport.lines("@label=r1 :irc.test 368 alice #seance :End of Channel Ban List");
			await settle();
			transport.close();
			client.connect();
			transport.open();

			expect(client.bans.snapshot("#seance").status).to.equal("idle");
		});
	});

	describe("MODE lines", function () {
		async function listed(): Promise<ReturnType<typeof setup>> {
			const h = setup();
			h.client.requestBanList("#seance");
			h.transport.lines(
				"@label=r1 :irc.test 367 alice #seance old!*@* bob 1700000000",
				"@label=r1 :irc.test 368 alice #seance :End of Channel Ban List"
			);
			await settle();
			dispatch.resetHistory();
			return h;
		}

		it("keeps the list current, whoever changes it", async function () {
			const {transport} = await listed();

			transport.lines(
				"@time=2026-11-06T10:00:00.000Z :carol!c@h MODE #seance +b new!*@*",
				":carol!c@h MODE #seance -b old!*@*"
			);

			expect(last()?.list.rows).to.deep.equal([
				{mask: "new!*@*", by: "carol", at: Date.parse("2026-11-06T10:00:00.000Z")},
			]);
		});

		it("follows a wider ban replacing a narrower one", async function () {
			const {transport} = await listed();

			transport.lines(":carol!c@h MODE #seance -b+b old!*@* old*!*@*");
			expect(masks(last()?.list)).to.deep.equal(["old*!*@*"]);
		});

		it("ignores other modes, and tells masks apart case-insensitively", async function () {
			const {transport} = await listed();

			transport.lines(":carol!c@h MODE #seance +o bob");
			expect(events()).to.have.length(0);

			transport.lines(":carol!c@h MODE #seance -b OLD!*@*");
			expect(masks(last()?.list)).to.deep.equal([]);
		});

		it("still shows the change in the channel", async function () {
			const {client, transport} = await listed();

			transport.lines(":carol!c@h MODE #seance +b new!*@*");

			const shown = dispatch
				.getCalls()
				.filter((call) => call.args[0] === "msg")
				.map((call) => (call.args[1] as {chan: number; msg: SharedMsg}).msg);
			expect(shown.map((msg) => [msg.type, msg.text])).to.deep.equal([
				[MessageType.MODE, "+b new!*@*"],
			]);
			expect(client.findChannel("#seance")).to.not.equal(undefined);
		});

		it("does nothing to a list nobody has asked for", function () {
			const {client, transport} = setup();

			transport.lines(":carol!c@h MODE #seance +b new!*@*");
			expect(client.bans.snapshot("#seance").rows).to.deep.equal([]);
		});
	});

	describe("banModeLines", function () {
		it("takes the old ban off before the new one goes on, in one line", function () {
			expect(banModeLines("#c", ["old!*@*"], ["new!*@*"], 6)).to.deep.equal([
				"MODE #c -b+b old!*@* new!*@*",
			]);
		});

		it("splits at the server's MODES", function () {
			expect(banModeLines("#c", ["a", "b", "c"], [], 2)).to.deep.equal([
				"MODE #c -bb a b",
				"MODE #c -b c",
			]);
		});

		it("splits where a line would pass the byte cap, label included", function () {
			const mask = (n: number) => `${n}${"x".repeat(100)}!*@*`;
			const out = banModeLines("#c", [1, 2, 3, 4, 5, 6].map(mask), [], 6);

			expect(out.length).to.be.greaterThan(1);

			for (const line of out) {
				expect(utf8ByteLength(line)).to.be.at.most(480);
			}
		});

		it("makes no line of no change", function () {
			expect(banModeLines("#c", [], [], 6)).to.deep.equal([]);
		});
	});

	it("words a kick with and without a reason", function () {
		expect(kickLine("#c", "bob", "go away")).to.equal("KICK #c bob :go away");
		expect(kickLine("#c", "bob", "")).to.equal("KICK #c bob");
	});

	describe("changeBans", function () {
		it("is ok once the channel shows it and the server ACKs", async function () {
			const {client, transport} = setup();
			const done = changeBans(client, {channel: "#seance", remove: [], add: ["x!*@*"]});

			await answer(transport, `${ECHO} +b x!*@*`);

			expect(await done).to.deep.equal({outcome: "ok"});
			expect(transport.sent[0]).to.equal("@label=r1 MODE #seance +b x!*@*");
		});

		it("is unchanged on an ACK with no MODE line: a covered ban, a kind switched off", async function () {
			const {client, transport} = setup();
			const done = changeBans(client, {
				channel: "#seance",
				remove: [],
				add: ["~a:bob"],
				kick: {nicks: ["bob"], reason: ""},
			});

			await answer(transport);

			expect(await done).to.deep.equal({outcome: "unchanged"});
			expect(transport.sent, "no kick on a ban that did not land").to.have.length(1);
		});

		it("reports a refusal in the server's words", async function () {
			const {client, transport} = setup();
			const done = changeBans(client, {channel: "#seance", remove: ["a"], add: []});

			await settle();
			transport.lines(`@label=r1 :irc.test 482 alice #seance :You're not channel operator`);

			expect(await done).to.deep.equal({
				outcome: "refused",
				text: "#seance: You're not channel operator",
			});
		});

		it("sends one line at a time, each after the last was answered", async function () {
			const {client, transport} = setup();
			const done = changeBans(client, {channel: "#seance", remove: ["a", "b", "c"], add: []});

			await settle();
			expect(transport.sent).to.have.length(1);

			await answer(transport, `${ECHO} -bb a b`);
			expect(transport.sent).to.have.length(2);
			expect(transport.sent[1]).to.equal("@label=r2 MODE #seance -b c");

			await answer(transport, `${ECHO} -b c`);
			expect(await done).to.deep.equal({outcome: "ok"});
		});

		it("kicks after the ban is on, even with no ban to add", async function () {
			const {client, transport} = setup();
			const done = changeBans(client, {
				channel: "#seance",
				remove: [],
				add: [],
				kick: {nicks: ["bob"], reason: "bye"},
			});

			await settle();
			expect(transport.sent).to.deep.equal(["@label=r1 KICK #seance bob :bye"]);
			await answer(transport, ":alice!alice@host KICK #seance bob :bye");

			expect(await done).to.deep.equal({outcome: "ok"});
		});

		it("shows a MODE a server labeled itself, as the spec has it", async function () {
			const {client, transport} = setup();
			client.requestBanList("#seance");
			transport.lines("@label=r1 :irc.test 368 alice #seance :End of Channel Ban List");
			await settle();
			const done = changeBans(client, {channel: "#seance", remove: [], add: ["x!*@*"]});

			await settle();
			transport.lines(`@label=r2 ${ECHO} +b x!*@*`);

			expect(await done).to.deep.equal({outcome: "ok"});
			expect(masks(client.bans.snapshot("#seance"))).to.deep.equal(["x!*@*"]);
		});

		it("is closed with no connection to send on", async function () {
			const {client, transport} = setup();
			transport.close();

			expect(
				(await changeBans(client, {channel: "#seance", remove: ["a"], add: []})).outcome
			).to.equal("closed");
		});

		it("queues its lines where nothing can be waited for", async function () {
			const {client, transport} = setup("multi-prefix");

			expect(
				await changeBans(client, {channel: "#seance", remove: ["a"], add: []})
			).to.deep.equal({outcome: "ok"});
			expect(transport.sent).to.deep.equal(["MODE #seance -b a"]);
		});
	});
});
