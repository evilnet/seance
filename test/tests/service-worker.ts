/**
 * Service-worker push tests (docs/projects/push-subscription.md).
 *
 * Loads `client/service-worker.js` — the exact artifact the browser
 * registers — into a Node `vm` sandbox with a scripted IRC server and an
 * in-memory notification store, then drives the real handlers: push
 * rendering and per-target merging, the `t:"read"` cross-device relay,
 * notification reply (throwaway-connection PRIVMSG) and Mark read (the
 * page's connection, else a throwaway-connection MARKREAD, else the outbox).
 */
import {expect} from "chai";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {interpolate, setCatalog, t} from "../../client/js/i18n/core";
import enCatalog from "../../client/locales/en.json";
import {applyLocale} from "../../client/js/push/i18n";
import {CONCAT_TAG, lineIndexOf, parsePushLine} from "../../client/js/push/line";
import {addMessage, MERGE_KEEP, renderMergedBody} from "../../client/js/push/merge";
import {appUrlFromScope, networkFromScope} from "../../client/js/push/scope";
import {notificationText, stripFormatting} from "../../client/js/push/strip";
import {pseudo} from "../../tools/i18n/pseudo";

// The harness pushes with stored prefs whose locale the worker applies into
// the SHARED core catalog (applyLocale → setCatalog); a qqx run would leave
// every later file resolving pseudo-copy. This file is safe today only
// through mocha file order — hand the real English catalog back after every
// test instead of leaning on that order.
afterEach(function () {
	setCatalog("en", enCatalog, undefined);
});

const SW_SOURCE = readFileSync(path.join(__dirname, "../../client/service-worker.js"), "utf8");

interface Rec {
	tag: string;
	title: string;
	body: string;
	silent?: boolean;
	data: {
		kind?: string;
		count?: number;
		from?: string;
		target?: string;
		time?: string;
		messages?: Array<{from: string; text: string; msgid?: string}>;
	};
	actions?: Array<{
		action: string;
		type?: string;
		title: string;
		placeholder?: string;
	}>;
	silent?: boolean;
	renotify?: boolean;
	shownAt?: number;
	closed: boolean;
	close(): void;
}

interface Stash {
	vapid: string | null;
	networks: Array<{
		uuid: string;
		host: string;
		port: number;
		tls: boolean;
		saslAccount: string;
		saslPassword?: string;
	}>;
}

const STASH: Stash = {
	vapid: "BLB6-test",
	networks: [
		{
			uuid: "net-1",
			host: "127.0.0.1",
			port: 8067,
			tls: false,
			saslAccount: "pushtest1",
			saslPassword: "pw",
		},
	],
};

interface FakeReq {
	result?: unknown;
	onsuccess?: () => void;
	oncomplete?: () => void;
}

/** How the scripted ircd behaves beyond the happy path (nefarious2's
 * bouncer, as observed against the testnet — push-subscription.md). */
interface ServerScript {
	/** Answer the FIRST nick with 433 (a ghost of an earlier reply holds it). */
	nickTaken?: boolean;
	/** After 001, replay these channel memberships (an attach to the
	 * account's session), then the "Session resumed" notice. */
	joinReplay?: string[];
	/** Refuse the first channel PRIVMSG with 404 (the replay race). */
	refuseFirst?: boolean;
	/** Register with the session's nick, not the one the worker asked for. */
	sessionNick?: string;
	/** A server without `message-tags` (no client tags can be sent). */
	noMessageTags?: boolean;
	/** A server without `draft/read-marker` (MARKREAD is an unknown command). */
	noReadMarker?: boolean;
	/** Refuse MARKREAD with a FAIL (read-marker storage unavailable). */
	failMarkRead?: boolean;
	/** Offer `draft/pre-away` (the testnet's ircv3.2-upgrade build does). */
	preAway?: boolean;
	/** Hold the first login's 900/903 until `release` resolves (a slow SASL). */
	holdLogin?: {release: Promise<void>; used?: boolean};
}

/** A clock of events across every socket: when each opened and sent QUIT. */
let socketSeq = 0;

/** What the scripted ircd advertises in CAP LS. */
function capsOffered(script: ServerScript): string[] {
	return [
		"multi-prefix",
		"sasl",
		"draft/metadata-2",
		"draft/webpush",
		...(script.noMessageTags ? [] : ["message-tags"]),
		...(script.noReadMarker ? [] : ["draft/read-marker"]),
		...(script.preAway ? ["draft/pre-away"] : []),
	];
}

/** Scripted ircd: replies the way the testnet server does. */
function serve(ws: any, line: string): void {
	const reply = (s: string): void => {
		ws.onmessage({data: s});
	};

	const script: ServerScript = ws.script ?? {};
	const me = (): string => String(script.sessionNick ?? ws.nick ?? "seance-sw");

	// Like a real ircd, registration completes only once NICK, USER and
	// CAP END are all in — whatever order the client sent them.
	const tryRegister = (): void => {
		if (ws.registered || !ws.capEnded || !ws.nick || !ws.user) {
			return;
		}

		ws.registered = true;
		reply(`:irc.testnet.local 001 ${me()} :Welcome`);

		for (const chan of script.joinReplay ?? []) {
			reply(`:${me()}!u@h JOIN :${chan}`);
		}

		if (script.joinReplay) {
			reply(`:irc.testnet.local NOTICE ${me()} :Session resumed. You are in 1 channel(s).`);
		}
	};

	// A client-tag prefix (`@+draft/reply=… PRIVMSG …`) is not the command.
	const bare = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;

	if (line === "CAP LS 302") {
		reply(`:irc.testnet.local CAP * LS :${capsOffered(script).join(" ")}`);
	} else if (line.startsWith("NICK ")) {
		const nick = line.slice(5);

		if (script.nickTaken && ws.nicks.length === 0) {
			ws.nicks.push(nick);
			reply(`:irc.testnet.local 433 * ${nick} :Nickname is already in use.`);
		} else {
			ws.nicks.push(nick);
			ws.nick = nick;
			tryRegister();
		}
	} else if (line.startsWith("USER ")) {
		ws.user = true;
		tryRegister();
	} else if (line.startsWith("CAP REQ :")) {
		const wanted = line.slice("CAP REQ :".length).split(" ");
		const verb = wanted.every((c) => capsOffered(script).includes(c)) ? "ACK" : "NAK";
		reply(`:irc.testnet.local CAP * ${verb} :${wanted.join(" ")}`);
	} else if (line === "AUTHENTICATE PLAIN") {
		reply("AUTHENTICATE +");
	} else if (line.startsWith("AUTHENTICATE ")) {
		const answer = (): void => {
			reply(":irc.testnet.local 900 * :logged in");
			reply(":irc.testnet.local 903 * :SASL authentication successful");
		};

		if (script.holdLogin && !script.holdLogin.used) {
			script.holdLogin.used = true;
			void script.holdLogin.release.then(answer);
		} else {
			answer();
		}
	} else if (line === "CAP END") {
		ws.capEnded = true;
		tryRegister();
	} else if (bare.startsWith("PRIVMSG #")) {
		if (script.refuseFirst && !ws.refused) {
			ws.refused = true;
			reply(`:irc.testnet.local 404 ${me()} ${bare.split(" ")[1]} :Cannot send to channel`);
		}
	} else if (line.startsWith("AWAY")) {
		// m_away.c: stored without a word before registration (pre-away),
		// RPL_NOWAWAY / RPL_UNAWAY after it.
		if (ws.registered) {
			reply(
				line === "AWAY"
					? `:irc.testnet.local 305 ${me()} :You are no longer marked as being away`
					: `:irc.testnet.local 306 ${me()} :You have been marked as being away`
			);
		}
	} else if (line.startsWith("WEBPUSH REGISTER ")) {
		reply(`:irc.testnet.local WEBPUSH REGISTER ${line.split(" ")[2]}`);
	} else if (line.startsWith("MARKREAD ")) {
		// m_markread.c: the cap gates the command (421 without it), a stored
		// marker is echoed to the account's clients, storage trouble is a FAIL.
		const [, target, param] = line.split(" ");

		if (script.noReadMarker) {
			reply(`:irc.testnet.local 421 ${me()} MARKREAD :Unknown command`);
		} else if (script.failMarkRead) {
			reply(
				`FAIL MARKREAD TEMPORARILY_UNAVAILABLE ${target} :Read marker storage is not available`
			);
		} else {
			reply(`:irc.testnet.local MARKREAD ${target} ${param}`);
		}
	}
}

/** Every FakeWS the harness created, newest last.  Typed structurally:
 * declaring it as FakeWS[] after the class (or before it) trips
 * no-use-before-define either way. */
const wsInstances: Array<{
	sent: string[];
	closed: boolean;
	nicks: string[];
	bornAt: number;
	quitAt: number | null;
}> = [];

class FakeWS {
	sent: string[] = [];
	nicks: string[] = [];
	nick?: string;
	user = false;
	capEnded = false;
	registered = false;
	refused = false;
	closed = false;
	bornAt = socketSeq++;
	quitAt: number | null = null;
	onopen: () => void = () => {};
	onmessage: (e: {data: string}) => void = () => {};
	onclose: () => void = () => {};
	onerror: () => void = () => {};

	constructor(
		public url: string,
		public protocol: string | undefined,
		public script: ServerScript
	) {
		wsInstances.push(this);
		queueMicrotask(() => this.onopen());
	}

	send(line: string): void {
		this.sent.push(line);

		if (line.startsWith("QUIT")) {
			this.quitAt = socketSeq++;
		}

		serve(this, line);
	}

	close(): void {
		this.closed = true;
	}
}

/** A window client of the app: records what the worker posts and, when
 * `ack` is given, answers a reply request through its MessageChannel port
 * (no `ack` = a frozen page that never answers). */
interface FakeClient {
	url: string;
	focused: boolean;
	visibilityState: string;
	posted: any[];
	focusCalls: number;
	ack?: (msg: any) => boolean;
	postMessage(msg: any, transfer?: any[]): void;
	focus(): void;
}

function makeClient(ack?: (msg: any) => boolean, url = "https://app.test/#/chan-1"): FakeClient {
	const client: FakeClient = {
		url,
		focused: true,
		visibilityState: "visible",
		posted: [],
		focusCalls: 0,
		ack,
		postMessage(msg: any, transfer?: any[]) {
			client.posted.push(msg);
			const port = transfer && transfer[0];

			if (!port) {
				return;
			}

			if (client.ack) {
				const ok = client.ack(msg);
				setTimeout(() => {
					port.postMessage({ok});
					port.close(); // an open MessagePort keeps Node alive
				}, 5);
			} else {
				port.close();
			}
		},
		focus() {
			client.focusCalls++;
		},
	};

	return client;
}

interface SWHarness {
	sandbox: any;
	handlers: Record<string, Array<(ev: any) => void>>;
	records: Rec[];
	shown: Rec[];
	opened: string[];
	kv: Map<string, unknown>;
	socketsOpened(): number;
	lastSent(): string[];
	/** What each socket opened since the harness was made sent, in order. */
	sentBySocket(): string[][];
	/** When each socket opened and sent its QUIT, on one clock. */
	socketTimeline(): {bornAt: number; quitAt: number | null}[];
	/** Move the worker's and the notifications' clock forward. */
	advance(ms: number): void;
}

interface HarnessOptions {
	script?: ServerScript;
	clients?: FakeClient[];
	/** Build the worker WITHOUT `sandbox.seancePush` — the js/push.js chunk
	 * failed to load, so `push()` falls back to its inline minimum. */
	noPushModule?: boolean;
	/** Make `indexedDB.open` throw synchronously — the worker must still
	 * show something rather than let handlePush reject silently. */
	failIndexedDB?: boolean;
	/** Make `indexedDB.open` never answer — a worker stalled on storage,
	 * which under WebKit's 30 s clock is a silent push. */
	hangIndexedDB?: boolean;
	/** The worker's `navigator.userAgent` (default a browser that is neither
	 * WebKit nor Chromium: the lenient path). */
	userAgent?: string;
	/** The registration's scope (default the app root; `push/<uuid>/` for a push-only worker). */
	scope?: string;
	/** Run the worker's timers a hundred times faster (its delays are seconds long). */
	fastTimers?: boolean;
	/** Replace the stash the page wrote. */
	stash?: Stash;
	/** Refuse `close()` on a notification shown under 30 s ago, as WebKit does
	 * (bug 309940). */
	refuseYoungClose?: boolean;
	/** WebKit's notifications as they are: a show never replaces one under
	 * the same tag (webpushd files each under its own UUID), and a close
	 * within 30 s of the show is refused. */
	webkitNotifications?: boolean;
	/** Hold every `indexedDB.open` until this settles: storage that is slow,
	 * not stalled (or, if it rejects, that fails once it answers). */
	idbGate?: Promise<void>;
}

const SCOPE = "https://app.test/";

