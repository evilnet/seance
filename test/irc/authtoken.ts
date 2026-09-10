/**
 * draft/authtoken + draft/FILEHOST (client/js/irc/authtoken.ts,
 * handlers/token.ts, the FILEHOST path in client/js/upload.ts).
 *
 * The network advertises an upload host in ISUPPORT; `TOKEN GENERATE
 * FILEHOST [#chan]` fetches a one-shot bearer token; the file goes up as
 * a raw POST with it and comes back as `201 Created` + `Location`.
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import {TokenRequests, filehostUrlOf} from "../../client/js/irc/authtoken";
import {SEANCE_CAPS} from "../../client/js/irc/caps";
import {ISupport} from "../../client/js/irc/isupport";
import {uploadFilehost, UploadError} from "../../client/js/upload";
import {ALL_CAPS, register, setup} from "./support";

function isupportWith(...tokens: string[]): ISupport {
	const is = new ISupport();
	is.apply(["alice", ...tokens, "are supported by this server"]);
	return is;
}

describe("draft/authtoken", function () {
	afterEach(function () {
		sinon.restore();
	});

	describe("filehostUrlOf", function () {
		it("reads draft/FILEHOST, then soju's spelling", function () {
			expect(
				filehostUrlOf(isupportWith("draft/FILEHOST=https://up.example/f"), true)
			).to.equal("https://up.example/f");
			expect(
				filehostUrlOf(isupportWith("soju.im/FILEHOST=https://up.example/s"), true)
			).to.equal("https://up.example/s");
			expect(
				filehostUrlOf(
					isupportWith(
						"soju.im/FILEHOST=https://up.example/s",
						"draft/FILEHOST=https://up.example/f"
					),
					true
				)
			).to.equal("https://up.example/f");
		});

		it("refuses plain http over an encrypted connection, as the draft requires", function () {
			const is = isupportWith("draft/FILEHOST=http://up.example/f");
			expect(filehostUrlOf(is, true)).to.be.undefined;
			expect(filehostUrlOf(is, false)).to.equal("http://up.example/f");
		});

		it("ignores other schemes and garbage", function () {
			expect(filehostUrlOf(isupportWith("draft/FILEHOST=ftp://up.example/f"), false)).to.be
				.undefined;
			expect(filehostUrlOf(isupportWith("draft/FILEHOST=not a url"), false)).to.be.undefined;
			expect(filehostUrlOf(isupportWith("CHANTYPES=#"), false)).to.be.undefined;
		});
	});

	describe("TokenRequests", function () {
		it("answers requests in order per service and clears the timer", async function () {
			const q = new TokenRequests(1000);
			const sent: string[] = [];
			const a = q.request("FILEHOST", () => sent.push("a"));
			const b = q.request("FILEHOST", () => sent.push("b"));
			const other = q.request("example.com/QDB", () => sent.push("q"));
			expect(sent).to.deep.equal(["a", "b", "q"]);
			expect(q.size).to.equal(3);

			expect(q.deliver("filehost", "tok-a")).to.equal(true); // case-insensitive
			expect(q.deliver("example.com/qdb", "tok-q")).to.equal(true);
			expect(q.deliver("FILEHOST", "tok-b")).to.equal(true);
			expect(await a).to.equal("tok-a");
			expect(await b).to.equal("tok-b");
			expect(await other).to.equal("tok-q");
			expect(q.size).to.equal(0);
			expect(q.deliver("FILEHOST", "stray")).to.equal(false);
		});

		it("a FAIL rejects the oldest request with the server's text and code", async function () {
			const q = new TokenRequests(1000);
			const p = q.request("FILEHOST", () => undefined);
			expect(q.fail("ACCOUNT_REQUIRED", "You must be logged in")).to.equal(true);
			const err = (await p.catch((e: Error) => e)) as Error & {code: string};
			expect(err.message).to.equal("You must be logged in");
			expect(err.code).to.equal("ACCOUNT_REQUIRED");
			expect(q.fail("X", "nobody waiting")).to.equal(false);
		});

		it("times out and clears on disconnect", async function () {
			const clock = sinon.useFakeTimers();
			const q = new TokenRequests(50);
			const p = q.request("FILEHOST", () => undefined);
			clock.tick(60);
			const err = (await p.catch((e: Error) => e)) as Error & {code: string};
			expect(err.code).to.equal("TIMEOUT");
			expect(q.size).to.equal(0);

			const p2 = q.request("FILEHOST", () => undefined);
			q.clear();
			const err2 = (await p2.catch((e: Error) => e)) as Error & {code: string};
			expect(err2.code).to.equal("DISCONNECTED");
			clock.restore();
		});
	});

	describe("IrcClient", function () {
		it("wants the cap, reads the ISUPPORT into serverOptions, and round-trips TOKEN GENERATE", async function () {
			expect(SEANCE_CAPS.wanted).to.include("draft/authtoken");
			const h = setup();
			register(h, `${ALL_CAPS} draft/authtoken`);
			h.transport.line(
				":irc.test 005 alice draft/FILEHOST=https://up.example/filehost :are supported by this server"
			);
			expect(h.client.filehostUrl()).to.equal("https://up.example/filehost");
			const options = h.payloads<{serverOptions: {FILEHOST?: string}}>("network:options");
			expect(options[options.length - 1].serverOptions.FILEHOST).to.equal(
				"https://up.example/filehost"
			);

			const p = h.client.generateToken("FILEHOST", "#seance");
			expect(h.sent()).to.deep.equal(["TOKEN GENERATE FILEHOST #seance"]);
			h.transport.line(":irc.test TOKEN GENERATE FILEHOST :abc123");
			expect(await p).to.equal("abc123");

			// Batched reply: chunks concatenate.
			const p2 = h.client.generateToken("FILEHOST");
			expect(h.sent()).to.deep.equal(["TOKEN GENERATE FILEHOST"]);
			h.transport.lines(
				":irc.test BATCH +t1 draft/authtoken FILEHOST",
				"@batch=t1 :irc.test TOKEN GENERATE * :part-one.",
				"@batch=t1 :irc.test TOKEN GENERATE * :part-two",
				":irc.test BATCH -t1"
			);
			expect(await p2).to.equal("part-one.part-two");

			// FAIL answers the pending request and stays out of the timeline.
			const before = h.messages().length;
			const p3 = h.client.generateToken("FILEHOST", "#elsewhere");
			h.transport.line(
				":irc.test FAIL TOKEN NO_PERMISSIONS #elsewhere :You do not have permission to generate a FILEHOST token for #elsewhere"
			);
			const err = (await p3.catch((e: Error) => e)) as Error;
			expect(err.message).to.match(/permission/);
			expect(h.messages().length).to.equal(before);

			// The service list, NEW/DEL and CLAIM lines are not timeline noise.
			h.transport.lines(
				":irc.test BATCH +s1 draft/authtoken *",
				"@batch=s1 :irc.test TOKEN SERVICE FILEHOST https://up.example/filehost :uploads",
				":irc.test BATCH -s1",
				":irc.test TOKEN NEW FILEHOST https://up.example/filehost"
			);
			expect(h.messages().length).to.equal(before);
		});
	});

	describe("uploadFilehost", function () {
		const file = new File(["PNG"], "shot.png", {type: "image/png"});

		it("gets a token, POSTs the raw file with Bearer, and returns Location", async function () {
			const generate = sinon.stub().resolves("tok-1");
			const fetchStub = sinon
				.stub()
				.resolves(
					new Response("{}", {status: 201, headers: {Location: "/filehost/abc.png"}})
				);
			const url = await uploadFilehost(
				file,
				{endpoint: "https://up.example/filehost", scope: "#seance", generate},
				{fetch: fetchStub}
			);
			expect(url).to.equal("https://up.example/filehost/abc.png");
			expect(generate.calledOnceWith("#seance")).to.equal(true);
			const [target, init] = fetchStub.firstCall.args as [string, RequestInit];
			expect(target).to.equal("https://up.example/filehost");
			expect(init.method).to.equal("POST");
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).to.equal("Bearer tok-1");
			expect(headers["Content-Type"]).to.equal("image/png");
			expect(headers["Content-Disposition"]).to.match(/^inline; filename="shot.png"/);
			expect(init.body).to.equal(file);
		});

		it("falls back to the JSON url when Location is not readable", async function () {
			const fetchStub = sinon
				.stub()
				.resolves(
					new Response(JSON.stringify({url: "https://up.example/raw/x"}), {status: 201})
				);
			const url = await uploadFilehost(
				file,
				{endpoint: "https://up.example/filehost", generate: () => Promise.resolve("t")},
				{fetch: fetchStub}
			);
			expect(url).to.equal("https://up.example/raw/x");
		});

		it("reports a refused token and a refused upload in the host's words", async function () {
			const refused = await uploadFilehost(
				file,
				{
					endpoint: "https://up.example/filehost",
					generate: () => Promise.reject(new Error("You must be logged into an account")),
				},
				{fetch: sinon.stub()}
			).catch((e: Error) => e);
			expect(refused).to.be.instanceOf(UploadError);
			expect((refused as Error).message).to.match(/logged into an account/);

			const fetchStub = sinon.stub().resolves(
				new Response(
					JSON.stringify({
						error: "too_large",
						message: "Maximum upload size is 10 bytes",
					}),
					{
						status: 413,
					}
				)
			);
			const big = await uploadFilehost(
				file,
				{endpoint: "https://up.example/filehost", generate: () => Promise.resolve("t")},
				{fetch: fetchStub}
			).catch((e: Error) => e);
			expect((big as Error).message).to.equal(
				"Upload failed: Maximum upload size is 10 bytes"
			);
		});
	});
});
