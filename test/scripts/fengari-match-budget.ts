import {expect} from "chai";
import fs from "fs";
import Module from "module";
import path from "path";
import * as fengari from "fengari";

// The loader webpack applies to fengari/src/lstrlib.js (scripts/), run here
// on the installed Fengari: mocha loads Fengari unpatched, so the patched
// string library is compiled beside it and opened into a state of its own.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const budget = require("../../scripts/fengari-match-budget.js") as {
	patch(source: string): string;
	MAX_STEPS: number;
	ERROR: string;
};

const LSTRLIB = require.resolve("fengari/src/lstrlib.js");

function patchedStringLib(): (L: any) => number {
	const source = budget.patch(fs.readFileSync(LSTRLIB, "utf8"));
	const mod = new Module(LSTRLIB, module) as Module & {
		_compile(code: string, filename: string): void;
	};
	mod.filename = LSTRLIB;
	mod.paths = (Module as any)._nodeModulePaths(path.dirname(LSTRLIB));
	mod._compile(source, LSTRLIB);
	return (mod.exports as {luaopen_string: (L: any) => number}).luaopen_string;
}

/** Run `code` in a state with the patched string library: [ok, first result]. */
function run(code: string): [boolean, string] {
	const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
	const L = lauxlib.luaL_newstate();

	try {
		lauxlib.luaL_requiref(L, to_luastring("_G"), lualib.luaopen_base, 1);
		lauxlib.luaL_requiref(L, to_luastring("string"), patchedStringLib(), 1);
		lua.lua_settop(L, 0);
		lauxlib.luaL_loadstring(L, to_luastring(code));
		const ok = lua.lua_pcall(L, 0, 1, 0) === lua.LUA_OK;
		return [ok, to_jsstring(lauxlib.luaL_tolstring(L, -1))];
	} finally {
		lua.lua_close(L);
	}
}

describe("Lua pattern step budget (scripts/fengari-match-budget.js)", function () {
	it("patches the installed lstrlib.js, each anchor exactly once", function () {
		const source = budget.patch(fs.readFileSync(LSTRLIB, "utf8"));
		expect(source).to.include(`const MAXSTEPS       = ${budget.MAX_STEPS};`);
		expect(source).to.include(budget.ERROR);
	});

	it("fails loudly when Fengari's source no longer matches", function () {
		expect(() => budget.patch("const nothing = 1;")).to.throw(/Fengari changed/);
	});

	it("stops a backtracking pattern quickly instead of hanging", function () {
		this.timeout(10000);
		const started = Date.now();
		const [ok, result] = run(`return string.find(string.rep("a", 100000), ".-.-.-.-b")`);
		expect(ok).to.be.false;
		expect(result).to.include(budget.ERROR);
		expect(Date.now() - started).to.be.lessThan(3000);
	});

	it("leaves ordinary matching alone", function () {
		expect(run(`return (string.gsub("hello world", "o", "0"))`)).to.deep.equal([
			true,
			"hell0 w0rld",
		]);
		expect(run(`return string.match("!ping_chan_c42", "^!ping_chan_(%w+)")`)).to.deep.equal([
			true,
			"c42",
		]);
		// A gmatch loop over a long text is charged per step, not as one call.
		expect(
			run(
				`local n = 0; for w in string.gmatch(string.rep("ab ", 100000), "%a+") do n = n + 1 end; return n`
			)
		).to.deep.equal([true, "100000"]);
	});
});
