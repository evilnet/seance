# tools/heart — the meadow animals' generator

This directory keeps its historical name from the `<3` theme (`heart`), which the `ps` theme
is forked from (`docs/projects/ps-theme.md`). In `ps` the animals are **disabled, not
removed**: the rigs here, the files they generate under `client/themes/ps/` and every scene's
cast stay, and one block after the scene table in `client/themes/ps.css` empties the three
animal slots, so no animal is painted or fetched. Delete that block and they come back.
Everything below still holds for the day they do.

The meadow's animals are silhouettes drawn by a rig and rendered into self-animating SVG
files that the theme paints as background layers (`docs/projects/heart-theme.md`). Nothing
here runs in the browser: the files under `client/themes/ps/` are committed, and this
directory is how they are made.

## Regenerate

    node tools/heart/generate.mjs            # every animal
    node tools/heart/generate.mjs puppy      # one

Read the audit it prints, look at the result, then commit the files. A problem in the audit
leaves the old files in place and exits 1.

## Look at it

    node tools/heart/contact-sheet.mjs puppy          # tmp/heart-puppy-sheet.png
    node tools/heart/contact-sheet.mjs puppy --times=0,5,11,16 --height=220

    node tools/heart/contact-sheet.mjs bird --height=520 --cell=0.5,1.35 --cols=6

    node tools/heart/contact-sheet.mjs --all --out=tmp/sheet-cast.png

`contact-sheet.mjs` photographs one animal's visit through a real browser — twelve cells
across the window it is visible, each one a slot like the theme's over the theme's sky and
ground, the stage's background-position tracked so the animal is in the middle of its cell
rather than 1/24 of it — and stitches them into one PNG you can read pose by pose. Times are
seconds after the sequence's `first`, the same clock as the audit's `onStage` and `tExit`.
The animation is SMIL inside a `background-image` and cannot be seeked from outside, so the
tool reaches a time by waiting for it: a twelve-cell sheet takes about one visit (~40 s for
the puppy). Chromium is launched through `tools/browser-drive.mjs` and must be: a container's
64 MB `/dev/shm` kills the renderer on these layers without the `--disable-dev-shm-usage`
the driver passes. The audit says whether a rig is sound; the sheet is the only thing that
says whether the animal looks like the animal.

