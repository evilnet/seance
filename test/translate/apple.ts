import {expect} from "chai";
import {
	AppleError,
	AppleTranslator,
	type AppleDeps,
	type AppleStatus,
} from "../../client/js/translate/engines/apple";

/**
 * A bridge standing in for the shell's AppleTranslate plugin: `status` per
 * pair, `answer` turns one line into its translation, `reject` makes the
 * next `translate` call fail with that code, and `sheet` is what the
 * download sheet does: install the pack, be declined, or leave it
 * downloading.
 */
export function fakeBridge(status: Record<string, AppleStatus> = {}) {
	const calls: {method: string; options: Record<string, unknown>}[] = [];
	const bridge = {
		status,
		answer: (line: string) => `[${line}]`,
		reject: null as string | null,
		sheet: "install" as "install" | "decline" | "downloading",
		calls,
		deps: {
			invoke<T>(method: string, options: Record<string, unknown>): Promise<T> {
				calls.push({method, options});

				const key = `${String(options.from)}>${String(options.to)}`;

				if (method === "availability") {
					return Promise.resolve({status: bridge.status[key] ?? "unsupported"} as T);
				}

				if (method === "prepare") {
					if (bridge.sheet === "install" && bridge.status[key] === "supported") {
						bridge.status[key] = "installed";
					}

					return Promise.resolve({
						status: bridge.status[key] ?? "unsupported",
						...(bridge.sheet === "decline" ? {error: "cancelled"} : {}),
					} as T);
				}

				if (bridge.reject) {
					const code = bridge.reject;

					bridge.reject = null;

					// As helpers/shell.ts `nativeInvoke` rejects: an Error carrying the plugin's code.
					return Promise.reject(Object.assign(new Error(`plugin said ${code}`), {code}));
				}

				const lines = options.lines as string[];

				return Promise.resolve({lines: lines.map((line) => bridge.answer(line))} as T);
			},
		} as AppleDeps,
	};

	return bridge;
}

