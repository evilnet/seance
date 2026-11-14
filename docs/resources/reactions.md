# Reactions and the emoji picker

A reaction is a `+draft/react` tag carrying **free text** (bus-contract §1.4).
That is the fact the whole UI is built around: `👍` is a reaction, so is
`🎉🎉🎉`, and so is `lol`. Nothing anywhere assumes one emoji, one grapheme or
even one word.

## Where a reaction comes from

| Entry point                                         | Lives in                                 |
| --------------------------------------------------- | ---------------------------------------- |
| A quick reaction on a message's toolbar (one tap)   | `client/components/MessageActions.vue`   |
| The 😀 button on the same toolbar (the picker)      | `MessageActions.vue`                     |
| The `+` at the end of an existing reaction row      | `client/components/MessageReactions.vue` |
| Clicking a reaction badge (adds or takes yours off) | `MessageReactions.vue`                   |
| `/react <text> [msgid]`, `/unreact …`               | `client/js/irc/commands/react.ts`        |

All of them end at `socket.emit("msg:react", {target, msgid, text, remove})`,
which the IRC layer turns into one TAGMSG. `remove` is decided from
`myReactions(message, nick)` (`client/js/helpers/messageUpdates.ts`): picking
something you already reacted with takes it back off, from the picker as well
as from the badge, so there is one toggle and not two verbs.

`/react` takes everything up to an optional trailing msgid as the reaction, so
`/react so cool` sends "so cool". A last word only counts as a msgid when it
names a message **loaded in this channel** (`Channel.idOf`) — the client knows
which msgids are real here, and no shape heuristic could tell `awesome` from
an opaque id. `:shortcodes:` are expanded on the way out, the same as in the
picker.

## Quick reactions (`MessageActions.vue`)

The toolbar leads with the three newest **single-emoji** reactions this browser
has sent (`quickReactions()` in `reactionRecents.ts`, topped up from
`DEFAULT_REACTIONS` so there are always three; a word or a `🎉🎉🎉` stays in
the picker — it would not fit a button the width of a glyph), then the 😀 that
opens the picker, then a divider and the rest. One tap reacts; one you already
have reads as pressed (`aria-pressed`, `.selected`) and a tap takes it off.
Every toolbar on screen shows the same list — `rememberReaction` emits
`RECENTS_CHANGED` on the event bus with the new list, and a pick anywhere
moves something to the front everywhere. The bar is one row,
always: as the `chat` pane narrows (container queries in `rem`, so the font
step counts — an own message's eight buttons are ~20.75rem and a 390px phone
is 19.5rem at the default step) the quick reactions stand down one at a time
at 21 / 18.5 / 16rem, and under 14rem the buttons themselves narrow to
1.75rem. This is how most reactions are meant to be sent; the picker is for the
rest.

An action taken from the toolbar — a reaction, Reply, Edit, Delete, a copy
that worked — emits `done`, and on a touch device `Message.vue` closes the
toolbar on it, as every native menu closes on a choice. A copy leaves one
word behind where the bar was, `Copied` (`.msg-copied`, `role="status"`),
fading over a second and taking no tap: the next thing after a copy is a
paste somewhere else. Browser checks:
`tools/scenarios/quick-reactions.mjs --mobile`,
`tools/scenarios/message-actions-single.mjs --mobile`.

## The picker (`ReactionPicker.vue`)

