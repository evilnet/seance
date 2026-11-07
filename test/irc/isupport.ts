import {expect} from "chai";
import {ISupport} from "../../client/js/irc/isupport";
import {parseLine} from "../../client/js/irc/message";

const TRAILER = "are supported by this server";

// The three 005 lines nefarious2 (ircv3.2-upgrade) sent in the prototype run,
// see docs/resources/nefarious2-websocket.md §Prototype status.
const NEFARIOUS_005 = [
	":irc.seance.test 005 seance2 WHOX WALLCHOPS WALLHOPS WALLVOICES USERIP CPRIVMSG CNOTICE NAMESX UHNAMES SILENCE=25 WATCH=128 MONITOR=128 MODES=6 :are supported by this server",
	":irc.seance.test 005 seance2 MAXCHANNELS=20 MAXBANS=50 NICKLEN=15 MAXNICKLEN=30 TOPICLEN=250 AWAYLEN=250 KICKLEN=250 CHANNELLEN=200 MAXCHANNELLEN=200 CHANTYPES=#& PREFIX=(ov)@+ STATUSMSG=@+ BOT=B :are supported by this server",
	":irc.seance.test 005 seance2 CHANMODES=b,k,Ll,aCcDdHiMmNnOPpQRrSsTtZz CASEMAPPING=rfc1459 NETWORK=SeanceDev MAXLIST=b:50 ELIST=CT TARGMAX=PRIVMSG:20,NOTICE:20,JOIN:,PART: CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server",
];

function applyLines(isupport: ISupport, lines: string[]): void {
	for (const line of lines) {
		isupport.apply(parseLine(line)!.params);
	}
}

function make(...tokens: string[]): ISupport {
	const isupport = new ISupport();
	isupport.apply(["me", ...tokens, TRAILER]);
	return isupport;
}

