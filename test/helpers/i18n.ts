import {expect} from "chai";
import {after, afterEach, beforeEach, describe, it} from "mocha";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import sinon from "sinon";
import enCatalog from "../../client/locales/en.json";
import {
	KEEP,
	callSitesReady,
	missingKeys,
	RTL_TAGS,
	bestLocale,
	interpolate,
	isRTL,
	isTraditionalChinese,
	resolvableTags,
	setCatalog,
	setWarnMissing,
	t,
	tCount,
	untranslatedKeys,
	warnFragmentJoin,
	frameSegments,
	framePieces,
} from "../../client/js/i18n/core";
import {activate, useOverlayLoader} from "../../client/js/i18n";
import {formatDayHeading, formatRelativeDay, formatTime} from "../../client/js/i18n/dates";

before(async () => {
	// The dynamic-key/coverage diagnostics are forced on per-test below; a
	// quiet default keeps fixture-key calls in other tests from printing.
	setWarnMissing(false);
	// The static call-site table is loaded only by a build that carries the
	// diagnostics (core.ts); the dynamic-label assertions need it in hand.
	await callSitesReady;
});

describe("i18n core", () => {
	const en = {
		"connect.title": "Connect to IRC",
		"condensed.join": {one: "{count} user has joined", other: "{count} users have joined"},
		greeting: "Hello {nick}",
	};

	it("resolves plain keys and interpolates {vars}", () => {
		setCatalog("en", en, undefined);
		expect(t("connect.title")).to.equal("Connect to IRC");
		expect(t("greeting", {nick: "alice"})).to.equal("Hello alice");
		expect(t("greeting")).to.equal("Hello {nick}"); // unknown var stays visible
	});

	it("overlays the locale over en and falls back per key", () => {
		setCatalog("de", en, {"connect.title": "Verbinde mit IRC"});
		expect(t("connect.title")).to.equal("Verbinde mit IRC");
		expect(t("greeting", {nick: "x"})).to.equal("Hello x"); // missing key → en
	});

	it("selects plural categories with the ACTIVE locale's rules", () => {
		setCatalog("en", en, undefined);
		expect(tCount("condensed.join", 1)).to.equal("1 user has joined");
		expect(tCount("condensed.join", 3)).to.equal("3 users have joined");
		setCatalog("de", en, {
			"condensed.join": {one: "{count} Benutzer", other: "{count} Benutzer"},
		});
		expect(tCount("condensed.join", 3)).to.equal("3 Benutzer");
	});

	it("knows right-to-left tags", () => {
		expect(isRTL("ar")).to.equal(true);
		expect(isRTL("de")).to.equal(false);
		expect(isRTL("qqx")).to.equal(true);
	});

	it("matches navigator.languages best-effort: exact tag, then base", () => {
		expect(bestLocale(["de-AT"], ["en", "de"])).to.equal("de");
		expect(bestLocale(["en-GB"], ["en", "de"])).to.equal("en");
		expect(bestLocale(["fr-CA"], ["en", "de"])).to.equal("en");
		expect(bestLocale(["xx-YY", "de-DE"], ["en", "de"])).to.equal("de"); // a later preference wins when an earlier has no match
	});

	it("never resolves Traditional Chinese to the Simplified catalog", () => {
		const available = ["en", "ja", "pt", "zh"];
		// What Chrome sends from Taiwan: the bare base appended after the
		// regional tag must not reach zh either.
		expect(bestLocale(["zh-TW", "zh", "en-US", "en"], available)).to.equal("en");
		expect(bestLocale(["zh-TW"], available)).to.equal("en");
		expect(bestLocale(["zh-HK", "zh"], available)).to.equal("en");
		expect(bestLocale(["zh-MO"], available)).to.equal("en");
		expect(bestLocale(["zh-Hant"], available)).to.equal("en");
		expect(bestLocale(["zh-Hant-CN"], available), "the script beats the region").to.equal("en");
		expect(bestLocale(["zh_TW"], available)).to.equal("en");
		// A later preference still wins, an explicitly Simplified one included.
		expect(bestLocale(["zh-TW", "zh", "ja"], available)).to.equal("ja");
		expect(bestLocale(["zh-TW", "zh-CN"], available)).to.equal("zh");
		expect(bestLocale(["zh-HK", "zh-Hans"], available)).to.equal("zh");
		// Simplified readers keep zh.
		expect(bestLocale(["zh"], available)).to.equal("zh");
		expect(bestLocale(["zh-CN"], available)).to.equal("zh");
		expect(bestLocale(["zh-SG"], available)).to.equal("zh");
		expect(bestLocale(["zh-Hans-TW"], available), "the script beats the region").to.equal("zh");
		expect(bestLocale(["zh-Hans-HK", "en"], available)).to.equal("zh");
		// A Traditional catalog, were one shipped, would match its own tag.
		expect(bestLocale(["zh-TW", "zh"], [...available, "zh-TW"])).to.equal("zh-TW");
		// European Portuguese keeps the Brazilian catalog.
		expect(bestLocale(["pt-PT"], available)).to.equal("pt");
	});

	it("tells Traditional Chinese tags from Simplified ones", () => {
		for (const tag of ["zh-TW", "zh-hk", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-CN"]) {
			expect(isTraditionalChinese(tag), tag).to.equal(true);
		}

		for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-TW", "ja-TW", "en-HK", ""]) {
			expect(isTraditionalChinese(tag), tag).to.equal(false);
		}
	});

	it("auto-resolution may pick a dev-only locale in development, never in production", () => {
		// available.ts lists every compiled catalog whatever the build mode
		// is (the generated file is tracked), so this filter over
		// (entries, DEV_I18N) is what keeps the rig out of a production
		// build — the selector and activate() both run it.
		const available: ReadonlyArray<{tag: string; devOnly?: boolean}> = [
			{tag: "en"},
			{tag: "qqx", devOnly: true},
		];
		expect(resolvableTags(available, false)).to.deep.equal(["en"]);
		expect(resolvableTags(available, true)).to.deep.equal(["en", "qqx"]);
	});

	it("the pre-paint script and the core agree on RTL tags", () => {
		const source = readFileSync("client/js/prepaint.js", "utf8");
		const inline = /\/\^\(([^)]*)\)\\b\//.exec(source)?.[1] ?? "";
		const fromHtml = new Set(inline.split("|"));
		expect([...fromHtml].sort()).to.deep.equal([...RTL_TAGS].sort());
	});

	/** Execute the pre-paint script as the build would ship it:
	 * client/js/prepaint.js, with `__AVAILABLE_LOCALES__` substituted from
	 * client/locales/tags.json (webpack bakes a comma-joined tag list at the
	 * same spot as it copies the file). The sandbox stubs the three globals
	 * the script touches; lang/dir start empty, so "still empty" means the
	 * script left them untouched. */
	function runPrePaint(stored: object, languages: string[]): {lang: string; dir: string} {
		const source = readFileSync("client/js/prepaint.js", "utf8");
		const tags = JSON.parse(readFileSync("client/locales/tags.json", "utf8")) as string[];
		const root = {lang: "", dir: ""};

		expect(source, "the pre-paint script carries its locale marker").to.contain(
			'"__AVAILABLE_LOCALES__"'
		);
		vm.runInNewContext(
			source.replace('"__AVAILABLE_LOCALES__"', JSON.stringify(tags.join(","))),
			{
				localStorage: {getItem: () => JSON.stringify(stored)},
				navigator: {languages},
				document: {documentElement: root},
			}
		);

		return root;
	}

	it("the pre-paint script applies a stored tag this build ships", () => {
		// tags.json is the real generated list — the same one whatever mode
		// the compile ran in (test/tests/i18n-toolchain.ts pins that; the
		// production build drops the dev-only tags as it bakes the list into
		// index.html): a stored tag in the list activates, with the direction
		// its writing system takes.
		const [tag] = JSON.parse(readFileSync("client/locales/tags.json", "utf8")) as string[];
		expect(runPrePaint({locale: tag}, [])).to.deep.equal({
			lang: tag,
			dir: isRTL(tag) ? "rtl" : "ltr",
		});
	});

	it("the pre-paint script still resolves auto: exact tag, then base", () => {
		const [tag] = JSON.parse(readFileSync("client/locales/tags.json", "utf8")) as string[];
		expect(runPrePaint({}, ["zz-Bork", `${tag}-XP`])).to.deep.equal({
			lang: tag,
			dir: isRTL(tag) ? "rtl" : "ltr",
		});
		expect(runPrePaint({locale: "auto"}, ["en-GB"])).to.deep.equal({lang: "en", dir: "ltr"});
	});

	it("the pre-paint script and bestLocale agree on Traditional Chinese", () => {
		// The pre-paint copy of the rule runs before the bundle: were it to
		// claim zh where boot activates en, <html lang> would pick the wrong
		// CJK fonts until boot. Both resolve the same lists the same way.
		const tags = JSON.parse(readFileSync("client/locales/tags.json", "utf8")) as string[];
		expect(tags, "the baked list ships the Simplified catalog").to.include("zh");

		for (const languages of [
			["zh-TW", "zh", "en-US", "en"],
			["zh-HK", "zh"],
			["zh-Hant-CN"],
			["zh-TW", "zh", "ja"],
			["zh-TW", "zh-CN"],
			["zh-Hans-TW"],
			["zh-SG"],
			["zh"],
			["pt-PT"],
		]) {
			// Nothing matched leaves lang as authored (en), which is
			// bestLocale's own fallback.
			const want = bestLocale(languages, tags);
			expect(runPrePaint({}, languages).lang || "en", languages.join(",")).to.equal(want);
		}

		expect(runPrePaint({}, ["zh-TW", "zh"])).to.deep.equal({lang: "", dir: ""});
		// An explicit pick of zh is the user's: it activates as chosen.
		expect(runPrePaint({locale: "zh"}, ["zh-TW"])).to.deep.equal({lang: "zh", dir: "ltr"});
	});

	it("the pre-paint script leaves lang/dir untouched for an unavailable stored tag", () => {
		// A stale tag (a locale the deploy dropped, a blob restored from a
		// backup) must not pin a direction no catalog backs — and must not
		// fall through to auto-resolution either: boot's activate() lands on
		// en, and the pre-paint claim has to agree. A tag this build's baked
		// list does not carry, whatever flavor it is.
		const tags = new Set(
			JSON.parse(readFileSync("client/locales/tags.json", "utf8")) as string[]
		);
		const stale = ["zz", "de", "qqx"].find((candidate) => !tags.has(candidate));
		expect(stale, "a tag outside the baked list").to.exist;
		expect(runPrePaint({locale: stale!}, [])).to.deep.equal({lang: "", dir: ""});
		expect(runPrePaint({locale: stale!}, [stale!])).to.deep.equal({lang: "", dir: ""});
	});

	it("the slower of two activations never installs its catalog", async function () {
		// Two locale changes in quick succession: the first one's overlay
		// resolves LAST, and must not overwrite the language the user
		// actually asked for.
		const root = {lang: "before", dir: "before"};
		(globalThis as {document?: unknown}).document = {
			documentElement: root,
			getElementById: () => null,
		};

		const pending = new Map<string, (catalog: Record<string, string>) => void>();

		useOverlayLoader(
			(tag) =>
				new Promise((resolve) => {
					pending.set(tag, resolve as (c: Record<string, string>) => void);
				})
		);

		try {
			const first = activate("de");
			const second = activate("fr");

			// The second pick wins although the first answers last.
			pending.get("fr")!({"connect.title": "Connexion"});
			await second;
			expect(t("connect.title")).to.equal("Connexion");
			expect(root).to.deep.equal({lang: "fr", dir: "ltr"});

			pending.get("de")!({"connect.title": "Mit IRC verbinden"});
			await first;
			expect(t("connect.title")).to.equal("Connexion");
			expect(root).to.deep.equal({lang: "fr", dir: "ltr"});
		} finally {
			useOverlayLoader(null);
			delete (globalThis as {document?: unknown}).document;
			setCatalog("en", enCatalog, undefined);
		}
	});

	it("activate() falls back to en for a tag with no catalog, never rejecting", async function () {
		// mocha has no DOM: the stub documentElement is everything activate()
		// writes to (settingsBackup can restore an arbitrary stored locale,
		// and boot calls activate() with `void` — a rejection would cascade).
		const root = {lang: "before", dir: "before"};
		(globalThis as {document?: unknown}).document = {
			documentElement: root,
			getElementById: () => null,
		};

		try {
			await activate("nonexistent"); // must not reject
			expect(t("connect.title")).to.equal("Connect to IRC"); // the catalog is en again
			expect(root).to.deep.equal({lang: "en", dir: "ltr"}); // best-effort html update still ran
		} finally {
			delete (globalThis as {document?: unknown}).document;
			setCatalog("en", enCatalog, undefined);
		}
	});
});