The ground band under the animal is a share of a _strip_, so drawing it needs the animal's
`--ps-<animal>-h` — which the tool reads from the rig's own `theme` block, so footing is
right without passing anything (`--slot=<token>` still overrides, to see an animal against
some other slot's band). **`--all` shoots the whole cast**, one row per animal, four moments
of one visit each, into a single PNG: eight visits end to end, about four minutes. Each row
is rendered at its own magnification (the `CAST` table in the file) because a shared scale
would show the bird — 76 units of bird in an 800-unit box — as a speck; the sheet says so
under its title, and rows are therefore not comparable in size.

## Tune it fast

    node tools/heart/pose-sheet.mjs frog poses        # every named pose, and the still
    node tools/heart/pose-sheet.mjs frog gait 12      # 12 phases of each gait
    node tools/heart/pose-sheet.mjs frog seq 0,2,4,6  # sequence times, in seconds
    node tools/heart/pose-sheet.mjs kitten self       # check the rasteriser itself

`pose-sheet.mjs` runs the rig's own outline pipeline straight into a PNG grid, with no
browser and no SVG in between: the same unions, the same resample, the same fillet the
generator would emit. It costs well under a second, so a pose can be judged and changed
dozens of times before anything is generated at all.

**Judge it at `--scale=2` or smaller, and don't over-trust the zoom.** The frog's redraw ran
nine variants at `--scale=4`, where the animal is about twelve times the size it ships at, and
the read wandered — frog, dog, crocodile, newt — chasing detail that is sub-pixel in the slot.
The contact sheet's own cell is the honest size, and a shape that only resolves at 4× is a
shape nobody will see.

That is the difference between it and `contact-sheet.mjs`, and both are worth having.
The contact sheet photographs the _shipped file_ through a real browser, so it is the only
thing that proves what a viewer sees — but it has to wait out the animation in real time,
and a twelve-cell sheet costs a whole visit, forty seconds and up. Tune here, confirm there.
The frog took nine rounds offline and three in the browser.

`self` renders the animal's still pose through this rasteriser so you can hold it against
the committed `<animal>-still.svg` and satisfy yourself the offline picture is the same
picture before trusting a round of tuning to it.

**Two flags for a rig whose box is not the animal.** The bird's box is 800 units tall for
76 units of bird, because the empty sky above it _is_ its route, so both sheets render it as
a speck by default: `pose-sheet --view=x,y,w,h` crops to a window of the box (the bird is
`--view=8,8,126,102` on the ground and `--view=8,-662,126,102` in the air), and
`contact-sheet --cell=w,h` narrows the cell — which is sized in multiples of the _rendered
image_, so a tall box makes the default 2.4 × 1.5 enormous and almost all sky. And
`pose-sheet --flat` paints every layer in one colour, which is what `<animal>-far.svg` does:
a near and a far part told apart only by tint are told apart by nothing in half the files
shipped, and that is exactly where the ladybug read as a rabbit. Judge the far read there,
small, and early.

## Measure it

    node tools/heart/gait-probe.mjs deer

`gait-probe.mjs` prints the two numbers nothing else in this directory will show you, and
both describe defects that are invisible in a still frame:

- **how far each foot lifts** through one cycle of each gait. The stance measurement
  (`lib/travel.mjs`) treats any foot within 6 units of the ground as planted, so a swing that
  barely clears that is read as planted for its whole swing and the animal drags. Feet come
  out in the rig tree's order — far legs first for the quadrupeds here — and a far leg is
  deliberately raised, so judge the near feet: a quarter of the cycle clear for a four-beat
  walk, most of it for a gallop.
- **the ground speed frame by frame**, per segment, as two series side by side: what is
  _applied_ (a pinned or ramped `travel` overrides the measurement) and the _raw_ stance
  measurement the rig's own feet produce. Judge a gait on the raw one — the applied series is
  flat by construction wherever a segment pins its speed, so a check against it alone reports
  a clean seam for exactly the segments that most needed pinning. A gait stores one cycle and
  repeats it, so a raw speed that differs across the cycle seam is replayed as a lurch once
  per stride, forever. The audit only ever prints one mean per segment, and the contact sheet
  tracks the animal so it sits centred in every cell — which is precisely what hides both of
  these.

The deer needed this twice: its four-beat walk measured a speed that stepped 38 → 89 at every
cycle boundary (so it was pinned at the measurement's own mean instead), and a hind hoof
cleared the ground by only 7 units because the hock's fold peaked 8 % of the cycle before the
leg passed vertical. A clean audit and a contact sheet that looks right caught neither. Run it
on the deer today and the walk still reports the lurch — 38 % of the mean across every seam,
54 frames of 395 stalled — beside the flat pinned speed that now hides it, which is what you
want: the pin is the right fix, and the numbers it was drawn from stay visible.

## The pipeline

1. **Rig** (`rigs/<animal>.mjs`): parts as paper.js paths in local coordinates under a tree
   of pivots, each node rotating on a channel; gaits as cyclic key tables per channel; poses
   and wobbles; a sequence of segments (a gait for n cycles, a blend into a gait, a pose
   with a blend and a hold, a wobble around a pose) with the frame rate per segment. The
   shapes and tables are the ones the mockups were approved with, moved here verbatim.

   **The ramp cycle.** A gait stores one cycle and repeats it, so a root channel that ramps
   inside the cycle resets on every repeat — no use to anything that has to climb. A gait
   played with `cycles: 1` whose `dur` spans several limb beats can instead ramp a root
   channel _one way_ across the whole segment, with no new machinery: the **ladybug**'s
   `flyUp` holds two wingbeats while `ty` travels from the ground to the top of its arc,
   `flyLevel` — an ordinary cyclic gait, so its repeats cost no stored frames — flies the
   distance, and `flyDown` ramps back down; the **bird**'s take-off is the same shape. Mark
   such a segment `once: true`. Without it the clip closes on its own frame 0, which is right
   for a repeat and, for a ramp, replays the whole climb backwards inside the clip's last
   frame interval; `once` closes it on the gait's pose at phase 1 instead, which for every
   cyclic channel (a limb beat, phased or not) is that channel's frame-0 value again and
   differs only in the ramping ones. Nothing else would catch the mistake — a `ty` ramp is a
   pure translate, so the outline's length never changes and the audit's 5 % rule sees
   nothing — which is why `once` is checked against `cycles: 1` and why a rig using it should
   read the clip's first and last frame back out of the shipped file once. **A ramp must
   also finish on the last frame the sampler stores, not at phase 100**: `sampleGait`
   samples phases 0…(n−1)/n while `once` closes the clip on the phase-1 pose, so a ramp
   written to 100 leaves the closing frame a whole frame-interval past the pose the _next_
   segment blends from — on the bird's descent, 17 units of altitude and a visible hop at
   the moment of landing. End the ramp key at (n−1)/n and hold it flat to 100. **And
   whatever segment follows a ramp has to start where the ramp ended**: `sampleGait` starts a gait
   segment cold and nothing blends into it, so a cruise gait whose `ty` sits at 0 after a
   take-off ramp pops back to the ground in one frame. The ladybug's `flyLevel` holds `ty` at
   the same `-APEX` its `flyUp` ramps to, which is why its clip reads back 66.1 → 66.1 against
   the ramp's 81.8 → 66.1.

   **An arc is not a ramp.** A gait whose root channel comes back to where it started — the
   dolphin's leap, out of the water and back into it — is periodic like any other, so it takes
   no `once` and repeats for free: `cycles: 6` stores one cycle, where six ramped segments
   would have stored six. Reach for the ramp only when the channel genuinely ends somewhere
   else than it began.

2. **Sample** (`lib/sampler.mjs`): the segments become a list of poses at their frame rates.
3. **Outline** (`lib/outline.mjs`): per stored frame, the near parts are united into one
   closed outline and each far group into its own — a far leg, or whatever else a rig puts
   on the far layer, the ladybug's far wing included (paper.js boolean ops, no canvas) — the
   outline is resampled from the rig's marker, rotated to line up with the previous frame,
   and its concave vertices — only those — are filleted, so joints soften and tips stay sharp.
   A gait stores one cycle; everything else stores every frame.
4. **Travel** (`lib/travel.mjs`): the lowest planted foot slides back by exactly what the body
   moves forward, so integrating its velocity gives a travel that never slips and a sit that
   never drifts. None of these animals ever walks backward on purpose, so a planted foot
   measured moving forward relative to the body — a touch-down mid-swing, common across a
   gait blend — clamps that frame's velocity at 0 rather than reading it as the body stepping
   back. Segments marked `turn` flip the facing. A segment may set `travel` to drive its own
   ground speed instead, when the rig's swing does not lift the feet clearly enough for the
   stance measurement to trust — the approved mockups' puppy and bunny don't — as a constant
   units/s, or `[from, to]` to ramp linearly across the segment's own span: clamping alone
   zeroes a gait blend's measured speed (the planted hoof swings forward there throughout),
   which read as the horse stalling for the length of every blend; the horse's own blends
   instead ramp between its two gaits' speeds, so it never stops or lurches at the switch. The
   audit still prints the measured stance speed beside whichever is actually applied (the
   ramp's own mean, for a ramp).
5. **Files** (`lib/svg.mjs`, `lib/build.mjs`): a wide stage (`sequence.stage.aspect` × the
   animal's height — sized so the visit actually crosses a wide chat rather than a slice of
   it: horse is aspect 16, puppy and bunny 24, since the small animals are half the horse's
   height and need the larger multiple to reach the same pixel width, about 1850 px at the
   theme's size), the animal starting flush with the stage's left edge; one `<path>` per
   outline, far legs first, each morphing through the clips (`<animate attributeName="d">`,
   integer relative coordinates) chained by syncbase timing so a gait repeats and the loop
   restarts after the off-stage gap; the travel as an animated translate — its own keyframes,
   independent of the outline's, from `travelCurve` (`lib/build.mjs`): a ramp segment is
   subdivided far finer than its own (cheap, low-fps) outline frames, since the translate
   costs nothing extra per sample and the outline costs bytes per frame, and every subdivided
   time is snapped to the same rounding precision (`TRAVEL_DECIMALS`, `lib/svg.mjs`) its
   position is computed against — skip that and a long loop period makes four decimals of a
   _fraction_ of it too coarse to tell two nearby frames' times apart, so a stored position
   pairs with a slightly different stored time than it was computed for and a velocity check
   reads a spurious jump that was never in the underlying motion; the turn as a
   discrete mirror about the animal's centre; the whole visit faded in over a second (or a
   quarter of the time on stage, if that is shorter) from the moment it appears, and faded out
   over the same span ending exactly when its box starts crossing the stage edge it leaves by
   (`tExit`, not the end of its time on stage — the sequence keeps sampling a little past
   that, and the animal keeps travelling on, invisibly, until the loop restarts) — so the
   animal never just appears, and is never visibly clipped at a stage edge inside the visible
   chat. Four files per animal: the near tint,
   the distant-visitor tint (`-far`), and a still of each for reduced motion — unless the rig
   sets `variants` (a subset of `["near", "far"]`, default both), which chooses the **tints**
   written, not the layers drawn: an animal only ever cast in the distance sets
   `variants: ["far"]` and ships the far tint and its still alone. A rig may also carry
   `decor`, an array of `{d, fill}` in its own coordinates, painted last and outside every
   group of the animated file — scenery the animal passes _behind_, which neither travels nor
   fades with the visit (and so is on screen for the whole loop, the off-stage gap included);
   the stills, being the rig's own box rather than the stage, carry none of _that_ array and
   take **`stillDecor`** instead — the same `{d, fill}` shape drawn against the box, for a rig
   whose animal is not legible without its scenery (the dolphin's pond: a leaping dolphin with
   no water under it is a fish in the sky, and a stage ellipse 2856 units wide crops to a flat
   band in a 130-unit box). **The shape and the position run on two
   different clocks, and keeping them equal is load-bearing.** The clips are a syncbase chain
   (each begins on the previous one's `.end`; the first restarts on the last one's `.end` plus
   an offset) while the travel, the flip and the fade are `animateTransform`s with `dur` = the
   period on the document clock. Nothing re-synchronises them, so a difference between the two
   periods is not a one-off error — it is added again every loop, forever. The restart offset
   is therefore `period - onStage`, computed from the durations _as they will be written_
   (every `dur` goes through `fmt`, so summing unrounded values would still leave a residue to
   accumulate), and the audit refuses a file whose chain period and travel period differ by
   more than half a millisecond. `test/tools/heart/files.ts` asserts the same thing over the
   committed SVGs.

   This is written at length because it shipped wrong. The restart offset was `gap`
   (`period - first - onStage`, the right number for the "is the animal away long enough"
   check and the wrong one here), so every loop restarted the shape `first` seconds early:
   2 s a loop for the horse, 14 s for the puppy. Within a few minutes the pose had nothing to
   do with the position and the animals slid around the meadow in frozen poses. Nothing caught
   it — the audit compared the chain against `onStage`, which was correct, and never against
   the period; the contact sheet photographs a single visit, so a defect that needs several
   loops to show cannot appear in one; and an earlier note in this file waved the whole class
   of problem away as "about three seconds a week, not worth twelve churned files".

## Rules a rig must keep

Learned the hard way in the mockups; the audit catches the symptoms, the rig author keeps
the causes out:

- every joint cap (disc) is larger than the piece it caps — coincident vertices break unions;
- every leg's top extends well inside the body at every pose; tail roots, far hips and the
  skull sit inside the body; the neck's base is a chord of a disc buried in the shoulder;
- far legs are 5 % shorter, slightly raised, barely set back, never below a near foot;
- folded limbs do not touch the belly or each other (an enclosed pocket changes the outline's
  topology; the outer boundary is kept, but a pocket that opens and closes jumps);
- feet carry a `foot` marker at the contact point, or the travel cannot see them;
- **a limb that enters or leaves the body does it across a step, not a slope.** A blade
  rotating off an elongated body is swallowed when it lies along the body and wholly out
  when it stands across it, and the near outline's length follows that, not the angle: the
  bird's wing measures flat at ~226 below −9°, flat at ~267 above +18°, and climbs 40 units
  (18 % of the outline) across the 27° between. Measure that curve before writing a beat —
  a table that crosses the ramp twice a cycle is what the 5 % rule will fail on, and no
  affordable frame rate fixes it. Cross it slowly with `linear` keys, or keep the whole
  beat on one side of it, or (the bird's answer for the wing that has to go _below_ the
  body) give that job to a part on the far layer, whose own outline is a rigid rotation and
  cannot change length at all;
- **a limb tucked into the body must sit deep inside it or stay outside it — never along
  its boundary.** The bird's leg cannot fold up into the belly: the only cavity long enough
  is the tail wedge's, the swing arrives there running nearly parallel to the underside, and
  the union carries a pocket through 6° of it. Tucked _under_ the belly instead — where a
  flying bird's feet are anyway — the leg is outside the outline at every angle and the whole
  extension measures one child;
- **`ty` belongs above the node that rotates.** `collect` composes T(pivot)·R(rot)·S·T(0,ty),
  so a `ty` on a rotating node is rotated with it: harmless at the ladybug's 16-unit hop,
  115 units of sideways shift on the bird's 126-wide box at 660 units of altitude and 10° of
  pitch. A rig that flies puts `ty` on the root and pitches on a child.

## The audit

- zero union failures (a union that comes back bigger than its parts is retried with the
  pose nudged; four failures is a rig problem);
- **nothing is drawn outside its own viewBox**: no stored frame's outline — the still's and the
  puppy's hearts included — may leave the rig's box by more than 1 rig unit, reported per side
  with the frame that reached furthest. A box that does not hold its animal clips it silently:
  the still is the rig's box on all four sides, the animated file is that box vertically (it is
  `0 … stageW` across), and the box is also what the fade-out is keyed to, so an outline hanging
  past `vb.x`/`vb.x + vb.w` reaches the stage edge before the fade has finished. Four of the
  first five rigs shipped with this defect — the bunny lost 17 units of ear through the sit-up
  that is the whole point of the animal, the deer 16 units of muzzle through the graze — while
  the bird's own report already said "nothing leaves the viewBox, tightest margin 7.2 units".
  The knowledge existed and nothing enforced it. The 1-unit allowance is for the resampled
  polygon's own slop (sampled extremes, the fillet, integer rounding), not a budget: give a rig
  a few units of real clearance. **Growing a box is never a one-number change** — the theme
  scales an animal by `viewBox.h` and the stage is `aspect × viewBox.h`, so `viewBox.h`,
  `--ps-<animal>-h` (× new/old), that animal's far slot height in every scene (the same way)
  and `stage.aspect` (× old/new) move together, or the animal changes size and travel on screen.
  The puppy's rig header is the worked example, twice over.
  **Two of those four numbers are in a stylesheet no audit here can read**, so the rig records
  what the theme must say: `theme: {height, box, stageWidth}` in every cast rig — the token, the
  `viewBox.h` it was picked against, and the stage width in rig units that a box change must
  preserve. `test/themes/ps.ts` derives the stylesheet's numbers from those and fails with
  the arithmetic spelled out ("scale the token by 100/91 to 0.4835, scale stage.aspect by
  91/100, and set theme.box to 100"). A far slot is no longer a number at all: the scenes say
  `calc(0.7 * var(--ps-<animal>-h))`. Bring a held animal back and it needs a `theme` block
  before the theme can cast it;
- the outline's length changes ≤ 5 % between stored frames (near), ≤ 10 % (a far leg).
  Current headroom across the cast of eight: near runs 0.84 % (horse) to **4.68 % (kitten)**,
  then bunny 4.18, frog 3.79, ladybug 3.58, bird 3.34, puppy 2.62, deer 1.84; far runs 0.31 %
  (deer) to **6.96 % (puppy)**, then frog 5.93, ladybug 3.35, bunny 2.47, kitten 2.32, bird
  1.14, horse 0.47. So a new rig tuned blind against the limits knows how much room there
  really is — and two of the eight are close enough that their next retouch has to be measured
  rather than guessed. **The rule is a symptom check, not a topology check**: a limb that folds
  against the belly closes a pocket the union drops, and the 20 % the frog's redraw lost in one
  frame that way looks exactly like a beat written too fast. Count the union's children across
  the cycle when a number like that appears — a frame rate cannot fix a hole;
- the visit ends off-stage on either side, the off-stage gap is ≥ 2 s;
- sizes: each animated file (the near tint and the `-far` one, which is the same
  shape) within its rig's own `budget`, stills ≤ 8 KB. The cast's budgets, which
  are also the rows `test/tools/heart/files.ts` holds the committed files to:

  | Animal  | Each animated file | Files             |
  | ------- | ------------------ | ----------------- |
  | horse   | 200 KB             | 4                 |
  | puppy   | 160 KB             | 4                 |
  | bunny   | 160 KB             | 4                 |
  | deer    | 150 KB             | 4                 |
  | kitten  | 150 KB             | 4                 |
  | teddy   | 120 KB             | 4                 |
  | bird    | 120 KB             | 4                 |
  | frog    | 100 KB             | 4                 |
  | ladybug | 100 KB             | 4                 |
  | dolphin | 120 KB             | 2 (far tint only) |

  A rig sets its `budget` to its row; the audit refuses to write a file over it,
  and the test skips an animal's rows until its files exist;

- the clip chain's period (Σ `dur` × `repeat`, plus the restart offset) equals the travel
  transform's `dur` within half a millisecond — the two clocks above, which nothing
  re-synchronises;
- the clip chain's total duration (Σ `dur` × `repeat` over the segments) agrees with the
  sampled `onStage` within 5 ms — the two are built from the same rounded frame counts and
  should always match exactly; a mismatch would mean the shape morphs and the travel have
  drifted out of sync with each other, animating a pose that no longer lines up with where the
  animal has travelled to;
- every hold — a `pose` segment with `hold > 0`, or a `wobble` — applies under 5 units/s: a
  stopped, sitting, or turning animal must not travel, even a little. A hold's _measured_
  stance speed can read higher than that (a blend into the hold can register real but
  spurious foot movement mid-transition); the fix is a `travel: 0` pin on that segment in the
  rig, not a change here — bunny's `crouch` needed exactly this (it measured ~5.3 units/s).

The per-segment speed the audit prints is never negative: a planted foot's measured velocity
is clamped at 0 (`lib/travel.mjs`), since none of these animals ever walks backward on purpose.

The audit also prints `tExit`, the sequence time its box starts crossing the stage edge it
leaves by (found by walking the travel back from the end, so the flush-left start at frame 0
is never mistaken for an exit) — that, not the end of its time on stage, is what the fade-out
in `lib/svg.mjs` is keyed to. If the exit condition is never found (it always should be, since
the exit rule above already guarantees the visit ends off-stage), `tExit` falls back to the
time on stage and the audit says so.

## Budget and browsers

Each near file is 85–192 KB uncompressed (the horse's 191.5 KB is 28.3 KB gzipped, about
15 % — better than the ¼ rule of thumb); the theme's directory is 2.11 MB with the whole cast
in it, against a 2.8 MB cap. That is not what a page downloads: a scene casts three animals,
and a `url()` sitting in a CSS custom property that no resolved `background-image` substitutes
is never fetched, so a page pulls three animal files out of the directory however many are
committed.

**That claim is the whole budget argument, so it is a check and not a memory.** Under the
`<3` theme the browser scenario read the open conversation's cast off the computed slot
tokens, read what the browser actually requested out of Resource Timing, and asserted the two
sets were equal. Measured 2026-09-12: 3 of the theme's 32 animal files fetched on a scene-3
channel, 5 after a second scene, and 29 never requested. With the animals switched off in `ps`,
the same claim is what keeps the 32 files that are still shipped free: the scenario
(`tools/scenarios/theme-ps.mjs`) now asserts that **no** animal file is fetched, in a first and
a second scene and under emulated reduced motion (the stills). It does that behind a control:
Resource Timing has to be recording the theme's own stylesheet and fonts, so an empty list is
evidence and not a blind spot. Measured 2026-09-24: 0 of 32 in all three. Watched failing,
too: with one rule added to the built stylesheet so a real `background-image` substitutes
`var(--ps-horse)`, the run reports "no animal file was fetched — horse.svg" (and
"horse-still.svg horse.svg" under reduced motion) and exits non-zero. Chromium runs SMIL —
chained clips, additive transforms, path morphs — inside a CSS `background-image`
(`spike-svg-background/`). Firefox and Safari still need their rows in that spike's README
filled in.
