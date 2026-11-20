import {expect} from "chai";
import {
	box,
	clipPolygon,
	depthOf,
	fill,
	project,
	ROOM_GEOMETRY,
	sprite,
	wallFrame,
} from "../../../client/js/scenes/ps/yurt";

describe("ps yurt: the room's geometry (yurt.ts, docs/projects/ps-yurt.md §5)", function () {
	it("projects the mockup's anchors in the design frame", function () {
		const near = (got: number[], want: number[]) =>
			want.forEach((w, i) => expect(got[i]).to.be.closeTo(w, 0.01));
		near(project([0, 0, 0]), [640, 669.85, 2.98]); // the stove's base
		near(project([0, 3.2, 0]), [640, 129.16]); // the crown's middle
		near(project([0, 0, 4]), [640, 518.78]); // the back wall's foot
		near(project([0.63, 0, 0]), [747.15, 669.85]); // the right post's base
	});

	it("cuts a polygon where it passes behind the eye", function () {
		const cut = clipPolygon([
			[-1, 0, -3.5],
			[1, 0, -3.5],
			[1, 0, 0],
			[-1, 0, 0],
		]);
		expect(cut).to.have.length(4);
		cut.forEach((q) => expect(depthOf(q)).to.be.at.least(ROOM_GEOMETRY.near - 1e-9));
		expect(
			clipPolygon([
				[-1, 0, -3.5],
				[1, 0, -3.5],
				[0, 0, -3.4],
			])
		).to.deep.equal([]);
	});

	it("draws only the faces turned to the eye", function () {
		const count = (s: string) => (s.match(/<polygon /g) ?? []).length;
		// Front and top.
		expect(count(box(wallFrame(0), [-0.5, 0.5], [0, 0.5], [0, 0.6], "furn"))).to.equal(2);
		// Left, top and front.
		const desk = box(wallFrame(-60), [-0.65, 0.65], [0, 0.62], [0.71, 0.75], "wood");
		expect(count(desk)).to.equal(3);
		expect(desk)
			.to.contain("ps-yt-f-left")
			.and.contain("ps-yt-f-top")
			.and.not.contain("ps-yt-f-right");
		// Left and front.
		expect(count(box(wallFrame(-82), [-0.45, 0.45], [0, 0.58], [0.08, 1.82], "furn"))).to.equal(
			2
		);
	});

	it("names colours by class, never by literal", function () {
		expect(box(wallFrame(0), [-0.5, 0.5], [0, 0.5], [0, 0.6], "furn")).to.not.match(/fill="#/);
		expect(fill("furn")).to.equal('class="ps-yt-c-furn"');
		expect(fill("furn", "top")).to.equal('class="ps-yt-c-furn ps-yt-f-top"');
	});

	it("leaves out a sprite behind the eye", function () {
		expect(sprite([0, 1, -3.2], "<i/>")).to.equal("");
	});
});
