/**
 * nefarious2 (EvilNet's ircu fork, `ircv3.2-upgrade` branch). Wire facts:
 * docs/resources/nefarious2-oper.md.
 */

import type {SearchAttrs} from "../../../../../shared/types/search";
import type {ServerProfile} from "../types";
import {ALERT_LINES} from "./alerts";
import {checkReport} from "./check";
import {describeBan} from "./extbans";
import {classifyNotice, NOTICE_KINDS} from "./notices";
import {NEFARIOUS_SNOMASK} from "./snomask";
import {STATS_ENTRIES, statsReport} from "./stats";

/**
 * `m_search` takes `key=value` selectors as separate parameters, not the spec's
 * one `;`-joined parameter, which it would read as one long `in=`. Only the
 * last may hold a space, so `text` goes last.
 */
function searchParams(attrs: SearchAttrs): string[] {
	const {text, ...rest} = attrs;
	const params = Object.entries(rest)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}=${String(value)}`);

	return text ? [...params, `text=${text}`] : params;
}

export const nefarious: ServerProfile = {
	id: "nefarious2",
	name: "nefarious2",
	describeBan,
	searchParams,
	snomask: NEFARIOUS_SNOMASK,
	noticeKinds: NOTICE_KINDS,
	alertLines: ALERT_LINES,
	classifyNotice,
	stats: STATS_ENTRIES,
	statsReport,
	checkReport,
	operFeatures: ["CONNEXIT_NOTICES", "SNOMASK_OPERDEFAULT"],
	privateMetadata: true,
};
