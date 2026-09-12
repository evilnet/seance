# Command aliases

User-defined slash commands: a name and a body, edited in Settings → Aliases,
stored in `thelounge.aliases` (one JSON list of `{name, body}`, order kept),
carried by the settings backup.

## Expansion

`client/js/helpers/aliases.ts` is the whole feature's logic: Vue-free, tested
in `test/helpers/aliases.ts`. `expandAlias(text, vars)` returns the body's
lines with substitutions applied, or `null` when `text` is not an alias
invocation (plain text, `//`-escaped, unknown name) — the caller then sends
the text unchanged.

Substitutions, applied to the whole body before it is split into lines:

| Token     | Becomes                                               |
| --------- | ----------------------------------------------------- |
| `$1`…`$9` | one argument, empty when not given (`$10`+ works too) |
| `$2-`     | arguments from the 2nd to the last, space-joined      |
| `$*`      | everything after the alias name, verbatim             |
| `$chan`   | the current channel or query name                     |
| `$me`     | own nick on the current network                       |
| `$$`      | a literal `$`                                         |

`$0` and unknown `$words` are left as typed. Arguments are split on runs of
spaces; `$*` alone preserves the original spacing. Each expanded line is
trimmed of trailing whitespace and blank lines are dropped.

A body line may invoke another alias. Expansion nests to `MAX_DEPTH` (8), and
a name already on the expansion chain is left alone rather than re-expanded,
so an alias may shadow and wrap a built-in (`/join` → `/join #lobby $*`)
and a mutual cycle terminates. Matching is case-insensitive.

## Where it hooks in

`ChatInput.onSubmit` expands the line **before** the UI-only command check
and emits each resulting line as its own `input`, so an alias can reach UI
commands (`/search`), IRC commands and plain text alike. Never while editing
a message (the edit body is text), and `//` always escapes. Alias names join
command autocompletion (`getCommands()` in `client/js/autocompletion.ts`).

Limits: 200 aliases, names ≤ 32 chars (`[a-z0-9][a-z0-9_-]*`, no leading
slash), bodies ≤ 2000 chars.

## The `/alias` command

`client/js/irc/commands/alias.ts` (tested in `test/irc/commands.ts`) edits the
same stored list from the input line, feedback via `pushMessage` — nothing is
sent to the server, and it works disconnected:

- `/alias` — every alias, verbatim in a monospace block (bodies are full of
  `/`, `$` and `#` that Markdown would mangle).
- `/alias <name>` — that one alias (the name may be typed with its slash).
- `/alias <name> <commands>` — create it, or overwrite the body in place;
  the same name/body limits as the editor. Deleting stays in Settings.

`$…` tokens survive as typed: expansion in `ChatInput` only replaces names
that _are_ aliases, so a `/alias` line passes through untouched — and a user
who defines an alias literally named `alias` shadows the command, like any
other shadow. `alias` is in `multilineCommands` (`irc/commands/index.ts`), so
a body typed with Shift+Enter stays one definition where `draft/multiline` is
negotiated; without the capability each line is its own input, as everywhere
else, and only the first reaches `/alias`. A Settings pane already open does
not live-reload the list; reopen it to see a command-line change.

## The editor

`client/components/Settings/Aliases.vue`: one grid row per alias (name input
with a fixed `/` prefix, monospace body textarea sized to its line count, a
remove button), inline validation — a row with an error is kept on screen but
not saved; every valid change persists at once, like the rest of the
settings — a variables reference, and a "Try it" box that runs
`expandAlias` against the current rows with placeholder `$chan`/`$me` values.

Nothing in `yarn test` renders it; browser check: `tools/scenarios/aliases.mjs`.
