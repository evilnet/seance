import {expect} from "chai";
import {FORMAT, MARKER_TTL_MS} from "../../client/js/sync/document";
import {
	QUIET_MS,
	REFUSED_RETRY_MS,
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
			return new Response("", {status: 201, headers: {Location: name}});
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
	uploader = true;
	online = true;
	engine: SyncEngine;

	constructor(readonly server: Account, public account = "alice") {
		const storage = {
			get: (key: string) => this.stored.get(key) ?? null,
			set: (key: string, value: string) => void this.stored.set(key, value),
			remove: (key: string) => void this.stored.delete(key),
		};
		this.engine = new SyncEngine({
			storage,
			now: () => server.now,
			fetch: server.fetch,
			link: () =>
				this.online
					? {
							account: this.account,
							pointer: server.pointer,
							filehost: server.filehost,
							canWrite: true,
							token: () => Promise.resolve("token"),
							setPointer: (value) => void (server.pointer = value),
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
			isUploader: () => this.uploader,
			wake: (ms) => void this.wakes.push(ms),
			retentionMs: () => 30 * DAY,
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

	it("uploads from one tab of a device only", async function () {
		const a = await firstDevice();
		a.uploader = false;
		a.settings.media = false;
		await a.changed();
		server.now += SPACING_MS;
		await a.run();

		expect(server.uploads).to.equal(1);
		expect(a.engine.state.dirty).to.equal(true);

		a.uploader = true; // the lock passed on
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
});
