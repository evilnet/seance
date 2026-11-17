import {expect} from "chai";
import {channelByName} from "../../client/js/helpers/channelByName";
import type {ClientChan, ClientNetwork} from "../../client/js/types";
import type {SharedServerOptions} from "../../shared/types/network";

function network(
	names: string[],
	CASEMAPPING?: SharedServerOptions["CASEMAPPING"]
): Pick<ClientNetwork, "channels" | "serverOptions"> {
	return {
		channels: names.map((name, id) => ({id, name} as ClientChan)),
		serverOptions: {
			CHANTYPES: ["#"],
			PREFIX: {prefix: [], modeToSymbol: {}, symbols: []},
			NETWORK: "Test",
			...(CASEMAPPING ? {CASEMAPPING} : {}),
		},
	};
}

describe("channelByName", function () {
	it("finds a channel whatever its case", function () {
		expect(channelByName(network(["lobby", "#Seance"]), "#seance")?.name).to.equal("#Seance");
		expect(channelByName(network(["lobby", "#seance"]), "#other")).to.equal(undefined);
	});

	it("folds as rfc1459 does: [ ] \\ ~ are { } | ^ (the default, before the 005)", function () {
		const net = network(["lobby", "#foo{bar}", "nick^"]);

		expect(channelByName(net, "#FOO[BAR]")?.name).to.equal("#foo{bar}");
		expect(channelByName(net, "nick~")?.name).to.equal("nick^");
		expect(channelByName(network(["#foo{bar}"], "rfc1459"), "#foo[bar]")).to.not.equal(
			undefined
		);
	});

	it("keeps [ and { apart where the network says ascii", function () {
		const net = network(["lobby", "#foo{bar}"], "ascii");

		expect(channelByName(net, "#foo[bar]")).to.equal(undefined);
		expect(channelByName(net, "#FOO{BAR}")?.name).to.equal("#foo{bar}");
	});

	it("never folds beyond ASCII, as IRC does not", function () {
		expect(channelByName(network(["#été"]), "#ÉTÉ")).to.equal(undefined);
	});
});
