import {expect} from "chai";
import {readFileSync} from "node:fs";
import sinon from "sinon";
import {register, setup, type Harness} from "./support";
import {SYNC_KEY} from "../../client/js/sync/file";
import {
	forgetSyncNetwork,
	readState,
	writeCopy,
	writeState,
	defaultState,
} from "../../client/js/sync/state";

const CAPS =
	"server-time message-tags batch labeled-response draft/metadata-2 draft/authtoken standard-replies";
const LOGIN = ":irc.test 900 alice alice!a@h alice :You are now logged in as alice";
const POINTER = `1 https://files.example/f/1 ${"A".repeat(43)} 1800000000000`;

describe("the settings sync pointer on the wire (seance/sync)", function () {
	function connected(version?: string, login = true): Harness {
		const h = setup({join: ""});
		register(h, CAPS, login ? [LOGIN] : [], version);
		return h;
	}

	const pointers = (h: Harness) => h.payloads<{network: string}>("sync:pointer");

	it("is unknown until this connection has read it", function () {
		expect(connected().client.syncPointer).to.equal(undefined);
	});

	it("reads the login read's answer for our own nick", function () {
		const h = connected();
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);

		expect(h.client.syncPointer).to.equal(POINTER);
		expect(pointers(h)).to.deep.equal([{network: h.client.uuid}]);
	});

	it("reads a key that is not set as empty", function () {
		const h = connected();
		h.transport.line(`:irc.test 766 alice alice ${SYNC_KEY} :key not set`);

		expect(h.client.syncPointer).to.equal("");
		expect(pointers(h)).to.have.length(1);
	});

	it("takes a notification that names our nick, whatever visibility it says", function () {
		const h = connected();
		h.transport.line(`:irc.test METADATA alice ${SYNC_KEY} * :${POINTER}`);

		expect(h.client.syncPointer).to.equal(POINTER);
	});

	it("takes a private notification under another nick: another device of the account", function () {
		// nefarious2 sends a private key's change to the account's own
		// sessions only, under the nick of the one that set it.
		const h = connected();
		h.transport.line(`:irc.test METADATA alice_ ${SYNC_KEY} private :${POINTER}`);

		expect(h.client.syncPointer).to.equal(POINTER);
		expect(pointers(h)).to.deep.equal([{network: h.client.uuid}]);
	});

	it("ignores someone else's key of the same name", function () {
		const h = connected();
		h.transport.line(`:irc.test METADATA mallory ${SYNC_KEY} * :${POINTER}`);
		h.transport.line(`:irc.test 761 alice mallory ${SYNC_KEY} * :${POINTER}`);

		expect(h.client.syncPointer).to.equal(undefined);
		expect(pointers(h)).to.deep.equal([]);
	});

	it("says nothing in the window for its replies", function () {
		const h = connected();
		const before = h.messages().length;
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.transport.line(`:irc.test 766 alice alice ${SYNC_KEY} :key not set`);
		h.transport.line(`:irc.test 770 alice ${SYNC_KEY}`);

		expect(h.messages().length).to.equal(before);
	});

	it("does not announce a value it already holds", function () {
		const h = connected();
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.transport.line(`:irc.test METADATA alice ${SYNC_KEY} * :${POINTER}`);

		expect(pointers(h)).to.have.length(1);
	});

	it("reads the pointer again on request, and says when the server answered", async function () {
		const h = connected();
		h.transport.line(`:irc.test 766 alice alice ${SYNC_KEY} :no matching key`);
		let answered = false;
		const read = h.client.readSyncPointer().then(() => void (answered = true));

		expect(h.sent()).to.include(`METADATA * GET ${SYNC_KEY}`);
		await Promise.resolve();
		expect(answered).to.equal(false);

		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		await read;

		expect(h.client.syncPointer).to.equal(POINTER);
	});

	it("does not leave a reader waiting when the connection goes", async function () {
		const h = connected();
		const read = h.client.readSyncPointer();
		h.transport.closed();
		await read;

		expect(h.client.syncPointer).to.equal(undefined);
	});

	it("writes the pointer private, and holds it as read from then on", function () {
		const h = connected();

		expect(h.client.canWriteSyncPointer).to.equal(true);
		expect(h.client.writeSyncPointer(POINTER)).to.equal(true);
		expect(h.sent()).to.include(`METADATA * SET ${SYNC_KEY} private :${POINTER}`);
		expect(h.client.syncPointer).to.equal(POINTER);
	});

	it("reads it again when the server refuses our write, and only then", function () {
		const h = connected();
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.transport.line(`:irc.test FAIL METADATA KEY_INVALID ${SYNC_KEY} :not ours`);

		expect(h.client.syncPointer).to.equal(POINTER);

		h.client.writeSyncPointer(`${POINTER}0`);
		h.transport.line(`:irc.test FAIL METADATA LIMIT_REACHED alice ${SYNC_KEY} :Too many keys`);

		expect(h.client.syncPointer).to.equal(undefined);
		// Behind whatever else waits.
		const read = (line: string) => line === `METADATA * GET ${SYNC_KEY}`;
		expect(
			h.sent().some(read) || h.client.background.keys().includes(`metadata:get:${SYNC_KEY}`)
		).to.equal(true);
		expect(pointers(h)).to.have.length(2);
	});

	it("reads it again when nefarious2's rate limit, which names no key, answers our write", function () {
		const h = connected();
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.client.writeSyncPointer(`${POINTER}0`);
		h.transport.line(
			":irc.test FAIL METADATA RATE_LIMITED :Too many metadata commands, slow down"
		);

		expect(h.client.syncPointer).to.equal(undefined);
	});

	it("asks again later when the read after a refused write is refused too", function () {
		const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

		try {
			const h = connected();
			h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
			h.client.writeSyncPointer(`${POINTER}0`);
			h.transport.line(
				`:irc.test FAIL METADATA LIMIT_REACHED alice ${SYNC_KEY} :Too many keys`
			);
			clock.tick(10_000);
			const read = (line: string) => line === `METADATA * GET ${SYNC_KEY}`;
			expect(h.sent().some(read)).to.equal(true);
			h.transport.line(":irc.test FAIL METADATA RATE_LIMITED :slow down");
			clock.tick(60_000);

			expect(h.sent().some(read)).to.equal(true);

			h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);

			expect(h.client.syncPointer).to.equal(POINTER);
		} finally {
			clock.restore();
		}
	});

	it("subscribes and reads the account's keys after a login on the live connection", function () {
		const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
		const h = connected(undefined, false);

		try {
			h.transport.line(":irc.test 900 alice alice!a@h alice :You are now logged in as alice");
			clock.tick(60_000);
		} finally {
			clock.restore();
		}

		const sent = h.sent();
		expect(h.client.account).to.equal("alice");
		expect(
			sent.some((line) => line.startsWith("METADATA * SUB ") && line.includes(SYNC_KEY))
		).to.equal(true);
		expect(
			sent.some((line) => line.startsWith("METADATA * GET ") && line.includes(SYNC_KEY))
		).to.equal(true);
	});

	it("forgets the pointer when the connection logs in as another account or out", function () {
		const h = connected();
		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.transport.line(":irc.test 900 alice alice!a@h bob :You are now logged in as bob");

		expect(h.client.account).to.equal("bob");
		expect(h.client.syncPointer).to.equal(undefined);

		h.transport.line(`:irc.test 761 alice alice ${SYNC_KEY} private :${POINTER}`);
		h.transport.line(":irc.test 901 alice alice!a@h :You are now logged out");

		expect(h.client.syncPointer).to.equal(undefined);
	});

	it("does not write it where the server cannot keep a key private", function () {
		const h = connected("ergo-v2.14.0");

		expect(h.client.canWriteSyncPointer).to.equal(false);
		expect(h.client.writeSyncPointer(POINTER)).to.equal(false);
		expect(h.sent().filter((line) => line.includes(SYNC_KEY))).to.deep.equal([]);
	});

	it("does not write it without an account", function () {
		expect(connected(undefined, false).client.canWriteSyncPointer).to.equal(false);
	});

	it("asks for the file host's token with no channel", async function () {
		const h = connected();
		const token = h.client.backgroundToken();

		expect(h.sent()).to.include("TOKEN GENERATE FILEHOST");
		h.transport.line(":irc.test TOKEN GENERATE FILEHOST :secret");
		expect(await token).to.equal("secret");
	});
});