describe("i18n date formatters", () => {
	after(() => {
		// The catalog is module state: hand the real English copy back, so the
		// suites loaded after this file resolve the live keys again.
		setCatalog("en", enCatalog, undefined);
	});

	it("writes the day heading in the active language", () => {
		// 4 February 2026 at local midnight: the heading is built from the
		// wall-clock date, so the assertion holds in every timezone.
		setCatalog("de", enCatalog, undefined);
		expect(formatDayHeading(new Date(2026, 1, 4).getTime())).to.contain("Februar");
	});

	it("resolves Today through the t() the caller passes", () => {
		setCatalog("en", enCatalog, undefined);
		const stubT = (key: string) => (key === "dates.today" ? "Today" : key);
		expect(formatRelativeDay(Date.now(), stubT)).to.equal("Today");
	});

	it("writes a timestamp on the 24-hour clock when hour12: false", () => {
		// 22 May 2014, 15:04 local: hour12: false must win over en's own
		// 12-hour preference (Task 8 Step 1 pins "15:04").
		setCatalog("en", enCatalog, undefined);
		expect(formatTime(new Date(2014, 4, 22, 15, 4).getTime(), false, false)).to.equal("15:04");
	});
});

describe("i18n number interpolation", () => {
	const en = {"port.msg": "Port {port}", "new.msg": "{count} new"};

	after(() => {
		// The catalog is module state: hand the real English copy back.
		setCatalog("en", enCatalog, undefined);
	});

	it("writes number vars with the active locale's digits and decimal separator", () => {
		setCatalog("en", en, undefined);
		expect(t("port.msg", {port: 6667})).to.equal("Port 6667");
		setCatalog("de", en, undefined);
		expect(t("port.msg", {port: 1.5})).to.equal("Port 1,5"); // de decimal comma
		setCatalog("ar-EG", en, undefined);
		expect(t("port.msg", {port: 6667})).to.equal("Port ٦٦٦٧"); // Arabic-Indic digits
	});

	it("interpolates {vars} without grouping — a port is 6667 everywhere", () => {
		// en's own grouping writes 1,500; the frames say {port}/{count}, and
		// neither reads well grouped. Grouping lives in numbers.ts's
		// formatNumber() for call sites that render a standalone number.
		setCatalog("en", en, undefined);
		expect(t("new.msg", {count: 1500})).to.equal("1500 new");
		setCatalog("de", en, undefined);
		expect(t("new.msg", {count: 1500})).to.equal("1500 new");
	});

	it("localizes {count}/{n} through the plural path too", () => {
		setCatalog("de", enCatalog, undefined);
		expect(tCount("condensed.join", 1500)).to.equal("1500 users have joined"); // en plural, de digits
	});
});

