import {expect} from "chai";
import {
	HISTORY_QUEUE_CAP,
	MIN_WORDS,
	ReplayBatches,
	historyQueueOrder,
	isEligible,
	plainTextOf,
	wordCount,
} from "../../client/js/translate/eligibility";

const nicks = ["ada", "jonas", "Storm"];

function msg(overrides: Record<string, unknown> = {}) {
	return {
		type: "message",
		self: false,
		pending: false,
		time: new Date("2026-09-11T12:00:00Z"),
		text: "Ja, gestern, der Batch-Cooldown greift jetzt auch bei leeren Zeilen.",
		...overrides,
	};
}

describe("translate/eligibility", () => {
	// A loaded history page: the newest lines are the ones the reader is
	// looking at, and a long page is cut rather than queued whole.
	it("a loaded history page is taken newest first, up to the cap", () => {
		expect(HISTORY_QUEUE_CAP).to.equal(40);
		expect(historyQueueOrder(["a", "b", "c"])).to.deep.equal(["c", "b", "a"]);
		expect(historyQueueOrder(["a", "b", "c", "d"], 2)).to.deep.equal(["d", "c"]);
		expect(historyQueueOrder([], 2)).to.deep.equal([]);
		expect(historyQueueOrder(["a", "b"], 0)).to.deep.equal([]);

		const page = Array.from({length: HISTORY_QUEUE_CAP + 5}, (_, i) => i);
		const queued = historyQueueOrder(page);

		expect(queued.length).to.equal(HISTORY_QUEUE_CAP);
		expect(queued[0]).to.equal(HISTORY_QUEUE_CAP + 4);
		expect(queued).to.not.include(0);
	});

	// A replay reaches the reader a line at a time, but one batch in one
	// synchronous run: what arrives before the scheduled flush is one load.
	describe("ReplayBatches", () => {
		function batches(cap?: number) {
			const scheduled: (() => void)[] = [];
			const flushed: [number, number[]][] = [];
			const grouper = new ReplayBatches<number>(
				(chanId, lines) => flushed.push([chanId, lines]),
				(fn) => scheduled.push(fn),
				cap
			);
			const runScheduled = () => scheduled.splice(0).forEach((fn) => fn());

			return {grouper, flushed, runScheduled, scheduled};
		}

		it("one run of lines is one batch, per channel, newest first", () => {
			const {grouper, flushed, runScheduled, scheduled} = batches();

			grouper.add(1, 10);
			grouper.add(2, 20);
			grouper.add(1, 11);
			grouper.add(1, 12);

			expect(scheduled.length).to.equal(2);
			expect(flushed).to.deep.equal([]);

			runScheduled();

			expect(flushed).to.deep.equal([
				[1, [12, 11, 10]],
				[2, [20]],
			]);
		});

		it("each batch is capped on its own, with no live line in between", () => {
			const {grouper, flushed, runScheduled} = batches(2);

			[1, 2, 3, 4].forEach((line) => grouper.add(7, line));
			runScheduled();
			[5, 6, 7].forEach((line) => grouper.add(7, line));
			runScheduled();

			expect(flushed).to.deep.equal([
				[7, [4, 3]],
				[7, [7, 6]],
			]);
		});

		it("the default cap is HISTORY_QUEUE_CAP", () => {
			const {grouper, flushed, runScheduled} = batches();

			for (let i = 0; i < HISTORY_QUEUE_CAP + 5; i++) {
				grouper.add(3, i);
			}

			runScheduled();

			expect(flushed[0][1].length).to.equal(HISTORY_QUEUE_CAP);
			expect(flushed[0][1][0]).to.equal(HISTORY_QUEUE_CAP + 4);
		});

		it("a dropped channel flushes nothing, and its next line starts a new batch", () => {
			const {grouper, flushed, runScheduled} = batches();

			grouper.add(4, 1);
			grouper.drop(4);
			grouper.add(4, 2);
			runScheduled();

			expect(flushed).to.deep.equal([[4, [2]]]);
		});

		it("flushes on a microtask by default", async () => {
			const flushed: number[][] = [];
			const grouper = new ReplayBatches<number>((_chanId, lines) => flushed.push(lines));

			grouper.add(1, 1);
			grouper.add(1, 2);
			expect(flushed).to.deep.equal([]);

			await Promise.resolve();

			expect(flushed).to.deep.equal([[2, 1]]);
		});
	});

	it("plainTextOf strips what a detector must not see", () => {
		expect(
			plainTextOf(
				"ada: schau mal https://example.test/a `code hier` :tada: \x02fett\x02 🎉 jonas, danke",
				nicks
			)
		).to.equal("schau mal fett danke");
		expect(plainTextOf("Ich komme um 10:30:45 Uhr :+1:", [])).to.equal(
			"Ich komme um 10:30:45 Uhr"
		);
	});

	it("wordCount counts words, not punctuation", () => {
		expect(wordCount("Ja, gestern.")).to.equal(2);
		expect(wordCount("  ")).to.equal(0);
		expect(MIN_WORDS).to.equal(1);
	});

	it("a message from someone else with three words qualifies, however old", () => {
		expect(isEligible(msg(), {nicks})).to.equal(true);
		expect(isEligible(msg({type: "action"}), {nicks})).to.equal(true);
		expect(isEligible(msg({type: "notice"}), {nicks})).to.equal(true);
		expect(isEligible(msg({time: new Date(0)}), {nicks})).to.equal(true);
	});

	it("the user's own lines qualify like anyone's, however old", () => {
		expect(isEligible(msg({self: true}), {nicks})).to.equal(true);
		expect(isEligible(msg({self: true, type: "action"}), {nicks})).to.equal(true);
		expect(isEligible(msg({self: true, time: new Date(0)}), {nicks})).to.equal(true);
	});

	it("pending copies, own or not, and other-typed messages do not", () => {
		expect(isEligible(msg({pending: true}), {nicks})).to.equal(false);
		expect(isEligible(msg({self: true, pending: true}), {nicks})).to.equal(false);
		expect(isEligible(msg({type: "join"}), {nicks})).to.equal(false);
		expect(isEligible(msg({self: true, type: "join"}), {nicks})).to.equal(false);
	});

	it("a single word is eligible, the user's own included", () => {
		expect(isEligible(msg({text: "Hallo"}), {nicks})).to.equal(true);
		expect(isEligible(msg({self: true, text: "Hallo"}), {nicks})).to.equal(true);
	});

	it("counts the stripped text it is handed, and strips nothing for a line it rules out first", () => {
		let calls = 0;

		const plain = (text: string) => () => {
			calls += 1;
			return text;
		};

		expect(isEligible(msg({text: "Hallo"}), {nicks, plain: plain("")})).to.equal(false);
		expect(isEligible(msg({text: "🎉"}), {nicks, plain: plain("drei Wörter hier")})).to.equal(
			true
		);
		expect(calls).to.equal(2);
		expect(isEligible(msg({type: "join"}), {nicks, plain: plain("x")})).to.equal(false);
		expect(isEligible(msg({pending: true}), {nicks, plain: plain("x")})).to.equal(false);
		expect(calls).to.equal(2);
	});

	it("an own line under MIN_WORDS does not", () => {
		expect(isEligible(msg({self: true, text: "🎉 😂"}), {nicks})).to.equal(false);
	});

	it("too little text does not", () => {
		expect(isEligible(msg({text: "🎉 😂"}), {nicks})).to.equal(false);
		expect(isEligible(msg({text: "https://example.test/a :tada: ada:"}), {nicks})).to.equal(
			false
		);
		expect(isEligible(msg({text: "`nur code hier drin`"}), {nicks})).to.equal(false);
		expect(isEligible(msg({text: undefined}), {nicks})).to.equal(false);
	});

	// Bug B: the detector must see prose. Formatting bytes, Markdown
	// markers, code, URLs, channel names and the channel's own names are
	// syntax, and a classifier shown `*test*` or `#seance` is being asked
	// what language a piece of punctuation is.
	describe("plainTextOf strips everything that is not prose", () => {
		it("takes the Markdown markers off", () => {
			expect(plainTextOf("*test*", [])).to.equal("test");
			expect(plainTextOf("~~weg~~ und _kursiv_", [])).to.equal("weg und kursiv");
		});

		it("a channel name is not a word", () => {
			expect(plainTextOf("**hola** #seance", [])).to.equal("hola");
			expect(plainTextOf("#seance", [])).to.equal("");
			expect(plainTextOf("frag im &local nach", [])).to.equal("frag im nach");
		});

		it("a quote marker is not a word", () => {
			expect(plainTextOf("> quoted line", [])).to.equal("quoted line");
		});

		it("a link keeps its text and loses its target", () => {
			expect(plainTextOf("[see this](https://x.y)", [])).to.equal("see this");
		});

		// CommonMark: `# ` at a line start is a header however the line reads.
		it("a leading hash is a header, not a channel", () => {
			expect(plainTextOf("# not a header?", [])).to.equal("not a header?");
		});

		it("code is gone and the URL beside it with it", () => {
			expect(plainTextOf("`code` *bold* http://x", [])).to.equal("bold");
			expect(plainTextOf("a\n```\ncode\n```\nb", [])).to.equal("a b");
		});

		it("the IRC formatting bytes are gone", () => {
			expect(plainTextOf("\x02fett\x02 \x0304rot\x03", [])).to.equal("fett rot");
		});

		it("the names are still gone, Markdown or not", () => {
			expect(plainTextOf("*ada* fragt jonas", ["ada", "jonas"])).to.equal("fragt");
		});

		it("a line that is nothing but syntax is no line at all", () => {
			expect(plainTextOf("#seance", [])).to.equal("");
			expect(wordCount(plainTextOf("#seance", []))).to.equal(0);
			expect(isEligible(msg({text: "#seance"}), {nicks: []})).to.equal(false);
		});
	});
});
