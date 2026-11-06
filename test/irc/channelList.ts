import {expect} from "chai";

import {ChannelList, listDelayOf, parseFeaturedChannels} from "../../client/js/irc/channelList";

describe("irc/channelList", function () {
	describe("parseFeaturedChannels", function () {
		it("takes a line of two spaces, a channel and a blurb", function () {
			const lines = [
				"- Welcome to the network",
				"  #help  Questions about the network",
				"  #lobby - Hang out",
				"  #news: What is new",
				"  #quiet",
				"   #indented  three spaces is not a marker",
				" #one  one space is not a marker",
				"  #help  named again, kept once",
				"  not#achannel  no prefix",
				"  #a,#b  a comma is not a channel name",
			];
			expect(parseFeaturedChannels(lines, "#&")).to.deep.equal([
				{name: "#help", blurb: "Questions about the network"},
				{name: "#lobby", blurb: "Hang out"},
				{name: "#news", blurb: "What is new"},
				{name: "#quiet", blurb: ""},
			]);
		});

		it("follows CHANTYPES", function () {
			expect(parseFeaturedChannels(["  &local  here", "  #none"], "&")).to.deep.equal([
				{name: "&local", blurb: "here"},
			]);
		});
	});

	describe("listDelayOf", function () {
		it("reads nefarious2's notice", function () {
			expect(
				listDelayOf(
					"*** You have not been connected long enough to use /list. You must wait 17 seconds before trying again."
				)
			).to.equal(17);
			expect(listDelayOf("*** Notice -- something else")).to.equal(undefined);
		});
	});

	describe("ChannelList", function () {
		it("sorts the answer by users, then name, and keeps the last answer while loading", function () {
			const list = new ChannelList();
			list.start();
			list.begin();
			list.add({name: "#b", users: 2, topic: ""});
			list.add({name: "#a", users: 2, topic: ""});
			list.add({name: "#c", users: 9, topic: ""});
			list.end(1000);
			expect(list.status).to.equal("done");
			expect(list.at).to.equal(1000);
			expect(list.rows.map((r) => r.name)).to.deep.equal(["#c", "#a", "#b"]);

			list.start();
			expect(list.status).to.equal("loading");
			expect(list.rows).to.have.length(3);
			expect(list.loaded).to.equal(0);
		});

		it("reports every PROGRESS_EVERY rows", function () {
			const list = new ChannelList();
			list.start();
			const reports: number[] = [];

			for (let i = 1; i <= 120; i++) {
				if (list.add({name: `#${i}`, users: i, topic: ""})) {
					reports.push(i);
				}
			}

			expect(reports).to.deep.equal([50, 100]);
		});

		it("a delay swallows the empty answer that follows and ends on time", function () {
			const list = new ChannelList();
			list.start();
			list.delay(30, 0);
			list.begin();
			list.end(5);
			expect(list.status).to.equal("delayed");
			expect(list.busy).to.equal(false); // delayedUntil is 30 s after epoch 0: long past
			list.delay(30);
			expect(list.busy).to.equal(true);
		});

		it("a stray 323 and a new connection leave the rows alone", function () {
			const list = new ChannelList();
			list.start();
			list.add({name: "#x", users: 1, topic: ""});
			list.end();
			list.end();
			expect(list.rows).to.have.length(1);
			list.start();
			list.reset();
			expect(list.status).to.equal("done");
			expect(list.rows).to.have.length(1);
			expect(list.loaded).to.equal(0);
		});
	});
});
