import {expect} from "chai";
import {FORMAT, MARKER_TTL_MS} from "../../client/js/sync/document";
import {
	QUIET_MS,
	REFUSED_RETRY_MS,
	RETRY_MAX_MS,
	RETRY_MS,
	SPACING_MS,
	SyncEngine,
	type Notice,
} from "../../client/js/sync/engine";
import {open, parsePointer, seal, type Pointer} from "../../client/js/sync/file";
import {readCopy} from "../../client/js/sync/state";

const HOME = "home-uuid";
const ENDPOINT = "https://files.example/filehost";
const DAY = 24 * 3600 * 1000;

/** The account's side: its pointer, the file host, and the clock every device reads. */
class Account {
	now = 1_800_000_000_000;
	pointer: string | undefined = "";
	files = new Map<string, Uint8Array>();
	uploads = 0;
	/** What the next upload is answered with instead of a 201. */
	refuse: Response | null = null;
	filehost: string | undefined = ENDPOINT;
	downloads = 0;
	/** Downloads are answered with a 500. */
	failGets = false;
	/** Where the next upload says it put the file, instead of the host's own. */
	location: string | null = null;

	fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (init?.method === "POST") {
			if (this.refuse) {
				return this.refuse;
			}

			expect((init.headers as Record<string, string>).Authorization).to.equal("Bearer token");
			const name = `https://files.example/f/${++this.uploads}`;
			this.files.set(name, new Uint8Array(await (init.body as Blob).arrayBuffer()));
			return new Response("", {status: 201, headers: {Location: this.location ?? name}});
		}

		this.downloads++;

		if (this.failGets) {
			return new Response("", {status: 500});
		}

		const bytes = this.files.get(url);
		return bytes ? new Response(bytes) : new Response("", {status: 404});
	}) as typeof fetch;

	/** The entries of the file the pointer names. */
	async entries(): Promise<Record<string, {t: number; v?: unknown}>> {
		const pointer = parsePointer(this.pointer ?? "") as Pointer;
		return (await open(this.files.get(pointer.url)!, pointer.key)).entries;
	}

	async values(): Promise<Record<string, unknown>> {
		const entries = await this.entries();
		return Object.fromEntries(
			Object.entries(entries)
				.filter(([, entry]) => "v" in entry)
				.map(([id, entry]) => [id, entry.v])
		);
	}
}

class Device {
	stored = new Map<string, string>();
	settings: Record<string, unknown> = {theme: "coffee", media: true};
	said: Notice[] = [];
	wakes: number[] = [];
	applied: string[][] = [];
	asked: string[] = [];
	answer = false;
	/** Another copy of the app on the device holds the upload lock. */
	busy = false;
	online = true;
	/** How far this device's clock runs ahead of the account's. */
	skew = 0;
	retentionDays = 30;
	/** What this copy's connection says the pointer is, where not the account's. */
	sees: (() => string | undefined) | null = null;
	token: () => Promise<string> = () => Promise.resolve("token");
	reread: () => Promise<void> = () => Promise.resolve();
	engine: SyncEngine;

	constructor(readonly server: Account, public account = "alice", stored?: Map<string, string>) {
		if (stored) {
			this.stored = stored;
		}

		const storage = {
			get: (key: string) => this.stored.get(key) ?? null,
			set: (key: string, value: string) => void this.stored.set(key, value),
			remove: (key: string) => void this.stored.delete(key),
		};
		this.engine = new SyncEngine({
			storage,
			now: () => server.now + this.skew,
			fetch: server.fetch,
			link: () =>
				this.online
					? {
							account: this.account,
							pointer: this.sees ? this.sees() : server.pointer,
							filehost: server.filehost,
							canWrite: true,
							token: () => this.token(),
							setPointer: (value) => void (server.pointer = value),
							reread: () => this.reread(),
					  }
					: null,
			context: (home) => ({
				storage,
				home,
				settings: {
					values: () => ({...this.settings}),
					defaults: () => ({theme: "coffee", media: true}),
					set: (name, value) => {
						this.settings[name] = value;
						return true;
					},
				},
			}),
			applied: (keys) => void this.applied.push(keys),
			say: (_uuid, notice) => void this.said.push(notice),
			askOtherAccount: (other) => {
				this.asked.push(other);
				return Promise.resolve(this.answer);
			},
			exclusively: (upload, wait) =>
				this.busy && !wait ? Promise.resolve(undefined) : upload(),
			wake: (ms) => void this.wakes.push(ms),
			retentionMs: () => this.retentionDays * DAY,
		});
	}

	aliases(list: Array<[string, string]>): void {
		this.stored.set(
			"thelounge.aliases",
			JSON.stringify(list.map(([name, body]) => ({name, body})))
		);
	}

