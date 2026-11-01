import {expect} from "chai";
import sinon from "ts-sinon";
import {BrandingUploads, DEFAULT_UPLOAD_MAX_BYTES} from "../../client/js/branding";
import {
	UploadHost,
	UploadProgress,
	Uploader,
	XhrConstructor,
	acceptsType,
	buildUploadRequest,
	fieldsBlamedBy,
	fileNameForType,
	lookupResponsePath,
	metadataPlan,
	parseUploadResponse,
	uploadFile,
	uploadMaxSize,
	xhrFetch,
} from "../../client/js/upload";

const ENDPOINT = "https://files.example.test/upload";

/** The `boxlabs-paste` preset as `normalizeBranding` expands it. */
const BOXLABS: BrandingUploads = {
	preset: "boxlabs-paste",
	endpoint: "https://paste.boxlabs.uk/img/",
	fieldName: "images[]",
	fields: {strip_exif: "1"},
	optionalFields: ["strip_exif"],
	responseUrlKey: "results.0.filePath",
	responseErrorKey: "results.0.error",
	accept: [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"video/mp4",
		"video/quicktime",
		"video/webm",
		"video/x-msvideo",
		"video/x-matroska",
	],
	maxSizeBytes: 25 * 1024 * 1024,
};

function imageFile(name = "pasted.png", type = "image/png"): File {
	return new File(["\u0089PNG"], name, {type});
}

function textFile(name = "hello.txt", content = "hello", type = "text/plain"): File {
	return new File([content], name, {type});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {"content-type": "application/json"},
	});
}

/** Replace the global `fetch` for one test; restored by `sinon.restore()`. */
function stubFetch(...responses: (Response | Error)[]): sinon.SinonStub {
	const stub = sinon.stub(globalThis, "fetch");

	responses.forEach((response, i) => {
		if (response instanceof Error) {
			stub.onCall(i).rejects(response);
		} else {
			stub.onCall(i).resolves(response);
		}
	});

	return stub;
}

/** Await `promise` and return the message it rejects with. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e: unknown) {
		return e instanceof Error ? e.message : String(e);
	}

	throw new Error("expected the promise to reject");
}

interface FakeHost extends UploadHost {
	errors: string[];
	urls: string[];
	config: BrandingUploads | undefined;
	connected: boolean;
	/** Every list of files the host was asked to confirm. */
	confirmed: File[][];
	/** Every progress state reported, `null` included. */
	progressLog: (UploadProgress | null)[];
	/** What `confirm` answers; the default lets everything through. */
	decide: (files: File[]) => Promise<File[]>;
}

function fakeHost(config: BrandingUploads | undefined): FakeHost {
	const host: FakeHost = {
		errors: [],
		urls: [],
		config,
		connected: true,
		confirmed: [],
		progressLog: [],
		decide: (files) => Promise.resolve(files),
		uploads: () => host.config,
		isConnected: () => host.connected,
		renderCanvas: () => false,
		showError: (message) => host.errors.push(message),
		insertUrl: (url) => host.urls.push(url),
		confirm(files) {
			host.confirmed.push(files);
			return host.decide(files);
		},
		progress: (state) => host.progressLog.push(state),
	};

	return host;
}

/** A stand-in for the browser's XMLHttpRequest that the test drives by hand. */
class FakeXhr {
	/** Every instance constructed, oldest first; reset by the describes that use it. */
	// eslint-disable-next-line no-use-before-define -- the class naming itself in a type
	static instances: FakeXhr[] = [];

	method = "";
	url = "";
	headers: Record<string, string> = {};
	body: unknown = undefined;
	withCredentials = false;
	aborted = false;
	status = 0;
	statusText = "";
	responseText = "";
	upload: {onprogress: ((event: ProgressEvent) => void) | null} = {onprogress: null};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;

	constructor() {
		FakeXhr.instances.push(this);
	}

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	setRequestHeader(name: string, value: string) {
		this.headers[name] = value;
	}

	send(body: unknown) {
		this.body = body;
	}

	abort() {
		this.aborted = true;
		this.onabort?.();
	}

	progress(loaded: number, total: number) {
		this.upload.onprogress?.({lengthComputable: true, loaded, total} as ProgressEvent);
	}

	respond(status: number, text: string) {
		this.status = status;
		this.responseText = text;
		this.onload?.();
	}

	fail() {
		this.onerror?.();
	}
}

const XHR = FakeXhr as unknown as XhrConstructor;

/** Wait for `condition` to hold, letting queued promise callbacks run. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !condition(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}

	if (!condition()) {
		throw new Error("condition never held");
	}
}

/** The latest request the fake XHR class saw. */
async function lastXhr(): Promise<FakeXhr> {
	const count = FakeXhr.instances.length;
	await until(() => FakeXhr.instances.length > count - 1 && FakeXhr.instances.length > 0);
	return FakeXhr.instances[FakeXhr.instances.length - 1];
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});

	return {promise, resolve};
}