describe("i18n dev warnings for dynamic strings", () => {
	let warns: sinon.SinonStub;

	beforeEach(() => {
		warns = sinon.stub(console, "warn");
		setWarnMissing(true); // mocha runs under NODE_ENV=test; force the dev stance
	});

	afterEach(() => {
		warns.restore();
		setWarnMissing(false);
	});

	after(() => {
		setCatalog("en", enCatalog, undefined);
	});

	it("warns once per missing key — the dynamically composed case", () => {
		setCatalog("en", {known: "Port {port}"}, undefined);
		expect(t(`dyn.${"x"}`)).to.equal("dyn.x"); // renders the key, as ever
		expect(t("dyn.x")).to.equal("dyn.x"); // ...but warns only once per kind
		const missing = warns
			.getCalls()
			.filter((call) => String(call.args[0]).includes("missing key"));
		expect(missing.length).to.equal(1);
		// An assembled key ALSO warns for being assembled — even before the
		// lookup fails.
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("assembled at runtime"))
				.length
		).to.be.greaterThan(0);
	});

	it("the KEEP sentinel leaves a placeholder intact, without warning", () => {
		// Frame-splitting call sites pass KEEP for each placeholder they
		// split on themselves: no substitution, no unknown-var warning.
		setCatalog("en", {frame: "{nick} sets mode {modes}"}, undefined);
		expect(interpolate("x {nick} y", {nick: KEEP})).to.equal("x {nick} y");
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("unknown var")).length
		).to.equal(0);
		expect(
			frameSegments(t("frame", {nick: KEEP, modes: KEEP}), ["nick", "modes"])
		).to.deep.equal(["", " sets mode ", ""]);
	});

	it("framePieces follows the translation's order of the placeholders", () => {
		// A translator may put {target} before {nick}; frameSegments returns
		// the segments in the CALLER's order, so a component with fixed
		// element positions rendered a raw "{target}" there. framePieces is
		// what I18nFrame.vue renders, slot by slot, in the frame's order.
		expect(framePieces("{nick} has kicked {target}", ["nick", "target"])).to.deep.equal([
			{name: "nick"},
			" has kicked ",
			{name: "target"},
		]);
		expect(
			framePieces("{target} は {nick} にキックされました", ["nick", "target"])
		).to.deep.equal([{name: "target"}, " は ", {name: "nick"}, " にキックされました"]);
		// A placeholder the caller has no element for stays text.
		expect(framePieces("on {time} by {nick}", ["nick"])).to.deep.equal([
			"on {time} by ",
			{name: "nick"},
		]);
	});

	it("the class-3 audit: a {var} frame warns once, naming its values", () => {
		setCatalog("en", enCatalog, undefined);
		t("connect.connectingTo", {host: "h", port: 1}); // "{host}:{port}…" frame
		const frames = warns
			.getCalls()
			.filter((call) => String(call.args[0]).includes("dynamic label ({var} frame)"));
		expect(frames.length).to.equal(1);
		expect(String(frames[0].args[0])).to.contain('"connect.connectingTo"');
		expect(String(frames[0].args[0])).to.contain("(host, port)");
		// ...once per key+locale
		t("connect.connectingTo", {host: "h", port: 1});
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("({var} frame)")).length
		).to.equal(1);
		// A key without placeholders is not a frame.
		t("connect.submit");
		expect(
			warns
				.getCalls()
				.filter(
					(call) =>
						String(call.args[0]).includes("({var} frame)") &&
						String(call.args[0]).includes("connect.submit")
				).length
		).to.equal(0);
	});

	it("the class-2 audit: fragment joins warn through warnFragmentJoin", () => {
		warnFragmentJoin(3);
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("fragment combination"))
				.length
		).to.equal(1);
	});

	it("warns on an unknown {var} left visible", () => {
		setCatalog("en", {known: "Port {port}"}, undefined);
		expect(t("known", {})).to.equal("Port {port}"); // placeholder stays visible
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("unknown var")).length
		).to.equal(1);
	});

	it("tCount warns on a missing key, accepts a flat string entry", () => {
		setCatalog("en", {flat: "{count} things"}, undefined);
		expect(tCount("flat", 3)).to.equal("3 things"); // no plural entry, no warn
		tCount("dyn.count", 3);
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("missing key")).length
		).to.equal(1);
	});

	it("a locale change re-arms the dedupe", () => {
		setCatalog("en", {known: "x"}, undefined);
		t("dyn.armed");
		setCatalog("de", {known: "x"}, undefined);
		t("dyn.armed");
		expect(
			warns.getCalls().filter((call) => String(call.args[0]).includes("missing key")).length
		).to.equal(2);
	});

	it("warns for an assembled key THAT RESOLVES — the pure dynamic-label case", () => {
		// The exact pattern the warnings exist for: a key composed at
		// runtime that happens to hit a real catalog entry. The lookup
		// succeeds; the warning fires anyway, because a composed key cannot
		// be trusted to the translation dataset.
		// A key only the runtime knows: in the catalog, no static call site
		// anywhere resolves it.
		setCatalog("en", {["assembled." + "key"]: "Resolved copy"}, undefined);
		expect(t("assembled.key")).to.equal("Resolved copy"); // resolves fine
		const dynsite = warns
			.getCalls()
			.filter((call) => String(call.args[0]).includes("dynamic label"));
		expect(dynsite.length).to.equal(1);
		expect(String(dynsite[0].args[0])).to.contain('"assembled.key"');
		// And a plain static key never warns this way.
		t("connect.submit");
		expect(
			warns
				.getCalls()
				.filter(
					(call) =>
						String(call.args[0]).includes("dynamic label") &&
						String(call.args[0]).includes("connect.submit")
				).length
		).to.equal(0);
	});

	it("setWarnMissing(false) silences them — production's compiled-out stance", () => {
		setCatalog("en", {known: "x"}, undefined);
		setWarnMissing(false);
		t("dyn.silenced");
		expect(warns.callCount).to.equal(0);
		expect(missingKeys().length).to.equal(0);
	});
});

