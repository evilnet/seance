import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {
	pendingSearches,
	requestSearch,
	requestSearchContext,
	resetSearches,
	SEARCH_TIMEOUT_MS,
	SEARCH_TOMBSTONE_MS,
	specSearchParams,
} from "../../client/js/irc/historysearch";
import {pendingHistory} from "../../client/js/irc/history";
import {nefarious} from "../../client/js/irc/profiles/nefarious";
import {IRCU_FAKE_LAG, NO_FAKE_LAG, type FakeLagModel} from "../../client/js/irc/fakelag";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, type SharedMsg} from "../../shared/types/msg";
import type {SearchHit, SearchStatus} from "../../shared/types/search";

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

interface ResultsPayload {
	requestId: number;
	status: SearchStatus;
	error?: string;
	hits: SearchHit[];
}

interface ContextPayload {
	end?: boolean;
	changes?: {msgid: string; redact?: {by: string}}[];
	requestId: number;
	status: SearchStatus;
	messages: SharedMsg[];
}

let dispatch: sinon.SinonSpy;
let ownsSpy = false;
let clock: sinon.SinonFakeTimers;

function payloads<T>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

interface Options {
	caps?: string;
	nefarious?: boolean;
	fakeLag?: FakeLagModel;
}

const ALL_CAPS =
	"batch message-tags server-time labeled-response draft/chathistory=100 standard-replies account-tag soju.im/search";