function makeSW(options: HarnessOptions = {}): SWHarness {
	const handlers: Record<string, Array<(ev: any) => void>> = {};
	const records: Rec[] = [];
	const shown: Rec[] = [];
	const opened: string[] = [];
	const kv = new Map<string, unknown>([["stash", options.stash ?? STASH]]);
	const socketsBefore = wsInstances.length;
	let offset = 0;
	const now = (): number => Date.now() + offset;

	class ShiftedDate extends Date {
		constructor(...args: any[]) {
			if (args.length) {
				super(...(args as [number]));
			} else {
				super(now());
			}
		}

		static now(): number {
			return now();
		}
	}

	const webkit = options.webkitNotifications === true;

	class HarnessWS extends FakeWS {
		constructor(url: string, protocol?: string) {
			super(url, protocol, options.script ?? {});
		}
	}

	const sandbox: any = {
		console,
		Date: ShiftedDate,
		setTimeout: options.fastTimers
			? (fn: () => void, ms = 0) => setTimeout(fn, ms / 100)
			: setTimeout,
		clearTimeout,
		MessageChannel,
		TextEncoder,
		Response,
		Headers,
		btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
		navigator: {
			userAgent: options.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64)",
			setAppBadge() {},
			clearAppBadge() {},
		},
		clients: {
			matchAll(): Promise<unknown[]> {
				return Promise.resolve(options.clients ?? []);
			},
			openWindow(u: string): void {
				opened.push(u);
			},
		},
		registration: {
			scope: options.scope ?? SCOPE,
			getNotifications(filter?: {tag: string}): Promise<Rec[]> {
				return Promise.resolve(
					records.filter(
						(n) => !n.closed && (!filter || !filter.tag || n.tag === filter.tag)
					)
				);
			},
			showNotification(title: string, opts: any): Promise<void> {
				// The real Notifications API replaces a same-tag notification
				// silently rather than showing a second one; mirror that here
				// so the worker's tag-based merge (no explicit close-then-show)
				// behaves the same under test as in a browser.
				if (opts.tag && !webkit) {
					for (const n of records) {
						if (!n.closed && n.tag === opts.tag) {
							n.closed = true;
						}
					}
				}

				const rec: Rec = {
					tag: opts.tag || "",
					title,
					body: opts.body,
					silent: opts.silent,
					data: opts.data,
					actions: opts.actions,
					silent: opts.silent,
					renotify: opts.renotify,
					shownAt: now(),
					closed: false,
					close() {
						if ((options.refuseYoungClose || webkit) && now() - rec.shownAt! < 30000) {
							return;
						}

						rec.closed = true;
					},
				};
				records.push(rec);
				shown.push(rec);
				return Promise.resolve();
			},
		},
		caches: {
			open: (): Promise<any> =>
				Promise.resolve({
					match: (): Promise<undefined> => Promise.resolve(undefined),
					put: (): Promise<void> => Promise.resolve(),
				}),
		},
		fetch(url: string): Promise<any> {
			// The locale catalogs come off disk — the real compiled artifacts:
			// the worker's i18n (client/js/push/i18n.ts) fetches
			// `<app>/locales/<tag>.json`, and the HTTP round-trip is the one
			// piece of the browser this vm cannot run. Everything else keeps
			// the empty 200 the push tests have always seen.
			const catalog = /locales\/([A-Za-z0-9-]+)\.json$/.exec(String(url));
			const file =
				catalog !== null
					? path.join(__dirname, "../../client/locales", catalog[1] + ".json")
					: null;
			const body = file !== null && existsSync(file) ? readFileSync(file, "utf8") : null;

			return Promise.resolve({
				ok: file === null || body !== null,
				status: file !== null && body === null ? 404 : 200,
				clone() {
					return this;
				},
				text: (): Promise<string> => Promise.resolve(body ?? ""),
				json: (): Promise<unknown> =>
					Promise.resolve(body === null ? {} : JSON.parse(body)),
				arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(0)),
			});
		},
		importScripts(): void {},
		skipWaiting: (): Promise<void> => Promise.resolve(),
		indexedDB: {
			open() {
				if (options.failIndexedDB) {
					// Private mode / blocked storage: a real browser fires
					// `onerror` async, but a synchronous throw here rejects
					// idbOpen()'s Promise just the same (the executor throwing
					// auto-rejects) and is the smallest fake for it.
					throw new Error("IndexedDB is not available");
				}

				const req: FakeReq = {};

				if (options.hangIndexedDB) {
					return req; // neither onsuccess nor onerror, ever
				}

				const gate = options.idbGate ?? Promise.resolve();

				// A gate that rejects is storage that stalled, then failed.
				gate.catch(() => {
					(req as {error?: Error}).error = new Error("connection lost");
					req.onerror?.();
				});
				void gate.then(() => {
					req.result = {
						transaction() {
							// The worker awaits the TRANSACTION's oncomplete
							// after a put, as real IndexedDB fires it.
							const tx: FakeReq = {};
							const store = {
								get(key: string) {
									const r: FakeReq = {result: kv.get(key)};
									queueMicrotask(() => {
										r.onsuccess?.();
									});
									return r;
								},
								put(value: unknown, key: string) {
									kv.set(key, value);
									queueMicrotask(() => {
										tx.oncomplete?.();
									});
									return {};
								},
							};

							return {
								objectStore: () => store,
								set oncomplete(fn: () => void) {
									tx.oncomplete = fn;
								},
								get oncomplete() {
									return tx.oncomplete;
								},
							};
						},
					};
					req.onsuccess();
				});
				return req;
			},
		},
		WebSocket: HarnessWS,
	};
	sandbox.self = sandbox;
	sandbox.globalThis = sandbox;

	// The real push module, exactly as js/push.js hands it to the worker
	// (client/js/push/worker-entry.ts) — so this sandbox exercises the path
	// the browser runs, not the worker's own no-module-loaded fallback.
	// `noPushModule` leaves it unset: `importScripts` is already a no-op
	// above, so that is exactly what a failed js/push.js fetch looks like,
	// and `push()` in the worker falls back to its inline minimum.
	if (!options.noPushModule) {
		sandbox.seancePush = {
			networkFromScope,
			appUrlFromScope,
			parsePushLine,
			lineIndexOf,
			CONCAT_TAG,
			notificationText,
			stripFormatting,
			addMessage,
			renderMergedBody,
			MERGE_KEEP,
			// The worker's i18n surface (worker-entry.ts installs the same
			// three, with the worker's global fetch bound): applyLocale
			// applies the prefs' locale per push, and t/interpolate resolve
			// the worker's own copy through it. The fetcher is this sandbox's
			// fetch, so the real loader runs against the same fake transport
			// the worker's own fetch calls would.
			applyLocale: (appUrl: string, tag?: string | null) =>
				applyLocale(
					(url: string) =>
						sandbox.fetch(url) as {
							ok: boolean;
							json(): Promise<unknown>;
						},
					appUrl,
					tag
				),
			t,
			interpolate,
		};
	}

	sandbox.addEventListener = (n: string, f: (ev: any) => void) => {
		(handlers[n] = handlers[n] || []).push(f);
	};

	vm.createContext(sandbox);
	vm.runInContext(SW_SOURCE, sandbox, {filename: "service-worker.js"});

	return {
		sandbox,
		handlers,
		records,
		shown,
		opened,
		kv,
		socketsOpened: (): number => wsInstances.length - socketsBefore,
		lastSent: (): string[] => wsInstances[wsInstances.length - 1].sent,
		sentBySocket: (): string[][] => wsInstances.slice(socketsBefore).map((w) => w.sent),
		socketTimeline: () =>
			wsInstances.slice(socketsBefore).map((w) => ({bornAt: w.bornAt, quitAt: w.quitAt})),
		advance(ms: number): void {
			offset += ms;
		},
	};
}

/** Fire one push payload through the worker's push handler. */
async function firePush(sw: SWHarness, raw: string): Promise<void> {
	const promises: Promise<unknown>[] = [];
	const ev = {
		data: {text: () => raw},
		waitUntil: (p: Promise<unknown>) => promises.push(p),
	};

	for (const h of sw.handlers.push) {
		h(ev);
	}

	await Promise.all(promises).catch(() => {});
}

/** Fire a notificationclick with the given action. */
async function fireClick(
	sw: SWHarness,
	notification: Rec,
	action: string,
	extra: {reply?: string} = {}
): Promise<void> {
	const promises: Promise<unknown>[] = [];
	const ev = {
		action,
		reply: extra.reply,
		notification: {
			tag: notification.tag,
			close: () => notification.close(),
			data: notification.data,
		},
		waitUntil: (p: Promise<unknown>) => promises.push(p),
	};

	for (const h of sw.handlers.notificationclick) {
		h(ev);
	}

	await Promise.all(promises).catch(() => {});
	await new Promise((r) => setTimeout(r, 350));
}

/** Every message gets its own msgid, as on a real server: a push that
 * repeats one is a redelivery and is dropped. */
let payloadSeq = 0;

function msgPayload(
	from: string,
	target: string,
	text: string,
	msgid = `BjAAAaBjzZ${++payloadSeq}`
): string {
	return (
		`{"t":"msg","from":"${from}","target":"${target}",` +
		`"msgid":"${msgid}","time":"2026-09-02T19:59:00.000Z","text":"${text}"}`
	);
}

const BATCH_T = "2026-09-02T19:59:00.000Z";

/** One pushed line of a multiline message, in draft/multiline's fallback
 * form (push-payload-multiline.md §3.2): `batch=<base msgid>` on every
 * line, the msgid on the first line only, the batch's time and the
 * ordering tag on every line. */
function batchLine(
	msgid: string,
	index: number,
	sent: number,
	total: number,
	text: string,
	options: {concat?: boolean; from?: string; target?: string} = {}
): string {
	const tags = [
		`batch=${msgid}`,
		...(index === 1 ? [`msgid=${msgid}`] : []),
		`time=${BATCH_T}`,
		`evilnet.github.io/line=${index}/${sent}/${total}`,
		...(options.concat ? [CONCAT_TAG] : []),
	];

	return `@${tags.join(";")} :${options.from ?? "bob"}!u@h PRIVMSG ${
		options.target ?? "pushtest"
	} :${text}`;
}

