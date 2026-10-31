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
  federation. **ircd changes: zero.**
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

## What Seance needs

- **SASL:** `client/js/irc/sasl.ts` knows `PLAIN` and (untested) `EXTERNAL`
  (`SaslMechanism`, `mechanismOffered()` against the CAP 302 `sasl=` value).
  Add `OAUTHBEARER` (RFC 7628): the initial client response is
  `n,a=<authzid>,\x01host=<host>\x01port=<port>\x01auth=Bearer <token>\x01\x01`,
  base64'd and chunked at 400 bytes like PLAIN (`MAX_LINE_BYTES` applies).
  Handle the server's error JSON + `AUTHENTICATE +` / `904` failure path.
- **Token acquisition:** an OIDC Authorization Code + PKCE flow in the SPA
  (no client secret in a static app). Redirect back to the app (`start_url`
  scope; hash router — the callback must survive `#/…`) or a popup;
  `oidc-client-ts` or a hand-rolled ~200-line flow (E.1 purged deps; keep it
  small). Store the refresh token in localStorage (`thelounge.*` keys) so the
  reconnect path (`IrcClient` reconnect/backoff, `applySettings`) can obtain a
  fresh access token silently before each `AUTHENTICATE`.
- **Branding/config:** `config.json` gains an `auth` block (issuer URL,
  client id, scopes, whether passkey login is offered/required) —
  `client/js/branding.ts` + `docs/resources/branding.md`. The connect form
  (`Windows/Connect.vue`, `sasl` select) grows a "Sign in with passkey"
  option beside PLAIN.
- **PWA/native shells:** the OIDC redirect must work inside the installed app
  (`docs/resources/pwa.md`; in-scope redirect URI) and in the app shells (Capacitor, Tauri)
  (system browser + custom-scheme return, or an in-app popup).
- **Dev environment:** `tools/nefarious-dev` has no services and no Keycloak
  (`docs/resources/nefarious2-dev.md`); a Keycloak container with a WebAuthn
  realm and a real hostname is needed to exercise this locally, plus the
  ircd's `KEYCLOAK_*` features set. Record the setup in a resources doc.

## Done when

- Connect form offers passkey sign-in on a branded deploy; a passkey login
  yields `900 RPL_LOGGEDIN`; reconnects re-authenticate without user
  interaction while the refresh token is valid; token expiry produces a clear
  "sign in again" state instead of a silent auth loop; unit tests for the
  OAUTHBEARER encoder and the SASL state machine (`test/irc/sasl.ts`).
