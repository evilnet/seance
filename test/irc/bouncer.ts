/**
 * soju.im/bouncer-networks (client/js/irc/bouncer.ts): the bouncer
 * connection's list, a bound connection's BIND, and the panel's requests.
 * Wire shapes are soju's own, as tools/soju-dev answered them.
 */

import {expect} from "chai";
import sinon from "sinon";
import {
	BOUNCER_CAP,
	BOUNCER_NOTIFY_CAP,
	bouncerRequest,
	formatAttrs,
	parseAttrs,
} from "../../client/js/irc/bouncer";
import type {IrcClientOptions} from "../../client/js/irc/client";
import {setup, type Harness} from "./support";

const SOJU_CAPS = `batch labeled-response message-tags server-time sasl=PLAIN ${BOUNCER_CAP} ${BOUNCER_NOTIFY_CAP}`;

/** Connect with SASL, answer the CAP REQ with an ACK of everything asked; returns what was asked. */
function negotiate(h: Harness, caps = SOJU_CAPS): string[] {
	h.client.connect();
	h.transport.open();
	h.transport.line(`:soju.test CAP * LS :${caps}`);
	const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
	const names = req.slice("CAP REQ :".length).split(" ");
	h.transport.line(`:soju.test CAP * ACK :${names.join(" ")}`);
	h.transport.line("AUTHENTICATE +");
	h.transport.line(":soju.test 903 alice :SASL authentication successful");
	return names;
}

function welcome(h: Harness, isupport = ""): void {
	h.transport.lines(
		":soju.test 001 alice :Welcome to soju, alice",
		`:soju.test 005 alice CASEMAPPING=ascii ${isupport} :are supported`,
		":soju.test 422 alice :No MOTD"
	);
}

function sojuSetup(overrides: Partial<IrcClientOptions> = {}): Harness {
	return setup({
		join: "",
		sasl: "plain",
		saslAccount: "alice",
		saslPassword: "s3cret",
		...overrides,
	});
}