function setup(opts: Options = {}): {client: IrcClient; transport: FakeTransport} {
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
		fakeLag: opts.fakeLag ?? NO_FAKE_LAG,
	});

	client.connect();
	transport.open();
	transport.line(`:irc.test CAP * LS :${opts.caps ?? ALL_CAPS}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
	transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
	transport.line(":irc.test 001 alice :Welcome");
	transport.line(
		`:irc.test 004 alice irc.test ${
			opts.nefarious ? "u2.10.12.14+Nefarious(2.0.0)" : "someircd-1"
		} io bklmnopst`
	);
	transport.line(":irc.test 422 alice :MOTD File is missing");
	transport.line("@time=2026-08-25T12:00:00.000Z :alice!alice@host JOIN #seance");
	transport.line(":irc.test 353 alice = #seance :@alice bob");
	transport.line(":irc.test 366 alice #seance :End of /NAMES list.");
	registerBusHandlers(socket, {
		clientForChannel: (chanId) => (client.channelById(chanId) ? client : undefined),
		clientForNetwork: (uuid) => (uuid === client.uuid ? client : undefined),
		allClients: () => [client],
		createNetwork: () => client,
		remove: () => undefined,
	});
	dispatch.resetHistory();
	transport.sent.length = 0;

	return {client, transport};
}

function labelOf(line: string): string {
	return (line.match(/^@label=([^ ;]+)/) as RegExpMatchArray)[1];
}

function batch(transport: FakeTransport, type: string, label: string, lines: string[]): void {
	transport.line(`@label=${label} :irc.test BATCH +b1 ${type}`);
	lines.forEach((line) => transport.line(line.replace(/^@/, "@batch=b1;")));
	transport.line(":irc.test BATCH -b1");
}

const ROW1 =
	"@time=2026-10-20T10:00:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :the fake lag clock";
const ROW2 =
	"@time=2026-10-20T11:00:00.000Z;msgid=m2 :bob!bob@host PRIVMSG #seance :\x01ACTION has fake lag\x01";

describe("historysearch", function () {
	beforeEach(function () {
		const current = (socket as unknown as Record<string, unknown>).dispatch;

		if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
			dispatch = current as sinon.SinonSpy;
			ownsSpy = false;
		} else {
			dispatch = sinon.spy(socket, "dispatch");
			ownsSpy = true;
		}

		clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
	});

	afterEach(function () {
		clock.restore();

		if (ownsSpy) {
			dispatch.restore();
		}

		socket.removeAllListeners();
	});

	it("asks for the cap, only when it is offered", function () {
		const offered = new FakeTransport();
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
			transportFactory: () => offered,
			highlights: () => ({keywords: [], exceptions: []}),
			fakeLag: NO_FAKE_LAG,
		});

		client.connect();
		offered.open();
		offered.line(":irc.test CAP * LS :batch soju.im/search");
		expect(offered.sent.find((l) => l.startsWith("CAP REQ :"))).to.contain("soju.im/search");
	});

	describe("the wire", function () {
		const attrs = {in: "#seance", text: "fake lag", from: "bob", limit: 100};

		it("uses the spec's one parameter, escaped, on any other server", function () {
			const {client, transport} = setup();

			requestSearch(client, 1, attrs);
			expect(transport.sent[0]).to.match(
				/^@label=q\d+ SEARCH in=#seance;text=fake\\slag;from=bob;limit=100$/
			);
			expect(specSearchParams({text: "a;b\\c"})).to.deep.equal(["text=a\\:b\\\\c"]);
		});

		it("uses separate selectors with text last on nefarious2", function () {
			const {client, transport} = setup({nefarious: true});

			requestSearch(client, 1, attrs);
			expect(transport.sent[0]).to.match(
				/^@label=q\d+ SEARCH in=#seance from=bob limit=100 :text=fake lag$/
			);
			expect(nefarious.searchParams?.({from: "bob"})).to.deep.equal(["from=bob"]);
		});

		it("refuses what would not fit, without sending it", function () {
			const {client, transport} = setup();

			requestSearch(client, 1, {text: "x".repeat(600)});
			expect(transport.sent).to.deep.equal([]);
			expect(payloads<ResultsPayload>("search:results")[0].status).to.equal("invalid");
		});

		it("answers invalid for a line break, on either spelling, and sends nothing", function () {
			for (const onNefarious of [false, true]) {
				const {client, transport} = setup({nefarious: onNefarious});

				requestSearch(client, 1, {text: "x\r\nQUIT :bye"});

				if (onNefarious) {
					expect(transport.sent).to.deep.equal([]);
					expect(payloads<ResultsPayload>("search:results").pop()?.status).to.equal(
						"invalid"
					);
				} else {
					// The spec's form escapes it, so it is simply text there.
					expect(transport.sent[0]).to.contain("x\\r\\nQUIT\\s:bye");
				}
			}
		});

		it("answers unsupported when the server has no search", function () {
			const {client, transport} = setup({caps: "batch message-tags server-time"});

			requestSearch(client, 7, {text: "x"});
			expect(transport.sent).to.deep.equal([]);
			expect(payloads<ResultsPayload>("search:results")[0]).to.include({
				requestId: 7,
				status: "unsupported",
			});
		});
	});

	describe("the answer", function () {
		it("turns rows into hits through the normal handlers", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			batch(transport, "search", labelOf(transport.sent[0]), [ROW1, ROW2]);

			const [answer] = payloads<ResultsPayload>("search:results");

			expect(answer.requestId).to.equal(3);
			expect(answer.status).to.equal("ok");
			expect(answer.hits.map((hit) => hit.target)).to.deep.equal(["#seance", "#seance"]);
			expect(answer.hits[0].msg.text).to.equal("the fake lag clock");
			expect(answer.hits[0].msg.msgid).to.equal("m1");
			expect(answer.hits[1].msg.type).to.equal(MessageType.ACTION);
			expect(answer.hits[0].msg.id).to.be.below(0);
			expect(answer.hits[0].msg.id).to.not.equal(answer.hits[1].msg.id);
			expect(pendingSearches(client)).to.have.length(0);
		});

		it("answers once when nefarious2's ACK follows the batch", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			const label = labelOf(transport.sent[0]);

			batch(transport, "search", label, [ROW1]);
			transport.line(`@label=${label} :irc.test ACK`);
			expect(payloads<ResultsPayload>("search:results")).to.have.length(1);
		});

		it("accepts the spec's other batch name", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			batch(transport, "soju.im/search", labelOf(transport.sent[0]), [ROW1]);
			expect(payloads<ResultsPayload>("search:results")[0].hits).to.have.length(1);
		});

		it("leaves the channels alone", function () {
			const {client, transport} = setup();
			const chan = client.findChannel("#seance")!;
			const newest = chan.newestRef;
			const unread = chan.shared.unread;
			const pages = pendingHistory(client).length; // the JOIN's own fill

			requestSearch(client, 3, {text: "fake"});
			batch(transport, "search", labelOf(transport.sent[0]), [ROW1, ROW2]);

			expect(payloads("msg")).to.have.length(0);
			expect(payloads("more")).to.have.length(0);
			expect(chan.newestRef).to.equal(newest);
			expect(chan.shared.unread).to.equal(unread);
			expect(pendingHistory(client)).to.have.length(pages);
		});

		it("still hits a message the channel already shows", function () {
			const {client, transport} = setup();

			transport.line(ROW1);
			requestSearch(client, 3, {text: "fake"});
			batch(transport, "search", labelOf(transport.sent[0]), [ROW1]);

			expect(payloads<ResultsPayload>("search:results")[0].hits).to.have.length(1);
		});

		it("names the other side of a private hit and opens no window", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {in: "dave", text: "psst"});
			batch(transport, "search", labelOf(transport.sent[0]), [
				"@time=2026-10-20T10:00:00.000Z;msgid=p1 :dave!d@h PRIVMSG alice :psst there",
				"@time=2026-10-20T10:01:00.000Z;msgid=p2 :alice!a@h PRIVMSG dave :psst back",
			]);

			const {hits} = payloads<ResultsPayload>("search:results")[0];

			expect(hits.map((hit) => hit.target)).to.deep.equal(["dave", "dave"]);
			expect(client.findChannel("dave")).to.equal(undefined);
		});

		it("keeps our live host when a stored row of ours shows an old one", function () {
			const {client, transport} = setup();
			client.ident = "live";
			client.host = "a.long.live.cloak.example";

			requestSearch(client, 3, {text: "fake"});
			batch(transport, "search", labelOf(transport.sent[0]), [
				"@time=2026-10-20T10:00:00.000Z;msgid=o1 :alice!old@short PRIVMSG #seance :fake",
			]);

			expect(payloads<ResultsPayload>("search:results")[0].hits).to.have.length(1);
			expect(client.ident).to.equal("live");
			expect(client.host).to.equal("a.long.live.cloak.example");
		});

		it("answers the labeled search when its FAIL comes wrapped in a batch", function () {
			const {client, transport} = setup();

			requestSearch(client, 1, {text: "first"});
			requestSearch(client, 2, {text: "second"});
			batch(transport, "labeled-response", labelOf(transport.sent[1]), [
				"@time=2026-10-20T10:00:00.000Z :irc.test FAIL SEARCH INTERNAL_ERROR :nope",
			]);

			const answers = payloads<ResultsPayload>("search:results");
			expect(answers.map((a) => [a.requestId, a.status])).to.deep.equal([[2, "fail"]]);
		});

		it("takes an empty batch as no matches", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "none"});
			batch(transport, "search", labelOf(transport.sent[0]), []);
			expect(payloads<ResultsPayload>("search:results")[0]).to.deep.include({
				status: "ok",
				hits: [],
			});
		});

		it("answers a labeled ACK as no matches", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "none"});
			transport.line(`@label=${labelOf(transport.sent[0])} :irc.test ACK`);
			expect(payloads<ResultsPayload>("search:results")[0].status).to.equal("ok");
		});

		it("matches the oldest request when there are no labels", function () {
			const {client, transport} = setup({
				caps: "batch message-tags server-time standard-replies soju.im/search",
			});

			requestSearch(client, 1, {text: "fake"});
			requestSearch(client, 2, {text: "fake"});
			expect(transport.sent[0].startsWith("SEARCH")).to.equal(true);
			transport.line(":irc.test BATCH +b1 search");
			transport.line(":irc.test BATCH -b1");
			expect(payloads<ResultsPayload>("search:results")[0].requestId).to.equal(1);
		});

		it("reports FAIL SEARCH to the window, not the lobby", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "x"});
			transport.line(
				`@label=${labelOf(
					transport.sent[0]
				)} :irc.test FAIL SEARCH INTERNAL_ERROR * :History storage unavailable`
			);

			expect(payloads<ResultsPayload>("search:results")[0]).to.include({
				status: "fail",
				error: "History storage unavailable",
			});
			expect(payloads("msg")).to.have.length(0);
		});

		it("times out, and a late answer never shows as live messages", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			const label = labelOf(transport.sent[0]);

			clock.tick(SEARCH_TIMEOUT_MS);
			expect(payloads<ResultsPayload>("search:results")[0].status).to.equal("timeout");

			batch(transport, "search", label, [ROW1]);
			expect(payloads<ResultsPayload>("search:results")).to.have.length(1);
			expect(payloads("msg")).to.have.length(0);
		});

		it("does not give a timed-out search's late answer to the next one, unlabeled", function () {
			const {client, transport} = setup({
				caps: "batch message-tags server-time standard-replies soju.im/search",
			});
			const close = (rows: string[]) => {
				transport.line(":irc.test BATCH +b1 search");
				rows.forEach((row) => transport.line(row.replace(/^@/, "@batch=b1;")));
				transport.line(":irc.test BATCH -b1");
			};

			requestSearch(client, 1, {text: "fake"});
			clock.tick(SEARCH_TIMEOUT_MS);
			requestSearch(client, 2, {text: "other"});

			close([ROW1]); // the first one's, late
			expect(
				payloads<ResultsPayload>("search:results").filter((p) => p.requestId === 2)
			).to.have.length(0);

			close([ROW2]);
			const [answer] = payloads<ResultsPayload>("search:results").filter(
				(p) => p.requestId === 2
			);
			expect(answer.hits[0].msg.msgid).to.equal("m2");
		});

		it("gives up an unlabeled place in line that is never answered", function () {
			const {client} = setup({
				caps: "batch message-tags server-time standard-replies soju.im/search",
			});

			requestSearch(client, 1, {text: "fake"});
			clock.tick(SEARCH_TIMEOUT_MS);
			expect(pendingSearches(client)).to.have.length(1);
			clock.tick(SEARCH_TOMBSTONE_MS);
			expect(pendingSearches(client)).to.have.length(0);
		});

		it("does not let an edit row touch the inbox", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			batch(transport, "search", labelOf(transport.sent[0]), [
				"@time=2026-10-20T10:00:00.000Z;msgid=e1;+seance/edit=m0 :bob!bob@host PRIVMSG #seance :fake lag, edited",
			]);

			expect(payloads("inbox:drop")).to.have.length(0);
			expect(payloads<ResultsPayload>("search:results")[0].hits).to.have.length(1);
		});

		it("answers what is in flight when the connection closes", function () {
			const {client, transport} = setup();

			requestSearch(client, 3, {text: "fake"});
			transport.closed();

			expect(payloads<ResultsPayload>("search:results")[0].status).to.equal("offline");
			expect(pendingSearches(client)).to.have.length(0);
		});
	});

	describe("context", function () {
		it("asks AROUND by msgid and keeps the answer out of the channel", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			expect(transport.sent[0]).to.match(
				/^@label=q\d+ CHATHISTORY AROUND #seance msgid=m1 21$/
			);

			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [ROW1, ROW2]);

			const [answer] = payloads<ContextPayload>("search:context");

			expect(answer.status).to.equal("ok");
			expect(answer.messages.map((msg) => msg.msgid)).to.deep.equal(["m1", "m2"]);
			expect(payloads("more")).to.have.length(0);
			expect(payloads("msg")).to.have.length(0);
		});

		it("asks by when it was said a server that takes only timestamps (soju)", function () {
			const {client, transport} = setup();
			transport.line(
				":irc.test 005 alice MSGREFTYPES=timestamp :are supported by this server"
			);
			requestSearch(client, 1, {in: "#seance", text: "fake"});
			batch(transport, "soju.im/search", labelOf(transport.sent[0]), [ROW1, ROW2]);
			transport.sent.length = 0;

			requestSearchContext(client, 4, "#seance", "AROUND", "m2", 21);

			expect(transport.sent[0]).to.match(
				/ CHATHISTORY AROUND #seance timestamp=2026-10-20T11:00:00\.000Z 21$/
			);
		});

		it("still knows when a hit was said after the connection closed and came back", function () {
			const {client, transport} = setup();
			transport.line(
				":irc.test 005 alice MSGREFTYPES=timestamp :are supported by this server"
			);
			requestSearch(client, 1, {in: "#seance", text: "fake"});
			batch(transport, "soju.im/search", labelOf(transport.sent[0]), [ROW1, ROW2]);
			// What a disconnect does; the search window keeps its hits.
			resetSearches(client);
			transport.sent.length = 0;

			requestSearchContext(client, 4, "#seance", "AROUND", "m2", 21);

			expect(transport.sent[0]).to.match(
				/ CHATHISTORY AROUND #seance timestamp=2026-10-20T11:00:00\.000Z 21$/
			);
		});

		it("does not ask by msgid a server whose MSGREFTYPES leaves it out", function () {
			const {client, transport} = setup();
			transport.line(
				":irc.test 005 alice MSGREFTYPES=timestamp :are supported by this server"
			);

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);

			expect(transport.sent).to.deep.equal([]);
			expect(payloads<ContextPayload>("search:context")[0].status).to.equal("unsupported");
		});

		it("never asks past what the server allows in one command", function () {
			const {client, transport} = setup();

			transport.line(":irc.test 005 alice CHATHISTORY=50 :are supported by this server");
			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 100);

			expect(transport.sent[0]).to.match(/ CHATHISTORY AROUND #seance msgid=m1 50$/);
		});

		it("says when the server marks the page as the end", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "BEFORE", "m1", 100);
			transport.line(
				`@draft/chathistory-end;label=${labelOf(
					transport.sent[0]
				)} :irc.test BATCH +h chathistory #seance`
			);
			transport.line(":irc.test BATCH -h");

			expect(payloads<ContextPayload>("search:context")[0]).to.include({
				status: "ok",
				end: true,
			});
		});

		it("applies a page's own reactions and deletions to its rows, and nowhere else", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [
				ROW1,
				ROW2,
				"@msgid=r1;+draft/react=👍;+draft/reply=m1 :bob!b@h TAGMSG #seance",
				"@msgid=r2 :bob!b@h REDACT #seance m2",
			]);

			const [answer] = payloads<ContextPayload>("search:context");
			const [first, second] = answer.messages;

			expect(answer.end).to.equal(false);
			expect(first.reactions).to.have.length(1);
			expect(second.redacted).to.not.equal(undefined);
			expect(payloads("msg:react")).to.have.length(0);
			expect(payloads("msg:redact")).to.have.length(0);
		});

		it("passes on what a page says of a line outside it", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AFTER", "m0", 100);
			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [
				ROW1,
				"@msgid=r2 :bob!b@h REDACT #seance m0",
			]);

			const [answer] = payloads<ContextPayload>("search:context");

			expect(answer.changes?.map((change) => change.msgid)).to.deep.equal(["m0"]);
			expect(answer.changes?.[0].redact?.by).to.equal("bob");
		});

		it("says where a page of reactions alone ends, for the next page to start from", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 5, "#seance", "BEFORE", "m9", 100);
			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [
				"@msgid=r1;+draft/react=👍;+draft/reply=m0 :bob!b@h TAGMSG #seance",
				"@msgid=r2;+draft/react=🎉;+draft/reply=m0 :bob!b@h TAGMSG #seance",
			]);

			const [answer] = payloads<ContextPayload>("search:context");

			expect(answer.messages).to.have.length(0);
			expect(answer.edges).to.deep.equal({first: "r1", last: "r2"});
		});

		it("keeps a wrapped FAIL for its context request from a channel's page", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 7, "#seance", "AROUND", "m1", 10);
			batch(transport, "labeled-response", labelOf(transport.sent[0]), [
				"@time=2026-10-20T10:00:00.000Z :irc.test FAIL CHATHISTORY MESSAGE_ERROR AROUND #seance :nope",
			]);

			expect(payloads<ContextPayload>("search:context")[0]).to.include({
				requestId: 7,
				status: "fail",
			});
			expect(pendingSearches(client)).to.have.length(0);
		});

		it("leaves a channel's own page to the channel", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			transport.line("@label=other :irc.test BATCH +b2 chathistory #seance");
			transport.line(":irc.test BATCH -b2");

			expect(payloads("search:context")).to.have.length(0);
			expect(pendingSearches(client)).to.have.length(1);
		});

		it("takes a labeled FAIL CHATHISTORY as its own", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "gone", 21);
			transport.line(
				`@label=${labelOf(
					transport.sent[0]
				)} :irc.test FAIL CHATHISTORY MESSAGE_ERROR AROUND :Unknown message`
			);

			expect(payloads<ContextPayload>("search:context")[0].status).to.equal("fail");
			expect(payloads("msg")).to.have.length(0);
		});

		it("keeps a timed-out request's late answer out of the channel", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			const label = labelOf(transport.sent[0]);

			clock.tick(SEARCH_TIMEOUT_MS);
			expect(payloads<ContextPayload>("search:context")[0].status).to.equal("timeout");
			dispatch.resetHistory();

			batch(transport, "chathistory #seance", label, [ROW1, ROW2]);

			expect(payloads("search:context")).to.have.length(0);
			expect(payloads("more")).to.have.length(0);
			expect(payloads("msg")).to.have.length(0);
			expect(pendingSearches(client)).to.have.length(0);
		});

		it("keeps a timed-out request's late FAIL out of the lobby", function () {
			const {client, transport} = setup();

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			const label = labelOf(transport.sent[0]);

			clock.tick(SEARCH_TIMEOUT_MS);
			dispatch.resetHistory();
			transport.line(`@label=${label} :irc.test FAIL CHATHISTORY MESSAGE_ERROR AROUND :Gone`);

			expect(payloads("search:context")).to.have.length(0);
			expect(payloads("msg")).to.have.length(0);
		});

		it("needs labels, since nothing else tells its batch from a channel's", function () {
			const {client, transport} = setup({
				caps: "batch message-tags server-time draft/chathistory=100",
			});

			requestSearchContext(client, 4, "#seance", "AROUND", "m1", 21);
			expect(transport.sent).to.deep.equal([]);
			expect(payloads<ContextPayload>("search:context")[0].status).to.equal("unsupported");
		});
	});

	describe("reply parents", function () {
		const AROUND = /^@label=q\d+ CHATHISTORY AROUND #seance msgid=m1 1$/;

		function ask(client: IrcClient): void {
			socket.emit("reply:parent", {chan: client.findChannel("#seance")!.id, msgid: "m1"});
		}

		it("asks for one row and gives it to the quote, not the channel", function () {
			const {client, transport} = setup();
			const cursor = client.cursor;

			ask(client);
			expect(transport.sent[0]).to.match(AROUND);
			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [ROW1]);

			expect(payloads("reply:parent")).to.deep.equal([
				{
					chan: client.findChannel("#seance")!.id,
					msgid: "m1",
					nick: "bob",
					text: "the fake lag clock",
				},
			]);
			expect(payloads("more")).to.have.length(0);
			expect(payloads("msg")).to.have.length(0);
			expect(client.cursor).to.equal(cursor);
			expect(client.findChannel("#seance")!.idOf("m1")).to.equal(undefined);
		});

		it("goes ahead of the queued background work", function () {
			const {client} = setup({fakeLag: IRCU_FAKE_LAG});

			for (let i = 0; i < 10; i++) {
				client.send("PING :busy");
			}

			client.background.add({key: "catchup", cost: 2000, run: () => undefined});
			ask(client);
			expect(client.background.keys()[0]).to.match(/^parent:/);
		});

		it("takes only the row it asked for", function () {
			const {client, transport} = setup();

			ask(client);
			batch(transport, "chathistory #seance", labelOf(transport.sent[0]), [ROW2]);
			expect(payloads("reply:parent")).to.have.length(0);
		});

		it("takes the server's no for this connection", function () {
			const {client, transport} = setup();

			ask(client);
			transport.line(
				`@label=${labelOf(
					transport.sent[0]
				)} :irc.test FAIL CHATHISTORY MESSAGE_ERROR AROUND #seance :Unknown message`
			);
			expect(payloads("search:context")).to.have.length(0);

			transport.sent.length = 0;
			ask(client);
			expect(transport.sent).to.deep.equal([]);
		});

		it("asks once however many quotes want it", function () {
			const {client, transport} = setup();

			ask(client);
			ask(client);
			expect(transport.sent.filter((line) => AROUND.test(line))).to.have.length(1);
		});

		it("needs labels, as context does", function () {
			const {client, transport} = setup({
				caps: "batch message-tags server-time draft/chathistory=100",
			});

			ask(client);
			expect(transport.sent).to.deep.equal([]);
		});

		it("leaves the answer of a lost connection for the next one to ask", function () {
			const {client, transport} = setup();

			ask(client);
			transport.closed();
			expect(payloads("reply:parent")).to.have.length(0);
			expect(pendingSearches(client)).to.have.length(0);

			ask(client);
			expect(client.background.keys()).to.have.length(1);
		});
	});

	it("reaches the IRC layer through the bus", function () {
		const {client, transport} = setup();

		socket.emit("search:request", {network: client.uuid, requestId: 9, attrs: {text: "fake"}});
		expect(transport.sent[0]).to.contain("SEARCH");
		socket.emit("search:request", {network: "nope", requestId: 10, attrs: {text: "fake"}});
		expect(payloads<ResultsPayload>("search:results")[0]).to.include({
			requestId: 10,
			status: "offline",
		});
	});
	describe("a server that wants in= (soju)", function () {
		const ROW3 =
			"@time=2026-10-20T10:30:00.000Z;msgid=m3 :bob!bob@host PRIVMSG #linux :fake lag again";

		function refuse(transport: FakeTransport, line: string): void {
			transport.line(
				`@label=${labelOf(
					line
				)} :irc.test FAIL SEARCH INVALID_PARAMS in :Missing "in" attribute`
			);
		}

		it("asks each joined channel in turn, and answers once with the newest, oldest first", function () {
			const {client, transport} = setup();
			transport.line("@time=2026-08-25T12:00:00.000Z :alice!alice@host JOIN #linux");
			transport.sent.length = 0;

			requestSearch(client, 7, {text: "fake", limit: 2});
			expect(transport.sent).to.have.length(1);
			expect(transport.sent[0]).to.not.contain("in=");
			refuse(transport, transport.sent[0]);

			// One channel at a time: soju 0.7 has no labeled-response to
			// tell concurrent answers apart.
			expect(transport.sent).to.have.length(2);
			expect(transport.sent[1]).to.contain("in=#linux;");
			batch(transport, "soju.im/search", labelOf(transport.sent[1]), [ROW3]);
			expect(payloads("search:results")).to.have.length(0);

			expect(transport.sent).to.have.length(3);
			expect(transport.sent[2]).to.contain("in=#seance;");
			batch(transport, "soju.im/search", labelOf(transport.sent[2]), [ROW1, ROW2]);

			const answers = payloads<ResultsPayload>("search:results");
			expect(answers).to.have.length(1);
			expect(answers[0]).to.include({requestId: 7, status: "ok"});
			expect(answers[0].hits.map((hit) => hit.msg.msgid)).to.deep.equal(["m3", "m2"]);
			expect(answers[0].hits.map((hit) => hit.target)).to.deep.equal(["#linux", "#seance"]);
		});

		it("fails the whole search when one channel's part fails", function () {
			const {client, transport} = setup();
			transport.line("@time=2026-08-25T12:00:00.000Z :alice!alice@host JOIN #linux");
			transport.sent.length = 0;

			requestSearch(client, 8, {text: "fake"});
			refuse(transport, transport.sent[0]);
			batch(transport, "soju.im/search", labelOf(transport.sent[1]), [ROW3]);
			transport.line(
				`@label=${labelOf(
					transport.sent[2]
				)} :irc.test FAIL SEARCH INTERNAL_ERROR :Database is down`
			);

			const answers = payloads<ResultsPayload>("search:results");
			expect(answers).to.have.length(1);
			expect(answers[0]).to.include({
				requestId: 8,
				status: "fail",
				error: "Database is down",
			});
		});

		it("remembers it: the next search over every channel goes per channel at once", function () {
			const {client, transport} = setup();
			requestSearch(client, 1, {text: "fake"});
			refuse(transport, transport.sent[0]);
			batch(transport, "soju.im/search", labelOf(transport.sent[1]), []);
			transport.sent.length = 0;

			requestSearch(client, 2, {text: "lag"});

			expect(transport.sent).to.have.length(1);
			expect(transport.sent[0]).to.contain("in=#seance");
		});

		it("stops asking the channels of a search a newer one replaced", function () {
			const {client, transport} = setup();
			transport.line("@time=2026-08-25T12:00:00.000Z :alice!alice@host JOIN #linux");
			transport.line("@time=2026-08-25T12:00:00.000Z :alice!alice@host JOIN #debian");
			requestSearch(client, 1, {text: "fake"});
			refuse(transport, transport.sent[transport.sent.length - 1]);
			const firstPart = transport.sent[transport.sent.length - 1];
			expect(firstPart).to.contain("text=fake");
			transport.sent.length = 0;

			// The user types a new search while #linux's part is out.
			requestSearch(client, 2, {text: "lag"});
			expect(transport.sent).to.have.length(1);
			expect(transport.sent[0]).to.contain("text=lag");
			const [superseded] = payloads<ResultsPayload>("search:results");
			expect(superseded).to.include({requestId: 1, status: "fail"});

			// The old part's answer comes in: dropped, and nothing more of it is asked.
			batch(transport, "soju.im/search", labelOf(firstPart), [ROW3]);
			expect(transport.sent.filter((line) => line.includes("text=fake"))).to.deep.equal([]);
			expect(payloads<ResultsPayload>("search:results")).to.have.length(1);

			// The new search carries on through its channels.
			batch(transport, "soju.im/search", labelOf(transport.sent[0]), []);
			expect(transport.sent[1]).to.contain("text=lag");
		});

		it("reports a failure only when no channel found anything", function () {
			const {client, transport} = setup();
			requestSearch(client, 3, {text: "fake"});
			refuse(transport, transport.sent[0]);
			transport.line(
				`@label=${labelOf(
					transport.sent[1]
				)} :irc.test FAIL SEARCH INTERNAL_ERROR :Database is down`
			);

			const [answer] = payloads<ResultsPayload>("search:results");
			expect(answer).to.include({requestId: 3, status: "fail", error: "Database is down"});
		});
	});
});
