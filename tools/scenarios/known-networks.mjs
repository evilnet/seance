// The connect form's Network list (client/js/irc/known-networks.ts,
// Windows/Connect.vue): it starts on "Another server", picking a known
// network fills the server fields, and typing another host reads back as
// "Another server" again. Nothing connects: the form alone is checked.
//
//   pnpm build && python3 -m http.server -d public 8031 &
//   node tools/browser-drive.mjs tools/scenarios/known-networks.mjs
//
// `SEANCE_PORT` when 8031 is taken.

const BASE = `http://localhost:${process.env.SEANCE_PORT ?? 8031}/`;

export const url = BASE;

const SELECT = `document.querySelector("#connect select[name=knownNetwork]")`;
const HOST = `document.querySelector("#connect input[name=host]")`;
const PORT = `document.querySelector("#connect input[name=port]")`;
const TLS = `document.querySelector("#connect input[name=tls]")`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check("the list is there", await page.evaluate(`!!${SELECT}`));
	page.check("it starts on Another server", (await page.evaluate(`${SELECT}.value`)) === "");

	const options = await page.evaluate(
		`[...${SELECT}.options].map((o) => o.value + "=" + o.textContent.trim()).join("|")`
	);
	page.check(`AfterNET is offered (${options})`, options.includes("afternet=AfterNET"));
	await page.screenshot("connect-other");

	await page.evaluate(`(() => {
		const el = ${SELECT};
		el.value = "afternet";
		el.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(`${HOST}.value !== ""`, {label: "host filled"});

	const filled = await page.evaluate(
		`${HOST}.value + ":" + ${PORT}.value + ":" + ${TLS}.checked`
	);
	page.check(
		`picking AfterNET fills the server (${filled})`,
		filled === "webirc.afternet.org:9998:true"
	);
	page.check("the list says AfterNET", (await page.evaluate(`${SELECT}.value`)) === "afternet");
	await page.screenshot("connect-afternet");

	await page.evaluate(`(() => {
		const el = ${HOST};
		el.value = "irc.example.org";
		el.dispatchEvent(new Event("input", {bubbles: true}));
	})()`);
	await page.waitFor(`${SELECT}.value === ""`, {label: "back to Another server"});
	page.check("a typed host is Another server", true);
}