describe("irc/isupport", function () {
	describe("apply / get / has", function () {
		it("skips the nick and trailer params", function () {
			const isupport = make("WHOX", "NICKLEN=15");
			expect(isupport.has("me")).to.equal(false);
			expect(isupport.has(TRAILER)).to.equal(false);
			expect(isupport.tokens.size).to.equal(2);
		});

		it("stores flag tokens with an empty value", function () {
			const isupport = make("WHOX");
			expect(isupport.has("WHOX")).to.equal(true);
			expect(isupport.get("WHOX")).to.equal("");
		});

		it("stores TOKEN=value", function () {
			expect(make("NETWORK=SeanceDev").get("NETWORK")).to.equal("SeanceDev");
		});

		it("stores TOKEN= as present with an empty value", function () {
			const isupport = make("PREFIX=");
			expect(isupport.has("PREFIX")).to.equal(true);
			expect(isupport.get("PREFIX")).to.equal("");
		});

		it("is case-insensitive on token names", function () {
			const isupport = make("nicklen=15");
			expect(isupport.get("NICKLEN")).to.equal("15");
			expect(isupport.get("NickLen")).to.equal("15");
			expect(isupport.has("nicklen")).to.equal(true);
			expect(Array.from(isupport.tokens.keys())).to.deep.equal(["NICKLEN"]);
		});

		it("removes tokens with -TOKEN", function () {
			const isupport = make("NICKLEN=15", "WHOX");
			isupport.apply(["me", "-NICKLEN", "-whox", TRAILER]);
			expect(isupport.has("NICKLEN")).to.equal(false);
			expect(isupport.has("WHOX")).to.equal(false);
			expect(isupport.nicklen).to.equal(undefined);
		});

		it("overwrites on re-application", function () {
			const isupport = make("NICKLEN=15");
			isupport.apply(["me", "NICKLEN=30", TRAILER]);
			expect(isupport.nicklen).to.equal(30);
		});

		it("unescapes \\xHH in values", function () {
			const isupport = make("NETWORK=Sea\\x20nce", "FOO=\\x3D\\x5Cbar");
			expect(isupport.get("NETWORK")).to.equal("Sea nce");
			expect(isupport.get("FOO")).to.equal("=\\bar");
		});

		it("decodes a run of \\xHH escapes as UTF-8", function () {
			const isupport = make("NETWORK=Caf\\xC3\\xA9\\x20\\xE2\\x98\\x95", "FOO=\\x5Cx41");
			expect(isupport.get("NETWORK")).to.equal("Café ☕");
			expect(isupport.get("FOO"), "an escaped backslash is not re-read").to.equal("\\x41");
		});

		it("reads a run that is not UTF-8 one byte per character", function () {
			expect(make("NETWORK=Caf\\xE9").get("NETWORK")).to.equal("Café");
		});

		it("leaves malformed escapes alone", function () {
			expect(make("FOO=a\\xZZb\\x2").get("FOO")).to.equal("a\\xZZb\\x2");
		});

		it("ignores empty params and messages with only nick and trailer", function () {
			const isupport = new ISupport();
			isupport.apply(["me", TRAILER]);
			isupport.apply(["me", "", TRAILER]);
			expect(isupport.tokens.size).to.equal(0);
		});

		it("reset clears everything", function () {
			const isupport = make("NICKLEN=15", "PREFIX=(qaohv)~&@%+");
			isupport.reset();
			expect(isupport.tokens.size).to.equal(0);
			expect(isupport.prefix).to.deep.equal({modes: "ov", symbols: "@+"});
		});
	});

	describe("typed getters", function () {
		it("returns documented defaults when nothing is known", function () {
			const isupport = new ISupport();
			expect(isupport.prefix).to.deep.equal({modes: "ov", symbols: "@+"});
			expect(isupport.chantypes).to.equal("#&");
			expect(isupport.statusmsg).to.equal("");
			expect(isupport.casemapping).to.equal("rfc1459");
			expect(isupport.network).to.equal(undefined);
			expect(isupport.chanmodes).to.deep.equal({
				a: "b",
				b: "k",
				c: "Ll",
				d: "aCcDdHiMmNnOPpQRrSsTtZz",
			});
			expect(isupport.nicklen).to.equal(undefined);
			expect(isupport.chathistory).to.equal(undefined);
			expect(isupport.extban).to.equal(undefined);
			expect(isupport.bot).to.equal(undefined);
			expect(isupport.targmax.size).to.equal(0);
		});

		it("parses PREFIX with halfops and owner/admin", function () {
			const isupport = make("PREFIX=(qaohv)~&@%+");
			expect(isupport.prefix).to.deep.equal({modes: "qaohv", symbols: "~&@%+"});
			expect(isupport.prefixForMode("h")).to.equal("%");
			expect(isupport.prefixForMode("q")).to.equal("~");
			expect(isupport.prefixForMode("x")).to.equal(undefined);
			expect(isupport.modeForPrefix("%")).to.equal("h");
			expect(isupport.modeForPrefix("+")).to.equal("v");
			expect(isupport.modeForPrefix("!")).to.equal(undefined);
		});

		it("treats an empty PREFIX as no prefixes", function () {
			const isupport = make("PREFIX=");
			expect(isupport.prefix).to.deep.equal({modes: "", symbols: ""});
			expect(isupport.prefixForMode("o")).to.equal(undefined);
		});

		it("falls back to the default on a malformed PREFIX", function () {
			expect(make("PREFIX=ov@+").prefix).to.deep.equal({modes: "ov", symbols: "@+"});
			expect(make("PREFIX=(ohv)@+").prefix).to.deep.equal({modes: "ov", symbols: "@+"});
		});

		it("parses CHANTYPES and STATUSMSG", function () {
			const isupport = make("CHANTYPES=#", "STATUSMSG=@%+");
			expect(isupport.chantypes).to.equal("#");
			expect(isupport.statusmsg).to.equal("@%+");
		});

		it("parses CASEMAPPING and falls back to rfc1459 for unknown values", function () {
			expect(make("CASEMAPPING=ascii").casemapping).to.equal("ascii");
			expect(make("CASEMAPPING=rfc1459-strict").casemapping).to.equal("rfc1459-strict");
			expect(make("CASEMAPPING=RFC1459").casemapping).to.equal("rfc1459");
			expect(make("CASEMAPPING=rfc7613").casemapping).to.equal("rfc1459");
		});

		it("parses NETWORK", function () {
			expect(make("NETWORK=AfterNET").network).to.equal("AfterNET");
			expect(make("NETWORK=").network).to.equal(undefined);
		});

		it("parses CHANMODES, tolerating fewer than four groups", function () {
			expect(make("CHANMODES=beI,k,l,imnpst").chanmodes).to.deep.equal({
				a: "beI",
				b: "k",
				c: "l",
				d: "imnpst",
			});
			expect(make("CHANMODES=b,k").chanmodes).to.deep.equal({a: "b", b: "k", c: "", d: ""});
		});

		it("parses NICKLEN and CHATHISTORY as integers", function () {
			expect(make("NICKLEN=15").nicklen).to.equal(15);
			expect(make("NICKLEN=abc").nicklen).to.equal(undefined);
			expect(make("CHATHISTORY=100").chathistory).to.equal(100);
			expect(make("CHATHISTORY=0").chathistory).to.equal(0);
			expect(make("CHATHISTORY=").chathistory).to.equal(undefined);
		});

		it("parses EXTBAN (branch spelling)", function () {
			expect(make("EXTBAN=~,acjnqr").extban).to.deep.equal({prefix: "~", types: "acjnqr"});
		});

		it("parses EXTBANS (master spelling)", function () {
			expect(make("EXTBANS=~,acjnqr").extban).to.deep.equal({prefix: "~", types: "acjnqr"});
		});

		it("prefers EXTBAN over EXTBANS when both are present", function () {
			expect(make("EXTBANS=~,a", "EXTBAN=$,b").extban).to.deep.equal({
				prefix: "$",
				types: "b",
			});
		});

		it("handles EXTBAN without a prefix character", function () {
			expect(make("EXTBAN=,abc").extban).to.deep.equal({prefix: "", types: "abc"});
			expect(make("EXTBAN=abc").extban).to.deep.equal({prefix: "", types: "abc"});
		});

		it("parses BOT", function () {
			expect(make("BOT=B").bot).to.equal("B");
			expect(make("BOT=").bot).to.equal(undefined);
		});

		it("parses TARGMAX with unlimited entries", function () {
			const targmax = make("TARGMAX=PRIVMSG:20,NOTICE:20,JOIN:,PART:,kick").targmax;
			expect(targmax.get("PRIVMSG")).to.equal(20);
			expect(targmax.get("NOTICE")).to.equal(20);
			expect(targmax.has("JOIN")).to.equal(true);
			expect(targmax.get("JOIN")).to.equal(undefined);
			expect(targmax.has("KICK")).to.equal(true);
			expect(targmax.get("KICK")).to.equal(undefined);
			expect(targmax.size).to.equal(5);
		});
	});

	describe("nefarious2 transcript", function () {
		it("applies all three 005 lines", function () {
			const isupport = new ISupport();
			applyLines(isupport, NEFARIOUS_005);

			expect(isupport.has("WHOX")).to.equal(true);
			expect(isupport.get("MONITOR")).to.equal("128");
			expect(isupport.get("MODES")).to.equal("6");
			expect(isupport.nicklen).to.equal(15);
			expect(isupport.get("MAXNICKLEN")).to.equal("30");
			expect(isupport.chantypes).to.equal("#&");
			expect(isupport.prefix).to.deep.equal({modes: "ov", symbols: "@+"});
			expect(isupport.statusmsg).to.equal("@+");
			expect(isupport.bot).to.equal("B");
			expect(isupport.chanmodes).to.deep.equal({
				a: "b",
				b: "k",
				c: "Ll",
				d: "aCcDdHiMmNnOPpQRrSsTtZz",
			});
			expect(isupport.casemapping).to.equal("rfc1459");
			expect(isupport.network).to.equal("SeanceDev");
			expect(isupport.get("MAXLIST")).to.equal("b:50");
			expect(isupport.get("ELIST")).to.equal("CT");
			expect(Array.from(isupport.targmax.entries())).to.deep.equal([
				["PRIVMSG", 20],
				["NOTICE", 20],
				["JOIN", undefined],
				["PART", undefined],
			]);
			expect(isupport.chathistory).to.equal(100);
			expect(isupport.get("MSGREFTYPES")).to.equal("timestamp,msgid");
			expect(isupport.extban).to.equal(undefined);
		});
	});
});
