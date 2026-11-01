import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {
	loadScripts,
	saveScripts,
	saveScript,
	ScriptStorageError,
	MAX_CODE_LENGTH,
	MAX_DATA_LENGTH,
	MAX_LIBRARY_LENGTH,
	MAX_TOTAL_DATA_LENGTH,
	deleteScript,
	isValidScriptName,
	loadScriptData,
	saveScriptData,
	useStorageBackend,
	STORAGE_KEY,
	STORAGE_PREFIX,
	compareScripts,
	DEFAULT_FOLDER,
	normalizeFolder,
	scriptFolders,
} from "../../client/js/irc/scripting/storage";
import {
	LuaSandbox,
	MAX_COMMANDS,
	MAX_HANDLERS,
	MAX_REP_LENGTH,
	type SandboxHost,
} from "../../client/js/irc/scripting/engine";
import type {Script, ScriptMessageEvent} from "../../client/js/irc/scripting/types";
import {
	scriptManager,
	setContextProvider,
	MAX_QUEUED_LINES,
	scriptingDisabledError,
} from "../../client/js/irc/scripting/manager";
import {IRCU_FAKE_LAG} from "../../client/js/irc/fakelag";
import {register, setup} from "./support";
import {isScriptingEnabled, setScriptingEnabled} from "../../client/js/irc/scripting/enabled";
import {
	importedScriptName,
	scriptNameError,
	scriptTemplate,
	uniqueScriptName,
} from "../../client/js/irc/scripting/library";

