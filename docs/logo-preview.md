# Seance logo — proposal

A first pass at turning the commissioned ghost artwork into a usable logo and icon
set, to replace the inherited TheLounge mark. **Nothing here is wired into the app
yet** — these files are staged under `docs/logo/assets/` so they have no effect on
the webpack build. See [Adopting it](#adopting-it) below.

## 1 — the artwork, wordmark trimmed, background keyed out

![The mark, extracted](logo/board-1.png)

The source is a 1584×2816 wallpaper-format JPEG. There is a clean 141px empty band
between the art (rows 945–1578) and the "Seance" wordmark (rows 1720–1874), so the
cut at row 1650 is unambiguous.

The background is `RGB(10,11,16)` with a faint blueprint grid that never exceeds
L≈13, so it keys out cleanly. The art is treated as what it physically is — light
emitted over black: alpha comes from the brightest channel, colour is
un-premultiplied. Over a dark background it reproduces the original exactly.

The grid's vertical lines (116px pitch, 2.96 levels of contrast) are modelled and
subtracted separately, because they survive inside the glow field where the artwork
lifts them back above the black point.

> **Caveat, visible top-right on the board above:** this cut only works on dark
> backgrounds. Additive glow cannot survive on white — the ghost's translucent body
> and its dark eyes both disappear. That is inherent to the artwork, not to the
> extraction. The raster is for dark UI; the icon tiles below carry their own dark
> background.

## 2 — icon set

![The icon set](logo/board-2.png)

The original genuinely falls apart below ~96px (see the 32px sample on board 1), so
the small sizes are a **vector redraw** rather than a downscale. Palette sampled from
the artwork itself: cyan `#35E1FF`, violet `#7E4FFF`, tile `#0D0E14`.

Two variants — `logo-mark.svg` (ghost + two bubbles, good down to ~48px) and
`logo-mark-tiny.svg` (ghost only, still reads at 16px). The bubbles are knocked out
of the ghost with a gap rather than overlaid, so the mark works on any background.

Verified: the maskable icon's content survives circle, squircle and rounded-square
crops, and every SVG was rendered in headless Chromium to confirm the masks and
gradients match Inkscape.

## Assets

| File | What it is |
| --- | --- |
| [`logo-mark.svg`](logo/assets/logo-mark.svg) | Primary mark — ghost + bubbles, transparent, 48px and up |
| [`logo-mark-tiny.svg`](logo/assets/logo-mark-tiny.svg) | Ghost only, for ≤32px |
| [`logo-mono.svg`](logo/assets/logo-mono.svg) | Single-colour silhouette, Safari pinned tab |
| [`logo-art-wide.png`](logo/assets/logo-art-wide.png) | Extracted artwork, 1286×659, transparent — dark UI only |
| [`logo-art.png`](logo/assets/logo-art.png) | Square crop, waveform tails dropped |
| [`favicon.ico`](logo/assets/favicon.ico) | 16 / 32 / 48 |
| [`icon-192.png`](logo/assets/icon-192.png), [`icon-512.png`](logo/assets/icon-512.png) | PWA, `purpose: any` |
| [`icon-maskable-192.png`](logo/assets/icon-maskable-192.png), [`icon-maskable-512.png`](logo/assets/icon-maskable-512.png) | PWA, `purpose: maskable` |
| `apple-touch-icon-{120,152,167,180}.png` | iOS home screen, opaque |
| `tile-*.svg` | Vector sources for the raster tiles |

Regenerable from the source art via `tmp/logo/extract.py` (keying) and
`tmp/logo/build.py` (icon set). Those live in the gitignored `tmp/` and are not
committed.

## Adopting it

Not done yet — it needs a decision on the design first. When it is, it touches:

- `client/index.html` — favicon, `mask-icon`, four `apple-touch-icon`s, two
  `msapplication-square*logo` tiles
- `client/service-worker.js` — the precache list and the notification `badge`/`icon`
- `client/js/socket-events/msg.ts` — the same notification `badge`/`icon`
- `client/components/Sidebar.vue` — `logo-horizontal-*` / `logo-*-transparent-bg`
- `client/manifest.webmanifest` — icon entries, and a `maskable` entry which does
  not exist today
- `msapplication-TileColor` and `themeColor` are currently `#415364`, which no
  longer matches; `#0D0E14` would

Two things worth fixing before it ships:

- `logo-art-wide.png` is 672KB. It wants optimizing (no `pngquant`/`oxipng` on the
  dev box) or serving at a smaller pixel size.
- The app still ships `logo-horizontal-*` and `logo-vertical-*` lockups, which
  combined the old mark with the wordmark. Equivalents don't exist yet — the
  wordmark was trimmed off, not re-typeset.

## Open questions

1. Is the redrawn ghost close enough to the original? The alternative is to stay
   nearer the source — translucent grey-blue body with the neon on the bubbles only
   — at the cost of some legibility at small sizes.
2. Do you want horizontal/vertical lockups (mark + "Seance") rebuilt? That needs the
   wordmark's typeface, which I'd have to match by eye or substitute.
