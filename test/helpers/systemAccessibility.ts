import {expect} from "chai";
import {
	fromAndroidSettings,
	onAndroidSystemStatus,
	type AndroidSystemStatus,
} from "../../client/js/helpers/systemAccessibility";

describe("systemAccessibility", function () {
	describe("fromAndroidSettings", function () {
		const defaults = {highTextContrast: 0, contrast: 0, animatorDurationScale: 1};

		it("is neither at Android's defaults", function () {
			expect(fromAndroidSettings(defaults)).to.deep.equal({
				highContrast: false,
				reduceMotion: false,
			});
		});

		it("takes High contrast text as high contrast", function () {
			expect(fromAndroidSettings({...defaults, highTextContrast: 1}).highContrast).to.equal(
				true
			);
		});

		it("takes only the top Contrast step as high contrast, as Chromium does", function () {
			expect(fromAndroidSettings({...defaults, contrast: 1}).highContrast).to.equal(true);
			expect(fromAndroidSettings({...defaults, contrast: 0.5}).highContrast).to.equal(false);
			expect(fromAndroidSettings({...defaults, contrast: -1}).highContrast).to.equal(false);
		});

		it("takes only Remove animations (scale 0) as reduced motion", function () {
			expect(
				fromAndroidSettings({...defaults, animatorDurationScale: 0}).reduceMotion
			).to.equal(true);
			expect(
				fromAndroidSettings({...defaults, animatorDurationScale: 0.5}).reduceMotion
			).to.equal(false);
		});
	});

	describe("onAndroidSystemStatus", function () {
		const g = globalThis as {window?: unknown};
		let changed: ((status: AndroidSystemStatus) => void) | null = null;
		let statusCalls = 0;
		let listenCalls = 0;
		const report: AndroidSystemStatus = {
			highTextContrast: 0,
			contrast: 0,
			animatorDurationScale: 1,
			fontScale: 1.3,
		};

		// Set and removed inside the test: mocha's leak check runs between hooks.
		function installShell() {
			g.window = {
				Capacitor: {
					isNativePlatform: () => true,
					getPlatform: () => "android",
					addListener(plugin: string, event: string, cb: typeof changed) {
						listenCalls++;
						changed = cb;
					},
					nativePromise() {
						statusCalls++;
						return Promise.resolve(report);
					},
				},
			};
		}

		it("asks the shell once and hands every reader each report", async function () {
			installShell();

			try {
				await readers();
			} finally {
				delete g.window;
			}
		});

		async function readers() {
			const first: AndroidSystemStatus[] = [];
			const second: AndroidSystemStatus[] = [];
			onAndroidSystemStatus((s) => first.push(s));
			onAndroidSystemStatus((s) => second.push(s));
			await Promise.resolve();
			await Promise.resolve();

			expect(statusCalls).to.equal(1);
			expect(listenCalls).to.equal(1);
			expect(first).to.deep.equal([report]);
			expect(second).to.deep.equal([report]);

			const next = {...report, fontScale: 1};
			changed?.(next);
			expect(first).to.deep.equal([report, next]);
			expect(second).to.deep.equal([report, next]);

			// A reader that arrives late hears the last report at once.
			const late: AndroidSystemStatus[] = [];
			onAndroidSystemStatus((s) => late.push(s));
			expect(late).to.deep.equal([next]);
			expect(statusCalls).to.equal(1);
		}
	});
});