describe("service worker push notifications", function () {
	it("renders a PM push with the sender as title and the text as body", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].title).to.equal("alice");
		expect(sw.shown[0].body).to.equal("hello there");
		expect(sw.shown[0].data.count).to.equal(1);
	});

	it("renders a channel highlight as `from in #chan` with the text", async function () {
		const sw = makeSW();

		await firePush(
			sw,
			`{"t":"hl","from":"alice","target":"#seance","msgid":"m1","time":"2026-09-02T19:59:00.000Z","text":"hey pushtest"}`
		);

		expect(sw.shown[0].title).to.equal("alice in #seance");
		expect(sw.shown[0].body).to.equal("alice: hey pushtest");
	});

	it("merges same-target pushes into one record with a rising count", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "first"));
		await firePush(sw, msgPayload("alice", "pushtest", "second"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.count).to.equal(2);
		expect(live[0].body).to.contain("first");
		expect(live[0].body).to.contain("second");
		expect(live[0].data.messages).to.have.lengthOf(2);
	});

	it("middle-truncates a long single message", async function () {
		const sw = makeSW();

		const long = "x".repeat(30) + " MIDDLE " + "y".repeat(30);
		await firePush(sw, msgPayload("alice", "pushtest", long));

		expect(sw.shown[0].body).to.contain("…");
		expect(sw.shown[0].body.length).to.be.lessThan(70);
		expect(sw.shown[0].body.startsWith("xxx")).to.equal(true);
		expect(sw.shown[0].body.endsWith("yyy")).to.equal(true);
	});

	it("collapses an overflowing conversation behind `… +N more`", async function () {
		const sw = makeSW();
		const filler = "lorem ipsum dolor sit amet ".repeat(3); // ~81 chars

		for (let i = 1; i <= 5; i++) {
			await firePush(sw, msgPayload("alice", "pushtest", `msg${i} ${filler}`));
		}

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		// MERGE_KEEP=4 retained msg2-msg5; msg1 aged out of the window
		// (the title's count=5 still covers it) and the body collapsed to
		// the oldest kept line, the +N marker, and the newest line.
		expect(live[0].body).to.contain("… +2 more");
		expect(live[0].body).to.contain("msg2"); // oldest kept for context
		expect(live[0].body).to.contain("msg5"); // newest kept
		expect(live[0].data.count).to.equal(5);
	});

	it("closes a target's notification when another device reads it", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "for the desktop"));
		await firePush(sw, msgPayload("bob", "pushtest", "and one more"));

		const ts = new Date(Date.now() + 5000).toISOString();
		await firePush(sw, `{"t":"read","target":"alice","ts":"${ts}"}`);

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.target).to.equal("bob");
	});

	it("keeps a notification when the read marker predates its message", async function () {
		const sw = makeSW();

		// the payload's time is fixed in the past; the read marker predates it
		await firePush(sw, msgPayload("alice", "pushtest", "arrived later"));
		await firePush(sw, `{"t":"read","target":"pushtest","ts":"2026-09-01T00:00:00.000Z"}`);

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
	});

	it("strips IRC formatting always, and Markdown markers only when the reader renders it", async function () {
		const defaultPrefs = makeSW();
		await firePush(
			defaultPrefs,
			"@msgid=fmt1;time=2026-09-02T19:59:00.000Z :alice!u@h PRIVMSG pushtest :\x02**hello**\x02"
		);
		expect(defaultPrefs.shown[0].body).to.equal("hello");

		const markdownOff = makeSW();
		markdownOff.kv.set("prefs", {markdown: false});
		await firePush(
			markdownOff,
			"@msgid=fmt2;time=2026-09-02T19:59:00.000Z :alice!u@h PRIVMSG pushtest :\x02**hello**\x02"
		);
		expect(markdownOff.shown[0].body).to.equal("**hello**");
	});

	it("reassembles a multiline batch delivered out of order into one notification", async function () {
		const sw = makeSW();
		const line = (i: number, text: string) => batchLine("b1", i, 3, 3, text);

		// Only the first line names the message; the others arrive before it.
		await firePush(sw, line(3, "```"));
		await firePush(sw, line(2, "let x = 1;"));
		await firePush(sw, line(1, "```js"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.count).to.equal(1);
		expect(live[0].body).to.equal("let x = 1;");
		expect(live[0].data.messages![0].msgid, "the batch's msgid, from its first line").to.equal(
			"b1"
		);
	});

	it("glues a concat line onto the one before it", async function () {
		const sw = makeSW();

		await firePush(sw, batchLine("b3", 1, 2, 2, "one long line "));
		await firePush(sw, batchLine("b3", 2, 2, 2, "in two chunks", {concat: true}));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("one long line in two chunks");
	});

	it("reassembles a multiline batch whose pushes arrive at the same time", async function () {
		// FCM hands a batch's pushes to the worker together; the handlers run
		// concurrently, and each one reads the notification's stored state
		// before writing it back. Every line must survive.
		const sw = makeSW();
		const line = (i: number) => batchLine("b2", i, 5, 5, `line ${i}`);

		await Promise.all([1, 2, 3, 4, 5].map((i) => firePush(sw, line(i))));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.count).to.equal(1);
		expect(live[0].body).to.equal("line 1\nline 2\nline 3\nline 4\nline 5");
	});

	it("reassembles a batch whose later lines carry no msgid, and keeps the msgid as the reply target", async function () {
		// draft/multiline's fallback form: msgid on the first line only; every
		// line carries the batch reference. Delivered out of order.
		const sw = makeSW();
		const T = "2026-09-02T19:59:00.000Z";
		const line = (i: number, text: string) =>
			`@batch=b3;${
				i === 1 ? "msgid=b3;" : ""
			}time=${T};evilnet.github.io/line=${i}/3/3 :bob!u@h PRIVMSG pushtest :${text}`;

		await firePush(sw, line(2, "two"));
		await firePush(sw, line(3, "three"));
		await firePush(sw, line(1, "one"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.count).to.equal(1);
		expect(live[0].body).to.equal("one\ntwo\nthree");
		const last = live[0].data.messages[live[0].data.messages.length - 1];
		expect(last.msgid, "the batch's msgid, brought by the late first line").to.equal("b3");
	});

	it("drops every line of a batch the live page already saw, msgid on the first line only", async function () {
		const sw = makeSW();
		const T = "2026-09-02T19:59:00.000Z";
		const line = (i: number, text: string) =>
			`@batch=b4;${
				i === 1 ? "msgid=b4;" : ""
			}time=${T};evilnet.github.io/line=${i}/2/2 :bob!u@h PRIVMSG pushtest :${text}`;

		// The page recorded the batch's msgid from the BATCH opener (push-seen.ts).
		sw.kv.set("seen", ["b4"]);
		await firePush(sw, line(2, "two"));
		await firePush(sw, line(1, "one"));
		expect(sw.shown, "seen batch, no msgid on line 2").to.have.lengthOf(0);

		// A different batch still lands, and a redelivered line of it shows nothing more.
		const other = (i: number, text: string) =>
			`@batch=b5;${
				i === 1 ? "msgid=b5;" : ""
			}time=${T};evilnet.github.io/line=${i}/2/2 :bob!u@h PRIVMSG pushtest :${text}`;
		await firePush(sw, other(2, "b"));
		await firePush(sw, other(2, "b"));
		await firePush(sw, other(1, "a"));
		expect(sw.shown, "one notification per shown line of the unseen batch").to.have.lengthOf(2);
		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("a\nb");
	});

	it("a MARKREAD line closes the target's notification when it postdates the message", async function () {
		const sw = makeSW();

		await firePush(
			sw,
			"@msgid=mr1;time=2026-09-02T19:59:00.000Z :alice!u@h PRIVMSG pushtest :unread"
		);
		await firePush(sw, ":irc.example MARKREAD alice timestamp=2099-01-01T00:00:00.000Z");

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(0);
	});

	it("a MARKREAD line leaves a notification that postdates it", async function () {
		const sw = makeSW();

		await firePush(
			sw,
			"@msgid=mr2;time=2099-01-01T00:00:00.000Z :alice!u@h PRIVMSG pushtest :future"
		);
		await firePush(sw, ":irc.example MARKREAD alice timestamp=2026-09-02T19:59:00.000Z");

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
	});

	it("sends the inline reply over a throwaway connection", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "need a reply"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "on my way"});

		const sent = sw.lastSent().join("\n");
		expect(sent).to.contain("PRIVMSG alice :on my way"); // reply to the sender
		expect(rec.closed).to.equal(true);
	});

	it("falls back to opening the app when a reply arrives unsendable", async function () {
		const sw = makeSW();
		sw.kv.delete("stash");

		await firePush(sw, msgPayload("alice", "pushtest", "unanswered"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "hello?"});

		expect(sw.opened).to.have.lengthOf(1);
	});

	it("drops a push whose msgid the live page already saw", async function () {
		const sw = makeSW();
		const msgid = "BjAAAaBjzZ0";

		// The page recorded this message while it was alive (push-seen.ts).
		sw.kv.set("seen", [msgid]);
		await firePush(sw, msgPayload("alice", "pushtest", "hello there", msgid));

		expect(sw.shown, "suppressed when seen").to.have.lengthOf(0);

		// A different message (no record) still shows.
		await firePush(sw, msgPayload("alice", "pushtest", "second one", "BjAAAaBjzZ1"));
		expect(sw.shown, "shown when not seen").to.have.lengthOf(1);

		// The raw-line path dedupes on its own tags.msgid too, against the
		// same "seen" ring.
		sw.kv.set("seen", ["BjAAAaBjzZ9"]);
		await firePush(sw, "@msgid=BjAAAaBjzZ9 :alice PRIVMSG pushtest :old line");
		expect(sw.shown, "raw-line msgid in the seen ring is deduped").to.have.lengthOf(1);

		// A raw line with a msgid not in the ring still shows.
		await firePush(sw, "@msgid=BjAAAaBjzZ10 :alice PRIVMSG pushtest :new line");
		expect(sw.shown, "raw-line msgid not in the ring still shows").to.have.lengthOf(2);
	});

	it("puts Mark read on the left and Reply on the right (thumb reach on a phone)", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));

		expect(sw.shown[0].actions!.map((a) => a.action)).to.deep.equal(["markread", "reply"]);
		expect(sw.shown[0].actions![0].title).to.equal("Mark read");
		expect(sw.shown[0].actions![1].type, "the reply is the inline text field").to.equal("text");
	});

	it("localizes the actions, placeholder and title through the prefs' locale (qqx)", async function () {
		const sw = makeSW();
		sw.kv.set("prefs", {markdown: true, locale: "qqx"});

		await firePush(sw, hlPayload("alice", "#seance", "hey there"));

		const shown = sw.shown[0];
		// The channel title resolves whole ({nick} in {target}) through the
		// catalog; nick and target are user content and stay verbatim.
		expect(shown.title).to.equal(
			interpolate(pseudo("{nick} in {target}"), {nick: "alice", target: "#seance"})
		);
		const actions = shown.actions!;
		expect(actions.map((a) => a.title)).to.deep.equal([pseudo("Mark read"), pseudo("Reply")]);
		expect(actions[1].placeholder).to.equal(pseudo("Reply…"));
	});

	it("keeps the exact English copy when the prefs carry no locale", async function () {
		const sw = makeSW();

		await firePush(sw, hlPayload("alice", "#seance", "hey there"));

		const actions = sw.shown[0].actions!;
		expect(actions.map((a) => a.title)).to.deep.equal(["Mark read", "Reply"]);
		expect(actions[1].placeholder).to.equal("Reply…");
		expect(sw.shown[0].title).to.equal("alice in #seance");
		expect(sw.shown[0].body).to.equal("alice: hey there");
	});

	it("falls back to English for a locale the deploy has no catalog for", async function () {
		const sw = makeSW();
		sw.kv.set("prefs", {locale: "zz"});

		await firePush(sw, hlPayload("alice", "#seance", "hey there"));

		expect(sw.shown[0].actions!.map((a) => a.title)).to.deep.equal(["Mark read", "Reply"]);
		expect(sw.shown[0].title).to.equal("alice in #seance");
	});

	it("localizes the unread-count suffix with the title (a bare number, no plurals)", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "first"));
		await firePush(sw, msgPayload("alice", "pushtest", "second"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live[0].title).to.equal("alice (2)");
	});

	it("resolves the fallback body from the default locale when IndexedDB rejects", async function () {
		// A previous push may have installed another locale; the failure path
		// knows nothing about the prefs, so it must reset to the default
		// rather than speak a locale it cannot name.
		const localized = makeSW();
		localized.kv.set("prefs", {locale: "qqx"});
		await firePush(localized, msgPayload("alice", "pushtest", "hello there"));
		expect(localized.shown[0].actions![0].title).to.equal(pseudo("Mark read"));

		const failed = makeSW({failIndexedDB: true});
		await firePush(failed, msgPayload("alice", "pushtest", "hello there"));

		expect(failed.shown).to.have.lengthOf(1);
		expect(failed.shown[0].tag).to.equal("push-activity");
		expect(failed.shown[0].body).to.equal("New activity while you were away.");
	});

	it("drops a push delivered twice (same msgid), even after its notification was closed", async function () {
		const sw = makeSW();
		const raw = "@msgid=BjAAAaBjdup1 :alice!u@h PRIVMSG pushtest :hello";

		await firePush(sw, raw);
		expect(sw.shown).to.have.lengthOf(1);

		await firePush(sw, raw);
		expect(sw.shown, "a redelivery shows nothing").to.have.lengthOf(1);
		expect(sw.records.filter((n) => !n.closed)[0].data.count).to.equal(1);

		sw.records[0].close(); // the user replied or dismissed it
		await firePush(sw, raw);
		expect(sw.shown, "nor after the notification is gone").to.have.lengthOf(1);
	});

	it("remembers a shown batch line by line, so the other lines still land", async function () {
		const sw = makeSW();
		const line = (i: number, text: string) => batchLine("b7", i, 2, 2, text);

		await firePush(sw, line(1, "one"));
		await firePush(sw, line(1, "one")); // redelivered
		await firePush(sw, line(2, "two"));
		await firePush(sw, line(2, "two")); // redelivered: no msgid to go by

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("one\ntwo");
		expect(live[0].data.count).to.equal(1);
		expect(sw.shown, "the redelivered lines showed nothing").to.have.lengthOf(2);
	});

	it("drops every line of a multiline message the live page took, whichever arrives first", async function () {
		const sw = makeSW();
		const line = (i: number, text: string) => batchLine("b8", i, 3, 3, text);

		// The page recorded the msgid from the BATCH opener (push-seen.ts);
		// the later lines carry no msgid, so it is their batch reference
		// that must be matched against the ring.
		sw.kv.set("seen", ["b8"]);

		await firePush(sw, line(2, "two"));
		await firePush(sw, line(1, "one"));
		await firePush(sw, line(3, "three"));

		expect(sw.shown).to.have.lengthOf(0);
		expect(sw.records.filter((n) => !n.closed)).to.have.lengthOf(0);
	});

	it("still takes the earlier line shape, with the batch and msgid tags on every line", async function () {
		// What a server predating the fallback form pushes. The client ships
		// first, so for a while both shapes reach the same worker; the extra
		// msgid changes nothing, the batch tag is the key either way.
		const sw = makeSW();
		const line = (i: number, text: string) =>
			`@batch=b9;msgid=b9;time=${BATCH_T};evilnet.github.io/line=${i}/2/2 :bob!u@h PRIVMSG pushtest :${text}`;

		await firePush(sw, line(2, "two"));
		await firePush(sw, line(1, "one"));
		await firePush(sw, line(2, "two")); // redelivered

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("one\ntwo");
		expect(live[0].data.count).to.equal(1);
		expect(sw.shown, "the redelivered line showed nothing").to.have.lengthOf(2);
	});

	it("keeps the read relay working when seen entries exist", async function () {
		const sw = makeSW();

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));
		expect(sw.shown).to.have.lengthOf(1);

		// The t:"read" relay carries ts, not msgid — never deduped.
		await firePush(sw, `{"t":"read","target":"alice","ts":"2026-09-03T00:00:00.000Z"}`);
		expect(sw.records[0].closed, "notification closed by read relay").to.be.true;
	});

	it("titles and tags a highlight on a non-# channel prefix (isChannelName, not startsWith('#'))", async function () {
		const sw = makeSW();

		await firePush(
			sw,
			"@msgid=amp1;time=2026-09-04T10:20:30.123Z :bob!u@h PRIVMSG &local :hey pushtest"
		);

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].title).to.equal("bob in &local");
		expect(sw.shown[0].tag).to.equal("push-net-1/&local");
	});

	it("shows the generic notification when IndexedDB rejects", async function () {
		const sw = makeSW({failIndexedDB: true});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].tag).to.equal("push-activity");
		expect(sw.shown[0].body).to.equal("New activity while you were away.");
	});
});

