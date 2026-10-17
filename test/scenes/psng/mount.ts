import {expect} from "chai";
import sinon from "sinon";
import {momentAt} from "../../../client/js/scenes/ps/engine";
import {sceneClasses} from "../../../client/js/scenes/ps/markup";
import {paletteAt} from "../../../client/js/scenes/ps/palette";
import {mount as mountClassic} from "../../../client/js/scenes/ps/scene";
import {mount} from "../../../client/js/scenes/psng/scene";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";
import type {SceneHandle, SceneHostState} from "../../../client/js/themeScene";
import {FakeElement, FakeSvg, installPage, type Page} from "../ps/standin";

// The NG still scene's mount() (psng/scene.ts) on classic's stand-in page (ps/standin.ts).

const SMIL = "animate, animateMotion, animateTransform, set";
const THEME_COLOR = "#3f8fe6";

/** Run `fn` with the stand-in's globals installed and sinon's clock at `at`; both removed after. */
function withPage(at: Date, fn: (page: Page, clock: sinon.SinonFakeTimers) => void) {
	const page = installPage();
	const clock = sinon.useFakeTimers({now: at.getTime()});

	try {
		fn(page, clock);
	} finally {
		clock.restore();
		page.restore();
	}
}

const state = (over: Partial<SceneHostState> = {}): SceneHostState => ({
	visible: true,
	attended: true,
	view: "channel",
	motion: "auto",
	...over,
});

const mountOn = (page: Page, over: Partial<SceneHostState> = {}): SceneHandle =>
	mount(page.root as unknown as HTMLElement, state(over));

/** An element for each selector, found by the scene's querySelectorAll. */
function plant(page: Page, ...selectors: string[]): Record<string, FakeElement> {
	const out: Record<string, FakeElement> = {};

	for (const selector of selectors) {
		const el = new FakeElement(selector);
		page.root.lists.set(selector, () => [el]);
		out[selector] = el;
	}

	return out;
}

/** What a scene has published, read off the stand-in page. */
function published(page: Page, meta: {content: string}) {
	return {
		htmlData: {...page.html.dataset},
		htmlStyle: Object.fromEntries(page.html.style.props),
		htmlClasses: [...page.html.classList.names].sort(),
		rootWeather: page.root.dataset.weather,
		rootSeason: page.root.dataset.season,
		rootStyle: Object.fromEntries(page.root.style.props),
		moon: Object.fromEntries(page.root.querySelector(".ps-m-ell").attrs),
		meta: meta.content,
	};
}

