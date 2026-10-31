/**
 * Central manager for user Lua scripts.
 *
 * Coordinates script storage, sandbox initialization, event routing,
 * and slash commands.
 *
 * Designed to be store-free and DOM-free so tests can load it directly.
 * UI/browser context is provided via `setContextProvider` at boot.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import {LuaSandbox, type SandboxHost} from "./engine";
import {isScriptingEnabled, onScriptingEnabledChange} from "./enabled";
import {loadScripts, saveScript, getScript} from "./storage";
import type {
	Script,
	ScriptMessageEvent,
	ScriptJoinEvent,
	ScriptPartEvent,
	ScriptQuitEvent,
	ScriptKickEvent,
	ScriptNickEvent,
	ScriptTopicEvent,
	ScriptModeEvent,
} from "./types";

/** Record a script's error (or its absence); a library that no longer fits keeps the old one. */
function storeLastError(script: Script, error: string | undefined): void {
	script.lastError = error;

	try {
		saveScript(script);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[scripting] could not record the script's error:", err);
	}
}

export const SCRIPTING_DISABLED_ERROR = "Scripting is disabled. Turn it on in Settings → Scripts.";

export interface ActiveContextProvider {
	getContext(): {channel: string; network: string; nick: string};
	print(text: string): void;
	/** The network with this uuid (none when it is gone); without one, the open network, else the first. */
	clientFor(networkUuid?: string): IrcClient | undefined;
}

/**
 * Lines a script sends outside a command the user typed (from an event
 * handler, or while loading) go through the connection's background queue,
 * paced by the fake-lag clock; past this many waiting, more are dropped.
 */
export const MAX_QUEUED_LINES = 10;
const QUEUE_KEY = "lua:";
/** How long a script's own PRIVMSG/NOTICE is remembered, to know its echo. */
const ECHO_MEMORY_MS = 60_000;
const ECHO_MEMORY_SIZE = 100;

let contextProvider: ActiveContextProvider | null = null;

export function setContextProvider(provider: ActiveContextProvider | null): void {
	contextProvider = provider;
}

/** `PRIVMSG <target> :<text>` / `NOTICE …`, a CTCP ACTION unwrapped as the message event shows it. */
function spokenLine(line: string): {target: string; text: string} | null {
	const match = /^(?:PRIVMSG|NOTICE) (\S+) :(.*)$/i.exec(line);

	if (!match) {
		return null;
	}

	let text = match[2];

	// As handlers/privmsg.ts parseCtcp reads it: the closing \x01 is optional.
	if (text.startsWith("\x01")) {
		const body = text.slice(1, text.endsWith("\x01") && text.length > 1 ? -1 : undefined);
		const space = body.indexOf(" ");
		const command = (space === -1 ? body : body.slice(0, space)).toUpperCase();

		if (command === "ACTION") {
			text = space === -1 ? "" : body.slice(space + 1);
		}
	}

	return {target: match[1], text};
}

function echoKey(networkUuid: string, target: string, text: string): string {
	return `${networkUuid}\n${target.toLowerCase()}\n${text}`;
}

class ScriptManager implements SandboxHost {
	private sandbox: LuaSandbox | null = null;
	/** Bumped whenever the sandbox is thrown away: a sandbox still loading for an older one is closed, not installed. */
	private generation = 0;
	private creating: Promise<LuaSandbox> | null = null;
	private queueSeq = 0;
	/** Connections holding queued script lines, to drop them when scripting is turned off. */
	private queuedOn = new Set<IrcClient>();
	/** What scripts said, so its echo does not wake the handlers that said it. */
	private ownLines = new Map<string, number>();
	private initPromise: Promise<void> | null = null;
	private activeContextOverride?: {
		client?: IrcClient;
		chan?: Channel;
		channel: string;
		network: string;
		nick: string;
	};

	/** Whether the sandbox exists — the Fengari chunk has been loaded. */
	public get loaded(): boolean {
		return this.sandbox !== null;
	}

	private discard(): void {
		this.generation++;
		this.creating = null;

		if (this.sandbox) {
			this.sandbox.close();
			this.sandbox = null;
		}
	}

	/** Drop the sandbox (and with it the loaded Lua state) and every line still queued, at once. */
	public teardown(): void {
		this.discard();
		this.initPromise = null;

		for (const client of this.queuedOn) {
			client.background.drop((key) => key.startsWith(QUEUE_KEY));
		}

		this.queuedOn.clear();
	}

