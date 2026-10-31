/**
 * Sandboxed Lua execution engine using Fengari.
 *
 * Provides an isolated runtime with:
 * - Lazy-loaded Fengari chunk
 * - Only the base, coroutine, table, string, math and utf8 libraries: no
 *   `io`, `os`, `package`/`require` or `debug` exist, not even in the
 *   registry's loaded-module table
 * - `load` limited to source text (no bytecode), no `string.dump`, `dofile`
 *   or `loadfile`, and a cap on what `string.rep` may build
 * - An instruction limit hook (LUA_MASKCOUNT) that aborts runaway code; new
 *   coroutines inherit it and count against the same budget
 * - One environment per script, each with its own read-only `seance` table
 *   bound to that script's id, and the dispatch tables kept in locals no
 *   script can reach
 */

import type * as FengariType from "fengari";
import type {ScriptMessageEvent} from "./types";
import {ScriptStorageError, loadScriptData, saveScriptData} from "./storage";
import {t} from "../../i18n/core";

let fengariPromise: Promise<typeof FengariType> | null = null;

export function getFengari(): Promise<typeof FengariType> {
	if (!fengariPromise) {
		fengariPromise = import(/* webpackChunkName: "fengari" */ "fengari");
	}

	return fengariPromise;
}

export interface SandboxHost {
	send(line: string, networkUuid?: string): void;
	reply(msg: ScriptMessageEvent, text: string): void;
	print(text: string): void;
	getCurrentContext(): {channel: string; network: string; nick: string};
	onError(error: string, scriptId?: string): void;
}

/** Instructions one call may run: a script's load, one handler, one command. */
const MAX_INSTRUCTIONS = 100000;
/** Instructions one event may run across all its handlers. */
export const MAX_EVENT_INSTRUCTIONS = 1_000_000;
const HOOK_INTERVAL = 1000;
/** The longest string `string.rep` may build, in bytes. */
export const MAX_REP_LENGTH = 1 << 20;
/** Handlers per event name, and command names, across all scripts. */
export const MAX_HANDLERS = 50;
export const MAX_COMMANDS = 100;
/** The storage bucket and error owner of `/lua` snippets. */
const SNIPPET_ID = "global";

/**
 * What the bootstrap reports through host.error, as a sentence: `kind` is
 * "skipped" (an event's handlers ran out of instructions), "handler" or
 * "command" (one failed); `name` is the event or command, `detail` the
 * error as the interpreter described it.
 */
function hostErrorText(kind: string, name: string, detail: string): string {
	switch (kind) {
		case "skipped":
			return t("scripting.eventSkipped", {event: name});
		case "command":
			return t("scripting.commandFailed", {command: name, error: detail});
		default:
			return t("scripting.handlerFailed", {event: name, error: detail});
	}
}

/** How deep, and how many entries, a Lua table is followed when it is handed to JavaScript. */
const MAX_TABLE_DEPTH = 8;
const MAX_TABLE_ENTRIES = 1000;

