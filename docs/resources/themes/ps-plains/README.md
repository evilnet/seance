# `ps` — peace on the plains: the approved mockup

`mockup.html` is the design the `ps` theme is built from, exactly as the user approved it on
2026-09-24 (published as https://claude.ai/artifact/4n67vQ1gJtPyuHwf22HrGQ, version 9). The spec
that turns it into the theme is `docs/projects/ps-theme.md`; where the two disagree, the spec wins,
because it records what was decided after the page was drawn.

It is one self-contained page: open it in a browser from disk. Only its fonts come from the
network (Google Fonts). It is kept byte-for-byte as approved, so prettier skips it
(`.prettierignore`).

## What in it is the design, and what is comparison chrome

The **window at the top** is the design: the scene, the glass panels over it, the message rows,
the embers on Send and React, and the private view. Everything **below the window** is the
brainstorm around it: the type picker, the four effect candidates, the three private-message
backgrounds and so on. Only the options marked "your pick" are decided; the others were
rejected and stay only so the page reads as it did.

The mockup is px-sized and puts its colour logic in page script. The theme follows the repo's
conventions instead (rem, a Vue-free engine module); see the spec.

## Driving it

The bar under the window scrubs the hour, plays a day, jumps to now, flips to right-to-left and
switches between `#plains` and the private conversation with `wren`; the moon bar under it sets the
date. The same states can be opened directly with hash parameters, which is how the renders in
the brainstorm were taken:

| Parameter          | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `t=<minute>`       | local minute of the day, 0–1439 (`t=1150` is 19:10)                      |
| `date=YYYY-MM-DD`  | the date: season, day length, weather and moon                           |
| `wx=<state>`       | force the weather: `clear`, `rain`, `storm`, `wind`, `snow`, `heat`      |
| `pm=frost`         | open the private conversation (`sky` and `glass` are the rejected ones)  |
| `pmm=still`        | still behind the frost (the choice; `drift` is the rejected alternative) |
| `words=`, `names=` | type faces; the decided pair is the default (`mulish`, `fraunces`)       |
| `rtl`              | right-to-left                                                            |

For example `mockup.html#t=1150&date=2026-01-15&wx=snow&rtl`.
