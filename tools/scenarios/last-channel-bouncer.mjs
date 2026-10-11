// The remembered channel survives a held session's restore
// (draft/persistence): channels the bouncer gives back arrive as `join`
// events, and none of them may move the view away from the one remembered.
//
// Needs an ircd with SASL and persistence — the testnet rig — and an
// account of its own (do not share one with a live session: the bouncer
// attaches to that session, and the clean-up below parts channels):
//
//   corepack yarn build && python3 -m http.server -d public 8001 &
//   SEANCE_SASL_ACCOUNT=… SEANCE_SASL_PASSWORD=… \
//     node tools/browser-drive.mjs tools/scenarios/last-channel-bouncer.mjs
//
// Two channels outside the autojoin list are joined by hand, so the held
// session keeps them and the reload gets them back as restore joins — one
// of them the remembered channel, the other the one that used to steal the
// view. The account's session may hold more channels from earlier runs;
// those are restore joins too, and must not move the view either.

const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PASSWORD = process.env.SEANCE_SASL_PASSWORD;
const RUN = Date.now().toString(36);
const NICK = `slcb${RUN}`;
const A = `#slcb-a-${RUN}`;
const B = `#slcb-b-${RUN}`;
const BASE = "http://localhost:8001/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance&saslAccount=${encodeURIComponent(
	ACCOUNT ?? ""
)}&saslPassword=${encodeURIComponent(PASSWORD ?? "")}`;

const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;
const STORED = `localStorage.getItem("thelounge.state.lastChannel")`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;
const item = (name) => `.channel-list-item[data-name="${name}"]`;

export default async function run(page) {
	if (!ACCOUNT || !PASSWORD) {
		throw new Error(
			"set SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD (a test account of your own)"
		);
	}

	const stored = async () => JSON.parse((await page.evaluate(STORED)) ?? "null");
	const command = async (text) => {
		await page.fill("#input", text);
		await page.click("#submit");
	};
	// The push subscription prompt follows a SASL login — a few seconds after
	// it, once the service worker has reported the subscription state — and
	// its overlay swallows every click while open. Wait for it, then "never",
	// which keeps it away for the rest of this profile's life.
	const dismissPushPrompt = async (waitMs = 8000) => {
		for (let waited = 0; waited <= waitMs; waited += 250) {
			// `data-armed`: a prompt takes no answer in its first moments.
			if ((await page.count("#push-prompt[data-armed]")) > 0) {
				await page.click("#pushPromptNever");
				await page.sleep(300);
				return;
			}

			await page.sleep(250);
		}
	};

	// 1. Connect with SASL, the password remembered so autoconnect can use it.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="rememberPassword"]');
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(joined("#seance"), {timeout: 25000, label: "joined #seance (SASL)"});
	await page.sleep(500);
	await dismissPushPrompt();

	// 2. Two channels the autojoin list does not know: the session holds them.
	await command(`/join ${A}`);
	await page.waitFor(`${ACTIVE} === "${A}"`, {timeout: 10000, label: `opened ${A}`});
	await command(`/join ${B}`);
	await page.waitFor(`${ACTIVE} === "${B}"`, {timeout: 10000, label: `opened ${B}`});
	await page.click(item(A));
	await page.waitFor(`${ACTIVE} === "${A}"`, {label: `back on ${A}`});
	await page.sleep(200);
	page.check(`remembers ${A}`, (await stored())?.target === A);
	await page.screenshot("1-before-reload");

	// 3. Reload: the network autoconnects, the bouncer restores the session.
	//    A is not a placeholder, so the page waits in the lobby, lands on A
	//    when its restore join arrives — and B's restore join (and any other
	//    channel the account holds) leaves the view alone.
	await page.goto(BASE, {waitForSelector: "#chat-container"});
	const whileWaiting = await page.evaluate(ACTIVE);
	await page.waitFor(joined(A), {timeout: 25000, label: `${A} restored`});
	await page.waitFor(joined(B), {timeout: 25000, label: `${B} restored`});
	await page.sleep(1500); // let the rest of the restore burst arrive
	await dismissPushPrompt(0);

	page.check(
		"waited somewhere other than a channel",
		whileWaiting !== B && whileWaiting !== "#seance"
	);
	page.check(`B came back without us asking (a restore join)`, (await page.count(item(B))) === 1);
	page.check(`view is on ${A} after the restore`, (await page.evaluate(ACTIVE)) === A);
	page.check("memory unchanged", (await stored())?.target === A);
	await page.screenshot("2-after-restore");

	// 4. Leave the held session as it was found.
	await command(`/part ${A}`);
	await command(`/part ${B}`);
	await page.waitFor(`document.querySelectorAll('${item(A)}, ${item(B)}').length === 0`, {
		timeout: 10000,
		label: "parted both",
	});

	page.check("no console errors", page.consoleErrors.length === 0);
}
