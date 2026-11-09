import {expect} from "chai";
import {
	FINAL_CLOSE,
	ShellSocket,
	SocketBridge,
	shellSocketCtor,
} from "../../client/js/irc/shellSocket";
import {WsTransport, TransportEvent} from "../../client/js/irc/transport";

/** A stand-in for `window.seanceShell`'s Socket plugin, driven by the tests. */
class FakeBridge implements SocketBridge {
	calls: {method: string; options: any}[] = [];
	/** Methods that reject, with this message. */
	refuse = new Map<string, string>();
	/** While set, calls wait until release() — to show they still run in order. */
	private gate: Promise<void> | null = null;
	private open: (() => void) | null = null;
	private listeners = new Map<string, (data: any) => void>();

	hold(): void {
		this.gate = new Promise((resolve) => (this.open = resolve));
	}

	release(): void {
		this.open?.();
		this.gate = null;
	}

	async call(plugin: string, method: string, options?: unknown): Promise<unknown> {
		expect(plugin).to.equal("Socket");
		const gate = this.gate;

		if (gate && method === "open") {
			await gate;
		}

		this.calls.push({method, options});
		const refusal = this.refuse.get(method);

		if (refusal) {
			throw Object.assign(new Error(refusal), {code: "refused"});
		}

		return {};
	}

	listen(plugin: string, event: string, cb: (data: any) => void): void {
		expect(plugin).to.equal("Socket");
		this.listeners.set(event, cb);
	}

	emit(event: string, data: unknown): void {
		this.listeners.get(event)?.(data);
	}

