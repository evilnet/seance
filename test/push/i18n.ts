import {expect} from "chai";
import {applyLocale, type CatalogFetcher} from "../../client/js/push/i18n";
import {t} from "../../client/js/i18n/core";

const APP = "https://app.test/";

/** A fetcher the test answers by hand; `calls` counts the requests. */
function heldFetcher(overlay: Record<string, string>) {
	let answer!: () => void;
	let calls = 0;

	const fetcher: CatalogFetcher = () => {
		calls += 1;

		return new Promise((resolve) => {
			answer = () => resolve({ok: true, json: () => Promise.resolve(overlay)});
		});
	};

	return {
		fetcher,
		answer: () => answer(),
		get calls() {
			return calls;
		},
	};
}

describe("push/i18n applyLocale", () => {
	afterEach(async () => {
		await applyLocale(() => Promise.reject(new Error("unused")), APP, "en");
	});

	it("goes out in English when the overlay is slow, and keeps the late overlay for the next push", async () => {
		const held = heldFetcher({"sw.reply": "Antwort"});

		expect(await applyLocale(held.fetcher, APP, "de", 5)).to.equal("en");
		expect(t("sw.reply")).to.equal("Reply");

		held.answer();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(await applyLocale(held.fetcher, APP, "de", 5)).to.equal("de");
		expect(t("sw.reply")).to.equal("Antwort");
		expect(held.calls).to.equal(1);
	});

	it("a second push while the first one's fetch is still out joins it", async () => {
		const held = heldFetcher({"sw.reply": "Répondre"});

		expect(await applyLocale(held.fetcher, APP, "fr", 5)).to.equal("en");
		const second = applyLocale(held.fetcher, APP, "fr", 1000);

		held.answer();

		expect(await second).to.equal("fr");
		expect(held.calls).to.equal(1);
	});

	it("a failed fetch is not remembered: the next push asks again", async () => {
		let calls = 0;

		const failing: CatalogFetcher = () => {
			calls += 1;
			return Promise.resolve({ok: false, status: 404, json: () => Promise.resolve({})});
		};

		expect(await applyLocale(failing, APP, "nl")).to.equal("en");
		expect(await applyLocale(failing, APP, "nl")).to.equal("en");
		expect(calls).to.equal(2);
	});
});
