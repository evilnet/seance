# Optional inline image / GIF / video preview

_Noted 2026-08-27. Status: partly exists; this tracks the gaps. Related:
`notifications.md` (same privacy stance for remote images), `network-icon.md`._

## Idea

Show images, GIFs and short videos inline under the message, optionally —
off by default or click-to-load where privacy matters, on for networks that
want a chatty, media-rich feel — and cover the links people actually paste
(YouTube, imgur/giphy/tenor pages, Mastodon posts…), not only bare
`https://…/x.png` URLs.

## What exists (plan item D.9, done 2026-08-24)

- `client/js/helpers/mediaPreview.ts`: direct media URLs only, detected by
  file extension (`imageExtensions` / `videoExtensions` / `audioExtensions`),
  `https:` only, `MAX_PREVIEWS_PER_MESSAGE = 5`. No metadata fetch — the
  browser cannot `HEAD` or read `Content-Type` cross-origin without CORS, so
  `size` is `-1` and there is no size cap.
- `client/components/LinkPreview.vue` renders `<img>` / `<video>` / `<audio>`
  (video/audio not autoplayed, native controls); `ImageViewer.vue` opens
  images full-screen; `LinkPreviewToggle.vue` collapses per preview and
  `msg:preview:toggle` state is local.
- Settings (`client/js/settings.ts`): `links` (show link previews at all) and
  `media` (show media inline). Both default **on**.
- An `ExternalPreviewResolver` hook was left in `mediaPreview.ts` for a
  deploy-time preview service (the thing TheLounge's server used to do:
  fetch the page, read OpenGraph/oEmbed, proxy the thumbnail). Nothing
  implements it.

## Gaps

1. **Page links.** Anything that is not a direct file gets no preview. With
   no server, options per host:
   - **URL rewriting for well-known hosts, no fetch needed**: YouTube /
     youtu.be → `https://i.ytimg.com/vi/<id>/hqdefault.jpg` thumbnail +
     click-to-embed `youtube-nocookie.com` iframe; imgur `/<id>` →
     `i.imgur.com/<id>.jpg`, `.gifv` → `.mp4`; giphy/tenor page → media CDN
     URL patterns; Twitch clips, Vimeo (`vumbnail`), Reddit `i.redd.it`. A
     small table in `mediaPreview.ts` with tests; degrade to a plain link.
   - **Open APIs that allow CORS**: e.g. Mastodon/Fediverse status JSON,
     giphy/tenor JSON (need API keys → per-deploy `config.json`).
   - **Optional external resolver** (the existing hook): a deploy can point
     `config.json` at a tiny stateless service (`GET /preview?url=` →
     `{type, thumb, title, description, media}`) that does what the attic
     `attic/server/plugins/irc-events/link.ts` did. Keep it out of this
     repo or ship it as `tools/preview-service/` — decide.
2. **GIFs.** Today an animated GIF/WebP autoplays as an `<img>`. Add a
   policy: autoplay / play on hover / click-to-play (`prefers-reduced-motion`
   → never autoplay), and prefer `.mp4`/`.webm` variants when a host offers
   them (imgur `.gifv`, giphy `.mp4`) — far cheaper than GIF. _Found
   2026-09-05:_ "animated WebP doesn't animate" was not a display problem
   at all — the upload path's canvas re-encode (the "remove metadata"
   setting) flattened it to one frame before it left the browser. Fixed in
   `client/js/upload.ts` via `helpers/animatedImage.ts` (header sniff for
   WebP/APNG/AVIF sequences, which now skip the re-encode like GIF).
3. **"Optional" — three levels, in this order of precedence:**
   - deploy default in `config.json` (`features.mediaPreviews: "on" | "click" | "off"`, plus an allow-list of hosts) — `client/js/branding.ts`,
     `docs/resources/branding.md`;
   - user setting (`media` today → a select with the same three values;
     `links` stays for text previews if a resolver exists);
   - per-channel override in the context menu (a `#nsfw` channel on
     click-to-load, a `#pics` channel on autoplay), stored with the other
     per-channel prefs (`thelounge.*` keys).
4. **Privacy & safety.** Loading a preview discloses the reader's IP and
   user-agent to the media host. _Mostly done 2026-08-28:_ previews are
   click-to-reveal by default (`mediaReveal` setting, `"click"` |
   `"always"`): `LinkPreview.vue` renders a fixed-height placeholder card
   (kind icon, "Image from i.imgur.com", file name) and mounts nothing that
   fetches until the reader clicks it, or trusts a scope through the
   "Always show ▾" menu: the host, the channel it was posted in, or the
   sender's services account (from the `account-tag`; never the nick —
   `client/js/helpers/mediaTrust.ts`, `mediaTrustMenu.ts`,
   `thelounge.media.trusted`, managed in Settings → Appearance). Revealed
   media has a hover toolbar (hide again, change that trust, open); own messages skip the veil; a
   failed load falls back to the card; `ImageViewer` only steps through
   revealed images; `client/index.html` sets a document-wide no-referrer
   policy, the only one video and audio obey. Still open: `loading="lazy"`; a
   deploy-level default / allow-list in `config.json`; hide previews from
   ignored/muted users; blur-until-click as a middle ground. Note the
   existing `uploadCanvas` idea for strip-metadata uploads is unrelated to
   previews.
5. **Layout.** Cap rendered height/width (CSS exists from TheLounge), show a
   fixed-size placeholder so history doesn't jump while media loads, keep
   the collapse toggle, and make the scroll-anchor logic in `MessageList.vue`
   tolerate late-loading media (`onload` → re-anchor).
6. **Video/audio**: keep `preload="metadata"` off unless autoplay is on
   (bandwidth on phones); PWA installed on cellular → default to
   click-to-load (`navigator.connection.saveData`).

## Done when

- Well-known-host table with tests; GIF policy setting honouring
  `prefers-reduced-motion`; three-level opt-in (deploy / user / channel);
  click-to-load placeholder; documented `config.json` keys; the external
  resolver contract written down in `docs/resources/branding.md` even if no
  service ships.
