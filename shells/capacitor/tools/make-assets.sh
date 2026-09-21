#!/bin/sh
# Builds the source images @capacitor/assets wants from the web app's logo
# (docs/resources/logo.md): the ghost artwork on its dark tile.
#
#   assets/icon-only.png   1024x1024, art on #0D0E14 — the same tile every web
#                          icon uses, art at 92% like client/img/icon-512.png
#   assets/splash.png      2732x2732, art centred on the same tile: the
#                          launch screen cannot know the user's theme, so it
#                          shows the logo on its own colour rather than a
#                          guess at the chat's (capacitor.config.ts agrees)
#   assets/splash-dark.png the same
#
# Then `corepack yarn assets` (= npx capacitor-assets generate) writes every
# iOS / Android size into the native projects. A rebrand replaces the three
# files in assets/ (or reruns this with its own art and colours) and runs
# the generator again.
#
# Usage: tools/make-assets.sh [art.png] [tile-colour] [splash-colour]
# Needs ImageMagick 7 (`magick`).
set -eu
cd "$(dirname "$0")/.."
ART=${1:-../../client/img/logo-art.png}
TILE=${2:-#0D0E14}
SPLASH=${3:-#0D0E14}

magick -size 1024x1024 "xc:$TILE" \( "$ART" -resize 944x944 \) -gravity center -composite \
	-depth 8 -strip assets/icon-only.png
magick -size 2732x2732 "xc:$SPLASH" \( "$ART" -resize 640x640 \) -gravity center -composite \
	-depth 8 -strip assets/splash.png
cp assets/splash.png assets/splash-dark.png
magick identify assets/icon-only.png assets/splash.png assets/splash-dark.png
