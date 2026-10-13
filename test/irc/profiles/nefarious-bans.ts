import {expect} from "chai";
import {
	banLine,
	banPrivs,
	checkMask,
	formatDuration,
	killLine,
	maskSuggestions,
	normaliseMask,
	parseDuration,
} from "../../../client/js/irc/profiles/nefarious/bans";

describe("nefarious2 bans (profiles/nefarious/bans.ts)", function () {
	it("parses durations the way ParseInterval does, minus its silent zeros", function () {
		expect(parseDuration("3600")).to.equal(3600);
		expect(parseDuration("1d")).to.equal(86400);
		expect(parseDuration("1d2h30m")).to.equal(86400 + 7200 + 1800);
		expect(parseDuration("1M")).to.equal(31 * 86400);
		expect(parseDuration("2m30")).to.equal(150);
		expect(parseDuration("0")).to.equal(undefined);
		expect(parseDuration("1x")).to.equal(undefined);
		expect(parseDuration("")).to.equal(undefined);
		expect(formatDuration(90061)).to.equal("1d 1h");
		expect(formatDuration(59)).to.equal("59s");
	});

	it("suggests masks from what the oper knows, most precise first", function () {
		expect(
			maskSuggestions("gline", {ident: "bob", ip: "203.0.113.7", host: "cpe.example.net"})
		).to.deep.equal([
			{mask: "*@203.0.113.7", label: "This IP"},
			{mask: "bob@203.0.113.7", label: "This ident on this IP"},
			{mask: "*@203.0.113.0/24", label: "The /24 (needs force)"},
			{mask: "*@cpe.example.net", label: "This host name"},
		]);
		expect(
			maskSuggestions("gline", {ident: "~bob", ip: "203.0.113.7"}).map((s) => s.mask)
		).to.not.include("~bob@203.0.113.7");
		expect(maskSuggestions("zline", {ip: "203.0.113.7"}).map((s) => s.mask)).to.deep.equal([
			"203.0.113.7",
			"203.0.113.0/24",
		]);
	});

	it("checks masks against the server's width rules", function () {
		expect(normaliseMask("gline", "1.2.3.4")).to.equal("*@1.2.3.4");
		expect(checkMask("gline", "*@1.2.3.4")).to.deep.equal({needsForce: false});
		expect(checkMask("gline", "bob@host.example.com")).to.deep.equal({needsForce: false});
		expect(checkMask("gline", "*@1.2.3.0/24")).to.deep.equal({needsForce: true});
		expect(checkMask("gline", "*@1.2.3.*")).to.deep.equal({needsForce: true});
		expect(checkMask("gline", "*@*.example.com")).to.deep.equal({needsForce: true});
		expect(checkMask("gline", "*@1.2.0.0/8").error).to.match(/16/);
		expect(checkMask("gline", "*@*.com").error).to.match(/two dots/);
		expect(checkMask("gline", "*@foo.*.com").error).to.match(/last two labels/);
		expect(checkMask("gline", "$Rspam bot").error).to.match(/spaces/);
		expect(checkMask("gline", "$Rspam?bot")).to.deep.equal({needsForce: false});
		expect(checkMask("gline", "$Aaccount").error).to.match(/\$R/);
		expect(checkMask("gline", "#badchan")).to.deep.equal({needsForce: false});
		expect(checkMask("shun", "#badchan").error).to.match(/G-line/);
		expect(checkMask("zline", "1.2.3.4")).to.deep.equal({needsForce: false});
		expect(checkMask("zline", "*@1.2.3.4").error).to.match(/IP/);
		expect(checkMask("zline", "2001:db8::/48")).to.deep.equal({needsForce: true});
		expect(checkMask("gline", "").error).to.equal("Enter a mask.");
	});

	it("builds the lines nefarious2 expects", function () {
		expect(
			banLine({
				type: "gline",
				mask: "1.2.3.4",
				scope: "*",
				seconds: 3600,
				reason: "spam bots",
			})
		).to.equal("GLINE +*@1.2.3.4 * 3600 :spam bots");
		expect(
			banLine({
				type: "shun",
				mask: "*@1.2.3.0/24",
				scope: "",
				seconds: 600,
				reason: "shush",
				force: true,
			})
		).to.equal("SHUN !+*@1.2.3.0/24 600 :shush");
		expect(
			banLine({
				type: "zline",
				mask: "1.2.3.4",
				scope: "leaf.test",
				seconds: 60,
				reason: "zap",
			})
		).to.equal("ZLINE +1.2.3.4 leaf.test 60 :zap");
		expect(killLine("bob", "flooding")).to.equal("KILL bob :flooding");
		expect(banPrivs("gline", "*")).to.deep.equal(["GLINE"]);
		expect(banPrivs("zline", "")).to.deep.equal(["ZLINE", "LOCAL_ZLINE"]);
	});
});
