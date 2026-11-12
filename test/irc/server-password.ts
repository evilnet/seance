import {expect} from "chai";
import sinon from "sinon";
import {register, setup} from "./support";

describe("server password (PASS)", function () {
	it("goes out after CAP LS and before NICK and USER", function () {
		const h = setup({serverPassword: "bob/rig:pass word"});
		h.client.connect();
		h.transport.open();

		expect(h.transport.sent).to.deep.equal([
			"CAP LS 302",
			"PASS :bob/rig:pass word",
			"NICK alice",
			"USER alice 0 * :alice",
		]);
	});

	it("is not sent when empty", function () {
		const h = setup({serverPassword: ""});
		h.client.connect();
		h.transport.open();

		expect(h.transport.sent.some((l) => l.startsWith("PASS"))).to.equal(false);
	});

	it("464 during registration stops the connection and says why", function () {
		const rejected = sinon.spy();
		const h = setup({onServerPasswordRejected: rejected});
		h.client.connect();
		h.transport.open();
		h.sent();
		h.transport.line(":irc.znc.in 464 alice :Password required");

		expect(h.sent()).to.deep.equal(["QUIT :Server password required"]);
		expect(rejected.calledOnce).to.equal(true);
		expect(h.payloads("network:aborted")).to.have.length(1);
		const texts = h.messages().map((m) => m.text ?? "");
		expect(texts.some((t) => /needs a server password/.test(t))).to.equal(true);
		expect(h.transport.state).to.equal("closed");
	});

	it("464 to a password that was sent says it was refused", function () {
		const h = setup({serverPassword: "wrong"});
		h.client.connect();
		h.transport.open();
		h.transport.line(":irc.znc.in 464 alice :Invalid Password");

		const texts = h.messages().map((m) => m.text ?? "");
		expect(texts.some((t) => /refused the server password/.test(t))).to.equal(true);
		expect(h.transport.sent).to.include("QUIT :Server password refused");
	});

	it("464 after 001 is an ordinary error (OPER with the wrong password)", function () {
		const rejected = sinon.spy();
		const h = setup({onServerPasswordRejected: rejected});
		register(h);
		h.transport.line(":irc.test 464 alice :Password incorrect");

		expect(rejected.called).to.equal(false);
		expect(h.payloads("network:aborted")).to.have.length(0);
		expect(h.sent().some((l) => l.startsWith("QUIT"))).to.equal(false);
		expect(h.lastMessage().error).to.equal("password_mismatch");
	});

	it("an edit that leaves it undefined keeps the one in memory", function () {
		const h = setup({serverPassword: "kept"});
		h.client.applySettings({
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			serverPassword: undefined,
		});
		h.client.connect();
		h.transport.open();

		expect(h.transport.sent).to.include("PASS :kept");
	});
});
