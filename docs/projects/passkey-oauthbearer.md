# Passkey sign-in: WebAuthn via Keycloak + SASL OAUTHBEARER

_Noted 2026-08-27. Status: idea, not started. Reference:
[WebAuthn for IRC Authentication: Feasibility Assessment](https://gist.github.com/MrLenin/3fe0af3345dd4e6c4774b2dbf4ce6256)
— this is **option A** of that document._

## Idea

Let users authenticate to Seance (and so to the network) with a passkey. The
passkey ceremony happens in the identity provider, not in IRC: Keycloak does
WebAuthn, mints a JWT, and the client presents that JWT to the ircd with the
SASL `OAUTHBEARER` mechanism the nefarious2 fork already implements.

## Option A as described in the assessment

- **Stack:** Keycloak 26.4 (realm WebAuthn policy, OIDC endpoints), nefarious2
  fork (advertises SASL `OAUTHBEARER` by default; validates the JWT locally
  against the realm JWKS, `exp`/`nbf`, and a hardened issuer + allowed-client
  policy — `KEYCLOAK_ISSUER` / `KEYCLOAK_ALLOWED_CLIENTS`), X3 with LDAP
  federation. **ircd code changes: zero**, but prod needs configuration (see
  "Network setup").
- **Web client flow:** open the app → OIDC redirect or popup to Keycloak →
  passkey ceremony runs natively in the browser → Keycloak returns an access
  token (JWT) → client opens the WebSocket and sends
  `AUTHENTICATE OAUTHBEARER` with the token → ircd validates and logs the
  connection in.
- **Native/TUI clients** use the OAuth device-code flow (URL + code, approve
  in any browser, poll the token endpoint) — not our concern for the SPA but
  the same token ends up on the wire.
- **Pros:** configuration-only on the server side; Keycloak already has mature
  WebAuthn + conditional UI; WebSocket clients confirmed working.
- **Open questions from the doc:** token lifetime **is** the reconnect UX
  (test bed uses 7-day access tokens; production policy TBD); the WebAuthn RP
  ID must be a stable real hostname (container-IP issuers don't work with
  passkeys); OAUTHBEARER support is thin across the IRC client ecosystem.
- Option B (unify cert auth behind Keycloak too) is a later extension; option
  C (a bespoke SASL-FIDO2 mechanism) is rejected — watch
  [ircv3-specifications#597](https://github.com/ircv3/ircv3-specifications/pull/597)
  (OIDC CIBA) as the standards-track alternative.

## Network setup

The ircd accepts a token only if it came from the expected issuer and an allowed
client. In `sasl_handle_oauthbearer`, after the JWKS check of signature and
expiry, `oauth_token_policy_ok` requires:

- `iss` to equal the `Keycloak {}` block's `issuer` (Keycloak's front-end issuer
  URL, not necessarily the internal `KEYCLOAK_URL`);
- `azp`, the client that requested the token, to be in `allowed_clients`.

If either setting is missing, every token is rejected unless
`insecure_token_validation = yes`, which is for development only. The test bed
runs insecure, so **a sign-in that works on the bed proves nothing about this
policy**; test with it off. A deploy therefore needs:

- Keycloak clients for Seance, all public with the browser flow and PKCE. The
  recommended split is `seance-web` (redirect URI on Seance's origin) and
  `seance-app` (the app's return address), so each can have its own lifetimes
  and be revoked separately;
- those client ids added to prod's `allowed_clients`;
- prod's `issuer` set.

The ircd checks `azp` and never sees where a page was loaded from. What ties a
client to a place is the redirect URI list in Keycloak, so an app needs no web
server, only a registered return address. OAUTHBEARER therefore works only for
registered clients:

- a web deploy on an unregistered origin cannot complete sign-in;
- a rebranded app needs its return address registered, and its client id in
  `allowed_clients` if it has its own client;
- other IRC clients need their own client id, probably with the device-code
  flow.

PLAIN is unaffected for as long as the network keeps it enabled. This is not
proof that a client is the real Seance: a public client id is not secret and
another app can claim a custom scheme. PKCE stops an intercepted code being used
by anything but the client that started the flow, but a look-alike app can still
run its own flow under the same client id.

## Does this need a server?

No. The static page runs the PKCE flow itself as the public client above and
sends the token over its own WebSocket. ibutsu first suggested Seance needed a
web server for this; asked about it (2026-11-04), ibutsu described this setup
for a static page: its own Keycloak client plus the prod configuration above.

A server remains an option only if token handling in the browser proves too
messy:

- A proxying backend-for-frontend would have to proxy the WebSocket. That is a
  bouncer, which Seance exists to avoid.
- A token-mediating backend (cookie session → access token) is the only shape
  that fits. It would be the single refresh-token holder and a confidential
  client, at the cost of a server every network has to run on the app's site. An
  access token still reaches the browser.

The [IETF browser-based apps draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)
does not recommend browser-only clients for sensitive apps. The comparison that
matters here is today's remembered SASL password in browser storage; a
revocable, scoped token is an improvement on that.

## What Seance needs

- **SASL:** `client/js/irc/sasl.ts` knows `PLAIN` and (untested) `EXTERNAL`
  (`SaslMechanism`, `mechanismOffered()` against the CAP 302 `sasl=` value).
  Add `OAUTHBEARER` (RFC 7628): the initial client response is
  `n,a=<authzid>,\x01host=<host>\x01port=<port>\x01auth=Bearer <token>\x01\x01`,
  base64'd and chunked at 400 bytes like PLAIN (`MAX_LINE_BYTES` applies).
  Handle the server's error JSON + `AUTHENTICATE +` / `904` failure path;
  `SaslAuth` currently aborts on any challenge other than `+`. A
  `904 token rejected by server policy` is a deploy misconfiguration, so report
  it rather than fetching a new token and retrying. The ircd caps the base64 at
  `SASL_DATA_MAX` (4096 bytes, about 3 KB of raw token); measure a real token,
  since roles and groups inflate it.
- **Token acquisition:** an OIDC Authorization Code + PKCE flow in the SPA
  (no client secret in a static app). Redirect back to the app (`start_url`
  scope; hash router — the callback must survive `#/…`) or a popup;
  `oidc-client-ts` or a hand-rolled ~200-line flow (E.1 purged deps; keep it
  small). Store the refresh token in localStorage (`thelounge.*` keys) so the
  reconnect path (`IrcClient` reconnect/backoff, `applySettings`) can obtain a
  fresh access token silently before each `AUTHENTICATE`. A plain refresh token
  dies with the SSO session (`SSO Session Idle` / `SSO Session Max`), so silent
  reconnects after a long gap need `offline_access` or long sessions; Keycloak
  exempts offline tokens from both timeouts, so choose their lifetime
  deliberately. The client's Web Origins must allow Seance's origin for CORS on
  the token call.
- **Service worker:** it opens its own SASL connection for push replies, from a
  login stashed in IndexedDB, and that path is hardcoded to PLAIN
  (`client/service-worker.js`). It needs a token too. Page and worker refreshing
  one rotating refresh token would race and could revoke it, so serialize them,
  give the worker its own token, or leave rotation off.
- **Branding/config:** `config.json` gains an `auth` block (issuer URL,
  client id, scopes, whether passkey login is offered/required) —
  `client/js/branding.ts` + `docs/resources/branding.md`. The connect form
  (`Windows/Connect.vue`, `sasl` select) grows a "Sign in with passkey"
  option beside PLAIN.
- **PWA:** the OIDC redirect must work inside the installed app
  (`docs/resources/pwa.md`; in-scope redirect URI). It runs from a web origin, so
  it uses the web client.
- **Tauri shells:** they bundle `public/`, so there is no origin to authorize.
  Follow RFC 8252: open Keycloak in the system's sign-in browser
  (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android) with PKCE, and
  return to the app through a registered address such as `chat.seance.app:/oauth`.
  The passkey ceremony runs in that browser; confirm it on a device. No in-app
  sign-in page: the shell's CSP sets `frame-src 'none'` and `form-action 'none'`.
  A claimed https link (Universal Links/App Links) is stronger than a custom
  scheme but needs a static file on a domain the network controls.
  - The page origin is not https, so CORS may refuse the token call and the
    exchange may have to run on the Rust side.
  - Still to build: the system browser session, a return scheme (`deep-link`
    only claims `irc`/`web+irc` today, with `appLink: false`), and token storage
    in the Keychain/Keystore. `tauri-plugin-opener` can open an external browser
    but is not a sign-in session.
- **Dev environment:** `tools/nefarious-dev` has no services and no Keycloak
  (`docs/resources/nefarious2-dev.md`); a Keycloak container with a WebAuthn
  realm and a real hostname is needed to exercise this locally, plus the
  ircd's `KEYCLOAK_*` features set, with `issuer` and `allowed_clients`
  configured and insecure validation off. Record the setup in a resources doc.

## Done when

- Connect form offers passkey sign-in on a branded deploy; a passkey login
  yields `900 RPL_LOGGEDIN`; reconnects re-authenticate without user
  interaction while the refresh token is valid; token expiry produces a clear
  "sign in again" state instead of a silent auth loop; unit tests for the
  OAUTHBEARER encoder and the SASL state machine (`test/irc/sasl.ts`).
