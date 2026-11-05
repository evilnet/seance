/**
 * The words a server notice kind is shown in: its name (the Alerts tab,
 * the badge's menu) and its plain-words template (SnoticeText.vue), in the
 * reader's language. The profiles' tables (`nefarious/notices.ts`,
 * `snotice.ts` WALLOPS_KINDS) stay the English data the classifier and the
 * tests key on; this is the render-time view of them, one literal key per
 * kind (tools/i18n/check.ts reads them).
 *
 * A template comes back with its `{field}` placeholders intact (KEEP), for
 * `splitTemplate`/`fillTemplate` (./fields.ts) to fill as before. Where the
 * classifier put English words into a field that sits inside the sentence
 * (`state`, `scope`, `action`, `role`, `remote`, `via`, a webpush key
 * `cleared`, `what`), the field picks a whole-phrase variant instead of
 * being glued in; the one closed vocabulary left in a sentence, the ban
 * `{type}`, is filled with its translated name when it is not jargon.
 *
 * Kept free of store/DOM imports (mocha).
 */

import {KEEP, t, type Vars} from "../../i18n/core";
import type {NoticeKind} from "./types";

type Fields = Record<string, string>;

/** KEEP for every `{name}` in `template`. */
function keepAll(template: string): Vars {
	const vars: Vars = {};

	for (const m of template.matchAll(/\{(\w+)\}/g)) {
		vars[m[1]] = KEEP;
	}

	return vars;
}

/** A kind's name, translated; a kind nobody lists keeps the name it came with. */
export function kindLabel(kind: Pick<NoticeKind, "kind" | "label">): string {
	switch (kind.kind) {
		case "wallops":
			return t("oper.kind.wallops.label");
		case "wallusers":
			return t("oper.kind.wallusers.label");
		case "wallops.server":
			return t("oper.kind.wallops.server.label");
		case "desynch":
			return t("oper.kind.desynch.label");
		case "client.connect":
			return t("oper.kind.client.connect.label");
		case "client.exit":
			return t("oper.kind.client.exit.label");
		case "nick.change":
			return t("oper.kind.nick.change.label");
		case "webirc.host":
			return t("oper.kind.webirc.host.label");
		case "webirc.invalid":
			return t("oper.kind.webirc.invalid.label");
		case "webirc.unauthorized":
			return t("oper.kind.webirc.unauthorized.label");
		case "config.error":
			return t("oper.kind.config.error.label");
		case "kill.oper":
			return t("oper.kind.kill.oper.label");
		case "kill.server":
			return t("oper.kind.kill.server.label");
		case "ban.hit":
			return t("oper.kind.ban.hit.label");
		case "shun.match":
			return t("oper.kind.shun.match.label");
		case "ban.add":
			return t("oper.kind.ban.add.label");
		case "ban.activate":
			return t("oper.kind.ban.activate.label");
		case "ban.deactivate":
			return t("oper.kind.ban.deactivate.label");
		case "ban.modify":
			return t("oper.kind.ban.modify.label");
		case "ban.remove":
			return t("oper.kind.ban.remove.label");
		case "ban.forceremove":
			return t("oper.kind.ban.forceremove.label");
		case "tempshun.apply":
			return t("oper.kind.tempshun.apply.label");
		case "tempshun.remove":
			return t("oper.kind.tempshun.remove.label");
		case "dnsbl.block":
			return t("oper.kind.dnsbl.block.label");
		case "jupe.add":
			return t("oper.kind.jupe.add.label");
		case "jupe.activate":
			return t("oper.kind.jupe.activate.label");
		case "jupe.deactivate":
			return t("oper.kind.jupe.deactivate.label");
		case "oper.up":
			return t("oper.kind.oper.up.label");
		case "oper.fail":
			return t("oper.kind.oper.fail.label");
		case "bouncer.oreset":
			return t("oper.kind.bouncer.oreset.label");
		case "whois.notify":
			return t("oper.kind.whois.notify.label");
		case "net.junction":
			return t("oper.kind.net.junction.label");
		case "net.break":
			return t("oper.kind.net.break.label");
		case "net.burst":
			return t("oper.kind.net.burst.label");
		case "net.burstack":
			return t("oper.kind.net.burstack.label");
		case "net.drift":
			return t("oper.kind.net.drift.label");
		case "link.established":
			return t("oper.kind.link.established.label");
		case "link.cancelled":
			return t("oper.kind.link.cancelled.label");
		case "link.connecting":
			return t("oper.kind.link.connecting.label");
		case "link.failed":
			return t("oper.kind.link.failed.label");
		case "link.timeout":
			return t("oper.kind.link.timeout.label");
		case "link.refused":
			return t("oper.kind.link.refused.label");
		case "squit":
			return t("oper.kind.squit.label");
		case "squit.received":
			return t("oper.kind.squit.received.label");
		case "server.error":
			return t("oper.kind.server.error.label");
		case "sendq.exceeded":
			return t("oper.kind.sendq.exceeded.label");
		case "rehash":
			return t("oper.kind.rehash.label");
		case "rehash.signal":
			return t("oper.kind.rehash.signal.label");
		case "restart":
			return t("oper.kind.restart.label");
		case "clock":
			return t("oper.kind.clock.label");
		case "store.defrag":
			return t("oper.kind.store.defrag.label");
		case "gitsync":
			return t("oper.kind.gitsync.label");
		case "gitsync.fail":
			return t("oper.kind.gitsync.fail.label");
		case "tls.loaded":
			return t("oper.kind.tls.loaded.label");
		case "tls.fail":
			return t("oper.kind.tls.fail.label");
		case "webpush.key":
			return t("oper.kind.webpush.key.label");
		case "webpush.error":
			return t("oper.kind.webpush.error.label");
		case "nick.collision":
			return t("oper.kind.nick.collision.label");
		case "bouncer.event":
			return t("oper.kind.bouncer.event.label");
		case "server.internal":
			return t("oper.kind.server.internal.label");
		case "hack.mode":
			return t("oper.kind.hack.mode.label");
		case "hack.kick":
			return t("oper.kind.hack.kick.label");
		case "oper.join":
			return t("oper.kind.oper.join.label");
		case "deop.service":
			return t("oper.kind.deop.service.label");
		case "conn.unauth":
			return t("oper.kind.conn.unauth.label");
		case "conn.toomany":
			return t("oper.kind.conn.toomany.label");
		case "conn.ipmismatch":
			return t("oper.kind.conn.ipmismatch.label");
		case "conn.tlserror":
			return t("oper.kind.conn.tlserror.label");
		case "iauth":
			return t("oper.kind.iauth.label");
		case "log.alert":
			return t("oper.kind.log.alert.label");
		case "log.info":
			return t("oper.kind.log.info.label");
		case "unknown":
			return t("oper.kind.unknown.label");
		default:
			return kind.label;
	}
}

