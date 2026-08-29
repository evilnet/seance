import {expect} from "chai";
import {CapNegotiator, CapResult, SEANCE_CAPS} from "../../client/js/irc/caps";
import {IrcMessage, MAX_LINE_BYTES, parseLine, utf8ByteLength} from "../../client/js/irc/message";

// The CAP LS exchange nefarious2 (ircv3.2-upgrade) produced in the prototype
// run, see docs/resources/nefarious2-websocket.md §Prototype status.
const NEFARIOUS_LS_1 =
	":irc.seance.test CAP * LS * :multi-prefix userhost-in-names extended-join away-notify account-notify cap-notify server-time echo-message account-tag chghost invite-notify labeled-response batch setname standard-replies message-tags no-implicit-names draft/no-implicit-names draft/extended-isupport draft/pre-away draft/multiline=max-bytes=16384,max-lines=100 draft/chathistory=100 draft/event-playback draft/message-redaction draft/read-marker draft/metadata-2=before-connect,max-subs=50,max-keys=20,max-value-bytes=300 draft/bouncer draft/persistence";
const NEFARIOUS_LS_2 = ":irc.seance.test CAP * LS : tls";

// nefarious2 master: no CAP 302 support, one unversioned line.
const MASTER_LS =
	":irc.example.org CAP * LS :multi-prefix userhost-in-names extended-join away-notify account-notify sasl tls";

function msg(line: string): IrcMessage {
	const parsed = parseLine(line);

	if (!parsed) {
		throw new Error(`bad test line: ${line}`);
	}

	return parsed;
}

function feed(neg: CapNegotiator, line: string): CapResult {
	return neg.handle(msg(line));
}

/** Names requested by a `CAP REQ :...` line. */
function reqCaps(line: string): string[] {
	expect(line.startsWith("CAP REQ :")).to.equal(true, `not a REQ: ${line}`);
	return line.slice("CAP REQ :".length).split(" ");
}