One component, opened from either anchor, `<Teleport>`ed to `<body>` because
the scrollback would otherwise clip it, and positioned from JS against the
button it belongs to: below it, flipped above when there is no room, clamped
into the visible band, re-pinned on scroll and resize, and closed once the
message it belongs to has scrolled away. Only a scroll of the scrollback (the
box holding the anchor) closes it, never a resize or the page's own scroll:
Android lays the page out again in what its keyboard leaves
(`interactive-widget=resizes-content`), and for a frame, until the scrollback
sticks to its bottom again, a message near the bottom sits past the new window
edge, so the tap on the search field that raised the keyboard closed the
popover and dropped the keyboard with it. The popover stays in the band while
its anchor is outside it (under the keyboard). Browser check:
`tools/scenarios/reaction-picker-keyboard.mjs --mobile --width=820 --height=1180`.
Under 480px wide, or on a touch device under
500px tall (a phone on its side), it is a sheet along the bottom edge instead,
and the search field does not take focus on a coarse pointer — the on-screen
keyboard would cover what the user came to tap. The sheet's bottom edge is the
visible band `helpers/viewport.ts` publishes as `--viewport-height`, not the
window's: iOS keeps a fixed element's `bottom: 0` under the keyboard. The
popover measures its room from the same band (`visibleHeight()`) but keeps its
offsets in layout-viewport terms, which is what `position: fixed` resolves. A
landscape phone with the keyboard up keeps ~190px, so there
(`html[data-keyboard="up"]`) the sheet takes the whole band, drops its tab
strip and tightens its chrome for two rows of emoji. Browser check:
`tools/scenarios/reaction-picker.mjs` (the sheet steps publish the band by hand).

Its parts, top to bottom:

- **Search / type field.** Doubles as the free-text entry: whatever is typed is
  offered as a reaction of its own ("React with …"), which is how a word or a
  run of emoji is sent from a desktop with no emoji keyboard. Where that row
  sits decides what Enter does, because the first option is the highlighted
  one: an **exact** alias (`tada`, `:tada:`, `+1`) is somebody naming an emoji,
  so the emoji comes first; anything else (`lol`, `same`, `brb`) is words, so
  the text row comes first and the emoji it happens to prefix — 🍭 lollipop for
  `lol` — is one keypress away. Searching itself is looser than that: `party popper` and `flag de` find what they describe.
- **Group tabs**, the nine Unicode groups plus the recents row, with a scroll
  spy keeping the current one lit.
- **The list**, sections with sticky headings. One delegated click and one
  delegated hover handler for ~1900 options, and `role="listbox"` with
  `aria-activedescendant` on the field, so the field keeps focus and the
  keyboard drives the grid: ↑/↓ move a row (found by geometry — sections wrap
  and a remembered word is wider than an emoji, so there is no column count to
  count), ←/→ move one, but only once the caret has nowhere left to go, and
  Enter sends what is highlighted. Reactions already on the message are ticked.
- **Building a combination**: shift-click (or Shift+Enter on the highlighted
  option) adds an emoji to the field instead of sending it, so `🎉🔥👍` is a
  reaction you can click together — something only a free-text reaction can
  be, which is why no other client's picker has a pattern to copy. The rules
  that keep it out of an ordinary click's way:
  - The field holds what is being built, so **a field that is only emoji is
    not a search**: the grid stays exactly where it was, because the next
    emoji to add is in it. Type a letter and it goes back to searching.
  - The preview bar becomes the composition — what is built so far, "Building
    a reaction", and a Send — whenever nothing is highlighted.
  - While building, **hovering does not move the highlight**. `:hover` still
    lights the cell and the arrow keys still move, but Enter goes on meaning
    "send what you built" instead of being rewritten by a pointer passing
    over the grid.
  - `appendReaction` (`helpers/emoji.ts`, tested) is the join rule: emoji sit
    flush together, anything with a word in it keeps a space, and an addition
    that would pass `MAX_REACTION_LENGTH` is refused rather than cut.
- **Preview bar**: the highlighted emoji, its `:shortcode:` and its
  description, and one line for what would happen to it — "Remove" for one of
  yours, "Enter to send" on the free-text row, "⇧ to combine" otherwise. It is
  the tooltip, so the options carry no `title`: an OS tooltip fading in over
  the grid is exactly the thing a picker should not do. They are not tab stops either
  (`tabindex="-1"`), or Tab would walk 1878 buttons, and each one's accessible
  name is its description rather than the glyph.

Only one picker is ever open. An opener stops the mousedown that would
otherwise reach the document — that is what lets its own button toggle — which
is also the event the outside-click handler waits for, so a second picker
would otherwise leave the first on screen. Each announces itself on the event
bus as it mounts (`reaction-picker-opened`) and any other closes.

