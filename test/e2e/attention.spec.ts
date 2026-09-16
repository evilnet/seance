/**
 * Attention in a real browser against a real ircd (client/js/irc/presence.ts).
 *
 * A hidden page tells the server `AWAY *` (draft/pre-away), a page that comes
 * back sends `AWAY`; while hidden nothing is marked read, and attention
 * returning marks the open channel. Checked on the wire (WebSocket frames)
 * and on the server (a second, plain-TCP client WHOISes the browser's nick).
 *
 * Runs only with SEANCE_E2E_IRC_URL (wss://) and SEANCE_E2E_SEED_HOST/PORT
 * (plain TCP, default 127.0.0.1:6667). Playwright cannot really hide a page,
 * so visibility is faked: `document.visibilityState` / `document.hasFocus`
 * are overridden and the events dispatched -- exactly what foreground.ts
 * listens to.
 */

import {expect, test, type Page} from "@playwright/test";
import * as net from "node:net";

const ircUrl = process.env.SEANCE_E2E_IRC_URL;
const seedHost = process.env.SEANCE_E2E_SEED_HOST ?? "127.0.0.1";
const seedPort = Number(process.env.SEANCE_E2E_SEED_PORT ?? "6667");

test.skip(!ircUrl, "set SEANCE_E2E_IRC_URL to run the live attention e2e test");

const channel = `#e2eatt-${Math.random().toString(36).slice(2, 8)}`;

/** A plain IRC client: sends lines, collects replies. */
class Observer {
	private sock!: net.Socket;
	private buf = "";
	readonly lines: string[] = [];
	readonly nick = `obs${Math.floor(1000 + Math.random() * 9000)}`;

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.sock = net.connect(seedPort, seedHost);
			this.sock.setEncoding("utf8");
			this.sock.on("error", reject);
			this.sock.on("data", (d: string) => {
				this.buf += d;
				let i: number;

				while ((i = this.buf.indexOf("\r\n")) >= 0) {
					const line = this.buf.slice(0, i);
					this.buf = this.buf.slice(i + 2);
					this.lines.push(line);

					if (line.startsWith("PING")) {
						this.sock.write(`PONG ${line.slice(5)}\r\n`);
					}

					if (/ 001 /.test(line)) {
						this.sock.write(`JOIN ${channel}\r\n`);
						resolve();
					}
				}
			});
			this.sock.write(`NICK ${this.nick}\r\nUSER o o o :observer\r\n`);
		});
	}

	send(line: string): void {
		this.sock.write(`${line}\r\n`);
	}

	/** Wait for a line matching `re` received at or after index `from`, returning it. */
	async waitFor(re: RegExp, timeoutMs = 5000, from = 0): Promise<string> {
		const deadline = Date.now() + timeoutMs;

		for (;;) {
			for (; from < this.lines.length; from++) {
				if (re.test(this.lines[from])) {
					return this.lines[from];
				}
			}

			if (Date.now() > deadline) {
				throw new Error(
					`timeout waiting for ${re}; last: ${this.lines.slice(-5).join(" | ")}`
				);
			}

			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** WHOIS `nick`: true when a 301 (away) came back before the 318. */
	async isAway(nick: string): Promise<boolean> {
		const mark = this.lines.length;
		this.send(`WHOIS ${nick}`);
		await this.waitFor(new RegExp(` 318 ${this.nick} ${nick} `), 5000, mark);
		return this.lines.slice(mark).some((l) => new RegExp(` 301 ${this.nick} ${nick} `).test(l));
	}

	close(): void {
		this.sock.write("QUIT\r\n");
		this.sock.end();
	}
}

async function connect(page: Page): Promise<string> {
	const nick = `att-e2e-${Math.floor(1000 + Math.random() * 9000)}`;
	const uri = `web+irc://${new URL(ircUrl!).host}/${channel}`;
	await page.goto(`/?uri=${encodeURIComponent(uri)}`);
	await page.waitForSelector("#connect");
	await page.fill("#connect\\:nick", nick);
	await page.click("#connect form button[type=submit]");
	await page.waitForSelector(`#chat-container[data-current-channel="${channel}"]`);
	await page.waitForSelector(`#chat-container .userlist .user[data-name="${nick}"]`, {
		timeout: 60_000,
	});
	await page.waitForSelector("#input");
	return nick;
}

/** Fake the page's visibility and focus, and fire the events foreground.ts listens to. */
async function setVisible(page: Page, visible: boolean): Promise<void> {
	await page.evaluate((v) => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => (v ? "visible" : "hidden"),
		});
		Object.defineProperty(document, "hidden", {configurable: true, get: () => !v});
		document.hasFocus = () => v;
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event(v ? "focus" : "blur"));
	}, visible);
}