	aliasNames(): string[] {
		return (JSON.parse(this.stored.get("thelounge.aliases") ?? "[]") as {name: string}[]).map(
			(alias) => alias.name
		);
	}

	async run(): Promise<void> {
		this.engine.run();
		await this.engine.settled();
	}

	async changed(): Promise<void> {
		this.engine.localChange();
		await this.engine.settled();
	}

	async enable(): Promise<void> {
		this.engine.enable(HOME, this.account);
		await this.engine.settled();
	}
}

/** Until the engine has got as far as `reached` says (an upload waiting on its token). */
async function untilAsked(reached: () => boolean): Promise<void> {
	while (!reached()) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("settings sync engine (sync/engine.ts)", function () {
	let server: Account;

	beforeEach(function () {
		server = new Account();
	});

	/** A first device with one alias and a chosen theme, uploaded. */
	async function firstDevice(): Promise<Device> {
		const a = new Device(server);
		a.settings.theme = "day";
		a.aliases([["wave", "/me waves"]]);
		await a.enable();
		server.now += QUIET_MS;
		await a.run();
		return a;
	}

	it("uploads what the first device holds that is not a default, after a quiet spell", async function () {
		const a = new Device(server);
		a.settings.theme = "day";
		a.aliases([["wave", "/me waves"]]);
		await a.enable();

		expect(server.uploads).to.equal(0);
		expect(a.wakes).to.deep.equal([QUIET_MS]);

		server.now += QUIET_MS;
		await a.run();

		expect(server.uploads).to.equal(1);
		expect(await server.values()).to.deep.equal({
			"alias:wave": {name: "wave", body: "/me waves"},
			"set:theme": "day",
		});
		expect(a.engine.state).to.include({pointer: server.pointer, dirty: false, joined: true});
	});

	it("gives every upload a fresh key and a pointer of four words", async function () {
		const a = await firstDevice();
		const first = parsePointer(server.pointer!) as Pointer;
		a.settings.media = false;
		await a.changed();
		server.now += SPACING_MS;
		await a.run();
		const second = parsePointer(server.pointer!) as Pointer;

		expect(server.pointer!.split(" ")).to.have.length(4);
		expect(second.key).to.not.equal(first.key);
		expect(second.url).to.not.equal(first.url);
		expect(second.changedAt).to.equal(server.now);
	});

	it("lets a device joining take the account's side and add what only it holds", async function () {
		await firstDevice();
		const b = new Device(server);
		b.settings.theme = "night";
		b.aliases([
			["wave", "/me waves differently"],
			["mine", "/me is here"],
		]);
		await b.enable();

		expect(b.settings.theme).to.equal("day");
		expect(JSON.parse(b.stored.get("thelounge.aliases")!)).to.deep.equal([
			{name: "wave", body: "/me waves"},
			{name: "mine", body: "/me is here"},
		]);
		expect(b.applied).to.deep.equal([["thelounge.aliases"]]);
		// Every alias sync changes is said; the one it only uploaded is not.
		expect(b.said).to.deep.equal([{kind: "alias-changed", name: "wave"}]);

		// What only it held goes up, once the account's five minutes are over.
		expect(server.uploads).to.equal(1);
		server.now += SPACING_MS;
		await b.run();

		expect(server.uploads).to.equal(2);
		expect(Object.keys(await server.values()).sort()).to.deep.equal([
			"alias:mine",
			"alias:wave",
			"set:theme",
		]);
	});

	it("carries a change to the other device, which uploads nothing back", async function () {
		const a = await firstDevice();
		const b = new Device(server);
		await b.enable();
		server.now += SPACING_MS;

		a.settings.theme = "night";
		a.aliases([
			["wave", "/me waves"],
			["new", "/me is new"],
		]);
		await a.changed();
		server.now += QUIET_MS;
		await a.run();
		const uploads = server.uploads;
		await b.run();

		expect(b.settings.theme).to.equal("night");
		expect(b.aliasNames()).to.deep.equal(["wave", "new"]);
		expect(b.said).to.deep.equal([
			{kind: "alias-added", name: "wave"},
			{kind: "alias-added", name: "new"},
		]);

		server.now += SPACING_MS;
		await b.run();
		await a.run();

		expect(server.uploads).to.equal(uploads);
		expect(b.engine.state.dirty).to.equal(false);
	});

	it("carries a removal, which stays removed on a device that still held the entry", async function () {
		const a = await firstDevice();
		const b = new Device(server);
		await b.enable();
		server.now += SPACING_MS;

		a.aliases([]);
		await a.changed();
		server.now += QUIET_MS;
		await a.run();
		await b.run();

		expect(b.aliasNames()).to.deep.equal([]);
		expect(b.said.at(-1)).to.deep.equal({kind: "alias-removed", name: "wave"});
		expect((await server.entries())["alias:wave"]).to.deep.equal({t: server.now - QUIET_MS});
	});

	it("takes the newest choice for each entry when two devices changed at once", async function () {
		const a = await firstDevice();
		const b = new Device(server);
		await b.enable();
		server.now += SPACING_MS;

		a.settings.theme = "night";
		await a.changed();
		server.now += 1000;
		b.settings.media = false;
		b.settings.theme = "morning";
		await b.changed();
		server.now += QUIET_MS;
		await a.run(); // a uploads; b has not seen it

		server.now += SPACING_MS;
		await b.run(); // b merges a's file, then uploads the merge
		await a.run();

		expect(a.settings).to.deep.equal({theme: "morning", media: false});
		expect(b.settings).to.deep.equal({theme: "morning", media: false});
		expect(a.engine.state.dirty).to.equal(false);
	});

	it("sends changes made inside five minutes together, in one upload", async function () {
		const a = await firstDevice();
		a.settings.media = false;
		await a.changed();
		server.now += QUIET_MS;
		await a.run();

		expect(server.uploads).to.equal(1);
		expect(a.wakes.at(-1)).to.equal(SPACING_MS - QUIET_MS);

		a.settings.theme = "night";
		await a.changed();
		server.now += SPACING_MS - QUIET_MS;
		await a.run();

		expect(server.uploads).to.equal(2);
		expect(await server.values()).to.include({"set:theme": "night", "set:media": false});
	});

	describe("a sync the user asked for (syncNow)", function () {
		it("uploads at once, inside the quiet spell and the spacing", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			await a.changed();

			expect(server.uploads).to.equal(1);
			expect(await a.engine.syncNow()).to.equal("sent");
			expect(server.uploads).to.equal(2);
			expect((await server.values())["set:media"]).to.equal(false);
			expect(a.engine.state.dirty).to.equal(false);
		});

		it("dates a change nothing had scanned yet", async function () {
			const a = await firstDevice();
			a.settings.media = false;

			expect(await a.engine.syncNow()).to.equal("sent");
			expect((await server.values())["set:media"]).to.equal(false);
		});

		it("uploads nothing when the device holds nothing new", async function () {
			const a = await firstDevice();

			expect(await a.engine.syncNow()).to.equal("upToDate");
			expect(server.uploads).to.equal(1);
		});

		it("takes what another device sent, without a file of its own", async function () {
			const a = await firstDevice();
			const b = new Device(server);
			await b.enable();
			a.settings.media = false;
			await a.engine.syncNow();

			expect(await b.engine.syncNow()).to.equal("upToDate");
			expect(b.settings.media).to.equal(false);
			expect(server.uploads).to.equal(2);
		});

		it("tries once when the host refuses, and leaves the retry to the timer", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			server.refuse = new Response("", {status: 429, headers: {"Retry-After": "600"}});

			expect(await a.engine.syncNow()).to.equal("failed");
			expect(a.wakes.at(-1)).to.equal(600_000);
			expect(a.engine.state.dirty).to.equal(true);

			server.refuse = null;

			expect(await a.engine.syncNow()).to.equal("sent");
			expect(server.uploads).to.equal(2);
		});

		it("says the home is not connected", async function () {
			const a = await firstDevice();
			a.online = false;

			expect(await a.engine.syncNow()).to.equal("offline");
		});

		it("reads the pointer again first", async function () {
			const a = await firstDevice();
			let asked = 0;
			a.reread = () => {
				asked++;
				return Promise.resolve();
			};
			await a.engine.syncNow();

			expect(asked).to.equal(1);
		});
	});

	it("keeps a change waiting with its time across a restart", async function () {
		const a = await firstDevice();
		a.settings.media = false;
		await a.changed();
		const dated = server.now;

		// The same storage, a new page.
		const restarted = new Device(server);
		restarted.stored = a.stored;
		Object.assign(restarted.settings, a.settings);
		server.now += SPACING_MS;
		await restarted.run();

		expect((await server.entries())["set:media"]).to.deep.equal({t: dated, v: false});
	});

	it("leaves the upload to the copy of the app that holds the lock, and looks again", async function () {
		const a = await firstDevice();
		a.busy = true; // another tab is uploading
		a.settings.media = false;
		await a.changed();
		server.now += SPACING_MS;
		await a.run();

		expect(server.uploads).to.equal(1);
		expect(a.engine.state.dirty).to.equal(true);
		expect(a.wakes.at(-1)).to.equal(QUIET_MS);

		a.busy = false;
		await a.run();

		expect(server.uploads).to.equal(2);
	});

	it("does nothing while the home is not connected, and keeps dating changes", async function () {
		const a = await firstDevice();
		a.online = false;
		a.settings.media = false;
		await a.changed();
		const dated = server.now;
		server.now += DAY;
		await a.run();

		expect(server.uploads).to.equal(1);

		a.online = true;
		await a.run();

		expect((await server.entries())["set:media"].t).to.equal(dated);
	});

	it("waits for the pointer to be read on this connection", async function () {
		const a = new Device(server);
		server.pointer = undefined;
		await a.enable();
		server.now += SPACING_MS;
		await a.run();

		expect(a.engine.state.joined).to.equal(false);
		expect(server.uploads).to.equal(0);
	});

	describe("what a device accepts", function () {
		it("ignores a pointer to anywhere but the home's file host, and says so once", async function () {
			const a = await firstDevice();
			const mine = server.pointer;
			server.pointer = `1 https://evil.example/f/1 ${"A".repeat(43)} ${server.now}`;
			server.files.set("https://evil.example/f/1", new Uint8Array(64));
			await a.run();
			await a.run();

			expect(a.said).to.deep.equal([{kind: "elsewhere"}]);
			expect(a.engine.state.pointer).to.equal(mine);
			expect(a.settings.theme).to.equal("day");

			// The next change uploads to the home's own host again.
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			await a.run();

			expect(parsePointer(server.pointer!)).to.include({url: "https://files.example/f/2"});
		});

		it("ignores a file over the size limit, and says so once", async function () {
			const a = await firstDevice();
			server.files.set("https://files.example/f/big", new Uint8Array(1024 * 1024 + 1));
			server.pointer = `1 https://files.example/f/big ${"A".repeat(43)} ${server.now}`;
			await a.run();
			await a.run();

			expect(a.said).to.deep.equal([{kind: "too-large"}]);
		});

		it("ignores a file it cannot decrypt", async function () {
			const a = await firstDevice();
			const pointer = parsePointer(server.pointer!) as Pointer;
			server.pointer = `1 ${pointer.url} ${"B".repeat(43)} ${server.now}`;
			await a.run();

			expect(a.said).to.deep.equal([{kind: "damaged"}]);
		});

		it("neither reads nor uploads past a newer format, until the app knows it", async function () {
			const a = await firstDevice();
			const newer = await seal({format: FORMAT, version: 2, entries: {}});
			server.files.set("https://files.example/f/v2", newer.bytes);
			const inside = `1 https://files.example/f/v2 ${newer.key} ${server.now}`;

			for (const value of ["2 some newer shape", inside]) {
				const d = new Device(server);
				d.stored = new Map(a.stored);
				d.settings = {...a.settings, media: false};
				server.pointer = value;
				await d.changed();
				server.now += SPACING_MS;
				await d.run();

				expect(d.said, value).to.deep.equal([{kind: "newer-version"}]);
				expect(server.pointer, value).to.equal(value);
				expect(d.engine.state.blocked, value).to.equal(true);
			}

			expect(server.uploads).to.equal(1);
		});

		it("does not upload more than the size limit, and says so once", async function () {
			const a = await firstDevice();
			let noise = "";

			while (noise.length < 1_600_000) {
				noise += Math.random().toString(36).slice(2);
			}

			a.stored.set("thelounge.oper", JSON.stringify({[HOME]: {notes: {big: noise}}}));
			await a.changed();
			server.now += SPACING_MS;
			await a.run();
			await a.run();

			expect(server.uploads).to.equal(1);
			expect(a.said).to.deep.equal([{kind: "upload-too-large"}]);

			// A change that brings it under the limit goes out.
			a.stored.delete("thelounge.oper");
			await a.changed();
			server.now += SPACING_MS;
			await a.run();

			expect(server.uploads).to.equal(2);
		});
	});

	describe("another account at the home", function () {
		it("pauses, asks once, and resumes when the first account is back", async function () {
			const a = await firstDevice();
			a.account = "bob";
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			await a.run();
			await a.run();

			expect(a.asked).to.deep.equal(["bob"]);
			expect(server.uploads).to.equal(1);
			expect(a.engine.state).to.include({account: "alice", pausedFor: "bob"});

			a.account = "Alice"; // services fold case
			await a.run();

			expect(server.uploads).to.equal(2);
			expect(a.engine.state.pausedFor).to.equal("");
		});

		it("joins the other account's file on a yes", async function () {
			const a = await firstDevice();
			const alices = server.pointer;
			// bob's account: its own pointer, nothing uploaded yet.
			a.account = "bob";
			a.answer = true;
			server.pointer = "";
			await a.run();

			expect(a.engine.state).to.include({account: "bob", joined: true, dirty: true});
			expect(alices).to.not.equal("");
		});
	});

	describe("the upload host", function () {
		it("waits out a 429 for the time it names", async function () {
			const a = new Device(server);
			a.settings.theme = "day";
			await a.enable();
			server.refuse = new Response("", {status: 429, headers: {"Retry-After": "600"}});
			server.now += QUIET_MS;
			await a.run();

			expect(a.wakes.at(-1)).to.equal(600_000);
			expect(a.said).to.deep.equal([]);

			server.refuse = null;
			server.now += 599_000;
			await a.run();

			expect(server.uploads).to.equal(0);

			server.now += 1_000;
			await a.run();

			expect(server.uploads).to.equal(1);
		});

		it("says once that the host does not take the file, and tries again later", async function () {
			const a = new Device(server);
			a.settings.theme = "day";
			await a.enable();
			server.refuse = new Response("", {status: 415});
			server.now += QUIET_MS;
			await a.run();
			server.now += REFUSED_RETRY_MS;
			await a.run();

			expect(a.said).to.deep.equal([{kind: "upload-refused", status: 415}]);

			server.refuse = null;
			server.now += REFUSED_RETRY_MS;
			await a.run();

			expect(server.uploads).to.equal(1);
			expect(a.engine.state.dirty).to.equal(false);
		});

		it("does not move the pointer when another device moved it during the upload", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			const other = await seal({
				format: FORMAT,
				version: 1,
				entries: {"set:theme": {t: server.now, v: "night"}},
			});
			const realFetch = server.fetch;
			server.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const response = await realFetch(input, init);

				if (init?.method === "POST" && server.uploads === 2) {
					// Another device's upload lands first.
					server.files.set("https://files.example/f/other", other.bytes);
					server.pointer = `1 https://files.example/f/other ${other.key} ${server.now}`;
				}

				return response;
			}) as typeof fetch;
			const b = new Device(server);
			b.stored = a.stored;
			b.settings = a.settings;
			await b.run();

			// It merged the other device's file instead, and waits its turn.
			expect(b.settings).to.deep.equal({theme: "night", media: false});
			expect(parsePointer(server.pointer!)).to.include({
				url: "https://files.example/f/other",
			});
			expect(b.engine.state.dirty).to.equal(true);
		});

		it("uploads the file again a week before the host deletes it", async function () {
			const a = await firstDevice();
			server.now += 22 * DAY;
			await a.run();

			expect(server.uploads).to.equal(1);

			server.now += DAY;
			await a.run();

			expect(server.uploads).to.equal(2);
			expect(await server.values()).to.include({"set:theme": "day"});
		});

		it("uploads again when the host no longer has the file", async function () {
			const a = await firstDevice();
			const b = new Device(server);
			b.stored = new Map(a.stored);
			b.settings = {...a.settings};
			// Another device's later upload, expired while nobody was connected.
			server.pointer = `1 https://files.example/f/expired ${"A".repeat(43)} ${server.now}`;
			server.now += 40 * DAY;
			await b.run();
			server.now += QUIET_MS;
			await b.run();

			expect(b.said).to.deep.equal([]);
			expect(server.uploads).to.equal(2);
			expect(await server.values()).to.include({"set:theme": "day"});
		});
	});

	describe("what the review of the first version found", function () {
		it("does not trade the pointer with a tab whose connection still says an older one", async function () {
			const a = await firstDevice();
			const old = server.pointer;
			a.settings.media = false;
			await a.engine.syncNow();
			// The device's second tab: the same storage, its own connection.
			const tab = new Device(server);
			tab.stored = a.stored;
			tab.settings = {...a.settings};
			tab.sees = () => old;
			server.downloads = 0;

			for (let i = 0; i < 10; i++) {
				await tab.run();
				await a.run();
			}

			expect(server.downloads).to.be.at.most(1);
			expect(a.settings.media).to.equal(false);
		});

		it("takes an entry an older build kept, once this build knows it, instead of overwriting it", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			await a.engine.syncNow();
			// An older build: it has no `media` setting.
			const b = new Device(server);
			delete b.settings.media;
			await b.enable();
			// The app is updated: the setting is there, at its default.
			b.settings.media = true;
			await b.changed();
			server.now += SPACING_MS;
			await b.run();

			expect(b.settings.media).to.equal(false);
			expect(await server.values()).to.include({"set:media": false});
		});

		it("takes the rest of a fast clock's file at once, and keeps what it dated ahead until its time", async function () {
			const a = await firstDevice();
			const b = new Device(server);
			await b.enable();
			a.skew = 3 * 60_000;
			a.settings.theme = "night";
			a.aliases([["hug", "/me hugs"]]);
			await a.engine.syncNow();
			a.skew = 0; // the clock is put right; the file still says ahead
			a.settings.media = false;
			await a.changed();
			b.settings.media = false;
			server.downloads = 0;
			b.wakes = [];
			await b.run();
			await b.run();

			// The rest is taken; the theme waits for its time, the file once.
			expect(b.aliasNames()).to.deep.equal(["wave"]);
			expect(b.settings.theme).to.equal("day");
			expect(b.wakes).to.include(2 * 60_000 + 1);
			expect(server.downloads).to.equal(1);

			// What b sends meanwhile carries the theme on as it came.
			b.settings.media = true;
			await b.changed();
			server.now += SPACING_MS;
			await b.run();

			expect(await server.values()).to.include({"set:theme": "night", "set:media": true});
			expect(b.settings.theme).to.equal("night"); // its time came meanwhile
		});

		it("takes an entry dated ahead when its time comes, and not before", async function () {
			const a = await firstDevice();
			const b = new Device(server);
			await b.enable();
			a.skew = 10 * 60_000;
			a.settings.theme = "night";
			await a.engine.syncNow();
			await b.run();

			expect(b.settings.theme).to.equal("day");

			server.now += 8 * 60_000;
			await b.run();

			expect(b.settings.theme).to.equal("day");

			server.now += 60_000 + 1;
			await b.run();

			expect(b.settings.theme).to.equal("night");
			expect(b.engine.state.dirty).to.equal(false);
		});

		it("never uploads again for a host that keeps files, and halves a short keep", async function () {
			const a = await firstDevice();
			a.retentionDays = 0;
			server.now += 40 * DAY;
			await a.run();

			expect(server.uploads).to.equal(1);

			// A host that keeps files 4 days: uploaded again after 2.
			a.retentionDays = 4;
			a.settings.media = false;
			await a.engine.syncNow();
			server.now += DAY;
			a.wakes = [];
			await a.run();
			await a.run();

			expect(server.uploads).to.equal(2);
			expect(a.wakes.at(-1)).to.equal(DAY);

			server.now += DAY;
			await a.run();

			expect(server.uploads).to.equal(3);
		});

		it("joins when the account's pointer cannot be read, without winning over a device that can read its file", async function () {
			const a = await firstDevice();
			const good = server.pointer!;
			const pointer = parsePointer(good) as Pointer;
			const bytes = server.files.get(pointer.url)!;
			server.files.set(pointer.url, new Uint8Array(64)); // a proxy's page, this once
			const b = new Device(server);
			b.settings.theme = "night";
			await b.enable();
			server.files.set(pointer.url, bytes);
			server.now += QUIET_MS;
			await b.run();

			expect(b.said).to.deep.equal([{kind: "damaged"}]);
			expect(b.engine.state.joined).to.equal(true);
			expect(server.pointer).to.not.equal(good);

			// The device that reads the account's side keeps it, and puts it back.
			await a.run();
			server.now += SPACING_MS;
			await a.run();
			await b.run();

			expect(a.settings.theme).to.equal("day");
			expect(await server.values()).to.include({"set:theme": "day"});
			expect(b.settings.theme).to.equal("day");
		});

		it("does not say up to date when the account's file could not be read", async function () {
			const a = await firstDevice();
			const b = new Device(server);
			await b.enable();
			a.settings.media = false;
			await a.engine.syncNow();
			server.failGets = true;

			expect(await b.engine.syncNow()).to.equal("failed");

			server.failGets = false;

			expect(await b.engine.syncNow()).to.equal("upToDate");
			expect(b.settings.media).to.equal(false);
		});

		it("reads a file it refused again on Sync now", async function () {
			const a = await firstDevice();
			const good = server.pointer!;
			const pointer = parsePointer(good) as Pointer;
			const bytes = server.files.get(pointer.url)!;
			server.files.set(pointer.url, new Uint8Array(64)); // a proxy's page
			server.pointer = `${good.slice(0, -1)}1`;
			const b = new Device(server);
			b.stored = new Map(a.stored);
			b.settings = {...a.settings};
			await b.run();

			expect(b.said).to.deep.equal([{kind: "damaged"}]);
			expect(await b.engine.syncNow()).to.equal("failed");

			server.files.set(pointer.url, bytes);
			server.downloads = 0;

			expect(await b.engine.syncNow()).to.equal("upToDate");
			expect(server.downloads).to.equal(1);
			expect(b.engine.state.pointer).to.equal(server.pointer);
		});

		it("starts over when sync is switched off and on during an upload", async function () {
			const a = await firstDevice();
			let release: (() => void) | null = null;
			a.token = () => new Promise((resolve) => (release = () => resolve("token")));
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			a.engine.run();
			await untilAsked(() => release !== null);
			a.engine.disable();
			a.engine.enable(HOME, "alice");
			a.token = () => Promise.resolve("token");
			release!();
			await a.engine.settled();
			server.now += SPACING_MS;
			await a.run();

			expect(a.engine.state.joined).to.equal(true);
			expect(a.engine.state.dirty).to.equal(false);
			expect(await server.values()).to.include({"set:media": false});
		});

		it("does not write one account's file into another's pointer", async function () {
			const a = await firstDevice();
			const before = server.pointer;
			let release: (() => void) | null = null;
			a.token = () => new Promise((resolve) => (release = () => resolve("token")));
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			a.engine.run();
			await untilAsked(() => release !== null);
			a.account = "bob"; // a login on the same connection
			release!();
			await a.engine.settled();

			expect(server.pointer).to.equal(before);
			expect(a.asked).to.deep.equal(["bob"]);
		});

		it("tries again later when the host answers with a URL elsewhere", async function () {
			const a = await firstDevice();
			server.location = "https://elsewhere.example/f/1";
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			a.wakes = [];
			await a.run();

			expect(a.said).to.deep.equal([{kind: "elsewhere"}]);
			expect(a.wakes.at(-1)).to.equal(REFUSED_RETRY_MS);
		});

		it("is no longer blocked by a newer format once the key is gone", async function () {
			const a = await firstDevice();
			server.pointer = "2 some newer shape";
			await a.run();

			expect(a.engine.state.blocked).to.equal(true);

			server.pointer = "";
			await a.run();
			server.now += SPACING_MS;
			await a.run();

			expect(a.engine.state.blocked).to.equal(false);
			expect(await server.values()).to.include({"set:theme": "day"});
		});

		it("does not download a newer-format file again on every run, and a new build reads it", async function () {
			const a = await firstDevice();
			const newer = await seal({format: FORMAT, version: 2, entries: {}});
			server.files.set("https://files.example/f/v2", newer.bytes);
			server.pointer = `1 https://files.example/f/v2 ${newer.key} ${server.now}`;
			server.downloads = 0;
			await a.run();
			await a.run();

			expect(server.downloads).to.equal(1);

			// The app is loaded again: the block is looked at once more.
			const restarted = new Device(server, "alice", a.stored);
			await restarted.run();

			expect(server.downloads).to.equal(2);
		});

		it("waits for the file host before it judges where a file is", async function () {
			const a = await firstDevice();
			server.filehost = undefined;
			const b = new Device(server);
			await b.enable();

			expect(b.said).to.deep.equal([]);
			expect(b.engine.state.refused).to.equal(null);

			server.filehost = ENDPOINT;
			await b.run();

			expect(b.settings.theme).to.equal("day");
			expect(a.engine.state.joined).to.equal(true);
		});

		it("waits longer each time the server keeps the pointer it had instead of ours", async function () {
			const a = await firstDevice();
			const kept = server.pointer;

			for (let i = 0; i < 7; i++) {
				a.settings.media = !a.settings.media;
				await a.changed();
				server.now += Math.max(SPACING_MS, a.engine.state.retryAt - server.now);
				const uploads = server.uploads;
				await a.run();

				expect(server.uploads, `upload ${i}`).to.equal(uploads + 1);

				server.pointer = kept; // refused: read again, the old value
				await a.run();

				expect(a.engine.state.retryAt - server.now, `wait ${i}`).to.equal(
					Math.min(RETRY_MS * 2 ** i, RETRY_MAX_MS)
				);
			}
		});

		it("does not roll the device back to a pointer a tab's connection has not heard replaced", async function () {
			const a = await firstDevice();
			const old = server.pointer;
			// The device's second tab, loaded with everything in step.
			const tab = new Device(server, "alice", a.stored);
			tab.settings = a.settings;
			await tab.run();
			a.settings.media = false;
			await a.changed();
			server.now += SPACING_MS;
			await a.run();
			tab.sees = () => old; // its connection has not heard the SET yet
			server.downloads = 0;
			await tab.run();
			server.now += SPACING_MS;
			await a.run();

			expect(a.engine.state.pointer).to.equal(server.pointer);
			expect(a.engine.state.dirty).to.equal(false);
			expect(server.downloads).to.equal(0);
			expect(server.uploads).to.equal(2);
		});

		it("does not take a fresh tab's unset for the key going, after the first upload", async function () {
			const a = await firstDevice();
			const tab = new Device(server, "alice", a.stored);
			tab.settings = a.settings;
			tab.sees = () => ""; // read before the first device's SET
			await tab.run();

			expect(a.engine.state.pointer).to.equal(server.pointer);
			expect(a.engine.state.dirty).to.equal(false);
		});

		it("starts the wait over once a write of ours stood", async function () {
			const a = await firstDevice();
			const refuse = async () => {
				const kept = server.pointer;
				a.settings.media = !a.settings.media;
				await a.changed();
				server.now += Math.max(SPACING_MS, a.engine.state.retryAt - server.now);
				await a.run();
				server.pointer = kept;
				await a.run();
				return a.engine.state.retryAt - server.now;
			};

			expect(await refuse()).to.equal(RETRY_MS);

			// The next one goes through, and stands until the one after.
			server.now += RETRY_MS;
			await a.run();
			a.settings.theme = "night";
			await a.changed();
			server.now += SPACING_MS;
			await a.run();

			expect(await refuse()).to.equal(RETRY_MS);
		});

		it("waits for another tab's upload on Sync now instead of saying it failed", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			a.busy = true; // another tab holds the lock

			expect(await a.engine.syncNow()).to.equal("sent");
		});

		it("marks what an earlier copy kept unknown, so a later build takes it", async function () {
			const a = await firstDevice();
			a.settings.media = false;
			await a.engine.syncNow();
			const b = new Device(server);
			delete b.settings.media;
			await b.enable();
			// The copy as the first version wrote it: no mark.
			const copy = JSON.parse(b.stored.get("thelounge.state.sync.entries")!);
			delete copy["set:media"].u;
			b.stored.set("thelounge.state.sync.entries", JSON.stringify(copy));
			await b.changed(); // a scan under this build, still without the setting
			b.settings.media = true; // then the update that has it
			await b.changed();

			expect(b.settings.media).to.equal(false);
		});

		it("asks once in a tab about another account, though another tab clears the pause", async function () {
			const a = await firstDevice();
			const tab = new Device(server, "alice", a.stored);
			a.account = "bob";
			await a.run();
			await tab.run();

			expect(tab.engine.state.pausedFor).to.equal("");

			await a.run();

			expect(a.asked).to.deep.equal(["bob"]);
		});
	});

	it("joins again, the account winning, after more than 90 days without syncing", async function () {
		const a = await firstDevice();
		const b = new Device(server);
		await b.enable();
		// a removed the alias long ago, and the marker has expired since.
		const later = await seal({
			format: FORMAT,
			version: 1,
			entries: {"set:theme": {t: server.now + 1000, v: "night"}},
		});
		server.now += MARKER_TTL_MS + DAY;
		server.files.set("https://files.example/f/later", later.bytes);
		server.pointer = `1 https://files.example/f/later ${later.key} ${server.now}`;
		b.settings.theme = "morning"; // undated on a device this stale
		await b.run();

		expect(b.settings.theme).to.equal("night");
		// What only the device still holds goes back up, dated now.
		expect(readCopy({get: (k) => b.stored.get(k) ?? null} as never)["alias:wave"].t).to.equal(
			server.now
		);
		expect(a.engine.state.joined).to.equal(true);
	});

	it("stops when sync is switched off, and leaves the account's file", async function () {
		const a = await firstDevice();
		const pointer = server.pointer;
		a.engine.disable();
		a.settings.media = false;
		await a.changed();
		server.now += SPACING_MS;
		await a.run();

		expect(server.pointer).to.equal(pointer);
		expect(server.uploads).to.equal(1);
		expect(a.stored.has("thelounge.state.sync.entries")).to.equal(false);
	});

	it("remembers a never across switching off", function () {
		const a = new Device(server);
		a.engine.never("some-network");
		a.engine.disable();

		expect(a.engine.state.never).to.deep.equal(["some-network"]);
	});

	it("does not undo the choice that made a store known with the entry kept unknown", async function () {
		const a = await firstDevice();
		a.stored.set(
			"thelounge.translate",
			JSON.stringify({version: 2, [`${HOME}/#chan`]: {write: "de", terms: [], once: null}})
		);
		await a.changed();
		await a.engine.syncNow();

		// b has never used translation: tr:* waits there, unknown.
		const b = new Device(server);
		await b.enable();

		// Its user picks French for #chan: the store writes its first blob.
		b.stored.set(
			"thelounge.translate",
			JSON.stringify({version: 2, [`${HOME}/#chan`]: {write: "fr", terms: [], once: null}})
		);
		await b.changed();

		const blob = JSON.parse(b.stored.get("thelounge.translate")!) as Record<
			string,
			{write: string}
		>;
		expect(blob[`${HOME}/#chan`].write).to.equal("fr");
		expect(b.engine.state.dirty).to.equal(true);
	});
});
