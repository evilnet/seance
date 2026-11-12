import {expect} from "chai";
import {
	STORAGE_KEY,
	STORE_VERSION,
	TERM_CAP,
	VERSION_KEY,
	channelKey,
	asFormality,
	defaultChannelTranslation,
	effectiveFormality,
	forgetChannel,
	forgetNetwork,
	forgetPrivateTerms,
	forgetTerms,
	getChannelTranslation,
	isPrivateKey,
	loadAll,
	migrateChannelStore,
	rememberTerm,
	setChannelTranslation,
	splitKey,
	termsFor,
	useStorageBackend,
	withoutPrivateTerms,
	type ChannelTranslation,
	type TermEntry,
} from "../../client/js/translate/channelStore";

function memoryBackend() {
	const data = new Map<string, string>();

	return {
		data,
		get(key: string) {
			return data.get(key) ?? null;
		},
		set(key: string, value: string) {
			data.set(key, value);
		},
		remove(key: string) {
			data.delete(key);
		},
	};
}

describe("translate/channelStore", () => {
	let backend = memoryBackend();

	beforeEach(() => {
		backend = memoryBackend();
		useStorageBackend(backend);
	});

	afterEach(() => useStorageBackend(null));

	it("a channel's register falls back to the global one where it says auto", () => {
		expect(effectiveFormality("formal", "casual")).to.equal("formal");
		expect(effectiveFormality("casual", "formal")).to.equal("casual");
		expect(effectiveFormality("auto", "formal")).to.equal("formal");
		expect(effectiveFormality("auto", "casual")).to.equal("casual");
		expect(effectiveFormality("auto", "auto")).to.equal("auto");
		// The setting is a string in the store; anything unknown is auto.
		expect(effectiveFormality("auto", "polite")).to.equal("auto");
		expect(effectiveFormality("auto", undefined)).to.equal("auto");
		expect(asFormality("formal")).to.equal("formal");
		expect(asFormality(3)).to.equal("auto");
	});

	it("keys are network uuid and lower-cased channel name", () => {
		expect(channelKey("n1", "#Seance")).to.equal("n1/#seance");
		expect(splitKey("n1/#seance")).to.deep.equal({network: "n1", name: "#seance"});
	});

	it("an unknown channel reads (no exclusion) with the defaults", () => {
		expect(getChannelTranslation("n1", "#seance")).to.deep.equal(defaultChannelTranslation());
		expect(defaultChannelTranslation()).to.deep.equal({
			exclude: false,
			write: null,
			writeFrom: null,
			formality: "auto",
			terms: [],
			once: null,
			noSuggest: false,
		});
	});

	it("a declined suggestion is kept as a strict boolean", () => {
		expect(setChannelTranslation("n1", "#seance", {noSuggest: true}).noSuggest).to.equal(true);
		expect(getChannelTranslation("n1", "#seance").noSuggest).to.equal(true);
	});

	it("a retired choice (languages spoken here, variant) is dropped on load", () => {
		backend.set(
			STORAGE_KEY,
			JSON.stringify({
				"n1/#a": {read: "en", languages: ["de", "pt"], variant: "BR", write: "pt"},
			})
		);

		const all = loadAll();

		expect(all["n1/#a"]).to.not.have.property("languages");
		expect(all["n1/#a"]).to.not.have.property("variant");
		expect(all["n1/#a"].write).to.equal("pt");
		// A version-1 record reads, whatever its `read` held.
		expect(all["n1/#a"].exclude).to.equal(false);
	});

	it("forgetChannel takes every choice for one conversation, and only it", () => {
		setChannelTranslation("n1", "#seance", {exclude: true, write: "pt", formality: "formal"});
		setChannelTranslation("n1", "#other", {write: "de"});
		rememberTerm("n1", "#seance", {source: "rig", target: "aparelho", from: "en", to: "pt"});
		forgetChannel("n1", "#Seance");

		expect(getChannelTranslation("n1", "#seance")).to.deep.equal(defaultChannelTranslation());
		expect(getChannelTranslation("n1", "#other").write).to.equal("de");
	});

	it("an exclusion persists, and the blob carries its version", () => {
		const state = setChannelTranslation("n1", "#Seance", {exclude: true});
		const stored = JSON.parse(backend.data.get(STORAGE_KEY) as string);

		expect(state.exclude).to.equal(true);
		expect(stored["n1/#seance"].exclude).to.equal(true);
		expect(stored[VERSION_KEY]).to.equal(STORE_VERSION);
		expect(getChannelTranslation("n1", "#seance").exclude).to.equal(true);
		// The version is not a record.
		expect(Object.keys(loadAll())).to.deep.equal(["n1/#seance"]);
	});

	it("lifting an exclusion keeps the rest of the record", () => {
		setChannelTranslation("n1", "#seance", {exclude: true, write: "pt"});

		expect(setChannelTranslation("n1", "#seance", {exclude: false})).to.include({
			exclude: false,
			write: "pt",
		});
	});

	describe("migrateChannelStore (version 1 to 2)", () => {
		const v1 = {
			"n1/#on": {read: true, write: "es", writeFrom: null, once: "es", formality: "formal"},
			"n1/#off": {read: false, write: "en", writeFrom: "de", noSuggest: true},
			"n1/#polish": {read: true, write: "en", writeFrom: null},
			"n1/#plain": {read: false, write: null, once: "fr", languages: ["pt"], variant: "BR"},
		};

		it("reads every conversation and keeps every writing choice exactly", () => {
			backend.set(STORAGE_KEY, JSON.stringify(v1));
			expect(migrateChannelStore()).to.equal("upgraded");

			const all = loadAll();

			for (const key of Object.keys(v1)) {
				expect(all[key].exclude, key).to.equal(false);
			}

			// A named target and its source, a null source (detect each
			// draft), and the same-language polish target are all kept.
			expect(all["n1/#on"]).to.include({write: "es", writeFrom: null, once: "es"});
			expect(all["n1/#on"].formality).to.equal("formal");
			expect(all["n1/#off"]).to.include({write: "en", writeFrom: "de", noSuggest: true});
			expect(all["n1/#polish"]).to.include({write: "en", writeFrom: null});
			// Writing off stays off; `once` stays a remembered preselection.
			expect(all["n1/#plain"]).to.include({write: null, once: "fr"});

			const stored = JSON.parse(backend.data.get(STORAGE_KEY) as string);

			expect(stored[VERSION_KEY]).to.equal(STORE_VERSION);
			expect(stored["n1/#on"]).to.not.have.property("read");
		});

		it("runs once: an exclusion made after it survives the next boot", () => {
			backend.set(STORAGE_KEY, JSON.stringify(v1));
			migrateChannelStore();
			setChannelTranslation("n1", "#on", {exclude: true});
			expect(migrateChannelStore()).to.equal("current");
			expect(loadAll()["n1/#on"].exclude).to.equal(true);
		});

		it("runs again for an old blob a backup restore puts back", () => {
			backend.set(STORAGE_KEY, JSON.stringify({"n1/#x": {read: true}}));
			migrateChannelStore();
			setChannelTranslation("n1", "#x", {exclude: true});
			// The restore writes the old blob, version and all, over it.
			backend.set(STORAGE_KEY, JSON.stringify({"n1/#x": {read: false, exclude: true}}));
			expect(migrateChannelStore()).to.equal("upgraded");
			// An `exclude` in a version-1 blob is not one: version 1 had none.
			expect(loadAll()["n1/#x"].exclude).to.equal(false);
		});

		it("nothing stored: a current, empty blob, so a later boot does not migrate", () => {
			expect(migrateChannelStore()).to.equal("absent");
			expect(JSON.parse(backend.data.get(STORAGE_KEY) as string)).to.deep.equal({
				[VERSION_KEY]: STORE_VERSION,
			});
			expect(migrateChannelStore()).to.equal("current");
		});

		it("an empty version-1 blob is upgraded too", () => {
			backend.set(STORAGE_KEY, "{}");
			expect(migrateChannelStore()).to.equal("upgraded");
		});

		it("leaves a garbage blob alone", () => {
			backend.set(STORAGE_KEY, "nonsense");
			expect(migrateChannelStore()).to.equal("current");
			expect(backend.data.get(STORAGE_KEY)).to.equal("nonsense");
		});

		it("the version key is never a private conversation's", () => {
			expect(isPrivateKey(VERSION_KEY)).to.equal(false);
			expect(
				withoutPrivateTerms({[VERSION_KEY]: 2} as Record<string, unknown>)
			).to.deep.equal({[VERSION_KEY]: 2});
		});
	});

	it("the translate button's last language is kept with the record", () => {
		expect(getChannelTranslation("n1", "#seance").once).to.equal(null);
		setChannelTranslation("n1", "#seance", {once: "es"});
		expect(getChannelTranslation("n1", "#seance").once).to.equal("es");
		expect(JSON.parse(backend.data.get(STORAGE_KEY) as string)["n1/#seance"].once).to.equal(
			"es"
		);
		// A language this build cannot route loads as none.
		backend.data.set(STORAGE_KEY, JSON.stringify({"n1/#seance": {once: "xx"}}));
		expect(getChannelTranslation("n1", "#seance").once).to.equal(null);
	});

	it("a send target is remembered as the last pick past its Off", () => {
		setChannelTranslation("n1", "#seance", {write: "es", writeFrom: "en"});
		setChannelTranslation("n1", "#seance", {write: null, writeFrom: null});
		expect(getChannelTranslation("n1", "#seance").once).to.equal("es");
	});

	it("a target saved before targets set `once` is kept at its Off", () => {
		backend.data.set(
			STORAGE_KEY,
			JSON.stringify({"n1/#seance": {write: "es", writeFrom: "en", once: null}})
		);
		setChannelTranslation("n1", "#seance", {write: null, writeFrom: null});
		expect(getChannelTranslation("n1", "#seance").once).to.equal("es");
	});

	it("a stored read language from the old per-channel picker loads as reading", () => {
		backend.set(STORAGE_KEY, JSON.stringify({"n1/#a": {read: "en", since: 1234}}));

		expect(loadAll()["n1/#a"]).to.deep.equal(defaultChannelTranslation());
	});

	it("term memory replaces a same-source same-language entry, keeps the newest, and is capped", () => {
		rememberTerm("n1", "#seance", {source: "rig", target: "Testaufbau", from: "en", to: "de"});
		rememberTerm("n1", "#seance", {source: "rig", target: "Prüfstand", from: "en", to: "de"});
		expect(getChannelTranslation("n1", "#seance").terms).to.deep.equal([
			{source: "rig", target: "Prüfstand", from: "en", to: "de"},
		]);

		for (let i = 0; i < TERM_CAP + 5; i++) {
			rememberTerm("n1", "#seance", {source: `t${i}`, target: `x${i}`, from: null, to: "de"});
		}

		const terms = getChannelTranslation("n1", "#seance").terms;

		expect(terms.length).to.equal(TERM_CAP);
		expect(terms[terms.length - 1]).to.deep.equal({
			source: `t${TERM_CAP + 4}`,
			target: `x${TERM_CAP + 4}`,
			from: null,
			to: "de",
		});
		expect(terms.some(({source}) => source === "rig")).to.equal(false);
	});

	it("term memory keeps a French and a German rendering of the same source", () => {
		rememberTerm("n1", "#seance", {source: "thanks", target: "danke", from: "en", to: "de"});
		rememberTerm("n1", "#seance", {source: "thanks", target: "merci", from: "en", to: "fr"});
		expect(getChannelTranslation("n1", "#seance").terms).to.deep.equal([
			{source: "thanks", target: "danke", from: "en", to: "de"},
			{source: "thanks", target: "merci", from: "en", to: "fr"},
		]);
	});

	it("loading drops a legacy pair and a term it cannot place", () => {
		backend.set(
			STORAGE_KEY,
			JSON.stringify({
				"n1/#a": {
					read: "en",
					terms: [
						["thanks", "danke"],
						{source: "rig", target: "Testaufbau", from: "en", to: "zz"},
						{source: "rig", target: "Testaufbau", from: "zz", to: "de"},
						{source: "rig", target: 7, from: "en", to: "de"},
						{source: "log", target: "Protokoll", from: "en", to: "de"},
						{source: "ok", target: "d'accord", from: null, to: "fr", extra: 1},
					],
				},
			})
		);

		expect(loadAll()["n1/#a"].terms).to.deep.equal([
			{source: "log", target: "Protokoll", from: "en", to: "de"},
			{source: "ok", target: "d'accord", from: null, to: "fr"},
		]);
	});

	describe("termsFor", () => {
		const de: TermEntry = {source: "thanks", target: "danke", from: "en", to: "de"};
		const fr: TermEntry = {source: "thanks", target: "merci", from: "en", to: "fr"};
		const unplaced: TermEntry = {source: "log", target: "Protokoll", from: null, to: "de"};

		it("gives a matching entry as [source, target]", () => {
			expect(termsFor([de, fr], "en", "de")).to.deep.equal([["thanks", "danke"]]);
		});

		it("gives an entry written from the target reversed", () => {
			expect(termsFor([de, fr], "de", "en")).to.deep.equal([["danke", "thanks"]]);
		});

		it("leaves out an entry for another language", () => {
			expect(termsFor([fr], "en", "de")).to.deep.equal([]);
			expect(termsFor([de], "fr", "de")).to.deep.equal([]);
			expect(termsFor([de], "fr", "en")).to.deep.equal([]);
		});

		it("an entry with no source matches any source for its target", () => {
			expect(termsFor([unplaced], "en", "de")).to.deep.equal([["log", "Protokoll"]]);
			expect(termsFor([unplaced], "fr", "de")).to.deep.equal([["log", "Protokoll"]]);
			// Its source is unknown, so it cannot be read back.
			expect(termsFor([unplaced], "de", "en")).to.deep.equal([]);
		});

		it("a request with no source matches the entries of its target, in order", () => {
			expect(termsFor([de, fr, unplaced], null, "de")).to.deep.equal([
				["thanks", "danke"],
				["log", "Protokoll"],
			]);
		});
	});

	it("forgetting a channel or a network removes its entries", () => {
		setChannelTranslation("n1", "#a", {exclude: true});
		setChannelTranslation("n1", "#b", {exclude: true});
		setChannelTranslation("n2", "#a", {exclude: true});
		forgetChannel("n1", "#A");
		expect(Object.keys(loadAll())).to.deep.equal(["n1/#b", "n2/#a"]);
		forgetNetwork("n1");
		expect(Object.keys(loadAll())).to.deep.equal(["n2/#a"]);
	});

	describe("private conversations' terms", () => {
		const term = (source: string): TermEntry => ({
			source,
			target: `${source}!`,
			from: "en",
			to: "de",
		});

		it("a query's key is a nick, a channel's starts with its prefix", () => {
			expect(isPrivateKey(channelKey("n1", "alice"))).to.equal(true);
			expect(isPrivateKey(channelKey("n1", "[bot]"))).to.equal(true);

			for (const name of ["#a", "&local", "!safe", "+modeless"]) {
				expect(isPrivateKey(channelKey("n1", name)), name).to.equal(false);
			}
		});

		it("closing a query drops its terms and keeps its switches", () => {
			setChannelTranslation("n1", "alice", {exclude: true, write: "de"});
			rememberTerm("n1", "alice", term("meet at 5"));
			const kept = forgetTerms("n1", "Alice");
			expect(kept?.terms).to.deep.equal([]);
			expect(kept?.exclude).to.equal(true);
			expect(getChannelTranslation("n1", "alice").write).to.equal("de");
			expect(getChannelTranslation("n1", "alice").terms).to.deep.equal([]);
			// Nothing left to drop: nothing written, nothing for the store.
			expect(forgetTerms("n1", "alice")).to.equal(null);
			expect(forgetTerms("n1", "nobody")).to.equal(null);
		});

		it("drops every query's terms on every network, and no channel's", () => {
			rememberTerm("n1", "alice", term("meet at 5"));
			rememberTerm("n2", "bob", term("I'm in hospital"));
			rememberTerm("n1", "#a", term("good morning"));
			expect(forgetPrivateTerms()).to.equal(true);
			expect(getChannelTranslation("n1", "alice").terms).to.deep.equal([]);
			expect(getChannelTranslation("n2", "bob").terms).to.deep.equal([]);
			expect(getChannelTranslation("n1", "#a").terms).to.deep.equal([term("good morning")]);
			expect(forgetPrivateTerms()).to.equal(false);
		});

		it("a copy without them leaves the original and other values alone", () => {
			const all = {
				"n1/alice": {read: true, terms: [term("hi")]},
				"n1/#a": {read: true, terms: [term("yo")]},
				"n1/bob": {read: false},
			};
			expect(withoutPrivateTerms(all)).to.deep.equal({
				"n1/alice": {read: true, terms: []},
				"n1/#a": {read: true, terms: [term("yo")]},
				"n1/bob": {read: false},
			});
			expect(all["n1/alice"].terms).to.have.length(1);
		});
	});

	it("survives unreadable storage", () => {
		backend.set(STORAGE_KEY, "nonsense");
		expect(loadAll()).to.deep.equal({});
		backend.set(
			STORAGE_KEY,
			JSON.stringify({"n1/#a": {exclude: 7, terms: "x"}, "n1/#b": null, [VERSION_KEY]: 2})
		);
		// An exclusion is a strict boolean; the junk term list goes.
		expect(loadAll()).to.deep.equal({"n1/#a": defaultChannelTranslation()});
	});

	it("drops a stored target this build cannot route", () => {
		backend.set(
			STORAGE_KEY,
			JSON.stringify({
				"n1/#a": {read: "xx", write: "zz", once: "de"},
				"n1/#b": {read: "de", write: "en"},
			})
		);

		const all = loadAll();

		// The unroutable write is no target at all.
		expect(all["n1/#a"].write).to.equal(null);
		// The rest of the record stays.
		expect(all["n1/#a"].once).to.equal("de");
		expect(all["n1/#b"].write).to.equal("en");
	});

	it("a patch cannot overwrite the term memory", () => {
		setChannelTranslation("n1", "#seance", {exclude: true});
		rememberTerm("n1", "#seance", {source: "rig", target: "Testaufbau", from: "en", to: "de"});
		const before = getChannelTranslation("n1", "#seance");
		const next = setChannelTranslation("n1", "#seance", {
			...before,
			exclude: false,
			terms: [],
		} as Partial<Omit<ChannelTranslation, "terms">>);

		expect(next.terms).to.deep.equal([
			{source: "rig", target: "Testaufbau", from: "en", to: "de"},
		]);
	});
});
