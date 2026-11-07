import {expect} from "chai";
import {
	accountBanPrefix,
	banAnswersQuery,
	banCovers,
	banMatches,
	banSetter,
	banSuggestions,
	checkBanMask,
	isExtendedBan,
	normaliseBanMask,
	parseAddress,
	parseMembers,
	sameBan,
	sortBans,
	wideHost,
} from "../../client/js/helpers/channelBans";
import {holdsChannelPower} from "../../client/js/helpers/banMenu";
import {describeBan} from "../../client/js/irc/profiles/nefarious/extbans";
import {parseLine, type IrcMessage} from "../../client/js/irc/message";

const lines = (...raw: string[]) => raw.map((line) => parseLine(line) as IrcMessage);

describe("channel ban masks", function () {
	describe("normaliseBanMask", function () {
		it("reads a mask as the server's pretty_mask does", function () {
			expect(normaliseBanMask("bob")).to.equal("bob!*@*");
			expect(normaliseBanMask("host.example.net")).to.equal("*!*@host.example.net");
			expect(normaliseBanMask("2001:db8::1")).to.equal("*!*@2001:db8::1");
			expect(normaliseBanMask("user@host")).to.equal("*!user@host");
			expect(normaliseBanMask("nick!user")).to.equal("nick!user@*");
			expect(normaliseBanMask(" a!b@c ")).to.equal("a!b@c");
			expect(normaliseBanMask("a!@")).to.equal("a!*@*");
		});

		it("leaves an extended ban alone, and an ident starting with ~ is not one", function () {
			expect(normaliseBanMask("~a:bob")).to.equal("~a:bob");
			expect(normaliseBanMask("~q:~a:bob")).to.equal("~q:~a:bob");
			expect(isExtendedBan("~!r:*bot*")).to.equal(true);
			expect(normaliseBanMask("~bob@host")).to.equal("*!~bob@host");
		});
	});

	it("says why a mask cannot go on a MODE line", function () {
		expect(checkBanMask("")).to.be.a("string");
		expect(checkBanMask("a b")).to.be.a("string");
		expect(checkBanMask(":oops")).to.be.a("string");
		expect(checkBanMask("*!*@host")).to.equal(undefined);
	});

	describe("wideHost", function () {
		it("opens the first part of a cloak or a name, the last of an IPv4", function () {
			expect(wideHost("AN-1F2E3D4C.ip4.example.net")).to.equal("*.ip4.example.net");
			expect(wideHost("1.2.3.4")).to.equal("1.2.3.*");
		});

		it("offers nothing that would be too much", function () {
			expect(wideHost("example.net"), "two labels").to.equal(undefined);
			expect(wideHost("2001:db8::1"), "IPv6").to.equal(undefined);
			expect(wideHost("bob.users.example.org", "bob"), "everyone logged in").to.equal(
				undefined
			);
			expect(wideHost(undefined)).to.equal(undefined);
		});
	});

	describe("banSuggestions", function () {
		const masks = (...args: Parameters<typeof banSuggestions>) =>
			banSuggestions(...args).map((s) => s.mask);

		it("starts with the address and ends with the provider", function () {
			expect(
				masks({nick: "bob", ident: "bob", host: "AN-1F2E3D4C.ip4.example.net"})
			).to.deep.equal([
				"*!*@AN-1F2E3D4C.ip4.example.net",
				"*!bob@AN-1F2E3D4C.ip4.example.net",
				"bob!*@*",
				"*!*@*.ip4.example.net",
			]);
		});

		it("loosens an unverified ident", function () {
			expect(masks({ident: "~bob", host: "h.example.net"})[1]).to.equal(
				"*!*bob@h.example.net"
			);
		});

		it("offers an oper the real IP and an account only where the server takes one", function () {
			const target = {nick: "bob", host: "h.example.net", ip: "1.2.3.4", account: "bobby"};
			expect(masks(target)).to.include("*!*@1.2.3.4");
			expect(masks(target)).to.not.include("~a:bobby");
			expect(masks(target, "~a:")).to.include("~a:bobby");
		});

		it("has only the nick for someone it knows nothing else about", function () {
			expect(masks({nick: "bob"})).to.deep.equal(["bob!*@*"]);
		});
	});

	it("takes the account prefix from EXTBANS or EXTBAN", function () {
		expect(accountBanPrefix("~,acjnqrmM")).to.equal("~a:");
		expect(accountBanPrefix("$,ajrxc")).to.equal("$a:");
		expect(accountBanPrefix("~,cjnqr")).to.equal("");
		expect(accountBanPrefix(undefined)).to.equal("");
	});

	describe("banCovers", function () {
		it("is the server's: a wider ban covers a narrower one, not the other way", function () {
			expect(banCovers("*!*@*.example.com", "*!*@foo.example.com")).to.equal(true);
			expect(banCovers("*!*@foo.example.com", "*!x@foo.example.com")).to.equal(true);
			expect(banCovers("*!x@foo.example.com", "*!*@foo.example.com")).to.equal(false);
			expect(banCovers("*!*@*.example.com", "foo.example.com")).to.equal(true);
		});

		it("compares extended bans whole", function () {
			expect(banCovers("~a:bob", "~a:BOB")).to.equal(true);
			expect(banCovers("~a:b*", "~a:bob")).to.equal(false);
			expect(banCovers("*!*@*", "~a:bob")).to.equal(false);
		});
	});

	it("treats masks the server would store alike as the same ban", function () {
		expect(sameBan("bob", "BOB!*@*")).to.equal(true);
		expect(sameBan("bob", "bob!x@*")).to.equal(false);
	});

	describe("banMatches", function () {
		const bob = {
			nick: "bob",
			ident: "bobby",
			host: "AN-1.ip4.example.net",
			ip: "1.2.3.4",
			account: "bobacct",
			realname: "Bob the Bot",
		};

		it("matches nick, ident and host", function () {
			expect(banMatches("*!*@*.ip4.example.net", bob)).to.equal(true);
			expect(banMatches("bob!*@*", bob)).to.equal(true);
			expect(banMatches("BOB!*@*", bob)).to.equal(true);
			expect(banMatches("*!other@*", bob)).to.equal(false);
			expect(banMatches("carol!*@*", bob)).to.equal(false);
		});

		it("tries the IP as well as the host, CIDR included", function () {
			expect(banMatches("*!*@1.2.3.*", bob)).to.equal(true);
			expect(banMatches("*!*@1.2.3.0/24", bob)).to.equal(true);
			expect(banMatches("*!*@9.9.9.0/24", bob)).to.equal(false);
		});

		it("reads accounts and real names, through ~q: too", function () {
			expect(banMatches("~a:bobacct", bob)).to.equal(true);
			expect(banMatches("~a:someone", bob)).to.equal(false);
			expect(banMatches("~r:*bot*", bob)).to.equal(true);
			expect(banMatches("~q:~a:bob*", bob)).to.equal(true);
			expect(banMatches("~q:*!*@*.example.net", bob)).to.equal(true);
		});

		it("does not guess at what it cannot see", function () {
			expect(banMatches("~c:#elsewhere", bob)).to.equal(undefined);
			expect(banMatches("~!a:bobacct", bob)).to.equal(undefined);
		});

		it("misses someone logged out by an account ban", function () {
			expect(banMatches("~a:*", {nick: "x"})).to.equal(false);
		});
	});

	describe("parseMembers", function () {
		it("reads WHOX rows with our token, as the dev ircd sends them", function () {
			expect(
				parseMembers(
					lines(
						"@batch=A :irc.test 354 me 123 #c bob 1.2.3.4 h.example.net bob H@x acct :Bob B",
						"@batch=A :irc.test 354 me 123 #c amy 255.255.255.255 k.example.net amy H 0 :Amy",
						"@batch=A :irc.test 354 me 999 #c old 0 x.example.net old H 0 :not ours"
					),
					"123"
				)
			).to.deep.equal([
				{
					nick: "bob",
					ident: "bob",
					host: "h.example.net",
					ip: "1.2.3.4",
					account: "acct",
					realname: "Bob B",
				},
				{
					nick: "amy",
					ident: "amy",
					host: "k.example.net",
					ip: undefined,
					account: undefined,
					realname: "Amy",
				},
			]);
		});

		it("reads a plain WHO", function () {
			expect(
				parseMembers(
					lines(":irc.test 352 me #c bob h.example.net irc.test bob H :0 Bob B"),
					"1"
				)
			).to.deep.equal([
				{nick: "bob", ident: "bob", host: "h.example.net", realname: "Bob B"},
			]);
		});
	});

	it("splits a line's address", function () {
		expect(parseAddress("bob@h.example.net")).to.deep.equal({
			ident: "bob",
			host: "h.example.net",
		});
		expect(parseAddress("@")).to.deep.equal({ident: undefined, host: undefined});
		expect(parseAddress(undefined)).to.deep.equal({});
	});

	it("names who set a ban", function () {
		expect(banSetter("alice")).to.equal("alice");
		expect(banSetter("alice!a@host")).to.equal("alice");
		expect(banSetter("*")).to.equal("");
		expect(banSetter("")).to.equal("");
	});

	describe("banAnswersQuery", function () {
		const row = {mask: "*!*@*.ip4.example.net", by: "alice"};

		it("finds words in the mask and the setter", function () {
			expect(banAnswersQuery(row, "")).to.equal(true);
			expect(banAnswersQuery(row, "ALICE")).to.equal(true);
			expect(banAnswersQuery(row, "example alice")).to.equal(true);
			expect(banAnswersQuery(row, "carol")).to.equal(false);
		});

		it("finds the ban that catches a pasted address", function () {
			expect(banAnswersQuery(row, "bob@AN-1.ip4.example.net")).to.equal(true);
			expect(banAnswersQuery(row, "bob!x@AN-1.ip4.example.net")).to.equal(true);
			expect(banAnswersQuery(row, "bob@host.other.org")).to.equal(false);
		});
	});

	it("sorts bans, those without a time as oldest", function () {
		const rows = [
			{mask: "b!*@*", by: "zed", at: 2000},
			{mask: "a!*@*", by: "amy!x@y", at: 3000},
			{mask: "c!*@*", by: ""},
		];
		const order = (sort: Parameters<typeof sortBans>[1]) =>
			sortBans(rows, sort).map((row) => row.mask[0]);

		expect(order("newest")).to.deep.equal(["a", "b", "c"]);
		expect(order("oldest")).to.deep.equal(["c", "b", "a"]);
		expect(order("mask")).to.deep.equal(["a", "b", "c"]);
		expect(order("setter")).to.deep.equal(["c", "a", "b"]);
		expect(rows[0].mask, "the list itself stays").to.equal("b!*@*");
	});

	describe("holdsChannelPower", function () {
		it("is half-op and up where there are half-ops", function () {
			const symbols = ["@", "%", "+"];
			expect(holdsChannelPower(symbols, ["@"])).to.equal(true);
			expect(holdsChannelPower(symbols, ["%", "+"])).to.equal(true);
			expect(holdsChannelPower(symbols, ["+"])).to.equal(false);
			expect(holdsChannelPower(symbols, [])).to.equal(false);
			expect(holdsChannelPower(symbols, undefined)).to.equal(false);
		});

		it("is op and up on a network without them", function () {
			expect(holdsChannelPower(["@", "+"], ["@"])).to.equal(true);
			expect(holdsChannelPower(["@", "+"], ["+"])).to.equal(false);
			expect(holdsChannelPower(["~", "&", "@", "+"], ["&"])).to.equal(true);
		});
	});

	it("puts nefarious2's extended bans in words", function () {
		expect(describeBan("*!*@host")).to.equal(undefined);
		expect(describeBan("~bob@host")).to.equal(undefined);
		expect(describeBan("~a:bob")?.kind).to.equal("account");
		expect(describeBan("~q:~a:bob")?.kind).to.equal("other");
		expect(describeBan("~q:*!*@x")?.label).to.equal("Muted");
		expect(describeBan("~!r:*bot*")?.label).to.equal("Real name");
	});
});
