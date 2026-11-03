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

		it("does not request draft/webpush without a VAPID value", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush`);

			const sent = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));
			expect(sent).to.not.include("draft/webpush");
		});
	});

	describe("onRegistered availability", function () {
		it("announces the network's VAPID key once registered", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);

			const payloads =
				h.payloads<{network: string; vapid: string | undefined; sasl: boolean}>(
					"webpush:available"
				);
			expect(payloads).to.have.lengthOf(1);
			expect(payloads[0].network).to.equal(h.client.uuid);
			expect(payloads[0].vapid).to.equal(VAPID);
		});

		it("announces a connected server without push support as vapid undefined", function () {
			const h = setup();
			register(h, ALL_CAPS);

			const payloads =
				h.payloads<{network: string; vapid: string | undefined; sasl: boolean}>(
					"webpush:available"
				);
			expect(payloads).to.have.lengthOf(1);
			expect(payloads[0].vapid).to.be.undefined;
		});

		it("falls back to the VAPID ISUPPORT token when the cap carries no value", function () {
			// The cap cannot be enabled without its value, so this network has
			// push "unavailable" from the negotiator's point of view — but a
			// later 005 VAPID token (CAP NEW after services hand the key out)
			// must still surface through isupport.
			const h = setup();
			register(h, ALL_CAPS);
			h.transport.line(
				":irc.test 005 alice VAPID=BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_ :are supported by this server"
			);

			expect(h.client.isupport.vapid).to.equal("BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_");
		});
	});

	describe("payload tier metadata (webpush:metadata)", function () {
		it("writes the push payload tier private, so WHOIS does not list it", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/webpush=vapid=${VAPID}`);
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

			expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/payload private :full"]);
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
