# `ps` — inside the yurt: the approved mockup

`mockup.html` is the room the `ps` theme shows in a private conversation, as the user approved it
on 2026-11-14 ("The interior looks great … otherwise ready to start integrating"; published as
https://claude.ai/artifact/CDWCcCLXB1CeXpwBnPVBVV, version 8). The design that turns it into the
theme is `docs/projects/ps-yurt.md`; where the two disagree, the design wins, because it records what
was decided after the page was drawn.

It is one self-contained page: open it in a browser from disk. Only its fonts come from the network
(Google Fonts). It is kept byte for byte as approved, so `.prettierignore` names it.

## What in it is the design, and what is comparison chrome

The **room** is the design: a round yurt in 3D seen from one eye standing 1 m inside the door — the
roof poles running to the crown, the lattice wall, the two painted posts, the round stove under the
crown with its pipe through it, the wide back window with its curtains and the two side windows,
the big round rug, and the furniture standing along the round wall and turning with it (the
wardrobe, the desk and computer, the painted chests with the lamp, the four-poster bed, the
kitchen; by the door the washstand and the robe on its hooks), the dining table and its chairs on
the rug. Everything **around** the room is the brainstorm: the "Today: frosted plains" view, the
"Stove at the far end" camera, the chat glass choices and the fire's flicker.

The mockup is px-sized on a fixed 1280 × 800 frame (390 × 844 for the phone, a crop of the same
room around the stove), colours the window views from its own three-hour table (`skyFor`, noon,
18:00 and 21:00) and four weathers, shades the night with SVG masks, and animates nothing by
default. The theme follows the repo's conventions instead (the scene's custom properties, the
engine's weather, its tiers and groups); see the design.

## Driving it

The controls under the frame choose the view (today's frosted plains, the stove in the middle, the
stove at the far end), the hour, the weather in the windows, the chat glass (none, as built, lighter,
hidden), desktop or phone, and the fire (still or flickering). "No glass" is a preview only: the
app always puts a private conversation on glass.

## The changes the user asked for, in order (2026-11-13 to 14)

1. A first room drawn flat, then the furniture turned with the round wall ("there are no corners").
2. More perspective: the whole room in 3D from one eye inside the door.
3. A taller dining table fully on the rug or off it, a bigger and fancier bed, wall rugs below the
   roof line, a bigger back window and two side windows, no black bar across the fire, no second
   rug, a round stove ("aesthetically better with the round room").
4. The bed rebuilt so it reads as one piece, then made a true four-poster.
5. The back window enlarged to 3.1 m by 1.45 m.
