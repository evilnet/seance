import {expect} from "chai";
import {fromOwnWorker} from "../../client/js/helpers/ownWorker";

/** A `navigator.serviceWorker` message as a worker running `scriptURL` sends it. */
function from(scriptURL: string | null): MessageEvent {
	return {data: {type: "build"}, source: scriptURL === null ? null : {scriptURL}} as MessageEvent;
}

describe("fromOwnWorker", function () {
	// GitHub Pages: the release at /seance/, develop and previews inside it.
	const RELEASE = "https://evilnet.github.io/seance/";
	const DEVELOP = "https://evilnet.github.io/seance/develop/";

	it("accepts this deploy's worker, whatever the page's route", function () {
		expect(fromOwnWorker(from(`${RELEASE}service-worker.js`), `${RELEASE}#/chan-3`)).to.equal(
			true
		);
		expect(
			fromOwnWorker(from(`${RELEASE}service-worker.js`), `${RELEASE}index.html?x=1#/net/a/b`)
		).to.equal(true);
	});

	it("refuses another deploy's worker on the same origin, in either direction", function () {
		expect(fromOwnWorker(from(`${RELEASE}service-worker.js`), `${DEVELOP}#/chan-3`)).to.equal(
			false
		);
		expect(fromOwnWorker(from(`${DEVELOP}service-worker.js`), `${RELEASE}#/chan-3`)).to.equal(
			false
		);
	});

	it("accepts a message that names no sending worker", function () {
		expect(fromOwnWorker(from(null), `${DEVELOP}#/chan-3`)).to.equal(true);
	});
});
