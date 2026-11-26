import {expect} from "chai";
import {FORMAT, type SyncDocument} from "../../client/js/sync/document";
import {
	acceptableUrl,
	download,
	DownloadError,
	FileError,
	formatPointer,
	isReadable,
	MAX_FILE_BYTES,
	open,
	parsePointer,
	seal,
	upload,
	UploadRefused,
} from "../../client/js/sync/file";

const doc = (entries: SyncDocument["entries"] = {a: {t: 5, v: "x"}}): SyncDocument => ({
	format: FORMAT,
	version: 1,
	entries,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		return e instanceof FileError ? e.code : `other: ${String(e)}`;
	}

	return "read";
}

describe("settings sync file (sync/file.ts)", function () {
	describe("the pointer", function () {
		const key = "A".repeat(43);

		it("round-trips version, URL, key and time", function () {
			const value = formatPointer({url: "https://files.example/f/abc", key, changedAt: 1234});

			expect(value).to.equal(`1 https://files.example/f/abc ${key} 1234`);
			expect(parsePointer(value!)).to.deep.equal({
				version: 1,
				url: "https://files.example/f/abc",
				key,
				changedAt: 1234,
			});
		});

		it("does not fit a value over 300 bytes", function () {
			const url = `https://files.example/${"x".repeat(240)}`;

			expect(formatPointer({url, key, changedAt: 1_800_000_000_000})).to.equal(null);
		});

		it("reads only the version of one this build does not know", function () {
			const pointer = parsePointer("2 anything at all, in any shape");

			expect(pointer).to.deep.equal({version: 2});
			expect(isReadable(pointer!)).to.equal(false);
		});

		it("reads nothing from anything else", function () {
			for (const value of [
				"",
				"hello",
				`1 https://files.example/f ${key}`,
				`1 not-a-url ${key} 5`,
				`1 https://files.example/f short 5`,
				`1 https://files.example/f ${key} soon`,
				`0 https://files.example/f ${key} 5`,
			]) {
				expect(parsePointer(value), value).to.equal(null);
			}
		});
	});

	describe("acceptableUrl", function () {
		const host = "https://files.example/filehost";

		it("takes an https URL on the network's own file host", function () {
			expect(acceptableUrl("https://files.example/f/abc", host)).to.equal(true);
			expect(acceptableUrl("https://FILES.example./f/abc", host)).to.equal(true);
		});

		it("takes nothing anywhere else", function () {
			expect(acceptableUrl("https://evil.example/f/abc", host)).to.equal(false);
			expect(acceptableUrl("https://files.example.evil.example/f", host)).to.equal(false);
			expect(acceptableUrl("https://files.example:8443/f", host)).to.equal(false);
			expect(acceptableUrl("https://user@files.example/f", host)).to.equal(false);
			expect(acceptableUrl("http://files.example/f", host)).to.equal(false);
			expect(acceptableUrl("data:text/plain,hi", host)).to.equal(false);
			expect(acceptableUrl("https://files.example/f", undefined)).to.equal(false);
		});

		it("takes plain http only where the file host itself is plain http", function () {
			expect(acceptableUrl("http://127.0.0.1:8099/f/1", "http://127.0.0.1:8099/up")).to.equal(
				true
			);
		});
	});

	describe("seal and open", function () {
		it("round-trips a document under a fresh key each time", async function () {
			const one = await seal(doc());
			const two = await seal(doc());

			expect(one.key).to.match(/^[A-Za-z0-9_-]{43}$/);
			expect(one.key).to.not.equal(two.key);
			expect(await open(one.bytes, one.key)).to.deep.equal(doc());
		});

		it("shows nothing of the document in the file", async function () {
			const sealed = await seal(doc({secret: {t: 5, v: "plainly-visible-marker"}}));

			expect(Buffer.from(sealed.bytes).toString("latin1")).to.not.include("plainly-visible");
		});

		it("does not open with another key or after a changed byte", async function () {
			const sealed = await seal(doc());
			const other = await seal(doc());
			const changed = sealed.bytes.slice();
			changed[changed.length - 1] ^= 1;

			expect(await codeOf(open(sealed.bytes, other.key))).to.equal("damaged");
			expect(await codeOf(open(changed, sealed.key))).to.equal("damaged");
			expect(await codeOf(open(new Uint8Array(4), sealed.key))).to.equal("damaged");
		});

		it("does not open a file over 1 MB, nor make one", async function () {
			// Random text does not compress: over the limit as a file.
			let noise = "";

			while (noise.length < 1_600_000) {
				noise += Math.random().toString(36).slice(2);
			}

			expect(await codeOf(seal(doc({big: {t: 5, v: noise}})))).to.equal("too-large");
			expect(await codeOf(open(new Uint8Array(MAX_FILE_BYTES + 1), "A".repeat(43)))).to.equal(
				"too-large"
			);
		});

		it("does not pack a document over 4 MB, however well it compresses", async function () {
			const sealed = seal(doc({big: {t: 5, v: "a".repeat(4 * 1024 * 1024)}}));

			expect(await codeOf(sealed)).to.equal("too-large");
		});

		it("says when the document inside is a newer version", async function () {
			const sealed = await seal({...doc(), version: 2});

			expect(await codeOf(open(sealed.bytes, sealed.key))).to.equal("newer-version");
		});
	});

	describe("download", function () {
		const respond = (response: Response) => (() => Promise.resolve(response)) as typeof fetch;

		it("reads a file and sends nothing of the page's", async function () {
			let seen: RequestInit | undefined;
			const bytes = await download("https://files.example/f", ((_url, init) => {
				seen = init;
				return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
			}) as typeof fetch);

			expect([...bytes]).to.deep.equal([1, 2, 3]);
			expect(seen).to.include({credentials: "omit", referrerPolicy: "no-referrer"});
		});

		it("stops past 1 MB, by the header or by the bytes", async function () {
			const big = new Uint8Array(MAX_FILE_BYTES + 1);
			const headed = respond(
				new Response(new Uint8Array(1), {headers: {"Content-Length": String(big.length)}})
			);

			expect(await codeOf(download("https://files.example/f", headed))).to.equal("too-large");
			expect(
				await codeOf(download("https://files.example/f", respond(new Response(big))))
			).to.equal("too-large");
		});

		it("tells a file the host no longer has from a failure to try again", async function () {
			const status = async (code: number) => {
				try {
					await download(
						"https://files.example/f",
						respond(new Response("", {status: code}))
					);
				} catch (e) {
					return (e as DownloadError).gone;
				}

				return undefined;
			};

			expect(await status(404)).to.equal(true);
			expect(await status(410)).to.equal(true);
			expect(await status(503)).to.equal(false);
		});
	});

	describe("upload", function () {
		it("posts the raw bytes with the token and reads the Location", async function () {
			let seen: {url: string; init: RequestInit} | undefined;
			const url = await upload(
				new Uint8Array([9]),
				"https://files.example/filehost",
				"tok",
				((u, init) => {
					seen = {url: String(u), init: init!};
					return Promise.resolve(
						new Response("", {status: 201, headers: {Location: "/f/abc"}})
					);
				}) as typeof fetch
			);

			expect(url).to.equal("https://files.example/f/abc");
			expect(seen!.url).to.equal("https://files.example/filehost");
			expect(seen!.init.method).to.equal("POST");
			expect(seen!.init.headers).to.deep.equal({
				Authorization: "Bearer tok",
				"Content-Type": "application/octet-stream",
			});
		});

		it("reports a refusal with the wait the host asked for", async function () {
			const refused = async (response: Response) => {
				try {
					await upload(new Uint8Array(1), "https://files.example/up", "tok", (() =>
						Promise.resolve(response)) as typeof fetch);
				} catch (e) {
					return e as UploadRefused;
				}

				throw new Error("not refused");
			};

			const limited = await refused(
				new Response("", {status: 429, headers: {"Retry-After": "120"}})
			);

			expect([limited.status, limited.retryAfterMs]).to.deep.equal([429, 120_000]);
			// A cross-origin page often cannot read the header: the host's 600 s.
			expect((await refused(new Response("", {status: 429}))).retryAfterMs).to.equal(600_000);
			expect((await refused(new Response("", {status: 415}))).status).to.equal(415);
		});
	});
});
