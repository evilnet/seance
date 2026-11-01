// Generates tools/translate-eval/echo.json: the cases where the current
// prompt hands the line back or leaves parts of it in English, measured on
// the offline runner 2026-09-12 (docs/resources/translation.md § Testing
// prompts offline). A prompt change is measured against this file AND
// prompts.json — the first must improve, the second must not regress.
//
//   node tools/translate-eval/make-echo.mjs > tools/translate-eval/echo.json
//   npx tsx tools/translate-llm.ts --eval tools/translate-eval/echo.json --markers literal

const PARAGRAPH =
	"We moved the deploy to Thursday because the build bot was flaky again. Please keep the timestamps in the log this time. If anyone still sees the login loop, paste the console output in here. Thanks for the patience, it has been a long week.";
const LINES = "the build is green\nI'll merge it after lunch\ncan someone restart the bot?";
const MARKDOWN = "see https://example.org/x?y=1 and run `tail -f irc.log` first, it's *urgent*";

const cases = [
	{
		note: "tr paragraph — echoed whole with the source named (translated with the source left to the model)",
		expect: "four Turkish sentences",
		text: PARAGRAPH,
		from: "en",
		to: "tr",
		purpose: "write",
	},
	{
		note: "ko paragraph — echoed whole with the source named",
		expect: "four Korean sentences",
		text: PARAGRAPH,
		from: "en",
		to: "ko",
		purpose: "write",
	},
	{
		note: "ja paragraph — Thursday, deploy, build bot left in English",
		expect: "four Japanese sentences, 木曜日 for Thursday",
		text: PARAGRAPH,
		from: "en",
		to: "ja",
		purpose: "write",
	},
	{
		note: "es lines — the second line came back in English",
		expect: "three Spanish lines",
		text: LINES,
		from: "en",
		to: "es",
		purpose: "write",
	},
	{
		note: "ru markdown — 'se' and *urgent* left in English",
		expect: "Russian around the URL and the command, *срочно* inside the marks",
		text: MARKDOWN,
		from: "en",
		to: "ru",
		purpose: "write",
	},
	{
		note: "de markdown — *urgent* left in English inside its marks",
		expect: "*dringend* inside the marks",
		text: MARKDOWN,
		from: "en",
		to: "de",
		purpose: "write",
	},
	{
		note: "fr paragraph — 'week', 'paste', 'flake' left in English",
		expect: "four French sentences, semaine for week",
		text: PARAGRAPH,
		from: "en",
		to: "fr",
		purpose: "write",
	},
	{
		note: "reading shape: a Turkish line into English with the source named",
		expect: "one English sentence",
		text: "Dağıtımı perşembeye aldık çünkü build botu yine sorun çıkardı, lütfen bu sefer logdaki zaman damgalarını koruyun.",
		from: "tr",
		to: "en",
		purpose: "read",
	},
	{
		note: "reading shape: a Korean line into English with the source named",
		expect: "one English sentence",
		text: "빌드 봇이 또 불안정해서 배포를 목요일로 옮겼어요. 이번에는 로그의 타임스탬프를 유지해 주세요.",
		from: "ko",
		to: "en",
		purpose: "read",
	},
];

process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