	methods(): string[] {
		return this.calls.map((c) => c.method);
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function record(socket: ShellSocket): string[] {
	const log: string[] = [];
	socket.addEventListener("open", () => log.push(`open:${socket.readyState}`));
	socket.addEventListener("message", (ev) => log.push(`line:${String(ev.data)}`));
	socket.addEventListener("error", (ev) =>
		log.push(`error:${(ev as {message: string}).message}`)
	);
	socket.addEventListener("close", (ev) =>
		log.push(`close:${ev.code}:${ev.reason}:${ev.wasClean}`)
	);
	return log;
}

const endpoint = {host: "irc.example.org", port: 6697, tls: true};

describe("ShellSocket", function () {
	it("opens, delivers lines and sends in one call per tick", async function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "a");
		const log = record(socket);
		await tick();
		expect(bridge.calls[0]).to.deep.equal({
			method: "open",
			options: {
				id: "a",
				page: bridge.calls[0].options.page,
				host: "irc.example.org",
				port: 6697,
				tls: true,
			},
		});
		expect(socket.readyState).to.equal(socket.CONNECTING);

		bridge.emit("open", {id: "a"});
		bridge.emit("lines", {id: "a", lines: [":srv 001 me :hi", ":srv 002 me :x"]});
		expect(log).to.deep.equal(["open:1", "line::srv 001 me :hi", "line::srv 002 me :x"]);

		socket.send("NICK me");
		socket.send("USER me 0 * :me");
		await tick();
		expect(bridge.calls[1]).to.deep.equal({
			method: "send",
			options: {id: "a", lines: ["NICK me", "USER me 0 * :me"]},
		});
	});

	it("sends one page token with every open", function () {
		const bridge = new FakeBridge();
		new ShellSocket(bridge, endpoint, "p1");
		new ShellSocket(bridge, endpoint, "p2");
		return tick().then(() => {
			const [a, b] = bridge.calls.map((c) => c.options.page as string);
			expect(a).to.match(/^[0-9a-f-]{36}$/);
			expect(b).to.equal(a);
		});
	});

	it("fails like a refusal when the bridge throws at once", async function () {
		const bridge = new FakeBridge();
		bridge.call = () => {
			throw new Error("no IPC");
		};
		const socket = new ShellSocket(bridge, endpoint, "t");
		const log = record(socket);
		await tick();
		expect(log).to.deep.equal(["error:no IPC", "close:1006:no IPC:false"]);
	});

	it("delivers the rest of a batch when a listener throws", function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "x");
		const got: string[] = [];
		socket.addEventListener("message", (ev) => {
			if (ev.data === "boom") {
				throw new Error("listener failed");
			}

			got.push(String(ev.data));
		});
		bridge.emit("open", {id: "x"});
		// The throw is rethrown in a microtask; catch the scheduling instead.
		const rethrows: Array<() => void> = [];
		const real = globalThis.queueMicrotask;
		globalThis.queueMicrotask = (fn) => rethrows.push(fn);

		try {
			bridge.emit("lines", {id: "x", lines: ["a", "boom", "b"]});
		} finally {
			globalThis.queueMicrotask = real;
		}

		expect(() => rethrows.forEach((fn) => fn())).to.throw("listener failed");
		expect(got).to.deep.equal(["a", "b"]);
	});

	it("throws on send before it is open", function () {
		const socket = new ShellSocket(new FakeBridge(), endpoint, "b");
		expect(() => socket.send("NICK me")).to.throw(/not open/);
	});

	it("keeps sends behind a slow open and a close behind the sends", async function () {
		const bridge = new FakeBridge();
		bridge.hold();
		const socket = new ShellSocket(bridge, endpoint, "c");
		// The shell's open event can come before its call resolves.
		bridge.emit("open", {id: "c"});
		socket.send("QUIT :bye");
		socket.close();
		bridge.release();
		await tick();
		expect(bridge.methods()).to.deep.equal(["open", "send", "close"]);
		expect(bridge.calls[1].options.lines).to.deep.equal(["QUIT :bye"]);
	});

	it("fires its own close once when the page closes it", async function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "d");
		const log = record(socket);
		bridge.emit("open", {id: "d"});
		socket.close();
		socket.close();
		expect(socket.readyState).to.equal(socket.CLOSING);
		await tick();
		// A late close from the shell, or more lines, change nothing.
		bridge.emit("lines", {id: "d", lines: ["late"]});
		bridge.emit("close", {id: "d", code: 1006, reason: "reset"});
		expect(log).to.deep.equal(["open:1", "close:1000::true"]);
		expect(socket.readyState).to.equal(socket.CLOSED);
	});

	it("closes with 1006 when the page closes it while connecting, and ignores a late open", async function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "e");
		const log = record(socket);
		socket.close();
		await tick();
		bridge.emit("open", {id: "e"});
		expect(log).to.deep.equal(["close:1006:closed while connecting:false"]);
	});

	it("reports a lost socket as error then close, with the shell's reason", function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "f");
		const log = record(socket);
		bridge.emit("open", {id: "f"});
		bridge.emit("close", {id: "f", code: 1006, reason: "connection reset"});
		bridge.emit("close", {id: "f", code: 1006, reason: "again"});
		expect(log).to.deep.equal([
			"open:1",
			"error:connection reset",
			"close:1006:connection reset:false",
		]);
	});

	it("reports an orderly EOF as a clean close, with no error", function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "g");
		const log = record(socket);
		bridge.emit("open", {id: "g"});
		bridge.emit("close", {id: "g", code: 1000, reason: ""});
		expect(log).to.deep.equal(["open:1", "close:1000::true"]);
	});

	it("marks a failure the shell calls final", function () {
		const bridge = new FakeBridge();
		const socket = new ShellSocket(bridge, endpoint, "fin");
		const closes: unknown[] = [];
		socket.addEventListener("close", (ev) => closes.push(ev));
		bridge.emit("close", {id: "fin", code: FINAL_CLOSE, reason: "certificate"});
		expect(closes).to.deep.equal([
			{code: FINAL_CLOSE, reason: "certificate", wasClean: false, final: true},
		]);
	});

	it("turns a refused open into error then close", async function () {
		const bridge = new FakeBridge();
		bridge.refuse.set("open", "port 25 is not allowed");
		const socket = new ShellSocket(bridge, endpoint, "h");
		const log = record(socket);
		await tick();
		expect(log).to.deep.equal([
			"error:port 25 is not allowed",
			"close:1006:port 25 is not allowed:false",
		]);
	});

	it("turns a refused send into error then close", async function () {
		const bridge = new FakeBridge();
		bridge.refuse.set("send", "queue full");
		const socket = new ShellSocket(bridge, endpoint, "i");
		const log = record(socket);
		bridge.emit("open", {id: "i"});
		socket.send("PRIVMSG #a :x");
		await tick();
		expect(log).to.deep.equal(["open:1", "error:queue full", "close:1006:queue full:false"]);
	});

	it("routes events by id and ignores unknown ids", function () {
		const bridge = new FakeBridge();
		const one = new ShellSocket(bridge, endpoint, "one");
		const two = new ShellSocket(bridge, endpoint, "two");
		const logOne = record(one);
		const logTwo = record(two);
		bridge.emit("open", {id: "two"});
		bridge.emit("open", {id: "nobody"});
		bridge.emit("lines", {lines: ["no id"]});
		expect(logOne).to.deep.equal([]);
		expect(logTwo).to.deep.equal(["open:1"]);
	});

	it("makes random ids when none is given", function () {
		const bridge = new FakeBridge();
		const a = new ShellSocket(bridge, endpoint);
		const b = new ShellSocket(bridge, endpoint);
		expect(a.id).to.match(/^[0-9a-f-]{36}$/);
		expect(a.id).to.not.equal(b.id);
	});

	describe("under WsTransport", function () {
		it("registers, answers PING and closes on request", async function () {
			const bridge = new FakeBridge();
			const transport = new WsTransport({
				url: "ircs://irc.example.org:6697",
				WebSocketImpl: shellSocketCtor(bridge, endpoint),
				reconnect: {
					enabled: false,
					initialDelayMs: 1,
					maxDelayMs: 1,
					factor: 1,
					jitter: false,
				},
			});
			const events: TransportEvent[] = [];
			transport.on((ev) => events.push(ev));
			transport.connect();
			await tick();
			const id = bridge.calls[0].options.id as string;
			expect(bridge.calls[0].options.host).to.equal("irc.example.org");

			bridge.emit("open", {id});
			expect(transport.state).to.equal("open");
			transport.send("CAP LS 302");
			bridge.emit("lines", {id, lines: ["PING :abc"]});
			await tick();
			// The PONG and the line sent before it go out in order.
			expect(bridge.calls[1].options.lines).to.deep.equal(["CAP LS 302", "PONG :abc"]);

			transport.close();
			await tick();
			expect(bridge.methods()).to.deep.equal(["open", "send", "close"]);
			expect(transport.state).to.equal("closed");
			expect(events.map((e) => e.type)).to.include.members(["open", "line", "close"]);
			const close = events.find((e) => e.type === "close") as {willReconnect: boolean};
			expect(close.willReconnect).to.equal(false);
		});

		it("retries a lost dial but not a final one", async function () {
			for (const [code, retries] of [
				[1006, true],
				[FINAL_CLOSE, false],
			] as const) {
				const bridge = new FakeBridge();
				const transport = new WsTransport({
					url: "ircs://irc.example.org:6697",
					WebSocketImpl: shellSocketCtor(bridge, endpoint),
					reconnect: {
						enabled: true,
						initialDelayMs: 60000,
						maxDelayMs: 60000,
						factor: 1,
						jitter: false,
					},
				});
				const events: TransportEvent[] = [];
				transport.on((ev) => events.push(ev));
				transport.connect();
				await tick();
				bridge.emit("close", {id: bridge.calls[0].options.id, code, reason: "x"});
				const close = events.find((e) => e.type === "close") as {willReconnect: boolean};
				expect(close.willReconnect, String(code)).to.equal(retries);
				expect(transport.state).to.equal(retries ? "reconnect-wait" : "closed");
				transport.close();
			}
		});

		it("abandons a dial: the old socket is closed in the shell, its late open ignored", async function () {
			const bridge = new FakeBridge();
			const transport = new WsTransport({
				url: "irc://irc.example.org:6667",
				WebSocketImpl: shellSocketCtor(bridge, {...endpoint, port: 6667, tls: false}),
				reconnect: {
					enabled: false,
					initialDelayMs: 1,
					maxDelayMs: 1,
					factor: 1,
					jitter: false,
				},
			});
			transport.connect();
			await tick();
			const first = bridge.calls[0].options.id as string;
			transport.redial();
			await tick();
			const opens = bridge.calls.filter((c) => c.method === "open");
			expect(opens).to.have.length(2);
			expect(
				bridge.calls.some((c) => c.method === "close" && c.options.id === first)
			).to.equal(true);
			bridge.emit("open", {id: first});
			expect(transport.state).to.equal("connecting");
			bridge.emit("open", {id: opens[1].options.id});
			expect(transport.state).to.equal("open");
			transport.close();
			await tick();
		});
	});
});
