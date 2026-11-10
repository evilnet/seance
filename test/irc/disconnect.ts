import {expect} from "chai";

import {describeClose} from "../../client/js/irc/disconnect";

describe("describeClose", function () {
	const base = {
		url: "ws://localhost:8067/",
		host: "localhost",
		code: 1006,
		reason: "",
		willReconnect: true,
	} as const;

	it("explains a failed connection attempt instead of 'disconnected'", function () {
		const report = describeClose({...base, phase: "connecting"});

		expect(report.text).to.equal("Could not connect to ws://localhost:8067/.");
		expect(report.hint).to.contain("does not accept WebSocket connections");
	});

	it("points at mixed content for ws:// from an https page", function () {
		const report = describeClose({...base, phase: "connecting", pageProtocol: "https:"});

		expect(report.hint).to.contain("blocks plain ws://");
	});

	it("suggests accepting the certificate for wss:// failures", function () {
		const report = describeClose({
			...base,
			url: "wss://irc.example.org:8443/",
			host: "irc.example.org",
			phase: "connecting",
		});

		expect(report.hint).to.contain("open https://irc.example.org:8443/ in a new tab");
	});

	it("gives IRC over TCP its own hints, with no browser advice", function () {
		const tls = describeClose({
			...base,
			url: "ircs://irc.example.org:6697",
			host: "irc.example.org",
			phase: "connecting",
			pageProtocol: "https:",
			errorMessage: "invalid peer certificate: UnknownIssuer",
		});

		expect(tls.text).to.contain("(invalid peer certificate: UnknownIssuer)");
		expect(tls.hint).to.contain("self-signed");
		expect(tls.hint).to.not.contain("new tab");

		const plain = describeClose({
			...base,
			url: "irc://irc.example.org:6667",
			phase: "connecting",
			pageProtocol: "https:",
		});

		expect(plain.hint).to.contain("blocks the connection");
		expect(plain.hint).to.not.contain("ws://");
	});

	it("includes an informative transport error but not the browser stock one", function () {
		const informative = describeClose({
			...base,
			phase: "connecting",
			errorMessage: "connect ECONNREFUSED 127.0.0.1:8067",
		});
		const stock = describeClose({
			...base,
			phase: "connecting",
			errorMessage: "WebSocket error",
		});

		expect(informative.text).to.contain("(connect ECONNREFUSED 127.0.0.1:8067)");
		expect(stock.text).to.not.contain("WebSocket error");
	});

	it("reports a drop during registration separately", function () {
		const report = describeClose({...base, phase: "registering", willReconnect: false});

		expect(report.text).to.equal(
			"Connection to localhost closed during IRC registration (connection lost). Not reconnecting."
		);
		expect(report.hint).to.contain("before registration");
	});

	it("does not blame the WebSocket for a raw TCP drop during registration", function () {
		const report = describeClose({
			...base,
			url: "ircs://irc.example.org:6697",
			phase: "registering",
			code: 1000,
			reason: "the server closed the connection",
		});

		expect(report.hint).to.not.contain("WebSocket");
		expect(report.hint).to.contain("before registration");
	});

	it("offers the takeover hint when the server names a live session", function () {
		const report = describeClose({
			...base,
			phase: "registering",
			code: 1000,
			reason: "Account already has an active session on this network",
		});

		expect(report.text).to.contain("(Account already has an active session on this network)");
		expect(report.hint).to.contain("another tab");
		expect(report.hint).to.contain("next retry");
	});

	it("keeps the generic hint for other registration closes", function () {
		const report = describeClose({
			...base,
			phase: "registering",
			code: 1000,
			reason: "some policy",
		});

		expect(report.hint).to.not.contain("another tab");
		expect(report.hint).to.contain("before registration");
	});

	it("names known close codes on a real disconnect", function () {
		const report = describeClose({...base, phase: "registered"});

		expect(report.text).to.equal("Disconnected from localhost (connection lost).");
		expect(report.hint).to.equal(undefined);
	});

	it("prefers the server's reason and stays quiet on a clean close", function () {
		const reasoned = describeClose({
			...base,
			phase: "registered",
			code: 1011,
			reason: "K-lined",
			willReconnect: false,
		});
		const clean = describeClose({...base, phase: "registered", code: 1000});

		expect(reasoned.text).to.equal("Disconnected from localhost (K-lined). Not reconnecting.");
		expect(clean.text).to.equal("Disconnected from localhost.");
	});

	it("falls back to the numeric code for unknown codes", function () {
		const report = describeClose({...base, phase: "registered", code: 4000});

		expect(report.text).to.equal("Disconnected from localhost (code 4000).");
	});
});
