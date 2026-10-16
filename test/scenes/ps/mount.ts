import {expect} from "chai";
import sinon from "sinon";
import {weatherClouds} from "../../../client/js/scenes/ps/plains";
import {FADE_MARGIN_MS} from "../../../client/js/scenes/ps/layers";
import {mount, OVERCAST_FADE_MS} from "../../../client/js/scenes/ps/scene";
import type {SceneHandle} from "../../../client/js/themeScene";
import {FakeElement, FakeResizeObserver, installPage, type FakeSvg, type Page} from "./standin";

// scene.ts's mount() on the stand-in page (standin.ts).

/** Run `fn` with the fake page's globals installed and sinon's clock at a clear noon; both removed after. */
function withPage(fn: (page: Page, clock: sinon.SinonFakeTimers) => void) {
	const page = installPage();
	const clock = sinon.useFakeTimers({now: new Date(2026, 8, 25, 12, 30).getTime()});

	try {
		fn(page, clock);
	} finally {
		clock.restore();
		page.restore();
	}
}

/** Whether the scene's stepper advances the svg's clock: one tenth of a second of the fake clock. */
function moving(svg: FakeSvg, clock: sinon.SinonFakeTimers): boolean {
	const before = svg.time;
	clock.tick(100);
	return svg.time > before;
}

const mountOn = (page: Page, visible = true): SceneHandle =>
	mount(page.root as unknown as HTMLElement, {
		visible,
		attended: true,
		view: "channel",
		motion: "24",
	});

/** What a scene has left running and written, read off the stand-in page. */
function leftBehind(page: Page, clock: sinon.SinonFakeTimers) {
	return {
		observers: page.observers().filter((o) => !o.disconnected).length,
		windowListeners: page.win.all.map(([type]) => type),
		mediaListeners: page.media.flatMap((m) => m.all.map(([type]) => `${m.media} ${type}`)),
		frames: page.pendingFrames(),
		timers: clock.countTimers(),
		rootMarkup: page.root.markup.length,
		rootData: Object.keys(page.root.dataset),
		rootStyle: [...page.root.style.props.keys()],
		rootClasses: [...page.root.classList.names],
		htmlData: Object.keys(page.html.dataset),
		htmlStyle: [...page.html.style.props.keys()],
		htmlClasses: [...page.html.classList.names],
	};
}

const NOTHING = {
	observers: 0,
	windowListeners: [],
	mediaListeners: [],
	frames: 0,
	timers: 0,
	rootMarkup: 0,
	rootData: [],
	rootStyle: [],
	rootClasses: [],
	htmlData: [],
	htmlStyle: [],
	htmlClasses: [],
};

