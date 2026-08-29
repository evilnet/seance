# Logo and icons

Seance ships the commissioned ghost artwork. This is how it was prepared, what each
file is for, and the one place it falls short. For the deploy-rebranding contract —
which files a network overwrites with its own — see `branding.md`.

![The logo and icon set](logo-board.png)

## What was done to the source art

The source is a 1584×2816 wallpaper-format JPEG: the ghost over a near-black
background with a faint blueprint grid, and a "Seance" wordmark below it.

**The wordmark is trimmed.** There is a clean 141px empty band between the art (rows
945–1578) and the wordmark (rows 1720–1874), so the cut at row 1650 is unambiguous.

**The background is keyed out.** It sits on `RGB(10,11,16)` and the grid never
exceeds L≈13, so it lifts cleanly. The art is treated as what it physically is —
light emitted over black: alpha comes from the brightest channel and the colour is
un-premultiplied, so over a dark background it reproduces the original exactly. The
grid's vertical lines (116px pitch, 2.96 levels of contrast) are modelled and
subtracted separately, because they survive a flat black point wherever the artwork's
glow lifts them back above it.

Nothing else is altered. Every icon is this artwork composited onto an opaque
`#0D0E14` tile.

## The transparent PNGs are dark-background only

`logo-art.png` and `logo-art-wide.png` carry alpha, but additive glow cannot survive
on a light background — the translucent body and the eyes both disappear. This is
inherent to how the artwork was painted, not to the extraction.

Everything the app actually renders (`logo-tile.png` and the icons) carries its own
dark background for exactly this reason, so it is safe on any theme. Use the bare
PNGs only where you control the surface.

## Small sizes do not work

- **48px and up:** fine. The PWA, apple-touch and maskable icons all read well.
- **32px:** soft.
- **16px:** a smudge. The composition has five speech bubbles, a waveform and a
  translucent body; that cannot be represented in 256 pixels.

So the browser-tab favicon is indistinct. That is a real cost and it is accepted
deliberately, in exchange for using the artwork as drawn.

Two things were tried and rejected. **Tighter crops** are worse — cropping to the
ghost's head loses the trailing tails, which are the thing that reads as a ghost, and
it becomes a dark blob with neon rectangles beside it. **A vector redraw** went
through three passes and never looked good enough next to the original; it is in the
history of the `logo-preview` branch if it is ever worth revisiting.

The favicon leans on the alerted variant to carry meaning instead: `favicon-alerted.ico`
adds a red dot, which is legible at 16px even when the artwork under it is not, and
`client/js/vue.ts` swaps to it while there are unread highlights.

## Files

| File                                                        | Used by                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `client/favicon.ico`                                        | Browser tab (16/32/48)                                             |
| `client/img/favicon-alerted.ico`                            | Browser tab while highlighted — same art plus a red dot            |
| `client/img/icon-192.png`, `icon-512.png`                   | Manifest `purpose: any`; also the notification icon                |
| `client/img/icon-maskable-192.png`, `icon-maskable-512.png` | Manifest `purpose: maskable`; art inside the central 80%           |
| `client/img/apple-touch-icon-{120,152,167,180}.png`         | iOS home screen; the two Windows `msapplication-square*logo` tiles |
| `client/img/logo-tile.png`                                  | Sidebar (45px) and the loading splash                              |
| `client/img/logo-art.png`, `logo-art-wide.png`              | Bare artwork, transparent. Not referenced by shipped markup        |

## Gaps

- **No Safari pinned-tab icon.** `mask-icon` requires a single-colour SVG silhouette,
  which raster artwork cannot supply. The `<link>` was removed rather than left
  pointing at TheLounge's file; Safari falls back to the favicon.
- **No notification badge.** A badge must be a monochrome silhouette. Thresholding
  the artwork's alpha gives an unrecognisable blob, so `badge:` was dropped from both
  notification call sites and only `icon:` is set.
- **No lockups.** The app used to ship `logo-horizontal-*` and `logo-vertical-*`,
  which combined the old mark with a wordmark. The wordmark here was trimmed off, not
  re-typeset, so there is no equivalent — the sidebar and splash use the square tile.
- **`logo-art-wide.png` is 672KB**, and `icon-512.png` 281KB. Neither is on the
  critical path (`logo-art-wide.png` is unreferenced; the 512 icon is fetched only on
  install), but both would benefit from `pngquant`/`oxipng`, which are not on the dev
  box.
- **`theme-color` is still `#415364`**, TheLounge's slate, matching the app's
  `--body-bg-color`. The icon tiles are `#0D0E14`. Changing it would recolour the
  browser chrome and the PWA splash, so it is left as a separate decision.

## Regenerating

The pipeline is not checked in — it lives in the gitignored `tmp/logo/`. `extract.py`
does the wordmark trim and the background keying; `build-app.py` produces every file
in the table above from the extracted square crop. Both need the source JPEG.
