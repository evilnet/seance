import {expect} from "chai";
import {
	applyBackup,
	BackupFormatError,
	collectBackup,
	decodeBackup,
	encodeBackup,
	fileName,
	FORMAT,
	hasPasswords,
	isBackupKey,
	networkCount,
	useStorageBackend,
	VERSION,
} from "../../client/js/helpers/settingsBackup";

describe("settings backup (helpers/settingsBackup.ts)", function () {
	let store: Map<string, string>;

	beforeEach(function () {
		store = new Map<string, string>();
		useStorageBackend({
			get: (key) => store.get(key) ?? null,
			set: (key, value) => void store.set(key, value),
			remove: (key) => void store.delete(key),
			keys: () => [...store.keys()],
		});
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	function seed() {
		store.set("settings", JSON.stringify({theme: "creama", coloredNicks: false}));
		store.set(
			"thelounge.networks",
			JSON.stringify([
				{uuid: "a", host: "irc.example", saslPassword: "hunter2", rememberPassword: true},
				{uuid: "b", host: "irc.other", saslPassword: ""},
			])
		);
		store.set(
			"thelounge.ignore.a",
			JSON.stringify([{nick: "spam", ident: "*", hostname: "*", when: 1}])
		);
		store.set("thelounge.muted", JSON.stringify(["a/#x"]));
		store.set("thelounge.sts", JSON.stringify({}));
		store.set("thelounge.push", JSON.stringify({a: {}}));
		store.set("thelounge.state.lastChannel", JSON.stringify({}));
		store.set("thelounge.mentions", "[]");
	}

	async function failure(bytes: Uint8Array): Promise<unknown> {
		try {
			await decodeBackup(bytes);
		} catch (e) {
			return e;
		}

		return undefined;
	}

	it("knows which keys are preferences", function () {
		expect(isBackupKey("settings")).to.equal(true);
		expect(isBackupKey("thelounge.ignore.some-uuid")).to.equal(true);
		expect(isBackupKey("thelounge.sts")).to.equal(false);
		expect(isBackupKey("thelounge.push")).to.equal(false);
		expect(isBackupKey("thelounge.state.sidebar")).to.equal(false);
		expect(isBackupKey("thelounge.mentions")).to.equal(false);
	});

	it("collects the covered entries and nothing device-bound", function () {
		seed();
		const backup = collectBackup({app: "Seance", now: new Date("2026-09-09T10:00:00Z")});

		expect(backup.format).to.equal(FORMAT);
		expect(backup.version).to.equal(VERSION);
		expect(backup.app).to.equal("Seance");
		expect(backup.exportedAt).to.equal("2026-09-09T10:00:00.000Z");
		expect(Object.keys(backup.entries).sort()).to.deep.equal([
			"settings",
			"thelounge.ignore.a",
			"thelounge.muted",
			"thelounge.networks",
		]);
		expect(backup.entries.settings).to.deep.equal({theme: "creama", coloredNicks: false});
	});

	it("strips saved passwords unless asked to keep them", function () {
		seed();
		const stripped = collectBackup();
		const nets = stripped.entries["thelounge.networks"] as Record<string, unknown>[];

		expect(nets[0]).to.not.have.property("saslPassword");
		expect(nets[0].rememberPassword).to.equal(false);
		expect(hasPasswords(stripped)).to.equal(false);
		expect(networkCount(stripped)).to.equal(2);

		const kept = collectBackup({includePasswords: true});
		const keptNets = kept.entries["thelounge.networks"] as Record<string, unknown>[];
		expect(hasPasswords(kept)).to.equal(true);
		expect(keptNets[0].saslPassword).to.equal("hunter2");
	});

	it("takes the live settings over the stored ones", function () {
		seed();
		const backup = collectBackup({settings: {theme: "day", coloredNicks: true}});
		expect(backup.entries.settings).to.deep.equal({theme: "day", coloredNicks: true});

		store.delete("settings");
		expect(collectBackup({settings: {theme: "day"}}).entries.settings).to.deep.equal({
			theme: "day",
		});
		expect(collectBackup().entries).to.not.have.property("settings");
	});

	it("skips a corrupt entry instead of failing", function () {
		store.set("settings", "{not json");
		store.set("thelounge.muted", "[]");
		expect(Object.keys(collectBackup().entries)).to.deep.equal(["thelounge.muted"]);
	});

	it("round-trips through gzip", async function () {
		seed();
		const backup = collectBackup({includePasswords: true});
		const bytes = await encodeBackup(backup);

		expect(bytes[0]).to.equal(0x1f);
		expect(bytes[1]).to.equal(0x8b);
		expect(await decodeBackup(bytes)).to.deep.equal(backup);
	});

	it("reads a plain JSON file too", async function () {
		seed();
		const backup = collectBackup();
		const bytes = new TextEncoder().encode(JSON.stringify(backup));
		expect(await decodeBackup(bytes)).to.deep.equal(backup);
	});

	it("rejects what is not a settings file", async function () {
		const encode = (text: string) => new TextEncoder().encode(text);

		for (const text of ["hello", "{}", '{"format":"other","version":1,"entries":{}}', "[1]"]) {
			expect(await failure(encode(text)), text).to.be.instanceOf(BackupFormatError);
		}

		const newer = await failure(
			encode(JSON.stringify({format: FORMAT, version: VERSION + 1, entries: {}}))
		);
		expect(newer).to.be.instanceOf(BackupFormatError);
		expect((newer as Error).message).to.match(/newer version/);

		const damaged = await failure(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]));
		expect(damaged).to.be.instanceOf(BackupFormatError);
	});

	it("restoring replaces every covered entry and leaves the rest alone", function () {
		seed();
		applyBackup(
			{
				format: FORMAT,
				version: VERSION,
				exportedAt: "",
				entries: {
					settings: {theme: "day"},
					"thelounge.ignore.z": [],
					"thelounge.sts": {evil: true},
					"thelounge.state.sidebar": "false",
				},
			},
			"web",
			{}
		);

		expect(store.get("settings")).to.equal(JSON.stringify({theme: "day"}));
		expect(store.has("thelounge.networks")).to.equal(false);
		expect(store.has("thelounge.muted")).to.equal(false);
		expect(store.has("thelounge.ignore.a")).to.equal(false);
		expect(store.get("thelounge.ignore.z")).to.equal("[]");
		// Not covered: untouched, and a file cannot write them either.
		expect(store.get("thelounge.sts")).to.equal("{}");
		expect(store.get("thelounge.push")).to.equal(JSON.stringify({a: {}}));
		expect(store.has("thelounge.state.sidebar")).to.equal(false);
		expect(store.get("thelounge.mentions")).to.equal("[]");
	});

	describe("settings whose default depends on the platform", function () {
		const follow = {matchSystemAppearance: true, matchSystemTextSize: true};
		const dontFollow = {matchSystemAppearance: false, matchSystemTextSize: false};
		const defaults = {fontSize: "large", theme: "coffee"};

		function restored(platform: "web" | "ios" | "android" | undefined, settings: object) {
			return (target: "web" | "ios" | "android") => {
				applyBackup(
					{
						format: FORMAT,
						version: VERSION,
						exportedAt: "",
						...(platform ? {platform} : {}),
						entries: {settings: {theme: "coffee", ...settings}},
					},
					target,
					defaults
				);
				return JSON.parse(store.get("settings") ?? "null") as Record<string, unknown>;
			};
		}

		it("records where the file was made", async function () {
			const backup = collectBackup({settings: {}, platform: "ios"});
			expect(backup.platform).to.equal("ios");
			expect((await decodeBackup(await encodeBackup(backup))).platform).to.equal("ios");
		});

		it("gives a web file's defaults the shell's defaults", function () {
			expect(restored("web", dontFollow)("android")).to.deep.equal({
				theme: "coffee",
				...follow,
			});
		});

		it("gives a shell file's defaults the web's defaults", function () {
			expect(restored("ios", follow)("web")).to.deep.equal({theme: "coffee", ...dontFollow});
		});

		it("keeps a value the person chose", function () {
			expect(restored("ios", dontFollow)("android")).to.deep.equal({
				theme: "coffee",
				...dontFollow,
			});
			expect(restored("web", follow)("ios")).to.deep.equal({theme: "coffee", ...follow});
		});

		it("keeps a web file's text size and paired theme the person picked", function () {
			// Following the system would override both on the shell.
			const picked = {fontSize: "huge", theme: "creama"};
			expect(restored("web", {...dontFollow, ...picked})("ios")).to.deep.equal({
				...picked,
				...dontFollow,
			});
			expect(restored("web", {...dontFollow, fontSize: "huge"})("android")).to.deep.equal({
				theme: "coffee",
				fontSize: "huge",
				matchSystemTextSize: false,
				matchSystemAppearance: true,
			});
		});

		it("follows the system for a theme it would not change", function () {
			// gates has no light/dark partner; the default step is no choice.
			expect(
				restored("web", {...dontFollow, fontSize: "large", theme: "gates"})("ios")
			).to.deep.equal({fontSize: "large", theme: "gates", ...follow});
		});

		it("measures the theme against the restoring deploy's default", function () {
			applyBackup(
				{
					format: FORMAT,
					version: VERSION,
					exportedAt: "",
					platform: "web",
					entries: {settings: {theme: "princess", ...dontFollow}},
				},
				"ios",
				{fontSize: "large", theme: "princess"}
			);
			expect(JSON.parse(store.get("settings") ?? "null")).to.deep.equal({
				theme: "princess",
				...follow,
			});
		});

		it("keeps a shell file's setting between shells whatever it overrides", function () {
			const picked = {fontSize: "huge", theme: "creama"};
			expect(restored("ios", {...follow, ...picked})("android")).to.deep.equal({
				...picked,
				...follow,
			});
		});

		it("restores a file that does not say where it was made as it is", function () {
			expect(restored(undefined, dontFollow)("ios")).to.deep.equal({
				theme: "coffee",
				...dontFollow,
			});
			// Made before the settings existed: no key, so the migration decides.
			expect(restored(undefined, {})("ios")).to.deep.equal({theme: "coffee"});
		});
	});

	it("names the file after the deploy and the day", function () {
		expect(fileName("Seance", new Date("2026-09-09T23:00:00Z"))).to.equal(
			"seance-2026-09-09.seance-settings"
		);
		expect(fileName("AfterNET Chat!", new Date("2026-01-02T00:00:00Z"))).to.equal(
			"afternet-chat-2026-01-02.seance-settings"
		);
		expect(fileName("", new Date("2026-01-02T00:00:00Z"))).to.equal(
			"seance-2026-01-02.seance-settings"
		);
	});
});