describe("service worker push notifications under WebKit (every push shows)", function () {
	// WebKit (an iPhone's Home Screen web app, Safari) counts a push event
	// that ends without a showNotification on its registration as silent,
	// never resets the count, and at the third removes every subscription of
	// the origin without a word — so the paths that drop a push (the seen
	// ring, a redelivery, a read relay) must show something there; the
	// lenient browsers keep their behaviour (service-worker.js § WebKit).
	const IOS_UA =
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
	const CHROME_UA =
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

	/** Fire a push without waiting for its handler (one that will never finish). */
	function firePushUnawaited(sw: SWHarness, raw: string): void {
		const ev = {data: {text: () => raw}, waitUntil: () => undefined};

		for (const h of sw.handlers.push) {
			h(ev);
		}
	}

	it("re-shows, same tag and count, a message its notification already holds", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there", "m1"));
		await firePush(sw, msgPayload("alice", "pushtest", "hello there", "m1"));

		expect(sw.shown, "shown twice").to.have.lengthOf(2);

		const live = sw.records.filter((n) => !n.closed);
		expect(live, "one notification").to.have.lengthOf(1);
		expect(live[0].title).to.equal("alice");
		expect(live[0].body).to.equal("hello there");
		expect(live[0].data.count).to.equal(1);
	});

	it("a Chromium worker still drops what the page saw (AppleWebKit with Chrome/ is not WebKit)", async function () {
		const sw = makeSW({userAgent: CHROME_UA});
		const msgid = "BjAAAaBjzZ0";

		sw.kv.set("seen", [msgid]);
		await firePush(sw, msgPayload("alice", "pushtest", "hello there", msgid));

		expect(sw.shown).to.have.lengthOf(0);
	});

	it("a read relay replaces the target's notification with a silent stub, closed once WebKit allows", async function () {
		const sw = makeSW({userAgent: IOS_UA, fastTimers: true});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));

		const ts = new Date(Date.now() + 5000).toISOString();
		await firePush(sw, `{"t":"read","target":"alice","ts":"${ts}"}`);

		expect(sw.shown, "the stub was shown").to.have.lengthOf(2);

		const stub = sw.shown[1];
		expect(stub.tag).to.equal("push-net-1/alice");
		expect(stub.silent).to.be.true;
		expect(stub.body).to.equal("Marked as read");
		expect(stub.data.kind).to.equal("read");
		expect(stub.data.target).to.equal("alice");
		expect(
			sw.records.filter((n) => !n.closed),
			"the message's notification is gone, the stub stands"
		).to.deep.equal([stub]);

		// 31 s, a hundred times faster: the worker closes the stub itself.
		await new Promise((r) => setTimeout(r, 450));
		expect(stub.closed, "stub closed after the minimum lifetime").to.be.true;
	});

	it("a MARKREAD line is the same relay", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));
		await firePush(
			sw,
			`:irc.testnet.local MARKREAD alice timestamp=${new Date(
				Date.now() + 5000
			).toISOString()}`
		);

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.kind).to.equal("read");
		expect(live[0].tag).to.equal("push-net-1/alice");
	});

	it("a read relay that keeps a newer notification puts the stub beside it", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		// the payload's time is fixed in the past; the read marker predates it
		await firePush(sw, msgPayload("alice", "pushtest", "arrived later"));
		await firePush(sw, `{"t":"read","target":"alice","ts":"2026-09-01T00:00:00.000Z"}`);

		const live = sw.records.filter((n) => !n.closed);
		expect(live.map((n) => n.tag).sort()).to.deep.equal([
			"push-net-1/alice",
			"push-net-1/read/alice",
		]);
		expect(live.find((n) => n.tag === "push-net-1/alice")?.body).to.equal("arrived later");
	});

	it("a read relay with nothing to close still shows the stub", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, `{"t":"read","target":"alice","ts":"${new Date().toISOString()}"}`);

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].tag).to.equal("push-net-1/alice");
		expect(sw.shown[0].silent).to.be.true;
	});

	it("the next push on the target replaces its stub", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));
		await firePush(
			sw,
			`{"t":"read","target":"alice","ts":"${new Date(Date.now() + 5000).toISOString()}"}`
		);
		await firePush(sw, msgPayload("alice", "pushtest", "and again"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("and again");
		expect(live[0].data.count, "the stub held no messages").to.equal(1);
	});

	it("a stalled handler shows the generic notification before WebKit's 30 s clock runs out", async function () {
		const sw = makeSW({
			userAgent: IOS_UA,
			fastTimers: true,
			hangIndexedDB: true,
			scope: SCOPE + "push/net-1/",
		});

		firePushUnawaited(sw, msgPayload("alice", "pushtest", "hello there"));

		// 20 s, a hundred times faster: silent, under a tag of its own, so
		// it can never overwrite the real notification should that land.
		await new Promise((r) => setTimeout(r, 350));
		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].tag).to.equal("push-net-1/fallback/alice");
		expect(sw.shown[0].silent).to.equal(true);
		expect(sw.shown[0].title).to.equal("Seance");
		expect(sw.shown[0].body).to.not.include("hello there");
	});

	it("shows a push the page already took quietly: silent, no text, not counted, closed after 31 s", async function () {
		const sw = makeSW({userAgent: IOS_UA, fastTimers: true});
		const msgid = "BjAAAaBjzZq1";

		sw.kv.set("seen", [msgid]);
		await firePush(sw, msgPayload("alice", "pushtest", "hello there", msgid));

		expect(sw.shown).to.have.lengthOf(1);
		const quiet = sw.shown[0];
		expect(quiet.silent).to.equal(true);
		expect(quiet.renotify).to.not.equal(true);
		expect(quiet.body).to.not.include("hello there");
		expect(quiet.data.kind).to.equal("quiet");
		await new Promise((r) => setTimeout(r, 450));
		expect(quiet.closed).to.equal(true);
	});

	it("re-shows the notification the page already put up, silently and unchanged", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there", "m-seen"));
		sw.kv.set("seen", ["m-seen"]);
		await firePush(sw, msgPayload("alice", "pushtest", "hello there", "m-seen"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("hello there");
		expect(sw.shown[1].silent).to.equal(true);
		expect(sw.shown[1].renotify).to.not.equal(true);
	});

	it("a redelivery after the user dismissed the notification comes back quiet, without its text", async function () {
		const sw = makeSW({userAgent: IOS_UA});
		const payload = msgPayload("alice", "pushtest", "secret text", "m-again");

		await firePush(sw, payload);
		sw.records.forEach((n) => n.close());
		await firePush(sw, payload);

		expect(sw.shown).to.have.lengthOf(2);
		expect(sw.shown[1].silent).to.equal(true);
		expect(sw.shown[1].body).to.not.include("secret text");
	});

	it("a conversation muted on this device is shown quietly, without its text", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		sw.kv.set("prefs", {muted: ["net-1/#help"]});
		await firePush(sw, msgPayload("alice", "#help", "pushtest: secret", "m-mute"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].silent).to.equal(true);
		expect(sw.shown[0].body).to.not.include("secret");
	});

	it("each stalled push gets its own show, under its conversation's tag", async function () {
		const sw = makeSW({
			userAgent: IOS_UA,
			fastTimers: true,
			hangIndexedDB: true,
			scope: SCOPE + "push/net-1/",
		});

		firePushUnawaited(sw, msgPayload("alice", "pushtest", "one"));
		firePushUnawaited(sw, msgPayload("bob", "pushtest", "two"));

		await new Promise((r) => setTimeout(r, 350));
		expect(sw.shown.map((n) => n.tag).sort()).to.deep.equal([
			"push-net-1/fallback/alice",
			"push-net-1/fallback/bob",
		]);
		expect(sw.shown.every((n) => !n.body.includes("one") && !n.body.includes("two"))).to.equal(
			true
		);
	});

	it("a slow store's fallback goes once the real notification lands, on a root worker too", async function () {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const sw = makeSW({userAgent: IOS_UA, fastTimers: true, idbGate: gate});
		const done = firePush(sw, msgPayload("alice", "pushtest", "hello"));

		await new Promise((r) => setTimeout(r, 250)); // 25 s, a hundred times faster
		expect(sw.shown, "the fallback went up").to.have.lengthOf(1);
		release();
		await done;

		expect(sw.shown).to.have.lengthOf(2);
		const live = sw.records.filter((n) => !n.closed);
		expect(live.map((n) => n.body)).to.deep.equal(["hello"]);
	});

	it("a store that stalls past the deadline and then fails alerts nobody twice", async function () {
		let fail!: () => void;
		const gate = new Promise<void>((resolve, reject) => (fail = () => reject(new Error("x"))));
		const sw = makeSW({
			userAgent: IOS_UA,
			fastTimers: true,
			idbGate: gate,
			scope: SCOPE + "push/net-1/",
		});
		const done = firePush(sw, msgPayload("alice", "pushtest", "hello")).catch(() => undefined);

		await new Promise((r) => setTimeout(r, 250));
		fail();
		await done;

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown.filter((n) => !n.silent)).to.deep.equal([]);
	});

	it("a muted push on a slow store leaves only a quiet stub, which goes", async function () {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const sw = makeSW({
			userAgent: IOS_UA,
			fastTimers: true,
			idbGate: gate,
			scope: SCOPE + "push/net-1/",
		});

		sw.kv.set("prefs", {muted: ["net-1/#help"]});
		const done = firePush(sw, msgPayload("alice", "#help", "pushtest: secret", "m-slow"));
		await new Promise((r) => setTimeout(r, 250));
		release();
		await done;

		expect(
			sw.shown.filter((n) => !n.silent),
			"nothing alerted"
		).to.deep.equal([]);
		await new Promise((r) => setTimeout(r, 450)); // past 31 s
		expect(sw.records.filter((n) => !n.closed)).to.deep.equal([]);
	});

	it("a stalled read relay's stub closes itself", async function () {
		const sw = makeSW({
			userAgent: IOS_UA,
			fastTimers: true,
			hangIndexedDB: true,
			scope: SCOPE + "push/net-1/",
		});

		firePushUnawaited(sw, `{"t":"read","target":"alice"}`);
		await new Promise((r) => setTimeout(r, 250));
		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].data.kind).to.equal("read");
		await new Promise((r) => setTimeout(r, 450));
		expect(sw.shown[0].closed).to.equal(true);
	});

	it("merges a notification an older worker showed without the network, and closes it", async function () {
		const sw = makeSW({userAgent: IOS_UA, scope: SCOPE + "push/net-1/"});

		await sw.sandbox.registration.showNotification("alice", {
			tag: "push-alice",
			body: "earlier",
			data: {
				kind: "push",
				count: 1,
				target: "alice",
				messages: [{from: "alice", text: "earlier", msgid: "m-old"}],
			},
		});
		await firePush(sw, msgPayload("alice", "pushtest", "later", "m-new"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live.map((n) => n.tag)).to.deep.equal(["push-net-1/alice"]);
		expect(live[0].data.count).to.equal(2);
		expect(live[0].body).to.include("earlier");
	});

	it("matches a muted conversation under IRC's case folding", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		sw.kv.set("prefs", {muted: ["net-1/nick{x}"]});
		await firePush(sw, msgPayload("Nick[x]", "pushtest", "secret", "m-fold"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].silent).to.equal(true);
		expect(sw.shown[0].body).to.not.include("secret");
	});

	it("shows a muted conversation quietly on Chrome too", async function () {
		const sw = makeSW({userAgent: CHROME_UA});

		sw.kv.set("prefs", {muted: ["net-1/#help"]});
		await firePush(sw, msgPayload("alice", "#help", "pushtest: secret", "m-chrome"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].silent).to.equal(true);
		expect(sw.shown[0].body).to.not.include("secret");
	});

	it("a read relay spelled in another case still replaces the message, even when WebKit refuses the close", async function () {
		const sw = makeSW({userAgent: IOS_UA, refuseYoungClose: true});

		await firePush(sw, msgPayload("Alice", "pushtest", "hi"));
		await firePush(
			sw,
			`{"t":"read","target":"alice","ts":"${new Date(Date.now() + 5000).toISOString()}"}`
		);

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].data.kind).to.equal("read");
	});

	it("the next message for a conversation closes a stub left beside a newer notification", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "arrived later"));
		await firePush(sw, `{"t":"read","target":"alice","ts":"2026-09-01T00:00:00.000Z"}`);
		await firePush(sw, msgPayload("alice", "pushtest", "and more"));

		const live = sw.records.filter((n) => !n.closed);
		expect(live.map((n) => n.data.kind)).to.deep.equal(["push"]);
	});

	it("tags carry the network, and the stub's title names no conversation", async function () {
		const sw = makeSW({userAgent: IOS_UA});

		await firePush(sw, msgPayload("alice", "pushtest", "hello"));
		await firePush(
			sw,
			`{"t":"read","target":"alice","ts":"${new Date(Date.now() + 5000).toISOString()}"}`
		);

		expect(sw.shown[0].tag).to.equal("push-net-1/alice");
		expect(sw.shown[1].tag).to.equal("push-net-1/alice");
		expect(sw.shown[1].title).to.not.include("alice");
	});

	describe("as WebKit shows them (no tag replacement, no close under 30 s)", function () {
		const live = (sw: SWHarness): Rec[] => sw.records.filter((n) => !n.closed);
		const soon = (): string => new Date(Date.now() + 5000).toISOString();
		/** The message fixtures' time, which the page's second read names. */
		const READ_UP_TO = "2026-09-02T19:59:00.000Z";

		it("a conversation read on this phone within 30 s leaves nothing once the page reads it again", async function () {
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true});

			await firePush(sw, msgPayload("keeki", "#linux", "push works too"));
			// The page read it (its close refused: the message is seconds
			// old), then the server's relay came back to this device.
			await fireMessage(sw, {type: "read", target: "#linux"});
			await firePush(sw, `{"t":"read","target":"#linux","ts":"${soon()}"}`);

			expect(
				live(sw).map((n) => n.data.kind),
				"both up while WebKit refuses the closes (the screenshot)"
			).to.have.members(["push", "read"]);

			sw.advance(32000);
			await fireMessage(sw, {type: "read", target: "#linux", ts: READ_UP_TO});

			expect(live(sw), "the message and the stub are gone").to.deep.equal([]);
		});

		it("the page's second read leaves a message that came after the first", async function () {
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true});

			await firePush(sw, msgPayload("alice", "pushtest", "read one"));
			await fireMessage(sw, {type: "read", target: "alice"});
			sw.advance(20000);
			await firePush(
				sw,
				`{"t":"msg","from":"alice","target":"pushtest","msgid":"m2","time":"${soon()}","text":"unread"}`
			);
			sw.advance(32000);
			await fireMessage(sw, {type: "read", target: "alice", ts: READ_UP_TO});

			expect(live(sw)).to.have.lengthOf(1);
			expect(live(sw)[0].body).to.include("unread");
		});

		it("a read on another device closes an old message at once and its stub on a later tidy", async function () {
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true});

			await firePush(sw, msgPayload("keeki", "#linux", "hello"));
			sw.advance(60000);
			await firePush(sw, `{"t":"read","target":"#linux","ts":"${soon()}"}`);

			expect(live(sw).map((n) => n.data.kind)).to.deep.equal(["read"]);

			sw.advance(32000);
			await fireMessage(sw, {type: "tidy"});
			expect(live(sw)).to.deep.equal([]);
		});

		it("a read relayed within 30 s takes the message's place on the next tidy", async function () {
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true});

			await firePush(sw, msgPayload("keeki", "#linux", "hello"));
			await firePush(sw, `{"t":"read","target":"#linux","ts":"${soon()}"}`);
			sw.advance(32000);
			await firePush(sw, msgPayload("bob", "pushtest", "later"));

			expect(live(sw).map((n) => n.data.from)).to.deep.equal(["bob"]);
		});

		it("a second message merges into the newest copy and the older one goes", async function () {
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true});

			await firePush(sw, msgPayload("alice", "pushtest", "one", "m1"));
			sw.advance(40000);
			await firePush(sw, msgPayload("alice", "pushtest", "two", "m2"));
			sw.advance(40000);
			await firePush(sw, msgPayload("alice", "pushtest", "three", "m3"));

			const up = live(sw);
			expect(up).to.have.lengthOf(1);
			expect(up[0].data.count).to.equal(3);
			expect(up[0].data.messages!.map((m) => m.text)).to.deep.equal(["one", "two", "three"]);
		});

		it("a merge within 30 s counts once on the badge and closes the older copy later", async function () {
			const badges: number[] = [];
			const sw = makeSW({userAgent: IOS_UA, webkitNotifications: true, fastTimers: true});

			sw.sandbox.navigator.setAppBadge = (n: number) => badges.push(n);
			await firePush(sw, msgPayload("alice", "pushtest", "one", "m1"));
			await firePush(sw, msgPayload("alice", "pushtest", "two", "m2"));

			expect(live(sw), "the first copy is too young to close").to.have.lengthOf(2);
			expect(badges[badges.length - 1]).to.equal(2);

			sw.advance(32000);
			// The worker's retry, 31 s on its (here hundredfold) timers.
			await new Promise((resolve) => setTimeout(resolve, 400));

			expect(live(sw).map((n) => n.data.count)).to.deep.equal([2]);
		});

		it("a Chromium worker ignores tidy", async function () {
			const sw = makeSW({userAgent: CHROME_UA});

			await firePush(sw, msgPayload("alice", "pushtest", "hi"));
			await fireMessage(sw, {type: "tidy"});

			expect(live(sw)).to.have.lengthOf(1);
		});
	});

	it("a lenient worker shows nothing for a stalled handler (Chrome has its own budget)", async function () {
		const sw = makeSW({fastTimers: true, hangIndexedDB: true});

		firePushUnawaited(sw, msgPayload("alice", "pushtest", "hello there"));

		await new Promise((r) => setTimeout(r, 350));
		expect(sw.shown).to.have.lengthOf(0);
	});
});

