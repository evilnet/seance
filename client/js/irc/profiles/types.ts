/**
 * Server profiles: what an oper sees differs per ircd family — snomask
 * model, server notice texts, STATS letters, CHECK output. A profile is
 * data and pure functions over parsed lines, so it runs under mocha with
 * fixtures captured from a real server. Chosen per connection from the
 * version (004) and ISUPPORT ({@link detectProfile} in `./index.ts`).
 *
 * Adding an ircd: implement {@link ServerProfile} in a new directory here
 * and list it in `./index.ts`. Nothing outside `profiles/` needs to change.
 */

import type {OperReport, Route} from "../../../../shared/types/oper";
import type {IrcMessage} from "../message";

/** One bit of a numeric server notice mask (ircu family). */
export interface SnomaskBit {
	bit: number;
	/** Short name (`GLINE`, `CONNEXIT`), the `category` of notices on it. */
	name: string;
	/** Plain-English title for the switchboard. */
	label: string;
	description: string;
	volume: "none" | "low" | "medium" | "high";
	/** In the server's default mask for users / for opers. */
	userDefault?: boolean;
	operDefault?: boolean;
	/** Only opers may hold it. */
	operOnly?: boolean;
	/** A server feature that must be on for anything to be sent on it. */
	needsFeature?: string;
	/** Nothing sends on it on this server. */
	dead?: boolean;
	/** Exists only in debug builds (351 serveropts with `D`). */
	debugOnly?: boolean;
}

export interface SnomaskModel {
	bits: SnomaskBit[];
	/** Every settable bit (SNO_ALL). */
	all: number;
	/** Feature names holding the server's defaults (`GET` them; don't hard-code). */
	defaultFeature?: string;
	operDefaultFeature?: string;
	/** Fallback defaults when the feature cannot be read. */
	userDefault: number;
	operDefault: number;
}

/** One kind of server notice (or WALLOPS) the profile recognises. */
export interface NoticeKind {
	kind: string;
	label: string;
	/** Snomask bit name it travels on (`GLINE`), or `WALLOPS`. */
	category: string;
	/** Where it goes unless the oper overrides it. */
	route: Route;
	/**
	 * The notice in plain words, with `{field}` placeholders the UI fills
	 * from the event's fields: `{oper} added a {scope} G-line on {mask}`.
	 * The UI renders fields by name (see FIELD_TYPES in `./fields.ts`): a
	 * nick is a clickable nick, an ip/mask a chip with oper actions, an
	 * `expires` a relative time. Without one the original text is shown.
	 */
	template?: string;
}

/** A server notice, classified. */
export interface SnoticeEvent {
	kind: string;
	category: string;
	fields: Record<string, string>;
}

/** One STATS selector, as the server's help list or the profile describes it. */
export interface StatsEntry {
	/** The letter, or "" for selectors reachable by long name only. */
	letter: string;
	name: string;
	description: string;
}

export interface ServerProfile {
	id: string;
	/** Display name (`nefarious2`). */
	name: string;
	snomask?: SnomaskModel;
	/** Every notice kind the classifier can produce, with its default route. */
	noticeKinds: NoticeKind[];
	/**
	 * Classify the text of a server notice — without the `*** Notice -- `
	 * prefix — into a kind with fields; undefined when unrecognised.
	 */
	classifyNotice(text: string): SnoticeEvent | undefined;
	/** STATS selectors known without asking the server. */
	stats: StatsEntry[];
	/**
	 * Build the report for `STATS <selector>` from the reply lines (every
	 * line of the labeled response, numerics and NOTICEs, in order).
	 */
	statsReport(selector: string, lines: IrcMessage[], command: string): OperReport;
	/** Build the report for a CHECK reply; undefined when it is not one. */
	checkReport(lines: IrcMessage[], command: string): OperReport | undefined;
	/**
	 * Features worth reading with `GET` when opered (nefarious2:
	 * `CONNEXIT_NOTICES`), so the UI can say a category is silent.
	 */
	operFeatures: string[];
}
