import {expect} from "chai";
import {banServiceBot, canBan} from "../../client/js/helpers/operMenu";
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
