import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {NO_FAKE_LAG} from "../../client/js/irc/fakelag";
import * as saved from "../../client/js/irc/saved-networks";
import {
	type CachedChannel,
	HistoryCache,
	type HistoryCacheBackend,
	MAX_AGE_MS,
	MAX_LINES,
	mergeChannel,
	SAVE_DELAY_MS,
	setHistoryCacheEnabled,
	useHistoryCacheBackend,
} from "../../client/js/irc/historycache";
import type {LoggedMsg} from "../../client/js/irc/querylog";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, type SharedMsg} from "../../shared/types/msg";

const UUID = "33333333-3333-4333-8333-333333333333";
const NOW = Date.UTC(2026, 7, 25, 12);
const fold = (s: string) => s.toLowerCase();

/** The IndexedDB backend's semantics over a Map, answering asynchronously. */
class MemoryBackend implements HistoryCacheBackend {
	data = new Map<string, CachedChannel>();

	private key(uuid: string, target: string) {
		return `${uuid}\n${target}`;
	}

	load(uuid: string): Promise<Map<string, CachedChannel>> {
		const out = new Map<string, CachedChannel>();

		for (const [key, value] of this.data) {
			if (key.startsWith(`${uuid}\n`)) {
				out.set(key.slice(uuid.length + 1), structuredClone(value));
			}
		}

		return Promise.resolve(out);
	}

	merge(uuid: string, target: string, mine: CachedChannel): Promise<void> {
		const key = this.key(uuid, target);
		this.data.set(key, mergeChannel(this.data.get(key), structuredClone(mine)));
		return Promise.resolve();
	}

	remove(uuid: string, target?: string): Promise<void> {
		for (const key of [...this.data.keys()]) {
			if (
				target === undefined ? key.startsWith(`${uuid}\n`) : key === this.key(uuid, target)
			) {
				this.data.delete(key);
			}
		}

		return Promise.resolve();
	}

	clear(): Promise<void> {
		this.data.clear();
		return Promise.resolve();
	}

	put(target: string, lines: LoggedMsg[]): void {
		this.data.set(this.key(UUID, target), {lines});
	}

	stored(target: string): CachedChannel | undefined {
		return this.data.get(this.key(UUID, target));
	}
}

function logged(n: number, text = `message ${n}`): LoggedMsg {
	return {
		msgid: `m${n}`,
		time: new Date(Date.UTC(2026, 7, 25, 11, n)).toISOString(),
		type: MessageType.MESSAGE,
		nick: "bob",
		text,
	};
}

function shared(n: number): SharedMsg {
	return {
		id: 0,
		msgid: `m${n}`,
		time: new Date(Date.UTC(2026, 7, 25, 11, n)),
		type: MessageType.MESSAGE,
		from: {nick: "bob", mode: ""},
		text: `message ${n}`,
	};
}

