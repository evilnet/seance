/**
 * Shared harness for the reply / reaction / redaction / edit suites
 * (reactions.ts, redact.ts, edit.ts). The client dispatches to a private
 * sinon spy (`bus: {dispatch}`) rather than the app bus, so these files can
 * run alongside test/irc/client.ts, which spies on `socket.dispatch`.
 */

import {expect} from "chai";
import sinon from "sinon";
import storage from "../../client/js/localStorage";
import {IrcClient, IrcClientOptions} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {NO_FAKE_LAG} from "../../client/js/irc/fakelag";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {SharedMsg} from "../../shared/types/msg";
import {parseBotWhois, recordBotWhois} from "../../client/js/irc/bottrust";
import {parseLine} from "../../client/js/irc/message";

/** In-memory transport driven by the tests (same shape as test/irc/client.ts). */
export class FakeTransport implements Transport {
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
		if (this.state !== "open") {
			throw new Error("WsTransport: not open");
		}

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

	/** Any transport event, as the real transport would emit it. */
	event(ev: TransportEvent): void {
		this.emit(ev);
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

export interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	dispatch: sinon.SinonSpy;
	/** Lines sent since the last call. */
	sent(): string[];
	/** Every payload dispatched for `event`. */
	payloads<T = any>(event: string): T[];
	/** Every `msg` payload's message, optionally for one channel id. */
	messages(chanId?: number): SharedMsg[];
	lastMessage(chanId?: number): SharedMsg;
	/** Event names dispatched, in order (for ordering assertions). */
	events(): string[];
}

export const ALL_CAPS =
	"message-tags server-time echo-message batch labeled-response standard-replies draft/chathistory=100 draft/event-playback draft/message-redaction";

let uuidCounter = 0;

/** A client with a fresh spy bus and its own uuid (keeps the cached ignore lists apart). */
export function setup(overrides: Partial<IrcClientOptions> = {}): Harness {
	const transport = new FakeTransport();
	const dispatch = sinon.spy();
	const client = new IrcClient({
		bus: {dispatch},
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		uuid: `rr-net-${++uuidCounter}`,
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
		// Background work goes out at once unless a test models the server's
		// fake lag itself (test/irc/catchup.ts).
		fakeLag: NO_FAKE_LAG,
		...overrides,
	});
	let mark = 0;

	const payloads = <T = any>(event: string): T[] =>
		dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	const messages = (chanId?: number): SharedMsg[] =>
		payloads<{chan: number; msg: SharedMsg}>("msg")
			.filter((p) => chanId === undefined || p.chan === chanId)
			.map((p) => p.msg);

	return {
		client,
		transport,
		dispatch,
		sent() {
			const result = transport.sent.slice(mark);
			mark = transport.sent.length;
			return result;
		},
		payloads,
		messages,
		lastMessage(chanId?: number) {
			const list = messages(chanId);
			return list[list.length - 1];
		},
		events() {
			return dispatch.getCalls().map((call) => call.args[0] as string);
		},
	};
}

/**
 * Drive CAP / 001 / 005 / 422 with the server offering `caps`; `beforeMotd`
 * lines (e.g. `PERSISTENCE STATUS`) go out between 005 and 422.
 */
export function register(
	h: Harness,
	caps = ALL_CAPS,
	beforeMotd: string[] = [],
	version = "u2.10.12.14+Nefarious(2.0.0)"
): void {
	h.client.connect();
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${caps}`);
	const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));

	if (caps.length > 0) {
		expect(req, "CAP REQ sent").to.be.a("string");
		h.transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	}

	h.transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		// nefarious2 by default, the server these fixtures follow (profiles/).
		`:irc.test 004 alice irc.test ${version} iow bklmnopstv bklov`,
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 STATUSMSG=@+ CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server",
		...beforeMotd,
		":irc.test 422 alice :MOTD File is missing"
	);
	h.sent();
}

/** The label of the last CHATHISTORY line in `lines`, or undefined. */
export function labelOf(lines: string[]): string | undefined {
	return lines.find((l) => l.includes("CHATHISTORY"))?.match(/^@label=([^ ;]+)/)?.[1];
}

/** Send a chathistory batch for `target`; `lines` get the batch tag added. */
export function batch(
	h: Harness,
	lines: string[],
	opts: {ref?: string; target?: string; label?: string; end?: boolean} = {}
): void {
	const ref = opts.ref ?? "hist1";
	const target = opts.target ?? "#seance";
	const tags = [
		...(opts.end ? ["draft/chathistory-end"] : []),
		...(opts.label ? [`label=${opts.label}`] : []),
	];
	h.transport.line(
		`${tags.length ? `@${tags.join(";")} ` : ""}:irc.test BATCH +${ref} chathistory ${target}`
	);

	for (const line of lines) {
		h.transport.line(
			line.startsWith("@") ? `@batch=${ref};${line.slice(1)}` : `@batch=${ref} ${line}`
		);
	}

	h.transport.line(`:irc.test BATCH -${ref}`);
}

/**
 * Register (with `caps`), have the server confirm our JOIN to #seance and
 * answer the automatic LATEST request with `history` (default: nothing).
 * Returns the channel id.
 */
export function joined(h: Harness, caps = ALL_CAPS, history: string[] = []): number {
	register(h, caps);
	h.transport.lines(
		"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host.example JOIN #seance",
		":irc.test 353 alice = #seance :@alice bob +carol",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	const label = labelOf(h.sent());

	if (h.client.caps.hasCapability("draft/chathistory")) {
		batch(h, history, {label});
	}

	h.dispatch.resetHistory();
	h.sent();
	return h.client.findChannel("#seance")!.id;
}

/** Stub `client/js/localStorage` with an in-memory map (ignore lists read it). */
export function stubStorage(): void {
	const data = new Map<string, string>();
	sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
	sinon.stub(storage, "set").callsFake((key: string, value: string) => void data.set(key, value));
	sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
}

/**
 * Make `nick` a checked services bot on this connection (irc/bottrust.ts),
 * from the WHOIS lines a real one answers with: online at `userhost`, and
 * called a network service (310).
 */
export function trustBot(
	client: IrcClient,
	nick: string,
	userhost = `${nick}@services.test`
): void {
	const [user, host] = userhost.split("@");
	const lines = [
		`:irc.test 311 ${client.nick} ${nick} ${user} ${host} * :Oper Services`,
		`:irc.test 312 ${client.nick} ${nick} services.test :Services`,
		`:irc.test 310 ${client.nick} ${nick} :is a Network Service`,
	].map((line) => parseLine(line)!);
	recordBotWhois(client, nick, parseBotWhois(lines));
}
