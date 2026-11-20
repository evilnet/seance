# Accessibility (WCAG 2.2 AA) pass

Status: audit done 2026-09-06; the type scale (§ below) landed the same day,
the WCAG failures are still open. This file is the checklist; tick items as
they land and move it to `archives/` when the pass is complete.

Scope of the audit: `client/css/style.css`, both themes, `client/index.html`,
every SFC under `client/components/`, `client/js/keybinds.ts` and
`client/js/helpers/parse.ts`. Contrast ratios were computed, not eyeballed
(`tools/`-free one-off script; the pairs are listed below so they can be
re-checked). Nothing here was verified in a browser yet: the fixes need the
`browser-check` routine (`docs/resources/browser-testing.md`).

## Summary

The app is in two halves. Everything written in the last month (reaction
picker, context menu, link previews, upload preview, spoilers, the live
regions in the message list and the typing indicator) is done carefully and
mostly passes. The inherited TheLounge chrome is where the failures are, and
they cluster into five root causes:

1. **Keyboard access.** The channel rows, every nick, the message action
   toolbar, the topic editor, the password reveal and the search toggle are
   `div`/`span` click targets or hover-only. A keyboard user cannot change
   channel, open a user menu, reply/react/edit/delete, or edit a topic.
2. **Focus visibility.** `button { outline: none }` (style.css:210) removes
   the focus ring from every button that has no `:focus-visible` rule of its
   own, which is all of the legacy chrome. The `.btn` ring that does exist is
   a 50 % green on white at 1.35:1.
3. **Zoom.** `user-scalable=no` in the viewport meta plus `touch-action: none`
   on `body` block pinch-zoom on phones (1.4.4). The font-size setting is
   also silently overridden on screens under 768 px (style.css ~3639 pins
   `.messages .msg` to 15 px) and clips at its upper steps (`#input` keeps a
   fixed 19 px line-height).
4. **Colour contrast.** The green that the brand leans on (`#84ce88`) is
   1.9:1 on white and is used as button text, button border and the focus
   ring. Links and default nicks (`#50a656`) are 3.0:1. Placeholders, the
   date and unread markers, the join/part icons, the action-nick orange and
   the error red all fall under 4.5:1 on the light theme. The nick palette
   itself is fine on plain backgrounds (min 4.46:1) but not on highlighted
   rows.
5. **Dialogs and structure.** ConfirmDialog, ImageViewer, Mentions and the
   connect-from-link window have no dialog role or focus management; there
   is no `<main>` and no skip link; `#viewport` is a `tablist` that owns the
   whole page.

Size is not a WCAG criterion, but see § Type scale below for what the audit
says about the "everything is too small" feeling.

## Type scale and target sizes

What is on screen today (desktop, light theme, font size "medium"):

| Element                                              | Size       | Note                                         |
| ---------------------------------------------------- | ---------- | -------------------------------------------- |
| Settings, help, connect form, sidebar channel names  | 16 px      | inherits `body`; already the browser default |
| Messages, input, user list                           | 14 px      | `--user-font-size`, medium                   |
| Header title / topic                                 | 15 / 14 px |                                              |
| `.btn` label                                         | 12 px      | bold, uppercase, `letter-spacing: 1px`       |
| Date / unread markers, typing indicator, media hints | 12 px      |                                              |
| Sidebar badge, `msg-shown-in-active` glyph           | 10 px      |                                              |
| Reaction picker headings, trusted-host labels        | 11 px      |                                              |
| Footer buttons                                       | 45 × 45 px | ok                                           |
| Header buttons (`#chat button.close`)                | 36 × 36 px | ok                                           |
| Message action buttons                               | 26 × 24 px | at the 2.5.8 minimum                         |
| Sidebar close / edit-network                         | 18 × 18 px | below 24 px, adjacent to each other          |
| User list rows                                       | ~22 px     | 14 px × 1.6                                  |
| Reaction chips                                       | ~20 px     |                                              |

Observations that bear on the decision:

- The chat is the one region that is _smaller_ than its surroundings. Every
  window and the sidebar are 16 px; the messages people read all day are
  14 px. That mismatch is most of the "too small" impression.
