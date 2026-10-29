// The whole-sentence frames with elements inside them (I18nFrame.vue) in a
// real browser: the Help window's command descriptions and autocompletion
// intro, the formatting shortcuts, and Settings → Aliases' intro, under en,
// de, ja, ar and the qqx pseudo locale (development builds only). Each must
// render as one sentence with its <code>/<kbd> elements inside it and no raw
// {placeholder} left over; under en the text must be upstream's English,
// spaces included. Screenshots of each locale's Help are the visual check.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-frames.mjs
//
// No ircd needed. SEANCE_PORT when 8000 is taken. qqx is skipped (with a
// line saying so) on a production build, which does not ship it.
//
// eslint cannot parse .mjs (pre-existing repo state): this file is prettier-
// formatted by hand and checked only by running it.

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;

export const url = BASE;

/** The Help paragraphs this checks, by the command in the item's subject. */
const ITEMS = {
	connect: "/connect host [port]",
	kickban: "/kickban nick [reason]",
	ctcp: "/ctcp target cmd [args]",
	part: "/part [channel]",
};

const EN = {
	connect:
		"Connect to a new IRC network. If port starts with a + sign, the connection will be made secure using TLS.",
	kickban:
		"Kick and ban (+b) a user from the current channel. Unlike /ban, only nicknames (and not host masks) can be used.",
	ctcp: "Send a CTCP request. Read more about this on the dedicated Wikipedia article.",
	part: "Close the specified channel or private message window, or the current channel if channel is omitted.",
	intro: "To auto-complete nicknames, channels, commands, and emoji, type one of the characters below to open a suggestion list. Use the ↑ and ↓ keys to highlight an item, and insert it by pressing Tab or Enter (or by clicking the desired item).",
	aliases:
		"An alias is a slash command of your own. Typing /wave runs what you define here — one command per line, with the arguments filled in where the body says $1, $2- or $*.",
};

/** What the page shows: each paragraph's text (whitespace collapsed, as a
 * reader sees it) and the elements inside it, in order. */
const READ_HELP = `(() => {
	const norm = (s) => s.replace(/\\s+/g, " ").trim();
	const items = {};
	for (const item of document.querySelectorAll(".help-item")) {
		const subject = norm(item.querySelector(".subject")?.textContent ?? "");
		const p = item.querySelector(".description p");
		if (p) items[subject] = {text: norm(p.textContent), elements: [...p.querySelectorAll("code, kbd, abbr, a")].map((e) => e.tagName.toLowerCase() + ":" + norm(e.textContent))};
	}
	const intro = [...document.querySelectorAll("#help p")].find((p) => p.querySelector("kbd"));
	return {
		items,
		intro: intro ? {text: norm(intro.textContent), kbds: [...intro.querySelectorAll("kbd")].map((k) => k.textContent)} : null,
		raw: (document.querySelector("#help")?.textContent ?? "").match(/\\{[A-Za-z]+\\}/g) ?? [],
		lang: document.documentElement.lang,
		dir: document.documentElement.dir,
	};
})()`;

const READ_ALIASES = `(() => {
	const p = document.querySelector(".alias-intro");
	return p ? {text: p.textContent.replace(/\\s+/g, " ").trim(), codes: [...p.querySelectorAll("code")].map((c) => c.textContent)} : null;
})()`;

async function open(page, locale, hash, selector) {
	await page.evaluate(
		`localStorage.setItem("settings", JSON.stringify({locale: ${JSON.stringify(locale)}}))`
	);
	// Boot lands on the connect form whatever the URL says (no network yet),
	// so the page is reached the way a click would: by its route.
	await page.goto(`${BASE}?_=${locale}`);
	await page.waitFor(
		`document.documentElement.lang === ${JSON.stringify(
			locale
		)} && !!document.querySelector("#connect")`,
		{timeout: 20000, label: `${locale} boot`}
	);
	await page.evaluate(`(() => { location.hash = ${JSON.stringify(hash)}; })()`);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
		timeout: 20000,
		label: `${locale} ${hash}`,
	});
	await page.sleep(400);
}