describe("service worker push notifications (inline fallback, js/push.js not loaded)", function () {
	it("renders a PM with control bytes stripped and Markdown left literal", async function () {
		const sw = makeSW({noPushModule: true});

		await firePush(
			sw,
			"@msgid=fb1;time=2026-09-04T10:20:30.123Z :alice!u@h PRIVMSG me :\x02**hi**\x02"
		);

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].title).to.equal("alice");
		expect(sw.shown[0].body).to.equal("**hi**");
	});

	it("merges a second push for the same target into a two-line body", async function () {
		const sw = makeSW({noPushModule: true});

		await firePush(
			sw,
			"@msgid=fb2;time=2026-09-04T10:20:30.123Z :alice!u@h PRIVMSG me :\x02**hi**\x02"
		);
		await firePush(
			sw,
			"@msgid=fb3;time=2026-09-04T10:20:31.123Z :alice!u@h PRIVMSG me :\x02**bye**\x02"
		);

		const live = sw.records.filter((n) => !n.closed);
		expect(live).to.have.lengthOf(1);
		expect(live[0].body).to.equal("**hi**\n**bye**");
		expect(live[0].data.count).to.equal(2);
	});

	it("still shows the English actions when the chunk (and with it the catalog) is gone", async function () {
		const sw = makeSW({noPushModule: true});

		await firePush(sw, msgPayload("alice", "pushtest", "hello there"));

		const actions = sw.shown[0].actions!;
		expect(actions.map((a) => a.title)).to.deep.equal(["Mark read", "Reply"]);
		expect(actions[1].placeholder).to.equal("Reply…");
	});
});

/** Fire a page-posted message at the worker's `message` handler. */
async function fireMessage(sw: SWHarness, data: any): Promise<void> {
	const promises: Promise<unknown>[] = [];
	const ev = {data, waitUntil: (p: Promise<unknown>) => promises.push(p)};

	for (const h of sw.handlers.message) {
		h(ev);
	}

	await Promise.all(promises).catch(() => {});
}

async function pushed(sw: SWHarness, target = "pushtest", from = "alice"): Promise<Rec> {
	await firePush(sw, msgPayload(from, target, "need a reply"));

	return sw.records.filter((n) => !n.closed)[0];
}

/** A sent line without its client-tag prefix. */
function untagged(line: string): string {
	return line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
}

function hlPayload(from: string, chan: string, text: string): string {
	return `{"t":"hl","from":"${from}","target":"${chan}","msgid":"m-${Math.random()}","time":"2026-09-02T19:59:00.000Z","text":"${text}"}`;
}

describe("service worker reply pipeline", function () {
	this.timeout(8000);

	it("registers under a random nick and recovers from 433", async function () {
		const sw = makeSW({script: {nickTaken: true}});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "on my way"});

		const sent = sw.lastSent();
		const nicks = sent.filter((l) => l.startsWith("NICK ")).map((l) => l.slice(5));
		expect(nicks, "a second nick after 433").to.have.lengthOf(2);
		expect(nicks[0]).to.not.equal(nicks[1]);
		expect(nicks[0]).to.match(/^seance-[a-z0-9]{4,}$/);
		expect(nicks[0], "never the fixed nick that collides with its own ghost").to.not.equal(
			"seance-sw"
		);
		expect(sent.join("\n")).to.contain("PRIVMSG alice :on my way");
		expect(rec.closed).to.equal(true);
	});

	it("sends a channel reply once the bouncer replayed the JOIN, not at 001", async function () {
		const sw = makeSW({script: {joinReplay: ["#seance"], sessionNick: "pushtest1-pg"}});

		await firePush(sw, hlPayload("alice", "#seance", "hey pushtest1"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		const started = Date.now();
		await fireClick(sw, rec, "reply", {reply: "on my way"});

		expect(sw.lastSent().join("\n")).to.contain("PRIVMSG #seance :on my way");
		expect(Date.now() - started, "no settle wait once the JOIN replay arrived").to.be.below(
			1200
		);
		expect(rec.closed).to.equal(true);
	});

	it("falls back to a settle wait when no JOIN replay comes", async function () {
		const sw = makeSW();

		await firePush(sw, hlPayload("alice", "#seance", "hey pushtest1"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		const started = Date.now();
		await fireClick(sw, rec, "reply", {reply: "late"});

		expect(sw.lastSent().join("\n")).to.contain("PRIVMSG #seance :late");
		expect(Date.now() - started).to.be.at.least(1500);
	});

	it("retries a channel reply once after a 404 from the replay race", async function () {
		const sw = makeSW({script: {joinReplay: ["#seance"], refuseFirst: true}});

		await firePush(sw, hlPayload("alice", "#seance", "hey pushtest1"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "again"});

		const privmsgs = sw
			.lastSent()
			.map(untagged)
			.filter((l) => l.startsWith("PRIVMSG #seance :again"));
		expect(privmsgs, "sent twice").to.have.lengthOf(2);
		expect(rec.closed, "counted as sent").to.equal(true);
		expect(sw.opened, "no fallback to opening the app").to.have.lengthOf(0);
	});

	it("splits a long reply into frame-sized PRIVMSGs", async function () {
		const sw = makeSW();
		const rec = await pushed(sw);
		const long = Array.from({length: 120}, (_, i) => `word${i}`).join(" "); // ~830 chars

		await fireClick(sw, rec, "reply", {reply: long});

		const privmsgs = sw
			.lastSent()
			.map(untagged)
			.filter((l) => l.startsWith("PRIVMSG alice :"));
		expect(privmsgs.length).to.be.at.least(2);

		for (const l of privmsgs) {
			expect(Buffer.byteLength(l)).to.be.below(420);
		}

		expect(privmsgs.map((l) => l.slice("PRIVMSG alice :".length)).join(" ")).to.equal(long);
	});

	it("hands the reply to an open page first and opens no socket", async function () {
		const client = makeClient(() => true);
		const sw = makeSW({clients: [client]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "via page"});

		expect(client.posted).to.have.lengthOf(1);
		expect(client.posted[0]).to.include({
			type: "reply",
			network: "net-1",
			target: "alice",
			text: "via page",
		});
		expect(sw.socketsOpened(), "no throwaway connection").to.equal(0);
		expect(rec.closed).to.equal(true);
	});

	it("uses its own connection when the page does not answer (frozen)", async function () {
		const frozen = makeClient(); // never acks
		const sw = makeSW({clients: [frozen]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "page is frozen"});

		expect(frozen.posted).to.have.lengthOf(1);
		expect(sw.socketsOpened()).to.equal(1);
		expect(sw.lastSent().join("\n")).to.contain("PRIVMSG alice :page is frozen");
		expect(rec.closed).to.equal(true);
	});

	it("uses its own connection when the page reports it cannot send", async function () {
		const offline = makeClient(() => false); // network disconnected in the page
		const sw = makeSW({clients: [offline]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "page offline"});

		expect(sw.socketsOpened()).to.equal(1);
		expect(sw.lastSent().join("\n")).to.contain("PRIVMSG alice :page offline");
	});

	it("queues the reply and opens the conversation when nothing can send it", async function () {
		const sw = makeSW();
		// Password not remembered: the stash knows the network, not the login.
		sw.kv.set("stash", {
			...STASH,
			networks: [{...STASH.networks[0], saslPassword: undefined}],
		});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "keep me"});

		expect(sw.socketsOpened(), "cannot log in").to.equal(0);
		const outbox = sw.kv.get("outbox") as any[];
		expect(outbox).to.have.lengthOf(1);
		expect(outbox[0]).to.include({network: "net-1", target: "alice", text: "keep me"});
		expect(sw.opened).to.deep.equal([`${SCOPE}#/net/net-1/alice`]);
	});

	it("opens the conversation when the reply button carries no text", async function () {
		const sw = makeSW();
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {});

		expect(sw.socketsOpened()).to.equal(0);
		expect(sw.kv.get("outbox")).to.equal(undefined);
		expect(sw.opened).to.deep.equal([`${SCOPE}#/net/net-1/alice`]);
	});

	it("replies as an IRCv3 reply to the newest message when the server has message-tags", async function () {
		const sw = makeSW({script: {joinReplay: ["#seance"]}});

		await firePush(sw, "@msgid=BjAAAaBjrep1 :alice!u@h PRIVMSG #seance :hey pushtest1");
		await firePush(sw, "@msgid=BjAAAaBjrep2 :alice!u@h PRIVMSG #seance :still there?");
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "yes"});

		const sent = sw.lastSent();
		expect(sent).to.include("CAP REQ :sasl message-tags");
		expect(sent).to.include("@+draft/reply=BjAAAaBjrep2 PRIVMSG #seance :yes");
	});

	it("answers a multiline message by its msgid even when its first line arrived last", async function () {
		const sw = makeSW({script: {joinReplay: ["#seance"]}});
		const line = (i: number, text: string) =>
			batchLine("BjAAAaBjml1", i, 2, 2, text, {from: "alice", target: "#seance"});

		await firePush(sw, line(2, "are you there?"));
		await firePush(sw, line(1, "hey pushtest1"));
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "yes"});

		expect(sw.lastSent()).to.include("@+draft/reply=BjAAAaBjml1 PRIVMSG #seance :yes");
	});

	it("sends a plain PRIVMSG when the server offers no message-tags", async function () {
		const sw = makeSW({script: {noMessageTags: true}});

		await firePush(sw, "@msgid=BjAAAaBjrep3 :alice!u@h PRIVMSG pushtest :hey");
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "yes"});

		const sent = sw.lastSent();
		expect(sent).to.include("CAP REQ :sasl");
		expect(sent).to.include("PRIVMSG alice :yes");
		expect(sent.join("\n")).to.not.contain("draft/reply");
		expect(rec.closed).to.equal(true);
	});

	it("hands the page the reply's msgid and a deadline", async function () {
		const client = makeClient(() => true);
		const sw = makeSW({clients: [client]});

		await firePush(sw, "@msgid=BjAAAaBjrep4 :alice!u@h PRIVMSG pushtest :hey");
		const rec = sw.records.filter((n) => !n.closed)[0];
		const before = Date.now();
		await fireClick(sw, rec, "reply", {reply: "via page"});

		expect(client.posted[0]).to.include({type: "reply", replyTo: "BjAAAaBjrep4"});
		expect(client.posted[0].deadline, "the page must not send after the worker gave up on it")
			.to.be.at.least(before + 2000)
			.and.at.most(Date.now() + 3000);
	});

	it("queues the reply's msgid with it", async function () {
		const sw = makeSW();
		sw.kv.set("stash", {
			...STASH,
			networks: [{...STASH.networks[0], saslPassword: undefined}],
		});

		await firePush(sw, "@msgid=BjAAAaBjrep5 :alice!u@h PRIVMSG pushtest :hey");
		const rec = sw.records.filter((n) => !n.closed)[0];
		await fireClick(sw, rec, "reply", {reply: "keep me"});

		const outbox = sw.kv.get("outbox") as any[];
		expect(outbox[0]).to.include({target: "alice", text: "keep me", replyTo: "BjAAAaBjrep5"});
	});

	it("asks one page at a time, the visible one first, so a reply never goes out twice", async function () {
		const hidden = makeClient(() => true);
		hidden.focused = false;
		hidden.visibilityState = "hidden";
		const visible = makeClient(() => true);
		const sw = makeSW({clients: [hidden, visible]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "once"});

		expect(visible.posted).to.have.lengthOf(1);
		expect(hidden.posted, "not asked once the visible page sent it").to.have.lengthOf(0);
		expect(sw.socketsOpened()).to.equal(0);
	});

	it("moves on to the next page when the first cannot send", async function () {
		const offline = makeClient(() => false);
		const online = makeClient(() => true);
		const sw = makeSW({clients: [offline, online]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "second page"});

		expect(offline.posted).to.have.lengthOf(1);
		expect(online.posted).to.have.lengthOf(1);
		expect(sw.socketsOpened(), "no throwaway connection needed").to.equal(0);
		expect(rec.closed).to.equal(true);
	});

	it("does not touch the page's outbox when a reply went out", async function () {
		const sw = makeSW();
		const rec = await pushed(sw);

		await fireClick(sw, rec, "reply", {reply: "sent"});

		expect(sw.kv.get("outbox")).to.equal(undefined);
	});
});

