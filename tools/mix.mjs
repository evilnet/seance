#!/usr/bin/env node
// Merge a pinned list of pull requests (and local branches) onto develop in
// a worktree of their own, to build and test them together. Never pushes,
// merges a pull request or edits a remote: gh is only read, git only fetches.
//
//   tools/mix.mjs new <name> [--base <branch>] <member>...
//       member: a PR number (evilnet/seance), or branch:<local branch>.
//       List a stack bottom first, every member of it.
//       With no members: upstream develop in its own worktree.
//   tools/mix.mjs continue <name>   after resolving a conflict
//   tools/mix.mjs forget <name> <file>   drop a reused (rerere) resolution
//   tools/mix.mjs build <name> <make target>...
//   tools/mix.mjs report <name>
//   tools/mix.mjs abort <name>      remove what new created, and only that
//
// The worktree is ../seance-mix-<name>, next to this checkout. Each member is
// pinned to the sha it had at `new`; a force-push upstream needs a new mix.
// `build` copies this checkout's local.mk and the files under $MIX_OVERRIDES
// (paths relative to the repository, e.g. client/config.json) into the
// worktree first, so overrides never touch a checkout you work in.

import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "evilnet/seance";
// Kept in the worktree's own git directory, so it goes when the worktree does.
const MARKER = "mix-owner";

function die(message) {
	process.stderr.write(`mix: ${message}\n`);
	process.exit(1);
}

function run(cmd, args, opts = {}) {
	try {
		return execFileSync(cmd, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			...opts,
		}).trim();
	} catch (e) {
		const detail = `${e.stderr ?? ""}`.trim() || e.message;
		die(`${cmd} ${args.join(" ")}: ${detail}`);
	}
}

function git(args, cwd) {
	return run("git", args, {cwd});
}

// git that may fail: {ok, out}
function gitTry(args, cwd) {
	const r = spawnSync("git", args, {cwd, encoding: "utf8"});
	return {ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim()};
}

const top = git(["rev-parse", "--show-toplevel"]);
const common = path.resolve(top, git(["rev-parse", "--git-common-dir"]));

function checkName(name) {
	if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		die("a mix name is lower-case letters, digits and dashes");
	}
}

const manifestPath = (name) => path.join(common, "mix", `${name}.json`);
const worktreeOf = (name) => path.resolve(top, "..", `seance-mix-${name}`);

function load(name) {
	checkName(name);
	const file = manifestPath(name);
	if (!fs.existsSync(file)) {
		die(`no mix named ${name} (tools/mix.mjs new ${name} ...)`);
	}
	const m = JSON.parse(fs.readFileSync(file, "utf8"));
	const marker = fs.existsSync(m.worktree)
		? path.join(path.resolve(m.worktree, git(["rev-parse", "--git-dir"], m.worktree)), MARKER)
		: "";
	if (!marker || !fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== name) {
		die(`${m.worktree} is not mix ${name}'s worktree; leaving it alone`);
	}
	return m;
}

function save(m) {
	fs.mkdirSync(path.dirname(manifestPath(m.name)), {recursive: true});
	fs.writeFileSync(manifestPath(m.name), `${JSON.stringify(m, null, "\t")}\n`);
}

function resolveMember(name, spec) {
	if (/^\d+$/.test(spec)) {
		const pr = JSON.parse(run("gh", ["api", `repos/${REPO}/pulls/${spec}`]));
		const commits = JSON.parse(
			run("gh", [
				"api",
				"--paginate",
				"--slurp",
				`repos/${REPO}/pulls/${spec}/commits?per_page=100`,
			])
		)
			.flat()
			.map((c) => c.sha);
		const ref = `refs/mix/${name}/pr-${spec}`;
		git([
			"fetch",
			"--quiet",
			`https://github.com/${REPO}.git`,
			`+refs/pull/${spec}/head:${ref}`,
		]);
		const sha = git(["rev-parse", ref]);
		if (sha !== pr.head.sha) {
			die(`#${spec} moved while fetching (${sha} != ${pr.head.sha}); run new again`);
		}
		return {
			kind: "pr",
			number: pr.number,
			title: pr.title,
			commits,
			ref,
			sha,
			merged: false,
		};
	}
	const branch = spec.replace(/^branch:/, "");
	if (spec === branch) {
		die(`${spec}: a member is a PR number or branch:<name>`);
	}
	const ref = `refs/mix/${name}/branch-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`;
	const sha = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
	git(["update-ref", ref, sha]);
	return {kind: "branch", branch, title: branch, ref, sha, merged: false};
}

