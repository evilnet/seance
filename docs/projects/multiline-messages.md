# Multi-line messages (`draft/multiline`): one message, many lines

_Built 2026-08-29 on `multiline-messages`. Design spec:
`docs/archives/2026-08-29-multiline-messages-design.md`. The IRCv3
draft is https://ircv3.net/specs/extensions/multiline._

## What it does

A message can contain line feeds. `Shift+Enter` in the composer starts a new
line (it always did — `ChatInput.vue` submits on `@keypress.enter.exact`, so a
shift-held Enter falls through to the textarea), and with `draft/multiline`
negotiated the whole thing goes out as **one** message: one msgid, one
timeline entry, one set of reactions, one thing to edit or delete. Received
multi-line messages arrive the same way.

Without the capability nothing changes: the text is still split on `\n` and
sent one message per line, byte for byte as before.

## How it works

**Capability** (`client/js/irc/multiline.ts`, `caps.ts`). `draft/multiline` is
in `SEANCE_CAPS.wanted`. Its CAP 302 value (`max-bytes=16384,max-lines=100`)
is parsed by `parseMultilineValue`; `max-bytes` is REQUIRED by the draft, so a
value without a usable one is vetoed through the negotiator's `accept()` hook
and the capability is treated as absent. `max-lines` is only RECOMMENDED —
missing, it means "no line limit". The two capabilities the draft depends on
must be active too — `batch`, which carries the message, and `message-tags`,
without which the `batch` tag never reaches the server:
`IrcClient.multilineLimits()` returns `undefined` otherwise, and that one call
is the gate every other part of the feature is behind.

**Receiving.** `multilineBatch` is registered as the handler for the
`draft/multiline` batch type (`handlers/index.ts`), whether or not the
capability was negotiated — what the server sends, the server sends.
`joinMultiline` joins the buffered lines with `\n`, except where a line
carries `draft/multiline-concat`, which glues it to the previous one with no
separator. The synthetic message takes its tags from the **batch opener**
(msgid, time, `+draft/reply`, `+seance/edit`, …) and the first line's source,
then goes through the ordinary PRIVMSG/NOTICE handler, so CTCP `ACTION`,
highlights, mentions, replies, edits and `echo-message` self-detection all see
the whole text. A malformed batch (mixed commands, mixed targets) falls back
to its lines one by one; a multiline batch nested inside a `chathistory` or
bouncer-replay batch is folded into the parent in its own position, so replays
stay in order.

**Sending.** `dispatchInput` stops splitting on `\n` when the capability is up
and the first line is plain text or one of `/me`, `/notice`, `/msg`, `/query`,
`/say`; any other leading command still runs one command per line.
`planMultiline` turns the text into batches — one line per line feed, a
paragraph over the line budget split into `draft/multiline-concat` chunks that
rejoin to exactly the input, packed under `max-lines` and `max-bytes` —
and `sendMultiline` writes `BATCH +ref draft/multiline <target>`, the tagged
lines, `BATCH -ref`, one whole batch at a time. Client-only tags go on the
opener, as the draft requires; a reply reference repeats on each opener of a
multi-batch plan while `+seance/edit` goes on the first only, because one edit
replaces one message. Without `echo-message` the joined text is synthesised
locally, exactly as the single-line path does.

**One line too long for one message** goes out the same way: a batch of
`draft/multiline-concat` chunks, so a client that speaks multiline shows the
URL, hash or paste as the one line it was, and the server keeps it as one
message. That includes a line that would fit a batch line but not a plain
PRIVMSG once its client tags (a long reply reference) ride on it. A line that
fits one message stays one plain PRIVMSG. Without the capability a long line
becomes separate messages, as before. nefarious2 never splits or rewraps
anything itself: a client body over 512 bytes is an Excess Flood disconnect,
an untagged line it delivers is cut at 510 bytes with the sender's source
counted in (so `sendMessage` budgets our host at nefarious2's `HOSTLEN`, 75,
while the server has not yet named it), and a recipient without multiline gets
each chunk as its own PRIVMSG — the first five, then `[N more lines]`. Where a
run has no space to break at, both splitters cut between two visible
characters (`graphemeCut` in `message.ts`, `Intl.Segmenter`), so an emoji
sequence, a flag or an accented letter is never torn across two lines; one
character larger than a whole line is cut by code point after all.

**Errors** (`handlers/standard-replies.ts`). `FAIL BATCH MULTILINE_*` means
the server threw the whole batch away, so nothing was sent: it becomes an
error line reading "Message not sent: …" in the channel a context parameter
names (`MULTILINE_INVALID_TARGET` names one), or in the lobby shown in the
active window when none does — `MULTILINE_MAX_BYTES` and `MULTILINE_MAX_LINES`
carry the limit rather than a target. The client plans under the advertised
limits, so none of these should ever arrive.

## What the server actually does

Everything below was observed live against AfterNET
(`u2.10.12.14+Nefarious(2.0.0)`); the transcripts are in
`docs/resources/nefarious2-websocket.md` § Multi-line messages.

- Tags sit on the opener exactly as the draft says, and the batch reference is
  rewritten **and reused sequentially** — the server hands the same reference
  out again for the next batch, but only once the previous one has closed,
  never while it is open. A reference is unique only among _open_ batches,
  which is why batches are sent one whole batch at a time.
- CTCP is not interpreted inside a batch, so `\x01ACTION …\x01` is framed per
  line: a client without the capability then sees one action per line rather
  than one action followed by junk.