describe("service worker notification click", function () {
	it("opens a window on the network/target deep link when no page is open", async function () {
		const sw = makeSW();
		const rec = await pushed(sw, "#seance");

		await fireClick(sw, rec, "");

		expect(sw.opened).to.deep.equal([`${SCOPE}#/net/net-1/%23seance`]);
	});

	it("tells an open page which conversation to show and focuses it", async function () {
		const client = makeClient();
		const sw = makeSW({clients: [client]});
		const rec = await pushed(sw, "#seance");

		await fireClick(sw, rec, "");

		expect(sw.opened).to.have.lengthOf(0);
		expect(client.posted[0]).to.include({type: "open", network: "net-1", target: "#seance"});
		expect(client.focusCalls).to.equal(1);
	});

	it("carries the page notification's network and target so it outlives the page", async function () {
		const sw = makeSW();

		await fireMessage(sw, {
			type: "notification",
			chanId: 7,
			network: "net-1",
			target: "#seance",
			title: "alice (#seance) says:",
			body: "hi",
			timestamp: Date.now(),
		});

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].tag).to.equal("chan-7");
		expect(sw.shown[0].data).to.deep.equal({kind: "page", network: "net-1", target: "#seance"});

		await fireClick(sw, sw.shown[0], "");
		expect(sw.opened).to.deep.equal([`${SCOPE}#/net/net-1/%23seance`]);
	});

	it("falls back to the chan-<id> route for a page notification without a target", async function () {
		const sw = makeSW();

		await fireMessage(sw, {type: "notification", chanId: 7, title: "t", body: "b"});
		await fireClick(sw, sw.shown[0], "");

		expect(sw.opened).to.deep.equal([`${SCOPE}#/chan-7`]);
	});
});

describe("service worker subscription renewal", function () {
	it("re-registers after 001, where nefarious2 accepts WEBPUSH REGISTER", async function () {
		const sw = makeSW();
		const promises: Promise<unknown>[] = [];
		const ev = {
			oldSubscription: null,
			newSubscription: {endpoint: "https://push.example/e1", keys: {p256dh: "P", auth: "A"}},
			waitUntil: (p: Promise<unknown>) => promises.push(p),
		};

		for (const h of sw.handlers.pushsubscriptionchange) {
			h(ev);
		}

		await Promise.all(promises).catch(() => {});

		const sent = sw.lastSent();
		const capEnd = sent.indexOf("CAP END");
		const register = sent.findIndex((l) =>
			l.startsWith("WEBPUSH REGISTER https://push.example/e1")
		);
		expect(register, "REGISTER sent").to.be.greaterThan(-1);
		expect(register, "after CAP END, not before").to.be.greaterThan(capEnd);
	});

	it("unregisters the rotated-away endpoint so the device is not registered twice", async function () {
		const sw = makeSW();
		const promises: Promise<unknown>[] = [];
		const ev = {
			oldSubscription: {endpoint: "https://push.example/OLD"},
			newSubscription: {endpoint: "https://push.example/NEW", keys: {p256dh: "P", auth: "A"}},
			waitUntil: (p: Promise<unknown>) => promises.push(p),
		};

		for (const h of sw.handlers.pushsubscriptionchange) {
			h(ev);
		}

		await Promise.all(promises).catch(() => {});

		const sent = sw.lastSent();
		const unregister = sent.indexOf("WEBPUSH UNREGISTER https://push.example/OLD");
		const register = sent.findIndex((l) =>
			l.startsWith("WEBPUSH REGISTER https://push.example/NEW")
		);
		expect(unregister, "old endpoint unregistered").to.be.greaterThan(-1);
		expect(register, "new endpoint registered").to.be.greaterThan(-1);
		expect(unregister, "unregister before register").to.be.lessThan(register);
	});
});

describe("service worker build announcement", function () {
	/** Fire the worker's `activate` and settle everything it waited on. */
	async function activate(sw: SWHarness): Promise<void> {
		const waited: Array<Promise<unknown>> = [];

		for (const handler of sw.handlers.activate ?? []) {
			handler({waitUntil: (p: Promise<unknown>) => waited.push(p)});
		}

		await Promise.all(waited);
	}

	/** What `activate` touches that the push harness has no need for. */
	function withActivation(sw: SWHarness, onClaim: () => void = () => undefined): void {
		sw.sandbox.caches.keys = (): Promise<string[]> => Promise.resolve(["older-build"]);
		sw.sandbox.caches.delete = (): Promise<boolean> => Promise.resolve(true);

		sw.sandbox.clients.claim = (): Promise<void> => {
			onClaim();
			return Promise.resolve();
		};
	}

	it("tells every open window its build once it has claimed them", async function () {
		const a = makeClient();
		const b = makeClient();
		const sw = makeSW({clients: [a, b]});
		let postedAtClaim = -1;

		withActivation(sw, () => {
			postedAtClaim = a.posted.length;
		});

		await activate(sw);

		// The source is unbuilt, so the token is still the placeholder.
		expect(a.posted).to.deep.equal([{type: "build", build: "__HASH__"}]);
		expect(b.posted).to.deep.equal([{type: "build", build: "__HASH__"}]);
		expect(postedAtClaim, "claims before announcing").to.equal(0);
	});

	it("a push-only worker announces nothing (its build's root worker does)", async function () {
		const a = makeClient();
		const sw = makeSW({clients: [a], scope: `${SCOPE}push/net-1/`});
		withActivation(sw);

		await activate(sw);

		expect(a.posted).to.deep.equal([]);
	});

	it("keeps the translation engines' model caches on a shell update", async function () {
		const sw = makeSW({clients: []});
		const deleted: string[] = [];

		sw.sandbox.caches.keys = (): Promise<string[]> =>
			Promise.resolve(["older-build", "transformers-cache", "webllm/model", "webllm/config"]);

		sw.sandbox.caches.delete = (name: string): Promise<boolean> => {
			deleted.push(name);
			return Promise.resolve(true);
		};

		sw.sandbox.clients.claim = (): Promise<void> => Promise.resolve();

		await activate(sw);

		expect(deleted).to.deep.equal(["older-build"]);
	});
});