describe("the device's sync state (sync/state.ts)", function () {
	function storage() {
		const data = new Map<string, string>();
		return {
			data,
			get: (key: string) => data.get(key) ?? null,
			set: (key: string, value: string) => void data.set(key, value),
			remove: (key: string) => void data.delete(key),
		};
	}

	it("reads anything unreadable as sync off", function () {
		const s = storage();

		for (const raw of ["{", "[]", "5", '{"home":7}']) {
			s.set("thelounge.state.sync", raw);
			expect(readState(s), raw).to.deep.equal(defaultState());
		}
	});

	it("switches sync off when its home network is removed, before its entries go", function () {
		const s = storage();
		writeState(s, {...defaultState(), home: "home", account: "alice", never: ["home", "x"]});
		writeCopy(s, {"mute:#a": {t: 5, v: true}});
		forgetSyncNetwork(s, "elsewhere");

		expect(readState(s).home).to.equal("home");

		forgetSyncNetwork(s, "home");

		expect(readState(s)).to.deep.equal({...defaultState(), never: ["x"]});
		expect(s.data.has("thelounge.state.sync.entries")).to.equal(false);
	});
});

describe("which settings roam (settings.ts `sync`)", function () {
	// settings.ts needs a document, so its marks are read from the source.
	const source = readFileSync("client/js/settings.ts", "utf8");
	const body = source.slice(
		source.indexOf("const defaultConfig = {"),
		source.indexOf("export const config")
	);
	const names = [...body.matchAll(/^\t(\w+): \{\n((?:\t\t.*\n|\n)*?)\t\},/gm)].map((m) => ({
		name: m[1],
		roams: /^\t\tsync: true,$/m.test(m[2]),
	}));

	it("marks 29 settings as roaming and leaves 22 on the device", function () {
		expect(names).to.have.length(51);
		expect(names.filter((s) => s.roams).map((s) => s.name)).to.deep.equal([
			"autocomplete",
			"nickPostfix",
			"coloredNicks",
			"highlightMessages",
			"highlights",
			"highlightExceptions",
			"awayMessage",
			"locale",
			"markdown",
			"motd",
			"notifyAllMessages",
			"showSeconds",
			"use12hClock",
			"statusMessages",
			"pushKeyChange",
			"translateInto",
			"translateAlsoRead",
			"translateFormality",
			"ownMessages",
			"theme",
			"messageLayout",
			"psGroupMessages",
			"psWords",
			"media",
			"mediaReveal",
			"avatarLoad",
			"uploadCanvas",
			"sendTypingNotifications",
			"searchEnabled",
		]);
	});

	it("never lets what a device runs or injects roam", function () {
		const stays = names.filter((s) => !s.roams).map((s) => s.name);

		expect(stays).to.include.members([
			"userStyles",
			"enableScripting",
			"keepConnected",
			"keepPrivateConversations",
			"translationEnabled",
			"notification",
			"fontSize",
		]);
	});
});
