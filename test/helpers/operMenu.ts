import {expect} from "chai";
import socket from "../../client/js/socket";
import {
	banServiceBot,
	canBan,
	operChanFor,
	operTargetItems,
	userhostItem,
} from "../../client/js/helpers/operMenu";
import type {ClientNetwork} from "../../client/js/types";

/** A network as the menu helpers see it: the oper state and the services setting. */
function network(oper: Partial<ClientNetwork["oper"]>, services?: ClientNetwork["services"]) {
	return {
		uuid: "n1",
		nick: "me",
		channels: [{id: 1}],
		oper: {
			level: "global",
			privs: [],
			privsKnown: true,
			umodes: "o",
			profile: "nefarious2",
			features: {},
			...oper,
		},
		services,
	} as unknown as ClientNetwork;
}

const x3: ClientNetwork["services"] = {
	package: "x3",
	bots: {
		oper: "O3",
		account: "AuthServ",
		channel: "ChanServ",
		report: "#operserv",
		snoop: "#mrsnoopy",
	},
};

describe("ban gating (helpers/operMenu.ts canBan)", function () {
	it("offers a G-line on the server's privilege", function () {
		expect(canBan(network({privs: ["GLINE"]}), "gline")).to.equal(true);
		expect(canBan(network({privs: ["LOCAL_GLINE"]}), "gline")).to.equal(true);
		expect(canBan(network({privs: ["KILL", "WIDE_GLINE"]}), "gline")).to.equal(false);
	});

	it("offers a G-line and a shun through the oper service when PRIVS says no", function () {
		// X3's auto_oper_privs: KILL and WIDE_GLINE, no GLINE, no SHUN.
		const afternet = network({privs: ["KILL", "WIDE_GLINE", "WIDE_SHUN"]}, x3);
		expect(canBan(afternet, "gline")).to.equal(true);
		expect(canBan(afternet, "shun")).to.equal(true);
		expect(canBan(afternet, "zline"), "no services route for a Z-line").to.equal(false);
		expect(banServiceBot(afternet)).to.equal("O3");
	});

	it("offers nothing to a non-oper, on another ircd, or with the bot unset", function () {
		expect(canBan(network({level: "none", privs: ["GLINE"]}, x3), "gline")).to.equal(false);
		expect(canBan(network({profile: "generic", privs: ["GLINE"]}, x3), "gline")).to.equal(
			false
		);
		expect(
			canBan(network({privs: []}, {...x3, bots: {...x3.bots, oper: " "}}), "gline")
		).to.equal(false);
		expect(canBan(network({privsKnown: false}), "gline"), "not reported yet: offered").to.equal(
			true
		);
	});
});

describe("a chip's menu (helpers/operMenu.ts operTargetItems)", function () {
	const run = (items: ReturnType<typeof operTargetItems>, cls: string): void => {
		items.find((item) => item.type === "item" && item.class === cls)?.action?.();
	};

	it("says where a Check or a Who went, so the card can point there", function () {
		const net = network({privs: ["CHECK"]});
		const sent: number[] = [];
		const emitted: unknown[] = [];
		const emit = socket.emit.bind(socket);
		socket.emit = ((name: string, data: unknown) => {
			emitted.push([name, data]);
		}) as typeof socket.emit;

		try {
			run(
				operTargetItems(net, 7, "ip", "198.51.100.4", (c) => sent.push(c)),
				"oper-check"
			);
			run(
				operTargetItems(net, 7, "host", "u@a.example", (c) => sent.push(c)),
				"oper-who"
			);
			run(operTargetItems(net, 7, "ip", "198.51.100.4"), "oper-who");
		} finally {
			socket.emit = emit;
		}

		expect(sent).to.deep.equal([7, 7]);
		expect(emitted).to.deep.equal([
			["input", {target: 7, text: "/check 198.51.100.4"}],
			["input", {target: 7, text: "/who a.example xh"}],
			["input", {target: 7, text: "/who 198.51.100.4 xi"}],
		]);
	});
});

describe("operChanFor (helpers/operMenu.ts)", function () {
	const a = {uuid: "a", channels: [{id: 10}, {id: 11}]};
	const b = {uuid: "b", channels: [{id: 20}, {id: 21}]};

	it("runs in the active window when it is on the card's network", function () {
		expect(operChanFor(a, {network: a, channel: {id: 11}})).to.equal(11);
	});

	it("runs in the card's own lobby when another network's window is active", function () {
		expect(operChanFor(a, {network: b, channel: {id: 21}})).to.equal(10);
	});
});

describe("userhostItem (helpers/operMenu.ts)", function () {
	const line = (command: string, text: string) => ({command, params: ["me", text]});

	it("finds the item for the asked nick, not the first one", function () {
		const lines = [
			line("340", "alice=+a@192.0.2.10"),
			line("340", "Bob*=+b@192.0.2.20 carol=-c@192.0.2.30"),
		];
		expect(userhostItem(lines, "340", "bob")).to.deep.equal({user: "b", host: "192.0.2.20"});
		expect(userhostItem(lines, "340", "carol")).to.deep.equal({user: "c", host: "192.0.2.30"});
	});

	it("is undefined when only someone else's answer came", function () {
		expect(userhostItem([line("302", "alice=+a@host.example")], "302", "bob")).to.equal(
			undefined
		);
	});
});
