# Touch: a topic or mode line takes two long presses to select

_Noted 2026-09-19. Status: fixed the same day — reproduced and pinned by step 5
of `tools/scenarios/toolbar-select-hold.mjs` (3 checks red on ef336db9, green
after); the plan below is what was done._

## Symptom

On a touch device, a long press on a chat message opens the action toolbar and
a second long press on that message is the platform's own text selection
(PR #68, #69 — that part works as designed).

A line that has no toolbar — the topic, a mode change, a notice, a quit or
nick line, a `/whois` reply — shows the same two-press requirement: the first
long press does nothing visible (on Android it still vibrates), and only the
second long press selects the text. Expected: a line with no toolbar has
nothing for the first press to open, so its first long press should already
be the platform's selection.

Before #68 (since PR #63, 2026-09-17) these lines could not be selected on
touch at all; #68 made them selectable, but only behind an invisible first
press.

## Cause

Two places treat every `.msg` as if it had a toolbar; neither asks `canAct`.

1. **The long-press timer starts on every row.**
   `client/components/Message.vue` `onTouchStart` (L292) has no `canAct`
   check. After 500 ms (L319) it sets `openActions = message.id`,
   `swallowClick = true` and vibrates (L327) whether or not the row renders a
   `MessageActions` (that is gated separately, `v-if="canAct && channel"`,
   L178; `canAct` L529 = `MESSAGE`/`ACTION` type, has a msgid, not redacted,
   network connected). So on a topic line the press "opens" a toolbar that
   does not exist: the row gets `actions-open` with nothing in it,
   `onContextMenu` (L362) swallows the platform's menu, `onClick` swallows the
   click, and `onTouchEnd` (L347–353) arms `select-armed`.
2. **`user-select: none` covers every row.** `client/css/style.css` L4625
   `#chat .messages .msg { user-select: none; -webkit-touch-callout: none }`
   applies to the topic, mode and notice rows too, so the platform's own
   long press cannot select them until `select-armed` (L4645) or
   `selection-live` (L4646) lifts it.

Put together: press one arms the row silently (`openActions === id`,
`select-armed` → `user-select: text`); press two hits the early return at
L307 (`openActions.value === props.message.id`) and is left to the platform,
which now finds selectable text. Hence exactly two presses.

Rows that `canAct` excludes and are therefore affected: every type other than
`message`/`action`; a message with no msgid (a server without `message-tags`,
or one that has been redacted); **any** message while the network is
disconnected (`canAct` reads `network.status.connected`).

`MessageCondensed.vue` (the collapsed join/part rows, `.msg[data-type="condensed"]`)
has the same `user-select: none` and no touch handlers at all, so it can never
be selected on touch unless a selection started elsewhere in the scrollback
(`selection-live`). Same family of bug, one step worse.

## Where to look

- `client/components/Message.vue` L292–356 (`onTouchStart`, the timer,
  `onTouchEnd`), L362 (`onContextMenu`), L529 (`canAct`), template L11–12
  (`actions-open`, `select-armed`).
- `client/css/style.css` L4625–4650 — the `(hover: none) and (pointer: coarse)`
  block: the `none` rule and its two `text` exceptions.
- `client/js/helpers/touchSelection.ts` L32 — a selection anywhere inside
  `#chat .messages` counts as live, so a native selection on a topic line
  already puts the toolbars away and turns the scrollback selectable. No
  change needed there.
- `tools/scenarios/toolbar-select-hold.mjs` — the existing scenario for the
  two-press contract on a real message; `longPress`/`tap` helpers at L118–133
  drive touch through `Input.dispatchTouchEvent`. `message-actions-single.mjs --mobile` covers the single long press.
- `CLAUDE.md` § Touch and iOS (L78) and the comment blocks above the CSS rule
  and `onTouchStart` describe the intended contract; both say "message" where
  they mean "a message with a toolbar" — update the wording with the fix.

## Plan

1. Reproduce: `corepack yarn build`, `tools/nefarious-dev/run.sh -d`, then a
   copy of `toolbar-select-hold.mjs` that long-presses the channel's
   `.msg[data-type="topic"] .content` (set a topic first) and `.msg[data-type="mode"]`
   once, and asserts `getComputedStyle(row).userSelect === "text"` and no
   `actions-open` class on the row. Expected today: `none` and `actions-open`
   present after the first press, `text` after it lifts — the bug.
2. Fix `onTouchStart`: return before setting `pressStart`/`pressTimer` when
   `!canAct.value` (define `canAct` above the handlers, or hoist it). Nothing
   then sets `openActions`, so the click and contextmenu swallowing, the
   vibrate and `select-armed` never happen on such a row. `onContextMenu`
   should likewise stand down when `!canAct.value`, so Android's selection
   menu is not prevented on a topic line.
3. Fix the CSS so a row without a toolbar is selectable on the first press.
   Simplest: mark the rows that have one — add `'has-actions': canAct` to the
   row's class list and scope the `none` rule to
   `#chat .messages .msg.has-actions` (keep the `select-armed` and
   `selection-live` exceptions as they are). A `:has(.msg-actions)` selector
   would also work but ties the CSS to a rendered child. Give
   `MessageCondensed.vue` no such class, so it turns selectable too.
4. Re-run `toolbar-select-hold.mjs --mobile` and `message-actions-single.mjs --mobile` (unchanged contract on a real message), then the new topic/mode
   assertion from step 1; promote it into `toolbar-select-hold.mjs` rather
   than a new file. A real device pass on iOS for the gesture itself, as the
   scenario header says emulation cannot make the native selection.
5. Update the comments in `style.css` (above L4625), `Message.vue` (above
   `onTouchStart`), `touchSelection.ts` and `CLAUDE.md` § Touch and iOS:
   "the message text is `user-select: none` there" becomes "a message with a
   toolbar is `user-select: none` there; a line without one (topic, mode,
   notice, anything `canAct` rejects) is the platform's on the first press".
