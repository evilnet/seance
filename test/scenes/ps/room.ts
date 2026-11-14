import {expect} from "chai";
import {ROOM_PIECES, roomMarkup, WINDOW_CLIPS} from "../../../client/js/scenes/ps/room";

describe("ps yurt: the room's markup (room.ts, docs/projects/ps-yurt.md §5)", function () {
	const markup = roomMarkup();

	it("is one static svg in the design frame, covering the scene around the stove", function () {
		expect(
			markup.startsWith(
				'<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice"'
			)
		).to.equal(true);
		expect(roomMarkup()).to.equal(markup); // deterministic
	});

	it("has no SMIL, prefixes every id, and defines every clip it uses", function () {
		expect(markup).to.not.match(/<(animate|animateMotion|animateTransform|set)\b/);
		const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(ids).size).to.equal(ids.length);
		ids.forEach((id) => expect(id).to.match(/^ps-yt-/));

		for (const ref of markup.matchAll(/url\(#([^)]+)\)/g)) {
			expect(ids).to.include(ref[1]);
		}

		[...WINDOW_CLIPS, "ps-yt-crown"].forEach((id) => expect(ids).to.include(id));
	});

	it("draws every piece, and colours the room by class or variable only", function () {
		ROOM_PIECES.forEach((p) => expect(markup, p).to.contain(p));
		const literal = [...markup.matchAll(/<[^>]*fill="#[^"]+"[^>]*>/g)].map((m) => m[0]);
		literal.forEach((tag) => expect(tag, tag).to.contain("ps-yt-lit"));
	});

	it("keeps the plains' classes out of the room", function () {
		expect(markup).to.not.match(/class="[^"]*\bps-(moon|sun|stars|weather|frost)\b/);
		expect(markup).to.contain("ps-m-ell").and.contain("ps-m-shape");
	});

	it("stays a reasonable size", function () {
		expect(markup.length).to.be.below(350_000);
	});
});
