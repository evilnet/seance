// The /whois reply as a definition list whose labels sit in the gutter —
// right-aligned against the row separator bar like nicks — with the values
// in the text column (whois.vue, the `.whois` rules in style.css). What
// `pnpm test` cannot see: that the absolutely positioned labels labels sit in the gutter, left of the separator
// bar; values right of it. Needs the dev ircd (ws://127.0.0.1:8067) and the
// build served on :8001:
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/whois-gutter.mjs

const RUN = Date.now().toString(36);
const NICK = `wg${RUN}`;

export const url = `http://localhost:8001/?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2000);

	await page.fill("#input", `/whois ${NICK}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`document.querySelector('#chat .msg[data-type="whois"] dl.whois dt')`, {
		timeout: 15000,
		label: "the whois reply",
	});

	const geo = await page.evaluate(`(() => {
		const msg = document.querySelector('#chat .msg[data-type="whois"]');
		const content = msg.querySelector(".content");
		const bar = content.getBoundingClientRect().left;
		const row = msg.getBoundingClientRect().left;
		const dts = Array.from(msg.querySelectorAll("dl.whois dt")).map((el) => {
			const r = el.getBoundingClientRect();
			return {text: el.textContent, left: r.left, right: r.right};
		});
		const dds = Array.from(msg.querySelectorAll("dl.whois dd")).map((el) => {
			const r = el.getBoundingClientRect();
			return {left: r.left};
		});
		return {bar, row, dts, dds};
	})()`);

	page.check(`whois has label rows (${geo.dts.length})`, geo.dts.length >= 3);
	page.check(
		"every label ends left of the separator bar",
		geo.dts.every((d) => d.right < geo.bar)
	);
	page.check(
		"labels share one right edge (aligned against the bar)",
		geo.dts.every((d) => Math.abs(d.right - geo.dts[0].right) < 1)
	);
	page.check(
		"no label runs off the left edge of the row",
		geo.dts.every((d) => d.left >= geo.row - 1)
	);
	page.check(
		"every value starts right of the bar",
		geo.dds.every((d) => d.left > geo.bar)
	);

	await page.screenshot("whois-gutter", {selector: '#chat .msg[data-type="whois"]'});
	await page.screenshot("whois-chat", {selector: "#chat"});
}