describe("Lua scripting subsystem", function () {
	describe("storage (irc/scripting/storage.ts)", function () {
		let store: Map<string, string>;

		beforeEach(function () {
			store = new Map<string, string>();
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				set: (k, v) => void store.set(k, v),
				remove: (k) => void store.delete(k),
				keys: () => [...store.keys()],
			});
		});

		afterEach(function () {
			useStorageBackend(null);
		});

		it("validates script names", function () {
			expect(isValidScriptName("hello")).to.be.true;
			expect(isValidScriptName("auto_ping")).to.be.true;
			expect(isValidScriptName("my-script-1")).to.be.true;
			expect(isValidScriptName("")).to.be.false;
			expect(isValidScriptName("hello world")).to.be.false;
			expect(isValidScriptName("a".repeat(33))).to.be.false;
			expect(isValidScriptName("$invalid")).to.be.false;
		});

		it("loads and saves script definitions", function () {
			expect(loadScripts()).to.deep.equal([]);

			const script: Script = {
				id: "s1",
				name: "test_script",
				code: "print('hello')",
				enabled: true,
				folder: "Automation",
				description: "Says hello",
			};
			saveScripts([script]);

			const loaded = loadScripts();
			expect(loaded).to.have.lengthOf(1);
			expect(loaded[0].id).to.equal("s1");
			expect(loaded[0].name).to.equal("test_script");
			expect(loaded[0].code).to.equal("print('hello')");
			expect(loaded[0].enabled).to.be.true;
		});

		it("deletes script and associated data", function () {
			const script: Script = {
				id: "del_me",
				name: "to_delete",
				code: "seance.print('hi')",
				enabled: false,
				folder: DEFAULT_FOLDER,
			};
			saveScripts([script]);
			saveScriptData("del_me", {testKey: "testVal"});

			expect(loadScriptData("del_me")).to.deep.equal({testKey: "testVal"});
			deleteScript("del_me");

			expect(loadScripts()).to.have.lengthOf(0);
			expect(loadScriptData("del_me")).to.deep.equal({});
		});

		it("normalizes folders and descriptions", function () {
			expect(normalizeFolder("  My  Scripts ")).to.equal("My Scripts");
			expect(normalizeFolder("")).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder("a/b")).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder("x".repeat(41))).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder(undefined)).to.equal(DEFAULT_FOLDER);
		});

		it("files legacy scripts without a folder under Unsorted", function () {
			store.set(
				STORAGE_KEY,
				JSON.stringify([
					{id: "old", name: "legacy", code: "return 1", enabled: true},
					{
						id: "new",
						name: "filed",
						code: "return 2",
						enabled: false,
						folder: "Commands",
						description: "  Adds  a command ",
					},
				])
			);
			const loaded = loadScripts();
			expect(loaded[0].folder).to.equal(DEFAULT_FOLDER);
			expect(loaded[0].description).to.equal(undefined);
			expect(loaded[1].folder).to.equal("Commands");
			expect(loaded[1].description).to.equal("Adds a command");
		});

		it("lists folders once, Unsorted last, and orders the library by folder then name", function () {
			const mk = (name: string, folder: string): Script => ({
				id: name,
				name,
				folder,
				code: "",
				enabled: true,
			});
			const list = [
				mk("b", "commands"),
				mk("a", "Commands"),
				mk("z", DEFAULT_FOLDER),
				mk("c", "Automation"),
			];
			// First-seen spelling wins for a folder that differs only by case.
			expect(scriptFolders(list)).to.deep.equal(["Automation", "commands", DEFAULT_FOLDER]);
			expect([...list].sort(compareScripts).map((s) => s.name)).to.deep.equal([
				"c",
				"a",
				"b",
				"z",
			]);
		});

		it("refuses a script over the size limit and keeps what was stored", function () {
			const ok: Script = {id: "a", name: "a", folder: "Unsorted", code: "x", enabled: true};
			saveScripts([ok]);
			const long = {...ok, code: "x".repeat(MAX_CODE_LENGTH + 1)};
			expect(() => saveScripts([long])).to.throw(
				ScriptStorageError,
				/over 16,000 characters/
			);
			expect(loadScripts()[0].code).to.equal("x");
		});

		it("refuses a library over the total limit", function () {
			const code = "x".repeat(MAX_CODE_LENGTH);
			const list: Script[] = [];

			for (let i = 0; list.length * MAX_CODE_LENGTH <= MAX_LIBRARY_LENGTH; i++) {
				list.push({id: `s${i}`, name: `s${i}`, folder: "Unsorted", code, enabled: true});
			}

			expect(() => saveScripts(list)).to.throw(ScriptStorageError, /together/);
			expect(store.has(STORAGE_KEY)).to.be.false;
		});

		it("still loads a script saved under the old, larger limit", function () {
			const code = "x".repeat(MAX_CODE_LENGTH + 100);
			store.set(STORAGE_KEY, JSON.stringify([{id: "old", name: "old", code, enabled: true}]));
			expect(loadScripts()).to.have.lengthOf(1);
		});

		it("reports a write the browser's storage did not keep", function () {
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				// localStorage's wrapper swallows a full quota like this
				set() {},
				remove: (k) => void store.delete(k),
				keys: () => [...store.keys()],
			});
			const script: Script = {
				id: "a",
				name: "a",
				folder: "Unsorted",
				code: "x",
				enabled: true,
			};
			expect(() => saveScript(script)).to.throw(ScriptStorageError, /room/);
			expect(() => saveScriptData("a", {k: "v"})).to.throw(ScriptStorageError, /room/);
		});

		it("caps each script's data and all of it together", function () {
			expect(() => saveScriptData("a", {k: "x".repeat(MAX_DATA_LENGTH)})).to.throw(
				ScriptStorageError,
				/for this script/
			);
			expect(store.has(`${STORAGE_PREFIX}a`)).to.be.false;

			const chunk = "x".repeat(MAX_DATA_LENGTH - 100);
			let n = 0;

			while ((n + 1) * MAX_DATA_LENGTH <= MAX_TOTAL_DATA_LENGTH) {
				saveScriptData(`s${n++}`, {k: chunk});
			}

			expect(() => saveScriptData(`s${n}`, {k: chunk})).to.throw(
				ScriptStorageError,
				/all scripts together/
			);
			// Rewriting a bucket counts it once, not twice.
			saveScriptData("s0", {k: chunk});
		});
	});

	describe("the Scripts tab's helpers (irc/scripting/library.ts)", function () {
		const named = (...names: string[]): Script[] =>
			names.map((name, i) => ({id: `s${i}`, name, code: "", enabled: true, folder: "X"}));

		it("numbers a name that is taken, case-insensitively, within the length limit", function () {
			expect(uniqueScriptName(named(), "auto_ping")).to.equal("auto_ping");
			expect(uniqueScriptName(named("Auto_Ping"), "auto_ping")).to.equal("auto_ping_2");
			expect(uniqueScriptName(named("auto_ping", "auto_ping_2"), "auto_ping")).to.equal(
				"auto_ping_3"
			);

			const long = "a".repeat(32);
			const next = uniqueScriptName(named(long), long);
			expect(next).to.equal(`${"a".repeat(30)}_2`);
			expect(isValidScriptName(next)).to.be.true;
		});

		it("makes a valid script name out of an imported file's name", function () {
			expect(importedScriptName("My Bot.lua")).to.equal("my_bot");
			expect(importedScriptName("__x.LUA")).to.equal("x");
			expect(importedScriptName("ü.lua")).to.equal("imported_script");
			expect(isValidScriptName(importedScriptName(`${"b".repeat(50)}.lua`))).to.be.true;
		});

		it("refuses a name the library would drop when it next loads", function () {
			const scripts = named("pinger", "other");

			expect(scriptNameError(scripts, "pinger", "s0")).to.equal(null);
			expect(scriptNameError(scripts, "pinger2", "s0")).to.equal(null);
			expect(scriptNameError(scripts, "", "s0")).to.match(/needs a name/);
			expect(scriptNameError(scripts, "two words", "s0")).to.match(/Letters, digits/);
			expect(scriptNameError(scripts, "a".repeat(33), "s0")).to.match(/at most 32/);
			expect(scriptNameError(scripts, "OTHER", "s0")).to.match(/already called/);
		});

		it("files the examples under their folders and keeps their names unique", function () {
			const responder = scriptTemplate("responder", []);
			expect(responder.folder).to.equal("Automation");
			expect(responder.name).to.equal("auto_ping");
			expect(scriptTemplate("responder", [responder]).name).to.equal("auto_ping_2");
			expect(scriptTemplate("slap", []).folder).to.equal("Commands");
		});
	});

	describe("sandbox engine (irc/scripting/engine.ts)", function () {
		let sentLines: {line: string; net?: string}[] = [];
		let repliedLines: {msg: ScriptMessageEvent; text: string}[] = [];
		let printedLines: string[] = [];
		let errors: string[] = [];
		let sandbox: LuaSandbox;

		const mockHost: SandboxHost = {
			send(line, net) {
				sentLines.push({line, net});
			},
			reply(msg, text) {
				repliedLines.push({msg, text});
			},
			print(text) {
				printedLines.push(text);
			},
			getCurrentContext() {
				return {
					channel: "#seance",
					network: "SeanceDev",
					nick: "tester",
				};
			},
			onError(err) {
				errors.push(err);
			},
		};

		let mockStore: Map<string, string>;

		beforeEach(async function () {
			sentLines = [];
			repliedLines = [];
			printedLines = [];
			errors = [];
			mockStore = new Map<string, string>();
			useStorageBackend({
				get: (k) => mockStore.get(k) ?? null,
				set: (k, v) => void mockStore.set(k, v),
				remove: (k) => void mockStore.delete(k),
				keys: () => [...mockStore.keys()],
			});
			sandbox = await LuaSandbox.create(mockHost);
		});

		afterEach(function () {
			useStorageBackend(null);
			sandbox.close();
		});

		it("evaluates basic Lua code and returns results", function () {
			const res = sandbox.eval("return 40 + 2");
			expect(res.success).to.be.true;
			expect(res.result).to.equal("42");
		});

		it("catches syntax errors", function () {
			const res = sandbox.eval("function unclosed(");
			expect(res.success).to.be.false;
			expect(res.error).to.be.a("string");
		});

		it("opens no io, os, package or debug library, not even through require", function () {
			const res = sandbox.eval(`
				assert(io == nil and os == nil and package == nil and debug == nil)
				assert(require == nil and dofile == nil and loadfile == nil)
				assert(string.dump == nil)
				return "secure"
			`);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("secure");
		});

		it("loads source text only, never bytecode", function () {
			const res = sandbox.eval(`
				local fn, err = load("\\27Lua")
				assert(fn == nil and err:find("binary"), err)
				return load("return 1 + 1")(), load("return x", "c", "t", {x = 5})()
			`);
			expect(res.success, res.error).to.be.true;
			expect(res.result).to.equal("2  5");
		});

		it("caps what string.rep may build", function () {
			const res = sandbox.eval(`return pcall(string.rep, "x", ${MAX_REP_LENGTH + 1})`);
			expect(res.result).to.include("false").and.include("too large");
			// A numeric string is a count too.
			const str = sandbox.eval(`return pcall(string.rep, "x", "${MAX_REP_LENGTH + 1}")`);
			expect(str.result).to.include("false").and.include("too large");
			expect(sandbox.eval(`return #("ab"):rep(3, ",")`).result).to.equal("8");
		});

		it("aborts infinite loops with instruction count hook", function () {
			this.timeout(5000);
			const res = sandbox.eval("while true do end");
			expect(res.success).to.be.false;
			expect(res.error).to.include("Instruction limit exceeded");
		});

		it("counts coroutines and does not let pcall catch the limit and go round again", function () {
			this.timeout(5000);

			for (const code of [
				"return coroutine.resume(coroutine.create(function() while true do end end))",
				"return pcall(coroutine.wrap(function() while true do end end))",
				"while true do pcall(function() while true do end end) end",
			]) {
				const res = sandbox.eval(code);
				expect(res.success, code).to.be.false;
				expect(res.error).to.include("Instruction limit exceeded");
			}

			// The next call starts with a fresh budget.
			expect(sandbox.eval("return 1").result).to.equal("1");
		});

		it("keeps seance read-only and the dispatch internals out of reach", function () {
			const res = sandbox.eval(`
				local ok, err = pcall(function() seance.send = nil end)
				assert(not ok and err:find("read%-only"), err)
				assert(getmetatable(seance) == false)
				assert(_SEANCE_HANDLERS == nil and _SEANCE_DISPATCH == nil and _SEANCE_ERROR == nil)
				return "ok"
			`);
			expect(res.success, res.error).to.be.true;
		});

		it("keeps one handler's spent budget from stopping the others", function () {
			this.timeout(5000);
			const owners: (string | undefined)[] = [];
			sandbox.close();

			return LuaSandbox.create({
				...mockHost,
				onError: (_e: string, id?: string) => void owners.push(id),
			}).then((sb) => {
				sandbox = sb;
				sb.eval(`seance.on("message", function() while true do end end)`, "A");
				sb.eval(
					`seance.on("message", function() seance.storage.set("ran", "yes") end)`,
					"B"
				);
				sb.eval(`seance.register_command("spin", function() while true do end end)`, "C");
				sb.dispatch("message", {});
				expect(loadScriptData("B")).to.deep.equal({ran: "yes"});
				expect(sb.runCommand("spin", [], "")).to.be.true;
				expect(owners).to.deep.equal(["A", "C"]);
			});
		});

		it("caps what one event may run, and runs only the handlers it started with", function () {
			this.timeout(5000);
			sandbox.eval(
				`for i = 1, ${MAX_HANDLERS} do seance.on("message", function() while true do end end) end`,
				"loop"
			);
			const started = Date.now();
			sandbox.dispatch("message", {});
			expect(Date.now() - started).to.be.lessThan(2000);
			expect(errors[errors.length - 1]).to.include("ran out of instructions");

			const res = sandbox.eval(
				`local function f() seance.on("grow", f) end; seance.on("grow", f)`,
				"grow"
			);
			expect(res.success, res.error).to.be.true;
			sandbox.dispatch("grow", {}); // returns: the handler added mid-dispatch waits
			sandbox.dispatch("grow", {});
		});

		it("caps handlers per event and command names", function () {
			const on = sandbox.eval(`for i = 1, ${MAX_HANDLERS + 1} do seance.on("x", print) end`);
			expect(on.error).to.include("too many x handlers");
			const cmds = sandbox.eval(
				`for i = 1, ${MAX_COMMANDS + 1} do seance.register_command("c" .. i, print) end`
			);
			expect(cmds.error).to.include("too many commands");
			// Re-registering a name it already has is not one more.
			expect(sandbox.eval(`seance.register_command("c1", print)`).success).to.be.true;
		});

		it("gives each script read-only views of the standard library", function () {
			const res = sandbox.eval(
				`
				assert(not pcall(function() string.rep = nil end))
				assert(getmetatable("") == false)
				local p = pcall
				_G.pcall = function(...) return p(...) end
				rawset(string, "upper", function() return "evil" end)
				return load("return _G == _ENV")()
			`,
				"A"
			);
			expect(res.result, res.error).to.equal("true");
			const other = sandbox.eval(`return string.upper("a"), pcall == _G.pcall`, "B");
			expect(other.result).to.equal("A  true");
			expect(sandbox.eval(`return table.concat({"a", "b"}, ",")`, "B").result).to.equal(
				"a,b"
			);
		});

		it("hands every handler its own copy of the event", function () {
			sandbox.eval(`seance.on("message", function(m) m.target = "#elsewhere" end)`, "A");
			sandbox.eval(`seance.on("message", function(m) seance.reply(m, "hi") end)`, "B");
			sandbox.dispatch("message", {target: "#c", networkUuid: "u", from: "bob"});
			expect(repliedLines[0].msg.target).to.equal("#c");
		});

		it("names a returned table instead of walking it, and walks none in a reply", function () {
			const res = sandbox.eval(
				`local t = {target = "#x"}; for i = 1, 20 do t[i] = t end; seance.reply(t, "x"); return t, nil`
			);
			expect(res.result).to.equal("[lua table]  nil");
			expect(repliedLines[0].msg.target).to.equal("#x");
		});

		it("gives each script its own globals", function () {
			sandbox.eval("x = 1", "one");
			expect(sandbox.eval("return tostring(x)", "two").result).to.equal("nil");
			expect(sandbox.eval("return x", "one").result).to.equal("1");
		});

		it("credits storage and errors to the script whose handler ran", function () {
			const owners: (string | undefined)[] = [];
			const host = {...mockHost, onError: (_e: string, id?: string) => void owners.push(id)};
			sandbox.close();

			return LuaSandbox.create(host).then((sb) => {
				sandbox = sb;
				sb.eval(`seance.on("message", function() seance.storage.set("k", "A") end)`, "A");
				sb.eval(
					`seance.on("message", function() seance.storage.set("k", "B"); error("boom") end)`,
					"B"
				);
				sb.eval(`seance.register_command("c", function() error("cmd") end)`, "C");
				sb.dispatch("message", {text: "hi"});
				sb.runCommand("c", [], "");
				expect(loadScriptData("A")).to.deep.equal({k: "A"});
				expect(loadScriptData("B")).to.deep.equal({k: "B"});
				expect(owners).to.deep.equal(["B", "C"]);
			});
		});

		it("raises seance.storage's limit as a Lua error", function () {
			const res = sandbox.eval(
				`seance.storage.set("k", string.rep("x", ${MAX_DATA_LENGTH}))`,
				"big"
			);
			expect(res.success).to.be.false;
			expect(res.error).to.include("seance.storage:").and.include("for this script");
		});

		it("survives an error object whose __tostring loops or fails", function () {
			this.timeout(5000);

			for (const body of ["while true do end", 'error("x")', "return {}"]) {
				const res = sandbox.eval(
					`error(setmetatable({}, {__tostring = function() ${body} end}))`
				);
				expect(res.error).to.equal("(error object is a table value)");
			}

			sandbox.eval(
				`seance.on("message", function() error(setmetatable({}, {__tostring = function() error("x") end})) end)`,
				"a"
			);
			sandbox.eval(
				`seance.on("message", function() seance.storage.set("ran", "yes") end)`,
				"b"
			);
			sandbox.dispatch("message", {});
			expect(errors).to.deep.equal([
				"Error in message handler: (error object is a table value)",
			]);
			expect(loadScriptData("b")).to.deep.equal({ran: "yes"});
			expect(sandbox.eval("return 1 + 1").result).to.equal("2");
		});

		it("turns a JavaScript exception in a host function into a Lua error", async function () {
			sandbox.close();
			sandbox = await LuaSandbox.create({
				...mockHost,
				print() {
					throw new TypeError("boom");
				},
			});
			const res = sandbox.eval(`return pcall(seance.print, "x")`);
			expect(res.result).to.equal("false  internal error: boom");
			expect(sandbox.eval("return 1 + 1").result).to.equal("2");
		});

		it("checks syntax without running anything", function () {
			expect(sandbox.check(`seance.print("ran")`)).to.be.undefined;
			expect(printedLines).to.deep.equal([]);
			expect(sandbox.check("function (")).to.be.a("string");
		});

		it("reads only strings back from storage", function () {
			mockStore.set(`${STORAGE_PREFIX}mixed`, JSON.stringify({n: 5, o: {}, s: "ok"}));
			expect(loadScriptData("mixed")).to.deep.equal({s: "ok"});
		});

		it("survives a table that contains itself", function () {
			const res = sandbox.eval(
				`local t = {target = "#c"}; t.self = t; seance.reply(t, "hi")`
			);
			expect(res.success, res.error).to.be.true;
			expect(repliedLines).to.have.lengthOf(1);
		});

		it("supports seance.on('message') event handlers", function () {
			const code = `
				seance.on("message", function(msg)
					if msg.text == "!ping" then
						seance.reply(msg, "pong " .. msg.from)
					end
				end)
			`;
			const res = sandbox.eval(code);
			expect(res.success).to.be.true;

			const event: ScriptMessageEvent = {
				network: "SeanceDev",
				target: "#seance",
				from: "alice",
				text: "!ping",
				type: "message",
				self: false,
			};

			sandbox.dispatch("message", event);
			expect(repliedLines).to.have.lengthOf(1);
			expect(repliedLines[0].text).to.equal("pong alice");
			expect(repliedLines[0].msg.target).to.equal("#seance");
			expect(repliedLines[0].msg.from).to.equal("alice");
		});

		it("supports registering and running custom slash commands", function () {
			const code = `
				seance.register_command("wave", function(args, rest)
					seance.send("PRIVMSG " .. seance.current_channel .. " :*waves at " .. rest .. "*")
				end)
			`;
			const res = sandbox.eval(code);
			expect(res.success).to.be.true;

			expect(sandbox.hasCommand("wave")).to.be.true;
			expect(sandbox.hasCommand("unknown")).to.be.false;

			const handled = sandbox.runCommand("wave", ["bob"], "bob");
			expect(handled).to.be.true;
			expect(sentLines).to.have.lengthOf(1);
			expect(sentLines[0].line).to.equal("PRIVMSG #seance :*waves at bob*");
		});

		it("provides read-only context properties", function () {
			const res = sandbox.eval(`
				return seance.current_channel .. " on " .. seance.current_network .. " as " .. seance.nick
			`);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("#seance on SeanceDev as tester");
		});

		it("provides persistent key-value storage per script", function () {
			const res = sandbox.eval(
				`
				seance.storage.set("counter", "10")
				return seance.storage.get("counter")
			`,
				"script_123"
			);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("10");

			// Clear key
			const res2 = sandbox.eval(
				`
				seance.storage.set("counter", nil)
				return tostring(seance.storage.get("counter"))
			`,
				"script_123"
			);
			expect(res2.success).to.be.true;
			expect(res2.result).to.equal("nil");
		});

		it("persists storage across sandbox reloads and isolates scripts", async function () {
			sandbox.eval(`seance.storage.set("shared_key", "value_for_s1")`, "script_1");
			sandbox.eval(`seance.storage.set("shared_key", "value_for_s2")`, "script_2");

			// Values are isolated per script
			const r1 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_1");
			const r2 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_2");
			expect(r1.result).to.equal("value_for_s1");
			expect(r2.result).to.equal("value_for_s2");

			// Close sandbox and re-open to simulate page reload / client restart
			sandbox.close();
			sandbox = await LuaSandbox.create(mockHost);

			const rReload1 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_1");
			const rReload2 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_2");
			expect(rReload1.result).to.equal("value_for_s1");
			expect(rReload2.result).to.equal("value_for_s2");
		});

		it("supports join, part, quit, kick, nick, topic, mode, and send events", function () {
			const events: Record<string, any> = {};

			sandbox.eval(
				`
				seance.on("join", function(d) seance.storage.set("join_nick", d.nick) end)
				seance.on("part", function(d) seance.storage.set("part_nick", d.nick) end)
				seance.on("quit", function(d) seance.storage.set("quit_nick", d.nick) end)
				seance.on("kick", function(d) seance.storage.set("kick_kicked", d.kicked) end)
				seance.on("nick", function(d) seance.storage.set("nick_new", d.newNick) end)
				seance.on("topic", function(d) seance.storage.set("topic_val", d.topic) end)
				seance.on("mode", function(d) seance.storage.set("mode_val", d.mode) end)
				seance.on("send", function(d) seance.storage.set("send_line", d.line) end)
			`,
				"events_script"
			);

			sandbox.dispatch("join", {
				nick: "alice",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("part", {
				nick: "bob",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("quit", {nick: "charlie", network: "test"});
			sandbox.dispatch("kick", {
				nick: "op",
				kicked: "dave",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("nick", {
				oldNick: "eve",
				newNick: "eve2",
				network: "test",
				self: false,
			});
			sandbox.dispatch("topic", {
				channel: "#seance",
				topic: "New Topic",
				nick: "alice",
				network: "test",
			});
			sandbox.dispatch("mode", {
				target: "#seance",
				mode: "+o",
				params: ["alice"],
				from: "op",
				network: "test",
			});
			sandbox.dispatch("send", {line: "Hello world", target: "#seance"});

			const check = (key: string) =>
				sandbox.eval(`return seance.storage.get("${key}")`, "events_script").result;
			expect(check("join_nick")).to.equal("alice");
			expect(check("part_nick")).to.equal("bob");
			expect(check("quit_nick")).to.equal("charlie");
			expect(check("kick_kicked")).to.equal("dave");
			expect(check("nick_new")).to.equal("eve2");
			expect(check("topic_val")).to.equal("New Topic");
			expect(check("mode_val")).to.equal("+o");
			expect(check("send_line")).to.equal("Hello world");
		});
	});

	describe("what scripts send (irc/scripting/manager.ts)", function () {
		let store: Map<string, string>;
		let clock: sinon.SinonFakeTimers;
		let printed: string[];
		let ownSpy = false;

		beforeEach(async function () {
			store = new Map<string, string>();
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				set: (k, v) => void store.set(k, v),
				remove: (k) => void store.delete(k),
				keys: () => [...store.keys()],
			});
			printed = [];

			if (!(socket.dispatch as any).isSinonProxy) {
				sinon.spy(socket, "dispatch");
				ownSpy = true;
			}

			saveScripts([
				{
					id: "bot",
					name: "bot",
					folder: "Unsorted",
					// Answers everything, its own lines included: the loop
					// the echo guard is for.
					code: `seance.on("message", function(m) seance.reply(m, "pong") end)`,
					enabled: true,
				},
			]);
			setScriptingEnabled(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await scriptManager.reload();
			clock = sinon.useFakeTimers({now: Date.parse("2026-10-27T12:00:00.000Z")});
		});

		afterEach(function () {
			clock.restore();
			setContextProvider(null);
			setScriptingEnabled(false);
			scriptManager.teardown();
			useStorageBackend(null);

			if (ownSpy) {
				(socket.dispatch as sinon.SinonSpy).restore();
				ownSpy = false;
			}
		});

		function connected(fakeLag = IRCU_FAKE_LAG) {
			const h = setup({fakeLag});
			register(h);
			setContextProvider({
				getContext: () => ({channel: "#seance", network: h.client.name, nick: "alice"}),
				print: (text) => void printed.push(text),
				clientFor: (uuid) =>
					uuid === undefined || uuid === h.client.uuid ? h.client : undefined,
			});
			return h;
		}

		it("sends a handler's reply through the fake-lag queue and ignores its own echo", function () {
			const h = connected();
			h.transport.line(":bob!b@host PRIVMSG #seance :!ping");
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :pong"]);

			h.transport.line(":alice!alice@host PRIVMSG #seance :pong");
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal([]);
		});

		it("never sends a failing script command to the server raw", async function () {
			const h = connected();
			clock.restore();
			await scriptManager.evalSnippet(
				`seance.register_command("spin", function() while true do end end)`
			);
			clock = sinon.useFakeTimers({now: Date.parse("2026-10-27T12:00:00.000Z")});
			h.client.input(h.client.lobby.id, "/spin secret");
			expect(h.sent()).to.deep.equal([]);
			const said = h.messages().map((m) => m.text ?? "");
			expect(said.some((t) => t.includes("Error in /spin command"))).to.be.true;
		});

		it("knows its own /me line when it echoes", function () {
			const h = connected();
			scriptManager.send("PRIVMSG #seance :\x01ACTION waves\x01", h.client.uuid);
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :\x01ACTION waves\x01"]);
			h.transport.line(":alice!alice@host PRIVMSG #seance :\x01ACTION waves\x01");
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal([]); // the bot answers everything else
		});

		it("answers our own line in a query at its target, not ourselves", function () {
			const h = connected();
			h.transport.line(":alice!alice@host PRIVMSG bob :hi");
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal(["PRIVMSG bob :pong"]);
		});

		it("drops a line for a network that is not there", function () {
			const h = connected();
			scriptManager.send("PRIVMSG #seance :hi", "no-such-network");
			clock.tick(30_000);
			expect(h.sent()).to.deep.equal([]);
		});

		it("drops queued lines when scripting is turned off", function () {
			const h = connected();

			for (let i = 0; i < 5; i++) {
				h.transport.line(`:bob!b@host PRIVMSG #seance :hi ${i}`);
			}

			const before = h.sent().length;
			setScriptingEnabled(false);
			clock.tick(600_000);
			expect(before).to.be.lessThan(5);
			expect(h.sent()).to.deep.equal([]);
		});

		it("drops what does not fit in the queue and says so", function () {
			const h = connected();

			for (let i = 0; i < MAX_QUEUED_LINES + 5; i++) {
				h.transport.line(`:bob!b@host PRIVMSG #seance :hi ${i}`);
			}

			expect(printed.some((p) => p.includes("already waiting"))).to.be.true;
			clock.tick(600_000);
			const sent = h.sent().filter((l) => l === "PRIVMSG #seance :pong");
			expect(sent.length).to.be.at.most(MAX_QUEUED_LINES + 3);
			expect(sent.length).to.be.lessThan(MAX_QUEUED_LINES + 5);
		});
	});

	describe("manager gate (irc/scripting/manager.ts + enabled.ts)", function () {
		let store: Map<string, string>;

		beforeEach(function () {
			store = new Map<string, string>();
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				set: (k, v) => void store.set(k, v),
				remove: (k) => void store.delete(k),
				keys: () => [...store.keys()],
			});
			setScriptingEnabled(false);
			scriptManager.teardown();
		});

		afterEach(function () {
			setScriptingEnabled(false);
			scriptManager.teardown();
			useStorageBackend(null);
		});

		it("does not load the parser or run anything while disabled", async function () {
			expect(isScriptingEnabled()).to.be.false;
			const res = await scriptManager.evalSnippet("return 1");
			expect(res.success).to.be.false;
			expect(res.error).to.equal(scriptingDisabledError());
			expect(scriptManager.loaded).to.be.false;
			expect(scriptManager.hasCommand("anything")).to.be.false;
			expect(scriptManager.getCommandNames()).to.deep.equal([]);
			await scriptManager.init();
			expect(scriptManager.loaded).to.be.false;
		});

		it("never installs a sandbox that finished loading after scripting was turned off", async function () {
			saveScripts([{id: "r", name: "r", folder: "Unsorted", code: "x = 1", enabled: true}]);
			setScriptingEnabled(true);
			const loading = scriptManager.reload();
			setScriptingEnabled(false);
			await loading;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(scriptManager.loaded).to.be.false;
		});

		it("loads each script once when reloads overlap", async function () {
			saveScripts([
				{
					id: "once",
					name: "once",
					folder: "Unsorted",
					code: `seance.on("message", function() seance.storage.set("n", tostring((tonumber(seance.storage.get("n")) or 0) + 1)) end)`,
					enabled: true,
				},
			]);
			setScriptingEnabled(true);
			await Promise.all([
				scriptManager.reload(),
				scriptManager.reload(),
				scriptManager.init(),
			]);
			scriptManager.dispatchMessage({
				network: "n",
				networkUuid: "u",
				target: "#c",
				from: "bob",
				text: "hi",
				type: "message",
				self: false,
			});
			expect(loadScriptData("once")).to.deep.equal({n: "1"});
		});

		it("loads enabled scripts when turned on and tears them down when turned off", async function () {
			saveScripts([
				{
					id: "gated",
					name: "gated_cmd",
					folder: "Commands",
					code: `seance.register_command("gatedwave", function(args, rest) end)`,
					enabled: true,
				},
			]);
			setScriptingEnabled(true);
			// The manager defers its first load by a microtask (boot ordering).
			await new Promise((resolve) => setTimeout(resolve, 0));
			await scriptManager.init();
			expect(scriptManager.loaded).to.be.true;
			expect(scriptManager.hasCommand("gatedwave")).to.be.true;

			setScriptingEnabled(false);
			expect(scriptManager.loaded).to.be.false;
			expect(scriptManager.hasCommand("gatedwave")).to.be.false;
			const res = await scriptManager.evalSnippet("return 1");
			expect(res.success).to.be.false;
		});
	});
});
