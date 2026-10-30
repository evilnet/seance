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
 * next `translate` call fail with that code.
 */
export function fakeBridge(status: Record<string, AppleStatus> = {}) {
	const calls: {method: string; options: Record<string, unknown>}[] = [];
	const bridge = {
		status,
		answer: (line: string) => `[${line}]`,
		reject: null as string | null,
		calls,
		deps: {
			invoke<T>(method: string, options: Record<string, unknown>): Promise<T> {
				calls.push({method, options});

				if (method === "availability" || method === "prepare") {
					const key = `${String(options.from)}>${String(options.to)}`;

					return Promise.resolve({status: bridge.status[key] ?? "unsupported"} as T);
				}

				if (bridge.reject) {
					const code = bridge.reject;

					bridge.reject = null;

					return Promise.reject({code, message: `plugin said ${code}`});
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
		const bridge = fakeBridge({"pl>en": "installed"});
		const apple = new AppleTranslator(bridge.deps, {strategy: "high", skip: false});

		expect(await apple.prepare("pl", "en")).to.equal("installed");
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
});
