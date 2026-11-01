import {expect} from "chai";
import sinon from "ts-sinon";
import {
	BRANDING_STRINGS,
	DEFAULT_BRANDING,
	brandingFeatures,
	brandingString,
	expandNick,
	getBranding,
	nickFromAccount,
	loadBranding,
	normalizeBranding,
	resetBranding,
} from "../../client/js/branding";

/** Minimal stand-in for a `fetch` returning the given body. */
function fakeFetch(body: string | object, status = 200): typeof fetch {
	const text = typeof body === "string" ? body : JSON.stringify(body);

	const response = {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(JSON.parse(text) as unknown),
	} as Response;

	return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

describe("branding", function () {
	afterEach(function () {
		sinon.restore();
		resetBranding();
	});

	describe("normalizeBranding", function () {
		it("returns the defaults for an empty or non-object input", function () {
			expect(normalizeBranding({})).to.deep.equal(normalizeBranding(DEFAULT_BRANDING));
			expect(normalizeBranding(null).appName).to.equal("Seance");
			expect(normalizeBranding("nope").appName).to.equal("Seance");
			expect(normalizeBranding([]).defaultNetwork).to.equal(undefined);
		});

		it("merges a partial config over the defaults", function () {
			const config = normalizeBranding({
				appName: "TestNet IRC",
				links: {privacy: "https://x.example/p"},
			});

			expect(config.appName).to.equal("TestNet IRC");
			expect(config.links).to.deep.equal({
				website: "https://github.com/evilnet/seance",
				help: "https://github.com/evilnet/seance/tree/develop/docs",
				privacy: "https://x.example/p",
				source: "https://github.com/evilnet/seance",
			});
			expect(config.features).to.deep.equal({
				multiNetwork: true,
				saveNetworks: true,
				allowCustomServer: true,
				saslDisconnectOnFail: true,
				guestAccess: true,
				signIn: false,
			});
		});

		it("drops malformed fields instead of failing", function () {
			const config = normalizeBranding({
				appName: "   ",
				themeColor: "red",
				theme: 42,
				links: {help: "javascript:alert(1)", website: 7},
				features: {multiNetwork: "no", saveNetworks: false},
				strings: {"connect.title": 1, "not.a.key": "x", "connect.submit": "Go"},
			});

			expect(config.appName).to.equal("Seance");
			expect(config.themeColor).to.equal(undefined);
			expect(config.theme).to.equal(undefined);
			expect(config.links?.help).to.equal(
				"https://github.com/evilnet/seance/tree/develop/docs"
			);
			expect(config.links?.website).to.equal("https://github.com/evilnet/seance");
			expect(config.features).to.deep.equal({
				multiNetwork: true,
				saveNetworks: false,
				allowCustomServer: true,
				saslDisconnectOnFail: true,
				guestAccess: true,
				signIn: false,
			});
			expect(config.strings).to.deep.equal({"connect.submit": "Go"});
		});

		it("validates the default network and normalises its channels", function () {
			const config = normalizeBranding({
				defaultNetwork: {
					name: "TestNet",
					host: "irc.testnet.example",
					port: "8443",
					tls: true,
					channels: ["lobby", " #help ", "", 3],
					nick: "guest????",
					lockHost: true,
				},
			});

			expect(config.defaultNetwork).to.deep.equal({
				name: "TestNet",
				host: "irc.testnet.example",
				port: 8443,
				tls: true,
				channels: ["#lobby", "#help"],
				nick: "guest????",
				lockHost: true,
			});

			expect(normalizeBranding({defaultNetwork: {port: 1}}).defaultNetwork).to.equal(
				undefined
			);
		});

		it("keeps the default network's IPcheck refund when it is whole and positive", function () {
			const network = (refund: unknown) =>
				normalizeBranding({defaultNetwork: {host: "irc.example", ipcheckRefund: refund}})
					.defaultNetwork;
			expect(network({limit: 10, periodSeconds: 600})?.ipcheckRefund).to.deep.equal({
				limit: 10,
				periodSeconds: 600,
			});
			expect(network({limit: "5"})?.ipcheckRefund).to.deep.equal({
				limit: 5,
				periodSeconds: 600,
			});
			expect(network({limit: 0})?.ipcheckRefund).to.equal(undefined);
			expect(network({limit: 2.5})?.ipcheckRefund).to.equal(undefined);
			expect(network({periodSeconds: 600})?.ipcheckRefund).to.equal(undefined);
			// The server grants nothing with a period of 0 or less: neither does the client.
			expect(network({limit: 10, periodSeconds: 0})?.ipcheckRefund).to.equal(undefined);
			expect(network({limit: 10, periodSeconds: -5})?.ipcheckRefund).to.equal(undefined);
			expect(network({limit: 10, periodSeconds: "x"})?.ipcheckRefund).to.equal(undefined);
			expect(network(true)?.ipcheckRefund).to.equal(undefined);
			expect(network(undefined)?.ipcheckRefund).to.equal(undefined);
			expect(
				normalizeBranding({defaultNetwork: {host: "h", port: 70000, channels: "a, b"}})
					.defaultNetwork
			).to.deep.equal({host: "h", channels: ["#a", "#b"]});
		});

		it("keeps shortName, description, theme and a valid themeColor", function () {
			const config = normalizeBranding({
				shortName: "TN",
				description: "TestNet's chat",
				theme: "morning",
				themeColor: "#123ABC",
			});

			expect(config).to.include({
				shortName: "TN",
				description: "TestNet's chat",
				theme: "morning",
				themeColor: "#123ABC",
			});
		});
	});

	describe("expandNick", function () {
		it("replaces every ? and % with a random digit", function () {
			const digits = [0.05, 0.15, 0.25, 0.35];
			let i = 0;
			const random = () => digits[i++ % digits.length];

			expect(expandNick("guest????", random)).to.equal("guest0123");
			expect(expandNick("lounge%", random)).to.equal("lounge0");
			expect(expandNick("plain", random)).to.equal("plain");
			expect(expandNick("g?")).to.match(/^g\d$/);
		});
	});

	describe("brandingString / brandingFeatures", function () {
		it("falls back to the default copy and treats missing flags as true", function () {
			const config = normalizeBranding({
				strings: {"connect.title": "Join TestNet"},
				features: {allowCustomServer: false},
			});

			expect(brandingString("connect.title", config)).to.equal("Join TestNet");
			expect(brandingString("connect.submit", config)).to.equal(
				BRANDING_STRINGS["connect.submit"]
			);
			expect(brandingString("unknown.key", config)).to.equal("unknown.key");
			expect(brandingFeatures(config)).to.deep.equal({
				multiNetwork: true,
				saveNetworks: true,
				allowCustomServer: false,
				saslDisconnectOnFail: true,
				signIn: false,
				guestAccess: true,
			});
			expect(brandingFeatures({appName: "x"}).allowCustomServer).to.equal(true);
			expect(
				brandingFeatures(normalizeBranding({features: {saslDisconnectOnFail: false}}))
					.saslDisconnectOnFail
			).to.equal(false);
		});
	});

	describe("the sign-in panel", function () {
		const network = {host: "irc.testnet.example"};

		it("is off unless a deploy asks for it", function () {
			expect(brandingFeatures(normalizeBranding({})).signIn).to.equal(false);
			expect(brandingFeatures(normalizeBranding({defaultNetwork: network})).signIn).to.equal(
				false
			);
		});

		it("needs a network to sign in to", function () {
			// The panel has no server fields, so without a default network
			// there is nothing it could connect to.
			const config = normalizeBranding({features: {signIn: true}});

			expect(config.features?.signIn).to.equal(true);
			expect(brandingFeatures(config).signIn).to.equal(false);
			expect(brandingFeatures(config).allowCustomServer).to.equal(true);
		});

		it("pins the server once it is on", function () {
			const features = brandingFeatures(
				normalizeBranding({defaultNetwork: network, features: {signIn: true}})
			);

			expect(features.signIn).to.equal(true);
			// Even though nothing set allowCustomServer: there are no server
			// fields to offer, and a ?host= link must not slip past them.
			expect(features.allowCustomServer).to.equal(false);
		});

		it("offers guest access unless the network requires an account", function () {
			const guests = normalizeBranding({defaultNetwork: network, features: {signIn: true}});
			const members = normalizeBranding({
				defaultNetwork: network,
				features: {signIn: true, guestAccess: false},
			});

			expect(brandingFeatures(guests).guestAccess).to.equal(true);
			expect(brandingFeatures(members).guestAccess).to.equal(false);
		});

		it("carries its own strings", function () {
			const config = normalizeBranding({
				strings: {"connect.guestSubmit": "Just let me in"},
			});

			expect(brandingString("connect.guestSubmit", config)).to.equal("Just let me in");
			expect(brandingString("connect.signInTitle", config)).to.equal("Sign in");
			// The intro is empty by default: a deploy adds one or gets none.
			expect(brandingString("connect.signInIntro", config)).to.equal("");
		});
	});

	describe("nickFromAccount", function () {
		it("keeps an account name that is already a legal nick", function () {
			expect(nickFromAccount("rubin", "guest1")).to.equal("rubin");
			expect(nickFromAccount("a_b-c[2]", "guest1")).to.equal("a_b-c[2]");
		});

		it("drops what a nick may not contain", function () {
			expect(nickFromAccount("first last", "guest1")).to.equal("firstlast");
			expect(nickFromAccount("user@example.com", "guest1")).to.equal("userexamplecom");
		});

		it("falls back when nothing usable is left", function () {
			expect(nickFromAccount("", "guest1")).to.equal("guest1");
			expect(nickFromAccount("...", "guest1")).to.equal("guest1");
		});
	});

	describe("loadBranding", function () {
		it("fetches config.json with cache: no-cache and applies it", async function () {
			const fetchStub = sinon.stub().callsFake(fakeFetch({appName: "TestNet IRC"}));

			const config = await loadBranding({fetch: fetchStub, url: "config.json"});

			expect(fetchStub.calledOnce).to.be.true;
			expect(fetchStub.firstCall.args[0]).to.equal("config.json");
			expect(fetchStub.firstCall.args[1]).to.include({cache: "no-cache"});
			expect(config.appName).to.equal("TestNet IRC");
			expect(getBranding()).to.equal(config);
		});

		it("falls back to the defaults on HTTP errors and warns once", async function () {
			const warn = sinon.stub(console, "warn");
			const notFound = fakeFetch("Not found", 404);

			const first = await loadBranding({fetch: notFound, url: "config.json"});
			const second = await loadBranding({fetch: notFound, url: "config.json"});

			expect(first.appName).to.equal("Seance");
			expect(first.defaultNetwork).to.equal(undefined);
			expect(second).to.deep.equal(first);
			expect(warn.calledOnce).to.be.true;
			expect(String(warn.firstCall.args[0])).to.include("404");
		});

		it("falls back to the defaults on invalid JSON or a rejected fetch", async function () {
			sinon.stub(console, "warn");

			const invalid = await loadBranding({fetch: fakeFetch("{not json"), url: "x"});
			expect(invalid.appName).to.equal("Seance");

			const list = await loadBranding({fetch: fakeFetch([1, 2]), url: "x"});
			expect(list.appName).to.equal("Seance");

			const rejecting = (() =>
				Promise.reject(new Error("offline"))) as unknown as typeof fetch;
			const offline = await loadBranding({fetch: rejecting, url: "x"});
			expect(offline).to.deep.equal(normalizeBranding({}));
		});

		it("uses the defaults until loaded", function () {
			expect(getBranding()).to.equal(DEFAULT_BRANDING);
		});
	});

	describe("uploads", function () {
		it("keeps a valid uploader config, filling nothing in", function () {
			const config = normalizeBranding({
				uploads: {
					endpoint: "https://files.example.test/upload",
					maxSizeBytes: "2048",
					fieldName: "attachment",
					responseUrlKey: "link",
					withCredentials: true,
					headers: {"X-Api-Key": "k", " ": "dropped", bad: 1},
				},
			});

			expect(config.uploads).to.deep.equal({
				endpoint: "https://files.example.test/upload",
				maxSizeBytes: 2048,
				fieldName: "attachment",
				responseUrlKey: "link",
				withCredentials: true,
				headers: {"X-Api-Key": "k"},
			});

			expect(
				normalizeBranding({uploads: {endpoint: "https://x.test/up", maxSizeBytes: -1}})
					.uploads
			).to.deep.equal({endpoint: "https://x.test/up"});
		});

		it("expands a named preset, letting explicit keys win", function () {
			const uploads = normalizeBranding({uploads: {preset: "boxlabs-paste"}}).uploads;

			expect(uploads).to.deep.equal({
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
			});

			// A deploy can aim the same wire format at its own PASTE instance.
			const own = normalizeBranding({
				uploads: {
					preset: "boxlabs-paste",
					endpoint: "https://paste.example.test/img/",
					maxSizeBytes: 4096,
				},
			}).uploads;

			expect(own?.endpoint).to.equal("https://paste.example.test/img/");
			expect(own?.maxSizeBytes).to.equal(4096);
			expect(own?.fieldName).to.equal("images[]");
		});

		it("does not let a preset config alias the preset constant", function () {
			const first = normalizeBranding({uploads: {preset: "boxlabs-paste"}}).uploads;
			first?.accept?.push("audio/ogg");

			if (first?.fields) {
				first.fields.strip_exif = "0";
			}

			const second = normalizeBranding({uploads: {preset: "boxlabs-paste"}}).uploads;

			expect(second?.accept).to.not.include("audio/ogg");
			expect(second?.fields).to.deep.equal({strip_exif: "1"});
		});

		it("keeps the extra upload fields a deploy sets by hand", function () {
			const uploads = normalizeBranding({
				uploads: {
					endpoint: "https://x.test/up",
					fields: {strip_exif: "1", note: "  hi  ", "  ": "dropped", bad: []},
					optionalFields: ["strip_exif", 7],
					accept: ["image/png", "video/*"],
					responseErrorKey: "results.0.error",
				},
			}).uploads;

			expect(uploads?.fields).to.deep.equal({strip_exif: "1", note: "hi"});
			expect(uploads?.optionalFields).to.deep.equal(["strip_exif"]);
			expect(uploads?.accept).to.deep.equal(["image/png", "video/*"]);
			expect(uploads?.responseErrorKey).to.equal("results.0.error");
		});

		it("expands the litterbox preset, whose URL comes back as plain text", function () {
			const uploads = normalizeBranding({uploads: {preset: "catbox-litterbox"}}).uploads;

			expect(uploads).to.deep.equal({
				preset: "catbox-litterbox",
				endpoint: "https://litterbox.catbox.moe/resources/internals/api.php",
				fieldName: "fileToUpload",
				fields: {reqtype: "fileupload", time: "72h"},
				maxSizeBytes: 1024 * 1024 * 1024,
				// Refuses the OPTIONS preflight, so no upload progress is attempted.
				progress: false,
			});

			// No accept list: litterbox takes video too.
			expect(uploads).to.not.have.property("accept");
		});

		it("lets a deploy state whether its uploader answers the preflight", function () {
			expect(
				normalizeBranding({uploads: {preset: "catbox-litterbox", progress: true}}).uploads
					?.progress
			).to.equal(true);
			expect(
				normalizeBranding({uploads: {endpoint: "https://x.test/up", progress: false}})
					.uploads?.progress
			).to.equal(false);
			expect(
				normalizeBranding({uploads: {endpoint: "https://x.test/up"}}).uploads
			).to.not.have.property("progress");
		});

		it("merges fields per key so one can be changed alone", function () {
			const uploads = normalizeBranding({
				uploads: {preset: "catbox-litterbox", fields: {time: "1h"}},
			}).uploads;

			expect(uploads?.fields).to.deep.equal({reqtype: "fileupload", time: "1h"});
		});

		it("drops uploads naming a preset that does not exist", function () {
			expect(
				normalizeBranding({uploads: {preset: "nope", endpoint: "https://x.test/up"}})
			).to.not.have.property("uploads");
		});

		it("drops uploads unless the endpoint is an https URL", function () {
			expect(normalizeBranding({})).to.not.have.property("uploads");
			expect(normalizeBranding({uploads: {}})).to.not.have.property("uploads");
			expect(normalizeBranding({uploads: "https://x.test/up"})).to.not.have.property(
				"uploads"
			);
			expect(
				normalizeBranding({uploads: {endpoint: "http://x.test/up"}})
			).to.not.have.property("uploads");
			expect(
				normalizeBranding({uploads: {endpoint: "ftp://x.test/up"}})
			).to.not.have.property("uploads");
			expect(normalizeBranding({uploads: {endpoint: "https://"}})).to.not.have.property(
				"uploads"
			);
		});
	});
});