describe("upload", function () {
	afterEach(function () {
		sinon.restore();
	});

	describe("buildUploadRequest", function () {
		it("posts multipart with the default field name and no credentials", function () {
			const init = buildUploadRequest(textFile(), {endpoint: ENDPOINT});

			expect(init.method).to.equal("POST");
			expect(init.credentials).to.equal("omit");
			expect(init.headers).to.deep.equal({});

			const body = init.body as FormData;
			expect(body).to.be.instanceOf(FormData);
			const file = body.get("file");
			expect(file).to.be.instanceOf(File);
			expect((file as File).name).to.equal("hello.txt");
			expect((file as File).size).to.equal(5);
		});

		it("honours fieldName, headers and withCredentials", function () {
			const init = buildUploadRequest(textFile(), {
				endpoint: ENDPOINT,
				fieldName: "attachment",
				withCredentials: true,
				headers: {"X-Api-Key": "s3cret", "Content-Type": "text/plain"},
			});

			expect(init.credentials).to.equal("include");
			// The browser must set the multipart boundary itself.
			expect(init.headers).to.deep.equal({"X-Api-Key": "s3cret"});
			expect((init.body as FormData).get("attachment")).to.be.instanceOf(File);
			expect((init.body as FormData).get("file")).to.equal(null);
		});
	});

	describe("parseUploadResponse", function () {
		it("reads the url key of a JSON body, resolving relative URLs", function () {
			const config = {endpoint: ENDPOINT};

			expect(
				parseUploadResponse('{"url":"https://cdn.example.test/a.png"}', config)
			).to.equal("https://cdn.example.test/a.png");
			expect(parseUploadResponse('{"url":"/f/a.png"}', config)).to.equal(
				"https://files.example.test/f/a.png"
			);
		});

		it("supports a custom key and a plain-text URL body", function () {
			expect(
				parseUploadResponse('{"data":{"x":1},"link":"https://x.test/1"}', {
					endpoint: ENDPOINT,
					responseUrlKey: "link",
				})
			).to.equal("https://x.test/1");

			expect(parseUploadResponse("  https://x.test/2\n", {endpoint: ENDPOINT})).to.equal(
				"https://x.test/2"
			);
		});

		it("rejects bodies without a usable URL", function () {
			const config = {endpoint: ENDPOINT};

			expect(() => parseUploadResponse('{"url":"javascript:alert(1)"}', config)).to.throw(
				'Upload failed: the uploader did not return a "url" URL'
			);
			expect(() => parseUploadResponse('{"error":"quota exceeded"}', config)).to.throw(
				"quota exceeded"
			);
			expect(() => parseUploadResponse("<html>nope</html>", config)).to.throw(
				"Upload failed: the uploader did not return a URL"
			);
		});
	});

	describe("uploadFile", function () {
		it("sends the file to the endpoint with the stubbed global fetch", async function () {
			const fetchStub = stubFetch(jsonResponse({url: "https://cdn.example.test/x"}));

			const url = await uploadFile(textFile(), {
				endpoint: ENDPOINT,
				headers: {"X-Api-Key": "k"},
			});

			expect(url).to.equal("https://cdn.example.test/x");
			expect(fetchStub.calledOnce).to.be.true;
			expect(fetchStub.firstCall.args[0]).to.equal(ENDPOINT);

			const init = fetchStub.firstCall.args[1] as RequestInit;
			expect(init.method).to.equal("POST");
			expect(init.headers).to.deep.equal({"X-Api-Key": "k"});
			expect(init.body).to.be.instanceOf(FormData);
		});

		it("surfaces HTTP errors, preferring a JSON error message", async function () {
			stubFetch(
				jsonResponse({error: "file type not allowed"}, 415),
				new Response("boom", {status: 502})
			);

			expect(await rejectionMessage(uploadFile(textFile(), {endpoint: ENDPOINT}))).to.equal(
				"file type not allowed"
			);

			expect(await rejectionMessage(uploadFile(textFile(), {endpoint: ENDPOINT}))).to.equal(
				"Upload failed: HTTP 502"
			);
		});

		it("surfaces network failures", async function () {
			stubFetch(new TypeError("Failed to fetch"));

			expect(await rejectionMessage(uploadFile(textFile(), {endpoint: ENDPOINT}))).to.equal(
				"Upload failed: Failed to fetch"
			);
		});
	});

	describe("boxlabs-paste preset", function () {
		it("sends the file as images[] with strip_exif", function () {
			const body = buildUploadRequest(imageFile(), BOXLABS).body as FormData;

			const file = body.get("images[]");
			expect(file).to.be.instanceOf(File);
			expect((file as File).name).to.equal("pasted.png");
			expect(body.get("strip_exif")).to.equal("1");
			expect(body.get("file")).to.equal(null);
		});

		it("omits the fields it is told to leave out", function () {
			const body = buildUploadRequest(imageFile(), BOXLABS, new Set(["strip_exif"]))
				.body as FormData;

			expect(body.get("images[]")).to.be.instanceOf(File);
			expect(body.get("strip_exif")).to.equal(null);
		});

		it("resolves the relative filePath the service returns", function () {
			expect(
				parseUploadResponse(
					'{"results":[{"success":true,"filePath":"/img/img_abc.png"}]}',
					BOXLABS
				)
			).to.equal("https://paste.boxlabs.uk/img/img_abc.png");
		});

		it("surfaces the nested error the service returns with HTTP 200", async function () {
			stubFetch(
				jsonResponse({
					results: [
						{
							success: false,
							error: "No files received or upload exceeded server limits.",
						},
					],
				})
			);

			expect(await rejectionMessage(uploadFile(imageFile(), BOXLABS))).to.equal(
				"No files received or upload exceeded server limits."
			);
		});

		it("retries once without strip_exif when stripping is what failed", async function () {
			const fetchStub = stubFetch(
				jsonResponse({results: [{success: false, error: "Failed to strip EXIF data"}]}),
				jsonResponse({results: [{success: true, filePath: "/img/img_z.png"}]})
			);

			expect(await uploadFile(imageFile(), BOXLABS)).to.equal(
				"https://paste.boxlabs.uk/img/img_z.png"
			);

			expect(fetchStub.callCount).to.equal(2);
			expect(
				((fetchStub.firstCall.args[1] as RequestInit).body as FormData).get("strip_exif")
			).to.equal("1");
			expect(
				((fetchStub.secondCall.args[1] as RequestInit).body as FormData).get("strip_exif")
			).to.equal(null);
		});

		it("does not retry an error that has nothing to do with the field", async function () {
			const fetchStub = stubFetch(
				jsonResponse({results: [{success: false, error: "File type not allowed"}]})
			);

			expect(await rejectionMessage(uploadFile(imageFile(), BOXLABS))).to.equal(
				"File type not allowed"
			);
			expect(fetchStub.callCount).to.equal(1);
		});

		it("gives up after dropping every optional field", async function () {
			const fetchStub = stubFetch(
				jsonResponse({results: [{success: false, error: "exif strip broke"}]}),
				jsonResponse({results: [{success: false, error: "exif strip broke"}]})
			);

			expect(await rejectionMessage(uploadFile(imageFile(), BOXLABS))).to.equal(
				"exif strip broke"
			);
			expect(fetchStub.callCount).to.equal(2);
		});

		it("uploads a video, which the endpoint takes despite its /img/ path", async function () {
			const fetchStub = stubFetch(
				jsonResponse({results: [{success: true, filePath: "/img/vid_1.mp4"}]})
			);
			const host = fakeHost(BOXLABS);

			await new Uploader(host).triggerUpload([
				new File(["x"], "clip.mp4", {type: "video/mp4"}),
			]);

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal(["https://paste.boxlabs.uk/img/vid_1.mp4"]);
			expect(fetchStub.called).to.be.true;
		});

		it("refuses a type the endpoint does not take, before contacting it", async function () {
			const fetchStub = stubFetch();
			const host = fakeHost(BOXLABS);

			// Audio is refused by the service as "Unsupported type .ogg", so
			// there is no reason to spend the upload finding that out.
			await new Uploader(host).triggerUpload([
				new File(["x"], "sound.ogg", {type: "audio/ogg"}),
			]);

			expect(host.errors.length).to.equal(1);
			expect(host.errors[0]).to.equal(
				`File sound.ogg is not a type this uploader accepts (${BOXLABS.accept?.join(", ")})`
			);
			expect(fetchStub.called).to.be.false;
		});

		it("uploads a pasted image end to end", async function () {
			const fetchStub = stubFetch(
				jsonResponse({results: [{success: true, filePath: "/img/img_1.png"}]})
			);
			const host = fakeHost(BOXLABS);

			await new Uploader(host).triggerUpload([imageFile()]);

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal(["https://paste.boxlabs.uk/img/img_1.png"]);
			expect(fetchStub.firstCall.args[0]).to.equal("https://paste.boxlabs.uk/img/");
		});
	});

	describe("catbox-litterbox preset", function () {
		const LITTERBOX: BrandingUploads = {
			preset: "catbox-litterbox",
			endpoint: "https://litterbox.catbox.moe/resources/internals/api.php",
			fieldName: "fileToUpload",
			fields: {reqtype: "fileupload", time: "72h"},
			maxSizeBytes: 1024 * 1024 * 1024,
			progress: false,
		};

		it("sends fileToUpload with the reqtype and retention fields", function () {
			const body = buildUploadRequest(imageFile(), LITTERBOX).body as FormData;

			expect(body.get("fileToUpload")).to.be.instanceOf(File);
			expect(body.get("reqtype")).to.equal("fileupload");
			expect(body.get("time")).to.equal("72h");
		});

		it("takes the plain-text URL the service answers with", async function () {
			stubFetch(new Response("https://litter.catbox.moe/abc123.png", {status: 200}));
			const host = fakeHost(LITTERBOX);

			await new Uploader(host).triggerUpload([imageFile()]);

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal(["https://litter.catbox.moe/abc123.png"]);
		});

		it("accepts video, having no accept list", async function () {
			stubFetch(new Response("https://litter.catbox.moe/clip.mp4", {status: 200}));
			const host = fakeHost(LITTERBOX);

			await new Uploader(host).triggerUpload([
				new File(["x"], "clip.mp4", {type: "video/mp4"}),
			]);

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal(["https://litter.catbox.moe/clip.mp4"]);
		});
	});

	describe("lookupResponsePath", function () {
		it("prefers a literal top-level key over the dotted path", function () {
			expect(lookupResponsePath({"a.b": "literal", a: {b: "walked"}}, "a.b")).to.equal(
				"literal"
			);
			expect(lookupResponsePath({a: {b: "walked"}}, "a.b")).to.equal("walked");
		});

		it("walks arrays by index and gives up on anything else", function () {
			expect(lookupResponsePath({r: [{u: "x"}]}, "r.0.u")).to.equal("x");
			expect(lookupResponsePath({r: [{u: "x"}]}, "r.1.u")).to.equal(undefined);
			expect(lookupResponsePath({r: [{u: "x"}]}, "r.nope.u")).to.equal(undefined);
			expect(lookupResponsePath({r: {u: 7}}, "r.u")).to.equal(undefined);
			expect(lookupResponsePath("plain", "a")).to.equal(undefined);
		});
	});

	describe("acceptsType", function () {
		it("takes anything without an accept list", function () {
			expect(acceptsType({endpoint: ENDPOINT}, "video/mp4")).to.be.true;
			expect(acceptsType({endpoint: ENDPOINT, accept: []}, "video/mp4")).to.be.true;
		});

		it("matches exact types and type/* wildcards", function () {
			const config = {endpoint: ENDPOINT, accept: ["image/png", "video/*"]};

			expect(acceptsType(config, "image/png")).to.be.true;
			expect(acceptsType(config, "IMAGE/PNG")).to.be.true;
			expect(acceptsType(config, "video/webm")).to.be.true;
			expect(acceptsType(config, "image/gif")).to.be.false;
			expect(acceptsType(config, "")).to.be.false;
		});
	});

	describe("fieldsBlamedBy", function () {
		it("blames a field the message names by one of its words", function () {
			expect(fieldsBlamedBy("Could not strip metadata", BOXLABS)).to.deep.equal([
				"strip_exif",
			]);
			expect(fieldsBlamedBy("EXIF failure", BOXLABS)).to.deep.equal(["strip_exif"]);
			expect(fieldsBlamedBy("quota exceeded", BOXLABS)).to.deep.equal([]);
		});

		it("ignores fields already dropped or never sent", function () {
			expect(fieldsBlamedBy("exif", BOXLABS, new Set(["strip_exif"]))).to.deep.equal([]);
			expect(
				fieldsBlamedBy("exif", {...BOXLABS, fields: {}, optionalFields: ["strip_exif"]})
			).to.deep.equal([]);
		});
	});

	describe("Uploader", function () {
		it("defaults the size limit to 10 MiB", function () {
			expect(uploadMaxSize(undefined)).to.equal(10 * 1024 * 1024);
			expect(uploadMaxSize({endpoint: ENDPOINT})).to.equal(DEFAULT_UPLOAD_MAX_BYTES);
			expect(uploadMaxSize({endpoint: ENDPOINT, maxSizeBytes: 1})).to.equal(1);
		});

		it("reports uploads as not configured once when branding has no endpoint", async function () {
			const fetchStub = stubFetch();
			const host = fakeHost(undefined);
			const uploader = new Uploader(host);

			await uploader.triggerUpload([textFile()]);
			await uploader.triggerUpload([textFile()]);

			expect(host.errors).to.deep.equal(["File uploads are not configured in this client."]);
			expect(host.urls).to.deep.equal([]);
			expect(fetchStub.called).to.be.false;
		});

		it("refuses files over maxSizeBytes without contacting the endpoint", async function () {
			const fetchStub = stubFetch(jsonResponse({url: "https://cdn.example.test/small"}));
			const host = fakeHost({endpoint: ENDPOINT, maxSizeBytes: 3});
			const uploader = new Uploader(host);

			await uploader.triggerUpload([
				textFile("big.txt", "too big"),
				textFile("ok.txt", "ok"),
			]);

			expect(host.errors).to.deep.equal(["File big.txt is over the maximum allowed size"]);
			expect(host.urls).to.deep.equal(["https://cdn.example.test/small"]);
			expect(fetchStub.calledOnce).to.be.true;
		});

		it("uploads queued files in order and inserts each URL", async function () {
			const fetchStub = stubFetch(
				jsonResponse({url: "https://cdn.example.test/1"}),
				new Response("https://cdn.example.test/2", {status: 201})
			);
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host);

			await uploader.triggerUpload([textFile("a.txt"), null, textFile("b.txt")]);

			expect(host.urls).to.deep.equal([
				"https://cdn.example.test/1",
				"https://cdn.example.test/2",
			]);
			expect(host.errors).to.deep.equal([]);
			expect(fetchStub.callCount).to.equal(2);
			expect((fetchStub.firstCall.args[1] as RequestInit).credentials).to.equal("omit");
		});

		it("shows a network error as a user-visible error and keeps going", async function () {
			stubFetch(new TypeError("Failed to fetch"), jsonResponse({url: "https://x.test/ok"}));
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host);

			await uploader.triggerUpload([textFile("a.txt"), textFile("b.txt")]);

			expect(host.errors).to.deep.equal(["Upload failed: Failed to fetch"]);
			expect(host.urls).to.deep.equal(["https://x.test/ok"]);
		});

		it("refuses to upload while disconnected", async function () {
			const fetchStub = stubFetch();
			const host = fakeHost({endpoint: ENDPOINT});
			host.connected = false;

			await new Uploader(host).triggerUpload([textFile()]);

			expect(host.errors).to.deep.equal([
				"You are currently disconnected, unable to initiate upload process.",
			]);
			expect(fetchStub.called).to.be.false;
		});
	});

	describe("confirmation", function () {
		it("shows the files that passed the checks and sends the ones the user keeps", async function () {
			const fetchStub = stubFetch(jsonResponse({url: "https://cdn.example.test/b"}));
			const host = fakeHost({endpoint: ENDPOINT, maxSizeBytes: 5});
			host.decide = (files) => Promise.resolve(files.filter((f) => f.name === "b.png"));

			await new Uploader(host).triggerUpload([
				textFile("big.txt", "too big"),
				imageFile("a.png"),
				imageFile("b.png"),
			]);

			expect(host.confirmed.map((files) => files.map((f) => f.name))).to.deep.equal([
				["a.png", "b.png"],
			]);
			expect(host.errors).to.deep.equal(["File big.txt is over the maximum allowed size"]);
			expect(host.urls).to.deep.equal(["https://cdn.example.test/b"]);
			expect(fetchStub.calledOnce).to.be.true;
			expect(
				((fetchStub.firstCall.args[1] as RequestInit).body as FormData).get("file")
			).to.have.property("name", "b.png");
		});

		it("uploads nothing when the user cancels", async function () {
			const fetchStub = stubFetch();
			const host = fakeHost({endpoint: ENDPOINT});
			host.decide = () => Promise.resolve([]);

			await new Uploader(host).triggerUpload([imageFile()]);

			expect(host.confirmed).to.have.length(1);
			expect(host.urls).to.deep.equal([]);
			expect(host.errors).to.deep.equal([]);
			expect(fetchStub.called).to.be.false;
		});

		it("never asks when nothing passed the checks", async function () {
			stubFetch();
			const host = fakeHost({endpoint: ENDPOINT, maxSizeBytes: 1});

			await new Uploader(host).triggerUpload([textFile("big.txt", "too big")]);

			expect(host.confirmed).to.deep.equal([]);
			expect(host.errors).to.have.length(1);
		});

		it("asks about a second drop only once the first is answered", async function () {
			stubFetch(
				jsonResponse({url: "https://cdn.example.test/1"}),
				jsonResponse({url: "https://cdn.example.test/2"})
			);
			const host = fakeHost({endpoint: ENDPOINT});
			const first = deferred<File[]>();
			host.decide = (files) =>
				files[0].name === "a.png" ? first.promise : Promise.resolve(files);
			const uploader = new Uploader(host);

			const runA = uploader.triggerUpload([imageFile("a.png")]);
			const runB = uploader.triggerUpload([imageFile("b.png")]);
			await new Promise((resolve) => setImmediate(resolve));

			expect(host.confirmed.map((files) => files[0].name)).to.deep.equal(["a.png"]);

			first.resolve([imageFile("a.png")]);
			await Promise.all([runA, runB]);

			expect(host.confirmed.map((files) => files[0].name)).to.deep.equal(["a.png", "b.png"]);
			expect(host.urls).to.deep.equal([
				"https://cdn.example.test/1",
				"https://cdn.example.test/2",
			]);
		});
	});

	describe("progress", function () {
		beforeEach(function () {
			FakeXhr.instances = [];
		});

		it("reports each file's bytes as they go, then goes idle", async function () {
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host, undefined, XHR);

			const run = uploader.triggerUpload([
				textFile("a.txt", "hello"),
				textFile("b.txt", "hi!"),
			]);

			const first = await lastXhr();
			first.progress(2, 5);
			first.respond(200, '{"url":"https://cdn.example.test/a"}');

			await until(() => FakeXhr.instances.length === 2);
			const second = await lastXhr();
			second.progress(3, 3);
			second.respond(200, '{"url":"https://cdn.example.test/b"}');

			await run;

			expect(host.urls).to.deep.equal([
				"https://cdn.example.test/a",
				"https://cdn.example.test/b",
			]);
			expect(host.progressLog).to.deep.equal([
				{fileName: "a.txt", index: 1, count: 2, phase: "preparing", loaded: 0, total: 0},
				{fileName: "a.txt", index: 1, count: 2, phase: "sending", loaded: 0, total: 5},
				{fileName: "a.txt", index: 1, count: 2, phase: "sending", loaded: 2, total: 5},
				{fileName: "b.txt", index: 2, count: 2, phase: "preparing", loaded: 0, total: 0},
				{fileName: "b.txt", index: 2, count: 2, phase: "sending", loaded: 0, total: 3},
				{fileName: "b.txt", index: 2, count: 2, phase: "waiting", loaded: 3, total: 3},
				null,
			]);
		});

		it("counts a file queued while another is in flight", async function () {
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host, undefined, XHR);

			const runA = uploader.triggerUpload([textFile("a.txt")]);
			const first = await lastXhr();
			const runB = uploader.triggerUpload([textFile("b.txt")]);
			await until(() => host.confirmed.length === 2);
			first.respond(200, '{"url":"https://cdn.example.test/a"}');

			await until(() => FakeXhr.instances.length === 2);
			const second = await lastXhr();
			second.respond(200, '{"url":"https://cdn.example.test/b"}');
			await Promise.all([runA, runB]);

			const sending = host.progressLog.filter((p) => p?.phase === "sending");
			expect(sending.map((p) => [p?.fileName, p?.index, p?.count])).to.deep.equal([
				["a.txt", 1, 1],
				["b.txt", 2, 2],
			]);
			expect(host.progressLog[host.progressLog.length - 1]).to.equal(null);
		});

		it("cancels quietly, dropping the rest of the queue", async function () {
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host, undefined, XHR);

			const run = uploader.triggerUpload([textFile("a.txt"), textFile("b.txt")]);
			const first = await lastXhr();
			uploader.abort();
			await run;

			expect(first.aborted).to.be.true;
			expect(FakeXhr.instances).to.have.length(1);
			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal([]);
			expect(host.progressLog[host.progressLog.length - 1]).to.equal(null);
		});

		it("goes idle after a failure too", async function () {
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host, undefined, XHR);

			const run = uploader.triggerUpload([textFile("a.txt")]);
			(await lastXhr()).fail();
			// Before any progress, so it is retried once as a plain POST; that fails too.
			await until(() => FakeXhr.instances.length === 2);
			(await lastXhr()).fail();
			await run;

			expect(host.errors).to.deep.equal(["Upload failed: Failed to fetch"]);
			expect(host.progressLog[host.progressLog.length - 1]).to.equal(null);
		});
	});

	describe("xhrFetch", function () {
		beforeEach(function () {
			FakeXhr.instances = [];
		});

		it("sends the request the way fetch would and resolves with a Response", async function () {
			const init = buildUploadRequest(textFile(), {
				endpoint: ENDPOINT,
				headers: {"X-Api-Key": "k"},
				withCredentials: true,
			});

			const pending = xhrFetch(ENDPOINT, init, {XHR});
			const xhr = await lastXhr();

			expect(xhr.method).to.equal("POST");
			expect(xhr.url).to.equal(ENDPOINT);
			expect(xhr.headers).to.deep.equal({"X-Api-Key": "k"});
			expect(xhr.withCredentials).to.be.true;
			expect(xhr.body).to.be.instanceOf(FormData);

			xhr.respond(201, "https://cdn.example.test/x");
			const response = await pending;

			expect(response.status).to.equal(201);
			expect(response.ok).to.be.true;
			expect(await response.text()).to.equal("https://cdn.example.test/x");
		});

		it("reports upload progress", async function () {
			const seen: [number, number][] = [];
			const pending = xhrFetch(
				ENDPOINT,
				{method: "POST"},
				{XHR, onProgress: (loaded, total) => seen.push([loaded, total])}
			);
			const xhr = await lastXhr();

			xhr.progress(10, 20);
			xhr.progress(20, 20);
			xhr.respond(200, "ok");
			await pending;

			expect(seen).to.deep.equal([
				[10, 20],
				[20, 20],
			]);
		});

		it("turns a network error into the TypeError fetch would throw", async function () {
			const pending = xhrFetch(ENDPOINT, {method: "POST"}, {XHR});
			(await lastXhr()).fail();

			let error: unknown;

			try {
				await pending;
			} catch (e) {
				error = e;
			}

			expect(error).to.be.instanceOf(TypeError);
			expect((error as Error).message).to.equal("Failed to fetch");
		});

		it("aborts through the signal, before or after sending", async function () {
			const controller = new AbortController();
			const pending = xhrFetch(ENDPOINT, {method: "POST", signal: controller.signal}, {XHR});
			const xhr = await lastXhr();

			controller.abort();

			expect(xhr.aborted).to.be.true;
			expect(await rejectionMessage(pending)).to.match(/abort/i);

			const early = new AbortController();
			early.abort();
			const rejected = xhrFetch(ENDPOINT, {method: "POST", signal: early.signal}, {XHR});

			expect(await rejectionMessage(rejected)).to.match(/abort/i);
			expect(FakeXhr.instances).to.have.length(1);
		});

		it("builds a bodiless Response for a 204", async function () {
			const pending = xhrFetch(ENDPOINT, {method: "POST"}, {XHR});
			(await lastXhr()).respond(204, "");
			const response = await pending;

			expect(response.status).to.equal(204);
			expect(await response.text()).to.equal("");
		});

		it("attaches an upload listener only when progress is wanted", async function () {
			const plain = xhrFetch(ENDPOINT, {method: "POST"}, {XHR});
			const first = await lastXhr();
			expect(first.upload.onprogress).to.equal(null);
			first.respond(200, "ok");
			await plain;

			const withProgress = xhrFetch(ENDPOINT, {method: "POST"}, {XHR, onProgress() {}});
			const second = await lastXhr();
			expect(second.upload.onprogress).to.be.a("function");
			second.respond(200, "ok");
			await withProgress;
		});

		it("is what uploadFile uses when given an XHR class", async function () {
			const pending = uploadFile(textFile(), {endpoint: ENDPOINT}, {xhr: XHR});
			(await lastXhr()).respond(200, '{"url":"https://cdn.example.test/via-xhr"}');

			expect(await pending).to.equal("https://cdn.example.test/via-xhr");
		});
	});

	describe("progress needs a preflight", function () {
		beforeEach(function () {
			FakeXhr.instances = [];
		});

		it("retries as a plain POST when the request fails before any progress", async function () {
			const seen: [number, number][] = [];
			let unavailable = 0;
			const pending = uploadFile(
				textFile(),
				{endpoint: ENDPOINT},
				{
					xhr: XHR,
					onProgress: (loaded, total) => seen.push([loaded, total]),
					onProgressUnavailable: () => unavailable++,
				}
			);

			// The upload listener made the browser preflight; the uploader said 405.
			(await lastXhr()).fail();
			await until(() => FakeXhr.instances.length === 2);
			const retry = await lastXhr();
			expect(retry.upload.onprogress).to.equal(null);
			expect(retry.body).to.be.instanceOf(FormData);
			retry.respond(200, '{"url":"https://cdn.example.test/plain"}');

			expect(await pending).to.equal("https://cdn.example.test/plain");
			expect(unavailable).to.equal(1);
			expect(seen).to.deep.equal([]);
		});

		it("does not retry once bytes were reported", async function () {
			let unavailable = 0;
			const pending = uploadFile(
				textFile(),
				{endpoint: ENDPOINT},
				{xhr: XHR, onProgress() {}, onProgressUnavailable: () => unavailable++}
			);
			const xhr = await lastXhr();
			xhr.progress(2, 5);
			xhr.fail();

			expect(await rejectionMessage(pending)).to.equal("Upload failed: Failed to fetch");
			expect(FakeXhr.instances).to.have.length(1);
			expect(unavailable).to.equal(0);
		});

		it("does not retry when no progress was asked for", async function () {
			const pending = uploadFile(textFile(), {endpoint: ENDPOINT}, {xhr: XHR});
			(await lastXhr()).fail();

			expect(await rejectionMessage(pending)).to.equal("Upload failed: Failed to fetch");
			expect(FakeXhr.instances).to.have.length(1);
		});

		it("never tries progress when the config says the endpoint cannot preflight", async function () {
			const host = fakeHost({endpoint: ENDPOINT, progress: false});
			const uploader = new Uploader(host, undefined, XHR);

			const run = uploader.triggerUpload([textFile("a.txt", "hello")]);
			const xhr = await lastXhr();
			expect(xhr.upload.onprogress).to.equal(null);
			xhr.respond(200, '{"url":"https://cdn.example.test/a"}');
			await run;

			expect(FakeXhr.instances).to.have.length(1);
			expect(host.urls).to.deep.equal(["https://cdn.example.test/a"]);
			expect(host.progressLog).to.deep.equal([
				{fileName: "a.txt", index: 1, count: 1, phase: "preparing", loaded: 0, total: 0},
				{fileName: "a.txt", index: 1, count: 1, phase: "sending", loaded: 0, total: 0},
				null,
			]);
		});

		it("remembers an endpoint that cannot report progress", async function () {
			const host = fakeHost({endpoint: ENDPOINT});
			const uploader = new Uploader(host, undefined, XHR);

			const run = uploader.triggerUpload([
				textFile("a.txt", "hello"),
				textFile("b.txt", "hi!"),
			]);
			(await lastXhr()).fail();
			await until(() => FakeXhr.instances.length === 2);
			(await lastXhr()).respond(200, '{"url":"https://cdn.example.test/a"}');

			await until(() => FakeXhr.instances.length === 3);
			const second = await lastXhr();
			// No upload listener from the start: no preflight for the second file.
			expect(second.upload.onprogress).to.equal(null);
			second.respond(200, '{"url":"https://cdn.example.test/b"}');
			await run;

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal([
				"https://cdn.example.test/a",
				"https://cdn.example.test/b",
			]);
			// The strip is indeterminate (total 0) once progress is known to be unavailable.
			expect(host.progressLog).to.deep.equal([
				{fileName: "a.txt", index: 1, count: 2, phase: "preparing", loaded: 0, total: 0},
				{fileName: "a.txt", index: 1, count: 2, phase: "sending", loaded: 0, total: 5},
				{fileName: "a.txt", index: 1, count: 2, phase: "sending", loaded: 0, total: 0},
				{fileName: "b.txt", index: 2, count: 2, phase: "preparing", loaded: 0, total: 0},
				{fileName: "b.txt", index: 2, count: 2, phase: "sending", loaded: 0, total: 0},
				null,
			]);
		});
	});

	describe("metadataPlan", function () {
		const animatedWebp = new Uint8Array([
			...Array.from("RIFF", (c) => c.charCodeAt(0)),
			22,
			0,
			0,
			0,
			...Array.from("WEBPVP8X", (c) => c.charCodeAt(0)),
			10,
			0,
			0,
			0,
			0x02,
			0,
			0,
			0,
			1,
			0,
			0,
			1,
			0,
			0,
		]);
		const stillWebp = new Uint8Array([
			...Array.from("RIFF", (c) => c.charCodeAt(0)),
			16,
			0,
			0,
			0,
			...Array.from("WEBPVP8L", (c) => c.charCodeAt(0)),
			4,
			0,
			0,
			0,
			0x2f,
			0,
			0,
			0,
		]);

		it("strips a still image when the setting is on", async function () {
			expect(await metadataPlan(imageFile("p.jpg", "image/jpeg"), true)).to.equal("strip");
			expect(
				await metadataPlan(new File([stillWebp], "s.webp", {type: "image/webp"}), true)
			).to.equal("strip");
		});

		it("keeps animated files, GIF and SVG whole", async function () {
			expect(
				await metadataPlan(new File([animatedWebp], "a.webp", {type: "image/webp"}), true)
			).to.equal("animated");
			expect(await metadataPlan(imageFile("a.gif", "image/gif"), true)).to.equal(
				"unsupported"
			);
			expect(await metadataPlan(imageFile("a.svg", "image/svg+xml"), true)).to.equal(
				"unsupported"
			);
		});

		it("is off for non-images and when the setting is off", async function () {
			expect(await metadataPlan(textFile(), true)).to.equal("not-image");
			expect(await metadataPlan(imageFile("p.jpg", "image/jpeg"), false)).to.equal("off");
		});

		it("sends an animated WebP untouched even with the setting on", async function () {
			// There is no canvas under Node: had the file been re-encoded this
			// would have failed instead of reaching the endpoint.
			const fetchStub = stubFetch(jsonResponse({url: "https://cdn.example.test/anim"}));
			const host = fakeHost({endpoint: ENDPOINT});
			host.renderCanvas = () => true;

			await new Uploader(host).triggerUpload([
				new File([animatedWebp], "a.webp", {type: "image/webp"}),
			]);

			expect(host.errors).to.deep.equal([]);
			expect(host.urls).to.deep.equal(["https://cdn.example.test/anim"]);

			const sent = ((fetchStub.firstCall.args[1] as RequestInit).body as FormData).get(
				"file"
			) as File;
			expect(sent.size).to.equal(animatedWebp.length);
			expect(sent.type).to.equal("image/webp");
		});
	});

	describe("fileNameForType", function () {
		it("renames the extension when the canvas produced a different format", function () {
			expect(fileNameForType("photo.webp", "image/png")).to.equal("photo.png");
			expect(fileNameForType("photo.avif", "image/png")).to.equal("photo.png");
			expect(fileNameForType("shot.png", "image/webp")).to.equal("shot.webp");
			expect(fileNameForType("noext", "image/jpeg")).to.equal("noext.jpg");
		});

		it("leaves a name whose extension already fits", function () {
			expect(fileNameForType("pic.JPG", "image/jpeg")).to.equal("pic.JPG");
			expect(fileNameForType("pic.jpeg", "image/jpeg")).to.equal("pic.jpeg");
			expect(fileNameForType("pic.png", "image/png")).to.equal("pic.png");
			expect(fileNameForType("pic.png", "image/unknown")).to.equal("pic.png");
			expect(fileNameForType("pic.png", "")).to.equal("pic.png");
		});
	});
});
