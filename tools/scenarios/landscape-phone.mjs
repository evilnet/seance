// A phone turned sideways keeps the phone layout: the sidebar is a swipe-in
// overlay, not a side panel (helpers/device.ts PHONE_LAYOUT_QUERY and the
// matching `@media` lists in style.css and Mentions.vue).
//
//   corepack yarn build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/landscape-phone.mjs --mobile
//
// No ircd: the connect form has the sidebar too. `--mobile` gives the page a
// coarse pointer and no hover, which is what tells a phone in landscape
// (926x428, wider than the 768px breakpoint) apart from a short desktop
// window of the same size. The viewport is re-sized from inside so one run
// covers every shape.

const BASE = "http://localhost:8001/";

export const url = BASE;

/** Device shapes, and the layout each one should get. */
const SHAPES = [
	{name: "phone portrait", width: 428, height: 926, mobile: true, phone: true},
	{name: "phone landscape", width: 926, height: 428, mobile: true, phone: true},
	{name: "tablet portrait", width: 744, height: 1133, mobile: true, phone: true},
	{name: "tablet landscape", width: 1133, height: 744, mobile: true, phone: false},
	{name: "desktop, short window", width: 926, height: 428, mobile: false, phone: false},
];

const SIDEBAR_POSITION = `getComputedStyle(document.querySelector("#sidebar")).position`;
const COARSE = `matchMedia("(hover: none) and (pointer: coarse)").matches`;

export default async function run(page) {
	for (const shape of SHAPES) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: shape.width,
			height: shape.height,
			deviceScaleFactor: 1,
			mobile: shape.mobile,
		});
		await page.send("Emulation.setTouchEmulationEnabled", {
			enabled: shape.mobile,
			maxTouchPoints: shape.mobile ? 5 : 1,
		});
		// Boot at that size, as a device does: the sidebar's open state is
		// decided once, on load (App.vue prepareOpenStates).
		await page.goto(url, {waitForSelector: "#connect"});

		const coarse = await page.evaluate(COARSE);
		page.check(
			`${shape.name}: emulation ${shape.mobile ? "is" : "is not"} touch`,
			coarse === shape.mobile
		);

		const position = await page.evaluate(SIDEBAR_POSITION);
		const layout = shape.phone ? "an overlay (absolute)" : "a side panel";
		page.check(
			`${shape.name} (${shape.width}x${shape.height}): sidebar is ${layout}, got ${position}`,
			(position === "absolute") === shape.phone
		);

		const chat = await page.rect("#connect");
		const sidebar = await page.rect("#sidebar");
		const clear = shape.phone
			? sidebar.x + sidebar.width <= 0 || chat.x >= sidebar.x + sidebar.width
			: true;
		page.check(`${shape.name}: the connect form is not under the sidebar`, clear);

		await page.screenshot(`landscape-phone-${shape.name.replace(/[^a-z]+/g, "-")}`);
	}
}
