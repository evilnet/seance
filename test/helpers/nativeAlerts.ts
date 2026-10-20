import {expect} from "chai";
import {iosAlertId, showNativeAlert} from "../../client/js/helpers/nativeAlerts";

describe("iosAlertId", function () {
	it("is one id per conversation, whatever the case of its name", function () {
		expect(iosAlertId("net-1", "#Seance")).to.equal(iosAlertId("net-1", "#seance"));
	});

	it("tells conversations and networks apart", function () {
		const ids = new Set([
			iosAlertId("net-1", "#seance"),
			iosAlertId("net-1", "alice"),
			iosAlertId("net-2", "#seance"),
		]);
		expect(ids.size).to.equal(3);
	});

	it("is a positive 32-bit integer", function () {
		for (const target of ["#seance", "alice", "", "Ünïcødé"]) {
			const id = iosAlertId("0d3c5a8e-1111-4c2b-9d7e-5eeace0de001", target);
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
	async function onAndroid(permission: string) {
		const calls: string[] = [];
		g.window = {
			Capacitor: {
				isNativePlatform: () => true,
				getPlatform: () => "android",
				addListener() {},
				nativePromise(plugin: string, method: string) {
					calls.push(`${plugin}.${method}`);
					return Promise.resolve(method === "askPermission" ? {permission} : {});
				},
			},
		};

		try {
			return {shown: await showNativeAlert(alert), calls};
		} finally {
			delete g.window;
		}
	}

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
});