- Fake lag charges a batch once, at `BATCH -`, not per line.
- **A `WARN BATCH MULTILINE_FALLBACK <target> :Message truncated for N legacy recipients` follows every batch that also reached a client without the
  capability.** It is not in the draft, it is a `WARN` (the message went out),
  and on any populated channel it is every multi-line message — so it is
  swallowed. Shown through the generic standard-reply line it would put a red
  error under every multi-line message the user sends, about something they
  cannot act on.
- **"Truncated" is a misnomer: nothing is lost.** A capability-less peer in the
  same channel receives the lines as ordinary separate `PRIVMSG`s, in order,
  which is what the draft requires of a server. The only difference for such a
  client is that the message is several timeline entries instead of one.
  `test/irc/multiline.live.ts` connects such a peer and asserts it.

## Sharp edges

- **Every batch must be paced past the server's cooldown, timed from its
  delivery, and the gate must outlive the message** (fixed 2026-09-04, in two
  passes). The server charges a cooldown per delivered batch and, for a batch
  opened inside that window, drops the opener while still delivering the batch's
  lines as _standalone_ messages — so the message duplicated, blank lines drew
  `ERR_NOTEXTTOSEND`, and the orphaned closer drew `FAIL BATCH NO_ACTIVE_BATCH`,
  all shown to the user, before the `MULTILINE_COOLDOWN` re-send delivered the
  batch again. Two things went wrong:

  - Pacing on the previous batch's _echo_ alone: the echo comes back in
    milliseconds, long before the cooldown ends, so the next opener went
    straight into the cooldown. The queue now holds a `pace` timer
    (`multiline.ts` `paceAfter`) of `batchCooldownMs` — the undiscounted
    `(2 + bodyBytes/128) s`, a safe upper bound since the server's
    `MULTILINE_COOLDOWN_DISCOUNT` is at most 1.
  - Pacing only _within_ one message's queue, timed from the send. A cooldown
    outlives the message that caused it, so the _next_ message's batch — sent
    while the server was still cooling down, which is what happens once you are
    sending fast enough to be throttled — walked into it. The `pace` gate is now
    set after **every** delivered batch (even the last of a message, so it
    outlives the queue) and timed from **delivery** (the echo, or the settle
    period without `echo-message`), not from the send — so a batch the server
    processes late under throttling still starts its cooldown at the right
    moment.

  The `MULTILINE_COOLDOWN` re-send stays as a backstop for a server whose
  discount somehow exceeds 1. Cost: batches are serialised ~one cooldown apart
  (~15 s per 100-line batch, ~3 s for a short one), whether within a paste or
  across messages sent in quick succession; a future refinement could learn the
  real discount from the first cooldown seen. Regression scenarios:
  `tools/scenarios/multiline-paste.mjs` (a 120-line paste, one message) and
  `tools/scenarios/multiline-throttle.mjs` (six messages back to back); each
  asserts no error rows and no duplicated line.

- `MAX_LINE_BYTES = 500` still caps every line: a batch is many short lines,
  not one long one. `planMultiline` clamps the per-line budget to `max-bytes`
  as well, so it can never plan a line the server would have to reject.
- The `BATCH` opener is not length-guarded — its size is the client-only tags
  plus ~40 bytes, so two msgid-bearing tags reach ~90. A pathological tag set
  would be caught by `WsTransport`'s own guard and surface as "Not sent: …"
  rather than truncate silently.
- Anything that ever wants two batches open at once has to allocate its own
  references carefully: the server reuses one per client, and `handlers/batch.ts`
  replaces the buffer if a reference that is still open is opened again.
- A CR is a line separator, never message content. Under the capability
  `dispatchInput` turns `\r\n` **and a lone `\r`** into `\n` before it looks at
  the text, because the command name, `splitTarget` and `isOneMessage` all
  split on `\n` alone: `/msg bob\r\nhi` used to split no target and send
  nothing, and `/me\r\nwaves` used to leave `me\r` as the command name and fall
  through to the raw send. `planMultiline` still maps any CR that reaches it to
  a space — that is the guard for text arriving from anywhere else. Without the
  capability the input is untouched, so that path is byte for byte what it was.
- A CTCP request whose answer would carry a line feed is not answered
  (`handlers/privmsg.ts`): a multiline `\x01PING …\x01` batch joins into text
  with `\n` in it, and `formatLine` throws on such a parameter — out of the
  handler, where `handleMessage` only logs it and the request line the user
  should see is lost with it. The request is shown; nothing is sent back.
- `client.input` may only be handed multi-line text from the composer. The
  connect-commands loop (`manager.ts`) dispatches one entry per call, which is
  what keeps `/msg nickserv identify …` from being glued to the next line.

## Testing

- `test/irc/multiline.ts` — the capability value, receiving (concat, opener
  tags, ACTION, NOTICE, malformed, nested in `chathistory`), planning and
  sending (line shape, tag placement, chunking, batch splitting, per-command
  behaviour, CRLF normalisation, no-capability fallback, no-echo synthesis),
  the FAIL/WARN replies, and `commands without the cap` — characterisation of
  `/msg`, `/notice` and `/query` target splitting with `draft/multiline` off.
- `test/irc/multiline.live.ts` — one three-line message through a real ircd,
  with a capability-less peer listening. Gated on `SEANCE_IRC_URL`;
  `SEANCE_IRC_CHANNEL` picks the channel. The FAIL paths are deliberately not
  probed live: reaching them means throwing 100+ lines or 16 KB at a real
  server.
- `test/e2e/multiline.spec.ts` — Playwright against the built `public/` tree:
  three lines typed with `Shift+Enter`, one message on screen. Gated on
  `SEANCE_E2E_IRC_URL` (`SEANCE_E2E_CHANNEL` picks the channel).