// Runs once per state with the host functions as its argument and returns
// the internals the engine calls. Everything a script could use to break
// another script lives in its locals.
const BOOTSTRAP = `
	local host = ...
	local base_load, error, type, tostring, tonumber, setmetatable, getmetatable, select, pairs, next =
		load, error, type, tostring, tonumber, setmetatable, getmetatable, select, pairs, next
	local lower, rep = string.lower, string.rep
	local max_rep, max_handlers, max_commands = host.max_rep, host.max_handlers, host.max_commands

	-- Each script gets its own load, below (text only: Lua's undumper
	-- trusts the bytecode it is given).
	load, dofile, loadfile, string.dump = nil, nil, nil, nil

	-- The string library is shared: no script reaches it through a
	-- string's metatable.
	getmetatable("").__metatable = false

	string.rep = function(s, n, sep)
		local count = tonumber(n) -- string.rep takes "5" as well as 5
		if count and count > 1 then
			local size = #tostring(s) * count
			if sep ~= nil then
				size = size + #tostring(sep) * (count - 1)
			end
			if size > max_rep then
				error("string.rep: result too large", 2)
			end
		end
		return rep(s, n, sep)
	end

	-- The libraries as opened. Scripts see them through views of their own,
	-- never these tables, so none can change what another script calls.
	local stdlib = {}
	for k, v in pairs(_G) do
		if k ~= "_G" then stdlib[k] = v end
	end

	local handlers, commands, envs = {}, {}, {}
	local command_count = 0

	local function readonly()
		error("seance is read-only", 2)
	end

	local function readonly_lib()
		error("the standard library is read-only", 2)
	end

	local function view(lib)
		return setmetatable({}, {
			__index = lib,
			__newindex = readonly_lib,
			__pairs = function() return next, lib, nil end,
			__metatable = false,
		})
	end

	-- Never through __tostring: a script's error object could loop or fail.
	local function describe(err)
		local kind = type(err)
		if kind == "string" or kind == "number" then return tostring(err) end
		return "(error object is a " .. kind .. " value)"
	end

	-- Every handler gets its own event: one cannot rewrite what the next sees.
	local function copy(value, depth)
		if type(value) ~= "table" or depth > 4 then return value end
		local out = {}
		for k, v in next, value do
			out[k] = copy(v, depth + 1)
		end
		return out
	end

	local function api_for(id)
		local storage = setmetatable({}, {
			__index = {
				get = function(key) return host.storage_get(id, key) end,
				set = function(key, value)
					local err = host.storage_set(id, key, value)
					if err then error(err, 2) end
				end,
			},
			__newindex = readonly,
			__metatable = false,
		})

		local api = {
			send = host.send,
			reply = host.reply,
			print = host.print,
			storage = storage,
			on = function(evt, fn)
				if type(evt) ~= "string" or type(fn) ~= "function" then return end
				local key = lower(evt)
				local list = handlers[key]
				if not list then
					list = {}
					handlers[key] = list
				end
				if #list >= max_handlers then
					error("seance.on: too many " .. key .. " handlers (" .. max_handlers .. ")", 2)
				end
				list[#list + 1] = {id = id, fn = fn}
			end,
			register_command = function(name, fn)
				if type(name) ~= "string" or type(fn) ~= "function" then return end
				local key = lower(name)
				if commands[key] == nil then
					if command_count >= max_commands then
						error("seance.register_command: too many commands (" .. max_commands .. ")", 2)
					end
					command_count = command_count + 1
				end
				commands[key] = {id = id, fn = fn}
			end,
		}

		return setmetatable({}, {
			__index = function(_, k)
				local v = api[k]
				if v ~= nil then return v end
				return host.context(k)
			end,
			__newindex = readonly,
			__metatable = false,
		})
	end

	local function env_for(id)
		local env = envs[id]
		if env then return env end

		local globals = {}
		for k, v in pairs(stdlib) do
			globals[k] = type(v) == "table" and view(v) or v
		end

		env = setmetatable({}, {__index = globals, __metatable = false})
		globals._G = env
		globals.seance = api_for(id)
		-- A chunk loaded without an environment runs in the script's own.
		globals.load = function(chunk, name, mode, ...)
			if select("#", ...) > 0 then
				return base_load(chunk, name, "t", ...)
			end
			return base_load(chunk, name, "t", env)
		end

		envs[id] = env
		return env
	end

	local function load_script(id, code)
		return base_load(code, nil, "t", env_for(id))
	end

	local function check(code)
		local fn, err = base_load(code, nil, "t")
		if fn then return true end
		return err
	end

	local function dispatch(evt, data)
		local list = handlers[lower(evt)]
		if not list then return end
		-- The handlers as they stand: one added now waits for the next event.
		for i = 1, #list do
			local h = list[i]
			local ok, err = host.run(h.fn, copy(data, 1))
			if ok == nil then
				host.error(h.id, "skipped", evt)
				return
			end
			if not ok then
				host.error(h.id, "handler", evt, describe(err))
			end
		end
	end

	local function run_command(name, args, rest)
		local cmd = commands[lower(name)]
		if not cmd then return false end
		local ok, err = host.run(cmd.fn, args, rest)
		if not ok then
			host.error(cmd.id, "command", name, describe(err))
		end
		return true
	end

	local function has_command(name)
		return commands[lower(name)] ~= nil
	end

	local function command_names()
		local names = {}
		for k in pairs(commands) do
			names[#names + 1] = k
		end
		return names
	end

	return {
		load = load_script,
		check = check,
		dispatch = dispatch,
		run = run_command,
		has = has_command,
		names = command_names,
	}
`;

