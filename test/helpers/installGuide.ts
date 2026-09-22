import {expect} from "chai";
import {
	DISMISSED,
	detectInstallTarget,
	installSteps,
	shouldShowInstallGuide,
} from "../../client/js/helpers/installGuide";

const UA = {
	iphoneSafari:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	iphoneChrome:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
	iphoneFirefox:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
	ipadDesktopSite:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	androidChrome:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
	androidSamsung:
		"Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
	androidEdge:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.2592.56",
	androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
	linuxChrome:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	windowsEdge:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.56",
	macSafari:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

describe("install guide (helpers/installGuide.ts)", function () {
	describe("detectInstallTarget", function () {
		it("tells the iPhone browsers apart", function () {
			expect(detectInstallTarget({userAgent: UA.iphoneSafari})).to.include({
				os: "ios",
				browser: "safari",
				platform: "ios",
				tablet: false,
			});
			expect(detectInstallTarget({userAgent: UA.iphoneChrome})).to.include({
				browser: "chrome",
				platform: "ios",
			});
			expect(detectInstallTarget({userAgent: UA.iphoneFirefox})).to.include({
				browser: "firefox",
				platform: "ios",
			});
		});

		it("recognises an iPad that asks for the desktop site by its touch screen", function () {
			expect(
				detectInstallTarget({userAgent: UA.ipadDesktopSite, maxTouchPoints: 5})
			).to.include({os: "ios", platform: "ios", tablet: true});
			expect(detectInstallTarget({userAgent: UA.macSafari, maxTouchPoints: 0})).to.include({
				os: "mac",
				browser: "safari",
				platform: "mac-safari",
			});
		});

		it("tells the Android browsers apart", function () {
			expect(detectInstallTarget({userAgent: UA.androidChrome})).to.include({
				os: "android",
				browser: "chrome",
				platform: "android",
			});
			expect(detectInstallTarget({userAgent: UA.androidSamsung}).browser).to.equal("samsung");
			expect(detectInstallTarget({userAgent: UA.androidEdge}).browser).to.equal("edge");
			expect(detectInstallTarget({userAgent: UA.androidFirefox})).to.include({
				browser: "firefox",
				platform: "android",
			});
		});

		it("prefers the client hints brands on the desktop", function () {
			expect(
				detectInstallTarget({
					userAgent: UA.linuxChrome,
					brands: ["Not/A)Brand", "Chromium", "Google Chrome"],
				})
			).to.include({os: "linux", browser: "chrome", platform: "desktop-chromium"});
			expect(
				detectInstallTarget({
					userAgent: UA.windowsEdge,
					brands: ["Not/A)Brand", "Chromium", "Microsoft Edge"],
				})
			).to.include({os: "windows", browser: "edge", platform: "desktop-chromium"});
			// The UA alone, for a browser without client hints.
			expect(detectInstallTarget({userAgent: UA.windowsEdge}).browser).to.equal("edge");
		});

		it("has nothing for a browser that cannot install", function () {
			expect(detectInstallTarget({userAgent: UA.linuxFirefox})).to.include({
				browser: "firefox",
				platform: null,
			});
		});
	});

	describe("shouldShowInstallGuide", function () {
		it("opens for an installable browser on a fresh device", function () {
			expect(shouldShowInstallGuide({userAgent: UA.androidChrome}, null)).to.equal(true);
			expect(shouldShowInstallGuide({userAgent: UA.linuxChrome}, null)).to.equal(true);
		});

		it("stays away once dismissed, once installed, and in a native shell", function () {
			expect(shouldShowInstallGuide({userAgent: UA.androidChrome}, DISMISSED)).to.equal(
				false
			);
			expect(
				shouldShowInstallGuide({userAgent: UA.androidChrome, standalone: true}, null)
			).to.equal(false);
			expect(
				shouldShowInstallGuide({userAgent: UA.androidChrome, native: true}, null)
			).to.equal(false);
		});

		it("stays away where there is nothing to install", function () {
			expect(shouldShowInstallGuide({userAgent: UA.linuxFirefox}, null)).to.equal(false);
		});
	});

	describe("installSteps", function () {
		it("walks an iPhone through Safari's share sheet", function () {
			const steps = installSteps(
				detectInstallTarget({userAgent: UA.iphoneSafari}),
				"Seance",
				{
					canPrompt: false,
				}
			);

			expect(steps.map((s) => s.art)).to.deep.equal([
				"intro",
				"ios-share-bottom",
				"share-sheet",
				"ios-add",
			]);
			expect(steps[0].title).to.equal("Install Seance");
			expect(steps[0].action).to.equal(undefined);
			expect(steps[1].body).to.match(/bottom of the screen/);
			expect(steps[3].body).to.match(/Seance appears on your Home Screen/);
		});

		it("points at the top of the screen on an iPad and in Chrome for iOS", function () {
			const ipad = installSteps(
				detectInstallTarget({userAgent: UA.ipadDesktopSite, maxTouchPoints: 5}),
				"Seance",
				{canPrompt: false}
			);
			const chrome = installSteps(
				detectInstallTarget({userAgent: UA.iphoneChrome}),
				"Seance",
				{
					canPrompt: false,
				}
			);

			expect(ipad[1].art).to.equal("ios-share-top");
			expect(chrome[1].art).to.equal("ios-share-top");
			expect(chrome[1].body).to.match(/address bar/);
		});

		it("offers the browser's own dialog first when it is available", function () {
			const steps = installSteps(
				detectInstallTarget({userAgent: UA.androidChrome}),
				"Seance",
				{
					canPrompt: true,
				}
			);

			expect(steps[0].action).to.equal("prompt");
			expect(steps[0].note).to.be.a("string");
			expect(steps.map((s) => s.art)).to.deep.equal([
				"intro",
				"android-menu",
				"android-menu",
				"android-confirm",
			]);
			expect(steps[2].title).to.equal("Choose Install app");
		});

		it("names each Android browser's own menu entry", function () {
			const titles = (ua: string) =>
				installSteps(detectInstallTarget({userAgent: ua}), "Seance", {
					canPrompt: false,
				}).map((s) => s.title);

			expect(titles(UA.androidSamsung)[2]).to.match(/Add page to/);
			expect(titles(UA.androidEdge)[2]).to.equal("Choose Add to phone");
			expect(titles(UA.androidFirefox)[2]).to.equal("Choose Install");
		});

		it("describes the address-bar button on the desktop", function () {
			const steps = installSteps(
				detectInstallTarget({userAgent: UA.windowsEdge, brands: ["Microsoft Edge"]}),
				"Seance",
				{canPrompt: false}
			);

			expect(steps).to.have.length(3);
			expect(steps[1].art).to.equal("desktop-omnibox");
			expect(steps[1].note).to.match(/Install this site as an app/);
			expect(steps[2].body).to.match(/Start menu/);
		});

		it("sends macOS Safari to the Dock", function () {
			const steps = installSteps(detectInstallTarget({userAgent: UA.macSafari}), "Seance", {
				canPrompt: false,
			});

			expect(steps[1].title).to.match(/Add to Dock/);
			expect(steps[1].art).to.equal("mac-dock");
		});

		it("has no steps where there is nothing to install", function () {
			expect(
				installSteps(detectInstallTarget({userAgent: UA.linuxFirefox}), "Seance", {
					canPrompt: false,
				})
			).to.deep.equal([]);
		});
	});
});
