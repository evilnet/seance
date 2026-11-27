import {expect} from "chai";
import type {Entries} from "../../client/js/sync/document";
import {apply, collect, isRoamingKey, type EntryContext} from "../../client/js/sync/entries";

const HOME = "home-uuid";
const OTHER = "other-uuid";

interface Device {
	ctx: EntryContext;
	stored: Map<string, string>;
	settings: Record<string, unknown>;
	/** What is stored under `key`, parsed. */
	read(key: string): unknown;
	put(key: string, value: unknown): void;
}

function device(): Device {
	const stored = new Map<string, string>();
	const defaults: Record<string, unknown> = {theme: "coffee", media: true, also: [] as string[]};
	const settings: Record<string, unknown> = {...defaults};

	return {
		stored,
		settings,
		read: (key) => (stored.has(key) ? (JSON.parse(stored.get(key)!) as unknown) : undefined),
		put: (key, value) => void stored.set(key, JSON.stringify(value)),
		ctx: {
			home: HOME,
			storage: {
				get: (key) => stored.get(key) ?? null,
				set: (key, value) => void stored.set(key, value),
				remove: (key) => void stored.delete(key),
			},
			settings: {
				values: () => ({...settings}),
				defaults: () => ({...defaults}),
				set(name, value) {
					if (name === "theme" && value === "not-shipped") {
						return false;
					}

					settings[name] = value;
					return true;
				},
			},
		},
	};
}

const live = (values: Record<string, unknown>): Entries =>
	Object.fromEntries(Object.entries(values).map(([id, v]) => [id, {t: 5, v}]));

/** Everything one device holds, applied to a second: the second then reads the same. */
function carry(from: Device, to: Device): void {
	apply(to.ctx, live(collect(from.ctx).current));
}