	public async init(): Promise<void> {
		if (!isScriptingEnabled()) {
			return;
		}

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			const scripts = loadScripts();
			const hasEnabled = scripts.some((s) => s.enabled);

			if (!hasEnabled) {
				return;
			}

			await this.reload();
		})();

		return this.initPromise;
	}

	public async ensureSandbox(): Promise<LuaSandbox> {
		for (;;) {
			if (!isScriptingEnabled()) {
				throw new Error(SCRIPTING_DISABLED_ERROR);
			}

			if (this.sandbox) {
				return this.sandbox;
			}

			const generation = this.generation;
			this.creating ??= LuaSandbox.create(this);
			const creating = this.creating;
			const sandbox = await creating;

			if (this.creating === creating) {
				this.creating = null;
			}

			if (generation === this.generation && !this.sandbox && isScriptingEnabled()) {
				this.sandbox = sandbox;
				return sandbox;
			}

			if (this.sandbox !== sandbox) {
				sandbox.close(); // superseded while Fengari loaded: go round (or stop, if turned off)
			}
		}
	}

	public async reload(): Promise<void> {
		if (!isScriptingEnabled()) {
			this.teardown();
			return;
		}

		this.discard();
		const generation = this.generation;

		if (!loadScripts().some((s) => s.enabled)) {
			return;
		}

		let sandbox: LuaSandbox;

		try {
			sandbox = await this.ensureSandbox();
		} catch {
			return; // turned off meanwhile
		}

		if (generation !== this.generation) {
			return; // a newer reload owns the sandbox and loads the scripts
		}

		for (const script of loadScripts().filter((s) => s.enabled)) {
			const res = sandbox.eval(script.code, script.id);

			if (!res.success) {
				storeLastError(script, res.error);
				// eslint-disable-next-line no-console
				console.error(`[scripting] Error loading script "${script.name}":`, res.error);
			} else if (script.lastError) {
				storeLastError(script, undefined);
			}
		}
	}

	/** Compile `code` without running it: undefined when it is valid, else the syntax error. */
	public async checkSyntax(code: string): Promise<string | undefined> {
		try {
			return (await this.ensureSandbox()).check(code);
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	public async evalSnippet(
		code: string,
		ctx?: {chan?: Channel; client?: IrcClient}
	): Promise<{success: boolean; result?: string; error?: string}> {
		let sandbox: LuaSandbox;

		try {
			sandbox = await this.ensureSandbox();
		} catch {
			return {success: false, error: SCRIPTING_DISABLED_ERROR};
		}

		// Only now, and only for the synchronous run: an event handler that
		// fires while Fengari loads must not send as if the user typed it.
		this.useContext(ctx);

		try {
			return sandbox.eval(code, undefined);
		} finally {
			this.activeContextOverride = undefined;
		}
	}

	private useContext(ctx?: {chan?: Channel; client?: IrcClient}): void {
		if (ctx) {
			this.activeContextOverride = {
				client: ctx.client,
				chan: ctx.chan,
				channel: ctx.chan?.name ?? "",
				network: ctx.client?.name ?? "",
				nick: ctx.client?.nick ?? "",
			};
		}
	}

	public dispatchMessage(event: ScriptMessageEvent): void {
		if (!this.sandbox) {
			return;
		}

		if (event.self) {
			const key = echoKey(event.networkUuid, event.target, event.text);
			const until = this.ownLines.get(key);

			if (until !== undefined) {
				this.ownLines.delete(key);

				if (until > Date.now()) {
					return; // a script's own line: answering it is how loops start
				}
			}
		}

		try {
			this.sandbox.dispatch("message", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching message event:", err);
		}
	}

	public dispatchSend(line: string, target?: string): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("send", {line, target});
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching send event:", err);
		}
	}

	public dispatchJoin(event: ScriptJoinEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("join", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching join event:", err);
		}
	}

	public dispatchPart(event: ScriptPartEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("part", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching part event:", err);
		}
	}

	public dispatchQuit(event: ScriptQuitEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("quit", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching quit event:", err);
		}
	}

	public dispatchKick(event: ScriptKickEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("kick", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching kick event:", err);
		}
	}

	public dispatchNick(event: ScriptNickEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("nick", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching nick event:", err);
		}
	}

	public dispatchTopic(event: ScriptTopicEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("topic", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching topic event:", err);
		}
	}

	public dispatchMode(event: ScriptModeEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("mode", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching mode event:", err);
		}
	}

	public hasCommand(name: string): boolean {
		if (!this.sandbox) {
			return false;
		}

		return this.sandbox.hasCommand(name);
	}

	public runCommand(
		name: string,
		args: string[],
		rest: string,
		ctx?: {chan?: Channel; client?: IrcClient}
	): boolean {
		if (!this.sandbox) {
			return false;
		}

		this.useContext(ctx);

		try {
			return this.sandbox.runCommand(name, args, rest);
		} finally {
			this.activeContextOverride = undefined;
		}
	}

	public getCommandNames(): string[] {
		if (!this.sandbox) {
			return [];
		}

		return this.sandbox.getRegisteredCommandNames();
	}

	// --- SandboxHost implementation ---

	/** The client a script means: the network it named, else the one the user typed in, else the open one. */
	private clientOf(networkUuid?: string): IrcClient | undefined {
		const asked = this.activeContextOverride?.client;

		if (networkUuid !== undefined && networkUuid !== asked?.uuid) {
			return contextProvider?.clientFor(networkUuid);
		}

		return asked ?? contextProvider?.clientFor();
	}

	/** At once in a command the user typed on that network, else paced. */
	private deliver(client: IrcClient, line: string): void {
		this.rememberOwnLine(client, line);

		if (client === this.activeContextOverride?.client) {
			client.send(line);
		} else {
			this.sendPaced(client, line);
		}
	}

	public send(line: string, networkUuid?: string): void {
		const client = this.clientOf(networkUuid);

		if (!client || !client.isConnected || line.length === 0) {
			// eslint-disable-next-line no-console
			console.warn("[scripting] seance.send dropped; no connected network for it");
			return;
		}

		this.deliver(client, line);
	}

	public reply(msg: ScriptMessageEvent, text: string): void {
		const client = this.clientOf(msg.networkUuid || undefined);

		if (!client || !client.isConnected || !text) {
			return;
		}

		// A channel answers in the channel; a query answers the other side,
		// which for our own line is its target.
		const target = client.isChannelName(msg.target) || msg.self ? msg.target : msg.from;

		if (!target) {
			return;
		}

		this.deliver(client, `PRIVMSG ${target} :${text}`);
	}

	private sendPaced(client: IrcClient, line: string): void {
		if (client.background.count((key) => key.startsWith(QUEUE_KEY)) >= MAX_QUEUED_LINES) {
			this.print(
				`[Lua error] Not sent: ${MAX_QUEUED_LINES} script lines are already waiting to go out`
			);
			return;
		}

		this.queuedOn.add(client);
		client.background.add({
			key: `${QUEUE_KEY}${++this.queueSeq}`,
			cost: client.fakeLag.cost(line),
			run: () => void client.send(line),
		});
	}

	private rememberOwnLine(client: IrcClient, line: string): void {
		const spoken = spokenLine(line);

		if (!spoken) {
			return;
		}

		if (this.ownLines.size >= ECHO_MEMORY_SIZE) {
			const now = Date.now();

			for (const [key, until] of this.ownLines) {
				if (until <= now || this.ownLines.size >= ECHO_MEMORY_SIZE) {
					this.ownLines.delete(key);
				}
			}
		}

		this.ownLines.set(
			echoKey(client.uuid, spoken.target, spoken.text),
			Date.now() + ECHO_MEMORY_MS
		);
	}

	public print(text: string): void {
		if (this.activeContextOverride?.client && this.activeContextOverride.chan) {
			this.activeContextOverride.client.pushMessage(this.activeContextOverride.chan, {
				type: MessageType.MESSAGE,
				text,
				from: {
					nick: "lua",
					mode: "",
				},
			});
			return;
		}

		if (contextProvider) {
			contextProvider.print(text);
		} else {
			// eslint-disable-next-line no-console
			console.log("[scripting print]", text);
		}
	}

	public getCurrentContext(): {channel: string; network: string; nick: string} {
		if (this.activeContextOverride) {
			return {
				channel: this.activeContextOverride.channel,
				network: this.activeContextOverride.network,
				nick: this.activeContextOverride.nick,
			};
		}

		if (contextProvider) {
			return contextProvider.getContext();
		}

		return {
			channel: "",
			network: "",
			nick: "",
		};
	}

	public onError(error: string, scriptId?: string): void {
		if (scriptId) {
			const script = getScript(scriptId);

			if (script) {
				storeLastError(script, error);
			}
		}

		this.print(`[Lua error] ${error}`);
		// eslint-disable-next-line no-console
		console.error("[scripting error]", error);
	}
}

export const scriptManager = new ScriptManager();

// The Settings → Scripts switch (settings.ts writes the flag):
// turning it on loads Fengari and the enabled scripts; turning it off
// closes the Lua state at once, so no handler or command can fire again.
onScriptingEnabledChange((enabled) => {
	if (enabled) {
		// Deferred: at boot this fires from settings applyAll, before boot
		// has installed the context provider the scripts print/send through.
		queueMicrotask(() => void scriptManager.init());
	} else {
		scriptManager.teardown();
	}
});
