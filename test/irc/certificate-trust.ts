import {expect} from "chai";
import sinon from "sinon";
import {setup} from "./support";

const certificate = {sha256: "ab".repeat(32), problem: "expired" as const};

function refuse(h: ReturnType<typeof setup>, willReconnect = false) {
	h.client.connect();
	h.transport.event({type: "error", message: "not trusted", certificate});
	h.transport.state = "closed";
	h.transport.event({
		type: "close",
		code: 4001,
		reason: "not trusted",
		wasClean: false,
		willReconnect,
	});
}

describe("untrusted certificate", function () {
	it("asks once the dial is refused for it, and not again on the next close", function () {
		const asked = sinon.spy();
		const h = setup({onUntrustedCertificate: asked});
		refuse(h);
		expect(asked.calledOnceWith(certificate)).to.equal(true);

		h.client.connect();
		h.transport.state = "closed";
		h.transport.event({
			type: "close",
			code: 1006,
			reason: "",
			wasClean: false,
			willReconnect: false,
		});
		expect(asked.calledOnce).to.equal(true);
	});

	it("does not ask while the transport will retry by itself", function () {
		const asked = sinon.spy();
		const h = setup({onUntrustedCertificate: asked});
		refuse(h, true);
		expect(asked.called).to.equal(false);
	});

	it("trusting it once dials again", function () {
		const h = setup({});
		refuse(h);
		h.client.trustCertificateOnce(
			certificate.sha256,
			h.client.options.host,
			h.client.options.port
		);
		expect(h.transport.state).to.equal("connecting");
	});

	it("keeps the saved list through an edit that does not mention it", function () {
		const h = setup({trustedCertificates: [certificate.sha256]});
		h.client.applySettings({
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
		});
		expect(h.client.options.trustedCertificates).to.deep.equal([certificate.sha256]);
	});
});

describe("untrusted certificate: bound to the server", function () {
	it("offers a certificate trusted once only to the server it was trusted for", function () {
		const h = setup({});
		const c = h.client as unknown as {trustedOnce: Set<string>};
		h.client.trustCertificateOnce(certificate.sha256, "elsewhere.test", 6697);
		expect([...c.trustedOnce]).to.deep.equal([`elsewhere.test\n6697\n${certificate.sha256}`]);
	});
});

describe("untrusted certificate: what the shell is sent", function () {
	const fp = (n: number) => n.toString(16).padStart(64, "0");
	const sent = (h: ReturnType<typeof setup>) =>
		(h.client as unknown as {certificatesToTrust(): string[]}).certificatesToTrust();

	it("sends a certificate once, saved and trusted once alike", function () {
		const h = setup({trustedCertificates: [certificate.sha256]});
		h.client.trustCertificateOnce(
			certificate.sha256,
			h.client.options.host,
			h.client.options.port
		);
		expect(sent(h)).to.deep.equal([certificate.sha256]);
	});

	it("stays within the shell's eight, the one trusted just now kept", function () {
		const saved = [1, 2, 3, 4, 5, 6, 7, 8].map(fp);
		const h = setup({trustedCertificates: saved});
		h.client.trustCertificateOnce(fp(9), h.client.options.host, h.client.options.port);
		expect(sent(h)).to.deep.equal([...saved.slice(1), fp(9)]);
	});
});
