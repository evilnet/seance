import {expect} from "chai";
import {RECENT_SPEAKERS, namesFor} from "../../client/js/translate/names";
import {stripNickPrefix} from "../../client/js/translate/spans";

describe("translate/names", () => {
	// Bug A: what the user list holds is not everyone whose name is in the
	// line. A query has no user list at all, the sender may have left, and
	// someone who spoke ten lines ago is still a name and not prose.
	it("takes the channel's user list", () => {
		expect(namesFor({users: [{nick: "ada"}, {nick: "jonas"}]})).to.deep.equal(["ada", "jonas"]);
	});

	it("takes the message's sender, even once they have left", () => {
		expect(namesFor({users: [{nick: "ada"}], sender: "gone"})).to.deep.equal(["ada", "gone"]);
	});

	it("takes a query's own target, and a channel's never", () => {
		expect(namesFor({users: [], target: "storm"})).to.deep.equal(["storm"]);
		expect(namesFor({users: [], target: "#seance"})).to.deep.equal([]);
		expect(namesFor({users: [], target: "&local"})).to.deep.equal([]);
	});

	it("takes the nicks that have recently spoken", () => {
		const names = namesFor({
			users: [{nick: "ada"}],
			messages: [{from: {nick: "gone"}}, {from: {nick: "ada"}}, {from: {}}, {}],
		});

		expect(names).to.include("gone");
		expect(names.filter((n) => n === "ada").length).to.equal(1);
	});

	it("reads the messages newest first and stops at the cap", () => {
		const messages = Array.from({length: RECENT_SPEAKERS + 10}, (_, i) => ({
			from: {nick: `n${i}`},
		}));
		const names = namesFor({users: [], messages});

		expect(names.length).to.equal(RECENT_SPEAKERS);
		expect(names).to.include(`n${messages.length - 1}`);
		expect(names).to.not.include("n0");
	});

	it("drops empties and duplicates, keeping the first spelling", () => {
		expect(
			namesFor({
				users: [{nick: "ada"}, {nick: ""}, {}, {nick: "ada"}],
				sender: "ada",
				target: null,
			})
		).to.deep.equal(["ada"]);
	});

	// Deliberate, not a side effect: the same set widens the prefix strip,
	// so `gone: hallo` from someone who has left loses the prefix a model
	// copied out of the context the way a current user's would.
	it("is the set the prefix strip is judged against as well", () => {
		expect(stripNickPrefix("gone: hallo", namesFor({users: [], sender: "gone"}))).to.equal(
			"hallo"
		);
		expect(stripNickPrefix("Moment: bitte warten", namesFor({users: []}))).to.equal(
			"Moment: bitte warten"
		);
	});
});