- The stylesheet has **zero `rem`** and sets `body { font: 16px … }`. A user
  who raises their browser's default font size gets nothing; only page zoom
  works. The font-size setting only reaches three selectors (`#form`,
  `.messages .msg`, `.userlist`).
- 50 % more on the text (14 → 21 px) is the current "huge" step and
  overshoots as a default. 50 % more on the small controls (18 → 27 px,
  26×24 → 36×32) is about right.
- Widths that are pinned in px and will fight a larger scale: `#chat .from`
  134 px, `#chat .time` 55 px, `#input` 19 px line-height / 95 px max-height,
  `.header` 45 px, `.container` 480 px, `#sidebar` 220 px, `.userlist`
  180 px.

Done 2026-09-06 (the users' feedback after the slider landed was that the
chrome stayed small while the messages grew — which was exactly what the
slider did, since it reached three selectors):

- [x] The scale is `html { font-size }`: `medium` = 100 % of the browser
      default (16 px); tiny 62.5 %, small 81.25 %, large 125 % (the
      default), xlarge 162.5 %, huge 212.5 %. Re-scaled 2026-09-07: the
      first cut topped out at 131.25 % (21 px), which was not large for
      anyone who needs large, and spent half its stops under 16 px. The
      ends are meant to be too small and too large for most people. The
      sidebar is `--sidebar-width` = `min(7rem + 108px, 85vw)`, half rate
      and never past a phone screen.
- [x] Every px font size and the chrome's box sizes in `style.css` and the
      component styles are rem/em: header and footer 3 rem, header and form
      buttons 2.5 rem / 2.25 rem, sidebar 16 rem with 1 rem rows and
      1.5 rem icon targets, user list 12 rem, `.from` 8.5 rem, `.time`
      3.5 rem, input `line-height: 1.4` with em heights, menus 12 rem,
      message actions 2.25 × 2 rem, reaction chips ≥ 1.5 rem, `.btn`
      0.875 rem with em padding, badges 0.75 rem, markers 0.8125 rem, the
      reaction picker 21.25 rem. Nothing is under 0.7 rem (11 px at the
      default).
- [x] The `max-width: 768px` block no longer pins anything to 15 px, so the
      setting works on phones.
- [x] Settings navigation offset is clamped so it cannot slide under the
      sidebar at the large steps.
- [ ] Measured at the default: messages 14 → 16 px, sidebar rows 14 → 16 px
      (lobby 15 → 17), header 45 → 48 px, `.btn` 12 → 14 px with a taller
      box, sidebar controls 18 → 24 px, message actions 26×24 → 36×32,
      user-list rows 22 → 26 px. At `huge` everything is 1.5× the old
      default. If the team wants more by default, `defaultFontSize` in
      `client/js/helpers/fontSize.ts` (and `settings.ts`) is one word:
      `xlarge` is +29 % across the board.

## Findings

Severity: **B** blocks a class of users, **D** degrades, **M** minor.
SC = WCAG 2.2 success criterion.

### Keyboard, focus, zoom

- [ ] **B 2.1.1 / 4.1.2** `ChannelWrapper.vue:22-26` — channel rows are
      `<div role="tab">` with `@click` and no `tabindex`/keydown. Primary
      navigation is mouse-only. Also `:aria-controls="'#chan-' + id"` is a
      selector, not an IDREF (drop the `#`; `keybinds.ts:157` queries it).
- [ ] **B 2.1.1** `Username.vue:5-7` — `<span role="button">` with no
      `tabindex` or key handler; every nick and the whole user list.
- [ ] **B 2.1.1 / 2.4.7** `MessageActions.vue` + `style.css:4137-4155` —
      toolbar is `display: none` until `.msg:hover`/`:focus-within`; a
      `display:none` subtree cannot take focus, so on a plain message
      Reply/React/Copy/Edit/Delete are unreachable by keyboard. Keep the
      buttons rendered (`opacity`/`visibility`), or mirror them in the
      message context menu.
- [ ] **B 2.1.1** `RevealPassword.vue:4-15` — `<span type="button">`; used by
      Connect and NetworkForm. Make it a `<button type="button">`.
- [ ] **B 2.1.1** `MessageSearchForm.vue:20` — toggle bound to
      `@mousedown.prevent` only; Enter/Space never fire it.
