/**
 * nefarious2 (EvilNet's ircu fork, `ircv3.2-upgrade` branch). Wire facts:
 * docs/resources/nefarious2-oper.md.
 */

import type {ServerProfile} from "../types";
import {checkReport} from "./check";
import {classifyNotice, NOTICE_KINDS} from "./notices";
import {NEFARIOUS_SNOMASK} from "./snomask";
import {STATS_ENTRIES, statsReport} from "./stats";

export const nefarious: ServerProfile = {
	id: "nefarious2",
	name: "nefarious2",
	snomask: NEFARIOUS_SNOMASK,
	noticeKinds: NOTICE_KINDS,
	classifyNotice,
	stats: STATS_ENTRIES,
	statsReport,
	checkReport,
	operFeatures: ["CONNEXIT_NOTICES", "SNOMASK_OPERDEFAULT"],
};
