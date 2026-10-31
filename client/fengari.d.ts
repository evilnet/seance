declare module "fengari" {
	export const FENGARI_VERSION: string;
	export const FENGARI_VERSION_MAJOR: string;
	export const FENGARI_VERSION_MINOR: string;
	export const FENGARI_VERSION_NUM: number;
	export const FENGARI_VERSION_RELEASE: string;

	export function to_luastring(str: string): Uint8Array;
	export function to_jsstring(bytes: Uint8Array | number[]): string;

	export namespace lua {
		export const LUA_OK: number;
		export const LUA_YIELD: number;
		export const LUA_ERRRUN: number;
		export const LUA_ERRSYNTAX: number;
		export const LUA_ERRMEM: number;
		export const LUA_ERRGCMM: number;
		export const LUA_ERRERR: number;

		export const LUA_MULTRET: number;
		export const LUA_REGISTRYINDEX: number;

		export const LUA_TNONE: number;
		export const LUA_TNIL: number;
		export const LUA_TBOOLEAN: number;
		export const LUA_TLIGHTUSERDATA: number;
		export const LUA_TNUMBER: number;
		export const LUA_TSTRING: number;
		export const LUA_TTABLE: number;
		export const LUA_TFUNCTION: number;
		export const LUA_TUSERDATA: number;
		export const LUA_TTHREAD: number;

		export const LUA_MASKCOUNT: number;
		export const LUA_MASKLINE: number;
		export const LUA_MASKCALL: number;
		export const LUA_MASKRET: number;

		export function lua_close(L: any): void;
		export function lua_atnativeerror(L: any, errorf: (L: any) => number): void;
		export function lua_touserdata(L: any, idx: number): unknown;
		export function lua_sethook(
			L: any,
			func: ((L: any, ar: any) => void) | null,
			mask: number,
			count: number
		): void;
		export function lua_gethookcount(L: any): number;
		export function lua_gettop(L: any): number;
		export function lua_settop(L: any, idx: number): void;
		export function lua_pushvalue(L: any, idx: number): void;
		export function lua_rotate(L: any, idx: number, n: number): void;
		export function lua_copy(L: any, fromidx: number, toidx: number): void;
		export function lua_checkstack(L: any, n: number): boolean;

		export function lua_isnumber(L: any, idx: number): boolean;
		export function lua_isstring(L: any, idx: number): boolean;
		export function lua_iscfunction(L: any, idx: number): boolean;
		export function lua_isinteger(L: any, idx: number): boolean;
		export function lua_isuserdata(L: any, idx: number): boolean;
		export function lua_istable(L: any, idx: number): boolean;
		export function lua_isnil(L: any, idx: number): boolean;
		export function lua_isnoneornil(L: any, idx: number): boolean;
		export function lua_isfunction(L: any, idx: number): boolean;
		export function lua_isboolean(L: any, idx: number): boolean;
		export function lua_type(L: any, idx: number): number;
		export function lua_typename(L: any, tp: number): Uint8Array;
		export function lua_next(L: any, idx: number): number;
		export function lua_setmetatable(L: any, idx: number): number;
		export function lua_getmetatable(L: any, idx: number): number;

		export function lua_tonumber(L: any, idx: number): number;
		export function lua_tointeger(L: any, idx: number): number;
		export function lua_toboolean(L: any, idx: number): boolean;
		export function lua_tolstring(L: any, idx: number, len?: any): Uint8Array;
		export function lua_tostring(L: any, idx: number): Uint8Array;
		export function lua_tocfunction(L: any, idx: number): ((state: any) => number) | null;

		export function lua_pushnil(L: any): void;
		export function lua_pushnumber(L: any, n: number): void;
		export function lua_pushinteger(L: any, n: number): void;
		export function lua_pushlstring(L: any, s: Uint8Array | string, len?: number): Uint8Array;
		export function lua_pushstring(L: any, s: Uint8Array | string): Uint8Array;
		export function lua_pushcclosure(L: any, fn: (L: any) => number, n: number): void;
		export function lua_pushcfunction(L: any, fn: (L: any) => number): void;
		export function lua_pushboolean(L: any, b: boolean): void;
		export function lua_pushlightuserdata(L: any, p: any): void;

		export function lua_getglobal(L: any, name: Uint8Array | string): number;
		export function lua_gettable(L: any, idx: number): number;
		export function lua_getfield(L: any, idx: number, k: Uint8Array | string): number;
		export function lua_geti(L: any, idx: number, i: number): number;
		export function lua_rawget(L: any, idx: number): number;
		export function lua_rawgeti(L: any, idx: number, n: number): number;
		export function lua_createtable(L: any, narr: number, nrec: number): void;
		export function lua_newtable(L: any): void;

		export function lua_setglobal(L: any, name: Uint8Array | string): void;
		export function lua_settable(L: any, idx: number): void;
		export function lua_setfield(L: any, idx: number, k: Uint8Array | string): void;
		export function lua_seti(L: any, idx: number, i: number): void;
		export function lua_rawset(L: any, idx: number): void;
		export function lua_rawseti(L: any, idx: number, n: number): void;

		export function lua_pcall(L: any, nargs: number, nresults: number, msgh: number): number;
		export function lua_error(L: any): number;
		export function lua_pop(L: any, n: number): void;
		export function lua_remove(L: any, idx: number): void;
	}

	export namespace lauxlib {
		export function luaL_newstate(): any;
		export function luaL_dostring(L: any, s: Uint8Array | string): number;
		export function luaL_loadstring(L: any, s: Uint8Array | string): number;
		export function luaL_tolstring(L: any, idx: number, len?: any): Uint8Array;
		export function luaL_error(L: any, fmt: Uint8Array | string, ...args: any[]): number;
		export function luaL_requiref(
			L: any,
			modname: Uint8Array | string,
			openf: (L: any) => number,
			glb: number
		): void;
		export function luaL_ref(L: any, t: number): number;
	}

	export namespace lualib {
		export function luaL_openlibs(L: any): void;

		export const LUA_COLIBNAME: string;
		export const LUA_TABLIBNAME: string;
		export const LUA_STRLIBNAME: string;
		export const LUA_MATHLIBNAME: string;
		export const LUA_UTF8LIBNAME: string;

		export function luaopen_base(L: any): number;
		export function luaopen_coroutine(L: any): number;
		export function luaopen_table(L: any): number;
		export function luaopen_string(L: any): number;
		export function luaopen_math(L: any): number;
		export function luaopen_utf8(L: any): number;
	}
}