- [ ] **B 3.3.2 / 4.1.2** `MessageSearchForm.vue:4-13` — search input is
      placeholder-only and stays tabbable while collapsed (`height: 0`).
- [ ] **B 2.4.3** `ChatUserList.vue:18`, `NetworkList.vue:20` —
      `tabindex="-1"` on the two search inputs, the only keyboard route into
      the user list / jump-to.
- [ ] **B 2.1.1** `InlineChannel.vue:2-10` — focusable `role="button"` with
      no keydown: focusable but inoperable.
- [ ] **B 2.1.1** `Windows/SearchResults.vue:48-54` — results are `<div @click>`.
- [ ] **B 2.1.1** `Chat.vue:34-47` — save-topic is nested spans; topic edit
      is `@dblclick` only. Needs a button / menu entry.
- [ ] **B 2.4.7** `style.css:210` — global `button { outline: none }`.
      Replace with one global `:focus-visible` rule (2 px solid, ≥ 3:1 on
      both themes) and delete the per-component copies that become
      redundant. Also `outline: none/0` on `.topic-input` (1407), `#chat .chat` (1510), `.userlist .search` (2334), `#loading summary` (2424),
      `#input` (2934), `.textcomplete-menu` (2993).
- [ ] **B 1.4.4 / 1.4.10** `index.html:7` `user-scalable=no` +
      `style.css:168` `body { touch-action: none }` — blocks pinch-zoom.
      Drop the meta value; scope `touch-action` to the scroll containers.
- [ ] **B 1.4.4** `style.css:~3639` — the `max-width: 768px` block pins
      `.messages .msg` (and `#form #input`) to 15 px, overriding the
      font-size setting on phones.
- [ ] **B 1.4.4** `style.css:2926-2934` — `#input` `height/min-height/ line-height: 19px; max-height: 95px` clip the input at the xlarge and
      huge steps. Use `line-height: 1.4` and em heights;
      `ChatInput.vue:181-191` already reads the computed line-height.
- [ ] **D 3.2.1** `keybinds.ts:203-240` — printable keys outside
      `INPUT`/`TEXTAREA` steal focus into `#input`; `<select>`,
      `contenteditable`, `role="menu"/"dialog"/"listbox"` are not excluded.
- [ ] **D 2.4.7** `Chat.vue:100-109` + `style.css:1552-1566` —
      `.scroll-down` hidden with `opacity: 0; pointer-events: none` stays in
      the tab order; add `visibility: hidden`.
- [ ] **D 2.1.1** `ContextMenu.vue:161-184` — no keyboard entry point (falls
      out of the two items above); also handle `Shift+F10`.
- [ ] **D 2.1.1** `Message.vue:68-75,146-153` — collapsing a revealed deleted
      message is a `title`-only span.
- [ ] **M 2.5.8** `style.css:1018-1078` — `.channel-list-item .close`,
      `.edit-network` 18 × 18 px; `.close` only rendered on the active row
      (`.add-channel` is gone: the channel browser is a full-size sidebar
      line now).
- [ ] **M** `App.vue:4-9` — Escape does not close the mobile sidebar
      overlay (`Alt+S` is the only keyboard path).

### Dialogs, landmarks, structure

