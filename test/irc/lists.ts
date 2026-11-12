import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {parseListTime} from "../../client/js/irc/handlers/lists";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {ChanType, SpecialChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import type {SharedNetworkChan} from "../../shared/types/network";

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

interface JoinPayload {
	network: string;
	chan: SharedNetworkChan;
	index: number;
	shouldOpen: boolean;
}

interface SpecialPayload {
	chan: number;
	data: Record<string, unknown>[];
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

function payloads<T>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

function messages(chanId: number): SharedMsg[] {
	return payloads<{chan: number; msg: SharedMsg}>("msg")
		.filter((p) => p.chan === chanId)
		.map((p) => p.msg);
}

function specialJoins(): JoinPayload[] {
	return payloads<JoinPayload>("join").filter((p) => p.chan.type === ChanType.SPECIAL);
}

/** A registered client that has joined #seance and #other. */
function setup(): {client: IrcClient; transport: FakeTransport} {
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
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=beI,k,l,imnpst CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing",
		":alice!alice@host JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob",
		":irc.test 366 alice #seance :End of /NAMES list.",
		":alice!alice@host JOIN #other",
		":irc.test 353 alice = #other :@alice",
		":irc.test 366 alice #other :End of /NAMES list."
	);
	dispatch.resetHistory();

	return {client, transport};
}

describe("IRC channel list numerics (lists.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	describe("invite exception list (346/347)", function () {
		it("opens an invite-list window with invited_by / invited_at rows", function () {
			const {transport} = setup();

			transport.lines(
				":irc.test 346 alice #seance friend!*@* alice 1700000000",
				":irc.test 346 alice #seance ~a:buddy bob 1700000500",
				":irc.test 347 alice #seance :End of Channel Invite List"
			);

			const joins = specialJoins();
			expect(joins).to.have.length(1);
			expect(joins[0].chan.name).to.equal("Invite list for #seance");
			expect(joins[0].chan.special).to.equal(SpecialChanType.INVITELIST);
			expect(joins[0].chan.data).to.deep.equal([
				{hostmask: "friend!*@*", invited_by: "alice", invited_at: new Date(1700000000000)},
				{hostmask: "~a:buddy", invited_by: "bob", invited_at: new Date(1700000500000)},
			]);
		});

		it("reports an empty invite list", function () {
			const {client, transport} = setup();

			transport.line(":irc.test 347 alice #seance :End of Channel Invite List");

			expect(messages(client.findChannel("#seance")!.id).map((m) => m.text)).to.deep.equal([
				"Invite list is empty",
			]);
		});
	});

	describe("ban exception list (348/349)", function () {
		it("opens an exception-list window with its own special type", function () {
			const {transport} = setup();

			transport.lines(
				":irc.test 348 alice #seance *!*@trusted.example alice 1700000000",
				":irc.test 349 alice #seance :End of channel exception list"
			);

			const joins = specialJoins();
			expect(joins).to.have.length(1);
			expect(joins[0].chan.name).to.equal("Exception list for #seance");
			expect(joins[0].chan.special).to.equal(SpecialChanType.EXCEPTLIST);
			expect(joins[0].chan.data).to.deep.equal([
				{
					hostmask: "*!*@trusted.example",
					banned_by: "alice",
					banned_at: new Date(1700000000000),
				},
			]);
		});

		it("keeps ban, exception and invite buffers for the same channel separate", function () {
			const {client, transport} = setup();

			transport.lines(
				":irc.test 367 alice #seance ban!*@* alice 1",
				":irc.test 348 alice #seance except!*@* alice 2",
				":irc.test 346 alice #seance invex!*@* alice 3",
				":irc.test 349 alice #seance :End of channel exception list",
				":irc.test 347 alice #seance :End of Channel Invite List",
				":irc.test 368 alice #seance :End of Channel Ban List"
			);

			const joins = specialJoins();
			expect(joins.map((j) => j.chan.name)).to.deep.equal([
				"Exception list for #seance",
				"Invite list for #seance",
			]);
			expect(
				joins.map((j) => (j.chan.data as {hostmask: string}[]).map((r) => r.hostmask))
			).to.deep.equal([["except!*@*"], ["invex!*@*"]]);
			expect(client.bans.snapshot("#seance").rows.map((row) => row.mask)).to.deep.equal([
				"ban!*@*",
			]);
		});
	});

	describe("parseListTime", function () {
		it("converts unix seconds to a Date and rejects anything else", function () {
			expect(parseListTime("1700000000")).to.deep.equal(new Date(1700000000000));
			expect(parseListTime(undefined)).to.equal(undefined);
			expect(parseListTime("soon")).to.equal(undefined);
			expect(parseListTime("-5")).to.equal(undefined);
		});
	});
});
