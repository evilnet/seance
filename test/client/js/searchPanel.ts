import {expect} from "chai";
import fs from "node:fs";
import path from "node:path";
import {
	CHAT_MIN_REM,
	roomBesideSidebar,
	SEARCH_MAX_REM,
	SEARCH_MIN_REM,
	SEARCH_SHARE,
	searchBesideWidth,
	searchFitsBeside,
} from "../../../client/js/searchPanel";

describe("search beside the chat or over it (client/js/searchPanel.ts)", function () {
	const rem = 16;

	it("is as wide beside the chat as its CSS says", function () {
		const vue = fs.readFileSync(
			path.join(__dirname, "../../../client/components/Windows/SearchResults.vue"),
			"utf8"
		);
		const basis = `clamp(${SEARCH_MIN_REM}rem, ${SEARCH_SHARE * 100}%, ${SEARCH_MAX_REM}rem)`;
		expect(vue).to.include(`flex: 0 1 ${basis};`);
	});

	it("takes a third of the window between 20rem and 30rem", function () {
		expect(searchBesideWidth(600, rem)).to.equal(320);
		expect(searchBesideWidth(1200, rem)).to.be.closeTo(408, 0.01);
		expect(searchBesideWidth(2000, rem)).to.equal(480);
		// The text size moves the ends.
		expect(searchBesideWidth(600, 20)).to.equal(400);
	});

	it("goes beside the chat only when 15rem of chat is left", function () {
		// A 1000px window, the default 220px sidebar: 780px of room.
		expect(searchFitsBeside(780, 1000, rem)).to.equal(true);
		// 760px: 540px of room, 320px of search and 220px of chat.
		expect(searchFitsBeside(540, 760, rem)).to.equal(false);
		expect(searchFitsBeside(320 + CHAT_MIN_REM * rem, 700, rem)).to.equal(true);
		expect(searchFitsBeside(320 + CHAT_MIN_REM * rem - 1, 700, rem)).to.equal(false);
	});

	it("needs more room at a larger text size", function () {
		expect(searchFitsBeside(652, 900, rem)).to.equal(true);
		expect(searchFitsBeside(652, 900, 20)).to.equal(false);
	});

	it("measures the same room beside the chat and over it, a theme's gap included", function () {
		// bourbaki: #viewport { gap: 0.5rem }. Beside, the chat, the gap and the
		// panel; covering, the chat has taken the panel's place and the gap's.
		const beside = roomBesideSidebar({chatPx: 232, panelPx: 320, gapPx: 8, covering: false});
		const over = roomBesideSidebar({chatPx: 560, panelPx: 560, gapPx: 8, covering: true});
		expect(beside).to.equal(560);
		expect(over).to.equal(beside);
		// So right at the threshold the choice holds in both layouts.
		expect(searchFitsBeside(beside, 800, rem)).to.equal(searchFitsBeside(over, 800, rem));
	});
});
