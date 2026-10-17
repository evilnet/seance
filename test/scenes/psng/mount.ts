import {expect} from "chai";
import sinon from "sinon";
import {momentAt} from "../../../client/js/scenes/ps/engine";
import {sceneClasses} from "../../../client/js/scenes/ps/markup";
import {paletteAt} from "../../../client/js/scenes/ps/palette";
import {mount as mountClassic} from "../../../client/js/scenes/ps/scene";
import {mount} from "../../../client/js/scenes/psng/scene";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";
import type {SceneHandle, SceneHostState} from "../../../client/js/themeScene";
import {followSystemAccessibility} from "../../../client/js/helpers/systemAccessibility";
import {GROUPS} from "../../../client/js/scenes/psng/groups";
import {
	FakeElement,
	FakeSvg,
	installPage,
	routeReducedMotion,
	setReducedMotion,
	type Page,
} from "../ps/standin";

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
		// --psng-t is NG's own clock for its animations' phase, not something it publishes.
		rootStyle: Object.fromEntries([...page.root.style.props].filter(([n]) => n !== "--psng-t")),
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
		expect(NG_STILL_CSS).to.contain("#theme-scene.psng * {\n\ttransition: none !important;");
		expect(NG_STILL_CSS).to.match(
			/#theme-scene\.psng \*:not\([^{]+\{\s*animation: none !important;/
		);
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

	it("the birds: each bird's and lark's place a pose stack, the buzzard in boxes, no SMIL in their layers", function () {
		withPage(new Date(2026, 2, 5, 21, 0), (page) => {
			const scene = mountOn(page);
			const birds = /<div class="ps-skeins">[\s\S]*<div class="ps-veil"/.exec(
				page.root.markup
			)?.[0];
			expect(birds, "the bird layers in the markup").to.be.a("string");
			expect(birds).to.not.match(/<animate|<set/);
			expect(
				birds!.match(/<span class="ps-bird"[^>]*><div class="psng-pose psng-pose-0"/g)
			).to.have.length(38);
			expect(
				birds!.match(/<div class="ps-lark-bird"><div class="psng-pose psng-pose-0"/g)
			).to.have.length(3);
			expect(birds).to.contain('class="psng-buzz-orbit"');
			scene.destroy();
		});
	});

	describe("the weather layer", function () {
		/** The weather and overcast layers, planted so the test holds what the scene writes. */
		const layers = (page: Page) => {
			const weather = new FakeElement(".ps-weather");
			const overcast = new FakeElement(".ps-overcast");
			page.root.planted.set(".ps-weather", weather);
			page.root.planted.set(".ps-overcast", overcast);
			return {weather, overcast};
		};

		it("a rain day: classic's layers with the rain in tiles, no haze, no SMIL", function () {
			const at = new Date(2026, 9, 19, 12, 0);
			expect(momentAt(at).weather).to.equal("rain");
			withPage(at, (page) => {
				const {weather} = layers(page);
				const smil = new FakeElement("animate");
				const removed = sinon.spy(smil, "remove");
				weather.lists.set(SMIL, () => [smil]);
				const scene = mountOn(page);
				expect(weather.markup).to.contain('<div class="ps-rain">');
				expect(weather.markup.match(/class="psng-rain-tile"/g)).to.have.length(6);
				expect(weather.markup).to.contain('<div class="ps-seeds">');
				expect(weather.markup).to.not.match(/ps-heat|<animate|<set/);
				expect(removed.called, "SMIL stripped from the layer").to.equal(true);
				scene.destroy();
			});
		});

		it("a hot day: the heat band, never the haze", function () {
			const at = new Date(2026, 5, 22, 13, 0);
			expect(momentAt(at).weather).to.equal("heat");
			withPage(at, (page) => {
				const {weather} = layers(page);
				const scene = mountOn(page);
				expect(weather.markup).to.contain('<div class="ps-heatband"></div>');
				expect(weather.markup).to.not.match(/ps-heat-haze|ps-heat"|feTurbulence/);
				scene.destroy();
			});
		});

		it("rain into a clear day at local midnight: the rain gone in the tick that rebuilds the overcast", function () {
			const at = new Date(2026, 2, 29, 23, 58, 30);
			expect(momentAt(at).weather).to.equal("rain");
			expect(momentAt(new Date(2026, 2, 30, 0, 1)).weather).to.equal("clear");
			withPage(at, (page, clock) => {
				const {weather, overcast} = layers(page);
				const scene = mountOn(page);
				expect(weather.markup).to.contain("psng-rain-tile");
				const rebuilt = sinon.spy(overcast, "replaceChildren");
				clock.tick(60000);
				expect(weather.markup, "23:59 still rain").to.contain("psng-rain-tile");
				clock.tick(60000);
				expect(rebuilt.callCount, "the overcast rebuilt at 00:00").to.equal(1);
				expect(weather.markup, "and the rain gone with it").to.equal("");
				scene.destroy();
			});
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

	describe("motion groups", function () {
		const motionClasses = (page: Page) =>
			[...page.root.classList.names].filter(
				(n) => n.startsWith("psng-m-") || n === "psng-calm"
			);
		const all = GROUPS.map((g) => `psng-m-${g}`).sort();
		const calm = ["clouds", "smoke", "weather", "skeins", "sun"].map((g) => `psng-m-${g}`);

		// systemAccessibility() follows the first window it is given for good.
		let following = false;

		const follow = (page: Page) => {
			routeReducedMotion(page);

			if (!following) {
				following = true;
				followSystemAccessibility();
			}
		};

		it("full: every group's class, none else; unattended: none; attended again: all", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const scene = mountOn(page);
				expect(motionClasses(page).sort()).to.deep.equal(all);
				scene.update(state({attended: false}));
				expect(motionClasses(page)).to.deep.equal([]);
				scene.update(state());
				expect(motionClasses(page).sort()).to.deep.equal(all);
				scene.update(state({view: "query"}));
				expect(motionClasses(page)).to.deep.equal([]);
				scene.destroy();
			});
		});

		it("reduced motion on takes every class off, and off puts them back", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const scene = mountOn(page);
				setReducedMotion(true);

				try {
					expect(motionClasses(page)).to.deep.equal([]);
					setReducedMotion(false);
					expect(motionClasses(page).sort()).to.deep.equal(all);
				} finally {
					setReducedMotion(false);
				}

				scene.destroy();
			});
		});

		it("calm: its five and psng-calm; destroy removes every class", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const scene = mountOn(page, {motion: "calm"});
				expect(motionClasses(page).sort()).to.deep.equal([...calm, "psng-calm"].sort());
				scene.update(state({motion: "full"}));
				expect(motionClasses(page)).to.not.include("psng-calm");
				scene.update(state({motion: "calm"}));
				scene.destroy();
				expect(motionClasses(page)).to.deep.equal([]);
			});
		});

		/** The scene root's --psng-t writes and motion-class toggles, as sinon spies (their callIds order them). */
		const watch = (page: Page) => ({
			phase: sinon.spy(page.root.style, "setProperty").withArgs("--psng-t"),
			on: sinon.spy(page.root.classList, "toggle").withArgs(sinon.match(/^psng-m-/), true),
		});

		it("--psng-t: written at mount before any group class, from the mount day's midnight", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const {phase, on} = watch(page);
				const scene = mountOn(page);
				expect(phase.callCount).to.equal(1);
				expect(phase.firstCall.args[1]).to.equal(`${12 * 3600}s`);
				expect(on.called).to.equal(true);
				expect(phase.firstCall.calledBefore(on.firstCall)).to.equal(true);
				scene.destroy();
			});
		});

		it("--psng-t: once on still → full, never on full → full, calm, or the minute across midnight", function () {
			withPage(new Date(2026, 5, 21, 23, 58, 30), (page, clock) => {
				follow(page);
				const scene = mountOn(page, {attended: false});
				const {phase, on} = watch(page);
				scene.update(state());
				expect(phase.callCount, "still → full").to.equal(1);
				expect(phase.firstCall.args[1]).to.equal(`${23 * 3600 + 58 * 60 + 30}s`);
				expect(phase.firstCall.calledBefore(on.firstCall)).to.equal(true);
				scene.update(state());
				scene.update(state({motion: "calm"}));
				scene.update(state());
				clock.tick(3 * 60000);
				expect(phase.callCount, "full → full, full → calm, the ticks").to.equal(1);
				scene.update(state({attended: false}));
				scene.update(state());
				expect(phase.callCount, "the next resume").to.equal(2);
				// Past midnight, still from the mount day's: one day plus the minutes since.
				expect(parseFloat(phase.secondCall.args[1])).to.be.greaterThan(86400);
				scene.destroy();
			});
		});

		it("the near grass is wrapped once at mount, in a div.psng-sway", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const scene = mountOn(page);
				const sway = page.root.querySelector(".ps-blades").parent;
				expect(sway?.className).to.equal("psng-sway");
				scene.update(state({attended: false}));
				scene.update(state());
				expect(page.root.querySelector(".ps-blades").parent).to.equal(sway);
				scene.destroy();
			});
		});

		it("destroy stops listening for reduced motion", function () {
			withPage(new Date(2026, 5, 21, 12, 0), (page) => {
				follow(page);
				const scene = mountOn(page);
				scene.destroy();
				setReducedMotion(true);

				try {
					expect(motionClasses(page)).to.deep.equal([]);
				} finally {
					setReducedMotion(false);
				}
			});
		});

		describe("the sun's fire", function () {
			/** A planted .ps-fire canvas with a 2D context that counts its paints. */
			const plantFire = (page: Page) => {
				const paints = {n: 0};
				const canvas = new FakeElement(".ps-fire") as FakeElement & {
					getContext: () => unknown;
				};
				canvas.getContext = () => ({
					createImageData: (w: number, h: number) => ({
						data: new Uint8ClampedArray(w * h * 4),
					}),
					putImageData: () => paints.n++,
				});
				page.root.planted.set(".ps-fire", canvas);
				// The fire's pending frame requests alone: its loop's callback is named `tick`.
				const win = (globalThis as unknown as {window: Record<string, unknown>}).window;
				const ids = new Set<number>();
				const raf = win.requestAnimationFrame as (fn: () => void) => number;
				const caf = win.cancelAnimationFrame as (id: number) => void;

				win.requestAnimationFrame = (fn: () => void) => {
					const id = raf(fn);

					if (fn.name === "tick") {
						ids.add(id);
					}

					return id;
				};

				win.cancelAnimationFrame = (id: number) => {
					ids.delete(id);
					caf(id);
				};

				return Object.assign(paints, {pending: () => ids.size});
			};

			it("full at noon: one frame request is pending, painted colours; the loop is cancelled by still", function () {
				withPage(new Date(2026, 5, 21, 12, 0), (page) => {
					follow(page);
					const paints = plantFire(page);
					const scene = mountOn(page);
					expect(paints.pending()).to.equal(1);
					expect(paints.n, "the minute's colours paint a frame").to.equal(1);
					scene.update(state({attended: false}));
					expect(paints.pending()).to.equal(0);
					scene.update(state());
					expect(paints.pending()).to.equal(1);
					scene.destroy();
					expect(paints.pending(), "destroy with the loop running").to.equal(0);
				});
			});

			it("calm: one frame painted and no frame request", function () {
				withPage(new Date(2026, 5, 21, 12, 0), (page) => {
					follow(page);
					const paints = plantFire(page);
					const scene = mountOn(page, {motion: "calm"});
					expect(paints.n).to.equal(1);
					expect(paints.pending()).to.equal(0);
					scene.destroy();
				});
			});

			it("its gate off (midnight): no frame request", function () {
				withPage(new Date(2026, 5, 21, 0, 0), (page) => {
					follow(page);
					const paints = plantFire(page);
					const scene = mountOn(page);
					expect(paints.pending(), "the sun is below the horizon").to.equal(0);
					scene.destroy();
				});
			});

			it("the markup has the canvas and no #ps-s-fire", function () {
				withPage(new Date(2026, 5, 21, 12, 0), (page) => {
					follow(page);
					const scene = mountOn(page);
					expect(page.root.markup).to.include('<canvas class="ps-fire"');
					expect(page.root.markup).to.not.include("ps-s-fire");
					scene.destroy();
				});
			});
		});
	});
});
