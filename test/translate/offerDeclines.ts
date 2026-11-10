import {expect} from "chai";
import {
	OFFER_IGNORE_REPLIES,
	answerOffer,
	forgetOfferDecline,
	ignoreOffer,
	noteReplyIn,
	offerAnswer,
	offerIgnored,
} from "../../client/js/translate/offerDeclines";

// The composer's writing offer, asked once per conversation and language
// (docs/resources/translation.md § Suggested writing). Only a tap answers;
// a draft sent past the offer is "not this time".

const NET = "offer-test-net";

describe("translate/offerDeclines", () => {
	afterEach(() => {
		forgetOfferDecline(NET, "#a");
		forgetOfferDecline(NET, "#b");
	});

	it("keeps a tap's answer per conversation and language", () => {
		answerOffer(NET, "#a", "fr", "yes");
		answerOffer(NET, "#a", "es", "no");

		expect(offerAnswer(NET, "#a", "fr")).to.equal("yes");
		expect(offerAnswer(NET, "#a", "es")).to.equal("no");
		expect(offerAnswer(NET, "#a", "de")).to.equal(undefined);
		expect(offerAnswer(NET, "#b", "fr")).to.equal(undefined);
	});

	it("sent past, an offer waits a few replies in that language, then comes back", () => {
		ignoreOffer(NET, "#a", "fr");

		expect(offerAnswer(NET, "#a", "fr"), "nothing is recorded").to.equal(undefined);

		for (let i = 0; i < OFFER_IGNORE_REPLIES; i++) {
			expect(offerIgnored(NET, "#a", "fr"), `after ${i} replies`).to.equal(true);
			noteReplyIn(NET, "#a", "fr");
		}

		expect(offerIgnored(NET, "#a", "fr")).to.equal(false);
	});

	it("a wait is for its own conversation and language", () => {
		ignoreOffer(NET, "#a", "fr");

		expect(offerIgnored(NET, "#a", "es")).to.equal(false);
		expect(offerIgnored(NET, "#b", "fr")).to.equal(false);
		noteReplyIn(NET, "#a", "es");
		expect(offerIgnored(NET, "#a", "fr")).to.equal(true);
	});

	it("Reset choices forgets the answers and the waits", () => {
		answerOffer(NET, "#a", "fr", "yes");
		ignoreOffer(NET, "#a", "es");
		forgetOfferDecline(NET, "#a");

		expect(offerAnswer(NET, "#a", "fr")).to.equal(undefined);
		expect(offerIgnored(NET, "#a", "es")).to.equal(false);
	});
});
