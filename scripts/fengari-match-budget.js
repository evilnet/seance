"use strict";

// A webpack loader for fengari/src/lstrlib.js: puts a step budget on Lua's
// pattern matcher. Fengari's `match` counts only its recursion depth
// (MAXCCALLS), and a whole string.find/match/gmatch/gsub is one native call
// the sandbox's instruction hook cannot interrupt, so a backtracking pattern
// (`string.find(("a"):rep(1e5), ".-.-.-.-b")`) held the tab for good
// (Josephur/seance#23). Every attempted position is a call to `match`, and
// the forward scans in max_expand are paid back by one counted call per
// position they backtrack over, so counting the calls bounds the work.
//
// Each patch must find its anchor exactly once: a Fengari upgrade that moves
// the code fails the build instead of shipping an unbounded matcher.

/** Calls to `match` one string.find/match/gsub (or one gmatch step) may make. */
const MAX_STEPS = 200000;
const ERROR = "pattern too complex (step limit)";

const PATCHES = [
	[
		"const MAXCCALLS      = 200;\n",
		`const MAXCCALLS      = 200;\nconst MAXSTEPS       = ${MAX_STEPS};\n`,
	],
	[
		"        this.matchdepth = NaN;  /* control for recursive depth */\n",
		"        this.matchdepth = NaN;  /* control for recursive depth */\n        this.steps = 0;\n",
	],
	[
		'    if (ms.matchdepth-- === 0)\n        luaL_error(ms.L, to_luastring("pattern too complex"));\n',
		'    if (ms.matchdepth-- === 0)\n        luaL_error(ms.L, to_luastring("pattern too complex"));\n' +
			`    if (++ms.steps > MAXSTEPS)\n        luaL_error(ms.L, to_luastring("${ERROR}"));\n`,
	],
	[
		"    ms.matchdepth = MAXCCALLS;\n    ms.src = s;\n",
		"    ms.matchdepth = MAXCCALLS;\n    ms.steps = 0;\n    ms.src = s;\n",
	],
	[
		"    gm.ms.L = L;\n    for (let src = gm.src;",
		"    gm.ms.L = L;\n    gm.ms.steps = 0;\n    for (let src = gm.src;",
	],
];

function patch(source) {
	for (const [from, to] of PATCHES) {
		const at = source.indexOf(from);

		if (at === -1 || source.indexOf(from, at + 1) !== -1) {
			throw new Error(
				`fengari-match-budget: expected exactly one ${JSON.stringify(
					from.split("\n")[0].trim()
				)} in fengari/src/lstrlib.js; Fengari changed, update scripts/fengari-match-budget.js`
			);
		}

		source = source.slice(0, at) + to + source.slice(at + from.length);
	}

	return source;
}

module.exports = function (source) {
	return patch(source);
};

module.exports.patch = patch;
module.exports.MAX_STEPS = MAX_STEPS;
module.exports.ERROR = ERROR;
