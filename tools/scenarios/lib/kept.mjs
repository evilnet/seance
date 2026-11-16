// Shared by the scenarios about the conversations kept on the device
// (client/js/irc/conversationStore.ts): reading what IndexedDB holds, a real
// reload, and a `chathistory` batch for a scripted server.

/**
 * A page expression: the texts kept in IndexedDB, by folded target
 * (`{"#chan": [...], "nick": [...]}`); `{}` when nothing is kept.
 */
export const KEPT = `new Promise((resolve) => {
	const open = indexedDB.open("seance-conversations");
	open.onerror = () => resolve({});
	open.onsuccess = () => {
		const db = open.result;
		if (!db.objectStoreNames.contains("lines")) { db.close(); resolve({}); return; }
		const all = db.transaction("lines").objectStore("lines").getAll();
		all.onsuccess = () => {
			const out = {};
			for (const line of all.result) {
				const target = line.c.split("\\n")[1];
				(out[target] ??= []).push(line.msg.text);
			}
			db.close();
			resolve(out);
		};
	};
})`;

/**
 * F5 (see reload-on-settings.mjs for why it is replaceState + Page.reload),
 * then wait for the page expression `waitFor` in the new document.
 */
export async function coldLoad(page, waitFor) {
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", "/"); })()`
	);
	await page.send("Page.reload");
	const started = Date.now();

	for (;;) {
		try {
			if (await page.evaluate(`!window.__coldLoad && !!(${waitFor})`)) {
				return;
			}
		} catch {
			// the document is being replaced
		}

		if (Date.now() - started > 30000) {
			throw new Error(`timed out waiting for ${waitFor} after the reload`);
		}

		await page.sleep(100);
	}
}

/** A `chathistory` batch for `target`; `end` says there is nothing older (draft/chathistory-end). */
export function chathistory(send, target, lines, end = false) {
	send(`${end ? "@draft/chathistory-end " : ""}:tiny.test BATCH +h chathistory ${target}`);

	for (const line of lines) {
		send(`@batch=h;${line.slice(1)}`);
	}

	send(":tiny.test BATCH -h");
}