// Two members may share commits (both stacked on a third, or one on the
// other); git merges that. What it cannot see is a rebased or force-pushed
// copy: the same patch under a new sha on one side, which merging both would
// bring twice. rev-list --cherry-mark marks such commits with "=".
function checkStacks(members) {
	members.forEach((m, i) => {
		for (const below of members.slice(0, i)) {
			const copies = git([
				"rev-list",
				"--cherry-mark",
				"--no-merges",
				"--format=%m %h %s",
				`${below.sha}...${m.sha}`,
			])
				.split("\n")
				.filter((l) => l.startsWith("= "));
			if (copies.length > 0) {
				die(
					`${label(m)} and ${label(
						below
					)} carry the same patch under different shas (a rebase or force-push):\n${copies
						.map((l) => `  ${l.slice(2)}`)
						.join("\n")}\nfix the stack, then run new again`
				);
			}
		}
	});
}

function label(m) {
	return m.kind === "pr" ? `#${m.number}` : m.branch;
}

// Merges the members not yet merged; stops at the first conflict.
function mergeOn(m) {
	const wt = m.worktree;
	for (const member of m.members.filter((x) => !x.merged)) {
		process.stdout.write(
			`mix: merging ${label(member)} ${member.sha.slice(0, 9)} ${member.title}\n`
		);
		const r = gitTry(
			[
				"-c",
				"rerere.enabled=true",
				"-c",
				"rerere.autoUpdate=false",
				"merge",
				"--no-ff",
				"--no-edit",
				"-m",
				`mix ${m.name}: ${label(member)} ${member.title}`,
				member.sha,
			],
			wt
		);
		if (!r.ok) {
			process.stdout.write(`${r.out}\n`);
			const reused = r.out.split("\n").filter((l) => /using previous resolution/.test(l));
			if (reused.length > 0) {
				process.stdout.write(
					`mix: reused resolutions (left unstaged), check each one:\n${reused
						.map((l) => `  ${l}`)
						.join("\n")}\n` + `mix: a bad one: tools/mix.mjs forget ${m.name} <file>\n`
				);
			}
			process.stdout.write(
				`mix: resolve in ${wt}, git add the files, then tools/mix.mjs continue ${m.name}\n`
			);
			save(m);
			process.exit(2);
		}
		member.merged = true;
		save(m);
	}
	process.stdout.write(`mix: ${m.name} is ready in ${wt}\n`);
}

function dropRefs(name) {
	const refs = git(["for-each-ref", "--format=%(refname)", `refs/mix/${name}/`]);
	for (const ref of refs.split("\n").filter(Boolean)) {
		git(["update-ref", "-d", ref]);
	}
}

function cmdNew(args) {
	const name = args.shift();
	checkName(name);
	let base = "develop";
	if (args[0] === "--base") {
		args.shift();
		base = args.shift() ?? die("--base needs a branch");
	}
	if (fs.existsSync(manifestPath(name))) {
		die(`mix ${name} exists; tools/mix.mjs abort ${name} first`);
	}
	const wt = worktreeOf(name);
	if (fs.existsSync(wt)) {
		die(`${wt} exists and mix did not create it; leaving it alone`);
	}
	if (git(["for-each-ref", "--count=1", `refs/mix/${name}/`])) {
		die(`refs/mix/${name}/ is in use and mix did not create it; leaving it alone`);
	}
	// Until the manifest is saved, abort cannot find this mix: if new stops
	// before then, drop the refs it fetched and the worktree it added.
	let saved = false;
	let added = false;
	process.on("exit", () => {
		if (!saved) {
			if (added) {
				gitTry(["worktree", "unlock", wt]);
				gitTry(["worktree", "remove", "--force", wt]);
			}
			dropRefs(name);
		}
	});
	const baseRef = `refs/mix/${name}/base`;
	git(["fetch", "--quiet", `https://github.com/${REPO}.git`, `+refs/heads/${base}:${baseRef}`]);
	const members = args.map((spec) => resolveMember(name, spec));
	checkStacks(members);
	const m = {
		name,
		worktree: wt,
		base,
		baseSha: git(["rev-parse", baseRef]),
		members,
		created: new Date().toISOString(),
	};
	git(["worktree", "add", "--detach", wt, m.baseSha]);
	added = true;
	fs.writeFileSync(
		path.join(path.resolve(wt, git(["rev-parse", "--git-dir"], wt)), MARKER),
		`${name}\n`
	);
	git(["worktree", "lock", "--reason", `mix ${name}`, wt]);
	save(m);
	saved = true;
	mergeOn(m);
}

