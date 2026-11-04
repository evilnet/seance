// File upload: the preview/confirm dialog, the progress strip, and the
// animated-WebP exemption from the metadata re-encode, in a real browser.
//
// Needs the app served with an `uploads.endpoint` that points at a CORS-
// enabled uploader you control, and an ircd to connect to:
//
//   pnpm build
//   # public/config.json → {"appName":"Seance","uploads":{"endpoint":"https://127.0.0.1:8099/upload"}}
//   python3 -m http.server -d public 8001 &
//   node <fake uploader on 8099: multipart POST /upload → {"url": …}; GET /__stats → {uploads:[{name,size,sha256,hasExif}], aborted}>
//   node tools/browser-drive.mjs tools/scenarios/upload-preview.mjs --chrome=…
//
//   SEANCE_UPLOADER=https://127.0.0.1:8099 overrides where /__stats is read.
//
// What `pnpm test` cannot see and this does: that a paste or a drop opens
// the dialog instead of uploading, that the dialog decodes and shows the
// images (an animated WebP included), that removing and cancelling work,
// that confirming shows the strip above the input with the file's name,
// position and percentage, that the URLs land in the input, that the
// animated WebP reached the uploader byte for byte (no canvas flattening)
// while the JPEG lost its Exif segment, that the sent message embeds the
// uploaded image, and that cancelling mid-flight is silent.
//
// The fixtures are built inside the page: Chrome encodes still WebP from a
// canvas, and two such frames wrapped in ANIM/ANMF chunks make a genuinely
// animated WebP; a JPEG from a canvas gets an Exif APP1 segment spliced in.

import https from "node:https";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev certificate

const UPLOADER = process.env.SEANCE_UPLOADER ?? "https://127.0.0.1:8099";
const RUN = Date.now().toString(36);

export const url = `http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=upl${RUN.slice(
	-5
)}&join=%23seance&autoconnect=1`;

function stats() {
	return new Promise((resolve, reject) => {
		https
			.get(`${UPLOADER}/__stats`, {rejectUnauthorized: false}, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(JSON.parse(body)));
			})
			.on("error", reject);
	});
}

function reset() {
	return new Promise((resolve, reject) => {
		const req = https.request(
			`${UPLOADER}/__reset`,
			{method: "POST", rejectUnauthorized: false},
			(res) => {
				res.resume();
				res.on("end", resolve);
			}
		);
		req.on("error", reject);
		req.end();
	});
}

/** Builds window.__fixtures = {anim, still, photo, big}; returns their sizes and hashes. */
export const MAKE_FILES = `(async () => {
	const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
	const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
	const le32 = (n) => [...le24(n), (n >>> 24) & 255];
	const chunk = (fourcc, payload) => {
		const body = Array.from(payload);
		if (body.length % 2) body.push(0);
		return [...ascii(fourcc), ...le32(payload.length), ...body];
	};
	const blobBytes = (canvas, type, quality) =>
		new Promise((resolve) => canvas.toBlob((b) => b.arrayBuffer().then((a) => resolve(new Uint8Array(a))), type, quality));
	const sha256 = async (bytes) =>
		Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

	const canvas = document.createElement("canvas");
	canvas.width = 16; canvas.height = 16;
	const ctx = canvas.getContext("2d");

	// A still WebP frame of one colour: the chunks after the RIFF header,
	// minus any VP8X (the animation gets its own).
	const frame = async (color) => {
		ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 16);
		const bytes = await blobBytes(canvas, "image/webp", 0.9);
		if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") throw new Error("canvas did not produce WebP");
		const out = [];
		let at = 12;
		while (at + 8 <= bytes.length) {
			const fourcc = String.fromCharCode(...bytes.subarray(at, at + 4));
			const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
			const padded = size + (size % 2);
			// Only the bitstream (and alpha) may sit inside a frame: the canvas encoder also emits an ICCP chunk.
			if (fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "ALPH") out.push(...bytes.subarray(at, at + 8 + padded));
			at += 8 + padded;
		}
		return {bytes, chunks: out};
	};

	const red = await frame("#e33");
	const blue = await frame("#36f");
	const anmf = (frameChunks) => chunk("ANMF", [...le24(0), ...le24(0), ...le24(15), ...le24(15), ...le24(400), 0, ...frameChunks]);
	const body = [
		...ascii("WEBP"),
		...chunk("VP8X", [0x02, 0, 0, 0, ...le24(15), ...le24(15)]),
		...chunk("ANIM", [0, 0, 0, 0, 0, 0]),
		...anmf(red.chunks),
		...anmf(blue.chunks),
	];
	const anim = new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);

	// A JPEG with an Exif APP1 segment (minimal TIFF header, no entries).
	const jpegCanvas = document.createElement("canvas");
	jpegCanvas.width = 96; jpegCanvas.height = 64;
	const jctx = jpegCanvas.getContext("2d");
	const grad = jctx.createLinearGradient(0, 0, 96, 64);
	grad.addColorStop(0, "#f80"); grad.addColorStop(1, "#08f");
	jctx.fillStyle = grad; jctx.fillRect(0, 0, 96, 64);
	const jpeg = await blobBytes(jpegCanvas, "image/jpeg", 0.9);
	const exif = [0xff, 0xe1, 0x00, 0x16, ...ascii("Exif\\0\\0"), 0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
	const photo = new Uint8Array(jpeg.length + exif.length);
	photo.set(jpeg.subarray(0, 2), 0);
	photo.set(exif, 2);
	photo.set(jpeg.subarray(2), 2 + exif.length);

	window.__fixtures = {
		anim: new File([anim], "anim.webp", {type: "image/webp"}),
		still: new File([red.bytes], "still.webp", {type: "image/webp"}),
		photo: new File([photo], "photo.jpg", {type: "image/jpeg"}),
		big: new File([new Uint8Array(8 * 1024 * 1024)], "big.bin", {type: "application/octet-stream"}),
	};

	return {
		anim: {size: anim.length, sha256: await sha256(anim)},
		still: {size: red.bytes.length},
		photo: {size: photo.length, hasExif: String.fromCharCode(...photo.subarray(0, 40)).includes("Exif")},
		big: {size: window.__fixtures.big.size},
	};
})()`;

