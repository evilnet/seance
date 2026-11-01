/**
 * A special window (channel list, ban/invite/except list, ignore list) is
 * identified by what it shows — its `SpecialChanType` and, for the per-channel
 * lists, the channel — never by its title, which is a translated string and
 * changes with the locale (findings F15).
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import enCatalog from "../../client/locales/en.json";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {setCatalog, t} from "../../client/js/i18n/core";
import {ChanType, SpecialChanType} from "../../shared/types/chan";
import type {SharedNetworkChan} from "../../shared/types/network";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";

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

function joins(): SharedNetworkChan[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "join")
		.map((call) => (call.args[1] as {chan: SharedNetworkChan}).chan);
}

function specials(): {chan: number}[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg:special")
		.map((call) => call.args[1] as {chan: number});
}

function setup(): {client: IrcClient; transport: FakeTransport} {
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});

	client.connect();
	transport.open();
	transport.line(":irc.test CAP * LS :message-tags server-time");
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :"));
	transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing"
	);

	return {client, transport};
}

/** A complete ban list for `channel` (one entry). */
function banList(transport: FakeTransport, channel: string): void {
	transport.lines(
		`:irc.test 367 alice ${channel} *!*@spam.example bob 1756123456`,
		`:irc.test 368 alice ${channel} :End of Channel Ban List`
	);
}

describe("special windows", function () {
	beforeEach(function () {
		installSpy();
		setCatalog("en", enCatalog, undefined);
	});

	afterEach(function () {
		setCatalog("en", enCatalog, undefined);
		removeSpy();
	});

	it("reuses a per-channel list window after a locale change", function () {
		const {client, transport} = setup();

		banList(transport, "#seance");

		const opened = joins();
		expect(opened).to.have.length(1);
		expect(opened[0].type).to.equal(ChanType.SPECIAL);
		expect(opened[0].special).to.equal(SpecialChanType.BANLIST);

		const englishName = opened[0].name;

		// Another locale: the very same window has another title.
		setCatalog("de", enCatalog, {"list.windowTitle": "{kind} von {channel}"});
		expect(t("list.windowTitle", {kind: "Bans", channel: "#seance"})).to.not.equal(englishName);

		banList(transport, "#seance");

		expect(joins(), "no second window").to.have.length(1);
		expect(specials().map((p) => p.chan)).to.deep.equal([opened[0].id]);
		expect(client.channels.filter((chan) => chan.shared.special !== undefined)).to.have.length(
			1
		);
	});

	it("keeps one window per channel, matched case-insensitively", function () {
		const {client, transport} = setup();

		banList(transport, "#seance");
		banList(transport, "#other");
		expect(joins()).to.have.length(2);

		// RFC1459 casemapping: #SEANCE is the same channel.
		banList(transport, "#SEANCE");
		expect(joins(), "no window for a case variant").to.have.length(2);
		expect(client.channels.filter((chan) => chan.shared.special !== undefined)).to.have.length(
			2
		);
	});
});
