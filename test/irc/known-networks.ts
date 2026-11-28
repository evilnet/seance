import {expect} from "chai";
import {
	effectiveServices,
	KNOWN_NETWORKS,
	knownNetworkByHost,
	sameServices,
} from "../../client/js/irc/known-networks";
import * as saved from "../../client/js/irc/saved-networks";
import type {StorageBackend} from "../../client/js/irc/saved-networks";
import {servicesProfileFor} from "../../client/js/irc/services/index";
import type {ServicesConfig} from "../../shared/types/network";

const AFTERNET = KNOWN_NETWORKS.find((n) => n.id === "afternet")!;
const OTHER: ServicesConfig = {
	package: "x3",
	bots: {oper: "O3", account: "AuthServ", channel: "ChanServ", report: "", snoop: ""},
};

describe("known-networks", function () {
	it("every entry is reachable and names a package Seance has a profile for", function () {
		const ids = new Set<string>();

		for (const known of KNOWN_NETWORKS) {
			expect(ids.has(known.id), known.id).to.equal(false);
			ids.add(known.id);
			expect(known.host, known.id).to.match(/^[a-z0-9.-]+$/);
			expect(knownNetworkByHost(known.host), known.id).to.equal(known);

			if (known.services) {
				expect(servicesProfileFor(known.services), known.id).to.not.equal(undefined);
			}
		}
	});

	it("finds a network by a host under one of its domains, and by nothing else", function () {
		expect(knownNetworkByHost("irc.afternet.org")).to.equal(AFTERNET);
		expect(knownNetworkByHost("wss://Fractalrealities.AfterNET.org:9998/")).to.equal(AFTERNET);
		expect(knownNetworkByHost("afternet.org/ws")).to.equal(AFTERNET);
		expect(knownNetworkByHost("notafternet.org")).to.equal(undefined);
		expect(knownNetworkByHost("afternet.org.example.net")).to.equal(undefined);
		expect(knownNetworkByHost("")).to.equal(undefined);
		expect(knownNetworkByHost(undefined)).to.equal(undefined);
	});

	it("a network follows the list until the oper says otherwise", function () {
		expect(effectiveServices({host: "irc.afternet.org"})).to.deep.equal(AFTERNET.services);
		expect(effectiveServices({host: "irc.example.org"})).to.equal(undefined);
		expect(effectiveServices(undefined, "irc.afternet.org")).to.deep.equal(AFTERNET.services);
		expect(effectiveServices({host: "irc.afternet.org", services: OTHER})).to.equal(OTHER);
		// "None", chosen.
		expect(effectiveServices({host: "irc.afternet.org", servicesChosen: true})).to.equal(
			undefined
		);
		// A copy: nothing that edits a network's bots edits the list.
		expect(effectiveServices({host: "irc.afternet.org"})?.bots).to.not.equal(
			AFTERNET.services?.bots
		);
	});

	it("compares two services blocks", function () {
		expect(sameServices(undefined, undefined)).to.equal(true);
		expect(sameServices(OTHER, undefined)).to.equal(false);
		expect(sameServices(OTHER, {...OTHER, bots: {...OTHER.bots}})).to.equal(true);
		expect(sameServices(OTHER, {...OTHER, bots: {...OTHER.bots, channel: "X3"}})).to.equal(
			false
		);
	});

	describe("what the edit form stores", function () {
		let data: Record<string, string>;

		beforeEach(function () {
			data = {};

			const backend: StorageBackend = {
				get: (key) => data[key] ?? null,
				set(key, value) {
					data[key] = value;
				},
				remove(key) {
					delete data[key];
				},
			};

			saved.useStorageBackend(backend);
		});

		afterEach(function () {
			saved.useStorageBackend(null);
		});

		const form = (host: string, extra: Record<string, unknown> = {}) => ({
			uuid: "11111111-1111-4111-8111-111111111111",
			host,
			port: 9998,
			tls: true,
			nick: "opr",
			...extra,
		});

		it("the list's own values posted back are no choice", function () {
			const net = saved.fromForm(form("irc.afternet.org", {services: AFTERNET.services}));
			expect(net.services).to.equal(undefined);
			expect(net.servicesChosen).to.equal(undefined);
			expect(effectiveServices(net)).to.deep.equal(AFTERNET.services);
		});

		it("other values, and None over what the list says, are", function () {
			const edited = saved.fromForm(form("irc.afternet.org", {services: OTHER}));
			expect(edited.services).to.deep.equal(OTHER);
			expect(edited.servicesChosen).to.equal(true);

			// A form that posts no services key says nothing about them.
			expect(saved.fromForm(form("irc.afternet.org")).servicesChosen).to.equal(undefined);

			// The form's "None" is the key with nothing in it.
			const off = saved.fromForm(form("irc.afternet.org", {services: undefined}));
			expect(off.services).to.equal(undefined);
			expect(off.servicesChosen).to.equal(true);
			expect(effectiveServices(off)).to.equal(undefined);

			// Back to the list's values: following it again.
			const back = saved.fromForm(
				form("irc.afternet.org", {services: AFTERNET.services}),
				off
			);
			expect(back.servicesChosen).to.equal(undefined);
			expect(effectiveServices(back)).to.deep.equal(AFTERNET.services);
		});

		it("None on a network with nothing set leaves it open to detection", function () {
			const net = saved.fromForm(form("irc.example.org", {services: undefined}));
			expect(net.services).to.equal(undefined);
			expect(net.servicesChosen).to.equal(undefined);
		});

		it("detected services posted back unchanged stay detected; removed, they are a choice", function () {
			const detected = saved.normalize({...form("irc.example.org"), services: OTHER})!;
			const same = saved.fromForm(form("irc.example.org", {services: OTHER}), detected);
			expect(same.services).to.deep.equal(OTHER);
			expect(same.servicesChosen).to.equal(undefined);

			const removed = saved.fromForm(
				form("irc.example.org", {services: undefined}),
				detected
			);
			expect(removed.services).to.equal(undefined);
			expect(removed.servicesChosen).to.equal(true);
		});
	});
});
