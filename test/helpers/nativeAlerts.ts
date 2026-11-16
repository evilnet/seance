import {expect} from "chai";
import {alertId, showNativeAlert} from "../../client/js/helpers/nativeAlerts";

describe("alertId", function () {
	it("is one id per conversation, whatever the case of its name", function () {
		expect(alertId("net-1", "#Seance")).to.equal(alertId("net-1", "#seance"));
	});

	it("tells conversations and networks apart", function () {
		const ids = new Set([
			alertId("net-1", "#seance"),
			alertId("net-1", "alice"),
			alertId("net-2", "#seance"),
		]);
		expect(ids.size).to.equal(3);
	});

	it("is a positive 32-bit integer", function () {
		for (const target of ["#seance", "alice", "", "Ünïcødé"]) {
			const id = alertId("0d3c5a8e-1111-4c2b-9d7e-5eeace0de001", target);
			expect(Number.isInteger(id)).to.equal(true);
			expect(id).to.be.within(1, 2 ** 31 - 1);
		}
	});
});

describe("showNativeAlert", function () {
	const g = globalThis as {window?: unknown};
	const alert = {
		network: "n1",
		target: "#chan",
		title: "alice (#chan) says:",
		body: "hi",
		sound: true,
		message: {from: "alice", text: "hi", notice: false},
	};

	// Set and removed inside the test: mocha's leak check runs between hooks.
	// A shown alert resolves as the shells do: null on Android (Tauri's
	// `invoke.resolve()`), `{}` from LocalNotifications.
	async function onShell(platform: string, permission: string, refuse?: string) {
		const calls: string[] = [];
		g.window = {
			seanceShell: {
				platform,
				listen() {},
				call(plugin: string, method: string) {
					calls.push(`${plugin}.${method}`);

					if (method === refuse) {
						return Promise.reject(
							Object.assign(new Error("refused"), {code: "failed"})
						);
					}

					if (method === "askPermission") {
						return Promise.resolve({permission});
					}

					if (method === "checkPermissions") {
						return Promise.resolve({display: permission});
					}

					return Promise.resolve(platform === "android" ? null : {});
				},
			},
		};

		try {
			return {shown: await showNativeAlert(alert), calls};
		} finally {
			delete g.window;
		}
	}

	const onAndroid = (permission: string, refuse?: string) =>
		onShell("android", permission, refuse);

	it("says it showed the alert when the permission is granted", async function () {
		expect(await onAndroid("granted")).to.deep.equal({
			shown: true,
			calls: ["NativePush.askPermission", "NativePush.show"],
		});
	});

	it("says it did not when the permission is refused or undecided, so the page can ping", async function () {
		for (const permission of ["denied", "prompt"]) {
			expect(await onAndroid(permission)).to.deep.equal({
				shown: false,
				calls: ["NativePush.askPermission"],
			});
		}
	});

	it("says it did not when the push service refuses the alert, so the page can ping", async function () {
		expect(await onAndroid("granted", "show")).to.deep.equal({
			shown: false,
			calls: ["NativePush.askPermission", "NativePush.show"],
		});
	});

	it("tells a scheduled alert from a refused one on iOS and macOS", async function () {
		for (const platform of ["ios", "macos"]) {
			expect(await onShell(platform, "granted")).to.deep.equal({
				shown: true,
				calls: ["LocalNotifications.checkPermissions", "LocalNotifications.schedule"],
			});
			expect(await onShell(platform, "granted", "schedule")).to.deep.equal({
				shown: false,
				calls: ["LocalNotifications.checkPermissions", "LocalNotifications.schedule"],
			});
		}
	});
});