The catalog is prefetched at idle once a conversation is open (`Chat.vue` →
`prefetchEmojiCatalog()` in `emoji.ts`: `requestIdleCallback` with a 10 s
timeout, a 3 s timer on Safari; `loadEmojiCatalog`'s own memo makes it once
per page, and a failed fetch lets the next call retry), so the first picker opens on a grid — hover on an opener asks
for it too, for a page whose idle has not come yet, and the picker loads it
itself if all else failed. The lobby does not prefetch: nothing there reacts.

**Only the groups near the scroll are buttons.** The catalog is 1870 emoji,
and a `<button>` each put 1924 nodes in the DOM and the open at 180 ms on a
4×-throttled CPU (109 ms of it one task) — and on Android every glyph in the
DOM is rasterised whether or not it is on screen. So the picker opens on the
recents and Smileys only (~220 nodes, 93 ms, no long task); every other group
is a placeholder `div` whose height is `--rows` × the cell pitch in
`style.css` (`.reaction-picker-placeholder`, next to the cell rule it
depends on), rendered when the scroll brings it within `RENDER_AHEAD`
(320px; `renderNear`, from the list's `scroll` handler and whenever the
layout changes), when its tab is tapped (`goToSection` renders first, then
scrolls) or when the keyboard lands in it (`setActive`; a down arrow with
nothing rendered below goes to the first cell of the next group). Once
rendered a group stays rendered (`rendered`, a reactive Set). A placeholder
group's `Option` objects are not built either — `sections` carries
`start`/`count` for every group and `options` only for rendered ones, so a
keystroke that clears the search allocates ~200 options, not 1900. The row
count needs the column count, which is read off the first row of the
rendered Smileys grid (`countColumns`, on mount, when the catalog lands and
on resize); the placeholder height then matches the rendered grid to the
pixel. Search results are always rendered (≤ 121). The numbers are from
`tools/scenarios/reaction-picker-profile.mjs`, which prints them for a before
and after (`SEANCE_CPU=6` for a cheaper phone).

### Recently used

`client/js/helpers/reactionRecents.ts` keeps the last 36 reactions **sent from
the UI** in `localStorage` under `thelounge.reactions.recent`, newest first,
deduplicated. They are whole reaction strings, words included, and they open
the picker as its first section; before there is any history the section shows
`DEFAULT_REACTIONS` instead. `/react` does not feed the list: it records what
was picked here, not everything that was ever sent.

### The catalog

`client/js/helpers/emoji-catalog.json` is generated from the `gemoji`
devDependency by `tools/generate-emoji-catalog.mjs` — 1870 emoji in nine
groups, each with its primary shortcode, description and keywords, as tuples.
Regenerate it (and re-run prettier over it) only when the dep is bumped; the
generator fails loudly if gemoji grows a category the tab bar has no group for,
or a name `findShortcode` would not recognise.

`emoji.ts` reaches it through `loadEmojiCatalog()`, an `import()` — the data is
its own ~88 kB chunk (`public/js/emoji-catalog.<hash>.js`) that nobody downloads until
they open the picker. `searchEmoji()` scores every token against the name, then
the description and keywords, and requires all of them to match, so `red heart`
finds ❤️ rather than everything red; ties keep Unicode order.

`normalizeReaction()` is the one gate before sending: shortcodes expanded,
control characters and whitespace runs flattened, trimmed, and cut to
`MAX_REACTION_LENGTH` (64) **code points** — a `slice` would split a surrogate
pair. `IrcClient.sendTagmsg` still refuses anything that will not fit in
`MAX_LINE_BYTES` once escaped, which is the real limit.

### Rendering a word reaction