/**
 * A kind's template, translated, placeholders kept; undefined when the kind
 * has none. `fields` are the notice's own (they choose a variant).
 */
export function kindTemplate(
	kind: Pick<NoticeKind, "kind" | "template">,
	fields: Fields = {}
): string | undefined {
	const english = kind.template;

	if (!english) {
		return undefined;
	}

	const vars: Vars = {
		...keepAll(english),
		type: fields.type === "channel ban" ? t("oper.ban.type.channel") : KEEP,
	};

	switch (kind.kind) {
		case "client.connect":
			return t("oper.kind.client.connect.template", vars);
		case "client.exit":
			return t("oper.kind.client.exit.template", vars);
		case "nick.change":
			return t("oper.kind.nick.change.template", vars);
		case "webirc.host":
			return t("oper.kind.webirc.host.template", vars);
		case "webirc.unauthorized":
			return t("oper.kind.webirc.unauthorized.template", vars);
		case "config.error":
			return t("oper.kind.config.error.template", vars);
		case "kill.oper":
			return t("oper.kind.kill.oper.template", vars);
		case "kill.server":
			return t("oper.kind.kill.server.template", vars);
		case "ban.hit":
			return t("oper.kind.ban.hit.template", vars);
		case "shun.match":
			return t("oper.kind.shun.match.template", vars);
		case "ban.activate":
			return t("oper.kind.ban.activate.template", vars);
		case "ban.modify":
			return t("oper.kind.ban.modify.template", vars);
		case "ban.remove":
			return t("oper.kind.ban.remove.template", vars);
		case "ban.forceremove":
			return t("oper.kind.ban.forceremove.template", vars);
		case "tempshun.apply":
			return t("oper.kind.tempshun.apply.template", vars);
		case "tempshun.remove":
			return t("oper.kind.tempshun.remove.template", vars);
		case "dnsbl.block":
			return t("oper.kind.dnsbl.block.template", vars);
		case "jupe.activate":
			return t("oper.kind.jupe.activate.template", vars);
		case "bouncer.oreset":
			return t("oper.kind.bouncer.oreset.template", vars);
		case "whois.notify":
			return t("oper.kind.whois.notify.template", vars);
		case "net.junction":
			return t("oper.kind.net.junction.template", vars);
		case "net.break":
			return t("oper.kind.net.break.template", vars);
		case "net.burst":
			return t("oper.kind.net.burst.template", vars);
		case "net.burstack":
			return t("oper.kind.net.burstack.template", vars);
		case "net.drift":
			return t("oper.kind.net.drift.template", vars);
		case "link.established":
			return t("oper.kind.link.established.template", vars);
		case "link.cancelled":
			return t("oper.kind.link.cancelled.template", vars);
		case "link.timeout":
			return t("oper.kind.link.timeout.template", vars);
		case "squit.received":
			return t("oper.kind.squit.received.template", vars);
		case "server.error":
			return t("oper.kind.server.error.template", vars);
		case "sendq.exceeded":
			return t("oper.kind.sendq.exceeded.template", vars);
		case "restart":
			return t("oper.kind.restart.template", vars);
		case "store.defrag":
			return t("oper.kind.store.defrag.template", vars);
		case "tls.loaded":
			return t("oper.kind.tls.loaded.template", vars);
		case "tls.fail":
			return t("oper.kind.tls.fail.template", vars);
		case "webpush.error":
			return t("oper.kind.webpush.error.template", vars);
		case "hack.mode":
			return t("oper.kind.hack.mode.template", vars);
		case "hack.kick":
			return t("oper.kind.hack.kick.template", vars);
		case "oper.join":
			return t("oper.kind.oper.join.template", vars);
		case "deop.service":
			return t("oper.kind.deop.service.template", vars);
		case "conn.ipmismatch":
			return t("oper.kind.conn.ipmismatch.template", vars);
		case "gitsync.fail":
			return t("oper.kind.gitsync.fail.template", vars);
		default:
			return variantTemplate(kind.kind, fields, vars) ?? english;
	}
}