export class LuaSandbox {
	private fengari: typeof FengariType;
	private L: any;
	private host: SandboxHost;
	private instructionCount = 0;
	/** What the current top-level call (an event's dispatch, say) has run in all. */
	private callTotal = 0;
	/** Registry reference to the table BOOTSTRAP returned. */
	private internals = 0;

	private constructor(fengari: typeof FengariType, host: SandboxHost) {
		this.fengari = fengari;
		this.host = host;

		this.L = fengari.lauxlib.luaL_newstate();
		this.catchNativeErrors();
		this.openSafeLibs();
		this.setupInstructionHook();
		this.bootstrap();
	}

	public static async create(host: SandboxHost): Promise<LuaSandbox> {
		const fengari = await getFengari();
		return new LuaSandbox(fengari, host);
	}

	/**
	 * A JavaScript exception thrown inside the VM (a host function, Fengari
	 * itself) becomes an ordinary Lua error. Without this Fengari leaves the
	 * state unusable: every later call fails, and every script with it.
	 */
	private catchNativeErrors(): void {
		const {lua, to_luastring} = this.fengari;
		lua.lua_atnativeerror(this.L, (state: any) => {
			const err: unknown = lua.lua_touserdata(state, 1);
			const text = err instanceof Error ? err.message : String(err);
			lua.lua_pushstring(state, to_luastring(`internal error: ${text}`));
			return 1;
		});
	}

	/**
	 * The value at `idx` as an error message, without calling `__tostring`:
	 * outside a protected call a metamethod that loops or fails would panic
	 * the whole state.
	 */
	private errorText(idx: number): string {
		const {lua, to_jsstring} = this.fengari;
		const type = lua.lua_type(this.L, idx);

		if (type === lua.LUA_TSTRING || type === lua.LUA_TNUMBER) {
			return to_jsstring(lua.lua_tostring(this.L, idx));
		}

		return `(error object is a ${to_jsstring(lua.lua_typename(this.L, type))} value)`;
	}

	/** A returned value as `/lua` shows it: a table or function is named, never walked. */
	private displayText(idx: number): string {
		const {lua, to_jsstring} = this.fengari;
		const type = lua.lua_type(this.L, idx);

		if (type === lua.LUA_TNIL) {
			return "nil";
		}

		if (type === lua.LUA_TBOOLEAN) {
			return String(lua.lua_toboolean(this.L, idx));
		}

		if (type === lua.LUA_TSTRING || type === lua.LUA_TNUMBER) {
			return to_jsstring(lua.lua_tostring(this.L, idx));
		}

		return `[lua ${to_jsstring(lua.lua_typename(this.L, type))}]`;
	}

	private openSafeLibs(): void {
		const {lua, lauxlib, lualib, to_luastring} = this.fengari;
		const libs: [string, (L: any) => number][] = [
			["_G", lualib.luaopen_base],
			[lualib.LUA_COLIBNAME, lualib.luaopen_coroutine],
			[lualib.LUA_TABLIBNAME, lualib.luaopen_table],
			[lualib.LUA_STRLIBNAME, lualib.luaopen_string],
			[lualib.LUA_MATHLIBNAME, lualib.luaopen_math],
			[lualib.LUA_UTF8LIBNAME, lualib.luaopen_utf8],
		];

		for (const [name, open] of libs) {
			lauxlib.luaL_requiref(this.L, to_luastring(name), open, 1);
			lua.lua_pop(this.L, 1);
		}
	}

