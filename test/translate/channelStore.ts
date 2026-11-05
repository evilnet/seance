import {expect} from "chai";
import {
	STORAGE_KEY,
	TERM_CAP,
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

	it("an unknown channel is off with the defaults", () => {
		expect(getChannelTranslation("n1", "#seance")).to.deep.equal(defaultChannelTranslation());
		expect(defaultChannelTranslation()).to.deep.equal({
			read: false,
			write: null,
			formality: "auto",
			variant: "",
			languages: [],
			terms: [],
			once: null,
		});
	});

	it("the channel's languages are kept, deduplicated, unknown codes dropped", () => {
		expect(
			setChannelTranslation("n1", "#seance", {languages: ["de", "en", "de", "xx", "nb"]})
				.languages
		).to.deep.equal(["de", "en", "nb"]);
		expect(getChannelTranslation("n1", "#seance").languages).to.deep.equal(["de", "en", "nb"]);

		// A patch that does not mention them leaves them alone.
		expect(setChannelTranslation("n1", "#seance", {read: true}).languages).to.deep.equal([
			"de",
			"en",
			"nb",
		]);
		expect(setChannelTranslation("n1", "#seance", {languages: []}).languages).to.deep.equal([]);
	});

	it("sanitize drops languages this build cannot route", () => {
		backend.set(
			STORAGE_KEY,
			JSON.stringify({
				"n1/#a": {read: "en", languages: ["de", "zz", 7, "de"]},
				"n1/#b": {read: "en", languages: "de"},
			})
		);

		const all = loadAll();

		expect(all["n1/#a"].languages).to.deep.equal(["de"]);
		expect(all["n1/#b"].languages).to.deep.equal([]);
		// A stored read language from the per-channel picker the unified
		// design removed migrates to plain "on".
		expect(all["n1/#a"].read).to.equal(true);
		expect(all["n1/#b"].read).to.equal(true);
	});

	it("switching reading on persists", () => {
		const state = setChannelTranslation("n1", "#Seance", {read: true});

		expect(state.read).to.equal(true);
		expect(JSON.parse(backend.data.get(STORAGE_KEY) as string)["n1/#seance"].read).to.equal(
			true
		);
		expect(getChannelTranslation("n1", "#seance").read).to.equal(true);
	});

	it("switching off keeps the rest of the record", () => {
		setChannelTranslation("n1", "#seance", {read: true, variant: "keep me"});

		expect(setChannelTranslation("n1", "#seance", {read: false})).to.include({
			read: false,
			variant: "keep me",
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
		backend.data.set(STORAGE_KEY, JSON.stringify({"n1/#seance": {read: false, once: "xx"}}));
		expect(getChannelTranslation("n1", "#seance").once).to.equal(null);
	});

	it("a stored read language from the old per-channel picker migrates to on", () => {
		backend.set(STORAGE_KEY, JSON.stringify({"n1/#a": {read: "en", since: 1234}}));

		expect(loadAll()["n1/#a"]).to.deep.equal({...defaultChannelTranslation(), read: true});
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
		setChannelTranslation("n1", "#a", {read: true});
		setChannelTranslation("n1", "#b", {read: true});
		setChannelTranslation("n2", "#a", {read: true});
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
			setChannelTranslation("n1", "alice", {read: true, write: "de"});
			rememberTerm("n1", "alice", term("meet at 5"));
			const kept = forgetTerms("n1", "Alice");
			expect(kept?.terms).to.deep.equal([]);
			expect(kept?.read).to.equal(true);
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
		backend.set(STORAGE_KEY, JSON.stringify({"n1/#a": {read: 7, terms: "x"}, "n1/#b": null}));
		// A truthy read is on, whatever it once held; the junk term list goes.
		expect(loadAll()).to.deep.equal({"n1/#a": {...defaultChannelTranslation(), read: true}});
	});

	it("drops a stored target this build cannot route", () => {
		backend.set(
			STORAGE_KEY,
			JSON.stringify({
				"n1/#a": {read: "xx", write: "zz", variant: "keep me"},
				"n1/#b": {read: "de", write: "en"},
			})
		);

		const all = loadAll();

		// The unroutable write is no target at all; a stored read was a
		// switch, and on is on whatever language it once named.
		expect(all["n1/#a"].read).to.equal(true);
		expect(all["n1/#a"].write).to.equal(null);
		// The rest of the record stays.
		expect(all["n1/#a"].variant).to.equal("keep me");
		expect(all["n1/#b"].read).to.equal(true);
		expect(all["n1/#b"].write).to.equal("en");
	});

	it("a patch cannot overwrite the term memory", () => {
		setChannelTranslation("n1", "#seance", {read: true});
		rememberTerm("n1", "#seance", {source: "rig", target: "Testaufbau", from: "en", to: "de"});
		const before = getChannelTranslation("n1", "#seance");
		const next = setChannelTranslation("n1", "#seance", {
			...before,
			read: false,
			terms: [],
		} as Partial<Omit<ChannelTranslation, "terms">>);

		expect(next.terms).to.deep.equal([
			{source: "rig", target: "Testaufbau", from: "en", to: "de"},
		]);
	});
});
