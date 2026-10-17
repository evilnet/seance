import {expect} from "chai";
import {renderMath} from "../../client/js/helpers/ircmessageparser/math";

// `math.ts` is Vue-free, so the KaTeX path is unit-testable: the module loads
// lazily, and everything it hands back is KaTeX's own markup. In the app it is
// `MathSpan.vue` that sets it as innerHTML — the TeX never reaches the DOM as
// anything KaTeX did not render.
describe("helpers/math — renderMath", () => {
	it("renders inline TeX to KaTeX markup", async () => {
		const html = await renderMath("E=mc^2", false);

		expect(html).to.be.a("string");
		expect(html).to.contain("katex");
		expect(html).to.not.contain("E=mc^2</script>");
	});

	it("marks a display render as display", async () => {
		const html = await renderMath("x = y", true);

		expect(html).to.be.a("string");
		expect(html).to.contain("katex-display");
	});

	it("renders a broken TeX as KaTeX error text instead of throwing", async () => {
		const html = await renderMath("\\frac{", false);

		expect(html).to.be.a("string");
		expect(html).to.contain("katex-error");
	});

	it("leaves inline TeX that asks for huge lengths as text", async () => {
		for (const tex of [
			"\\rule{1em}{5000em}",
			"\\raisebox{-3000em}{x}",
			"\\kern{-9999em}x",
			"\\rule{1cm}{5000cm}",
		]) {
			expect(await renderMath(tex, false), tex).to.equal(undefined);
		}
	});

	it("renders a tall but ordinary inline expression", async () => {
		const html = await renderMath("\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", false);

		expect(html).to.contain("katex");
	});

	it("renders nothing for empty TeX", async () => {
		expect(await renderMath("", false)).to.equal(undefined);
		expect(await renderMath("   ", true)).to.equal(undefined);
	});
});
