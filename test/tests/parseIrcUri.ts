import {expect} from "chai";
import parseIrcUri from "../../client/js/helpers/parseIrcUri";

describe("parseIrcUri helper", function () {
	it("should parse web+irc:// without port", function () {
		expect(parseIrcUri("web+irc://example.com")).to.deep.equal({
			tls: true,
			name: "example.com",
			host: "example.com",
			port: "443",
			join: "",
		});
	});

	it("should parse web+irc:// with port", function () {
		expect(parseIrcUri("web+irc://example.com:1337")).to.deep.equal({
			tls: true,
			name: "example.com",
			host: "example.com",
			port: "1337",
			join: "",
		});
	});

	it("should keep host and channel of a legacy irc:// link, but not its port", function () {
		const obj = {
			tls: true,
			name: "example.com",
			host: "example.com",
			port: "443",
			join: "#chan",
		};

		expect(parseIrcUri("irc://example.com:6667/#chan")).to.deep.equal(obj);
		expect(parseIrcUri("ircs://example.com:6697/#chan")).to.deep.equal(obj);
	});

	it("should not parse an unknown scheme", function () {
		expect(parseIrcUri("wirc://example.com")).to.deep.equal({});
		expect(parseIrcUri("https://example.com")).to.deep.equal({});
	});

	it("should not parse invalid port", function () {
		expect(parseIrcUri("web+irc://example.com:lol")).to.deep.equal({});
	});

	it("should not parse plus in port", function () {
		expect(parseIrcUri("web+irc://example.com:+6697")).to.deep.equal({});
	});

	it("should not channel on empty query and hash", function () {
		const obj = {
			tls: true,
			name: "example.com",
			host: "example.com",
			port: "443",
			join: "",
		};

		expect(parseIrcUri("web+irc://example.com#")).to.deep.equal(obj);
		expect(parseIrcUri("web+irc://example.com/")).to.deep.equal(obj);
		expect(parseIrcUri("web+irc://example.com/#")).to.deep.equal(obj);
	});

	it("should parse multiple channels", function () {
		const obj = {
			tls: true,
			name: "example.com",
			host: "example.com",
			port: "1337",
			join: "#channel,channel2",
		};

		expect(parseIrcUri("web+irc://example.com:1337#channel,channel2")).to.deep.equal(obj);
		expect(parseIrcUri("web+irc://example.com:1337/#channel,channel2")).to.deep.equal(obj);

		obj.join = "channel,channel2";
		expect(parseIrcUri("web+irc://example.com:1337/channel,channel2")).to.deep.equal(obj);

		obj.join = "chan,#chan2,#chan3";
		expect(parseIrcUri("web+irc://example.com:1337/chan,#chan2,#chan3")).to.deep.equal(obj);

		obj.join = "&chan,@chan2,#chan3";
		expect(parseIrcUri("web+irc://example.com:1337/&chan,@chan2,#chan3")).to.deep.equal(obj);

		// URL() drops empty hash
		obj.join = "chan";
		expect(parseIrcUri("web+irc://example.com:1337/chan#")).to.deep.equal(obj);
	});
});
