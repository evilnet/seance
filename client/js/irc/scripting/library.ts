/**
 * What the Scripts settings tab needs that is not storage: fresh ids and
 * names, the starter templates, and the rename check. Vue-free so mocha
 * loads it (test/irc/scripting.ts).
 */

import {isValidScriptName, MAX_NAME_LENGTH} from "./storage";
import type {Script} from "./types";
import {t} from "../../i18n/core";

export function newScriptId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nameTaken(scripts: Script[], name: string, exceptId?: string): boolean {
	return scripts.some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());
}

/** `base`, else `base_2`, `base_3`…, cut so the suffix still fits the name limit. */
export function uniqueScriptName(scripts: Script[], base: string): string {
	let name = base.slice(0, MAX_NAME_LENGTH);

	for (let n = 2; nameTaken(scripts, name); n++) {
		const suffix = `_${n}`;
		name = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
	}

	return name;
}

/** A script name from an imported file's name: `My Bot.lua` → `my_bot`. */
export function importedScriptName(fileName: string): string {
	return (
		fileName
			.replace(/\.lua$/i, "")
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "_")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, MAX_NAME_LENGTH) || "imported_script"
	);
}

/**
 * Why `name` cannot be this script's name, or null when it can. The
 * library drops an entry with an invalid or duplicate name when it next
 * loads, so the editor keeps such a name to itself until it is fixed.
 */
export function scriptNameError(scripts: Script[], name: string, id: string): string | null {
	if (name.length === 0) {
		return t("scripting.nameEmpty");
	}

	if (!isValidScriptName(name)) {
		return t("scripting.nameInvalid", {max: MAX_NAME_LENGTH});
	}

	if (nameTaken(scripts, name, id)) {
		return t("scripting.nameTaken", {name});
	}

	return null;
}

export function scriptTemplate(kind: "responder" | "slap", scripts: Script[]): Script {
	if (kind === "responder") {
		return {
			id: newScriptId(),
			name: uniqueScriptName(scripts, "auto_ping"),
			folder: t("scripting.template.responderFolder"),
			description: t("scripting.template.responderDescription"),
			code: `-- Auto-responder example\nseance.on("message", function(msg)\n    if msg.text == "!ping" and not msg.self then\n        seance.reply(msg, "pong! " .. seance.nick)\n    end\nend)\n`,
			enabled: true,
			createdAt: Date.now(),
		};
	}

	return {
		id: newScriptId(),
		name: uniqueScriptName(scripts, "slap_cmd"),
		folder: t("scripting.template.slapFolder"),
		description: t("scripting.template.slapDescription"),
		code: `-- Custom /slap command\nseance.register_command("slap", function(args, rest)\n    local target = rest ~= "" and rest or "themselves"\n    local chan = seance.current_channel\n    if chan ~= "" then\n        seance.send("PRIVMSG " .. chan .. " :\\001ACTION slaps " .. target .. " with a large trout\\001")\n    end\nend)\n`,
		enabled: true,
		createdAt: Date.now(),
	};
}