/** Let the backend's promises and what awaits them run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("History cache (irc/historycache.ts)", function () {
	let backend: MemoryBackend;
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		backend = new MemoryBackend();
		useHistoryCacheBackend(backend);
		clock = sinon.useFakeTimers({now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
		setHistoryCacheEnabled(true);
		useHistoryCacheBackend(null);
	});

	describe("merging", function () {
		it("keeps another tab's lines, prefers ours for the msgids we hold", function () {
			const merged = mergeChannel(
				{lines: [logged(1), logged(2, "theirs")]},
				{lines: [logged(2, "ours"), logged(3)]},
				NOW
			);
			expect(merged.lines.map((l) => [l.msgid, l.text])).to.deep.equal([
				["m1", "message 1"],
				["m2", "ours"],
				["m3", "message 3"],
			]);
		});

		it("a tombstone from either side keeps a line out", function () {
			const merged = mergeChannel(
				{lines: [logged(1), logged(2)], dead: {m1: NOW}},
				{lines: [logged(1), logged(2)], dead: {m2: NOW}},
				NOW
			);
			expect(merged.lines).to.deep.equal([]);
			expect(Object.keys(merged.dead ?? {})).to.have.members(["m1", "m2"]);
		});

		it("drops lines past the age cap and beyond the line cap", function () {
			const old: LoggedMsg = {
				...logged(0),
				time: new Date(NOW - MAX_AGE_MS - 1).toISOString(),
			};
			const many = Array.from({length: MAX_LINES + 5}, (_, i) => ({
				...logged(i),
				msgid: `n${i}`,
				time: new Date(NOW - (MAX_LINES + 5 - i) * 1000).toISOString(),
			}));
			const merged = mergeChannel(undefined, {lines: [old, ...many]}, NOW);
			expect(merged.lines).to.have.length(MAX_LINES);
			expect(merged.lines[0].msgid).to.equal("n5");
		});
	});

	describe("the cache", function () {
		it("a redaction taken before the store is read keeps the line out of what it restores", async function () {
			backend.put("#seance", [logged(1), logged(2)]);
			const cache = new HistoryCache(UUID, fold);
			cache.redact("#Seance", "m1");
			const restored = await cache.load();
			expect(restored.get("#seance")?.map((m) => m.msgid)).to.deep.equal(["m2"]);
			clock.tick(SAVE_DELAY_MS);
			await settle();
			expect(backend.stored("#seance")?.lines.map((l) => l.msgid)).to.deep.equal(["m2"]);
			cache.dispose();
		});

		it("lines past the age cap leave the disk at load, not only memory", async function () {
			const old = {...logged(1), time: new Date(NOW - MAX_AGE_MS - 1000).toISOString()};
			backend.put("#seance", [old, logged(2)]);
			const cache = new HistoryCache(UUID, fold);
			await cache.load();
			clock.tick(SAVE_DELAY_MS);
			await settle();
			expect(backend.stored("#seance")?.lines.map((l) => l.msgid)).to.deep.equal(["m2"]);
			cache.dispose();
		});

		it("a stale tab cannot write a redacted line back", async function () {
			backend.put("#seance", [logged(1)]);
			const a = new HistoryCache(UUID, fold);
			const b = new HistoryCache(UUID, fold);
			await a.load();
			await b.load();
			a.redact("#seance", "m1");
			a.flush();
			await settle();
			b.append("#seance", shared(2)); // b still holds m1 in memory
			b.flush();
			await settle();
			expect(backend.stored("#seance")?.lines.map((l) => l.msgid)).to.deep.equal(["m2"]);
			a.dispose();
			b.dispose();
		});

		it("keeps nothing without a msgid, and nothing twice", async function () {
			const cache = new HistoryCache(UUID, fold);
			await cache.load();
			cache.append("#seance", {...shared(1), msgid: undefined});
			cache.append("#seance", shared(2));
			cache.append("#seance", shared(2));
			expect(cache.lines("#seance").map((l) => l.msgid)).to.deep.equal(["m2"]);
			cache.dispose();
		});

		it("switched off: deletes everything kept and keeps nothing more", async function () {
			backend.put("#seance", [logged(1)]);
			const cache = new HistoryCache(UUID, fold);
			await cache.load();
			setHistoryCacheEnabled(false);
			await settle();
			expect(backend.data.size).to.equal(0);
			cache.append("#seance", shared(2));
			expect(cache.lines("#seance")).to.deep.equal([]);
			cache.dispose();
		});
	});
});

// ------------------------------------------------------------ with a client

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.state = "connecting";
	}

	send(line: string): void {
		this.sent.push(line);
	}

	close(): void {
		this.state = "closed";
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

class SavedBackend {
	data = new Map<string, string>();
	get(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	set(key: string, value: string): void {
		this.data.set(key, value);
	}
	remove(key: string): void {
		this.data.delete(key);
	}
}

const CAPS =
	"batch message-tags server-time echo-message labeled-response draft/chathistory=100 draft/message-redaction";

function hist(n: number): string {
	const minute = String(n).padStart(2, "0");
	return `@time=2026-08-25T11:${minute}:00.000Z;msgid=m${n} :bob!bob@host PRIVMSG #seance :message ${n}`;
}

describe("History cache in a client (irc/history.ts reconcileCached)", function () {
	let backend: MemoryBackend;
	let clock: sinon.SinonFakeTimers;
	let dispatch: sinon.SinonSpy;
	let ownsSpy = false;
	let transport: FakeTransport;
	let client: IrcClient;

	beforeEach(function () {
		backend = new MemoryBackend();
		useHistoryCacheBackend(backend);
		saved.useStorageBackend(new SavedBackend());
		saved.save({
			uuid: UUID,
			name: "",
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
		});
		clock = sinon.useFakeTimers({now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"]});
		const current = (socket as unknown as {dispatch: {isSinonProxy?: boolean}}).dispatch;

		if (current.isSinonProxy) {
			dispatch = current as unknown as sinon.SinonSpy;
			ownsSpy = false;
		} else {
			dispatch = sinon.spy(socket, "dispatch");
			ownsSpy = true;
		}
	});

	afterEach(function () {
		client?.historyCache.dispose();
		clock.restore();

		if (ownsSpy) {
			dispatch.restore();
		}

		socket.removeAllListeners();
		useHistoryCacheBackend(null);
		saved.useStorageBackend(null);
	});

	function payloads<T>(event: string): T[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	/** Connect and register; the cache's restore runs alongside. */
	async function start(): Promise<void> {
		transport = new FakeTransport();
		client = new IrcClient({
			uuid: UUID,
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			transportFactory: () => transport,
			highlights: () => ({keywords: [], exceptions: []}),
			fakeLag: NO_FAKE_LAG,
		});
		registerBusHandlers(socket, {
			clientForChannel: (id) => (client.channelById(id) ? client : undefined),
			clientForNetwork: (uuid) => (uuid === client.uuid ? client : undefined),
			allClients: () => [client],
			createNetwork: () => client,
			remove: () => undefined,
		});
		client.connect();
		transport.open();
		transport.line(`:irc.test CAP * LS :${CAPS}`);
		const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) ?? "";
		transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
		transport.line(":irc.test 001 alice :Welcome");
		transport.line(
			":irc.test 005 alice CHANTYPES=# PREFIX=(ov)@+ CASEMAPPING=rfc1459 CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported"
		);
		transport.line(":irc.test 422 alice :MOTD File is missing");
		await settle();
	}

	/** Our JOIN echoes; returns the label of the first page's request. */
	function join(): string {
		transport.sent = [];
		transport.line(
			"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host JOIN #seance"
		);
		transport.line(":irc.test 366 alice #seance :End of /NAMES list.");
		const request = transport.sent.find((l) => l.includes("CHATHISTORY LATEST #seance"));
		expect(request, "LATEST sent").to.be.a("string");
		return request!.match(/^@label=([^ ;]+)/)![1];
	}

	function answer(label: string, lines: string[]): void {
		transport.line(`@label=${label} :irc.test BATCH +h chathistory #seance`);

		for (const line of lines) {
			transport.line(`@batch=h;${line.slice(1)}`);
		}

		transport.line(":irc.test BATCH -h");
	}

	const chanId = () => client.findChannel("#seance")!.id;
	const mores = () =>
		payloads<{chan: number; messages: SharedMsg[]}>("more").filter((p) => p.chan === chanId());

	it("shows the kept lines before the server answers", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		expect(mores().map((p) => p.messages.map((m) => m.msgid))).to.deep.equal([
			["m1", "m2", "m3"],
		]);
	});

	it("a first page with nothing new confirms them where they are", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		const label = join();
		dispatch.resetHistory();
		answer(label, [hist(2), hist(3)]);

		expect(payloads("msg:drop")).to.deep.equal([]);
		expect(mores().flatMap((p) => p.messages)).to.deep.equal([]);
		expect(client.findChannel("#seance")!.cachedIds.size).to.equal(0);
	});

	it("a first page that meets them and has more puts it all in order above our JOIN", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		const cachedIds = mores()[0].messages.map((m) => m.id);
		const label = join();
		dispatch.resetHistory();
		answer(label, [hist(2), hist(3), hist(4), hist(5)]);

		expect(payloads("msg:drop")).to.deep.equal([{chan: chanId(), ids: cachedIds}]);
		expect(mores().flatMap((p) => p.messages.map((m) => m.msgid))).to.deep.equal([
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
		]);
		expect(client.findChannel("#seance")!.cachedIds.size).to.equal(0);
	});

	it("a first page that does not meet them takes them out and shows itself", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		const cachedIds = mores()[0].messages.map((m) => m.id);
		const label = join();
		dispatch.resetHistory();
		answer(label, [hist(30), hist(31)]);

		expect(payloads("msg:drop")).to.deep.equal([{chan: chanId(), ids: cachedIds}]);
		expect(mores().flatMap((p) => p.messages.map((m) => m.msgid))).to.deep.equal([
			"m30",
			"m31",
		]);
		// And the device forgets what it can no longer join up.
		expect(client.historyCache.lines("#seance").map((l) => l.msgid)).to.deep.equal([
			"m30",
			"m31",
		]);
	});

	it("a page with a line the cache lacks inside its span is not trusted", async function () {
		backend.put("#seance", [logged(1), logged(3)]);
		await start();
		const label = join();
		dispatch.resetHistory();
		answer(label, [hist(1), hist(2), hist(3)]);
		expect(payloads("msg:drop")).to.have.length(1);
	});

	it("a JOIN or QUIT inside their span, which the cache never keeps, does not undo them", async function () {
		backend.put("#seance", [logged(1), logged(3)]);
		await start();
		const label = join();
		dispatch.resetHistory();
		answer(label, [
			hist(1),
			"@time=2026-08-25T11:02:00.000Z;msgid=e2 :carol!c@host JOIN #seance",
			hist(3),
			"@time=2026-08-25T11:04:00.000Z;msgid=e4 :carol!c@host QUIT :bye",
		]);

		// The events land in order among the kept lines, not on top of them.
		expect(mores().flatMap((p) => p.messages.map((m) => m.msgid))).to.deep.equal([
			"m1",
			"e2",
			"m3",
			"e4",
		]);
		expect(client.findChannel("#seance")!.cachedIds.size).to.equal(0);
	});

	it("a redaction takes a kept line off the device though it is not loaded", async function () {
		backend.put("#seance", [logged(1), logged(2)]);
		await start();
		const label = join();
		answer(label, [hist(1), hist(2)]);
		client.findChannel("#seance")!.forget([...client.findChannel("#seance")!.msgRefs.keys()]);
		transport.line(":bob!bob@host REDACT #seance m1 :oops");
		expect(client.historyCache.lines("#seance").map((l) => l.msgid)).to.deep.equal(["m2"]);
	});

	it("a kept line redacted before the first page does not come back with it", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		const label = join();
		transport.line(":bob!bob@host REDACT #seance m1 :oops");
		dispatch.resetHistory();
		answer(label, [hist(2), hist(3), hist(4)]);

		expect(mores().flatMap((p) => p.messages.map((m) => m.msgid))).to.deep.equal([
			"m2",
			"m3",
			"m4",
		]);
	});

	it("restored rows never count as what the server sent", async function () {
		backend.put("#seance", [logged(1), logged(2), logged(3)]);
		await start();
		const chan = client.findChannel("#seance")!;
		expect(chan.newestServerRef()).to.equal(undefined);
		expect(chan.confirmedMsgids()).to.deep.equal([]);
		expect(client.cursor).to.equal(undefined);
	});
});
