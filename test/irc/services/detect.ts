import {expect} from "chai";
import sinon from "sinon";
import {IrcClient} from "../../../client/js/irc/client";
import {IdAllocator} from "../../../client/js/irc/ids";
import {NO_FAKE_LAG} from "../../../client/js/irc/fakelag";
import {botTrust} from "../../../client/js/irc/bottrust";
import {parseLine} from "../../../client/js/irc/message";
import {parseMappings} from "../../../client/js/irc/profiles/nefarious/mappings";
import {detectServices, rolesFromMappings} from "../../../client/js/irc/services/detect";
import {FakeTransport} from "../support";

/** AfterNET's `STATS R`, 2026-11-27. */
const AFTERNET_ROWS = [
	"Command   Name      Prepend    Target",
	"X3        X3        *          X3@X3.AfterNET.Services",
	"OPERSERV  O3        *          O3@x3.AfterNET.Services",
	"O3        O3        *          O3@x3.AfterNET.Services",
	"READ      MemoServ  READ       memoserv@x3.AfterNET.Services",
	"SEND      MemoServ  SEND       memoserv@x3.AfterNET.Services",
	"MEMO      MemoServ  *          memoserv@x3.AfterNET.Services",
	"MEMOSERV  MemoServ  *          memoserv@x3.AfterNET.Services",
	"GLOBAL    AfterNET  *          afternet@x3.AfterNET.Services",
	"AFTERNET  AfterNET  *          afternet@x3.AfterNET.Services",
	"AS        authserv  *          AuthServ@X3.AfterNET.Services",
	"AUTHSERV  authserv  *          AuthServ@X3.AfterNET.Services",
	"AUTH      authserv  AUTH       AuthServ@X3.AfterNET.Services",
];

const stats = (rows: string[], label = "") =>
	rows.map((row) => parseLine(`${label}:irc.test 276 opr ${row}`)!);

