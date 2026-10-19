import {expect} from "chai";
import {
	aliasNames,
	expandAlias,
	isValidAliasName,
	loadAliases,
	MAX_ALIASES,
	MAX_BODY_LENGTH,
	MAX_DEPTH,
	MAX_LINES,
	saveAliases,
	STORAGE_KEY,
	useStorageBackend,
	type Alias,
} from "../../client/js/helpers/aliases";

describe("command aliases (helpers/aliases.ts)", function () {
	let store: Map<string, string>;

	beforeEach(function () {
		store = new Map<string, string>();
		useStorageBackend({
			get: (key) => store.get(key) ?? null,
			set: (key, value) => void store.set(key, value),
			remove: (key) => void store.delete(key),
		});
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	const set = (list: Alias[]) => store.set(STORAGE_KEY, JSON.stringify(list));

	describe("expandAlias", function () {
		it("leaves plain text, //-escapes and unknown commands alone", function () {
			set([{name: "wave", body: "/me waves"}]);
			expect(expandAlias("hello /wave", {})).to.equal(null);
			expect(expandAlias("//wave", {})).to.equal(null);
			expect(expandAlias("/waves", {})).to.equal(null);
			expect(expandAlias("/join #chan", {})).to.equal(null);
		});

		it("substitutes positional arguments", function () {
			set([{name: "k", body: "/kick $1 $2-"}]);
			expect(expandAlias("/k bob flooding the channel", {})).to.deep.equal([
				"/kick bob flooding the channel",
			]);
		});

		it("leaves a missing argument empty and trims the tail", function () {
			set([{name: "k", body: "/kick $1 $2-"}]);
			expect(expandAlias("/k bob", {})).to.deep.equal(["/kick bob"]);
		});

		it("passes $* verbatim and knows $chan, $me and $$", function () {
			set([{name: "s", body: "/msg X $* in $chan as $me for $$5"}]);
			expect(expandAlias("/s op  me", {chan: "#seance", me: "rubin"})).to.deep.equal([
				"/msg X op  me in #seance as rubin for $5",
			]);
		});

		it("substitutes empty for $chan/$me when unknown", function () {
			set([{name: "w", body: "/whois $me$chan bob"}]);
			expect(expandAlias("/w", {})).to.deep.equal(["/whois  bob"]);
		});

		it("matches names case-insensitively", function () {
			set([{name: "Wave", body: "/me waves at $1"}]);
			expect(expandAlias("/wAvE bob", {})).to.deep.equal(["/me waves at bob"]);
		});

		it("supports $10 and up, leaves $0 and unknown $words literal", function () {
			set([{name: "t", body: "/echo $10 $0 $chans $meow"}]);
			const args = "a b c d e f g h i j".split(" ").join(" ");
			expect(expandAlias(`/t ${args}`, {})).to.deep.equal(["/echo j $0 $chans $meow"]);
		});

		it("splits a multi-line body into lines and drops blank ones", function () {
			set([{name: "hi", body: "/join $1\n\nhello $2\n"}]);
			expect(expandAlias("/hi #chan bob", {})).to.deep.equal(["/join #chan", "hello bob"]);
		});

		it("expands an alias used inside another alias", function () {
			set([
				{name: "wave", body: "/me waves at $1"},
				{name: "greet", body: "/wave $1\nwelcome to $chan, $1!"},
			]);
			expect(expandAlias("/greet bob", {chan: "#seance"})).to.deep.equal([
				"/me waves at bob",
				"welcome to #seance, bob!",
			]);
		});

		it("lets an alias wrap the command it shadows without looping", function () {
			set([{name: "join", body: "/join #lobby $*"}]);
			expect(expandAlias("/join #seance", {})).to.deep.equal(["/join #lobby #seance"]);
		});

		it("terminates a mutual cycle", function () {
			set([
				{name: "a", body: "/b $*"},
				{name: "b", body: "/a $*"},
			]);
			expect(expandAlias("/a x", {})).to.deep.equal(["/a x"]);
		});

		it("stops nesting at MAX_DEPTH", function () {
			const list: Alias[] = [];

			for (let i = 0; i < MAX_DEPTH + 2; i++) {
				list.push({name: `n${i}`, body: `/n${i + 1} deep`});
			}

			set(list);
			const result = expandAlias("/n0 go", {});
			expect(result).to.have.length(1);
			expect(result?.[0]).to.match(/^\/n\d+ deep$/);
		});

		it("stops at MAX_LINES however the aliases multiply", function () {
			const fan = (to: string) =>
				Array(Math.floor(MAX_BODY_LENGTH / (to.length + 1)))
					.fill(to)
					.join("\n");
			set([
				{name: "a", body: fan("/b")},
				{name: "b", body: fan("/c")},
				{name: "c", body: fan("/msg x hi")},
			]);

			const result = expandAlias("/a", {});
			expect(result).to.have.length(MAX_LINES);
			expect(result?.every((line) => line === "/msg x hi")).to.equal(true);
		});

		it("stops fan-out that expands to nothing, so no line is ever counted", function () {
			const fan = (to: string) =>
				Array(Math.floor(MAX_BODY_LENGTH / (to.length + 1)))
					.fill(to)
					.join("\n");
			set([
				{name: "a", body: fan("/b")},
				{name: "b", body: fan("/c")},
				{name: "c", body: fan("/d")},
				{name: "d", body: "$1"},
			]);

			const started = Date.now();
			expect(expandAlias("/a", {})).to.deep.equal([]);
			expect(Date.now() - started).to.be.below(1000);
		});

		it("prefers an explicit list over storage (the settings preview)", function () {
			set([{name: "wave", body: "/me waves stored"}]);
			expect(
				expandAlias("/wave", {}, [{name: "wave", body: "/me waves passed"}])
			).to.deep.equal(["/me waves passed"]);
			expect(expandAlias("/wave", {}, [])).to.equal(null);
		});
	});

	describe("storage", function () {
		it("round-trips through saveAliases/loadAliases", function () {
			saveAliases([{name: "wave", body: "/me waves"}]);
			expect(loadAliases()).to.deep.equal([{name: "wave", body: "/me waves"}]);
			expect(aliasNames()).to.deep.equal(["wave"]);
		});

		it("removes the key when saving an empty list", function () {
			saveAliases([{name: "wave", body: "/me waves"}]);
			saveAliases([]);
			expect(store.has(STORAGE_KEY)).to.equal(false);
		});

		it("drops invalid entries and later duplicates on load", function () {
			store.set(
				STORAGE_KEY,
				JSON.stringify([
					{name: "ok", body: "/me fine"},
					{name: "bad name", body: "/me nope"},
					{name: "empty", body: "   "},
					{name: "OK", body: "/me duplicate"},
					{name: 5, body: "/me nope"},
					"junk",
				])
			);
			expect(loadAliases()).to.deep.equal([{name: "ok", body: "/me fine"}]);
		});

		it("treats unreadable storage as empty and clears it", function () {
			store.set(STORAGE_KEY, "{nope");
			expect(loadAliases()).to.deep.equal([]);
			expect(store.has(STORAGE_KEY)).to.equal(false);
		});

		it("caps the list at MAX_ALIASES", function () {
			const list: Alias[] = [];

			for (let i = 0; i < MAX_ALIASES + 5; i++) {
				list.push({name: `a${i}`, body: "/me x"});
			}

			set(list);
			expect(loadAliases()).to.have.length(MAX_ALIASES);
		});
	});

	describe("isValidAliasName", function () {
		it("accepts command-shaped names and rejects the rest", function () {
			expect(isValidAliasName("wave")).to.equal(true);
			expect(isValidAliasName("Wave-2_x")).to.equal(true);
			expect(isValidAliasName("")).to.equal(false);
			expect(isValidAliasName("-wave")).to.equal(false);
			expect(isValidAliasName("wa ve")).to.equal(false);
			expect(isValidAliasName("/wave")).to.equal(false);
			expect(isValidAliasName("a".repeat(33))).to.equal(false);
		});
	});
});
