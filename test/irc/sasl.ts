import {expect} from "chai";
import {
	base64Encode,
	chunkAuthenticate,
	encodePlain,
	isServerSideFailure,
	mechanismOffered,
	SASL_CHUNK_BYTES,
	SaslAuth,
	SaslResult,
} from "../../client/js/irc/sasl";
import {IrcMessage, parseLine} from "../../client/js/irc/message";

function msg(line: string): IrcMessage {
	const parsed = parseLine(line);

	if (!parsed) {
		throw new Error(`bad test line: ${line}`);
	}

	return parsed;
}

function feed(auth: SaslAuth, line: string): SaslResult {
	return auth.handle(msg(line));
}

/** Decode base64 the way Node does, for comparison with the browser-safe encoder. */
function nodeBase64(s: string): string {
	return Buffer.from(s, "utf8").toString("base64");
}

describe("irc/sasl", function () {
	describe("base64Encode / encodePlain", function () {
		it("matches Node's base64 for ASCII", function () {
			expect(base64Encode("hello")).to.equal(nodeBase64("hello"));
			expect(base64Encode("")).to.equal("");
		});

		it("encodes UTF-8 bytes, not UTF-16 code units", function () {
			const s = "pässwörd ☃ 🔑";
			expect(base64Encode(s)).to.equal(nodeBase64(s));
		});

		it("frames PLAIN as authzid NUL authcid NUL password", function () {
			const encoded = encodePlain("alice", "s3cret");
			expect(Buffer.from(encoded, "base64").toString("utf8")).to.equal(
				"alice\0alice\0s3cret"
			);
		});

		it("keeps unicode credentials intact", function () {
			const encoded = encodePlain("ålice", "pässwörd 🔑");
			expect(Buffer.from(encoded, "base64").toString("utf8")).to.equal(
				"ålice\0ålice\0pässwörd 🔑"
			);
		});
	});

	describe("chunkAuthenticate", function () {
		it("sends a short payload in one line", function () {
			expect(chunkAuthenticate("YWJj")).to.deep.equal(["AUTHENTICATE YWJj"]);
		});

		it("sends an empty payload as a lone +", function () {
			expect(chunkAuthenticate("")).to.deep.equal(["AUTHENTICATE +"]);
		});

		it("splits at 400 bytes and terminates an exact multiple with +", function () {
			const payload = "A".repeat(SASL_CHUNK_BYTES);
			expect(chunkAuthenticate(payload)).to.deep.equal([
				`AUTHENTICATE ${payload}`,
				"AUTHENTICATE +",
			]);

			const twoAndABit = "B".repeat(SASL_CHUNK_BYTES * 2 + 1);
			const lines = chunkAuthenticate(twoAndABit);
			expect(lines).to.have.length(3);
			expect(lines[0]).to.equal(`AUTHENTICATE ${"B".repeat(SASL_CHUNK_BYTES)}`);
			expect(lines[1]).to.equal(`AUTHENTICATE ${"B".repeat(SASL_CHUNK_BYTES)}`);
			expect(lines[2]).to.equal("AUTHENTICATE B");
		});

		it("does not add + when the last chunk is short", function () {
			const lines = chunkAuthenticate("C".repeat(SASL_CHUNK_BYTES - 1));
			expect(lines).to.have.length(1);
			expect(lines[0].endsWith("C")).to.equal(true);
		});
	});

	describe("mechanismOffered", function () {
		it("is false when the cap is not offered at all", function () {
			expect(mechanismOffered("PLAIN", undefined)).to.equal(false);
		});

		it("is true when there is no 302 value (no CAP 302, e.g. nefarious2 master)", function () {
			expect(mechanismOffered("PLAIN", "")).to.equal(true);
			expect(mechanismOffered("EXTERNAL", "")).to.equal(true);
		});

		it("requires the mechanism to be listed when a value is present", function () {
			expect(mechanismOffered("PLAIN", "PLAIN,EXTERNAL")).to.equal(true);
			expect(mechanismOffered("PLAIN", "plain")).to.equal(true);
			expect(mechanismOffered("PLAIN", "EXTERNAL")).to.equal(false);
			expect(mechanismOffered("EXTERNAL", "PLAIN")).to.equal(false);
		});
	});

	describe("SaslAuth (PLAIN)", function () {
		it("opens with AUTHENTICATE PLAIN and answers + with the credentials", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "s3cret"});
			expect(auth.start()).to.deep.equal(["AUTHENTICATE PLAIN"]);
			expect(auth.done).to.equal(false);

			const res = feed(auth, "AUTHENTICATE +");
			expect(res.send).to.deep.equal([`AUTHENTICATE ${encodePlain("alice", "s3cret")}`]);
			expect(res.done).to.equal(false);
		});

		it("chunks a long response at exactly 400 bytes", function () {
			// 300-char account + 300-char password: base64 of 903 bytes = 1204 chars.
			const account = "a".repeat(300);
			const password = "b".repeat(300);
			const auth = new SaslAuth("PLAIN", {account, password});
			auth.start();

			const res = feed(auth, "AUTHENTICATE +");
			const payload = encodePlain(account, password);
			expect(payload.length).to.equal(1204);
			expect(res.send).to.have.length(4);
			expect(res.send.slice(0, 3).every((l) => l.length === 13 + 400)).to.equal(true);
			expect(res.send[3]).to.equal(`AUTHENTICATE ${payload.slice(1200)}`);
			expect(res.send.map((l) => l.slice(13)).join("")).to.equal(payload);
		});

		it("sends a trailing + when the response is an exact multiple of 400", function () {
			// base64 length is a multiple of 4; 400 chars = 300 raw bytes.
			// authzid NUL authcid NUL password = 2*|acct| + |pw| + 2 = 300.
			const account = "x".repeat(100);
			const password = "y".repeat(98);
			const auth = new SaslAuth("PLAIN", {account, password});
			auth.start();

			const res = feed(auth, "AUTHENTICATE +");
			expect(encodePlain(account, password).length).to.equal(400);
			expect(res.send).to.have.length(2);
			expect(res.send[1]).to.equal("AUTHENTICATE +");
		});

		it("reports success on 903", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();
			feed(auth, "AUTHENTICATE +");
			feed(
				auth,
				":irc.test 900 alice alice!alice@host alice :You are now logged in as alice"
			);

			const res = feed(auth, ":irc.test 903 alice :SASL authentication successful");
			expect(res).to.include({done: true, ok: true});
			expect(auth.done).to.equal(true);
		});

		it("surfaces 900 as info without ending", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();
			feed(auth, "AUTHENTICATE +");

			const res = feed(
				auth,
				":irc.test 900 alice alice!alice@host alice :You are now logged in as alice"
			);
			expect(res.done).to.equal(false);
			expect(res.info).to.equal("You are now logged in as alice");
		});

		for (const [numeric, text] of [
			["902", "You must use a nick assigned to you"],
			["904", "SASL authentication failed"],
			["905", "SASL message too long"],
			["906", "SASL authentication aborted"],
			["907", "You have already authenticated using SASL"],
		]) {
			it(`fails on ${numeric} with the server's text`, function () {
				const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
				auth.start();
				feed(auth, "AUTHENTICATE +");

				const res = feed(auth, `:irc.test ${numeric} alice :${text}`);
				expect(res).to.include({done: true, ok: false, error: text});
				expect(res.send).to.deep.equal([]);
				expect(auth.done).to.equal(true);
			});
		}

		it("surfaces 908 as info", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();

			const res = feed(
				auth,
				":irc.test 908 alice PLAIN,EXTERNAL :are available SASL mechanisms"
			);
			expect(res.done).to.equal(false);
			expect(res.info).to.equal("Available SASL mechanisms: PLAIN,EXTERNAL");
		});

		it("aborts with AUTHENTICATE * (timeout) and reports failure", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();

			const res = auth.abort("timed out");
			expect(res).to.deep.equal({
				send: ["AUTHENTICATE *"],
				done: true,
				ok: false,
				error: "timed out",
			});
			expect(auth.done).to.equal(true);

			// Once done, nothing more is sent or reported.
			expect(auth.abort().send).to.deep.equal([]);
			expect(feed(auth, ":irc.test 906 alice :SASL authentication aborted").done).to.equal(
				true
			);
		});

		it("aborts on an unexpected non-empty challenge", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();

			const res = feed(auth, "AUTHENTICATE c29tZXRoaW5n");
			expect(res.send).to.deep.equal(["AUTHENTICATE *"]);
			expect(res).to.include({done: true, ok: false});
		});

		it("ignores unrelated messages and a second AUTHENTICATE +", function () {
			const auth = new SaslAuth("PLAIN", {account: "alice", password: "pw"});
			auth.start();
			expect(
				feed(auth, ":irc.test NOTICE * :*** Looking up your hostname").send
			).to.deep.equal([]);
			feed(auth, "AUTHENTICATE +");
			expect(feed(auth, "AUTHENTICATE +").send).to.deep.equal([]);
			expect(auth.done).to.equal(false);
		});
	});

	describe("SaslAuth (EXTERNAL stub)", function () {
		it("sends AUTHENTICATE EXTERNAL then an empty response", function () {
			const auth = new SaslAuth("EXTERNAL");
			expect(auth.start()).to.deep.equal(["AUTHENTICATE EXTERNAL"]);
			expect(feed(auth, "AUTHENTICATE +").send).to.deep.equal(["AUTHENTICATE +"]);
		});
	});
});

