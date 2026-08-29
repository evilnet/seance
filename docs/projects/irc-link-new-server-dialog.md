# `web+irc://` links to an unknown server should open an "add server" dialog

_Noted 2026-08-27. Status: idea, not started. Related: `docs/resources/pwa.md`
and `docs/resources/irc-links.md` (installed app receives `web+irc:` links via
`protocol_handlers` → `?uri=`; since 2026-08-28 the scheme is `web+irc:`, not
`irc:`/`ircs:`, and a link's port is a WebSocket port)._

## Idea

When the user opens a link that hard-codes a server and port
(`web+irc://irc.example.org/#chan`, or a `?host=…&port=…` URL) and we do
**not** already have that host + port combination saved, do not just drop
them on the generic connect form. Bring up the "add new server" dialog with
enough context — "This link suggests connecting to irc.example.org:443 and
joining #chan" — and the fields pre-filled from the link. Nothing is saved
until the user chooses to connect/save. If the combination **is** already
saved, connect to (or focus) that network and join the channel.

## Current behaviour

- `client/js/boot.ts` `handleQueryParams()` parses `?uri=` with
  `client/js/helpers/parseIrcUri.ts` (`{name, host, port, join, tls}`) or takes
  the raw query params, then `router.push({name: "Connect", query})`. The same
  path serves later launches of the installed app (`onLaunch` in `pwa.ts`).
- `client/components/Windows/Connect.vue` takes `queryParams` (the accepted
  keys are `CONNECT_PARAMS`, ~L300) and merges them over the branding default
  network / `serverConfiguration.defaults` (~L326-345). It also lists saved
  networks (`saved.list()` from `client/js/irc/saved-networks.ts`, ~L366) but
  does not compare the link against them.
- Locked deployments (`lockNetwork` / branding `features`) pin the host; a
  link to another server must be refused or ignored there, not offered.

## Design notes

- Match on casefolded host + port (+ TLS?) against `saved-networks`; a link
  without a port implies 443 (`parseIrcUri` already does this).
- "Already saved" → if that network is connected, `/join` the channel(s) and
  route to it; if not, connect it, queueing the join (the `join` field of the
  saved entry or a one-off).
- "Unknown" → the add-server dialog (`NetworkForm.vue` is the existing form
  component; a new modal or the `Connect` window in a "suggested by link"
  mode) with a banner naming the origin of the suggestion and the host/port/
  TLS/channel filled in. Save happens only on the user's Connect/Save.
- Security: a link can pre-fill a password / SASL secret via `?saslPassword=`
  today (`CONNECT_PARAMS`). Consider dropping secret fields from link-supplied
  params, and never auto-connecting from a link — the user must click.
- Keep working in a browser tab (no launch queue) and when the app is already
  open in the PWA (launch queue, no reload).

## Done when

- Saved match → connect/focus + join; no match → pre-filled dialog, nothing
  persisted until confirmed; locked deploy → ignored with a message; tests for
  the matcher and for `parseIrcUri` edge cases (no port, legacy `irc:`/`ircs:`,
  channel with key, multiple channels).
