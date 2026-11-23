import {expect} from "chai";
import sinon from "sinon";
import {MessageType} from "../../shared/types/msg";
import type {WhoisProfileAnswer} from "../../shared/types/whois";
import {setup, register, type Harness} from "./support";

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

/** The label of the last line sent. */
function lastLabel(h: Harness): string {
	return /^@label=(\S+) /.exec(h.transport.sent.at(-1) ?? "")?.[1] ?? "";
}

/** Answer the last line sent with a labeled batch around `lines`. */
function reply(h: Harness, ref: string, ...lines: string[]): void {
	h.transport.lines(
		`@label=${lastLabel(h)} :irc.test BATCH +${ref} labeled-response`,
		...lines.map((line) => `@batch=${ref} ${line}`),
		`:irc.test BATCH -${ref}`
	);
}

const BOB = [
	":irc.test 311 alice bob bobby example.net * :Bob Example",
	":irc.test 319 alice bob :@#seance #linux",
	":irc.test 312 alice bob hub.test :Test hub",
	":irc.test 301 alice bob :lunch",
	":irc.test 671 alice bob :is using a secure connection",
	":irc.test 330 alice bob bobacct :is logged in as",
	":irc.test 317 alice bob 180 1700000000 :seconds idle, signon time",
	":irc.test 318 alice bob :End of /WHOIS list.",
];

function welcomed(caps?: string): Harness {
	const h = setup();
	register(h, caps);
	h.dispatch.resetHistory();
	return h;
}

const profiles = (h: Harness) => h.payloads<WhoisProfileAnswer>("whois:profile");

describe("the user profile's quiet WHOIS", function () {
	it("reads a labeled WHOIS into whois:profile and prints nothing", async function () {
		const h = welcomed();
		h.client.requestProfile("bob");
		await settle();
		expect(h.transport.sent.at(-1)).to.equal(`@label=${lastLabel(h)} WHOIS bob bob`);

		reply(h, "w", ...BOB);
		await settle();

		const [profile] = profiles(h);
		expect(profile.status).to.equal("online");
		expect(profile.nick).to.equal("bob");
		expect(profile.whois).to.include({
			nick: "bob",
			ident: "bobby",
			hostname: "example.net",
			real_name: "Bob Example",
			server: "hub.test",
			away: "lunch",
			secure: true,
			account: "bobacct",
			channels: "@#seance #linux",
			logonTime: 1700000000000,
		});
		expect(h.messages()).to.be.empty;
	});

	it("asks WHOWAS when the nick is offline, and prints no error", async function () {
		const h = welcomed();
		h.client.requestProfile("carol");
		await settle();
		reply(
			h,
			"a",
			":irc.test 401 alice carol :No such nick",
			":irc.test 318 alice carol :End of /WHOIS list."
		);
		await settle();

		expect(h.transport.sent.at(-1)).to.equal(`@label=${lastLabel(h)} WHOWAS carol 1`);
		reply(
			h,
			"b",
			":irc.test 314 alice carol carol old.example * :Carol",
			":irc.test 312 alice carol hub.test :Mon Nov 23 09:14:00 2026",
			":irc.test 369 alice carol :End of WHOWAS"
		);
		await settle();

		const [profile] = profiles(h);
		expect(profile.status).to.equal("offline");
		expect(profile.whois).to.include({nick: "carol", hostname: "old.example", whowas: true});
		expect(h.messages()).to.be.empty;
	});

	it("joins a lookup under way, reuses a fresh answer, and asks again on Refresh", async function () {
		const h = welcomed();
		h.client.requestProfile("bob");
		h.client.requestProfile("BOB");
		await settle();
		expect(h.transport.sent.filter((l) => l.includes("WHOIS"))).to.have.length(1);

		reply(h, "w", ...BOB);
		await settle();
		expect(profiles(h)).to.have.length(2);

		h.client.requestProfile("bob");
		await settle();
		expect(h.transport.sent.filter((l) => l.includes("WHOIS"))).to.have.length(1);
		expect(profiles(h)).to.have.length(3);

		h.client.requestProfile("bob", true);
		await settle();
		expect(h.transport.sent.filter((l) => l.includes("WHOIS"))).to.have.length(2);
	});

	it("says unavailable, sending nothing, without labeled-response", async function () {
		const h = welcomed("batch message-tags server-time");
		h.client.requestProfile("bob");
		await settle();
		expect(h.sent()).to.be.empty;
		expect(profiles(h).map((p) => p.status)).to.deep.equal(["unavailable"]);
	});

	it("keeps a batch that closes after the timeout out of the chat", async function () {
		const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});

		try {
			const h = welcomed();
			h.client.requestProfile("bob");
			await settle();
			const label = lastLabel(h);
			clock.tick(30_001);
			await settle();
			expect(profiles(h).map((p) => p.status)).to.deep.equal(["unavailable"]);

			h.transport.lines(
				`@label=${label} :irc.test BATCH +late labeled-response`,
				...BOB.map((line) => `@batch=late ${line}`),
				":irc.test BATCH -late"
			);
			await settle();
			expect(h.messages()).to.be.empty;
		} finally {
			clock.restore();
		}
	});

	it("calls a 263 unavailable, not offline", async function () {
		const h = welcomed();
		h.client.requestProfile("bob");
		await settle();
		reply(h, "t", ":irc.test 263 alice WHOIS :Server load is temporarily too heavy");
		await settle();
		expect(h.transport.sent.some((l) => l.includes("WHOWAS"))).to.equal(false);
		expect(profiles(h).map((p) => p.status)).to.deep.equal(["unavailable"]);
	});

	it("forgets a nick that changes hands, dropping a lookup under way", async function () {
		const h = welcomed();
		h.client.requestProfile("bob");
		await settle();
		const label = lastLabel(h);
		h.transport.line(":bob!bobby@example.net NICK robert");
		expect(h.payloads("whois:profile:stale")).to.deep.include({
			network: h.client.uuid,
			nick: "bob",
		});

		h.transport.lines(
			`@label=${label} :irc.test BATCH +w labeled-response`,
			...BOB.map((line) => `@batch=w ${line}`),
			":irc.test BATCH -w"
		);
		await settle();
		expect(profiles(h)).to.be.empty;

		h.client.requestProfile("bob");
		await settle();
		expect(h.transport.sent.filter((l) => l.includes("WHOIS"))).to.have.length(2);
	});

	it("keeps the time of a reused answer", async function () {
		const h = welcomed();
		h.client.requestProfile("bob");
		await settle();
		reply(h, "w", ...BOB);
		await settle();
		h.client.requestProfile("bob");
		await settle();
		const [first, again] = profiles(h);
		expect(again.at).to.equal(first.at);
	});

	it("leaves a typed /whois printing as before", function () {
		const h = welcomed();
		h.transport.lines(
			":irc.test 311 alice bob bobby example.net * :Bob Example",
			":irc.test 318 alice bob :End of /WHOIS list."
		);
		expect(h.messages().map((msg) => msg.type)).to.include(MessageType.WHOIS);
		expect(profiles(h)).to.be.empty;
	});
});