describe("service worker mark read", function () {
	this.timeout(8000); // a frozen page is given 2.5 s before the worker moves on

	/** msgPayload's `time`: the notification's newest message. */
	const T = "2026-09-02T19:59:00.000Z";

	it("marks the conversation read over a throwaway connection, at the notification's newest time", async function () {
		const sw = makeSW();
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		const sent = sw.lastSent();
		expect(sent).to.include("CAP REQ :sasl draft/read-marker");
		expect(sent).to.include(`MARKREAD alice timestamp=${T}`);
		expect(sent).to.include("QUIT :done");
		expect(rec.closed).to.equal(true);
		expect(sw.opened, "no window opened").to.have.lengthOf(0);
		expect(sw.kv.get("outbox")).to.equal(undefined);
	});

	it("marks a channel read at 001, without waiting for the bouncer's JOIN replay", async function () {
		const sw = makeSW();
		await firePush(
			sw,
			"@msgid=BjAAAaBjmr1;time=2026-09-02T20:00:00.000Z :bob!u@h PRIVMSG #seance :hey pushtest1"
		);
		const rec = sw.records.filter((n) => !n.closed)[0];

		await fireClick(sw, rec, "markread");

		expect(sw.lastSent()).to.include("MARKREAD #seance timestamp=2026-09-02T20:00:00.000Z");
		expect(rec.closed).to.equal(true);
	});

	it("marks read at the time of the click when the push carried no time", async function () {
		const sw = makeSW();
		const before = Date.now();
		await firePush(sw, "@msgid=BjAAAaBjmr2 :alice!u@h PRIVMSG pushtest :no time tag");
		const rec = sw.records.filter((n) => !n.closed)[0];

		await fireClick(sw, rec, "markread");

		const line = sw.lastSent().find((l) => l.startsWith("MARKREAD alice timestamp="));
		expect(line, "MARKREAD sent").to.be.a("string");
		const stamp = Date.parse(line!.slice("MARKREAD alice timestamp=".length));
		expect(stamp).to.be.within(before, Date.now());
	});

	it("hands mark-read to an open page first and opens no socket", async function () {
		const client = makeClient(() => true);
		const sw = makeSW({clients: [client]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		expect(client.posted).to.have.lengthOf(1);
		expect(client.posted[0]).to.include({
			type: "markread",
			network: "net-1",
			target: "alice",
			time: T,
		});
		expect(client.posted[0].deadline).to.be.a("number");
		expect(sw.socketsOpened(), "no throwaway connection").to.equal(0);
		expect(rec.closed).to.equal(true);
	});

	it("uses its own connection when the page does not answer (frozen)", async function () {
		const frozen = makeClient(); // never acks
		const sw = makeSW({clients: [frozen]});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		expect(frozen.posted).to.have.lengthOf(1);
		expect(sw.socketsOpened()).to.equal(1);
		expect(sw.lastSent()).to.include(`MARKREAD alice timestamp=${T}`);
		expect(rec.closed).to.equal(true);
	});

	it("queues the marker for the page when nothing can send it, and does not open the app", async function () {
		const sw = makeSW();
		// Password not remembered: the stash knows the network, not the login.
		sw.kv.set("stash", {
			...STASH,
			networks: [{...STASH.networks[0], saslPassword: undefined}],
		});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		expect(sw.socketsOpened(), "cannot log in").to.equal(0);
		const outbox = sw.kv.get("outbox") as any[];
		expect(outbox).to.have.lengthOf(1);
		expect(outbox[0]).to.include({
			type: "markread",
			network: "net-1",
			target: "alice",
			time: T,
		});
		expect(sw.opened, "a marker is nothing to type, so no window").to.have.lengthOf(0);
		expect(rec.closed, "closed here even so").to.equal(true);
	});

	it("queues the marker when the server offers no read-marker cap", async function () {
		const sw = makeSW({script: {noReadMarker: true}});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		const sent = sw.lastSent();
		expect(sent).to.include("CAP REQ :sasl");
		expect(
			sent.some((l) => l.startsWith("MARKREAD")),
			"no MARKREAD without the cap"
		).to.equal(false);
		expect(sw.kv.get("outbox")).to.have.lengthOf(1);
		expect(rec.closed).to.equal(true);
	});

	it("queues the marker when the server refuses it", async function () {
		const sw = makeSW({script: {failMarkRead: true}});
		const rec = await pushed(sw);

		await fireClick(sw, rec, "markread");

		expect(sw.lastSent()).to.include(`MARKREAD alice timestamp=${T}`);
		expect(sw.kv.get("outbox")).to.have.lengthOf(1);
	});
});

describe("service worker copy fallback (SW_COPY_FALLBACK)", function () {
	it("stays equal to the compiled en catalog's sw.* entries", function () {
		// The worker's t() falls back to these literals when js/push.js did
		// not load and no catalog exists anywhere. They must never drift from
		// the pot's sw.* msgids — en.json is compiled from them, so this pin
		// fails when either side changes alone.
		const block = /const SW_COPY_FALLBACK = (\{[\s\S]*?\});/.exec(SW_SOURCE);
		expect(block, "SW_COPY_FALLBACK found in service-worker.js").to.not.equal(null);

		// The object literal is prettier-formatted (trailing comma), so drop
		// it before parsing as JSON.
		const literal = block![1].replace(/,(\s*\})$/, "$1");
		const fallback = JSON.parse(literal) as Record<string, string>;
		const en = JSON.parse(
			readFileSync(path.join(__dirname, "../../client/locales/en.json"), "utf8")
		) as Record<string, string>;
		const swKeys = Object.keys(en)
			.filter((key) => key.startsWith("sw."))
			.sort();

		expect(swKeys, "the pot carries sw.* keys").to.have.lengthOf.above(0);
		expect(Object.keys(fallback).sort()).to.deep.equal(swKeys);

		for (const key of swKeys) {
			expect(fallback[key], key).to.equal(en[key]);
		}
	});
});

describe("service worker push module surface", function () {
	it("binds exactly the keys worker-entry.ts exports", async function () {
		// The sandbox's seancePush stands in for js/push.js's module: if a
		// key is added to worker-entry.ts's export and not to this harness
		// (or the other way), the worker would run with a silently narrower
		// surface than the browser's. worker-entry.ts assigns onto `self`
		// at import time, so stand one in for Node first.
		(globalThis as {self?: unknown}).self = {};

		try {
			const {seancePush} = await import("../../client/js/push/worker-entry");
			const sw = makeSW();

			expect(Object.keys(sw.sandbox.seancePush as object)).to.deep.equal(
				Object.keys(seancePush)
			);
		} finally {
			delete (globalThis as {self?: unknown}).self;
		}
	});
});

describe("service worker shell cache", function () {
	/**
	 * Drive one `fetch` event through the worker and report what it put into
	 * the shell cache. `length` is the response's `content-length` header,
	 * `null` for a response that carries none.
	 */
	async function cached(sw: SWHarness, url: string, length: string | null): Promise<string[]> {
		const put: string[] = [];
		const waited: Promise<unknown>[] = [];
		let responded: Promise<unknown> = Promise.resolve();

		sw.sandbox.fetch = (): Promise<any> =>
			Promise.resolve({
				ok: true,
				status: 200,
				redirected: false,
				headers: {
					get: (name: string): string | null =>
						name.toLowerCase() === "content-length" ? length : null,
				},
				clone(): unknown {
					return this;
				},
			});

		sw.sandbox.caches.open = (): Promise<any> =>
			Promise.resolve({
				match: (): Promise<undefined> => Promise.resolve(undefined),
				put(request: any): Promise<void> {
					put.push(typeof request === "string" ? request : request.url);
					return Promise.resolve();
				},
			});

		const request = {url, method: "GET", mode: "no-cors", destination: "script"};

		for (const handler of sw.handlers.fetch ?? []) {
			handler({
				request,
				respondWith(p: Promise<unknown>) {
					responded = p;
				},
				waitUntil: (p: Promise<unknown>) => waited.push(p),
			});
		}

		await Promise.all([responded, ...waited]);
		return put;
	}

	it("caches an ordinary asset", async function () {
		const sw = makeSW();

		expect(await cached(sw, `${SCOPE}js/bundle.js`, String(900 * 1024))).to.deep.equal([
			`${SCOPE}js/bundle.js`,
		]);
	});

	it("caches a response that does not say how big it is", async function () {
		const sw = makeSW();

		expect(await cached(sw, `${SCOPE}css/style.css`, null)).to.deep.equal([
			`${SCOPE}css/style.css`,
		]);
	});

	it("does not put a response over 8 MiB into the shell cache", async function () {
		const sw = makeSW();

		// A 9 MiB same-origin GET: served, never stored. The shell cache is
		// what makes the app open offline, not a general-purpose store.
		expect(await cached(sw, `${SCOPE}media/clip.webm`, String(9 * 1024 * 1024))).to.deep.equal(
			[]
		);
	});

	it("never sees a request under models/ (a same-origin mirror is excluded)", async function () {
		const sw = makeSW();

		expect(await cached(sw, `${SCOPE}models/Xenova/nllb/onnx/x.onnx`, "1024")).to.deep.equal(
			[]
		);
	});
});

describe("service worker cross-origin isolation headers", function () {
	// docs/projects/translation-devices.md § Multithreading: the root worker
	// makes the app's documents and its own worker scripts cross-origin
	// isolated (multithreaded WebAssembly for the CPU models), from the
	// network and from the shell cache alike.
	const COOP = "cross-origin-opener-policy";
	const COEP = "cross-origin-embedder-policy";

	interface Served {
		/** What the worker answered with; undefined when it never called respondWith. */
		response: Response | undefined;
		/** What it stored in the shell cache. */
		put: Response[];
	}

	/**
	 * Drive one `fetch` event through the worker. `network` is what the
	 * network answers (a function, so each call gets a fresh body), or
	 * "offline" for a fetch that rejects; `cached` is the shell cache's copy.
	 */
	async function serveFetch(
		sw: SWHarness,
		request: {url: string; mode: string; destination: string},
		network: (() => Response) | "offline",
		cached?: () => Response
	): Promise<Served> {
		const put: Response[] = [];
		const waited: Promise<unknown>[] = [];
		let responded: Promise<Response> | undefined;

		sw.sandbox.fetch = (): Promise<Response> =>
			network === "offline"
				? Promise.reject(new TypeError("Failed to fetch"))
				: Promise.resolve(network());
		sw.sandbox.caches.open = (): Promise<any> =>
			Promise.resolve({
				match: (): Promise<Response | undefined> => Promise.resolve(cached?.()),
				put(_request: unknown, response: Response): Promise<void> {
					put.push(response);
					return Promise.resolve();
				},
			});

		for (const handler of sw.handlers.fetch ?? []) {
			handler({
				request: {method: "GET", ...request},
				clientId: "",
				respondWith(p: Promise<Response>) {
					responded = p;
				},
				waitUntil: (p: Promise<unknown>) => waited.push(p),
			});
		}

		const response = responded ? await responded : undefined;
		await Promise.all(waited);
		return {response, put};
	}

	const page =
		(headers: Record<string, string> = {}) =>
		() =>
			new Response("<!doctype html><title>app</title>", {
				status: 200,
				headers: {"content-type": "text/html", ...headers},
			});
	const script = () => () =>
		new Response("self.onmessage = () => {};", {
			status: 200,
			headers: {"content-type": "text/javascript"},
		});
	const navigation = {url: SCOPE, mode: "navigate", destination: "document"};

	it("isolates a navigation served from the network", async function () {
		const {response, put} = await serveFetch(makeSW(), navigation, page());

		expect(response?.status).to.equal(200);
		expect(response?.headers.get(COOP)).to.equal("same-origin");
		expect(response?.headers.get(COEP)).to.equal("credentialless");
		expect(response?.headers.get("content-type")).to.equal("text/html");
		expect(await response?.text()).to.equal("<!doctype html><title>app</title>");
		// The shell cache still gets a copy.
		expect(put).to.have.length(1);
	});

	it("isolates a navigation served from the shell cache", async function () {
		// A copy stored by an older worker carries no headers of its own.
		const {response} = await serveFetch(makeSW(), navigation, "offline", page());

		expect(response?.headers.get(COOP)).to.equal("same-origin");
		expect(response?.headers.get(COEP)).to.equal("credentialless");
		expect(await response?.text()).to.equal("<!doctype html><title>app</title>");
	});

	it("isolates the app's own worker script", async function () {
		const {response} = await serveFetch(
			makeSW(),
			{
				url: `${SCOPE}js/translate-worker.js?v=abc`,
				mode: "same-origin",
				destination: "worker",
			},
			script()
		);

		expect(response?.headers.get(COOP)).to.equal("same-origin");
		expect(response?.headers.get(COEP)).to.equal("credentialless");
		expect(await response?.text()).to.equal("self.onmessage = () => {};");
	});

	it("isolates the app's own worker script from the shell cache", async function () {
		const {response} = await serveFetch(
			makeSW(),
			{
				url: `${SCOPE}js/translate-worker.js?v=abc`,
				mode: "same-origin",
				destination: "worker",
			},
			"offline",
			script()
		);

		expect(response?.headers.get(COEP)).to.equal("credentialless");
	});

	it("leaves an ordinary script's headers alone", async function () {
		const {response} = await serveFetch(
			makeSW(),
			{url: `${SCOPE}js/bundle.js?v=abc`, mode: "no-cors", destination: "script"},
			script()
		);

		expect(response?.headers.get(COOP)).to.equal(null);
		expect(response?.headers.get(COEP)).to.equal(null);
	});

	it("keeps the deploy's own policy where it sent one", async function () {
		// branding.md § Threads: a deploy may choose `require-corp`.
		const {response} = await serveFetch(
			makeSW(),
			navigation,
			page({"Cross-Origin-Embedder-Policy": "require-corp"})
		);

		expect(response?.headers.get(COEP)).to.equal("require-corp");
		expect(response?.headers.get(COOP)).to.equal("same-origin");
	});

	it("isolates under Chromium's user agent", async function () {
		const sw = makeSW({
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
		});
		const {response} = await serveFetch(sw, navigation, page());

		expect(response?.headers.get(COEP)).to.equal("credentialless");
	});

	it("adds nothing under WebKit, which has no credentialless", async function () {
		// Spec § Multithreading: Safari and every iOS browser stay as they
		// were, COOP included.
		for (const userAgent of [
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
		]) {
			const {response} = await serveFetch(makeSW({userAgent}), navigation, page());

			expect(response?.status, userAgent).to.equal(200);
			expect(response?.headers.get(COOP), userAgent).to.equal(null);
			expect(response?.headers.get(COEP), userAgent).to.equal(null);
		}
	});

	it("never touches a cross-origin request", async function () {
		const {response} = await serveFetch(
			makeSW(),
			{url: "https://cdn.example/preview.png", mode: "no-cors", destination: "image"},
			page()
		);

		expect(response).to.equal(undefined);
	});

	it("adds nothing on a push-only worker", async function () {
		const sw = makeSW({scope: `${SCOPE}push/net-1/`});
		const {response} = await serveFetch(
			sw,
			{url: `${SCOPE}push/net-1/`, mode: "navigate", destination: "document"},
			page()
		);

		expect(response).to.equal(undefined);
	});
});

describe("service worker page notifications on a push worker", function () {
	// The page shows its own notification for a message it took live, and
	// the server may push the same message to this device (an unattended
	// session is pushed to). Chrome counts visible notifications per
	// registration: if the page's notification lives on the root worker and
	// the push worker drops the duplicate, the push counts as silent and
	// Chrome eventually shows "This site has been updated in the
	// background". So for a push-enabled network the page hands the message
	// to that network's push worker, which shows it as it would a push.
	const NET_SCOPE = `${SCOPE}push/net-1/`;
	const T = "2026-09-02T19:59:00.000Z";

	function pageNote(
		target: string,
		from: string,
		text: string,
		msgid: string
	): Record<string, unknown> {
		return {
			type: "notification",
			chanId: 7,
			network: "net-1",
			target,
			timestamp: Date.parse(T),
			title: `${from} says:`,
			body: text,
			message: {msgid, from, text, time: T},
		};
	}

	it("shows the page's message as the push would: same tag, data and actions", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("#seance", "alice", "hi seance", "pm-1"));

		expect(sw.shown).to.have.lengthOf(1);
		const rec = sw.shown[0];
		expect(rec.tag).to.equal("push-net-1/#seance");
		expect(rec.title).to.equal("alice in #seance");
		expect(rec.body).to.equal("alice: hi seance");
		expect(rec.data.kind).to.equal("push");
		expect(rec.data.target).to.equal("#seance");
		expect(rec.data.time).to.equal(T);
		expect(rec.data.messages![0].msgid).to.equal("pm-1");
		expect(rec.actions!.map((a) => a.action)).to.deep.equal(["markread", "reply"]);
	});

	it("shows the page's message silently when the page asks, actions kept", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, {...pageNote("#seance", "alice", "hush", "pm-s"), silent: true});

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.shown[0].silent).to.equal(true);
		expect(sw.shown[0].actions!.map((a) => a.action)).to.deep.equal(["markread", "reply"]);
	});

	it("leaves the page's message audible by default", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("#seance", "alice", "hey", "pm-a"));

		expect(sw.shown[0].silent).to.equal(false);
	});

	it("a query's notification answers the sender", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("alice", "alice", "psst", "pm-2"));

		expect(sw.shown[0].tag).to.equal("push-net-1/alice");
		expect(sw.shown[0].title).to.equal("alice");
		expect(sw.shown[0].data.target).to.equal("alice");
	});

	it("the push for a message the page showed leaves that notification visible and adds none", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("alice", "alice", "psst", "pm-3"));
		sw.kv.set("seen", ["pm-3"]); // the page recorded it (push-seen.ts)
		await firePush(sw, msgPayload("alice", "alice", "psst", "pm-3"));

		expect(sw.shown, "no second notification").to.have.lengthOf(1);
		expect(
			sw.records.filter((n) => !n.closed),
			"a notification of this registration is visible when the push ends"
		).to.have.lengthOf(1);
	});

	it("a push that lands before the page's copy is not shown twice", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await firePush(sw, msgPayload("alice", "alice", "psst", "pm-4"));
		await fireMessage(sw, pageNote("alice", "alice", "psst", "pm-4"));

		expect(sw.shown).to.have.lengthOf(1);
		expect(sw.records.filter((n) => !n.closed)[0].data.count).to.equal(1);
	});

	it("merges the page's message with pushed ones for the same conversation", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await firePush(sw, msgPayload("alice", "alice", "one", "pm-5"));
		await fireMessage(sw, pageNote("alice", "alice", "two", "pm-6"));

		const open = sw.records.filter((n) => !n.closed);
		expect(open).to.have.lengthOf(1);
		expect(open[0].data.count).to.equal(2);
		expect(open[0].data.messages!.map((m) => m.msgid)).to.deep.equal(["pm-5", "pm-6"]);
	});

	it("an action from the page reads like its push", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("alice", "alice", "\x01ACTION waves\x01", "pm-7"));
		await firePush(sw, "@msgid=pm-8 :alice!u@h PRIVMSG me :\x01ACTION nods\x01");

		const open = sw.records.filter((n) => !n.closed);
		expect(open).to.have.lengthOf(1);
		expect(open[0].body, "both the push's shape").to.equal("*waves*\n*nods*");
	});

	it("the page reading a conversation closes it, so a later push does not bring it back", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		// The page notified while the account was attended: nothing was
		// pushed, so the server's read gate sends no read push to close it.
		await fireMessage(sw, pageNote("alice", "alice", "old news", "pm-9"));
		await fireMessage(sw, {type: "read", target: "alice"});

		expect(
			sw.records.filter((n) => !n.closed),
			"closed by the page's read"
		).to.have.lengthOf(0);

		await firePush(sw, msgPayload("alice", "alice", "fresh", "pm-10"));

		const open = sw.records.filter((n) => !n.closed);
		expect(open).to.have.lengthOf(1);
		expect(open[0].data.count, "the read message is not counted again").to.equal(1);
		expect(open[0].body).to.equal("fresh");
	});

	it("the page's read leaves other conversations alone", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, pageNote("alice", "alice", "a", "pm-11"));
		await fireMessage(sw, pageNote("#seance", "bob", "b", "pm-12"));
		await fireMessage(sw, {type: "read", target: "#seance"});

		const open = sw.records.filter((n) => !n.closed);
		expect(open.map((n) => n.tag)).to.deep.equal(["push-net-1/alice"]);
	});

	it("the page's read closes a conversation however either side spells it", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		// IRC folds case (rfc1459: `[]\~` are `{}|^`), and the page's open
		// conversation need not be spelled as the notification it closes.
		await fireMessage(sw, pageNote("#Seance", "bob", "b", "pm-13"));
		await fireMessage(sw, pageNote("[Alice]", "[Alice]", "a", "pm-14"));
		await fireMessage(sw, {type: "read", target: "#seance"});
		await fireMessage(sw, {type: "read", target: "{alice}"});

		expect(sw.records.filter((n) => !n.closed)).to.have.lengthOf(0);
	});

	it("a page notification without a message keeps the per-channel shape", async function () {
		const sw = makeSW({scope: NET_SCOPE});

		await fireMessage(sw, {type: "notification", chanId: 7, title: "t", body: "b"});

		expect(sw.shown[0].tag).to.equal("chan-7");
	});
});

