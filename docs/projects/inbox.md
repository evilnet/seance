# Inbox: unread mentions on every device

_Noted 2026-10-23. Issue: [evilnet/seance#125](https://github.com/evilnet/seance/issues/125).
Status: step 1 (client-only) built; step 2 (server) to be proposed on the issue._

## Goal

One list of the messages that mentioned you, the same on every device, those
you have not read counted and the rest dimmed, with reading them anywhere
clearing the count. The server stores
little and cleans up after itself.

## Shape

An **inbox entry** is a reference to one message:

| field     | what                                              |
| --------- | ------------------------------------------------- |
| `network` | the saved network's uuid                          |
| `target`  | the channel or query name, as the client shows it |
| `msgid`   | the IRCv3 `msgid`, when the server sends one      |
| `query`   | set for a private conversation                    |
| `time`    | the message's `@time` (server time)               |
| `from`    | the sender                                        |
| `type`    | the message type (message, action, notice)        |
| `text`    | the text, kept only to display it (see Excerpt)   |

Its **key** is `network/msgid`, or `network/target/time/nick` on a server
without `message-tags`. Never a session-local id from `irc/ids.ts`: those change on
every page load. A **private conversation is one entry** (key
`query:network/target`): Seance counts every line of a query as a
highlight, so one entry per line filled the list with what the sidebar's
unread badge already says. The newest line replaces the one before, and
the pane shows it with the conversation's unread count ("7 unread").

**Read rule:** an entry is read, and stays in the list dimmed and out of every
count (`read`), once its target's read point passes its `time`, or once it is
opened. It leaves when closed with its ×, by Dismiss all, or 7 days after it was
said if read (counted from the line, checked when the page loads). A conversation shows its newest three rows, newest first, with "Show N more" under them for
the rest (`ROWS_PER_GROUP`), which keeps that order. Discord's mentions are the model. What is unread is
kept ahead of what is read when the caps fill. The read point is the one `handlers/markread.ts`
`moveReadMarker` keeps: our own reading (opening the conversation, or the
window coming back to it), a `MARKREAD` from another session of the account,
and our own message in a history page. Dismissing an entry by hand removes it
on this device only.

## Step 1: client-only (no server change)

Every device builds the same list from what the server already gives it:

- **Live** highlights, and **catch-up** highlights: the `CHATHISTORY AFTER` /
  bouncer replay appended after a reconnect (`history.ts` `deliverAppend`) and
  the first history page of a cold load past the read marker
  (`countPageUnread`), all as the `inbox:add` bus event. Only what counted as
  unread, only in a channel or a query (the lobby has no read point). A muted
  conversation's are kept but not shown or counted. Older scrollback is never added.
- **Marked read** by the `inbox:read {network, target, time}` bus event that
  `moveReadMarker` dispatches whenever the read point moves, and by
  `inbox:drop {network, target, msgid, by?}` when the message is deleted
  (`REDACT`) or replaced by its author's edit, whether or not the page has
  it loaded (an edit is dropped only when `by` sent the entry's message).
- **Dismissed** on this device: the entry goes, and its key and time are
  remembered (`thelounge.mentions.dismissed`, 200 at most) so the next
  catch-up does not bring it back, until the conversation is read past it.
  A dismissal holds back what it covered, not a later line under the same
  key: a private conversation's next message comes in. Parting a channel
  or closing a query dismisses its entries, so a rejoin's catch-up does
  not bring them back either.
- **Muted** conversations keep their entries, hidden (`visibleMentions`)
  and left out of every count; unmuting shows those still unread. A
  deliberate choice: muting is about not being interrupted, and the
  per-conversation cap keeps a muted channel from crowding the rest out.

**One count.** The @ button's badge, the page title, the favicon and the
app icon all read `mentionCount` (the entries shown). The per-channel
highlight counters still drive the sidebar's badges. A highlight in the
lobby (a notice, say) badges no icon, since no read point clears it. The
service worker's badge for a closed page counts its notifications, as
before.

**Opening an entry** takes the conversation to the mention: `Mentions.vue`
sets `store.state.jumpTarget`, and `MessageList.vue` scrolls it to the middle
with a flash. A quote's parent and a search hit go the same way. A line older
than what is loaded opens a **past view** (`client/js/pastView.ts`): one
`CHATHISTORY AROUND` of up to 100 lines, kept in `channel.past` and shown in
place of `channel.messages`, which stays one unbroken run and goes on taking
live lines, the unread count with them. Scrolling to either end asks for the
next page. The bar over the composer says the reader is among older messages,
with Jump to present; scrolling off the newest end, Escape, or sending gets
there too. While the lines are on their way the bar says that. A past row offers
no Edit, since an edit's place is the recent lines, but others' edits, reactions
and deletions reach it (`msg:changed`). An edit and its original that come on
different pages are placed as on one page (`linkEdits`). A deletion in a later
page does not reach a line loaded after it. A page is asked from the previous
page's outermost line, rows or not (`edges`), so a page of reactions alone moves
on rather than ending that side; only an empty page or the end tag ends it. Nothing of a past view is kept: leaving the
channel closes it. A line the server does not have says so and stays put. The
logic is `helpers/jumpToMessage.ts` and `helpers/pastRows.ts` (Vue-free,
`test/helpers/`).
That mention dims. The conversation is not read yet: `helpers/readHold.ts` holds it until the list reaches the bottom, so the other mentions stay unread and lines arriving meanwhile count as unread. Leaving before the bottom ends the hold with nothing read; opening it again reads it, as opening it from the sidebar does. What the user says there, and a read from another session, still read it.
A group whose conversation this page does not have (a channel left, a
network not on this page) cannot be opened and says why under its name.

**Excerpt.** The pane clamps an entry to three lines. A line whose mention
starts past 60 characters (three lines hold fewer than 80 on a phone at the large text steps) is kept from a word about 30 characters before
it, with an ellipsis, and without its IRC formatting (a cut could leave a
style half open). The match is the highlight rule's own
(`highlight.ts` `mentionIndex`), run when the entry is made.

Stored in `thelounge.mentions`: 100 entries, 20 per conversation, oldest
out first; not carried by the settings backup. Lists stored by an
earlier build, keyed by session-local ids, are dropped on load. Logic in
`client/js/helpers/inbox.ts` (Vue-free, `test/helpers/inbox.ts`);
`client/js/mentions.ts` is the store glue.

Limits of step 1:

1. A dismissal does not reach the other devices (a read marker clears up to
   a point, not one message).
2. Only what this device fetched: the bouncer replay stops at 100 lines per
   target, and a channel you have left is never fetched.
3. Custom highlight words are this browser's; another client may disagree.

## Step 2: a server-kept inbox

Not built. Step 1's entry shape (network, target, msgid, time) is what a
server list would carry, so a network whose server one day offers one can
read its entries from there and keep step 1 as the fallback. The proposal
belongs on the issue, not here.