- [ ] **B 4.1.2 / 2.4.3** `ConfirmDialog.vue` — done: `role="dialog"`,
      `aria-modal`, `aria-labelledby` its title, the focus onto the answer
      (a destructive question's Cancel) and back where it was after the
      last of a run of questions, and Tab and Shift+Tab come round between
      its buttons (`helpers/trapTab.ts`). Left: the question's text is not
      its `aria-describedby`, so a screen reader announces only the title
      and the focused button; and the app behind is not `inert`, so a click
      on the backdrop drops the focus to `body`, and Tab from there goes
      into the app.
- [ ] **B 4.1.2 / 1.1.1** `ImageViewer.vue:2-39` — same; `.close-btn` has no
      handler (relies on bubbling); image `alt=""`; `.open-btn` is an empty
      link.
- [ ] **D 2.4.3** `Mentions.vue`, `PushPrompt.vue`, `Windows/Connect.vue:2-8`
      (`fromLink`), `ReactionPicker.vue:3-12` (no `aria-modal`, Tab escapes;
      `<p>` inside `role="listbox"`) — incomplete dialog semantics / focus
      management.
- [ ] **D 2.4.1 / 1.3.1** no `<main>`, no skip link; the sidebar precedes
      the chat on every page.
- [ ] **D 4.1.2** `App.vue:2` — `#viewport` is `role="tablist"` and owns the
      whole page; move the role to the channel list or drop the tab pattern.
- [ ] **D 1.3.1** `Settings/Navigation.vue:5` + `SettingTabItem.vue:2` —
      `<ul role="navigation">` with `<li role="tab">` wrapping `<button>`.
- [ ] **D 4.1.2** `Sidebar.vue:32-70` — Settings/Help `aria-label` sits on
      the wrapper span, not the button (unnamed buttons); `<a>` wrapping
      `<button>` via `router-link`. Use `data-tooltip` + `router-link custom`.
- [ ] **D 4.1.2** ten `<button class="extra-help"/>` (NetworkForm, General,
      Notifications, Appearance) — empty, unnamed; tooltip on the wrapper is
      hover-only (`:focus` never matches the span) and not Escape-dismissable
      (1.4.13). Two of them lack `type="button"` inside a `<form>` (3.2.2).
- [ ] **D 2.5.3** `Connect.vue:29-38`, `NetworkForm.vue:55-63` — visible
      "Server" vs `aria-label="Server address"`.
- [x] **D 3.3.2** `JoinChannel.vue:11-33` — placeholder-only fields. The form is gone; the channel browser's join-by-name password field carries an `aria-label`.
- [ ] **D 4.1.3** `Chat.vue:120-126` `#user-visible-error` (no
      `role="alert"`, div-click dismiss); `Settings/Notifications.vue:65-107`
      error blocks (no live region); `Chat.vue:53-63` empty
      `role="status"` with only an `aria-label`.
- [ ] **D 4.1.3** `NetworkList.vue:84` — `aria-live` on a whole network's
      channel list double-announces every message next to the `role="log"`.
- [ ] **D 1.1.1** `parse.ts:385-395` — emoji `role="img"` with `aria-label`
      null when not in the name map.
- [ ] **D 4.1.2** `Windows/Changelog.vue:2` — `aria-label` on a role-less div.
- [ ] **M 3.1.2** `Chat.vue:2` — `lang=""` on the container also covers the
      English chrome inside it.
- [ ] **M 4.1.2** `Message.vue:17-22` — `aria-label` on an `aria-hidden`
      timestamp.
- [ ] **M 4.1.2** `Channel.vue:12-18`, `NetworkLobby.vue:29-31`,
      `StatusmsgMarker.vue`, `DateMarker.vue` — `aria-label` on generic
      spans (ignored by most AT); add `role="img"` or sr-only text.
- [ ] **M 1.1.1** `Sidebar.vue:5` — `alt` + `role="presentation"` together.
- [ ] **M 1.3.1** empty `<label>` spacers and orphan labels in Connect /
      NetworkForm; nested `<label>` in General / Appearance / Notifications;
      Settings has no `h1`; `Notifications.vue:11-19` `role="heading"` on a
      paragraph; `Special/List*.vue` `<th>` without `scope`, no caption;
      `ContextMenu.vue:28-40` dividers are `menuitem`s, Space does not
      activate; markers drawn with CSS `content:`.

### Colour contrast (1.4.3 text ≥ 4.5:1, 1.4.11 non-text ≥ 3:1)

Light theme, on `#fff` unless noted:

| Pair                                 | Ratio     | Used for                                   |
| ------------------------------------ | --------- | ------------------------------------------ |
| `#84ce88` button text/border         | 1.88      | every `.btn`, `--upload-progressbar-color` |
| `#fff` on `#84ce88`                  | 1.88      | `.btn:hover`, `.btn:disabled`              |
| focus ring `rgb(132 206 136 / 50%)`  | 1.35      | `.btn:focus`, `.input:focus`               |
| `#50a656`                            | 3.03      | `--link-color`, default `.user`            |
| placeholder `rgb(0 0 0 / 35%)`       | 2.43      | all inputs                                 |
| date marker `rgb(0 107 59 / 50%)`    | 2.33      |                                            |
| unread marker `rgb(231 76 60 / 50%)` | 1.95      |                                            |
| `#2ecc40`                            | 2.14      | join / topic / mode / whois icons          |
| `#e74c3c`                            | 3.82      | error `.from`                              |
| `#f39c12`                            | 2.19      | `/me` nick                                 |
| `#767676` on highlight `#efe8dc`     | 3.73      | time / muted text on a highlighted row     |
| 23 of 32 nick colours on `#efe8dc`   | 3.66-4.40 | nicks on highlighted rows                  |
| `#cfcfcf`                            | 1.56      | `#chat .count::before`                     |

Sidebar (`#415364`):

| Pair                                        | Ratio | Used for                                   |
| ------------------------------------------- | ----- | ------------------------------------------ |
| `#84ce88` lobby name                        | 4.22  | network row                                |
| `#e74c3c` parted channel / disconnected dot | 2.08  |                                            |
| `#afb6c0` badge on 6 % white                | 3.32  | unread count                               |
| `#2ea043` notify-on bell                    | 2.35  |                                            |
| `#767676` notify enabled/off bell           | 1.75  | `--body-color-muted` reused on the dark bg |
| `#b7c5d1` row text / footer icons           | 4.51  | passes, no margin                          |

Morning theme (`#303e4a`): `#f92772` unread marker 2.91, `#e74c3c` error
2.87; 10 of 32 nick colours fall to ~4.0 on the highlight bg `#4d4332`.
Everything else on morning passes; the nick palette was clearly tuned to
4.5 on the plain backgrounds.

The Ink & Amber themes added 2026-09 (`coffee`, now the default, and `creama`;
`docs/resources/themes.md`) were built to this section's targets: body and
muted text ≥ 4.5:1 on the chat surface, icons and the rail's muted tone
≥ 3:1 (footer icons ≥ 4.5), and generated 32-slot nick palettes at ≥ 4.6:1
(coffee) / ≥ 5:1 (creama) so a nick still clears 4.5 on a highlighted row.
Where the design handoff's own values missed its 4.5 rule they were darkened;
each theme file's header lists the deviations. Their placeholders sit at
3.2–3.8:1, the one deliberate exception, and the day/morning items below
still stand.

- [ ] Pick a darker brand green for text/border/focus on light (≥ 4.5:1 on
      `#fff`, e.g. in the `#2f7d3a`–`#3b8a41` range) and keep `#84ce88` as a
      fill with dark text. Same for `--link-color`/`.user`.
- [ ] Placeholder to ~55 % black; markers to solid colours; icon greens/reds
      and the `/me` orange to darker variants (they are also used as the only
      indicator of message type, see 1.4.1 below).
- [ ] Sidebar: darker/lighter variants for lobby, parted, badge, bells; stop
      reusing `--body-color-muted` on the dark sidebar.
- [ ] Focus ring: solid, ≥ 3:1 against both window backgrounds.

### Colour as the only signal (1.4.1)

Unread vs highlight badge (same element, colour only); typing / activity
pulse; sidebar connection dot; notification bell state; parted-channel icon;
message highlight background; reaction "mine" state (has `aria-pressed`, the
visual side only). Add a shape/weight/text difference to each.

### Already good

`role="log"` on the message list and search results; `role="status"` on the
typing indicator and upload progress; ReactionPicker (combobox/listbox,
focus return); ContextMenu (arrow keys, Escape, focus restore); UploadPreview
(full dialog pattern); Markdown spoilers; `.sr-only` in use; `lang="en"`;
real tables in `Special/`; Help documents every shortcut; the
`data-tooltip` convention exists precisely to keep accessible names off
wrappers, and the newer components use it. Reduced motion is honoured for
all eight keyframe animations.

## Plan

1. Pure bugs, no design decision: viewport zoom, global focus ring, the
   mobile font override, the input line-height, `aria-controls`, dialog
   roles, the `tabindex="-1"`s, the keybinds focus steal.
2. Keyboard reach: channel rows, nicks, message actions, search toggle,
   password reveal, topic edit, search results.
3. Contrast: the green, the muted/marker/icon colours, the sidebar set, the
   focus ring.
4. Type scale and targets (§ above), once the default is agreed.
5. Landmarks, live regions, the minor list.

Each step is a browser check, not a mocha run: nothing in `yarn test` mounts
a component.