describe("settings sync entries (sync/entries.ts)", function () {
	it("reads a fresh device as defaults nobody chose", function () {
		const d = device();
		const local = collect(d.ctx);

		for (const [id, value] of Object.entries(local.current)) {
			expect(local.isDefault(id, value), id).to.equal(true);
		}
	});

	it("carries every store from one device to another", function () {
		const a = device();
		a.settings.theme = "day";
		a.settings.also = ["de", "fr"];
		a.put("thelounge.aliases", [
			{name: "wave", body: "/me waves at $1"},
			{name: "j", body: "/join $*"},
		]);
		a.put("thelounge.muted", [`${HOME}/#loud`, `${OTHER}/#elsewhere`]);
		a.put("thelounge.favorites", [
			{network: HOME, name: "#Seance", type: "channel"},
			{network: OTHER, name: "#other", type: "channel"},
			{network: HOME, name: "alice", type: "query"},
		]);
		a.put("thelounge.sort.channels", {[HOME]: ["#b", "#a"], [OTHER]: ["#z"]});
		a.put(`thelounge.ignore.${HOME}`, [{nick: "Troll", ident: "*", hostname: "*", when: 100}]);
		a.put("thelounge.media.trusted", {
			host: ["i.example.org"],
			channel: [`${HOME}/#pics`, `${OTHER}/#nope`],
			account: [`${HOME}/alice`],
		});
		a.put("thelounge.avatars", {off: [OTHER], people: [`${HOME}/alice@i.example.org`]});
		a.put("thelounge.dnd", {
			manual: {kind: "indefinite"},
			schedule: {enabled: true, start: "22:00", end: "06:30", days: [1, 2, 3]},
			scheduleSkippedUntil: null,
			mode: {value: "away", at: 77},
		});
		a.put("thelounge.oper", {
			[HOME]: {
				routes: {"conn.connect": "off"},
				snomask: 1234,
				temporary: {"conn.exit": {route: "active", until: 999, revert: "off"}},
				notes: {"#spam": "watch this one"},
			},
			[OTHER]: {snomask: 1},
		});
		a.put("thelounge.translate", {
			version: 2,
			[`${HOME}/#paris`]: {
				exclude: false,
				write: "fr",
				writeFrom: null,
				formality: "formal",
				terms: [{source: "hi", target: "salut", from: "en", to: "fr"}],
				once: "fr",
				noSuggest: true,
			},
			[`${OTHER}/#berlin`]: {exclude: true},
		});

		const b = device();
		b.put("thelounge.translate", {version: 2});
		carry(a, b);

		const ids = Object.keys(collect(a.ctx).current).sort();

		expect(ids).to.deep.equal([
			"alias:j",
			"alias:wave",
			"dnd:schedule",
			"fav:#seance",
			"fav:alice",
			"ignore:troll!*@*",
			"mute:#loud",
			"oper:note:#spam",
			"oper:route:conn.connect",
			"oper:snomask",
			"oper:temp:conn.exit",
			"order:channels",
			"order:fav",
			"person:alice@i.example.org",
			"set:also",
			"set:media",
			"set:theme",
			"tr:#paris",
			"trust:account:alice",
			"trust:channel:#pics",
			"trust:host:i.example.org",
		]);
		expect(collect(b.ctx).current).to.deep.equal(collect(a.ctx).current);

		// What belongs to another network, or to the device, did not travel.
		expect(b.settings).to.deep.equal({theme: "day", media: true, also: ["de", "fr"]});
		expect(b.read("thelounge.muted")).to.deep.equal([`${HOME}/#loud`]);
		expect(b.read("thelounge.favorites")).to.deep.equal([
			{network: HOME, name: "#Seance", type: "channel"},
			{network: HOME, name: "alice", type: "query"},
		]);
		expect(b.read("thelounge.sort.channels")).to.deep.equal({[HOME]: ["#b", "#a"]});
		expect(b.read("thelounge.avatars")).to.deep.equal({
			off: [],
			people: [`${HOME}/alice@i.example.org`],
		});
		expect(b.read("thelounge.oper")).to.deep.equal({
			[HOME]: (a.read("thelounge.oper") as any)[HOME],
		});

		// The schedule roams; the manual switch and the mode are shared elsewhere.
		expect(b.read("thelounge.dnd")).to.deep.include({
			manual: {kind: "off"},
			mode: {value: "auto", at: null},
		});
		// The choices roam; the terms learnt and the last language picked stay.
		expect((b.read("thelounge.translate") as any)[`${HOME}/#paris`]).to.deep.equal({
			exclude: false,
			write: "fr",
			writeFrom: null,
			formality: "formal",
			terms: [],
			once: null,
			noSuggest: true,
		});
	});

	it("leaves another network's entries on the device as they were", function () {
		const b = device();
		b.put("thelounge.muted", [`${OTHER}/#mine`]);
		b.put("thelounge.favorites", [
			{network: OTHER, name: "#first", type: "channel"},
			{network: HOME, name: "#old", type: "channel"},
			{network: OTHER, name: "#last", type: "channel"},
		]);
		b.put("thelounge.avatars", {off: [OTHER], people: [`${OTHER}/bob@x.example`]});
		apply(b.ctx, {
			"mute:#loud": {t: 5, v: true},
			"fav:#old": {t: 5},
			"fav:#new": {t: 5, v: {name: "#new", type: "channel"}},
			"person:alice@i.example.org": {t: 5, v: true},
		});

		expect(b.read("thelounge.muted")).to.deep.equal([`${OTHER}/#mine`, `${HOME}/#loud`]);
		// The home's favorite takes the place the home's had in the block.
		expect(
			(b.read("thelounge.favorites") as {name: string}[]).map((f) => f.name)
		).to.deep.equal(["#first", "#new", "#last"]);
		expect(b.read("thelounge.avatars")).to.deep.equal({
			off: [OTHER],
			people: [`${OTHER}/bob@x.example`, `${HOME}/alice@i.example.org`],
		});
	});

	it("applies a removal, and leaves what the document does not name", function () {
		const d = device();
		d.put("thelounge.aliases", [
			{name: "keep", body: "/me keeps"},
			{name: "drop", body: "/me drops"},
		]);
		d.settings.theme = "day";
		const result = apply(d.ctx, {
			"alias:drop": {t: 5},
			"set:theme": {t: 5},
			"set:media": {t: 5, v: false},
		});

		expect(d.read("thelounge.aliases")).to.deep.equal([{name: "keep", body: "/me keeps"}]);
		// A removed setting is back at this device's default.
		expect(d.settings).to.deep.include({theme: "coffee", media: false});
		expect(result.keys).to.deep.equal(["thelounge.aliases"]);
		expect(result.changes).to.deep.include({
			id: "alias:drop",
			before: {name: "drop", body: "/me drops"},
		});
	});

	it("applies only the ids asked for", function () {
		const d = device();
		apply(d.ctx, {"set:theme": {t: 5, v: "day"}, "set:media": {t: 5, v: false}}, ["set:theme"]);

		expect(d.settings).to.deep.include({theme: "day", media: true});
	});

	it("orders the favorites by the order entry, the unnamed after", function () {
		const d = device();
		apply(d.ctx, {
			"fav:#a": {t: 5, v: {name: "#a", type: "channel"}},
			"fav:#b": {t: 5, v: {name: "#b", type: "channel"}},
			"fav:#c": {t: 5, v: {name: "#c", type: "channel"}},
			"order:fav": {t: 5, v: ["#c", "#a"]},
		});

		expect(
			(d.read("thelounge.favorites") as {name: string}[]).map((f) => f.name)
		).to.deep.equal(["#c", "#a", "#b"]);
	});

	it("keeps the user's alias order and puts new ones after", function () {
		const d = device();
		d.put("thelounge.aliases", [
			{name: "z", body: "/me z"},
			{name: "a", body: "/me a"},
		]);
		apply(d.ctx, {
			"alias:m": {t: 5, v: {name: "m", body: "/me m"}},
			"alias:a": {t: 5, v: {name: "a", body: "/me changed"}},
		});

		expect(d.read("thelounge.aliases")).to.deep.equal([
			{name: "z", body: "/me z"},
			{name: "a", body: "/me changed"},
			{name: "m", body: "/me m"},
		]);
	});

	it("does not take what it cannot hold", function () {
		const d = device();
		const result = apply(d.ctx, {
			"alias:bad name": {t: 5, v: {name: "bad name", body: "/quit"}},
			"alias:other": {t: 5, v: {name: "mismatch", body: "/quit"}},
			"alias:long": {t: 5, v: {name: "long", body: "x".repeat(2001)}},
			"set:theme": {t: 5, v: "not-shipped"},
			"set:media": {t: 5, v: "yes"},
			"set:also": {t: 5, v: "de"},
			"mute:#x": {t: 5, v: "true"},
			"fav:#f": {t: 5, v: {name: "#f", type: "window"}},
			"ignore:a!b@c": {t: 5, v: {nick: "a", ident: "b"}},
			"trust:host:Evil.example": {t: 5, v: true},
			"person:nohost": {t: 5, v: true},
			"dnd:schedule": {t: 5, v: {enabled: true, start: "25:00", end: "07:00", days: []}},
			"oper:route:kind": {t: 5, v: "everywhere"},
			"oper:snomask": {t: 5, v: "+s"},
		});

		expect(result.changes).to.deep.equal([]);
		expect(d.settings).to.deep.equal({theme: "coffee", media: true, also: []});
	});

	it("keeps the device's own alias, favorite and ignore where the incoming value is one it cannot hold", function () {
		const d = device();
		d.put("thelounge.aliases", [{name: "wave", body: "/me waves"}]);
		d.put("thelounge.favorites", [{network: HOME, name: "#f", type: "channel"}]);
		d.put(`thelounge.ignore.${HOME}`, [{nick: "a", ident: "b", hostname: "c", when: 1}]);
		const result = apply(d.ctx, {
			"alias:wave": {t: 5, v: {name: "wave", body: "x".repeat(2001)}},
			"fav:#f": {t: 5, v: {name: "#f", type: "window"}},
			"ignore:a!b@c": {t: 5, v: {nick: "a", ident: "b"}},
			"mute:#x": {t: 5, v: true},
		});

		expect(result.changes.map((change) => change.id)).to.deep.equal(["mute:#x"]);
		expect(d.read("thelounge.aliases")).to.deep.equal([{name: "wave", body: "/me waves"}]);
		expect(d.read("thelounge.favorites")).to.deep.equal([
			{network: HOME, name: "#f", type: "channel"},
		]);
		expect(d.read(`thelounge.ignore.${HOME}`)).to.deep.equal([
			{nick: "a", ident: "b", hostname: "c", when: 1},
		]);
	});

	it("does not own a setting this build does not have, nor an unknown kind of entry", function () {
		const local = collect(device().ctx);

		expect(local.owns("set:theme")).to.equal(true);
		expect(local.owns("set:fromTheFuture")).to.equal(false);
		expect(local.owns("widget:1")).to.equal(false);
	});

	it("leaves the translation choices alone until the blob is this version's", function () {
		const d = device();
		d.put("thelounge.translate", {[`${HOME}/#old`]: {read: true, write: "de"}});

		expect(collect(d.ctx).owns("tr:#old")).to.equal(false);
		expect(Object.keys(collect(d.ctx).current)).to.not.include("tr:#old");

		apply(d.ctx, {"tr:#new": {t: 5, v: {write: "fr"}}});

		expect(d.read("thelounge.translate")).to.deep.equal({
			[`${HOME}/#old`]: {read: true, write: "de"},
		});
	});

	it("names the storage keys a change to date may be written to", function () {
		expect(isRoamingKey("settings", HOME)).to.equal(true);
		expect(isRoamingKey("thelounge.aliases", HOME)).to.equal(true);
		expect(isRoamingKey(`thelounge.ignore.${HOME}`, HOME)).to.equal(true);
		expect(isRoamingKey(`thelounge.ignore.${OTHER}`, HOME)).to.equal(false);
		expect(isRoamingKey("thelounge.networks", HOME)).to.equal(false);
		expect(isRoamingKey("thelounge.state.sync", HOME)).to.equal(false);
	});

	describe("the home network's saved network", function () {
		const X3 = {
			package: "x3",
			bots: {
				oper: "O3",
				account: "AuthServ",
				channel: "ChanServ",
				report: "#operserv",
				snoop: "",
			},
		};
		/** Where and how a device reaches the network: never in the file. */
		const reach = (extra: Record<string, unknown>) => ({
			host: "irc.example",
			port: 6697,
			tls: true,
			sasl: "plain",
			saslAccount: "me",
			saslPassword: "secret",
			rememberPassword: true,
			autoconnect: true,
			pushEnabled: true,
			trustedCertificates: ["ab".repeat(32)],
			cursor: {msgid: "m1", time: 5},
			...extra,
		});
		const net = (uuid: string, extra: Record<string, unknown> = {}) => ({
			uuid,
			name: "",
			nick: "me",
			join: "",
			commands: [],
			...extra,
		});

		it("carries the home's name, nick, channels, commands and services, and nothing of how to reach it", function () {
			const a = device();
			a.put("thelounge.networks", [
				net(HOME, {
					name: "AfterNET",
					nick: "phone",
					join: "#afternet,#seance",
					commands: ["/mode phone +x"],
					services: X3,
					...reach({}),
				}),
				net(OTHER, {nick: "elsewhere", services: X3}),
			]);
			const b = device();
			const macReach = reach({
				host: "irc.mac.example",
				tls: false,
				saslPassword: "mac-secret",
				autoconnect: false,
				pushEnabled: false,
				trustedCertificates: [],
				cursor: {msgid: "m9", time: 9},
			});
			b.put("thelounge.networks", [net(OTHER), net(HOME, {nick: "mac", ...macReach})]);

			expect(
				Object.keys(collect(a.ctx).current)
					.filter((id) => id.startsWith("net:"))
					.sort()
			).to.deep.equal(["net:commands", "net:join", "net:name", "net:nick", "net:services"]);
			carry(a, b);

			expect(b.read("thelounge.networks")).to.deep.equal([
				net(OTHER),
				net(HOME, {
					name: "AfterNET",
					nick: "phone",
					join: "#afternet,#seance",
					commands: ["/mode phone +x"],
					services: X3,
					...macReach,
				}),
			]);
		});

		it("reads a network nobody customised as defaults, but for the nick", function () {
			const d = device();
			d.put("thelounge.networks", [net(HOME)]);
			const local = collect(d.ctx);

			expect(local.isDefault("net:name", local.current["net:name"])).to.equal(true);
			expect(local.isDefault("net:join", local.current["net:join"])).to.equal(true);
			expect(local.isDefault("net:commands", local.current["net:commands"])).to.equal(true);
			expect(local.isDefault("net:nick", local.current["net:nick"])).to.equal(false);
			expect(local.current).not.to.have.property("net:services");
		});

		it("removes the services support when the other device set it back to none", function () {
			const b = device();
			b.put("thelounge.networks", [net(HOME, {services: X3})]);
			apply(b.ctx, {"net:services": {t: 5}});

			expect(b.read("thelounge.networks")).to.deep.equal([net(HOME)]);
			expect(collect(b.ctx).current).not.to.have.property("net:services");
		});

		it("keeps the device's own value where the incoming one is one it cannot hold", function () {
			const b = device();
			b.put("thelounge.networks", [net(HOME, {nick: "mac", services: X3})]);
			apply(b.ctx, {
				"net:services": {t: 5, v: {package: "anope", bots: {}}},
				"net:nick": {t: 5, v: "two words"},
				"net:commands": {t: 5, v: ["/ok", "/bad\r\nQUIT"]},
			});

			expect(b.read("thelounge.networks")).to.deep.equal([
				net(HOME, {nick: "mac", services: X3}),
			]);
		});

		it("writes nothing on a device that has not saved the home network", function () {
			const b = device();
			b.put("thelounge.networks", [net(OTHER)]);
			const {keys} = apply(b.ctx, {
				"net:services": {t: 5, v: X3},
				"net:nick": {t: 5, v: "x"},
			});

			expect(keys).to.deep.equal([]);
			expect(b.read("thelounge.networks")).to.deep.equal([net(OTHER)]);
		});
	});
});