`isEmojiOnly()` decides how a badge is set: emoji at full size, anything else
as a text pill, ellipsised at 22ch with the full text and the nicks in the
tooltip (`data-tooltip`, the app's own primer tooltip, not the OS one). The
picker does the same for remembered reactions and for the "React with …" row.

Being teleported out of `#chat-container` costs the picker anything a theme
scopes to it — `themes/morning.css` puts its placeholder colour there, so the
search field fell back to the global `rgb(0 0 0 / 35%)` and was a smudge on
the dark theme. Style the picker from the `:root` variables only, and the
scenario measures the placeholder's contrast on both themes (>= 4.5:1).

Emoji are set in `--emoji-font` wherever they are shown: a system with more
than one emoji font otherwise picks its own, and some of those are monochrome.
Latin text falls through the stack to the UI font, so it is only ever set on
elements that hold emoji.

A badge that arrives while you are looking pops in (`TransitionGroup`, 160 ms,
off under `prefers-reduced-motion`); the ones already there when a channel is
drawn do not, which is what `appear` being off buys.

## Tests

- `test/helpers/emoji.ts` — catalog shape, search ranking, normalisation.
- `test/helpers/reactionRecents.ts` — the MRU list, its storage, `quickReactions` and the change listener.
- `test/tests/messageUpdates.ts` — `applyReaction` and `myReactions`.
- `test/irc/reactions.ts` — the wire side and `/react`'s argument rules.

No test mounts the picker (the suite has no DOM), so the parts only a browser
can show — where the popover lands, the lazily loaded catalog, keyboard
navigation, the round trip through the ircd and the phone-sized sheet — are a
scenario instead:

```sh
pnpm build && python3 -m http.server -d public 8000 &
tools/nefarious-dev/run.sh -d
node tools/browser-drive.mjs tools/scenarios/reaction-picker.mjs
```

See `docs/resources/browser-testing.md`. The channel keeps history, so the
scenario marks its own message and works only on that one; and it waits out
the 120 ms entrance animation before measuring anything, or it measures the
animation's rect rather than the layout's.

## The same picker in the composer

Typing `:` and two letters of a name in the composer (at the start or after a space: `:tad`, `:+1`; never a time like `10:30` or a URL) opens this picker over the composer with its search seeded (`helpers/emojiTrigger.ts`, `ChatInput.vue`), and the emoji picked replaces the `:name` in the draft with the caret after it. It replaces the old textcomplete dropdown of shortcodes. The picker runs with `insert`: no "React with …" row, Enter on words that match nothing inserts nothing, and what is inserted is not a reaction, so the recents and the toolbar's quick reactions stay as they were. The composer keeps the keyboard on every device, so typing on is never lost to the picker (`:wq then` stays text): each keystroke follows into the picker's search (its `search` prop), and ArrowUp/Down, Enter, Tab and Escape are handed to it (`ReactionPicker` `navigate`, which the picker's own field shares); Enter with nothing to insert sends the message as typed, and Shift+Enter stays the composer's line break. Inserting has nothing to build, so shift is a plain pick and the hints offer no combining. Typing the closing colon of a shortcode (`:tada:`) puts its emoji in at once (`emojiTrigger.ts` `closedShortcode`, `emoji.ts` `emojiForName`); an unknown `:name:` stays text. Only typing opens it (a paste ending in `:name` does not); a space, sending or another channel closes it. Escape, a click away, back or the Close button leaves the `:name` as typed, and that token does not open the picker again; Backspace narrows the search, and past the second letter closes it. On the phone layout it opens as the bottom sheet, over the composer; the term being typed shows in its search. Browser check: `tools/scenarios/composer-emoji.mjs` (also `--mobile --width=390 --height=844`).

**Always a way out.** Back closes the picker, either one: it holds a `CloseWatcher` while it is up where the browser has one (Chromium: Android's back gesture and button, in a tab or an installed web app; never a history entry, as `helpers/imageViewer.ts` does for an image), and the Android shell's back button reaches it as Escape (`native.ts`, its `data-escape-close` layer). On the phone's sheet, and in the composer's picker everywhere, a Close button ends the search row (where there is no Escape key, and the sheet leaves little to tap away on); inserting, the search's clear ✕ is gone, since that search follows the composer.
