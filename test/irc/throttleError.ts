import {expect} from "chai";
import {parseThrottleError} from "../../client/js/irc/handlers/error";

describe("parseThrottleError (handlers/error.ts)", function () {
	it("reads nefarious2's throttle, with no wait", function () {
		expect(
			parseThrottleError("Your host is trying to (re)connect too fast -- throttled")
		).to.deep.equal({});
		expect(
			parseThrottleError(
				"Closing Link: alice[host] (Too many connections from your host -- throttled)"
			)
		).to.deep.equal({});
	});

	it("reads the wait it names, in any of the usual spellings", function () {
		const wait = (text: string) => parseThrottleError(text)?.waitMs;
		expect(wait("too fast -- throttled (retry in 37 seconds)")).to.equal(37_000);
		expect(wait("throttled; retry in 37s")).to.equal(37_000);
		expect(wait("Throttled: wait 5 sec")).to.equal(5_000);
		expect(wait("throttled, 1 second")).to.equal(1_000);
	});

	it("ignores any other ERROR, and a number that is not seconds", function () {
		expect(
			parseThrottleError("Closing Link: alice[host] (Ping timeout: 240 seconds)")
		).to.equal(undefined);
		expect(parseThrottleError("Closing Link: (throttledness)")).to.equal(undefined);
		expect(parseThrottleError("throttled (3 connections)")).to.deep.equal({});
	});
});