describe("i18n translation-coverage warnings", () => {
	let warns: sinon.SinonStub;

	beforeEach(() => {
		warns = sinon.stub(console, "warn");
		setWarnMissing(true);
	});

	afterEach(() => {
		warns.restore();
		setWarnMissing(false);
	});

	after(() => {
		// The catalog is module state: hand the real English copy back.
		setCatalog("en", enCatalog, undefined);
	});

	it("the en base catalog has no untranslated keys", () => {
		setCatalog("en", enCatalog, undefined);
		expect(untranslatedKeys()).to.deep.equal([]);
	});

	it("a partial overlay warns per rendered label — the English copy shows", () => {
		// The de.po seed shape: a handful of keys translated, the rest
		// falling through to en.
		setCatalog("de", enCatalog, {"connect.submit": "Verbinden"});
		expect(untranslatedKeys()).to.contain("sidebar.settings");
		expect(untranslatedKeys()).to.not.contain("connect.submit");

		t("sidebar.settings"); // untranslated → warns
		t("sidebar.settings"); // ...once
		t("connect.submit"); // translated → no coverage warn
		const coverage = warns
			.getCalls()
			.filter((call) => String(call.args[0]).includes('untranslated in "de"'));
		expect(coverage.length).to.equal(1);
		expect(String(coverage[0].args[0])).to.contain('"sidebar.settings"');

		// The rendered value is still the English copy.
		expect(t("sidebar.settings")).to.equal("Settings");
	});

	it("intentionally-empty en copy is not 'untranslated'", () => {
		setCatalog("de", {"a.key": "text", "empty.key": ""}, {"a.key": "Text"});
		expect(untranslatedKeys()).to.deep.equal([]);
	});

	it("tCount warns for untranslated plural entries too", () => {
		setCatalog("de", enCatalog, undefined); // nothing translated
		tCount("condensed.join", 3);
		const coverage = warns
			.getCalls()
			.filter((call) => String(call.args[0]).includes('untranslated in "de"'));
		expect(coverage.length).to.equal(1);
		// And the en plural still serves.
		expect(tCount("condensed.join", 3)).to.equal("3 users have joined");
	});

	it("a locale change re-derives the untranslated set", () => {
		setCatalog("de", enCatalog, {"connect.submit": "Verbinden"});
		expect(untranslatedKeys().length).to.be.greaterThan(0);
		setCatalog("en", enCatalog, undefined);
		expect(untranslatedKeys()).to.deep.equal([]);
	});
});