describe("irc/caps", function () {
	describe("start", function () {
		it("opens with CAP LS 302", function () {
			expect(new CapNegotiator(SEANCE_CAPS).start()).to.deep.equal(["CAP LS 302"]);
		});
	});

	describe("nefarious2 ircv3.2-upgrade transcript", function () {
		it("accumulates the continued LS, then REQs once and ENDs in the same flush", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);

			const first = feed(neg, NEFARIOUS_LS_1);
			expect(first.send).to.deep.equal([]);
			expect(first.done).to.equal(false);
			expect(neg.available.has("multi-prefix")).to.equal(true);
			expect(neg.available.has("tls")).to.equal(false);

			const second = feed(neg, NEFARIOUS_LS_2);
			// Pipelined: the REQ and CAP END go out together; the ACK is
			// processed by the server before it reads the END.
			expect(second.done).to.equal(true);
			expect(second.missingRequired).to.deep.equal([]);
			expect(second.error).to.equal(undefined);
			expect(second.send).to.have.length(2);
			expect(second.send[1]).to.equal("CAP END");
			expect(neg.available.has("tls")).to.equal(true);

			const requested = reqCaps(second.send[0]);
			expect(requested).to.deep.equal(SEANCE_CAPS.wanted);
			expect(requested).to.not.include("tls");
			expect(requested).to.include("draft/multiline");
			expect(requested).to.not.include("draft/bouncer");
			expect(requested).to.not.include("draft/metadata-2");
			expect(requested).to.include("draft/persistence");
			expect(requested).to.not.include("draft/metadata-2");
			expect(requested).to.not.include("no-implicit-names");
			expect(utf8ByteLength(second.send[0])).to.be.at.most(MAX_LINE_BYTES);

			const ack = feed(neg, `:irc.seance.test CAP * ACK :${requested.join(" ")}`);
			expect(ack.send).to.deep.equal([]);
			expect(ack.done).to.equal(true);
			expect(neg.done).to.equal(true);

			for (const cap of requested) {
				expect(neg.hasCapability(cap)).to.equal(true, cap);
			}

			expect(neg.hasCapability("draft/bouncer")).to.equal(false);
		});

		it("exposes 302 values", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			feed(neg, NEFARIOUS_LS_1);
			feed(neg, NEFARIOUS_LS_2);

			expect(neg.value("draft/chathistory")).to.equal("100");
			expect(neg.value("draft/multiline")).to.equal("max-bytes=16384,max-lines=100");
			expect(neg.value("draft/metadata-2")).to.equal(
				"before-connect,max-subs=50,max-keys=20,max-value-bytes=300"
			);
			expect(neg.value("multi-prefix")).to.equal("");
			expect(neg.value("nope")).to.equal(undefined);
		});

		it("keeps tracking ACKs that arrive after the pipelined CAP END", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			feed(neg, NEFARIOUS_LS_1);
			const requested = reqCaps(feed(neg, NEFARIOUS_LS_2).send[0]);

			const half = requested.slice(0, 5);
			const rest = requested.slice(5);

			const partial = feed(neg, `:irc.seance.test CAP * ACK :${half.join(" ")}`);
			expect(partial.send).to.deep.equal([]);
			expect(half.every((c) => neg.hasCapability(c))).to.equal(true);
			expect(rest.some((c) => neg.hasCapability(c))).to.equal(false);

			const final = feed(neg, `:irc.seance.test CAP * ACK :${rest.join(" ")}`);
			expect(final.send).to.deep.equal([]);
			expect(rest.every((c) => neg.hasCapability(c))).to.equal(true);
		});
	});

	describe("nefarious2 master (no CAP 302)", function () {
		it("negotiates a single unversioned LS and never requests sasl/tls", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			const ls = feed(neg, MASTER_LS);

			expect(ls.send).to.have.length(2);
			expect(ls.send[1]).to.equal("CAP END");
			const requested = reqCaps(ls.send[0]);
			expect(requested).to.deep.equal([
				"multi-prefix",
				"userhost-in-names",
				"extended-join",
				"away-notify",
				"account-notify",
			]);

			const ack = feed(neg, `:irc.example.org CAP * ACK :${requested.join(" ")}`);
			expect(ack.send).to.deep.equal([]);
			expect(ack.done).to.equal(true);
		});
	});

	describe("required caps", function () {
		it("reports required caps the server does not offer and sends nothing", function () {
			const neg = new CapNegotiator({
				required: ["server-time", "batch"],
				wanted: ["multi-prefix"],
			});
			const res = feed(neg, ":s CAP * LS :multi-prefix");

			expect(res.missingRequired).to.deep.equal(["server-time", "batch"]);
			expect(res.error).to.be.a("string");
			expect(res.send).to.deep.equal([]);
			expect(res.done).to.equal(false);
		});

		it("lists required caps first in the REQ", function () {
			const neg = new CapNegotiator({
				required: ["server-time"],
				wanted: ["multi-prefix", "server-time"],
			});
			const res = feed(neg, ":s CAP * LS :multi-prefix server-time");
			expect(reqCaps(res.send[0])).to.deep.equal(["server-time", "multi-prefix"]);
		});

		it("retries a NAKed multi-cap REQ one cap at a time, then reports the required one", function () {
			const neg = new CapNegotiator({required: ["server-time"], wanted: ["multi-prefix"]});
			const ls = feed(neg, ":s CAP * LS :multi-prefix server-time");
			expect(ls.send).to.deep.equal(["CAP REQ :server-time multi-prefix", "CAP END"]);

			// A REQ is atomic: one refused cap sinks the lot. Ask again singly.
			const nak = feed(neg, ":s CAP * NAK :server-time multi-prefix");
			expect(nak.send).to.deep.equal(["CAP REQ :server-time", "CAP REQ :multi-prefix"]);
			expect(nak.missingRequired).to.deep.equal([]);
			expect(nak.naked).to.deep.equal([]);

			const nak2 = feed(neg, ":s CAP * NAK :server-time");
			expect(nak2.send).to.deep.equal([]);
			expect(nak2.missingRequired).to.deep.equal(["server-time"]);
			expect(nak2.error).to.be.a("string");
			expect(feed(neg, ":s CAP * ACK :multi-prefix").send).to.deep.equal([]);
			expect(Array.from(neg.enabled)).to.deep.equal(["multi-prefix"]);
		});
	});

	describe("NAK", function () {
		it("treats a single-cap NAK as final and does not enable the cap", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a", "b"]});
			feed(neg, ":s CAP * LS :a b c");

			const nak = feed(neg, ":s CAP * NAK :a b");
			expect(nak.send).to.deep.equal(["CAP REQ :a", "CAP REQ :b"]);
			expect(nak.done).to.equal(true);
			expect(nak.missingRequired).to.deep.equal([]);

			const again = feed(neg, ":s CAP * NAK :a");
			expect(again.send).to.deep.equal([]);
			expect(again.naked).to.deep.equal(["a"]);
			expect(neg.hasCapability("a")).to.equal(false);
			expect(neg.isRequesting("a")).to.equal(false);
			expect(neg.isRequesting("b")).to.equal(true);
		});

		it("mixes ACK and NAK across replies", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a", "b", "c"]});
			feed(neg, ":s CAP * LS :a b c");

			expect(feed(neg, ":s CAP * NAK :b").send).to.deep.equal([]);
			const ack = feed(neg, ":s CAP * ACK :a c");
			expect(ack.send).to.deep.equal([]);
			expect(Array.from(neg.enabled)).to.deep.equal(["a", "c"]);
		});
	});

	describe("edge cases", function () {
		it("sends CAP END directly when nothing offered is wanted", function () {
			const neg = new CapNegotiator({required: [], wanted: ["batch"]});
			const res = feed(neg, ":s CAP * LS :sasl tls");
			expect(res.send).to.deep.equal(["CAP END"]);
			expect(res.done).to.equal(true);
		});

		it("sends CAP END on an empty LS", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			const res = feed(neg, ":s CAP * LS :");
			expect(res.send).to.deep.equal(["CAP END"]);
			expect(res.done).to.equal(true);
		});

		it("ignores non-CAP messages", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			const res = feed(neg, ":s NOTICE * :*** Looking up your hostname");
			expect(res).to.deep.equal({send: [], done: false, missingRequired: [], naked: []});
		});

		it("ignores a CAP with too few params", function () {
			const neg = new CapNegotiator(SEANCE_CAPS);
			expect(neg.handle(msg("CAP")).send).to.deep.equal([]);
		});

		it("does not REQ twice on a duplicate final LS", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a"]});
			expect(feed(neg, ":s CAP * LS :a").send).to.deep.equal(["CAP REQ :a", "CAP END"]);
			expect(feed(neg, ":s CAP * LS :a").send).to.deep.equal([]);
		});

		it("does not emit CAP END twice", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a"]});
			expect(feed(neg, ":s CAP * LS :a").send).to.deep.equal(["CAP REQ :a", "CAP END"]);
			expect(feed(neg, ":s CAP * ACK :a").send).to.deep.equal([]);
			expect(feed(neg, ":s CAP * ACK :a").send).to.deep.equal([]);
		});

		it("deduplicates caps listed in both required and wanted", function () {
			const neg = new CapNegotiator({required: ["a"], wanted: ["a", "b"]});
			const res = feed(neg, ":s CAP * LS :a b");
			expect(reqCaps(res.send[0])).to.deep.equal(["a", "b"]);
		});

		it("handles ACK with -cap (disable) tokens", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a"]});
			feed(neg, ":s CAP * LS :a");
			feed(neg, ":s CAP * ACK :a");
			expect(neg.hasCapability("a")).to.equal(true);
			feed(neg, ":s CAP nick ACK :-a");
			expect(neg.hasCapability("a")).to.equal(false);
		});

		it("handles CAP LIST by replacing the enabled set", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a", "b"]});
			feed(neg, ":s CAP * LS :a b");
			feed(neg, ":s CAP * ACK :a b");
			feed(neg, ":s CAP nick LIST :a");
			expect(Array.from(neg.enabled)).to.deep.equal(["a"]);
		});

		it("splits a REQ that would exceed MAX_LINE_BYTES", function () {
			const wanted: string[] = [];

			for (let i = 0; i < 60; i++) {
				wanted.push(`vendor.example/capability-number-${i}`);
			}

			const neg = new CapNegotiator({required: [], wanted});
			const res = feed(neg, `:s CAP * LS :${wanted.join(" ")}`);
			expect(res.send.pop()).to.equal("CAP END");
			expect(res.send.length).to.be.greaterThan(1);

			const all: string[] = [];

			for (const line of res.send) {
				expect(utf8ByteLength(line)).to.be.at.most(MAX_LINE_BYTES);
				all.push(...reqCaps(line));
			}

			expect(all).to.deep.equal(wanted);
		});
	});

	describe("CAP NEW / DEL (cap-notify)", function () {
		function registered(): CapNegotiator {
			const neg = new CapNegotiator(SEANCE_CAPS);
			feed(neg, NEFARIOUS_LS_1);
			const requested = reqCaps(feed(neg, NEFARIOUS_LS_2).send[0]);
			feed(neg, `:irc.seance.test CAP * ACK :${requested.join(" ")}`);
			expect(neg.done).to.equal(true);
			return neg;
		}

		it("requests wanted caps that appear via NEW and enables them on ACK", function () {
			const neg = registered();
			feed(neg, ":irc.seance.test CAP seance2 DEL :draft/event-playback");
			expect(neg.hasCapability("draft/event-playback")).to.equal(false);

			const res = feed(neg, ":irc.seance.test CAP seance2 NEW :draft/event-playback");
			expect(res.send).to.deep.equal(["CAP REQ :draft/event-playback"]);
			expect(res.done).to.equal(true);
			expect(neg.available.has("draft/event-playback")).to.equal(true);

			const ack = feed(neg, ":irc.seance.test CAP seance2 ACK :draft/event-playback");
			expect(ack.send).to.deep.equal([]);
			expect(neg.hasCapability("draft/event-playback")).to.equal(true);
		});

		it("ignores NEW caps that are not wanted", function () {
			const neg = registered();
			const res = feed(neg, ":irc.seance.test CAP seance2 NEW :draft/webpush=vapid");
			expect(res.send).to.deep.equal([]);
			expect(neg.value("draft/webpush")).to.equal("vapid");
		});

		it("does not re-request an already enabled cap on NEW", function () {
			const neg = registered();
			const res = feed(neg, ":irc.seance.test CAP seance2 NEW :batch");
			expect(res.send).to.deep.equal([]);
		});

		it("removes caps on DEL from both available and enabled", function () {
			const neg = registered();
			const res = feed(neg, ":irc.seance.test CAP seance2 DEL :batch labeled-response");
			expect(res.send).to.deep.equal([]);
			expect(res.missingRequired).to.deep.equal([]);
			expect(neg.hasCapability("batch")).to.equal(false);
			expect(neg.available.has("batch")).to.equal(false);
			expect(neg.hasCapability("labeled-response")).to.equal(false);
			expect(neg.hasCapability("server-time")).to.equal(true);
		});

		it("reports DEL of a required cap", function () {
			const neg = new CapNegotiator({required: ["batch"], wanted: []});
			feed(neg, ":s CAP * LS :batch");
			feed(neg, ":s CAP * ACK :batch");

			const res = feed(neg, ":s CAP nick DEL :batch");
			expect(res.missingRequired).to.deep.equal(["batch"]);
			expect(res.error).to.be.a("string");
		});

		it("folds a NEW that arrives mid-LS into the single REQ", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a", "b"]});
			expect(feed(neg, ":s CAP * LS * :a").send).to.deep.equal([]);
			expect(feed(neg, ":s CAP * NEW :b").send).to.deep.equal([]);
			const res = feed(neg, ":s CAP * LS :c");
			expect(reqCaps(res.send[0])).to.deep.equal(["a", "b"]);
		});

		it("REQs a NEW cap after the pipelined END and enables it on ACK", function () {
			const neg = new CapNegotiator({required: [], wanted: ["a", "b"]});
			expect(feed(neg, ":s CAP * LS :a").send).to.deep.equal(["CAP REQ :a", "CAP END"]);
			const nw = feed(neg, ":s CAP * NEW :b");
			expect(nw.send).to.deep.equal(["CAP REQ :b"]);

			expect(feed(neg, ":s CAP * ACK :a").send).to.deep.equal([]);
			expect(feed(neg, ":s CAP * ACK :b").send).to.deep.equal([]);
			expect(neg.hasCapability("b")).to.equal(true);
		});
	});

	describe("SEANCE_CAPS", function () {
		it("has no required caps and the documented wanted list", function () {
			expect(SEANCE_CAPS.required).to.deep.equal([]);
			expect(SEANCE_CAPS.wanted).to.include.members([
				"server-time",
				"message-tags",
				"batch",
				"labeled-response",
				"draft/chathistory",
				"draft/event-playback",
				"draft/multiline",
			]);
			expect(SEANCE_CAPS.wanted).to.not.include.members([
				"draft/bouncer",
				"draft/persistence",
				"draft/metadata-2",
				"no-implicit-names",
				"sasl",
				"tls",
			]);
		});
	});
});