const transfer = (names) =>
	`const dt = new DataTransfer(); for (const n of ${JSON.stringify(
		names
	)}) dt.items.add(window.__fixtures[n]);`;

/** Paste the named fixtures into the page, as a clipboard would. */
const PASTE = (names) =>
	`(() => { ${transfer(
		names
	)} document.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true})); return dt.items.length; })()`;

/** Drop the named fixtures on the page, as a drag from the desktop would. */
const DROP = (names) =>
	`(() => { ${transfer(
		names
	)} document.dispatchEvent(new DragEvent("drop", {dataTransfer: dt, bubbles: true, cancelable: true})); return dt.items.length; })()`;

/**
 * Open AND clickable: the shared overlay CSS transitions `visibility` too, so
 * for the first frame the dialog is on screen but hit-testing and focus still
 * go to the chat behind it (a real click cannot be that fast; this tool can).
 */
const DIALOG_OPEN = `(() => {
	const overlay = document.querySelector("#upload-preview-overlay.opened");
	return !!(overlay && overlay.querySelector("#upload-preview") && getComputedStyle(overlay).opacity === "1");
})()`;
/**
 * Closed AND out of the way: the overlay fades for 0.2 s after closing and
 * still catches clicks until then. Two tiny files upload faster than that,
 * so a click on the send button right after must wait for it.
 */
const DIALOG_CLOSED = `(() => {
	const overlay = document.querySelector("#upload-preview-overlay");
	return !!overlay && !overlay.classList.contains("opened") && getComputedStyle(overlay).visibility === "hidden";
})()`;
const ITEMS = `Array.from(document.querySelectorAll("#upload-preview .upload-preview-item")).map((li) => ({
	name: li.querySelector(".upload-preview-name").textContent.trim(),
	details: li.querySelector(".upload-preview-details").textContent.trim(),
	note: li.querySelector(".upload-preview-note")?.textContent.trim() ?? "",
	badge: li.querySelector(".upload-preview-badge")?.textContent.trim() ?? "",
	decoded: (() => { const img = li.querySelector("img"); return img ? img.complete && img.naturalWidth > 0 : null; })(),
}))`;
const STRIP = `document.querySelector("#form .upload-bar")`;
const STRIP_TEXT = `(document.querySelector("#form .upload-bar-label")?.textContent.trim() ?? "") + " | " + (document.querySelector("#form .upload-bar-percent")?.textContent.trim() ?? "")`;
/** Records every distinct strip text as it changes (polling misses small files). */
const WATCH_STRIP = `(() => {
	window.__strip = [];
	const record = () => {
		const text = ${STRIP_TEXT};
		if (window.__strip[window.__strip.length - 1] !== text) window.__strip.push(text);
	};
	new MutationObserver(record).observe(document.querySelector("#form"), {subtree: true, childList: true, characterData: true, attributes: true});
	record();
	return true;
})()`;
const ERROR_TEXT = `document.querySelector("#user-visible-error")?.textContent.trim() ?? ""`;
/** The textarea's value next to the store draft the submit handler actually sends. */
const PENDING = `(() => {
	const root = document.querySelector("[data-v-app]");
	const store = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$store;
	const chan = store && store.state.activeChannel && store.state.activeChannel.channel;
	return {
		domValue: document.querySelector("#input").value,
		pendingMessage: chan ? chan.pendingMessage : "(no store)",
		active: document.activeElement ? document.activeElement.tagName + "#" + document.activeElement.id : null,
	};
})()`;

