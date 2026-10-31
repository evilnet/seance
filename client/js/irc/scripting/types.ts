/**
 * Type definitions for Seance's Lua scripting subsystem.
 */

import type {Channel} from "../channel";
import type {IrcClient} from "../client";

export interface Script {
	id: string;
	name: string;
	code: string;
	enabled: boolean;
	/** Library folder the script is filed under (see storage `normalizeFolder`). */
	folder: string;
	/** One-line note shown and searched in the script library. */
	description?: string;
	lastError?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface ScriptMessageEvent {
	network: string;
	/** The connection's uuid: `seance.send(line, networkUuid)` targets it. */
	networkUuid: string;
	target: string;
	from: string;
	text: string;
	type: "message" | "notice" | "action";
	self: boolean;
	tags?: Record<string, string>;
}

export interface ScriptJoinEvent {
	network: string;
	networkUuid: string;
	channel: string;
	nick: string;
	account?: string;
	ident?: string;
	host?: string;
	self: boolean;
}

export interface ScriptPartEvent {
	network: string;
	networkUuid: string;
	channel: string;
	nick: string;
	message?: string;
	self: boolean;
}

export interface ScriptQuitEvent {
	network: string;
	networkUuid: string;
	nick: string;
	message?: string;
}

export interface ScriptKickEvent {
	network: string;
	networkUuid: string;
	channel: string;
	nick: string;
	kicked: string;
	reason?: string;
	self: boolean;
}

export interface ScriptNickEvent {
	network: string;
	networkUuid: string;
	oldNick: string;
	newNick: string;
	self: boolean;
}

export interface ScriptTopicEvent {
	network: string;
	networkUuid: string;
	channel: string;
	topic: string;
	nick: string;
}

export interface ScriptModeEvent {
	network: string;
	networkUuid: string;
	target: string;
	mode: string;
	params: string[];
	from: string;
}

export interface ScriptCommandContext {
	client: IrcClient;
	chan: Channel;
	command: string;
	args: string[];
	rest: string;
}

export interface ScriptStorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
	keys(): string[];
}