test("a hidden page says AWAY *, marks nothing read, and comes back with AWAY and a MARKREAD", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const observer = new Observer();
	await observer.connect();

	const sent: string[] = [];
	let sockets = 0;
	const t0 = Date.now();
	const stamp = () => String(Date.now() - t0).padStart(6);
	page.on("websocket", (ws) => {
		sockets++;
		const id = sockets;
		ws.on("framesent", (f) => {
			sent.push(String(f.payload));
			console.warn(`${stamp()} ws${id} > ${String(f.payload).slice(0, 80)}`);
		});
		ws.on("framereceived", (f) => {
			const p = String(f.payload);
			if (/ (301|305|306|318|PONG|ERROR)/.test(p) || /^PONG|^ERROR/.test(p))
				console.warn(`${stamp()} ws${id} < ${p.slice(0, 100)}`);
		});
		ws.on("close", () => console.warn(`${stamp()} ws${id} CLOSED`));
	});
	page.on("console", (m) => {
		if (
			m.type() === "error" ||
			m.type() === "warning" ||
			/transport|reconnect|probe/i.test(m.text())
		)
			console.warn(`${stamp()} [page ${m.type()}] ${m.text().slice(0, 160)}`);
	});
	page.on("framenavigated", (fr) => {
		if (fr === page.mainFrame()) console.warn(`${stamp()} NAVIGATED ${fr.url()}`);
	});

	const nick = await connect(page);
	await observer.waitFor(new RegExp(`:${nick}!.* JOIN ${channel}`), 15_000);
	await page.waitForTimeout(1500);
	expect(await observer.isAway(nick), "present while the page is visible").toBe(false);

	// Hide the page: AWAY * goes out, and the server shows the nick as away.
	const before = sent.length;
	await setVisible(page, false);
	await expect
		.poll(() => sent.slice(before).some((l) => /^AWAY \*$/.test(l)), {timeout: 5_000})
		.toBe(true);
	// The ircd runs under valgrind on the bed: give the frame time to land.
	await expect
		.poll(() => observer.isAway(nick), {timeout: 10_000, message: "AWAY * reaches the server"})
		.toBe(true);

	// Messages arrive in the open channel while hidden: no MARKREAD.
	const beforeMsgs = sent.length;
	observer.send(`PRIVMSG ${channel} :first while hidden`);
	observer.send(`PRIVMSG ${channel} :second while hidden`);
	await page.waitForSelector(
		`#chat-container .msg[data-type="message"]:has-text("second while hidden")`,
		{timeout: 10_000}
	);
	await page.waitForTimeout(2500); // past the MARKREAD debounce
	expect(
		sent.slice(beforeMsgs).filter((l) => /^MARKREAD /.test(l)),
		"a hidden page read nothing"
	).toEqual([]);

	// Back: AWAY clears, the server agrees, and the open channel is marked read.
	const beforeBack = sent.length;
	await setVisible(page, true);
	await expect
		.poll(() => sent.slice(beforeBack).some((l) => l === "AWAY"), {timeout: 5_000})
		.toBe(true);
	await expect
		.poll(
			() =>
				sent
					.slice(beforeBack)
					.some((l) => new RegExp(`^MARKREAD ${channel} timestamp=`).test(l)),
			{timeout: 5_000}
		)
		.toBe(true);
	await expect
		.poll(() => observer.isAway(nick), {timeout: 10_000, message: "present again"})
		.toBe(false);

	// The browser is unauthenticated, so the ircd's classic fakelag applies:
	// every command costs ~2 s of credit and past 10 s the socket is not read
	// (the focus probe's PING would then sit behind our lines and Seance would
	// drop the socket after PROBE_TIMEOUT_MS).  Let the credit recover.
	await page.waitForTimeout(8000);

	// A /away the user set is not touched by hiding or returning.
	await page.fill("#input", "/away lunch");
	await page.press("#input", "Enter");
	await expect.poll(() => sent.some((l) => l === "AWAY :lunch"), {timeout: 5_000}).toBe(true);
	await expect
		.poll(() => observer.isAway(nick), {
			timeout: 15_000,
			message: "/away lunch reaches the server",
		})
		.toBe(true);
	const beforeUser = sent.length;
	await setVisible(page, false);
	await page.waitForTimeout(1500);
	await setVisible(page, true);
	await page.waitForTimeout(1500);
	expect(
		sent.slice(beforeUser).filter((l) => /^AWAY/.test(l)),
		"the user's away stands"
	).toEqual([]);
	expect(await observer.isAway(nick), "still away as the user asked").toBe(true);

	observer.close();
});
