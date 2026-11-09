import {expect} from "chai";
import parseIrcUri from "../../client/js/helpers/parseIrcUri";
import {
	decideLinkTarget,
	linkSuggestion,
	mergeJoinLists,
	sanitizeLinkParams,
	type LinkSuggestion,
} from "../../client/js/helpers/linkTarget";
import type {SavedNetwork} from "../../client/js/irc/saved-networks";

function net(overrides: Partial<SavedNetwork> = {}): SavedNetwork {
	return {
		uuid: "11111111-1111-4111-8111-111111111111",
		name: "",
		host: "irc.example.org",
		port: 443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		...overrides,
	};
}

describe("linkTarget helper", function () {
	describe("linkSuggestion", function () {
		it("reads a parsed web+irc:// link", function () {
			expect(linkSuggestion(parseIrcUri("web+irc://irc.example.org/#chan"))).to.deep.equal({
				host: "irc.example.org",
				port: 443,
				portGiven: false,
				tls: true,
				transport: "websocket",
				join: "#chan",
			});
			expect(
				linkSuggestion(parseIrcUri("web+irc://irc.example.org:8443/#chan"))
			).to.deep.equal({
				host: "irc.example.org",
				port: 8443,
				portGiven: true,
				tls: true,
				transport: "websocket",
				join: "#chan",
			});
		});

		it("defaults a missing port to 443 and TLS to on", function () {
			expect(linkSuggestion({host: "irc.example.org"})).to.deep.equal({
				host: "irc.example.org",
				port: 443,
				portGiven: false,
				tls: true,
				transport: "websocket",
				join: "",
			});
		});

		it("accepts channels as an alias for join", function () {
			expect(linkSuggestion({host: "h", channels: "#a,#b"})?.join).to.equal("#a,#b");
		});

		it("rejects params without a host", function () {
			expect(linkSuggestion({})).to.equal(undefined);
			expect(linkSuggestion({host: "   "})).to.equal(undefined);
			expect(linkSuggestion({nick: "alice", join: "#chan"})).to.equal(undefined);
		});

		it("ignores an unusable port", function () {
			expect(linkSuggestion({host: "h", port: "lol"})?.port).to.equal(443);
			expect(linkSuggestion({host: "h", port: "-1"})?.port).to.equal(443);
			expect(linkSuggestion({host: "h", port: "70000"})?.port).to.equal(443);
			expect(linkSuggestion({host: "h", port: "8443"})?.port).to.equal(8443);
		});

		it("reads an irc:// or ircs:// link as TCP in the app, with 6667 / 6697 defaults", function () {
			const app = {tcp: true};
			expect(
				linkSuggestion(parseIrcUri("irc://irc.example.org/#chan", app), app)
			).to.deep.equal({
				host: "irc.example.org",
				port: 6667,
				portGiven: false,
				tls: false,
				transport: "tcp",
				join: "#chan",
			});
			expect(
				linkSuggestion(parseIrcUri("ircs://irc.example.org/#chan", app), app)
			).to.deep.equal({
				host: "irc.example.org",
				port: 6697,
				portGiven: false,
				tls: true,
				transport: "tcp",
				join: "#chan",
			});
			expect(linkSuggestion(parseIrcUri("irc://irc.example.org:7000", app), app)).to.include({
				port: 7000,
				portGiven: true,
				tls: false,
				transport: "tcp",
			});
		});

		it("keeps a browser on WebSocket whatever the parameters say", function () {
			expect(linkSuggestion(parseIrcUri("irc://irc.example.org:6667/#chan"))).to.deep.equal({
				host: "irc.example.org",
				port: 443,
				portGiven: false,
				tls: true,
				transport: "websocket",
				join: "#chan",
			});
			expect(linkSuggestion({host: "h", transport: "tcp"})?.transport).to.equal("websocket");
		});

		it("never reads a password or autoconnect", function () {
			const suggestion = linkSuggestion({
				host: "h",
				saslAccount: "alice",
				saslPassword: "hunter2",
				autoconnect: "1",
			});

			expect(suggestion?.saslAccount).to.equal("alice");
			expect(suggestion).to.not.have.property("saslPassword");
			expect(suggestion).to.not.have.property("autoconnect");
		});
	});

	describe("decideLinkTarget", function () {
		const suggested = (overrides: Partial<LinkSuggestion> = {}): LinkSuggestion => ({
			host: "irc.example.org",
			port: 443,
			portGiven: true,
			tls: true,
			transport: "websocket",
			join: "#chan",
			...overrides,
		});

		it("matches a saved network on the host alone when the link names no port", function () {
			const decision = decideLinkTarget(suggested({portGiven: false}), {
				saved: [net({port: 6697})],
			});

			expect(decision.kind).to.equal("saved");
			expect(decision.kind === "saved" && decision.network.port).to.equal(6697);
		});

		it("never matches a cleartext network when the link names no port", function () {
			const plain = net({
				uuid: "22222222-2222-4222-8222-222222222222",
				port: 8067,
				tls: false,
			});
			const secure = net({port: 6697});

			expect(decideLinkTarget(suggested({portGiven: false}), {saved: [plain]}).kind).to.equal(
				"new"
			);

			const decision = decideLinkTarget(suggested({portGiven: false}), {
				saved: [plain, secure],
			});

			expect(decision.kind === "saved" && decision.network.uuid).to.equal(secure.uuid);
		});

		it("matches a saved network by casefolded host and port", function () {
			const decision = decideLinkTarget(suggested({host: "IRC.EXAMPLE.ORG"}), {
				saved: [net()],
			});

			expect(decision.kind).to.equal("saved");
			expect(decision.kind === "saved" && decision.network.uuid).to.equal(net().uuid);
		});

		it("does not match a different port", function () {
			expect(decideLinkTarget(suggested({port: 8443}), {saved: [net()]}).kind).to.equal(
				"new"
			);
		});

		it("does not match a different TLS mode", function () {
			expect(decideLinkTarget(suggested(), {saved: [net({tls: false})]}).kind).to.equal(
				"new"
			);
		});

		it("matches hosts that carry a scheme or path", function () {
			const decision = decideLinkTarget(suggested(), {
				saved: [net({host: "wss://irc.example.org/ws"})],
			});

			expect(decision.kind).to.equal("saved");
		});

		describe("over TCP", function () {
			const tcp = (overrides: Partial<LinkSuggestion> = {}) =>
				suggested({transport: "tcp", port: 6697, portGiven: false, ...overrides});
			const plainLink = (overrides: Partial<LinkSuggestion> = {}) =>
				tcp({tls: false, port: 6667, ...overrides});
			const wsNet = net({uuid: "33333333-3333-4333-8333-333333333333"});
			const tlsNet = net({
				uuid: "44444444-4444-4444-8444-444444444444",
				transport: "tcp",
				port: 6697,
			});
			const plainNet = net({
				uuid: "55555555-5555-4555-8555-555555555555",
				transport: "tcp",
				port: 6667,
				tls: false,
			});
			const uuidOf = (decision: ReturnType<typeof decideLinkTarget>) =>
				decision.kind === "saved" ? decision.network.uuid : decision.kind;

			it("prefers a network on the link's own transport", function () {
				expect(uuidOf(decideLinkTarget(tcp(), {saved: [wsNet, tlsNet]}))).to.equal(
					tlsNet.uuid
				);
				expect(uuidOf(decideLinkTarget(suggested(), {saved: [tlsNet, wsNet]}))).to.equal(
					wsNet.uuid
				);
			});

			it("upgrades a plain link to a saved TLS network, whatever its port", function () {
				expect(uuidOf(decideLinkTarget(plainLink(), {saved: [plainNet, tlsNet]}))).to.equal(
					tlsNet.uuid
				);
				expect(
					uuidOf(
						decideLinkTarget(plainLink({portGiven: true}), {saved: [plainNet, tlsNet]})
					)
				).to.equal(tlsNet.uuid);
				expect(uuidOf(decideLinkTarget(plainLink(), {saved: [plainNet]}))).to.equal(
					plainNet.uuid
				);
			});

			it("never downgrades an ircs:// link to a plain network", function () {
				expect(decideLinkTarget(tcp(), {saved: [plainNet]}).kind).to.equal("new");
				expect(
					decideLinkTarget(suggested(), {saved: [plainNet, net({tls: false})]}).kind
				).to.equal("new");
			});

			it("checks the port of an ircs:// link that names one", function () {
				expect(
					decideLinkTarget(tcp({port: 7000, portGiven: true}), {saved: [tlsNet]}).kind
				).to.equal("new");
				expect(
					uuidOf(decideLinkTarget(tcp({portGiven: true}), {saved: [tlsNet]}))
				).to.equal(tlsNet.uuid);
			});

			it("falls back to the host saved over the other transport, never weaker", function () {
				expect(
					uuidOf(decideLinkTarget(plainLink({portGiven: true}), {saved: [wsNet]}))
				).to.equal(wsNet.uuid);
				expect(uuidOf(decideLinkTarget(suggested(), {saved: [tlsNet]}))).to.equal(
					tlsNet.uuid
				);
				expect(decideLinkTarget(suggested(), {saved: [plainNet]}).kind).to.equal("new");
			});
		});

		it("refuses foreign hosts on a locked deploy", function () {
			const decision = decideLinkTarget(suggested(), {
				saved: [net()],
				lockedHost: "irc.pinned.org",
			});

			expect(decision.kind).to.equal("locked");
		});

		it("keeps matching behind a locked deploy's own host", function () {
			const policy = {saved: [net()], lockedHost: "IRC.Example.org"};
			expect(decideLinkTarget(suggested(), policy).kind).to.equal("saved");
			expect(decideLinkTarget(suggested(), {...policy, saved: []}).kind).to.equal("new");
		});
	});

	describe("sanitizeLinkParams", function () {
		it("keeps the allowed keys and drops secrets", function () {
			expect(
				sanitizeLinkParams({
					host: "h",
					port: "443",
					nick: "alice",
					saslPassword: "hunter2",
					autoconnect: "1",
					junk: "x",
				})
			).to.deep.equal({host: "h", port: "443", nick: "alice"});
		});
	});

	describe("mergeJoinLists", function () {
		it("unions channel lists without duplicates, keeping keys", function () {
			expect(mergeJoinLists("#a key, #b", "b,#c")).to.equal("#a key, #b, #c");
		});

		it("tolerates empty sides", function () {
			expect(mergeJoinLists("", "#a")).to.equal("#a");
			expect(mergeJoinLists("#a", "")).to.equal("#a");
			expect(mergeJoinLists("", "")).to.equal("");
		});
	});
});
