import {expect} from "chai";
import parseIrcUri from "../../client/js/helpers/parseIrcUri";
import {
	decideLinkTarget,
	linkSuggestion,
	mergeJoinLists,
	sanitizeLinkParams,
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
				join: "#chan",
			});
			expect(
				linkSuggestion(parseIrcUri("web+irc://irc.example.org:8443/#chan"))
			).to.deep.equal({
				host: "irc.example.org",
				port: 8443,
				portGiven: true,
				tls: true,
				join: "#chan",
			});
		});

		it("defaults a missing port to 443 and TLS to on", function () {
			expect(linkSuggestion({host: "irc.example.org"})).to.deep.equal({
				host: "irc.example.org",
				port: 443,
				portGiven: false,
				tls: true,
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
		const suggested = (overrides = {}) => ({
			host: "irc.example.org",
			port: 443,
			portGiven: true,
			tls: true,
			join: "#chan",
			...overrides,
		});

		it("matches a saved network on the host alone when the link names no port", function () {
			const decision = decideLinkTarget(suggested({portGiven: false}), {
				saved: [net({port: 8443, tls: false})],
			});

			expect(decision.kind).to.equal("saved");
			expect(decision.kind === "saved" && decision.network.port).to.equal(8443);
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