describe("ps NG scene: mount (psng/scene.ts, on a stand-in page)", function () {
	it("no animation and no SMIL: every SMIL element removed, every svg paused", function () {
		withPage(new Date(2026, 5, 21, 12, 0), (page) => {
			const smil = [new FakeElement("animate"), new FakeElement("animateTransform")];
			const removed = smil.map((el) => sinon.spy(el, "remove"));
			page.root.lists.set(SMIL, () => smil);
			const svgs = [new FakeSvg(), new FakeSvg()];
			page.root.lists.set("svg", () => svgs as unknown as FakeElement[]);
			const scene = mountOn(page);
			expect(removed.map((r) => r.called)).to.deep.equal([true, true]);
			expect(svgs.map((s) => s.paused)).to.deep.equal([true, true]);
			expect(page.root.classList.contains("psng")).to.equal(true);
			expect(page.doc.adoptedStyleSheets.map((s) => s.text)).to.deep.equal([NG_STILL_CSS]);
			scene.destroy();
		});
	});

	it("the still stylesheet holds the still rules and lifts the heat haze's filter", function () {
		expect(NG_STILL_CSS).to.contain("#theme-scene.psng * {");
		expect(NG_STILL_CSS).to.contain("animation: none !important;");
		expect(NG_STILL_CSS).to.contain("var(--cp)");
		expect(NG_STILL_CSS).to.match(/#theme-scene\.psng \.ps-ground \{\s*filter: none;?\s*\}/);
		expect(NG_STILL_CSS).to.not.match(/backdrop-filter|#sidebar|#form|\.header|\.userlist/);
	});

	it("gates without fades: at noon the stars and fireflies out, at 23:00 the sun", function () {
		withPage(new Date(2026, 5, 21, 12, 0), (page, clock) => {
			const el = plant(page, ".ps-stars", ".ps-fireflies", ".ps-sun");
			const scene = mountOn(page);
			expect(el[".ps-stars"].classList.contains("ps-off")).to.equal(true);
			expect(el[".ps-fireflies"].classList.contains("ps-off")).to.equal(true);
			expect(el[".ps-sun"].classList.contains("ps-off")).to.equal(false);
			expect(clock.countTimers(), "the minute's tick alone").to.equal(1);
			scene.destroy();
		});

		withPage(new Date(2026, 5, 21, 23, 0), (page, clock) => {
			const el = plant(page, ".ps-stars", ".ps-fireflies", ".ps-sun");
			const scene = mountOn(page);
			expect(el[".ps-sun"].classList.contains("ps-off")).to.equal(true);
			expect(el[".ps-stars"].classList.contains("ps-off")).to.equal(false);
			expect(el[".ps-fireflies"].classList.contains("ps-off")).to.equal(false);
			expect(clock.countTimers(), "the minute's tick alone").to.equal(1);
			scene.destroy();
		});
	});

	it("never hot: no ps-hot on a hot midday", function () {
		const at = new Date(2026, 5, 22, 13, 0);
		const m = momentAt(at);
		expect(sceneClasses(m, paletteAt(m))["ps-hot"], "classic would be hot").to.equal(true);
		withPage(at, (page) => {
			const scene = mountOn(page);
			expect(page.root.classList.contains("ps-hot")).to.equal(false);
			scene.destroy();
		});
	});

	for (const hour of [12, 23]) {
		it(`publishes what classic publishes (2026-06-21 ${hour}:00)`, function () {
			const at = new Date(2026, 5, 21, hour, 0);

			const run = (fn: typeof mount) => {
				let out: ReturnType<typeof published> | undefined;
				withPage(at, (page) => {
					const meta = page.plantMeta(THEME_COLOR);
					const scene = fn(page.root as unknown as HTMLElement, state());
					out = published(page, meta);
					scene.destroy();
				});
				return out!;
			};

			const ng = run(mount);
			const classic = run(mountClassic);
			expect(ng.meta).to.not.equal(THEME_COLOR);
			expect(ng).to.deep.equal(classic);
		});
	}

	it("NG then classic on the same root: classic's destroy still leaves nothing", function () {
		withPage(new Date(2026, 5, 21, 23, 0), (page, clock) => {
			const meta = page.plantMeta(THEME_COLOR);
			const root = page.root as unknown as HTMLElement;
			mount(root, state()).destroy();
			mountClassic(root, state({view: "query"})).destroy();
			expect(page.doc.adoptedStyleSheets).to.deep.equal([]);
			expect([...page.root.classList.names]).to.deep.equal([]);
			expect(page.root.markup).to.equal("");
			expect([...page.root.style.props.keys()]).to.deep.equal([]);
			expect(Object.keys(page.root.dataset)).to.deep.equal([]);
			expect(clock.countTimers()).to.equal(0);
			expect(page.observers().filter((o) => !o.disconnected)).to.have.length(0);
			expect(page.win.all).to.deep.equal([]);
			expect(page.pendingFrames()).to.equal(0);
			expect(meta.content).to.equal(THEME_COLOR);
			expect(Object.keys(page.html.dataset)).to.deep.equal([]);
			expect([...page.html.style.props.keys()]).to.deep.equal([]);
			expect([...page.html.classList.names]).to.deep.equal([]);
		});
	});

	it("ticks on the minute, not while hidden", function () {
		withPage(new Date(2026, 5, 21, 20, 30, 0), (page, clock) => {
			const scene = mountOn(page, {visible: false});
			expect(page.html.dataset.psLight, "nothing written while hidden").to.equal(undefined);
			expect(clock.countTimers()).to.equal(0);
			clock.tick(120000);
			expect(page.html.dataset.psLight).to.equal(undefined);

			scene.update(state());
			expect(page.html.dataset.psLight, "written at once").to.not.equal(undefined);
			const writes = sinon.spy(page.html.style, "setProperty");
			clock.tick(59000);
			expect(writes.calledWith("--canvas-bg-color")).to.equal(false);
			clock.tick(1100);
			expect(writes.calledWith("--canvas-bg-color"), "the next minute").to.equal(true);

			scene.update(state({visible: false}));
			expect(clock.countTimers(), "no tick while hidden").to.equal(0);
			scene.destroy();
		});
	});

	it("a query sets ps-private", function () {
		withPage(new Date(2026, 5, 21, 12, 0), (page) => {
			const scene = mountOn(page);
			expect(page.root.classList.contains("ps-private")).to.equal(false);
			scene.update(state({view: "query"}));
			expect(page.root.classList.contains("ps-private")).to.equal(true);
			scene.update(state({view: "channel"}));
			expect(page.root.classList.contains("ps-private")).to.equal(false);
			scene.destroy();
		});
	});

	it("destroy leaves nothing", function () {
		withPage(new Date(2026, 5, 21, 23, 0), (page, clock) => {
			const meta = page.plantMeta(THEME_COLOR);
			const scene = mountOn(page, {view: "query"});
			expect(page.html.dataset.psLight).to.equal("night");
			scene.destroy();
			expect(page.doc.adoptedStyleSheets).to.deep.equal([]);
			expect([...page.root.classList.names]).to.deep.equal([]);
			expect(page.root.markup).to.equal("");
			expect([...page.root.style.props.keys()]).to.deep.equal([]);
			expect(Object.keys(page.root.dataset)).to.deep.equal([]);
			expect(clock.countTimers()).to.equal(0);
			expect(page.observers().filter((o) => !o.disconnected)).to.have.length(0);
			expect(page.win.all).to.deep.equal([]);
			expect(page.pendingFrames()).to.equal(0);
			expect(meta.content).to.equal(THEME_COLOR);
			expect(Object.keys(page.html.dataset)).to.deep.equal([]);
			expect([...page.html.style.props.keys()]).to.deep.equal([]);
			expect([...page.html.classList.names]).to.deep.equal([]);
		});
	});
});