describe("services detection", function () {
	describe("the server's table", function () {
		it("reads STATS R, header and padding aside", function () {
			const rows = parseMappings(stats(AFTERNET_ROWS));
			expect(rows).to.have.length(12);
			expect(rows[0]).to.deep.equal({
				command: "X3",
				nick: "X3",
				server: "X3.AfterNET.Services",
			});
			expect(rows[11]).to.deep.equal({
				command: "AUTH",
				nick: "AuthServ",
				server: "X3.AfterNET.Services",
			});
		});

		it("places the bots their commands name and leaves the rest open", function () {
			const found = rolesFromMappings(parseMappings(stats(AFTERNET_ROWS)));
			expect(found.roles).to.deep.equal({oper: "O3", account: "AuthServ"});
			// The memo and global bots fill no role; X3 is the one left.
			expect(found.open).to.deep.equal(["X3"]);
			expect(found.servers.get("o3")).to.equal("x3.AfterNET.Services");
		});

		it("takes NICKSERV and CHANSERV by name", function () {
			const found = rolesFromMappings(
				parseMappings(
					stats([
						"CHANSERV  X         *          X@channels.example.net",
						"NICKSERV  N         *          N@channels.example.net",
					])
				)
			);
			expect(found.roles).to.deep.equal({channel: "X", account: "N"});
			expect(found.open).to.deep.equal([]);
		});
	});

	describe("at oper-up", function () {
		let dispatch: sinon.SinonSpy;

		function setup(): {client: IrcClient; transport: FakeTransport} {
			const caps = "batch labeled-response message-tags server-time";
			const transport = new FakeTransport();
			dispatch = sinon.spy();

			const client = new IrcClient({
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "opr",
				join: "",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
				ids: new IdAllocator(),
				transportFactory: () => transport,
				highlights: () => ({keywords: [], exceptions: []}),
				fakeLag: NO_FAKE_LAG,
				bus: {dispatch},
			});

			client.connect();
			transport.open();
			transport.lines(
				`:irc.test CAP * LS :${caps}`,
				`:irc.test CAP opr ACK :${caps}`,
				":irc.test 001 opr :Welcome to the SeanceDev IRC Network, opr",
				":irc.test 004 opr irc.test u2.10.12.14+Nefarious(2.0.0) abdgiknoqswxyzBDHLMNORWXY abCcDdhHikLlMmNnOopPQRrSsTtvZz bkLlov",
				":irc.test 422 opr :MOTD File is missing"
			);
			transport.sent = [];
			return {client, transport};
		}

		const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

		/** The label of the line sent last, as the prefix its answer carries. */
		async function asked(transport: FakeTransport, line: string): Promise<string> {
			for (let i = 0; i < 20 && !transport.sent.some((s) => s.endsWith(` ${line}`)); i++) {
				await tick();
			}

			const sent = transport.sent.find((s) => s.endsWith(` ${line}`));
			expect(sent, `${line} in ${JSON.stringify(transport.sent)}`).to.not.equal(undefined);
			return `${sent!.split(" ")[0]} `;
		}

		async function answerStats(transport: FakeTransport, rows: string[]): Promise<void> {
			const label = await asked(transport, "STATS R");
			transport.lines(
				...rows.map((row) => `${label}:irc.test 276 opr ${row}`),
				`${label}:irc.test 219 opr R :End of /STATS report`
			);
		}

		async function answerWhois(
			transport: FakeTransport,
			nick: string,
			realname: string,
			service = true
		): Promise<void> {
			const label = await asked(transport, `WHOIS ${nick}`);
			transport.lines(
				`${label}:irc.test 311 opr ${nick} ${nick} AfterNET.Services * :${realname}`,
				`${label}:irc.test 312 opr ${nick} x3.AfterNET.Services :X3 Services`,
				...(service ? [`${label}:irc.test 310 opr ${nick} :is a Network Service`] : []),
				`${label}:irc.test 318 opr ${nick} :End of /WHOIS list.`
			);
		}

		it("adopts the bots the table names once WHOIS calls them services", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, AFTERNET_ROWS);
			await answerWhois(transport, "O3", "Oper Services");
			await answerWhois(transport, "AuthServ", "Nick Services");
			await answerWhois(transport, "X3", "Channel Services");

			const services = await done;
			expect(services).to.deep.equal({
				package: "x3",
				bots: {oper: "O3", account: "AuthServ", channel: "X3", report: "", snoop: ""},
			});
			expect(client.services).to.deep.equal(services);
			expect(botTrust(client, "O3")).to.equal("trusted");
			expect(dispatch.calledWith("network:info", {uuid: client.uuid, services})).to.equal(
				true
			);
			// The table and one WHOIS a bot: nothing else was sent.
			expect(transport.sent).to.have.length(4);
		});

		it("asks the services server what it is when no realname says", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, AFTERNET_ROWS);
			await answerWhois(transport, "O3", "AfterNET Oper Service");
			await answerWhois(transport, "AuthServ", "AfterNET Accounts");
			await answerWhois(transport, "X3", "AfterNET Channels");

			const label = await asked(transport, "VERSION x3.AfterNET.Services");
			transport.line(
				`${label}:x3.AfterNET.Services 351 opr x3 2.0+[release] x3.AfterNET.Services`
			);

			// X3 is the only bot left for the only role left.
			expect((await done)?.bots).to.include({oper: "O3", account: "AuthServ", channel: "X3"});
		});

		it("adopts nothing when the services server is not a package it knows", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, AFTERNET_ROWS);
			await answerWhois(transport, "O3", "Operator Service");
			await answerWhois(transport, "AuthServ", "Accounts");
			await answerWhois(transport, "X3", "Channels");

			const label = await asked(transport, "VERSION x3.AfterNET.Services");
			transport.line(`${label}:x3.AfterNET.Services 351 opr srvx-1.4.0 x3.AfterNET.Services`);

			expect(await done).to.equal(undefined);
			expect(client.services).to.equal(undefined);
		});

		it("adopts nothing when a named bot is somebody else", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, AFTERNET_ROWS);
			await answerWhois(transport, "O3", "Oper Services", false);
			await answerWhois(transport, "AuthServ", "Nick Services");
			await answerWhois(transport, "X3", "Channel Services");

			expect(await done).to.equal(undefined);
			expect(client.services).to.equal(undefined);
			expect(dispatch.calledWith("network:info")).to.equal(false);
		});

		it("leaves a role blank that two bots could fill", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, [
				...AFTERNET_ROWS,
				"HELPER    Helper    *          Helper@x3.AfterNET.Services",
			]);
			await answerWhois(transport, "O3", "Oper Services");
			await answerWhois(transport, "AuthServ", "Nick Services");
			await answerWhois(transport, "X3", "AfterNET Channels");
			await answerWhois(transport, "Helper", "AfterNET Help");

			expect((await done)?.bots).to.include({oper: "O3", account: "AuthServ", channel: ""});
		});

		it("asks nothing where services are set, or the server has no table", async function () {
			const {client, transport} = setup();
			client.setServices({
				package: "x3",
				bots: {oper: "O3", account: "", channel: "", report: "", snoop: ""},
			});

			expect(await detectServices(client)).to.equal(undefined);
			expect(transport.sent).to.deep.equal([]);
		});

		it("adopts nothing from a table with no command it knows", async function () {
			const {client, transport} = setup();
			const done = detectServices(client);

			await answerStats(transport, [
				"X3        X3        *          X3@X3.AfterNET.Services",
			]);

			expect(await done).to.equal(undefined);
			expect(transport.sent).to.have.length(1);
		});
	});
});