function cmdContinue([name]) {
	const m = load(name);
	const wt = m.worktree;
	const unmerged = git(["diff", "--name-only", "--diff-filter=U"], wt);
	if (unmerged) {
		die(`still unresolved:\n${unmerged}`);
	}
	const member = m.members.find((x) => !x.merged);
	if (!member) {
		die(`${name} has nothing left to merge`);
	}
	if (!gitTry(["rev-parse", "--verify", "-q", "MERGE_HEAD"], wt).ok) {
		die(`no merge in progress in ${wt}`);
	}
	git(["-c", "rerere.enabled=true", "commit", "--no-edit"], wt);
	member.merged = true;
	save(m);
	mergeOn(m);
}

function cmdForget([name, file]) {
	const m = load(name);
	if (!file) {
		die("forget needs a file");
	}
	// checkout -m would overwrite a file that is not in conflict.
	if (!git(["diff", "--name-only", "--diff-filter=U", "--", file], m.worktree)) {
		die(`${file} is not in conflict in ${m.worktree}`);
	}
	// rerere forget only drops the recorded resolution; checkout -m puts the
	// conflict markers back in the file, to resolve by hand.
	git(["-c", "rerere.enabled=true", "rerere", "forget", file], m.worktree);
	git(["checkout", "-m", "--", file], m.worktree);
	process.stdout.write(`mix: forgot the resolution of ${file}; its conflict is back\n`);
}

function cmdBuild([name, ...targets]) {
	const m = load(name);
	if (m.members.some((x) => !x.merged)) {
		die(`${name} is mid-merge; finish it first`);
	}
	const localMk = path.join(top, "local.mk");
	if (fs.existsSync(localMk)) {
		fs.copyFileSync(localMk, path.join(m.worktree, "local.mk"));
	}
	const overrides = process.env.MIX_OVERRIDES;
	if (overrides) {
		const copy = (dir) => {
			for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
				const from = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					copy(from);
				} else {
					const to = path.join(m.worktree, path.relative(overrides, from));
					fs.mkdirSync(path.dirname(to), {recursive: true});
					fs.copyFileSync(from, to);
					process.stdout.write(`mix: override ${path.relative(overrides, from)}\n`);
				}
			}
		};
		copy(overrides);
	}
	const r = spawnSync("make", targets.length ? targets : ["help"], {
		cwd: m.worktree,
		stdio: "inherit",
	});
	process.exit(r.status ?? 1);
}

function cmdReport([name]) {
	const m = load(name);
	const wt = m.worktree;
	const lines = [`mix ${name} in ${wt}`, `base ${m.base} ${m.baseSha}`];
	const earlier = [];
	for (const member of m.members) {
		lines.push(
			`${member.merged ? "merged " : "pending"} ${label(member)} ${member.sha} ${
				member.title
			}`
		);
		if (member.kind === "pr") {
			const own = new Set(member.commits);
			const extra = git(
				[
					"rev-list",
					"--no-merges",
					member.sha,
					`^${m.baseSha}`,
					...earlier.map((s) => `^${s}`),
				],
				wt
			)
				.split("\n")
				.filter((sha) => sha && !own.has(sha));
			for (const sha of extra) {
				lines.push(`  also brings ${git(["log", "-1", "--format=%h %s", sha], wt)}`);
			}
		}
		earlier.push(member.sha);
	}
	lines.push(`HEAD ${git(["rev-parse", "HEAD"], wt)}`);
	const dirty = git(["status", "--porcelain"], wt);
	if (dirty) {
		lines.push(`changes in the worktree:\n${dirty}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdAbort([name]) {
	const m = load(name);
	const wt = m.worktree;
	if (gitTry(["rev-parse", "--verify", "-q", "MERGE_HEAD"], wt).ok) {
		git(["merge", "--abort"], wt);
	}
	gitTry(["worktree", "unlock", wt]);
	git(["worktree", "remove", "--force", wt]);
	dropRefs(name);
	fs.rmSync(manifestPath(name));
	process.stdout.write(`mix: removed ${name}\n`);
}

const commands = {
	new: cmdNew,
	continue: cmdContinue,
	forget: cmdForget,
	build: cmdBuild,
	report: cmdReport,
	abort: cmdAbort,
};
const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
	die(
		`usage: tools/mix.mjs ${Object.keys(commands).join(
			"|"
		)} <name> ... (see the top of tools/mix.mjs)`
	);
}
commands[command](rest);
