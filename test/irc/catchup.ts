import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {
	CATCHUP_STEP_COST_MS,
	pendingCatchup,
	TARGETS_TIMEOUT_MS,
} from "../../client/js/irc/catchup";
import {BACKGROUND_BUDGET_MS, IRCU_FAKE_LAG} from "../../client/js/irc/fakelag";
import {MARKREAD_DEBOUNCE_MS, MARKREAD_JUMP_GAP_MS} from "../../client/js/irc/handlers/markread";
import {ChanState} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, Harness, register, setup} from "./support";

// The spy from test/irc/client.ts's root-level beforeEach may be installed;
// only restore one we own (see CLAUDE.md).
describe("Connect burst: batched JOIN, catch-up paced by fake lag, lazy MODE (irc/catchup.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	let ownSpy = false;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-27T12:00:00.000Z")});

		if (!(socket.dispatch as any).isSinonProxy) {
			sinon.spy(socket, "dispatch");
			ownSpy = true;
		}
	});

	afterEach(function () {
		clock.restore();

		if (ownSpy) {
			(socket.dispatch as sinon.SinonSpy).restore();
			ownSpy = false;
		}
	});

	const CHANS = ["#seance", "#two", "#three", "#four"];

	const CAPS = ALL_CAPS + " draft/read-marker";

	/** Register (read markers on) with four autojoin channels. */
	function connected(): Harness {
		const h = setup({join: CHANS.join(","), fakeLag: IRCU_FAKE_LAG});
		register(h, CAPS);
		return h;
	}

	function joinAll(h: Harness): void {
		for (const name of CHANS) {
			h.transport.line(`:alice!alice@host JOIN ${name}`);
		}
	}

	/**
	 * Advance the clock to the background queue's next send and return what
	 * went out; checks that background work never pushed the server's clock
	 * past the budget it leaves the user.
	 */
	function nextBackground(h: Harness, filter: (l: string) => boolean = () => true): string[] {
		for (let i = 0; i < 200; i++) {
			clock.tick(100);
			const lines = h.sent().filter(filter);

			if (lines.length > 0) {
				expect(h.client.fakeLag.ahead()).to.be.at.most(BACKGROUND_BUDGET_MS);
				return lines;
			}
		}

		return [];
	}

	/**
	 * Run the clock until `count` more lines passing `filter` have gone out,
	 * with when each went (ms after the call); checks the budget at every send.
	 */
	function collect(
		h: Harness,
		count: number,
		filter: (l: string) => boolean = () => true
	): {line: string; at: number}[] {
		const start = Date.now();
		const out: {line: string; at: number}[] = [];

		for (let i = 0; i < 1000 && out.length < count; i++) {
			clock.tick(100);
			const lines = h.sent().filter(filter);

			if (lines.length > 0) {
				expect(h.client.fakeLag.ahead()).to.be.at.most(BACKGROUND_BUDGET_MS);
				out.push(...lines.map((line) => ({line, at: Date.now() - start})));
			}
		}

		return out;
	}

	/** The server's answer to the TARGETS `request`: `rows` as [name, ISO time], newest first. */
	function answerTargets(
		h: Harness,
		request: string,
		rows: [string, string][],
		complete = true
	): void {
		const label = /^@label=(\S+) /.exec(request)?.[1];
		const tags = [complete ? "draft/chathistory-end" : "", label ? `label=${label}` : ""]
			.filter(Boolean)
			.join(";");
		h.transport.line(`${tags ? `@${tags} ` : ""}:irc.test BATCH +tg draft/chathistory-targets`);

		for (const [name, time] of rows) {
			h.transport.line(
				`@batch=tg :irc.test!chathistory@irc.test CHATHISTORY TARGETS ${name} ${time}`
			);
		}

		h.transport.line(":irc.test BATCH -tg");
	}

	const isTargets = (l: string) => /^(@\S+ )?CHATHISTORY TARGETS /.test(l);
	const isFetch = (l: string) => /^(@\S+ )?CHATHISTORY (LATEST|AFTER|BEFORE) /.test(l);
	/** The channels of the history fetches among `lines`, in order. */
	const fetched = (lines: string[]) =>
		lines.filter(isFetch).map((l) => /CHATHISTORY \S+ (\S+)/.exec(l)![1]);

	function commandsOf(lines: string[]): string[] {
		return lines.map((l) =>
			l
				.replace(/^@\S+ /, "")
				.split(" ")
				.slice(0, 2)
				.join(" ")
		);
	}

	it("JOINs the autojoin list with one command", function () {
		const h = connected();
		const joins = h.transport.sent.filter((l) => l.startsWith("JOIN"));
		// The model keeps channels sorted; one JOIN carries them all.
		expect(joins).to.deep.equal(["JOIN #four,#seance,#three,#two"]);
	});

	it("puts keyed channels first and splits on TARGMAX / line length", function () {
		const h = connected();
		h.sent();
		h.client.joinChannels([
			{name: "#open"},
			{name: "#locked", key: "hunter2"},
			{name: "#open2"},
		]);
		expect(h.sent()).to.deep.equal(["JOIN #locked,#open,#open2 hunter2"]);

		h.transport.line(":irc.test 005 alice TARGMAX=JOIN:2 :are supported by this server");
		h.client.joinChannels([{name: "#a"}, {name: "#b"}, {name: "#c"}]);
		expect(h.sent()).to.deep.equal(["JOIN #a,#b", "JOIN #c"]);

		h.transport.line(":irc.test 005 alice TARGMAX=JOIN: :are supported by this server");
		const many = Array.from({length: 40}, (_, i) => ({name: `#channel-number-${i}`}));
		h.client.joinChannels(many);
		const lines = h.sent();
		expect(lines.length).to.be.greaterThan(1);

		for (const line of lines) {
			expect(Buffer.byteLength(line)).to.be.at.most(500);
		}

		expect(lines.flatMap((l) => l.split(" ")[1].split(","))).to.deep.equal(
			many.map((c) => c.name)
		);
	});

	it("serves only the active channel at once; the rest as the fake-lag clock allows", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		h.sent();
		joinAll(h);

		// Active channel: its marker and history now. Nothing for the others yet: they
		// wait for the server to say which of them has been written to.
		const first = h.sent();
		expect(commandsOf(first)).to.deep.equal(["MARKREAD #seance", "CHATHISTORY LATEST"]);
		expect(first[1]).to.include("#seance");
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal([
			"#two",
			"#three",
			"#four",
		]);

		// One TARGETS, first in the queue, from the start of time (nothing is
		// held yet) to a day past now.
		const [targets] = collect(h, 1).map((s) => s.line);
		expect(targets).to.match(
			/^@label=tg\d+ CHATHISTORY TARGETS timestamp=1970-01-01T00:00:00\.000Z timestamp=2026-08-28T12:00:\d\d\.\d{3}Z 100$/
		);
		answerTargets(h, targets, [
			["#three", "2026-08-27T11:59:00.000Z"],
			["#two", "2026-08-27T11:58:00.000Z"],
		]);

		// Then, each job only once the clock has drained enough for it to
		// stay within the budget: the active channel's modes, then one
		// channel at a time, the most recently written first and the
		// unlisted one last, its marker query (while the server has not
		// volunteered it) ahead of its history, which it counts past.
		const sent = collect(h, 7);
		expect(commandsOf(sent.map((s) => s.line))).to.deep.equal([
			"MODE #seance",
			"MARKREAD #three",
			"CHATHISTORY LATEST",
			"MARKREAD #two",
			"CHATHISTORY LATEST",
			"MARKREAD #four",
			"CHATHISTORY LATEST",
		]);
		expect(fetched(sent.map((s) => s.line))).to.deep.equal(["#three", "#two", "#four"]);
		// Steady state: a channel's two commands drain in their own 4 s.
		expect(sent[5].at - sent[3].at).to.equal(4000);
		expect(pendingCatchup(h.client)).to.deep.equal([]);
		clock.tick(CATCHUP_STEP_COST_MS * 6);
		expect(h.sent()).to.deep.equal([]);
	});

	it("leaves the user's lines out of the wait: the clock never sits at the ceiling", function () {
		const h = connected();
		h.client.open(h.client.findChannel("#seance")!.id);
		joinAll(h);
		h.sent();
		let peak = 0;

		for (let t = 0; t < 30_000; t += 100) {
			clock.tick(100);
			peak = Math.max(peak, h.client.fakeLag.ahead());
		}

		// Before: two commands every 4 s held it at ~10 s for the whole catch-up.
		expect(peak).to.be.at.most(BACKGROUND_BUDGET_MS + 2000);
		expect(pendingCatchup(h.client)).to.deep.equal([]);

		// Three lines typed now are all read at once by the server.
		for (let i = 0; i < 3; i++) {
			h.client.send(`PRIVMSG #seance :line ${i}`);
		}

		expect(h.client.fakeLag.ahead()).to.be.below(h.client.fakeLag.model.ceiling * 1000);
	});

	it("holds a typing notice back while anything else waits for the clock", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		h.sent();
		const tagmsgs = () => h.sent().filter((l) => l.includes("TAGMSG"));

		// The catch-up is still queued: the notice gives way to it.
		h.client.typing(seance, "active");
		expect(tagmsgs()).to.deep.equal([]);
		clock.tick(4000);
		h.client.typing(seance, "active");
		expect(tagmsgs()).to.deep.equal([]);

		// Once the queue is through and the clock has room, it goes.
		clock.tick(60_000);
		expect(pendingCatchup(h.client)).to.deep.equal([]);
		h.client.typing(seance, "active");
		expect(tagmsgs()).to.have.length(1);
	});

	it("asks the oper-up queries one at a time, behind the catch-up's room", async function () {
		const h = connected();
		h.client.open(h.client.findChannel("#seance")!.id);
		joinAll(h);
		h.sent();
		h.transport.line(":alice!alice@host MODE alice +o");
		await Promise.resolve();
		expect(h.sent().filter((l) => l.includes("PRIVS"))).to.deep.equal([]);
		let privs: string[] = [];

		for (let i = 0; i < 200 && privs.length === 0; i++) {
			await clock.tickAsync(100);
			privs = h.sent().filter((l) => l.includes("PRIVS"));
		}

		expect(privs).to.have.length(1);
		expect(h.client.fakeLag.ahead()).to.be.at.most(BACKGROUND_BUDGET_MS);
	});

	it("puts the oper-up queries ahead of other channels' catch-up", async function () {
		const h = connected();
		h.client.open(h.client.findChannel("#seance")!.id);
		joinAll(h);
		const [targets] = collect(h, 1, isTargets).map((s) => s.line);
		answerTargets(h, targets, []); // the catch-up is queued now
		h.transport.line(":alice!alice@host MODE alice +o");
		const order: string[] = [];

		for (let i = 0; i < 300; i++) {
			await clock.tickAsync(100);
			order.push(...h.sent().filter((l) => /PRIVS|CHATHISTORY LATEST/.test(l)));
		}

		const privs = order.findIndex((l) => l.includes("PRIVS"));
		expect(privs, order.join(" | ")).to.be.at.least(0);
		expect(order.slice(privs).filter((l) => l.includes("LATEST"))).to.have.length(3);
	});

	it("sends a read marker ahead of the catch-up, and a Mark read from a notification at once", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		const [targets] = collect(h, 1, isTargets).map((s) => s.line);
		answerTargets(h, targets, []); // the catch-up is queued now
		h.transport.line(
			"@time=2026-08-27T12:00:01.000Z;msgid=r1 :bob!bob@host PRIVMSG #seance :read me"
		);
		const lines: string[] = [];

		for (let i = 0; i < 300 && lines.length < 8; i++) {
			clock.tick(100);
			lines.push(...h.sent());
		}

		const marker = lines.indexOf("MARKREAD #seance timestamp=2026-08-27T12:00:01.000Z");
		expect(marker, lines.join(" | ")).to.be.at.least(0);
		expect(lines.slice(0, marker).filter(isFetch)).to.deep.equal([]);

		// The push worker's Mark read: whatever the clock says.
		h.client.send("PRIVMSG #seance :busy");
		h.client.send("PRIVMSG #seance :busy");
		h.sent();
		h.client.markRead("#two", "2026-08-27T12:00:02.000Z");
		expect(h.sent()).to.deep.equal(["MARKREAD #two timestamp=2026-08-27T12:00:02.000Z"]);
	});

	for (const [who, every] of [
		["alice", 4000], // our own lines, echoed
		["bob", 2000], // someone else's, in the open channel
	] as const) {
		it(`a line from ${who} every ${
			every / 1000
		} s in the open channel does not starve the catch-up`, function () {
			const h = connected();
			const seance = h.client.findChannel("#seance")!;
			h.client.open(seance.id);
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, targets, []); // every channel waits for its fetch
			const caughtUp: string[] = [];
			const markers: string[] = [];

			// For longer than the catch-up needs on its own (each channel's
			// marker query goes ahead of its history, so the last history
			// fetch goes out at about 44 s at one background command per 4 s).
			for (let n = 1; n <= 48000 / every; n++) {
				if (who === "alice") {
					h.client.send(`PRIVMSG #seance :line ${n}`);
				}

				const time = new Date(Date.now()).toISOString();
				h.transport.line(
					`@time=${time};msgid=l${n} :${who}!${who}@host PRIVMSG #seance :line ${n}`
				);

				for (let i = 0; i < every / 100; i++) {
					clock.tick(100);

					for (const l of h.sent()) {
						if (isFetch(l)) {
							caughtUp.push(l.replace(/^@\S+ /, "").split(" ")[2]);
						} else if (l.startsWith("MARKREAD #seance timestamp=")) {
							markers.push(l);
						}
					}
				}
			}

			expect(caughtUp).to.include.members(["#two", "#three", "#four"]);
			// The marker keeps following the conversation all the same.
			expect(markers.length).to.be.at.least(3);
		});
	}

	it("lets a channel's marker jump the catch-up once per MARKREAD_JUMP_GAP_MS", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		const [targets] = collect(h, 1, isTargets).map((s) => s.line);
		answerTargets(h, targets, []);
		const first = (l: string) => l.startsWith("MARKREAD #seance") || isFetch(l);
		const bob = (n: number) =>
			h.transport.line(
				`@time=${new Date(
					Date.now()
				).toISOString()};msgid=b${n} :bob!bob@host PRIVMSG #seance :${n}`
			);

		// What goes first once the marker is queued (the debounce is over).
		const next = (n: number): string => {
			bob(n);
			clock.tick(MARKREAD_DEBOUNCE_MS - 100);
			h.sent();
			return collect(h, 1, first)[0].line;
		};

		expect(next(1)).to.match(/^MARKREAD #seance /);
		// Too soon after the last jump: behind the waiting fetches.
		expect(next(2)).to.satisfy(isFetch);
		clock.tick(MARKREAD_JUMP_GAP_MS);
		h.sent();
		expect(next(3)).to.match(/^MARKREAD #seance /);
	});

	it("never renews a push registration after it was unregistered", function () {
		const h = connected();
		h.client.open(h.client.findChannel("#seance")!.id);
		joinAll(h);
		h.sent();
		const keys = {p256dh: "pk", auth: "au"};
		h.client.webpushRegister("https://push.example/ep1", keys, {renewal: true});
		h.client.webpushUnregister("https://push.example/ep1");
		clock.tick(60_000);
		const push = h.transport.sent.filter((l) => l.startsWith("WEBPUSH"));
		expect(push).to.deep.equal(["WEBPUSH UNREGISTER https://push.example/ep1"]);
	});

	it("never sends MODE on JOIN; asks once when the channel is first opened", function () {
		const h = connected();
		h.sent();
		joinAll(h);
		clock.tick(CATCHUP_STEP_COST_MS * 8);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);

		const two = h.client.findChannel("#two")!;
		h.client.open(two.id);
		expect(collect(h, 1, (l) => l.startsWith("MODE")).map((s) => s.line)).to.deep.equal([
			"MODE #two",
		]);
		h.client.open(0);
		h.client.open(two.id);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);

		// A re-JOIN (after a reconnect: everything is PARTED, not removed)
		// asks again — #two is the active channel now, so behind its catch-up.
		h.transport.closed();
		register(h, CAPS);
		h.transport.line(":alice!alice@host JOIN #two");
		expect(nextBackground(h, (l) => l.startsWith("MODE"))).to.deep.equal(["MODE #two"]);
		h.client.open(h.client.findChannel("#two")!.id);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);
	});

	it("opening a waiting channel serves it immediately and keeps pacing the rest", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		h.sent();

		const four = h.client.findChannel("#four")!;
		clock.tick(1000);
		h.sent();
		h.client.open(four.id);
		const now = h.sent();
		// Opening marks the channel read up to its newest line (the JOIN), so
		// the stored marker is not asked for. The user is waiting for the
		// history: it goes out whatever the clock says; the modes wait.
		expect(commandsOf(now)).to.deep.equal(["CHATHISTORY LATEST"]);
		expect(now[0]).to.include("#four");
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#two", "#three"]);

		// The rest wait for the room those took (the debounced "read up to
		// here" markers are background work of their own).
		const catchupOnly = (l: string) => isFetch(l) || l === "MARKREAD #two";
		expect(commandsOf(collect(h, 2, catchupOnly).map((s) => s.line))).to.deep.equal([
			"MARKREAD #two",
			"CHATHISTORY LATEST",
		]);
	});

	it("skips the marker query when the server volunteered the marker before its turn", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		// What nefarious2 does for a logged-in account: the marker right
		// behind each JOIN, `*` when none is stored.
		h.transport.line(":alice!alice@host JOIN #seance");
		h.transport.line(":irc.test MARKREAD #seance timestamp=*");
		h.transport.line(":alice!alice@host JOIN #two");
		h.transport.line(":irc.test MARKREAD #two timestamp=2026-08-27T11:00:00.000Z");
		h.sent(); // #seance's history went out with its JOIN
		const lines = collect(h, 3).map((s) => s.line);
		expect(commandsOf(lines.filter((l) => !isTargets(l))), lines.join(" | ")).to.deep.equal([
			"MODE #seance",
			"CHATHISTORY LATEST",
		]);
		clock.tick(30_000);
		expect(h.sent().filter((l) => l.startsWith("MARKREAD"))).to.deep.equal([]);
	});

	it("drops channels that were left or removed while waiting, and everything on close", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		h.sent();

		// Our own PART removes the channel from the model (and the queue).
		h.transport.line(":alice!alice@host PART #two");
		expect(h.client.findChannel("#two")).to.equal(undefined);
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#three", "#four"]);
		// A channel that is merely no longer JOINED is skipped without spending a slot.
		h.client.findChannel("#three")!.state = ChanState.PARTED;
		const catchupOnly = (l: string) => isFetch(l) || /^MARKREAD #(three|four)/.test(l);
		expect(commandsOf(collect(h, 2, catchupOnly).map((s) => s.line))).to.deep.equal([
			"MARKREAD #four",
			"CHATHISTORY LATEST",
		]);

		h.client.findChannel("#three")!.state = ChanState.JOINED;
		h.transport.line(":alice!alice@host PART #four");
		h.transport.line(":alice!alice@host JOIN #four");
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#four"]);
		h.transport.closed();
		expect(pendingCatchup(h.client)).to.deep.equal([]);
		clock.tick(CATCHUP_STEP_COST_MS * 3);
		expect(h.sent()).to.deep.equal([]);
	});

	it("uses the reconnect path (LATEST, walking back) for channels that already had history", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		h.transport.line(":alice!alice@host JOIN #seance");
		h.sent();
		// History was requested on that JOIN; a live message is the newest reference.
		h.transport.line(
			"@time=2026-08-27T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
		);
		h.transport.closed();
		h.sent();
		const mark = h.transport.sent.length;
		register(h, CAPS);
		// The active channel's catch-up is pipelined right behind the JOIN,
		// before the echo; the echo then only adds the modes.
		const atRegistration = h.transport.sent.slice(mark);
		const join = atRegistration.findIndex((l) => l.startsWith("JOIN "));
		expect(join).to.be.greaterThan(-1);
		expect(atRegistration[join + 1]).to.match(/CHATHISTORY LATEST #seance \* \d+$/);
		// The marker is already known from before the drop: not asked again.
		expect(atRegistration).to.not.include("MARKREAD #seance");
		h.transport.line(":alice!alice@host JOIN #seance");
		expect(nextBackground(h)).to.deep.equal(["MODE #seance"]);
	});

	describe("ordered by CHATHISTORY TARGETS", function () {
		/** Run the clock for `ms`, answering every history fetch (an empty page) and TARGETS (nothing listed). */
		function settle(h: Harness, ms: number): void {
			for (let t = 0; t < ms; t += 100) {
				clock.tick(100);

				for (const line of h.sent()) {
					if (isTargets(line)) {
						answerTargets(h, line, []);
					} else if (isFetch(line)) {
						h.transport.line(`@label=${/^@label=(\S+) /.exec(line)![1]} ACK`);
					}
				}
			}
		}

		/** A first connection fully caught up, then one live message per channel at the given times. */
		function heldThenDropped(times: Record<string, string>): Harness {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			joinAll(h);
			settle(h, 60_000);

			for (const [name, time] of Object.entries(times)) {
				h.transport.line(
					`@time=${time};msgid=m${name.slice(1)} :bob!bob@host PRIVMSG ${name} :hi`
				);
			}

			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			return h;
		}

		const HELD = {
			"#seance": "2026-08-27T12:00:30.000Z",
			"#two": "2026-08-27T12:00:10.000Z",
			"#three": "2026-08-27T12:00:20.000Z",
			"#four": "2026-08-27T12:00:40.000Z",
		};

		it("on a reconnect fetches the channels with something new first, newest first, the quiet ones last", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			// From the start: events move what we hold, not the server's index.
			expect(targets).to.include("TARGETS timestamp=1970-01-01T00:00:00.000Z ");
			answerTargets(h, targets, [
				["#three", "2026-08-27T12:05:00.000Z"], // written to since
				["#seance", "2026-08-27T12:04:00.000Z"], // the active one: served already
				["#two", "2026-08-27T12:00:10.000Z"], // our newest is its newest
				["bob", "2026-08-27T12:03:00.000Z"], // a private conversation: not ours to fetch here
				["#four", "2026-08-27T12:00:40.000Z"], // our newest is its newest
			]);
			const lines = collect(h, 20).map((s) => s.line);
			// The index is a hint for the order, not proof: the quiet ones are
			// still fetched, behind the rest.
			expect(fetched(lines)).to.deep.equal(["#three", "#two", "#four"]);
			expect(pendingCatchup(h.client)).to.deep.equal([]);
			expect(h.client.findChannel("bob")).to.equal(undefined);
		});

		it("judges by the newest line the server stamped, not a local line on our clock", function () {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			joinAll(h);
			settle(h, 60_000);
			h.transport.line(
				"@time=2026-08-27T12:00:10.000Z;msgid=m2 :bob!bob@host PRIVMSG #two :hi"
			);
			// The socket dies unnoticed; bob writes at 12:03 (we never see it);
			// a local error line lands at 12:10 by our clock.
			h.client.pushMessage(h.client.findChannel("#two")!, {
				type: MessageType.ERROR,
				text: "Not sent",
				time: new Date("2026-08-27T12:10:00.000Z"),
			});
			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, targets, [["#two", "2026-08-27T12:03:00.000Z"]]);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.include("#two");
		});

		it("fetches a channel whose history never came, though it holds our last JOIN", function () {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);

			for (const name of CHANS) {
				h.transport.line(
					`@time=2026-08-27T12:00:00.000Z;msgid=j${name.slice(
						1
					)} :alice!alice@host JOIN ${name}`
				);
			}

			// The socket drops before the catch-up got to the others; all they
			// hold is the JOIN, stamped by the server.
			collect(h, 1, isTargets);
			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			expect(targets).to.include("TARGETS timestamp=1970-01-01T00:00:00.000Z ");
			answerTargets(h, targets, []);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#two",
				"#three",
				"#four",
			]);
		});

		it("does not take a catch-up the socket cut short for one that finished", function () {
			const h = heldThenDropped(HELD);
			collect(h, 1, isTargets);
			// Back, but before #two's turn: a live line, then the socket goes again.
			h.transport.line(
				"@time=2026-08-27T12:20:00.000Z;msgid=live :bob!bob@host PRIVMSG #two :still here"
			);
			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, targets, [["#two", "2026-08-27T12:20:00.000Z"]]);
			// What #two missed before that live line is still to fetch.
			expect(fetched(collect(h, 20).map((s) => s.line))).to.include("#two");
		});

		it("drops a reconnect walk the socket cuts short whole, and walks it again", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, targets, [["#three", "2026-08-27T12:59:00.000Z"]]);
			const [fetch] = collect(h, 1, isFetch).map((s) => s.line);
			const label = /^@label=(\S+) /.exec(fetch)![1];
			// The user is talking: the next page has to wait for room.
			h.client.send("PRIVMSG #seance :one");
			h.client.send("PRIVMSG #seance :two");
			const limit = Number(fetch.split(" ").at(-1));
			h.transport.line(`@label=${label} :irc.test BATCH +p chathistory #three`);

			for (let i = 0; i < limit; i++) {
				const time = new Date(Date.parse("2026-08-27T12:30:00.000Z") + i * 1000);
				h.transport.line(
					`@batch=p;time=${time.toISOString()};msgid=w${i} :bob!bob@host PRIVMSG #three :line ${i}`
				);
			}

			h.transport.line(":irc.test BATCH -p");
			const three = h.client.findChannel("#three")!;
			expect(h.client.background.keys()).to.include(`page:${three.id}`);
			h.transport.closed();
			// Landing the newest pages would make the next walk stop at them.
			expect(three.idByMsgid.has("w0")).to.equal(false);

			register(h, CAPS);
			h.sent();
			joinAll(h);
			const [again] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, again, [["#three", "2026-08-27T12:59:00.000Z"]]);
			const next = collect(h, 1, isFetch).map((s) => s.line);
			expect(fetched(next)).to.deep.equal(["#three"]);
		});

		it("does not vouch for a gap a short page stopped the walk in", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(h, targets, [["#three", "2026-08-27T12:59:00.000Z"]]);
			const [fetch] = collect(h, 1, isFetch).map((s) => s.line);
			const label = /^@label=(\S+) /.exec(fetch)![1];
			// Three lines, newer than what we hold, no end tag: a filtered page.
			h.transport.line(`@label=${label} :irc.test BATCH +q chathistory #three`);

			for (let i = 0; i < 3; i++) {
				h.transport.line(
					`@batch=q;time=2026-08-27T12:5${i}:00.000Z;msgid=q${i} :bob!bob@host PRIVMSG #three :line ${i}`
				);
			}

			h.transport.line(":irc.test BATCH -q");
			expect(h.client.findChannel("#three")!.idByMsgid.has("q2")).to.equal(true);
			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			const [again] = collect(h, 1, isTargets).map((s) => s.line);
			// Its newest is the one we hold now; what came before may not be.
			answerTargets(h, again, [["#three", "2026-08-27T12:52:00.000Z"]]);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.include("#three");
		});

		it("asks even when the clock has room for it the moment the first channel waits", function () {
			const h = connected(); // the lobby is open: no channel is served first
			joinAll(h);
			const lines = h.sent();
			const targets = lines.find(isTargets);
			expect(targets, lines.join(" | ")).to.not.equal(undefined);
			answerTargets(h, targets!, [["#three", "2026-08-27T11:59:00.000Z"]]);
			expect(fetched(collect(h, 20).map((s) => s.line))[0]).to.equal("#three");
		});

		it("is not answered by somebody else's unlabeled TARGETS", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			// A typed `/quote CHATHISTORY TARGETS` over a narrower window.
			answerTargets(h, "CHATHISTORY TARGETS", []);
			expect(pendingCatchup(h.client).map((c) => c.name)).to.have.members([
				"#two",
				"#three",
				"#four",
			]);
			answerTargets(h, targets, [
				["#four", "2026-08-27T12:50:00.000Z"],
				["#three", "2026-08-27T12:00:20.000Z"],
				["#two", "2026-08-27T12:00:10.000Z"],
			]);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#four",
				"#two",
				"#three",
			]);
		});

		it("walks the open channel's gap back without waiting for the queue", function () {
			const h = heldThenDropped(HELD);
			const fetch = [...h.transport.sent].reverse().find((l) => /LATEST #seance /.test(l))!;
			const label = /^@label=(\S+) /.exec(fetch)![1];
			const limit = Number(fetch.split(" ").at(-1));
			clock.tick(2000);
			h.transport.line(`@label=${label} :irc.test BATCH +s chathistory #seance`);

			for (let i = 0; i < limit; i++) {
				const time = new Date(Date.parse("2026-08-27T12:30:00.000Z") + i * 1000);
				h.transport.line(
					`@batch=s;time=${time.toISOString()};msgid=s${i} :bob!bob@host PRIVMSG #seance :line ${i}`
				);
			}

			h.transport.line(":irc.test BATCH -s");
			// Room for it under the ceiling, none under the background budget.
			expect(h.client.fakeLag.ahead()).to.be.above(BACKGROUND_BUDGET_MS - 2000);
			expect(h.sent().filter((l) => /CHATHISTORY BEFORE #seance /.test(l))).to.have.length(1);
		});

		it("orders a listed quiet channel behind one the answer leaves out, end tag or not", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			answerTargets(
				h,
				targets,
				[
					["#three", "2026-08-27T12:05:00.000Z"],
					["#two", "2026-08-27T12:00:10.000Z"],
				],
				false
			);
			// A listed row may be older than the channel's newest (a storage
			// server that timed out or hit its limit, with or without the tag):
			// #two is quiet by the answer, so last, and still fetched.
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#three",
				"#four",
				"#two",
			]);
		});

		it("goes in JOIN order when the server refuses, and does not ask that server again", function () {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			const label = /^@label=(\S+) /.exec(targets)![1];
			const shown = (socket.dispatch as sinon.SinonSpy).callCount;
			h.transport.line(
				`@label=${label} :irc.test FAIL CHATHISTORY INVALID_PARAMS TARGETS :TARGETS requires timestamp references`
			);
			// Nobody typed it: the FAIL is not shown.
			expect((socket.dispatch as sinon.SinonSpy).callCount).to.equal(shown);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#two",
				"#three",
				"#four",
			]);

			h.transport.closed();
			register(h, CAPS);
			h.sent();
			joinAll(h);
			const again = collect(h, 20).map((s) => s.line);
			expect(again.filter(isTargets)).to.deep.equal([]);
			expect(fetched(again)).to.deep.equal(["#seance", "#two", "#three", "#four"].slice(1));
		});

		it("gives up on a silent server after a few seconds and ignores a late answer", function () {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			joinAll(h);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			const asked = Date.now();
			const lines = collect(h, 20).map((s) => s.line);
			expect(fetched(lines)).to.deep.equal(["#two", "#three", "#four"]);
			expect(Date.now() - asked).to.be.at.least(TARGETS_TIMEOUT_MS);
			answerTargets(h, targets, [["#four", "2026-08-27T12:00:00.000Z"]]);
			clock.tick(60_000);
			expect(h.sent().filter(isFetch)).to.deep.equal([]);
		});

		it("serves a channel opened while it waits for the answer at once", function () {
			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			joinAll(h);
			collect(h, 1, isTargets);
			h.client.open(h.client.findChannel("#three")!.id);
			expect(fetched(h.sent())).to.deep.equal(["#three"]);
			expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#two", "#four"]);
		});

		it("fetches a channel joined after the question behind the busy ones, whatever the answer says", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			h.client.joinChannels([{name: "#five"}]);
			h.sent(); // the user's JOIN: not background work
			h.transport.line(":alice!alice@host JOIN #five");
			answerTargets(h, targets, [
				["#three", "2026-08-27T12:05:00.000Z"],
				["#four", "2026-08-27T12:00:40.000Z"],
				["#two", "2026-08-27T12:00:10.000Z"],
			]);
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#three",
				"#five",
				"#two",
				"#four",
			]);
		});

		it("never skips a channel, left out of the answer or listed as quiet, however late it answers", function () {
			const h = heldThenDropped(HELD);
			const [targets] = collect(h, 1, isTargets).map((s) => s.line);
			clock.tick(3500);
			answerTargets(h, targets, [
				["#three", "2026-08-27T12:05:00.000Z"],
				["#two", "2026-08-27T12:00:10.000Z"],
			]); // #four left out
			expect(fetched(collect(h, 20).map((s) => s.line))).to.deep.equal([
				"#three",
				"#four",
				"#two",
			]);
		});

		it("is not asked to order a single channel, nor while the server replays the gap", function () {
			const one = setup({join: "#seance,#two", fakeLag: IRCU_FAKE_LAG});
			register(one, CAPS);
			one.client.open(one.client.findChannel("#seance")!.id);
			one.transport.line(":alice!alice@host JOIN #seance");
			one.transport.line(":alice!alice@host JOIN #two");
			const lines = [...one.sent()];

			for (let i = 0; i < 100; i++) {
				clock.tick(100);
				lines.push(...one.sent());
			}

			expect(lines.filter(isTargets)).to.deep.equal([]);
			expect(fetched(lines)).to.deep.equal(["#seance", "#two"]);

			const h = connected();
			h.client.open(h.client.findChannel("#seance")!.id);
			h.client.serverReplay = true;
			h.transport.line(":alice!alice@host JOIN #two");
			h.transport.line(":alice!alice@host JOIN #three");
			h.client.serverReplay = false;
			expect(
				collect(h, 20)
					.map((s) => s.line)
					.filter(isTargets)
			).to.deep.equal([]);
		});
	});
});