describe("ps scene: mount (scene.ts, on a stand-in page)", function () {
	describe("the yurt waits for the scene to be laid out (the boot race)", function () {
		it("places nothing while the scene has no box, and the yurt's first place once it has one", function () {
			withPage((page) => {
				const scene = mountOn(page); // ps.css not applied yet: #theme-scene is display: none
				page.frame();
				page.resize(page.column); // the column's first observation
				expect(
					page.root.style.getPropertyValue("--ps-yurt-left"),
					"nothing placed at 0"
				).to.equal("");

				page.layOut(1280);
				page.resize(page.root); // ps.css shows the scene
				expect(page.root.style.getPropertyValue("--ps-yurt-left")).to.equal(
					`${(250 + 0.72 * 850).toFixed(2)}px`
				);
				expect(page.root.classList.contains("ps-yurt-moving"), "no fade").to.equal(false);
				scene.destroy();
			});
		});

		it("clamps the last place again when the scene narrows with no column on the page", function () {
			withPage((page) => {
				const scene = mountOn(page);
				page.layOut(1280);
				page.resize(page.column);
				expect(page.root.style.getPropertyValue("--ps-yurt-left")).to.equal("862.00px");
				page.hideColumn(); // Settings
				page.layOut(990); // the window narrowed there: 990 − 133.5
				page.resize(page.root);
				expect(page.root.style.getPropertyValue("--ps-yurt-left")).to.equal("856.50px");
				scene.destroy();
			});
		});
	});

	describe("the land's round things (watchLand)", function () {
		it("writes how much the land's stretch squashes them, for ps.css to widen them back", function () {
			withPage((page) => {
				const land = new FakeElement(".ps-land");
				// a phone: 390 wide, the land 56 % of 844 tall
				land.box = {left: 0, top: 371, width: 390, height: 472.6};
				page.root.planted.set(".ps-land", land);
				const scene = mountOn(page);
				const watcher = page
					.observers()
					.find((o) => (o as FakeResizeObserver).targets.has(land)) as
					| FakeResizeObserver
					| undefined;
				expect(watcher, "the land is observed").to.not.equal(undefined);
				watcher!.callback();
				// (472.6 / 400) / (390 / 1200)
				expect(page.root.style.getPropertyValue("--ps-land-unsquash")).to.equal("3.635");
				// undone with the area kept: the square root each way
				expect(page.root.style.getPropertyValue("--ps-land-round-x")).to.equal("1.907");
				expect(page.root.style.getPropertyValue("--ps-land-round-y")).to.equal("0.524");
				scene.destroy();
				expect(watcher!.disconnected).to.equal(true);
			});
		});
	});

	describe("a mount that throws leaves nothing running", function () {
		it("runs, and a destroy leaves nothing behind (the control)", function () {
			withPage((page, clock) => {
				const scene = mountOn(page);
				const running = leftBehind(page, clock);
				expect(running.observers, "the yurt's, the composer's and the land's").to.equal(3);
				expect(running.windowListeners).to.deep.equal(["resize"]);
				expect(running.mediaListeners).to.deep.equal([
					"(prefers-reduced-motion: reduce) change",
				]);
				expect(running.timers, "the minute's tick and the stepper's frame").to.equal(2);
				expect(running.htmlData).to.have.members(["psLight", "psText"]);
				scene.destroy();
				expect(leftBehind(page, clock)).to.deep.equal(NOTHING);
			});
		});

		it("destroys what it built and rethrows when the first tick throws", function () {
			withPage((page, clock) => {
				const bad = new Error("a bad moment");
				// The moon's ellipse is written late in apply, after the observers,
				// the listeners, the gates and the weather.
				const ellipse = new FakeElement(".ps-m-ell");
				ellipse.failing = bad;
				page.root.planted.set(".ps-m-ell", ellipse);
				expect(() => mountOn(page)).to.throw(bad);
				expect(leftBehind(page, clock)).to.deep.equal(NOTHING);
			});
		});

		it("destroys what it built and rethrows when looking for the column throws", function () {
			withPage((page, clock) => {
				const bad = new Error("a bad measurement");
				page.failColumnLookup(bad);
				expect(() => mountOn(page)).to.throw(bad);
				expect(leftBehind(page, clock)).to.deep.equal(NOTHING);
			});
		});
	});

	describe("the minute's tick", function () {
		it("draws the next minute after one whose apply threw", function () {
			withPage((page, clock) => {
				const scene = mountOn(page);
				const ellipse = page.root.querySelector(".ps-m-ell");
				const writes = sinon.spy(ellipse, "setAttribute");
				ellipse.failing = new Error("a bad minute");
				expect(() => clock.tick(61000)).to.throw("a bad minute");
				expect(
					clock.countTimers(),
					"the next minute is still due, and the next frame"
				).to.equal(2);
				ellipse.failing = null;
				writes.resetHistory();
				clock.tick(61000);
				expect(writes.calledWith("rx"), "the next minute was drawn").to.equal(true);
				expect(clock.countTimers(), "the minute's tick and the frame").to.equal(2);
				scene.destroy();
			});
		});

		it("keeps ticking after a visible page's catch-up throws", function () {
			withPage((page, clock) => {
				const scene = mountOn(page, false); // mounted into a hidden page: no tick yet
				expect(clock.countTimers()).to.equal(0);
				const ellipse = page.root.querySelector(".ps-m-ell");
				ellipse.failing = new Error("a bad minute");
				expect(() =>
					scene.update({visible: true, attended: true, view: "channel", motion: "24"})
				).to.throw("a bad minute");
				expect(
					clock.countTimers(),
					"the next minute is still due, and the next frame"
				).to.equal(2);
				ellipse.failing = null;
				const writes = sinon.spy(ellipse, "setAttribute");
				clock.tick(61000);
				expect(writes.calledWith("rx")).to.equal(true);
				scene.destroy();
			});
		});
	});

	describe("the day's weather, rebuilt", function () {
		/** The overcast's sets, each as its classes and its markup. */
		const setsOf = (overcast: FakeElement) =>
			overcast.children.map((c) => ({classes: c.className, markup: c.markup}));

		/** The scene on a stand-in page whose .ps-overcast (and cloud field) the test holds. */
		const withOvercast = (page: Page) => {
			const overcast = new FakeElement(".ps-overcast");
			const field = new FakeElement(".ps-cloud-field");
			page.root.planted.set(".ps-overcast", overcast);
			page.root.planted.set(".ps-cloud-field", field);
			return {overcast, field};
		};

		it("rebuilds the weather's own clouds with the day's weather, and never the five (the user, 2026-09-26)", function () {
			withPage((page, clock) => {
				const {overcast, field} = withOvercast(page);
				const scene = mountOn(page); // 25 September: clear

				// Waking into another day: found on a page coming back into view, so at once.
				const shownOn = (date: Date) => {
					scene.update({visible: false, attended: true, view: "channel", motion: "24"});
					clock.setSystemTime(date);
					scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				};

				expect(page.root.dataset.weather).to.equal("clear");
				expect(setsOf(overcast), "a clear day adds nothing").to.deep.equal([]);

				shownOn(new Date(2026, 8, 26, 12, 30));
				expect(page.root.dataset.weather).to.equal("rain");
				expect(setsOf(overcast), "rain's four").to.deep.equal([
					{classes: "ps-overcast-set", markup: weatherClouds("rain")},
				]);
				const rainSet = overcast.children[0];

				clock.tick(60000); // the next minute, the same day: nothing rebuilt
				expect(overcast.children).to.deep.equal([rainSet]);

				shownOn(new Date(2026, 6, 19, 12, 30));
				expect(page.root.dataset.weather).to.equal("storm");
				expect(setsOf(overcast), "the storm's deck and four").to.deep.equal([
					{classes: "ps-overcast-set", markup: weatherClouds("storm")},
				]);

				shownOn(new Date(2026, 8, 25, 12, 30));
				expect(setsOf(overcast), "clear again").to.deep.equal([]);
				expect(field.markup, "the five are the mount's, never rebuilt").to.equal("");
				expect(
					clock.countTimers(),
					"the minute's tick and the frame: no fade waits"
				).to.equal(2);
				scene.destroy();
			});
		});

		describe("across local midnight in view: the weather's own clouds fade (the user dislikes clouds popping)", function () {
			it("fades the incoming set in over OVERCAST_FADE_MS: in at 0, its start computed, then the class off", function () {
				withPage((page, clock) => {
					const {overcast} = withOvercast(page);
					clock.setSystemTime(new Date(2026, 8, 25, 23, 59, 30)); // clear, before a rainy 26th
					const scene = mountOn(page);
					expect(setsOf(overcast)).to.deep.equal([]);
					page.computed.length = 0;

					clock.tick(31000); // the minute's tick at 00:00, by its own timer
					expect(page.root.dataset.weather).to.equal("rain");
					expect(setsOf(overcast)).to.deep.equal([
						{classes: "ps-overcast-set", markup: weatherClouds("rain")},
					]);
					// Its style was computed while it stood at 0, so the transition runs.
					const set = overcast.children[0];
					expect(
						page.computed.filter((c) => c.el === set).map((c) => c.classes)
					).to.deep.equal(["ps-overcast-set ps-arriving"]);
					// Nothing leaves, so nothing waits on the overcast: once the
					// gates' own fades are over (the night's skeins, grounded by the
					// rain), the minute's tick alone, and the set as it was.
					clock.tick(OVERCAST_FADE_MS + FADE_MARGIN_MS);
					expect(clock.countTimers(), "the minute's tick and the frame").to.equal(2);
					expect(overcast.children).to.deep.equal([set]);
					expect(set.className).to.equal("ps-overcast-set");
					scene.destroy();
				});
			});

			it("fades the outgoing set out and takes it out of the page once the fade is over", function () {
				withPage((page, clock) => {
					const {overcast} = withOvercast(page);
					clock.setSystemTime(new Date(2026, 8, 26, 23, 59, 30)); // rain, before a clear 27th
					const scene = mountOn(page);
					const rain = overcast.children[0];
					expect(setsOf(overcast), "the first build is at once").to.deep.equal([
						{classes: "ps-overcast-set", markup: weatherClouds("rain")},
					]);

					clock.tick(31000); // 00:00:01; the fade began at the tick, 00:00:00.020
					expect(page.root.dataset.weather).to.equal("clear");
					expect(overcast.children, "still in the page, fading").to.deep.equal([rain]);
					expect(rain.className).to.equal("ps-overcast-set ps-leaving");

					clock.tick(OVERCAST_FADE_MS + FADE_MARGIN_MS - 980 - 1);
					expect(overcast.children, "until the fade is over").to.deep.equal([rain]);
					clock.tick(2);
					expect(overcast.children, "then out of the render tree").to.deep.equal([]);
					expect(clock.countTimers(), "the minute's tick and the frame").to.equal(2);
					scene.destroy();
				});
			});

			it("fades nothing under reduced motion or in a query: the new day's clouds replace the old at once", function () {
				for (const setUp of ["reduced motion", "a query"]) {
					withPage((page, clock) => {
						const {overcast} = withOvercast(page);
						clock.setSystemTime(new Date(2026, 8, 26, 23, 59, 30));
						const scene = mountOn(page);

						if (setUp === "reduced motion") {
							page.reducedMotion().set(true);
						} else {
							scene.update({
								visible: true,
								attended: true,
								view: "query",
								motion: "24",
							});
						}

						clock.tick(31000);
						expect(page.root.dataset.weather, setUp).to.equal("clear");
						expect(setsOf(overcast), setUp).to.deep.equal([]);
						expect(clock.countTimers(), setUp).to.equal(1);

						clock.setSystemTime(new Date(2026, 8, 25, 23, 59, 30));
						scene.update({
							visible: false,
							attended: true,
							view: "channel",
							motion: "24",
						});
						scene.update({
							visible: true,
							attended: true,
							view: setUp === "a query" ? "query" : "channel",
							motion: "24",
						});
						clock.tick(31000); // into the rainy 26th
						expect(setsOf(overcast), setUp).to.deep.equal([
							{classes: "ps-overcast-set", markup: weatherClouds("rain")},
						]);
						scene.destroy();
					});
				}
			});

			it("settles a fade under way when the page is hidden, and a destroy mid-fade leaves nothing running", function () {
				withPage((page, clock) => {
					const {overcast} = withOvercast(page);
					clock.setSystemTime(new Date(2026, 8, 26, 23, 59, 30));
					const scene = mountOn(page);
					clock.tick(31000);
					expect(overcast.children).to.have.length(1);

					scene.update({visible: false, attended: true, view: "channel", motion: "24"});
					expect(overcast.children, "the leaving set, out at once").to.deep.equal([]);
					expect(clock.countTimers(), "nothing waits on a hidden page").to.equal(0);
					scene.destroy();
				});

				withPage((page, clock) => {
					withOvercast(page);
					clock.setSystemTime(new Date(2026, 8, 26, 23, 59, 30));
					const scene = mountOn(page);
					clock.tick(31000);
					scene.destroy();
					expect(leftBehind(page, clock)).to.deep.equal(NOTHING);
				});
			});
		});

		it("takes out the seeds a new day's weather built when its wind shows none (a clear 30 January, a snowy 31st)", function () {
			withPage((page, clock) => {
				// The weather layer's seeds, as its latest build made them.
				const weather = new FakeElement(".ps-weather");
				let seeds: FakeElement | null = null;
				Object.defineProperty(weather, "innerHTML", {
					set(value: string) {
						weather.markup = value;
						seeds = value.includes('class="ps-seeds"')
							? new FakeElement(".ps-seeds")
							: null;
					},
				});
				page.root.planted.set(".ps-weather", weather);
				page.root.lists.set(".ps-seeds", () => (seeds ? [seeds] : []));

				clock.setSystemTime(new Date(2026, 0, 30, 12, 30));
				const scene = mountOn(page);
				expect(page.root.dataset.weather).to.equal("clear");
				expect(seeds, "no seeds on a day without wind").to.equal(null);

				scene.update({visible: false, attended: true, view: "channel", motion: "24"});
				clock.setSystemTime(new Date(2026, 0, 31, 12, 30));
				scene.update({visible: true, attended: true, view: "channel", motion: "24"}); // waking into the next day
				expect(page.root.dataset.weather).to.equal("snow");
				expect(page.root.style.getPropertyValue("--ps-wind-op")).to.equal("0.00");
				expect(seeds, "the snow's seeds are built").to.not.equal(null);
				expect(seeds!.classList.contains("ps-off"), "and out of the render tree").to.equal(
					true
				);
				scene.destroy();
			});
		});
	});

	describe("a page nobody attends to: the scene rests", function () {
		it("stills the scene, its SVG clocks too, keeps the minute's tick, and runs again when attended", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mountOn(page);
				expect(page.root.classList.contains("ps-paused")).to.equal(false);

				scene.update({visible: true, attended: false, view: "channel", motion: "24"});
				expect(page.root.classList.contains("ps-paused"), "resting").to.equal(true);
				expect(page.root.classList.contains("ps-private"), "not frosted").to.equal(false);
				expect(!moving(svg, clock), "its SVG clocks too").to.equal(true);
				expect(clock.countTimers(), "the minute's tick keeps running").to.equal(1);
				const writes = sinon.spy(page.root.querySelector(".ps-m-ell"), "setAttribute");
				clock.tick(61000);
				expect(writes.calledWith("rx"), "the next minute was drawn").to.equal(true);
				expect(page.root.classList.contains("ps-paused")).to.equal(true);

				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(page.root.classList.contains("ps-paused"), "attended again").to.equal(false);
				expect(!moving(svg, clock)).to.equal(false);

				// Attended in a query is still a query's stillness.
				scene.update({visible: true, attended: false, view: "query", motion: "24"});
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				expect(page.root.classList.contains("ps-paused")).to.equal(true);
				expect(!moving(svg, clock)).to.equal(true);
				scene.destroy();
			});
		});

		it("steps the scene's CSS animations while it runs, and holds them while it rests", function () {
			withPage((page, clock) => {
				const anim = {
					animationName: "ps-drift", // a CSSAnimation; a CSSTransition has none
					playState: "running",
					currentTime: 0 as number | null,
					pause() {
						this.playState = "paused";
					},
					play() {
						this.playState = "running";
					},
					cancel() {
						this.playState = "idle";
					},
					addEventListener() {},
				};
				page.root.animations = [anim];
				const scene = mountOn(page);
				expect(anim.playState, "held: the stepper moves it").to.equal("paused");
				clock.tick(1000);
				expect(anim.currentTime).to.be.closeTo(1000, 1000 / 24);
				scene.update({visible: true, attended: false, view: "channel", motion: "24"});
				const held = anim.currentTime;
				clock.tick(1000);
				expect(anim.currentTime, "resting").to.equal(held);
				scene.destroy();
			});
		});

		it("holds the scene at motion off, its minute still kept, and at 60 hands it to the browser with no timer of its own", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mountOn(page);
				scene.update({visible: true, attended: true, view: "channel", motion: "off"});
				expect(page.root.classList.contains("ps-paused"), "off").to.equal(true);
				expect(svg.paused).to.equal(true);
				expect(clock.countTimers(), "the minute's tick alone").to.equal(1);
				expect(moving(svg, clock)).to.equal(false);

				scene.update({visible: true, attended: true, view: "channel", motion: "60"});
				expect(page.root.classList.contains("ps-paused"), "60").to.equal(false);
				expect(svg.paused, "the browser plays its SMIL").to.equal(false);
				expect(clock.countTimers(), "no stepper timer").to.equal(1);

				scene.update({visible: true, attended: false, view: "channel", motion: "60"});
				expect(svg.paused, "resting holds it again").to.equal(true);

				scene.update({visible: true, attended: true, view: "channel", motion: "1s"});
				expect(svg.paused).to.equal(true);
				expect(clock.countTimers(), "the minute and the second's step").to.equal(2);
				expect(moving(svg, clock), "not inside a second").to.equal(false);
				clock.tick(1000);
				expect(svg.time).to.be.above(0);
				scene.destroy();
			});
		});

		it("starts resting when mounted into a page nobody attends to", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mount(page.root as unknown as HTMLElement, {
					visible: true,
					attended: false,
					view: "channel",
					motion: "24",
				});
				expect(page.root.classList.contains("ps-paused")).to.equal(true);
				expect(!moving(svg, clock)).to.equal(true);
				scene.destroy();
			});
		});
	});

	describe("the private view: frosted and still in a query (spec §5.7)", function () {
		/** The two classes the private view is made of, on the root. */
		const state = (page: Page) =>
			["ps-private", "ps-paused"].filter((name) => page.root.classList.contains(name));

		it("frosts and stills the scene while a query is open, and a channel and every other view show it as usual", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mountOn(page);
				expect(state(page), "a channel").to.deep.equal([]);
				expect(!moving(svg, clock)).to.equal(false);

				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				expect(state(page), "a query").to.deep.equal(["ps-private", "ps-paused"]);
				expect(!moving(svg, clock), "its SVG clocks too").to.equal(true);
				expect(clock.countTimers(), "the minute's tick keeps running").to.equal(1);

				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(state(page), "back in a channel").to.deep.equal([]);
				expect(!moving(svg, clock)).to.equal(false);

				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				scene.update({visible: true, attended: true, view: "other", motion: "24"});
				expect(state(page), "Settings, Help, the connect form").to.deep.equal([]);
				expect(!moving(svg, clock)).to.equal(false);
				scene.destroy();
			});
		});

		it("keeps the colours on the hour in a query: the next minute is drawn, and the scene stays still", function () {
			withPage((page, clock) => {
				const scene = mount(page.root as unknown as HTMLElement, {
					visible: true,
					attended: true,
					view: "query",
					motion: "24",
				});
				expect(state(page)).to.deep.equal(["ps-private", "ps-paused"]);
				const writes = sinon.spy(page.root.querySelector(".ps-m-ell"), "setAttribute");
				clock.tick(61000);
				expect(writes.calledWith("rx"), "the next minute was drawn").to.equal(true);
				expect(state(page)).to.deep.equal(["ps-private", "ps-paused"]);
				scene.destroy();
			});
		});

		it("composes with a hidden page: hidden stops it and its minute, shown again in the query it stays still, and leaving the query runs it", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mountOn(page);
				scene.update({visible: true, attended: true, view: "query", motion: "24"});

				scene.update({visible: false, attended: true, view: "query", motion: "24"});
				expect(state(page), "hidden, in a query").to.deep.equal([
					"ps-private",
					"ps-paused",
				]);
				expect(!moving(svg, clock)).to.equal(true);
				expect(clock.countTimers(), "no tick on a hidden page").to.equal(0);

				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				expect(state(page), "shown again, still in the query").to.deep.equal([
					"ps-private",
					"ps-paused",
				]);
				expect(!moving(svg, clock)).to.equal(true);
				expect(clock.countTimers(), "the minute's tick again").to.equal(1);

				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(state(page), "the query left").to.deep.equal([]);
				expect(!moving(svg, clock)).to.equal(false);

				// Hidden wins over a channel as well, and a view changed while hidden is the one shown.
				scene.update({visible: false, attended: true, view: "channel", motion: "24"});
				scene.update({visible: false, attended: true, view: "query", motion: "24"});
				expect(state(page), "a query opened on a hidden page").to.deep.equal([
					"ps-private",
					"ps-paused",
				]);
				scene.update({visible: false, attended: true, view: "channel", motion: "24"});
				expect(state(page), "hidden, in a channel").to.deep.equal(["ps-paused"]);
				expect(!moving(svg, clock)).to.equal(true);
				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(state(page)).to.deep.equal([]);
				expect(!moving(svg, clock)).to.equal(false);
				scene.destroy();
			});
		});

		it("starts frosted and still when mounted into a query, hidden or shown", function () {
			for (const visible of [false, true]) {
				withPage((page, clock) => {
					const svg = page.plantSvg();
					const scene = mount(page.root as unknown as HTMLElement, {
						visible,
						view: "query",
					});
					expect(state(page), `visible ${visible}`).to.deep.equal([
						"ps-private",
						"ps-paused",
					]);
					expect(!moving(svg, clock)).to.equal(true);
					expect(clock.countTimers()).to.equal(visible ? 1 : 0);
					scene.destroy();
				});
			}
		});

		it("stays still in a query when reduced motion is lifted, and reduced motion still holds a channel", function () {
			withPage((page, clock) => {
				const svg = page.plantSvg();
				const scene = mountOn(page);
				const reduced = page.reducedMotion();
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				reduced.set(true);
				expect(state(page)).to.deep.equal(["ps-private", "ps-paused"]);
				reduced.set(false);
				expect(state(page), "lifted, in a query").to.deep.equal([
					"ps-private",
					"ps-paused",
				]);
				expect(!moving(svg, clock)).to.equal(true);

				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(state(page)).to.deep.equal([]);
				reduced.set(true);
				expect(state(page), "reduced motion, in a channel").to.deep.equal(["ps-paused"]);
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				scene.update({visible: true, attended: true, view: "channel", motion: "24"});
				expect(state(page), "reduced motion, back in a channel").to.deep.equal([
					"ps-paused",
				]);
				expect(!moving(svg, clock)).to.equal(true);
				scene.destroy();
			});
		});

		it("leaves nothing behind when destroyed in a query", function () {
			withPage((page, clock) => {
				const scene = mountOn(page);
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				scene.destroy();
				expect(leftBehind(page, clock)).to.deep.equal(NOTHING);
			});
		});

		it("publishes the same values in a query as in a channel: the frost is the stylesheet's alone", function () {
			withPage((page, clock) => {
				/** What the chrome and the scene's CSS read: <html>'s and the root's values. */
				const published = () => ({
					htmlData: {...page.html.dataset},
					htmlStyle: Object.fromEntries(page.html.style.props),
					htmlClasses: [...page.html.classList.names],
					rootStyle: Object.fromEntries(page.root.style.props),
					rootData: {...page.root.dataset, view: undefined},
				});

				let scene = mountOn(page);
				const inChannel = published();
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				expect(published(), "opening the query").to.deep.equal(inChannel);

				clock.tick(60 * 60000 + 1000); // an hour on, every minute of it drawn in the query
				const inQuery = published();
				expect(inQuery.htmlStyle, "the hour's own values").to.not.deep.equal(
					inChannel.htmlStyle
				);
				scene.destroy();
				scene = mountOn(page); // the same minute, drawn in a channel
				expect(published()).to.deep.equal(inQuery);
				scene.destroy();
			});
		});

		it("clamps the yurt by its own width, not by the box the frost's scale draws it in", function () {
			withPage((page) => {
				const scene = mountOn(page);
				page.layOut(1280);
				page.resize(page.column);
				expect(page.root.style.getPropertyValue("--ps-yurt-left")).to.equal("862.00px");
				scene.update({visible: true, attended: true, view: "query", motion: "24"});
				page.hideColumn();
				page.layOut(990);
				const yurt = page.root.querySelector(".ps-yurt");
				yurt.layoutWidth = 267;
				yurt.box = {...yurt.box, width: 267 * 1.2}; // under the frost's scale(1.2)
				page.resize(page.root);
				expect(page.root.style.getPropertyValue("--ps-yurt-left")).to.equal("856.50px");
				expect(page.root.classList.contains("ps-yurt-moving"), "no fade").to.equal(false);
				scene.destroy();
			});
		});
	});
});