	private readonly hook = (state: any): void => {
		const {lua, to_luastring} = this.fengari;
		const count = lua.lua_gethookcount(state);
		this.instructionCount += count;
		this.callTotal += count;

		if (this.instructionCount > MAX_INSTRUCTIONS) {
			// From here every instruction raises, so a pcall in a loop cannot
			// catch the error and go round again: the loop around it dies on
			// its next instruction.
			lua.lua_sethook(state, this.hook, lua.LUA_MASKCOUNT, 1);
			lua.lua_sethook(this.L, this.hook, lua.LUA_MASKCOUNT, 1);
			lua.lua_pushstring(
				state,
				to_luastring("Instruction limit exceeded (possible infinite loop)")
			);
			lua.lua_error(state);
		}
	};

	private setupInstructionHook(): void {
		// Set on the main state before any script runs; lua_newthread copies
		// it to every coroutine, and they all charge the same counter.
		this.fengari.lua.lua_sethook(
			this.L,
			this.hook,
			this.fengari.lua.LUA_MASKCOUNT,
			HOOK_INTERVAL
		);
	}

	/** A fresh budget for one handler or command; the call's total runs on. */
	private resetHandlerBudget(): void {
		this.instructionCount = 0;
		this.setupInstructionHook();
	}

	/** A fresh budget for a top-level call from JavaScript. */
	private resetInstructions(): void {
		this.callTotal = 0;
		this.resetHandlerBudget();
	}

	private getString(state: any, idx: number): string {
		const {lua, to_jsstring} = this.fengari;
		const str = lua.lua_tostring(state, idx);
		return str ? to_jsstring(str) : "";
	}

	private bootstrap(): void {
		const {lua, lauxlib, to_luastring} = this.fengari;
		const L = this.L;

		const fn = (name: string, f: (state: any) => number) => {
			lua.lua_pushcfunction(L, f);
			lua.lua_setfield(L, -2, to_luastring(name));
		};

		if (lauxlib.luaL_loadstring(L, to_luastring(BOOTSTRAP)) !== lua.LUA_OK) {
			throw new Error(`Lua bootstrap: ${this.getString(L, -1)}`);
		}

		lua.lua_newtable(L);

		for (const [name, value] of [
			["max_rep", MAX_REP_LENGTH],
			["max_handlers", MAX_HANDLERS],
			["max_commands", MAX_COMMANDS],
		] as const) {
			lua.lua_pushinteger(L, value);
			lua.lua_setfield(L, -2, to_luastring(name));
		}

		// host.run(fn, ...): call one handler or command on a budget of its
		// own, and give the code after it a fresh one too, so a handler that
		// spends everything cannot take the dispatch loop down with it.
		// true, or false and the error; nil once the event's total is spent.
		fn("run", (state) => {
			if (this.callTotal >= MAX_EVENT_INSTRUCTIONS) {
				lua.lua_pushnil(state);
				return 1;
			}

			this.resetHandlerBudget();
			const status = lua.lua_pcall(state, lua.lua_gettop(state) - 1, 0, 0);
			this.resetHandlerBudget();

			if (status === lua.LUA_OK) {
				lua.lua_pushboolean(state, true);
				return 1;
			}

			lua.lua_pushboolean(state, false);
			lua.lua_rotate(state, -2, 1); // false, error
			return 2;
		});

		// host.error(id, kind, name, detail): the sentence is the host's, in
		// the reader's language; the name and the error text are verbatim.
		fn("error", (state) => {
			const id = this.getString(state, 1);
			const text = hostErrorText(
				this.getString(state, 2),
				this.getString(state, 3),
				this.getString(state, 4)
			);
			this.host.onError(text, id === SNIPPET_ID ? undefined : id);
			return 0;
		});

		// seance.send(line, networkUuid?)
		fn("send", (state) => {
			const line = this.getString(state, 1);
			const net = lua.lua_isstring(state, 2) ? this.getString(state, 2) : undefined;
			this.host.send(line, net);
			return 0;
		});

		// seance.reply(msgTable, text): only the fields a reply needs, read
		// raw (no metamethod runs, and no table is walked whole).
		fn("reply", (state) => {
			if (!lua.lua_istable(state, 1)) {
				return 0;
			}

			const field = (key: string): string | boolean | undefined => {
				lua.lua_pushstring(state, to_luastring(key));
				lua.lua_rawget(state, 1);
				const type = lua.lua_type(state, -1);
				const value =
					type === lua.LUA_TSTRING
						? this.getString(state, -1)
						: type === lua.LUA_TBOOLEAN
						? lua.lua_toboolean(state, -1)
						: undefined;
				lua.lua_pop(state, 1);
				return value;
			};

			const text = (key: string) => {
				const value = field(key);
				return typeof value === "string" ? value : "";
			};

			this.host.reply(
				{
					network: text("network"),
					networkUuid: text("networkUuid"),
					target: text("target"),
					from: text("from"),
					text: text("text"),
					type: "message",
					self: field("self") === true,
				},
				this.getString(state, 2)
			);
			return 0;
		});

		fn("print", (state) => {
			this.host.print(this.getString(state, 1));
			return 0;
		});

		fn("storage_get", (state) => {
			const data = loadScriptData(this.getString(state, 1));
			const val = data[this.getString(state, 2)];

			if (val === undefined) {
				lua.lua_pushnil(state);
			} else {
				lua.lua_pushstring(state, to_luastring(val));
			}

			return 1;
		});

		fn("storage_set", (state) => {
			const id = this.getString(state, 1);
			const key = this.getString(state, 2);
			const data = loadScriptData(id);

			if (lua.lua_isnoneornil(state, 3)) {
				delete data[key];
			} else {
				data[key] = this.getString(state, 3);
			}

			try {
				saveScriptData(id, data);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				lua.lua_pushstring(state, to_luastring(`seance.storage: ${err.message}`));
				return 1; // raised by the Lua side, at the caller's level
			}

			return 0;
		});

		// seance.current_channel, seance.current_network, seance.nick
		fn("context", (state) => {
			const prop = this.getString(state, 1);
			const ctx = this.host.getCurrentContext();
			const value =
				prop === "current_channel"
					? ctx.channel
					: prop === "current_network"
					? ctx.network
					: prop === "nick"
					? ctx.nick
					: undefined;

			if (value === undefined) {
				lua.lua_pushnil(state);
			} else {
				lua.lua_pushstring(state, to_luastring(value));
			}

			return 1;
		});

		if (lua.lua_pcall(L, 1, 1, 0) !== lua.LUA_OK) {
			throw new Error(`Lua bootstrap: ${this.getString(L, -1)}`);
		}

		this.internals = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
	}

