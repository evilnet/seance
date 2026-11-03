import {expect} from "chai";
import {MAX_THROTTLE_WAIT_MS, parseThrottleError} from "../../client/js/irc/handlers/error";

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

	it('reads the wait after "retry in", capped at five minutes', function () {
		const wait = (text: string) => parseThrottleError(text)?.waitMs;
		expect(wait("too fast -- throttled (retry in 37 seconds)")).to.equal(37_000);
		expect(wait("throttled; retry in 37s")).to.equal(37_000);
		expect(wait("Throttled: Retry in 5 sec")).to.equal(5_000);
		expect(wait("throttled (retry in 1)")).to.equal(1_000);
		expect(wait("throttled (retry in 99999 seconds)")).to.equal(MAX_THROTTLE_WAIT_MS);
	});

	it("ignores any other ERROR, and a number that is not seconds", function () {
		expect(
			parseThrottleError("Closing Link: alice[host] (Ping timeout: 240 seconds)")
		).to.equal(undefined);
		expect(parseThrottleError("Closing Link: (throttledness)")).to.equal(undefined);
		expect(parseThrottleError("throttled (3 connections)")).to.deep.equal({});
		expect(parseThrottleError("throttled: banned for 86400 seconds")).to.deep.equal({});
	});
});