export default async function run(page) {
	await reset();
	await page.goto(page.url, {waitForSelector: "#chat"});
	await page.waitFor(
		`document.querySelector("#form #upload") && !document.querySelector("#form #upload").disabled`,
		{timeout: 30000, label: "connected: the paperclip is enabled"}
	);

	const fixtures = await page.evaluate(MAKE_FILES);
	page.check("fixtures built in the page", fixtures.anim.size > 60 && fixtures.photo.hasExif);
	console.log("fixtures", JSON.stringify(fixtures));

	// 1. A paste opens the dialog instead of uploading.
	await page.evaluate(PASTE(["anim", "photo", "still"]));
	await page.waitFor(DIALOG_OPEN, {label: "the preview dialog opens on paste"});
	await page.waitFor(`(${ITEMS}).length === 3 && (${ITEMS}).every((i) => i.decoded === true)`, {
		label: "all three images decoded in the dialog",
	});
	await page.waitFor(`(${ITEMS}).every((i) => i.note !== "")`, {label: "metadata notes shown"});

	const items = await page.evaluate(ITEMS);
	console.log("dialog items", JSON.stringify(items, null, 1));
	const byName = Object.fromEntries(items.map((i) => [i.name, i]));
	page.check(
		"animated WebP is labelled as kept whole",
		/^Animated/.test(byName["anim.webp"]?.note)
	);
	page.check("JPEG is labelled as metadata-stripped", /removed/.test(byName["photo.jpg"]?.note));
	page.check(
		"still WebP is labelled as metadata-stripped",
		/removed/.test(byName["still.webp"]?.note)
	);
	page.check("dimensions are shown", /16×16/.test(byName["anim.webp"]?.details));
	page.check(
		"title and button count the files",
		(await page.evaluate(
			`document.querySelector("#upload-preview-title").textContent.trim() + " / " + document.querySelector("#upload-preview-confirm").textContent.trim()`
		)) === "Upload these files? / Upload 3 files"
	);
	page.check(
		"the Upload button has focus",
		(await page.evaluate(`document.activeElement?.id`)) === "upload-preview-confirm"
	);
	await page.screenshot("upload-dialog", {selector: "#upload-preview"});

	// 2. Removing one file keeps the rest.
	await page.click("#upload-preview .upload-preview-remove", 2);
	await page.waitFor(`(${ITEMS}).length === 2`, {label: "a removed file leaves the list"});
	page.check(
		"button recounts after a removal",
		(await page.evaluate(
			`document.querySelector("#upload-preview-confirm").textContent.trim()`
		)) === "Upload 2 files"
	);

	// 3. Cancel sends nothing.
	await page.click("#upload-preview .btn-cancel");
	await page.waitFor(DIALOG_CLOSED, {label: "Cancel closes the dialog"});
	await page.sleep(300);
	page.check("nothing was uploaded after Cancel", (await stats()).uploads.length === 0);
	page.check("no upload strip after Cancel", !(await page.evaluate(`!!(${STRIP})`)));

	// 4. A drop opens it too; confirming uploads with progress and inserts the URLs.
	await page.evaluate(DROP(["anim", "photo"]));
	await page.waitFor(DIALOG_OPEN, {label: "the preview dialog opens on drop"});
	await page.waitFor(`(${ITEMS}).length === 2`, {label: "two items after drop"});
	await page.evaluate(WATCH_STRIP);
	await page.click("#upload-preview-confirm");
	await page.waitFor(DIALOG_CLOSED, {label: "Upload closes the dialog"});
	await page.waitFor(`window.__strip.some((t) => /Uploading/.test(t))`, {
		label: "the progress strip appears above the input",
	});
	if (await page.evaluate(`!!(${STRIP})`)) {
		await page.screenshot("upload-strip", {selector: "#form", pad: 12});
	}

	await page.waitFor(`!(${STRIP}) && document.querySelector("#input").value.includes("/f/")`, {
		timeout: 60000,
		label: "uploads finish and the URLs land in the input",
	});
	await page.waitFor(DIALOG_CLOSED, {label: "the overlay has faded out"});
	const stripTexts = await page.evaluate(`window.__strip`);
	console.log("strip texts", JSON.stringify(stripTexts));
	page.check(
		"strip names the first file and its position",
		stripTexts.some((t) => /Uploading anim\.webp · 1 of 2/.test(t))
	);
	page.check(
		"strip moves on to the second file",
		stripTexts.some((t) => /Uploading photo\.jpg · 2 of 2/.test(t))
	);
	page.check("strip goes away when the run is over", stripTexts[stripTexts.length - 1] === " | ");
	const inputValue = await page.evaluate(`document.querySelector("#input").value`);
	console.log("input", JSON.stringify(inputValue));
	page.check(
		"both URLs are in the input, in order",
		/f\/\d+-anim\.webp .*f\/\d+-photo\.jpg /.test(inputValue)
	);

	const after = await stats();
	console.log("uploader saw", JSON.stringify(after));
	const anim = after.uploads.find((u) => u.name === "anim.webp");
	const photo = after.uploads.find((u) => u.name === "photo.jpg");
	page.check(
		"animated WebP arrived byte for byte (no canvas re-encode)",
		anim?.size === fixtures.anim.size && anim?.sha256 === fixtures.anim.sha256
	);
	page.check(
		"JPEG arrived without its Exif segment",
		photo !== undefined && photo.hasExif === false
	);
	page.check("JPEG is still a JPEG", photo?.type === "image/jpeg");

	// 5. Sending shows the uploaded animated WebP inline (own messages skip the veil).
	// Only THIS run's URLs count: the channel keeps earlier runs' messages.
	const animUrl = /https:\/\/\S+\/f\/\d+-anim\.webp/.exec(inputValue)?.[0] ?? "";
	page.check("this run's WebP URL is known", animUrl !== "");
	const SENT = `Array.from(document.querySelectorAll("#chat .msg[data-type='message'] .content")).some((el) => el.textContent.includes(${JSON.stringify(
		animUrl
	)}))`;
	const EMBEDDED = `Array.from(document.querySelectorAll("#chat .msg[data-type='message'] .preview img")).some((i) => i.src === ${JSON.stringify(
		animUrl
	)} && i.complete && i.naturalWidth > 0)`;

	// What goes out is the store's pendingMessage, so it must match the textarea.
	const pending = await page.evaluate(PENDING);
	console.log("before send", JSON.stringify(pending));
	page.check(
		"the store's draft matches the textarea",
		pending.pendingMessage === pending.domValue
	);

	// Where would a click on the send button land?
	const hit = await page.evaluate(`(() => {
		const r = document.querySelector("#submit").getBoundingClientRect();
		const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return {rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], at: el ? el.tagName + "#" + el.id + "." + el.className : null};
	})()`);
	console.log("send button hit test", JSON.stringify(hit));

	await page.click("#submit");
	let sentBy = "click";

	try {
		await page.waitFor(SENT, {timeout: 4000, label: "the message row appears"});
	} catch (e) {
		// Diagnostic fallback: was it the click that missed, or the send?
		console.log(
			"submit click did not send; state:",
			JSON.stringify(await page.evaluate(PENDING)),
			"hover:",
			JSON.stringify(
				await page.evaluate(
					`document.querySelector("#submit:hover") ? "on #submit" : (document.querySelector(":hover") ? "elsewhere" : "none")`
				)
			)
		);
		await page.evaluate(`document.querySelector("#input").focus()`);
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			text: "\r",
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		sentBy = "enter";
		await page.waitFor(SENT, {timeout: 4000, label: "the message row appears after Enter"});
	}

	console.log("sent by", sentBy);
	page.check("the send button sends", sentBy === "click");
	await page.waitFor(EMBEDDED, {
		timeout: 20000,
		label: "the sent message embeds the uploaded WebP",
	});
	await page.sleep(400);
	await page.screenshot("upload-chat");

	// 6. Cancelling mid-flight is quiet.
	await page.evaluate(PASTE(["big"]));
	await page.waitFor(DIALOG_OPEN, {label: "the dialog opens for a plain file"});
	page.check(
		"a non-media file shows its extension badge",
		(await page.evaluate(ITEMS))[0]?.badge === "BIN"
	);
	await page.evaluate(WATCH_STRIP);
	await page.click("#upload-preview-confirm");
	await page.waitFor(`window.__strip.some((t) => /Uploading big\\.bin/.test(t))`, {
		label: "the strip shows the big file",
	});
	await page.sleep(400);
	const bigStrip = await page.evaluate(`window.__strip`);
	console.log("big-file strip", JSON.stringify(bigStrip));
	// On loopback the whole file enters the socket buffer at once, so the
	// bar is allowed to jump straight to "waiting"; a real network shows %.
	page.check(
		"a percentage or the waiting phase is reported",
		bigStrip.some((t) => /\d+%|waiting for the server/.test(t))
	);
	await page.click("#form .upload-bar .compose-bar-cancel");
	await page.waitFor(`!(${STRIP})`, {timeout: 15000, label: "cancel removes the strip"});
	await page.sleep(500);
	page.check("cancel shows no error banner", !/upload/i.test(await page.evaluate(ERROR_TEXT)));
	const final = await stats();
	page.check("the cancelled upload never completed", final.uploads.length === 2);
	console.log("aborted on the uploader side:", final.aborted);

	page.check("no console errors", page.consoleErrors.length === 0);
	if (page.consoleErrors.length) {
		console.log(page.consoleErrors);
	}
}