/** The kinds whose sentence depends on a field's value. */
function variantTemplate(kind: string, fields: Fields, vars: Vars): string | undefined {
	switch (kind) {
		case "ban.add": {
			const local = fields.scope === "local";
			const global = fields.scope === "global";

			if (fields.state) {
				return local
					? t("oper.kind.ban.add.template.deactivatedLocal", vars)
					: global
					? t("oper.kind.ban.add.template.deactivatedGlobal", vars)
					: undefined;
			}

			return local
				? t("oper.kind.ban.add.template.local", vars)
				: global
				? t("oper.kind.ban.add.template.global", vars)
				: undefined;
		}

		case "ban.deactivate":
			if (fields.action === "removed") {
				return fields.scope === "local"
					? t("oper.kind.ban.deactivate.template.removedLocal", vars)
					: t("oper.kind.ban.deactivate.template.removedGlobal", vars);
			}

			return fields.scope === "global"
				? t("oper.kind.ban.deactivate.template.deactivatedGlobal", vars)
				: undefined;

		case "jupe.add":
			return fields.scope === "local"
				? t("oper.kind.jupe.add.template.local", vars)
				: t("oper.kind.jupe.add.template.global", vars);

		case "jupe.deactivate":
			return fields.action === "deactivated"
				? t("oper.kind.jupe.deactivate.template.deactivated", vars)
				: t("oper.kind.jupe.deactivate.template.removed", vars);

		case "oper.up":
			switch (fields.role) {
				case "a global operator":
					return t("oper.kind.oper.up.template.global", vars);
				case "a local operator":
					return t("oper.kind.oper.up.template.local", vars);
				case "an IRC operator":
					return t("oper.kind.oper.up.template.ircOperator", vars);
				case "an IRC administrator":
					return t("oper.kind.oper.up.template.ircAdmin", vars);
				default:
					return undefined;
			}

		case "oper.fail":
			return fields.remote
				? t("oper.kind.oper.fail.template.remote", vars)
				: t("oper.kind.oper.fail.template.local", vars);

		case "rehash": {
			// `via` is ` from <server>` in the fields: the variant says "from".
			const via = /^ from (.+)$/.exec(fields.via ?? "")?.[1];

			if (fields.via && !via) {
				return undefined;
			}

			const withVia = {...vars, via: via ?? ""};
			return fields.remote
				? via
					? t("oper.kind.rehash.template.remoteVia", withVia)
					: t("oper.kind.rehash.template.remote", vars)
				: via
				? t("oper.kind.rehash.template.localVia", withVia)
				: t("oper.kind.rehash.template.local", vars);
		}

		case "squit":
			return fields.scope === "Local"
				? t("oper.kind.squit.template.local", vars)
				: fields.scope === "Remote"
				? t("oper.kind.squit.template.remote", vars)
				: undefined;

		case "webirc.invalid":
			switch (fields.what) {
				case "password":
					return t("oper.kind.webirc.invalid.template.password", vars);
				case "parameters":
					return t("oper.kind.webirc.invalid.template.parameters", vars);
				case "IP address":
					return t("oper.kind.webirc.invalid.template.ip", vars);
				case "host name":
					return t("oper.kind.webirc.invalid.template.host", vars);
				default:
					return undefined;
			}

		case "webpush.key":
			return fields.key === "cleared"
				? t("oper.kind.webpush.key.template.cleared", vars)
				: t("oper.kind.webpush.key.template.current", vars);

		case "gitsync": {
			const by = /^triggered by (.*)$/.exec(fields.message ?? "")?.[1];
			return by !== undefined
				? t("oper.kind.gitsync.template.triggered", {...vars, by})
				: t("oper.kind.gitsync.template.plain", vars);
		}

		default:
			return undefined;
	}
}