	/** Push one of the functions BOOTSTRAP returned. */
	private pushInternal(name: string): void {
		const {lua, to_luastring} = this.fengari;
		lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, this.internals);
		lua.lua_getfield(this.L, -1, to_luastring(name));
		lua.lua_remove(this.L, -2);
	}

	public pushValue(val: unknown): void {
		const {lua, to_luastring} = this.fengari;

		if (val === null || val === undefined) {
			lua.lua_pushnil(this.L);
		} else if (typeof val === "string") {
			lua.lua_pushstring(this.L, to_luastring(val));
		} else if (typeof val === "number") {
			lua.lua_pushnumber(this.L, val);
		} else if (typeof val === "boolean") {
			lua.lua_pushboolean(this.L, val);
		} else if (Array.isArray(val)) {
			lua.lua_newtable(this.L);
			val.forEach((item, idx) => {
				lua.lua_pushinteger(this.L, idx + 1);
				this.pushValue(item);
				lua.lua_settable(this.L, -3);
			});
		} else if (typeof val === "object") {
			lua.lua_newtable(this.L);

			for (const [k, v] of Object.entries(val)) {
				lua.lua_pushstring(this.L, to_luastring(k));
				this.pushValue(v);
				lua.lua_settable(this.L, -3);
			}
		} else {
			lua.lua_pushnil(this.L);
		}
	}

	/**
	 * A Lua value as JavaScript; tables are followed MAX_TABLE_DEPTH deep (a
	 * cycle ends there) and MAX_TABLE_ENTRIES entries in all, since no
	 * instruction hook counts this walk.
	 */
	public toJsValue(
		idx: number,
		state: any = this.L,
		depth = 0,
		budget = {left: MAX_TABLE_ENTRIES}
	): unknown {
		const {lua, to_jsstring} = this.fengari;
		const type = lua.lua_type(state, idx);

		switch (type) {
			case lua.LUA_TNIL:
				return undefined;
			case lua.LUA_TBOOLEAN:
				return lua.lua_toboolean(state, idx);
			case lua.LUA_TNUMBER:
				return lua.lua_tonumber(state, idx);

			case lua.LUA_TSTRING: {
				const str = lua.lua_tostring(state, idx);
				return str ? to_jsstring(str) : "";
			}

			case lua.LUA_TTABLE: {
				if (depth >= MAX_TABLE_DEPTH) {
					return undefined;
				}

				const obj: Record<string, unknown> = {};
				const absIdx = idx < 0 ? lua.lua_gettop(state) + idx + 1 : idx;
				lua.lua_pushnil(state);

				while (lua.lua_next(state, absIdx) !== 0) {
					if (--budget.left < 0) {
						lua.lua_pop(state, 2);
						break;
					}

					const k = String(this.toJsValue(-2, state, depth + 1, budget));
					obj[k] = this.toJsValue(-1, state, depth + 1, budget);
					lua.lua_pop(state, 1);
				}

				return obj;
			}

			default:
				return `[lua ${to_jsstring(lua.lua_typename(state, type))}]`;
		}
	}

	public eval(
		code: string,
		scriptId?: string
	): {success: boolean; result?: string; error?: string} {
		const {lua} = this.fengari;
		const L = this.L;
		lua.lua_settop(L, 0);
		this.resetInstructions();

		const fail = () => {
			const error = this.errorText(-1);
			lua.lua_settop(L, 0);
			return {success: false, error};
		};

		this.pushInternal("load");
		this.pushValue(scriptId ?? SNIPPET_ID);
		this.pushValue(code);

		if (lua.lua_pcall(L, 2, 2, 0) !== lua.LUA_OK) {
			return fail();
		}

		if (lua.lua_isnil(L, -2)) {
			return fail(); // a syntax error: load's second result
		}

		lua.lua_pop(L, 1);

		if (lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0) !== lua.LUA_OK) {
			return fail();
		}

		const nres = lua.lua_gettop(L);
		const results: string[] = [];

		for (let i = 1; i <= nres; i++) {
			results.push(this.displayText(i));
		}

		lua.lua_settop(L, 0);

		return {
			success: true,
			result: results.length > 0 ? results.join("  ") : undefined,
		};
	}

	/** Call one of the internals; its first result, or undefined when it failed. */
	private call(name: string, args: unknown[]): unknown {
		const {lua} = this.fengari;
		const top = lua.lua_gettop(this.L);
		this.resetInstructions();
		this.pushInternal(name);

		for (const arg of args) {
			this.pushValue(arg);
		}

		const status = lua.lua_pcall(this.L, args.length, 1, 0);
		const result = status === lua.LUA_OK ? this.toJsValue(-1) : undefined;
		lua.lua_settop(this.L, top);
		return result;
	}

	/** Compile `code` without running it: undefined when it is valid, else the syntax error. */
	public check(code: string): string | undefined {
		const res = this.call("check", [code]);
		return res === true ? undefined : String(res ?? "Lua error");
	}

	public dispatch(event: string, payload: unknown): void {
		this.call("dispatch", [event, payload]);
	}

	public runCommand(name: string, args: string[], rest: string): boolean {
		return this.call("run", [name, args, rest]) === true;
	}

	public hasCommand(name: string): boolean {
		return this.call("has", [name]) === true;
	}

	public getRegisteredCommandNames(): string[] {
		const res = this.call("names", []);
		return res && typeof res === "object" ? Object.values(res as Record<string, string>) : [];
	}

	public close(): void {
		if (this.L) {
			this.fengari.lua.lua_close(this.L);
			this.L = null;
		}
	}
}