describe("soju.im/bouncer-networks", function () {
	afterEach(function () {
		sinon.restore();
	});

	it("parses and formats attributes in message-tag form", function () {
		expect(parseAttrs("name=My\\sNet;state=connected;pass")).to.deep.equal({
			name: "My Net",
			state: "connected",
			pass: "",
		});
		expect(formatAttrs({name: "My Net;x", tls: "0"})).to.equal("name=My\\sNet\\:x;tls=0");
	});

	describe("the bouncer connection", function () {
		it("asks for both caps, never binds, and keeps the list it is sent", function () {
			const onBouncerNetwork = sinon.spy();
			const onBouncerList = sinon.spy();
			const h = sojuSetup({onBouncerNetwork, onBouncerList});
			const asked = negotiate(h);

			expect(asked).to.include.members([BOUNCER_CAP, BOUNCER_NOTIFY_CAP]);
			expect(h.transport.sent.some((l) => l.startsWith("BOUNCER BIND"))).to.equal(false);

			welcome(h);
			expect(h.sent()).to.not.include("BOUNCER LISTNETWORKS"); // -notify sends it unasked

			h.transport.lines(
				":soju.test BATCH +1 soju.im/bouncer-networks",
				"@batch=1 :soju.test BOUNCER NETWORK 42 name=Libera;state=connected",
				"@batch=1 :soju.test BOUNCER NETWORK 43 name=My\\sNet;state=disconnected",
				":soju.test BATCH -1"
			);

			expect(onBouncerNetwork.args).to.deep.equal([
				["42", {name: "Libera", state: "connected"}],
				["43", {name: "My Net", state: "disconnected"}],
			]);
			expect(onBouncerList.args).to.deep.equal([[["42", "43"]]]);
			const last = h.payloads("bouncer:networks").pop();
			expect(last.networks).to.deep.equal([
				{netid: "42", attrs: {name: "Libera", state: "connected"}},
				{netid: "43", attrs: {name: "My Net", state: "disconnected"}},
			]);
		});

		it("merges a notification, drops a bare key and forgets a `*`", function () {
			const onBouncerNetwork = sinon.spy();
			const h = sojuSetup({onBouncerNetwork});
			negotiate(h);
			welcome(h);
			h.transport.lines(
				":soju.test BOUNCER NETWORK 42 name=Libera;state=connecting;error=boom",
				":soju.test BOUNCER NETWORK 42 state=connected;error"
			);
			expect(h.client.bouncerNetworks.get("42")).to.deep.equal({
				name: "Libera",
				state: "connected",
			});

			h.transport.line(":soju.test BOUNCER NETWORK 42 *");
			expect(h.client.bouncerNetworks.size).to.equal(0);
			expect(onBouncerNetwork.lastCall.args).to.deep.equal(["42", null]);
		});

		it("lists once at registration when soju does not do -notify", function () {
			const h = sojuSetup();
			negotiate(h, `batch labeled-response sasl=PLAIN ${BOUNCER_CAP}`);
			welcome(h);
			expect(h.sent()).to.include("BOUNCER LISTNETWORKS");
		});

		it("is not a bouncer connection when soju says it is bound already", function () {
			const h = sojuSetup();
			negotiate(h, `batch labeled-response sasl=PLAIN ${BOUNCER_CAP}`);
			welcome(h, "BOUNCER_NETID=42");
			expect(h.sent()).to.not.include("BOUNCER LISTNETWORKS");
		});

		it("adds a network and takes its notification out of the labeled batch", async function () {
			const h = sojuSetup();
			negotiate(h);
			welcome(h);
			h.sent();

			const reply = bouncerRequest(h.client, "ADDNETWORK", undefined, {
				name: "Dev",
				host: "127.0.0.1",
				port: "6667",
				tls: "0",
			});
			const [line] = h.sent();
			expect(line).to.match(
				/^@label=(\S+) BOUNCER ADDNETWORK name=Dev;host=127\.0\.0\.1;port=6667;tls=0$/
			);
			const label = line.match(/^@label=(\S+)/)![1];
			h.transport.lines(
				`@label=${label} BATCH +2 labeled-response`,
				"@batch=2 BOUNCER NETWORK 1 name=Dev;state=disconnected;host=127.0.0.1",
				"@batch=2 BOUNCER ADDNETWORK 1",
				"BATCH -2"
			);

			expect(await reply).to.deep.equal({ok: true, netid: "1"});
			expect(h.client.bouncerNetworks.get("1")).to.include({name: "Dev"});
		});

		it("reports soju's words for a FAIL", async function () {
			const h = sojuSetup();
			negotiate(h);
			welcome(h);
			h.sent();

			const reply = bouncerRequest(h.client, "CHANGENETWORK", "999", {realname: "x"});
			const [line] = h.sent();
			expect(line).to.match(/ BOUNCER CHANGENETWORK 999 realname=x$/);
			const label = line.match(/^@label=(\S+)/)![1];
			h.transport.line(
				`@label=${label} :soju.test FAIL BOUNCER INVALID_NETID CHANGENETWORK 999 :Invalid network ID`
			);

			expect(await reply).to.deep.equal({ok: false, error: "Invalid network ID"});
		});
	});

	describe("a bound connection", function () {
		it("asks for the base cap only and binds before CAP END", function () {
			const h = sojuSetup({bouncerNetid: "42"});
			const asked = negotiate(h);

			expect(asked).to.include(BOUNCER_CAP);
			expect(asked).to.not.include(BOUNCER_NOTIFY_CAP);
			const bind = h.transport.sent.indexOf("BOUNCER BIND 42");
			expect(bind).to.be.greaterThan(-1);
			expect(bind).to.be.lessThan(h.transport.sent.indexOf("CAP END"));
		});

		it("never lists, and ignores a NETWORK line", function () {
			const onBouncerNetwork = sinon.spy();
			const h = sojuSetup({bouncerNetid: "42", onBouncerNetwork});
			negotiate(h);
			welcome(h, "BOUNCER_NETID=42");
			expect(h.sent()).to.not.include("BOUNCER LISTNETWORKS");
			h.transport.line(":soju.test BOUNCER NETWORK 43 name=Other");
			expect(onBouncerNetwork.called).to.equal(false);
		});

		it("quits when soju will not bind it, rather than register unbound", function () {
			const h = sojuSetup({bouncerNetid: "42"});
			negotiate(h);
			h.transport.line(":soju.test FAIL BOUNCER INVALID_NETID BIND 42 :Unknown network ID");

			expect(h.transport.state).to.equal("closed");
			expect(h.messages(h.client.lobby.id).pop()?.text).to.contain("Unknown network ID");
		});
	});
});