export default async function run(page) {
	await page.goto(BASE);
	await page.waitFor(`!!document.querySelector("#app")`, {label: "app"});
	const hasQqx = await page.evaluate(
		`fetch("locales/qqx.json").then((r) => r.ok).catch(() => false)`
	);

	for (const locale of ["en", "de", "ja", "ar", "qqx"]) {
		if (locale === "qqx" && !hasQqx) {
			console.log("SKIP qqx: a production build ships no pseudo locale");
			continue;
		}

		await open(page, locale, "#/help", "#help .help-item");
		const seen = await page.evaluate(READ_HELP);
		page.check(
			`${locale}: no raw placeholder in Help (${seen.raw.join(" ")})`,
			seen.raw.length === 0
		);
		page.check(`${locale}: dir ${seen.dir}`, locale !== "ar" || seen.dir === "rtl");

		for (const [key, subject] of Object.entries(ITEMS)) {
			const item = seen.items[subject];
			page.check(`${locale}: Help item ${subject} present`, !!item);

			if (!item) {
				continue;
			}

			console.log(`${locale} ${key}: ${item.text}  [${item.elements.join(", ")}]`);

			if (locale === "en") {
				page.check(
					`en ${key} reads upstream's English: ${item.text}`,
					item.text === EN[key]
				);
			}
		}

		// qqx writes each frame twice over, elements included.
		const twice = (list) => (locale === "qqx" ? [...list, ...list] : list);
		const connect = seen.items[ITEMS.connect];
		page.check(
			`${locale}: connect keeps its two code elements, ${connect?.elements.join(",")}`,
			connect && connect.elements.join(",") === twice(["code:port", "code:+"]).join(",")
		);
		const ctcp = seen.items[ITEMS.ctcp];
		page.check(
			`${locale}: ctcp keeps CTCP and the link inside the sentence`,
			ctcp &&
				ctcp.elements.some((e) => e.startsWith("abbr:CTCP")) &&
				ctcp.elements.some((e) => e.startsWith("a:"))
		);
		console.log(`${locale} intro: ${seen.intro?.text}`);
		page.check(
			`${locale}: the autocompletion intro holds its four keycaps, ${seen.intro?.kbds.join(
				","
			)}`,
			seen.intro && seen.intro.kbds.join(",") === twice(["↑", "↓", "Tab", "Enter"]).join(",")
		);

		if (locale === "en") {
			page.check(
				`en intro reads upstream's English: ${seen.intro?.text}`,
				seen.intro?.text === EN.intro
			);
		}

		await page.screenshot(`help-${locale}`, {selector: "#help .help-item"});
		await page.evaluate(
			`(() => { const items = [...document.querySelectorAll(".help-item")]; const c = items.find((i) => i.textContent.includes("/connect host")); c && c.scrollIntoView(); })()`
		);
		await page.sleep(200);
		await page.screenshot(`help-${locale}-connect`);

		await open(page, locale, "#/settings/aliases", ".alias-intro");
		const aliases = await page.evaluate(READ_ALIASES);
		console.log(`${locale} aliases: ${aliases?.text}`);
		page.check(
			`${locale}: the aliases intro holds its code tokens in place, ${aliases?.codes.join(
				","
			)}`,
			aliases &&
				aliases.codes.join(",") ===
					(locale === "qqx" ? "/wave,$1,$2-,$*,/wave,$1,$2-,$*" : "/wave,$1,$2-,$*")
		);
		page.check(
			`${locale}: no raw placeholder in the aliases intro`,
			!/\{[A-Za-z]+\}/.test(aliases?.text ?? "")
		);

		if (locale === "en") {
			page.check(
				`en aliases intro reads upstream's English: ${aliases?.text}`,
				aliases?.text === EN.aliases
			);
		}
	}
}
