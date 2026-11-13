/**
 * Web Push subscription (draft/webpush, phase 1 — docs/projects/push-subscription.md).
 *
 * Covers the client half of the round-trip the server probe verified against
 * the testnet ircd: the cap is requested only when its 302 value carries a
 * VAPID key, the REGISTER/UNREGISTER lines go out unsplit (or not at all),
 * the echoes and `FAIL WEBPUSH …` come back as `webpush:state`, and
 * `onRegistered` announces per-network VAPID availability.
 */

import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {SEANCE_CAPS, webpushVapidOf} from "../../client/js/irc/caps";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ALL_CAPS, register, setup, stubStorage} from "./support";

const VAPID =
	"BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_8uA1CpBkiyd_lc8ztobgKxEs1F7dFHQGB3yW5mgi54GkJBnGU";
const ENDPOINT = "https://push.example.com/send/AbCdEf-1234567890";

describe("Web Push subscription (draft/webpush)", function () {
	beforeEach(function () {
		stubStorage();
	});

	afterEach(function () {
		sinon.restore();
		socket.removeAllListeners();
	});

	describe("cap value parsing (webpushVapidOf)", function () {
		it("extracts the vapid= value", function () {
			expect(webpushVapidOf(`vapid=${VAPID}`)).to.equal(VAPID);
		});

		it("finds the key among other tokens and drops its = padding", function () {
			expect(webpushVapidOf(`foo=1,vapid=${VAPID}==`)).to.equal(VAPID);
		});

		it("rejects values without a usable vapid key", function () {
			expect(webpushVapidOf("")).to.be.undefined;
			expect(webpushVapidOf("bogus=1")).to.be.undefined;
			expect(webpushVapidOf("vapid=")).to.be.undefined;
		});
	});

	describe("capability negotiation", function () {
		it("lists draft/webpush among the caps seance wants", function () {
			expect(SEANCE_CAPS.wanted).to.include("draft/webpush");
		});

		it("requests draft/webpush when the server advertises a VAPID key", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			const req = h.events(); // touch to ensure registration ran
			void req;

			const sent = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));
			expect(sent).to.include("draft/webpush");
		});

		it("requests a bare draft/webpush too: the spec sends the key in 005 once it is on", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush`);

			const sent = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));
			expect(sent).to.include("draft/webpush");
		});
	});

	describe("onRegistered availability", function () {
		it("announces the network's VAPID key once registered", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			const payloads = h.payloads<{
				network: string;
				vapid: string | undefined;
				sasl: boolean;
			}>("webpush:available");
			expect(payloads).to.have.lengthOf(1);
			expect(payloads[0].network).to.equal(h.client.uuid);
			expect(payloads[0].vapid).to.equal(VAPID);
		});

		it("announces a connected server without push support as vapid undefined", function () {
			const h = setup();
			register(h, ALL_CAPS);

			const payloads = h.payloads<{
				network: string;
				vapid: string | undefined;
				sasl: boolean;
			}>("webpush:available");
			expect(payloads).to.have.lengthOf(1);
			expect(payloads[0].vapid).to.be.undefined;
		});

		it("announces the VAPID ISUPPORT key of a server that lists the cap bare (the spec)", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush`, [
				`:irc.test 005 alice VAPID=${VAPID}= :are supported by this server`,
			]);

			const payloads = h.payloads<{vapid: string | undefined}>("webpush:available");
			expect(payloads.map((p) => p.vapid)).to.deep.equal([VAPID]);
		});
	});

	describe("payload tier metadata (webpush:metadata)", function () {
		function payloadWrite(caps: string): string[] {
			const h = setup();
			register(h, caps);
			registerBusHandlers(socket, {
				clientForChannel: () => h.client,
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.sent();

			socket.emit("webpush:metadata", {
				network: h.client.uuid,
				key: "draft/webpush/payload",
				value: "full",
			});

			return h.sent().filter((l) => l.startsWith("METADATA * SET"));
		}

		it("writes the push payload tier private, so WHOIS does not list it", function () {
			expect(
				payloadWrite(`${ALL_CAPS} draft/metadata-2 draft/webpush=vapid=${VAPID}`)
			).to.deep.equal(["METADATA * SET draft/webpush/payload private :full"]);
		});

		it("writes a payload tier asked for without batch once batch comes", function () {
			const noBatch = ALL_CAPS.replace(" batch ", " ");
			const h = setup();
			register(h, `${noBatch} cap-notify draft/metadata-2 draft/webpush=vapid=${VAPID}`);
			h.sent();
			h.client.writePayloadTier("draft/webpush/payload", "full");
			expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
			h.transport.line(":irc.test CAP alice NEW :batch");
			h.transport.line(":irc.test CAP alice ACK :batch");
			expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([
				"METADATA * SET draft/webpush/payload private :full",
			]);
		});

		it("writes no payload tier without metadata in use (it needs batch)", function () {
			const noBatch = ALL_CAPS.replace(" batch ", " ");
			expect(
				payloadWrite(`${noBatch} draft/metadata-2 draft/webpush=vapid=${VAPID}`)
			).to.deep.equal([]);
			expect(payloadWrite(`${ALL_CAPS} draft/webpush=vapid=${VAPID}`)).to.deep.equal([]);
		});
	});

	describe("our metadata keys on a server without private keys (the spec)", function () {
		it("writes none of our private keys to a server that cannot keep them private", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush`, [], "someircd-1");
			expect(h.client.metadataSetLine("draft/webpush/payload", "full")).to.equal(undefined);
			expect(h.client.metadataSetLine("draft/webpush/payload", "")).to.equal(
				"METADATA * SET draft/webpush/payload"
			);
		});

		it("writes private until this connection's 004 has named the server", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush`, [], "someircd-1");
			h.transport.closed();
			h.client.connect();
			h.transport.open(); // a new connection: no 004 yet
			expect(h.client.metadataSetLine("seance/mode", "away 1")).to.equal(
				"METADATA * SET seance/mode private :away 1"
			);
		});

		it("does not rewrite a payload tier the server reports with its own visibility", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/metadata-2`, [], "someircd-1");
			h.transport.line(":irc.test 761 alice alice draft/webpush/payload * :full");
			expect(h.sent()).to.deep.equal([]);
		});
	});

	describe("outbound WEBPUSH lines (IrcClient.webpushRegister)", function () {
		it("sends REGISTER with tag-encoded keys", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			const ok = h.client.webpushRegister(ENDPOINT, {p256dh: "P256DH", auth: "AUTH"});

			expect(ok).to.be.true;
			expect(h.sent()).to.deep.equal([
				`WEBPUSH REGISTER ${ENDPOINT} p256dh=P256DH;auth=AUTH`,
			]);
		});

		it("sends UNREGISTER", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			const ok = h.client.webpushUnregister(ENDPOINT);

			expect(ok).to.be.true;
			expect(h.sent()).to.deep.equal([`WEBPUSH UNREGISTER ${ENDPOINT}`]);
		});

		it("refuses to send a REGISTER that would not fit one line", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			// MAX_LINE_BYTES is 500 (nefarious2's WebSocket frame guard); an
			// over-long endpoint must be refused whole, never split.
			const longEndpoint = `https://push.example.com/${"x".repeat(600)}`;
			const ok = h.client.webpushRegister(longEndpoint, {p256dh: "P", auth: "A"});

			expect(ok).to.be.false;
			expect(h.sent()).to.deep.equal([]);
		});
	});

	describe("inbound echoes and failures", function () {
		it("dispatches webpush:state for a REGISTER echo", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			h.transport.line(`:irc.test WEBPUSH REGISTER ${ENDPOINT}`);

			expect(h.payloads("webpush:state")).to.deep.equal([
				{network: h.client.uuid, action: "REGISTER", endpoint: ENDPOINT, ok: true},
			]);
		});

		it("dispatches webpush:state for an UNREGISTER echo", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			h.transport.line(`:irc.test WEBPUSH UNREGISTER ${ENDPOINT}`);

			expect(h.payloads("webpush:state")).to.deep.equal([
				{network: h.client.uuid, action: "UNREGISTER", endpoint: ENDPOINT, ok: true},
			]);
		});

		it("routes FAIL WEBPUSH with an endpoint (spec shape)", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			h.transport.line(
				`:irc.test FAIL WEBPUSH INVALID_PARAMS REGISTER ${ENDPOINT} :Invalid keys format (expected p256dh=...;auth=...)`
			);

			expect(h.payloads("webpush:state")).to.deep.equal([
				{
					network: h.client.uuid,
					action: "REGISTER",
					endpoint: ENDPOINT,
					ok: false,
					code: "INVALID_PARAMS",
					reason: "Invalid keys format (expected p256dh=...;auth=...)",
				},
			]);
		});

		it("routes FAIL WEBPUSH without an endpoint (nefarious2's ACCOUNT_REQUIRED)", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			h.transport.line(
				":irc.test FAIL WEBPUSH ACCOUNT_REQUIRED REGISTER :You must be logged in to register for push notifications"
			);

			expect(h.payloads("webpush:state")).to.deep.equal([
				{
					network: h.client.uuid,
					action: "REGISTER",
					endpoint: "",
					ok: false,
					code: "ACCOUNT_REQUIRED",
					reason: "You must be logged in to register for push notifications",
				},
			]);
		});
	});
});