describe("isServerSideFailure (a failure another connection may fix)", function () {
	it("is the server's timeout, its unreachable services and an abort it sent", function () {
		expect(
			isServerSideFailure("904", "SASL authentication failed: request timed out")
		).to.equal(true);
		expect(
			isServerSideFailure("904", "SASL authentication failed: service unavailable")
		).to.equal(true);
		expect(isServerSideFailure("906", "SASL authentication aborted")).to.equal(true);
	});

	it("is not a refusal, a bare 904 or the other failure numerics", function () {
		expect(isServerSideFailure("904", "SASL authentication failed")).to.equal(false);
		expect(
			isServerSideFailure("904", "SASL authentication failed: invalid credentials")
		).to.equal(false);
		expect(isServerSideFailure("902", "You must use a nick assigned to you")).to.equal(false);
		expect(isServerSideFailure("905", "SASL message too long")).to.equal(false);
		expect(isServerSideFailure("907", "You have already authenticated")).to.equal(false);
	});

	it("marks the result: retryable, or a bare 904 as unexplained", function () {
		const run = (line: string) => {
			const auth = new SaslAuth("PLAIN", {account: "a", password: "b"});
			auth.start();
			return auth.handle(msg(line));
		};

		expect(run(":s 904 n :SASL authentication failed: request timed out")).to.include({
			retryable: true,
		});
		expect(run(":s 904 n :SASL authentication failed")).to.include({unexplained: true});
		const tooLong = run(":s 905 n :SASL message too long");
		expect(tooLong.retryable).to.equal(undefined);
		expect(tooLong.unexplained).to.equal(undefined);
	});
});
