import {expect} from "chai";
import {
	isAndroidShell,
	isDesktopShell,
	isIOSShell,
	isMobileShell,
	isShell,
	nativeCall,
	NativeCallError,
	nativeInvoke,
	nativeListen,
	nativePlatform,
} from "../../client/js/helpers/shell";
import {
	currentPlatform,
	isPlatform,
	PLATFORM_DEFAULTS,
} from "../../client/js/helpers/platformDefaults";

const g = globalThis as {window?: unknown};

// Set and removed inside each test: mocha's leak check runs between hooks.
async function inWindow(win: object, fn: () => void | Promise<void>): Promise<void> {
	g.window = win;

	try {
		await fn();
	} finally {
		delete g.window;
	}
}

function capacitor(platform: string, calls: string[] = []) {
	return {
		Capacitor: {
			isNativePlatform: () => true,
			getPlatform: () => platform,
			addListener(plugin: string, event: string) {
				calls.push(`listen ${plugin}.${event}`);
			},
			nativePromise(plugin: string, method: string) {
				calls.push(`${plugin}.${method}`);
				return Promise.resolve({from: "capacitor"});
			},
		},
	};
}

function desktop(platform: string, calls: string[] = []) {
	return {
		seanceShell: {
			platform,
			version: "1.0.0",
			call(plugin: string, method: string) {
				calls.push(`${plugin}.${method}`);

				if (plugin === "App") {
					return Promise.resolve({url: "web+irc://irc.example/#seance"});
				}

				return Promise.reject({
					message: `${plugin}.${method} is not implemented`,
					code: "unimplemented",
				});
			},
			listen(plugin: string, event: string) {
				calls.push(`listen ${plugin}.${event}`);
			},
		},
	};
}

describe("the shell bridge", function () {
	it("is no shell in a browser", async function () {
		await inWindow({}, async () => {
			expect(nativePlatform()).to.equal("web");
			expect(isShell()).to.equal(false);
			expect(isMobileShell()).to.equal(false);
			expect(isDesktopShell()).to.equal(false);
			expect(await nativeCall("App", "getLaunchUrl")).to.equal(null);

			const refused = await nativeInvoke<never>("App", "getLaunchUrl").catch(
				(e: unknown) => e as NativeCallError
			);
			expect(refused).to.be.instanceOf(NativeCallError);
			expect(refused.code).to.equal("unavailable");
		});
	});

	for (const platform of ["ios", "android"]) {
		it(`reads the Capacitor bridge on ${platform}`, async function () {
			const calls: string[] = [];

			await inWindow(capacitor(platform, calls), async () => {
				expect(nativePlatform()).to.equal(platform);
				expect(isShell()).to.equal(true);
				expect(isMobileShell()).to.equal(true);
				expect(isDesktopShell()).to.equal(false);
				expect(isIOSShell()).to.equal(platform === "ios");
				expect(isAndroidShell()).to.equal(platform === "android");
				expect(await nativeCall("Badge", "set", {count: 2})).to.deep.equal({
					from: "capacitor",
				});
				nativeListen("App", "appUrlOpen", () => {});
				expect(calls).to.deep.equal(["Badge.set", "listen App.appUrlOpen"]);
			});
		});
	}

	it("is no shell when Capacitor says it runs on the web", async function () {
		await inWindow(capacitor("web"), () => {
			expect(nativePlatform()).to.equal("web");
		});
	});

	for (const platform of ["macos", "windows", "linux"]) {
		it(`reads a desktop shell on ${platform}`, async function () {
			const calls: string[] = [];

			await inWindow(desktop(platform, calls), async () => {
				expect(nativePlatform()).to.equal(platform);
				expect(isShell()).to.equal(true);
				expect(isDesktopShell()).to.equal(true);
				expect(isMobileShell()).to.equal(false);
				expect(isIOSShell()).to.equal(false);
				expect(await nativeCall("App", "getLaunchUrl")).to.deep.equal({
					url: "web+irc://irc.example/#seance",
				});
				nativeListen("App", "appUrlOpen", () => {});
				expect(calls).to.deep.equal(["App.getLaunchUrl", "listen App.appUrlOpen"]);
			});
		});
	}

	it("answers null for a plugin the desktop shell does not have", async function () {
		await inWindow(desktop("linux"), async () => {
			expect(await nativeCall("Haptics", "impact")).to.equal(null);

			const refused = await nativeInvoke<never>("Haptics", "impact").catch(
				(e: unknown) => e as NativeCallError
			);
			expect(refused).to.be.instanceOf(NativeCallError);
			expect(refused.code).to.equal("unimplemented");
			expect(refused.message).to.equal("Haptics.impact is not implemented");
		});
	});

	it("ignores a seanceShell that is not a desktop shell", async function () {
		// A bare {platform, version} with no call or listen is no bridge; and a
		// page script cannot claim to be a phone shell through this door.
		for (const shell of [
			{platform: "darwin", version: "1"},
			{...desktop("ios").seanceShell},
			{...desktop("freebsd").seanceShell},
		]) {
			await inWindow({seanceShell: shell}, () => {
				expect(nativePlatform()).to.equal("web");
			});
		}
	});

	it("prefers the Capacitor bridge when both are there", async function () {
		await inWindow({...desktop("macos"), ...capacitor("ios")}, () => {
			expect(nativePlatform()).to.equal("ios");
		});
	});
});

describe("platform defaults", function () {
	it("follows the system's appearance in every shell, its text size on the phones", async function () {
		const cases: Array<[object, string, boolean, boolean]> = [
			[{}, "web", false, false],
			[capacitor("ios"), "ios", true, true],
			[capacitor("android"), "android", true, true],
			[desktop("macos"), "macos", true, false],
			[desktop("windows"), "windows", true, false],
			[desktop("linux"), "linux", true, false],
		];

		for (const [win, platform, appearance, textSize] of cases) {
			await inWindow(win, () => {
				const p = currentPlatform();
				expect(p).to.equal(platform);
				expect(isPlatform(p)).to.equal(true);
				expect(PLATFORM_DEFAULTS.matchSystemAppearance(p), platform).to.equal(appearance);
				expect(PLATFORM_DEFAULTS.matchSystemTextSize(p), platform).to.equal(textSize);
			});
		}
	});

	it("knows the platforms a backup can name, and nothing else", function () {
		for (const p of ["web", "ios", "android", "macos", "windows", "linux"]) {
			expect(isPlatform(p), p).to.equal(true);
		}

		for (const p of ["darwin", "win32", "", null, 1]) {
			expect(isPlatform(p), String(p)).to.equal(false);
		}
	});
});