describe("translate/engines/apple", () => {
	it("asks a pair's status once and keeps it", async () => {
		const bridge = fakeBridge({"de>en": "installed"});
		const apple = new AppleTranslator(bridge.deps);

		expect(await apple.installed("de", "en")).to.equal(true);
		expect(await apple.installed("de", "en")).to.equal(true);
		expect(await apple.status("ja", "en")).to.equal("unsupported");
		expect(bridge.calls.map((c) => c.method)).to.deep.equal(["availability", "availability"]);
		expect(bridge.calls[0].options).to.deep.equal({from: "de", to: "en", strategy: "low"});
	});

	it("reads a bridge that does not answer as unsupported", async () => {
		const apple = new AppleTranslator({invoke: () => Promise.reject(new Error("no bridge"))});

		expect(await apple.status("de", "en")).to.equal("unsupported");
	});

	it("sends the non-empty lines and puts the answers back in their places", async () => {
		const bridge = fakeBridge({"de>en": "installed"});
		const apple = new AppleTranslator(bridge.deps, {strategy: "low", skip: true});

		expect(await apple.translate("eins\n\n⟦1⟧: zwei", "de", "en")).to.equal(
			"[eins]\n\n[⟦1⟧: zwei]"
		);
		expect(bridge.calls[0].options).to.deep.equal({
			lines: ["eins", "⟦1⟧: zwei"],
			from: "de",
			to: "en",
			strategy: "low",
			skip: true,
		});
	});

	it("sends nothing for a text with no words to translate", async () => {
		const bridge = fakeBridge();
		const apple = new AppleTranslator(bridge.deps);

		expect(await apple.translate("\n  \n", "de", "en")).to.equal("\n  \n");
		expect(bridge.calls).to.deep.equal([]);
	});

	it("refuses an answer with a different number of lines", async () => {
		const apple = new AppleTranslator({
			invoke: <T>() => Promise.resolve({lines: ["one", "two"]} as T),
		});
		const error = await apple.translate("only one", "de", "en").catch((e: unknown) => e);

		expect(error).to.be.instanceOf(AppleError);
		expect((error as AppleError).code).to.equal("failed");
	});

	it("forgets every status when the plugin says a pack is not installed", async () => {
		const bridge = fakeBridge({"de>en": "installed"});
		const apple = new AppleTranslator(bridge.deps);

		await apple.status("de", "en");
		bridge.status["de>en"] = "supported";
		bridge.reject = "notInstalled";

		const error = await apple.translate("hallo", "de", "en").catch((e: unknown) => e);

		expect((error as AppleError).code).to.equal("notInstalled");
		expect(await apple.installed("de", "en")).to.equal(false);
	});

	it("prepare asks for the pack and reports the status after it", async () => {
		const bridge = fakeBridge({"pl>en": "supported"});
		const apple = new AppleTranslator(bridge.deps, {strategy: "high", skip: false});

		expect(await apple.prepare("pl", "en")).to.deep.equal({status: "installed"});
		expect(bridge.calls[0]).to.deep.equal({
			method: "prepare",
			options: {from: "pl", to: "en", strategy: "high"},
		});
	});

	it("a strategy change asks every status again", async () => {
		const bridge = fakeBridge({"de>en": "installed"});
		const apple = new AppleTranslator(bridge.deps);

		await apple.status("de", "en");
		apple.setOptions({strategy: "high", skip: false});
		await apple.status("de", "en");
		apple.setOptions({strategy: "high", skip: true});
		await apple.status("de", "en");

		expect(bridge.calls.map((c) => c.options.strategy)).to.deep.equal(["low", "high"]);
	});

	// The UI's synchronous questions (reader.ts `pairVerdict`): a row asks
	// what is known, `lookup` asks the bridge once, and the answer is heard.
	describe("known statuses", () => {
		it("knows nothing until asked, asks once, and tells its listeners", async () => {
			const bridge = fakeBridge({"es>en": "installed"});
			const apple = new AppleTranslator(bridge.deps);
			let heard = 0;

			apple.onKnown(() => heard++);

			expect(apple.knownStatus("es", "en")).to.equal(undefined);
			apple.lookup("es", "en");
			apple.lookup("es", "en");
			await apple.status("es", "en");
			apple.lookup("es", "en");

			expect(apple.knownStatus("es", "en")).to.equal("installed");
			expect(bridge.calls.map((c) => c.method)).to.deep.equal(["availability"]);
			expect(heard).to.equal(1);
		});

		it("knows a bridge that does not answer as unsupported", async () => {
			const apple = new AppleTranslator({
				invoke: () => Promise.reject(new Error("no bridge")),
			});

			await apple.status("es", "en");

			expect(apple.knownStatus("es", "en")).to.equal("unsupported");
		});

		it("forgets what it knew with the statuses, and tells its listeners", async () => {
			const bridge = fakeBridge({"es>en": "installed"});
			const apple = new AppleTranslator(bridge.deps);
			let heard = 0;

			await apple.status("es", "en");
			apple.onKnown(() => heard++);
			apple.forget();

			expect(apple.knownStatus("es", "en")).to.equal(undefined);
			expect(heard).to.equal(1);
		});

		it("forgets what it knew on a strategy change, not on a skip change", async () => {
			const bridge = fakeBridge({"es>en": "installed"});
			const apple = new AppleTranslator(bridge.deps);

			await apple.status("es", "en");
			apple.setOptions({strategy: "low", skip: true});
			expect(apple.knownStatus("es", "en")).to.equal("installed");
			apple.setOptions({strategy: "high", skip: true});
			expect(apple.knownStatus("es", "en")).to.equal(undefined);
		});

		it("asks again after the sheet what was asked while it was up", async () => {
			const bridge = fakeBridge({"pl>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			// A row asks while the sheet is up, and hears "supported".
			apple.onKnown(() => apple.lookup("pl", "en"));
			expect(await apple.prepare("pl", "en")).to.deep.equal({status: "installed"});
			expect(await apple.installed("pl", "en")).to.equal(true);
		});
	});

	it("lists the system's languages, and none when the bridge does not answer", async () => {
		const answering = new AppleTranslator({
			invoke: <T>() => Promise.resolve({languages: ["de", "en", "ja"]} as T),
		});
		const silent = new AppleTranslator({invoke: () => Promise.reject(new Error("no bridge"))});

		expect(await answering.languages()).to.deep.equal(["de", "en", "ja"]);
		expect(await silent.languages()).to.deep.equal([]);
	});

	describe("offering a pack", () => {
		it("asks once for every request waiting on the pair, and is then installed", async () => {
			const bridge = fakeBridge({"pl>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			const answers = await Promise.all([apple.offer("pl", "en"), apple.offer("pl", "en")]);

			expect(answers).to.deep.equal([true, true]);
			expect(bridge.calls.filter((c) => c.method === "prepare")).to.have.length(1);
			expect(await apple.installed("pl", "en")).to.equal(true);
		});

		it("declined, the pair is not offered again on this page load", async () => {
			const bridge = fakeBridge({"pl>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			bridge.sheet = "decline";
			expect(await apple.offer("pl", "en")).to.equal(false);
			bridge.sheet = "install";
			expect(await apple.offer("pl", "en")).to.equal(false);
			expect(bridge.calls.filter((c) => c.method === "prepare")).to.have.length(1);
		});

		it("shows one sheet at a time, another pair's offer waiting for it to close", async () => {
			const bridge = fakeBridge({"pl>en": "supported", "sv>en": "supported"});
			let open = 0;
			let most = 0;
			const closes: (() => void)[] = [];
			const apple = new AppleTranslator({
				invoke<T>(method: string, options: Record<string, unknown>): Promise<T> {
					if (method !== "prepare") {
						return bridge.deps.invoke<T>(method, options);
					}

					open++;
					most = Math.max(most, open);

					return new Promise<void>((resolve) => closes.push(resolve)).then(() => {
						open--;

						return bridge.deps.invoke<T>(method, options);
					});
				},
			});

			const pl = apple.offer("pl", "en");
			const sv = apple.offer("sv", "en");

			await Promise.resolve();
			await Promise.resolve();
			expect(closes).to.have.length(1);
			closes[0]();
			expect(await pl).to.equal(true);
			await Promise.resolve();
			expect(closes).to.have.length(2);
			closes[1]();
			expect(await sv).to.equal(true);
			expect(most).to.equal(1);
		});

		it("declined, no other pair is offered on this page load", async () => {
			const bridge = fakeBridge({"pl>en": "supported", "sv>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			bridge.sheet = "decline";

			const answers = await Promise.all([apple.offer("pl", "en"), apple.offer("sv", "en")]);

			expect(answers).to.deep.equal([false, false]);
			expect(await apple.offer("sv", "en")).to.equal(false);
			expect(bridge.calls.filter((c) => c.method === "prepare")).to.have.length(1);
		});

		it("not allowed by the time its turn comes, shows nothing and may be offered later", async () => {
			const bridge = fakeBridge({"pl>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			expect(await apple.offer("pl", "en", () => false)).to.equal(false);
			expect(bridge.calls.filter((c) => c.method === "prepare")).to.have.length(0);
			expect(await apple.offer("pl", "en")).to.equal(true);
		});

		it("accepted but still downloading, it asks the status afresh until the pack lands", async () => {
			const bridge = fakeBridge({"pl>en": "supported"});
			const apple = new AppleTranslator(bridge.deps);

			bridge.sheet = "downloading";
			expect(await apple.offer("pl", "en")).to.equal(false);
			expect(await apple.status("pl", "en")).to.equal("supported");
			bridge.status["pl>en"] = "installed";
			expect(await apple.status("pl", "en")).to.equal("installed");
			expect(await apple.offer("pl", "en")).to.equal(false);
			expect(bridge.calls.filter((c) => c.method === "prepare")).to.have.length(1);
		});
	});
});
