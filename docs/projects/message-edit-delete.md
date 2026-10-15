# Message editing & deletion

_Noted 2026-08-27 as a backlog item. Status: **already implemented** for the
common case (see below); this file tracks what is left and what to decide._

## What exists today

Spec: `docs/resources/bus-contract.md` § 1.4; server facts:
`docs/resources/nefarious2-websocket.md` § "REDACT / TAGMSG / client tags".

- **Delete** — `REDACT <channel> <msgid> [:reason]` (`draft/message-redaction`).
  `client.redact()` sends; `handlers/redact.ts` dispatches `msg:redact`; the
  store marks `msg.redacted = {by, reason, time}` and `Message.vue` renders
  "[Message deleted by …]" with click-to-reveal. `/redact <msgid> [reason]`
  (alias `/delete`) and the trash action in `MessageActions.vue`. `FAIL REDACT <code>` surfaces as an error line.
- **Edit** — no wire standard. Seance emulates it: `REDACT <chan> <old> :edited`, wait for the echoed REDACT (or FAIL / 5 s timeout), then
  `@+seance/edit=<old msgid> PRIVMSG <chan> :new text`. `client.editMessage()`,
  `privmsg.ts` sets `msg.editOf`, `msg:edit` puts the new message in the
  old one's place (`helpers/messageUpdates.ts` `applyEdit`: moved behind the
  original, which is hidden by `supersededBy`; it keeps the original's
  timestamp and shows "(edited)" with the edit time as its tooltip). Own
  edits look the same as anyone else's, the pending copy included, and an
  edit raises no unread count and no notification unless it highlights.
  Pencil action in `MessageActions.vue`; `input` carries an optional `edit`
  msgid. ArrowUp in an empty composer edits the newest own message and
  ArrowUp/Down step through them, but only from the composer's top/bottom
  row as drawn (a wrapped line is several rows), and the stepped-to text gets
  the caret at its start after ArrowUp, at its end after ArrowDown — input
  history follows the same rule. Browser checks:
  `tools/scenarios/edit-arrow-step.mjs`, `tools/scenarios/input-arrow-rows.mjs`.
- Both are replayed correctly from `draft/chathistory` (`client.afterReplay`).

## Gaps / decisions

- **Server policy:** `draft/message-redaction` is **off by default** in
  nefarious2 (`CAP_draft_message_redaction`); only `tools/nefarious-dev/local.conf`
  turns it on. Production networks must enable it and pick `REDACT_WINDOW`
  (default 300 s). Document this in the deploy notes.
- **Queries:** REDACT is channels-only (`FAIL REDACT INVALID_TARGET`), so
  deleting in a PM is impossible and editing there degrades to "send a second
  message". Decide whether to hide the edit/delete actions in queries rather
  than offer a half-working one.
- **Edit semantics are Seance-only:** other clients see a deletion followed by
  a new message with an unknown client tag. Acceptable for a network shipping
  its own client, but worth stating in the UI/help. Watch IRCv3 for a message
  edit spec and switch to it if one lands.
- **Window expiry UX:** after `REDACT_WINDOW` the author can no longer edit or
  delete (unless logged in / chanop). The actions still show; they fail with
  `REDACT_WINDOW_EXPIRED`. Could hide them once the message is older than the
  window (window length is not advertised in ISUPPORT — maybe a branding
  setting).
- **Edit ordering:** the emulation does REDACT first, then PRIVMSG. If the
  PRIVMSG is rejected (flood, +m) the original is already gone. Consider
  sending the new message first and redacting on echo.
- **History without the cap:** if `draft/message-redaction` is not negotiated
  (server has it disabled) chathistory still filters deleted messages but the
  client never sees the REDACT lines — verify nothing is left hanging.
- **Tests:** `test/irc/` covers redact/edit handlers; add a live-test case in
  `test/irc/*.live.ts` for the full edit round-trip once the live suites can
  run together (open follow-up in CLAUDE.md).