describe("service worker away on close", function () {
	// The scripted ircd answers inside send(), so NICK/USER land late in
	// the list; they are not what these tests are about.
	const ircOnly = (lines: string[]): string[] =>
		lines.filter((l) => !l.startsWith("NICK ") && !l.startsWith("USER "));

	/** Post the page's `away-on-close` and wait for the worker to finish. */
	async function closePage(sw: SWHarness, networks: string[]): Promise<void> {
		const promises: Promise<unknown>[] = [];
		const ev = {
			data: {type: "away-on-close", networks},
			waitUntil: (p: Promise<unknown>) => promises.push(p),
		};

		for (const h of sw.handlers.message) {
			h(ev);
		}

		expect(promises, "kept alive with waitUntil").to.have.lengthOf(1);
		await Promise.all(promises);
	}

	it("a close: no window after the delay, so it logs in, says AWAY * before CAP END and after 001, and QUITs", async function () {
		const sw = makeSW({fastTimers: true, script: {preAway: true}});
		await closePage(sw, ["net-1"]);

		expect(sw.socketsOpened()).to.equal(1);
		const sent = ircOnly(sw.lastSent());
		expect(sent).to.include("CAP REQ :sasl draft/pre-away");
		const tail = sent.slice(
			sent.findIndex((l) => l.startsWith("AUTHENTICATE ") && l.length > 20) + 1
		);
		expect(tail).to.deep.equal(["AWAY *", "CAP END", "AWAY *", "QUIT :done"]);
	});

	it("without draft/pre-away says it after 001 only", async function () {
		const sw = makeSW({fastTimers: true});
		await closePage(sw, ["net-1"]);

		const sent = ircOnly(sw.lastSent());
		expect(sent).to.include("CAP REQ :sasl");
		expect(sent.slice(sent.indexOf("CAP END"))).to.deep.equal([
			"CAP END",
			"AWAY *",
			"QUIT :done",
		]);
	});

	it("a reload: a window of the app is open again, so it does nothing", async function () {
		// The reload's new document appears after the close was posted: the
		// worker must look only once the delay is over.
		const windows: FakeClient[] = [];
		const sw = makeSW({fastTimers: true, script: {preAway: true}, clients: windows});
		const done = closePage(sw, ["net-1"]);
		await new Promise((r) => setTimeout(r, 10)); // 1 s of the worker's 5
		windows.push(makeClient());
		await done;
		expect(sw.socketsOpened()).to.equal(0);
	});

	it("a window of another project on the origin does not stop it", async function () {
		// A github.io origin: this app at /seance/, another project at /other/.
		const other = makeClient(undefined, "https://app.test/other/");
		const sw = makeSW({
			fastTimers: true,
			script: {preAway: true},
			clients: [other],
			scope: "https://app.test/seance/",
		});
		await closePage(sw, ["net-1"]);
		expect(sw.socketsOpened()).to.equal(1);
	});

	const poster = (sw: SWHarness) => {
		const promises: Promise<unknown>[] = [];

		const post = (networks: string[]) => {
			for (const h of sw.handlers.message) {
				h({
					data: {type: "away-on-close", networks},
					waitUntil: (p: Promise<unknown>) => promises.push(p),
				});
			}
		};

		return {post, done: () => Promise.all(promises)};
	};

	const accountOf = (sent: string[]) => {
		const auth = sent.find((l) => l.startsWith("AUTHENTICATE ") && l.length > 20) as string;
		return Buffer.from(auth.slice(13), "base64").toString().split("\0")[1];
	};

	const NET_2 = {...STASH.networks[0], uuid: "net-2", saslAccount: "pushtest2"};

	it("two closes inside the delay log in once, for both posts' networks", async function () {
		const sw = makeSW({
			fastTimers: true,
			script: {preAway: true},
			stash: {vapid: STASH.vapid, networks: [...STASH.networks, NET_2]},
		});
		const {post, done} = poster(sw);
		post(["net-1"]);
		await new Promise((r) => setTimeout(r, 10)); // 1 s of the worker's 5
		post(["net-1", "net-2"]);
		await done();
		// One run: each network once, not net-1 twice.
		expect(sw.sentBySocket().map(accountOf)).to.deep.equal([
			STASH.networks[0].saslAccount,
			"pushtest2",
		]);
	});

	it("a close while the run is logging in is queued for one more run after it", async function () {
		let release = (): void => undefined;
		const held = new Promise<void>((r) => (release = r));
		const sw = makeSW({
			fastTimers: true,
			script: {preAway: true, holdLogin: {release: held}},
			stash: {vapid: STASH.vapid, networks: [...STASH.networks, NET_2]},
		});
		const {post, done} = poster(sw);
		post(["net-1"]);
		// Past the delay (50 ms here): the login has begun, its 903 held.
		await new Promise((r) => setTimeout(r, 60));
		expect(sw.socketsOpened(), "the first run is logging in").to.equal(1);
		post(["net-2"]);
		// Longer than another delay (a second run of its own would have
		// dialled by now), shorter than the login's 150 ms timeout.
		await new Promise((r) => setTimeout(r, 70));
		expect(sw.socketsOpened(), "no second login beside the held one").to.equal(1);
		release();
		await done();
		expect(sw.sentBySocket().map(accountOf)).to.deep.equal([
			STASH.networks[0].saslAccount,
			"pushtest2",
		]);
		const [first, second] = sw.socketTimeline();
		expect(first.quitAt, "the first login QUIT").to.not.equal(null);
		expect(second.bornAt, "the queued run dials after that QUIT").to.be.greaterThan(
			first.quitAt as number
		);
	});

	it("no stashed password: it does nothing", async function () {
		const net = {...STASH.networks[0], saslPassword: undefined};
		const sw = makeSW({fastTimers: true, stash: {vapid: STASH.vapid, networks: [net]}});
		await closePage(sw, ["net-1"]);
		expect(sw.socketsOpened()).to.equal(0);
	});

	it("only the networks it was given, by uuid", async function () {
		const sw = makeSW({
			fastTimers: true,
			script: {preAway: true},
			stash: {vapid: STASH.vapid, networks: [...STASH.networks, NET_2]},
		});
		await closePage(sw, ["net-2", "unknown"]);
		expect(sw.sentBySocket().map(accountOf)).to.deep.equal(["pushtest2"]);
	});

	it("several networks one after another, in the order given", async function () {
		const sw = makeSW({
			fastTimers: true,
			script: {preAway: true},
			stash: {vapid: STASH.vapid, networks: [...STASH.networks, NET_2]},
		});
		await closePage(sw, ["net-2", "net-1"]);
		const sockets = sw.sentBySocket();
		expect(sockets.map(accountOf)).to.deep.equal(["pushtest2", STASH.networks[0].saslAccount]);
		// One after another: the first had QUIT before the second was opened.
		const [first, second] = sw.socketTimeline();
		expect(first.quitAt).to.not.equal(null);
		expect(second.bornAt).to.be.greaterThan(first.quitAt as number);
	});
});
