# The `<3` theme

Date: 2026-09-10. Branch `theme-heart` (worktree `.claude/worktrees/theme-heart`). Status: plan 1 (theme, motion, meadow's sky), plan 2 (the first three animals) and plan 3 (the cast of eight) landed; plan 4 (day, night and weather, §11) follows.

Mockups the decisions were made on (private artifacts, viewable only by their author):

- The whole theme in a mock of the app: https://claude.ai/code/artifact/5b2eb3b8-7be8-49ba-a00d-4ae7741c57f4
- The character pipeline (horse, puppy, bunny): https://claude.ai/code/artifact/8f7564e2-c793-4962-9f41-7e00c1e795bc
- Earlier rounds: fonts, parade vs. scene, placements, per-channel scenes, gaits.

## Plan 2 (landed 2026-09-11)

`docs/superpowers/plans/2026-09-11-theme-heart-animals.md` implements §5.4–5.7 and §6 (the animals) with these deviations from the spec:

1. Routes live inside the SVG, not in CSS keyframes: a background image's SMIL timeline starts when the image loads and cannot be phased from CSS, so each file is a wide stage the animal crosses, stops on, turns on and leaves by its own `<animateTransform>`s; CSS only places the stage.
2. Animals are background layers on `#chat .chat`, not pseudo-elements, so a nearer hill passes in front of a distant visitor's feet for free; which animal a slot shows is a custom property per scene.
3. Travel is derived from the planted feet (the lowest foot on the ground moves backward by what the body moves forward), so a gait never slides and a sit never drifts — no hand-tuned speeds, except decision 9.
4. Gait cycles are stored once and repeated, sequences are chained with syncbase timing (`begin="s1.end"`), and coordinates are integer relative deltas, which is what brings a horse under 200 KB.
5. The rainbow rises from behind the hills instead of fading: `background-position-y` is a longhand the clouds' `background-position-x` animation does not touch, so the two animate side by side.
6. The idle pause (§5.5) is dropped — the user's call on 2026-09-11 ("don't freeze the animations while the user is typing").
7. Two still files per animal (`-still.svg`, `-far-still.svg`) so reduced motion shows the cast in both tints.
8. Casting is per scene, phase is per file: two channels with the same scene show the same visitors at the same moments (the image is one resource); the seed still shifts where on the stage each slot is framed, the hills, the hue and the clouds.
9. A gait segment may set `travel: <units/s>` in its sequence, overriding the measured stance speed: the approved mockups' puppy and bunny bounded and hopped in place with the feet never clearly lifted, so the planted-foot measurement could not carry them. The audit prints the measured speed beside the applied one; the horse keeps the measurement.
10. The rainbow arc is `radial-gradient(circle farthest-side at 50% 100%, …)` — `closest-side` is degenerate for a circle centred on the box's bottom edge.

Each animal's first visit starts after its file loads: 2 s (horse), 7 s (bunny), 14 s (puppy), on 60 s, 50 s and 75 s loops. The horse's gallop covers about a body length a stride — what the approved rig's leg swing gives, feet locked. Each stage is `sequence.stage.aspect` × the animal's box height, and it is the product that is sized, not the multiplier: about 1850 px at the theme's size, wide enough that a visit crosses the whole channel on a wide chat instead of a slice of it (horse 2752 rig units, puppy 1962, bunny 2208). The multiplier is therefore whatever that product needs — horse 14.7166, puppy 17.0609, bunny 17.5238 — and it moves whenever a box does, since a box that grew to stop clipping its animal would otherwise widen the stage with it (`tools/heart/README.md` § The audit). A visit now lasts about 20 s (horse ~19.7 s, puppy ~26.9 s, bunny ~17.8 s), tuned so the animal reads as arriving at about the stage's middle before whatever it does there (the horse's prance, the puppy's sit-and-turn, the bunny's sit-up) and leaving fully off the far edge — see `tools/heart/README.md` § The audit for the exact rule.

### Live-test rounds (2026-09-11)

Four changes came from the user's live feedback on the real app, outside the plan text:

- The send burst hangs off the text column (`--heart-text-x` on `#chat`, per clock setting).
- The header is paper (`--heart-paper`), not sky.
- The nick column has no rule.
- Fonts are Google Fonts' variable files, the latin subset — the static instances first fetched were the latin-ext subset and drew nothing (`tools/heart/fetch-fonts.mjs` documents the trap).

A further round, also from live testing: animals now cross the whole channel (stages widened to
the ~1850 px above, cycle counts retuned to still land at about the middle and clear the far
edge); `travel` accepts `[from, to]` to ramp linearly across a segment, since the velocity
clamp (decision 3 above) that stops a mid-swing touch-down reading as backward motion also
zeroed the horse's gait-blend segments outright, freezing it for 0.3 s at every gallop/prance
switch — the horse's blends now ramp between its two gaits' speeds instead. Two more audit
rules catch the class of bug behind an animal appearing to slide with no visible animation:
the clip chain's total duration must agree with the sampled time on stage within 5 ms, and a
hold (a stopped, sitting or turning pose) must apply under 5 units/s — bunny's `crouch` needed
a `travel: 0` pin to pass the latter (its blend read ~5.3 units/s of spurious drift). Neither
rule fired on the puppy; the reported slide was not reproduced.

## Plan 3 (landed 2026-09-12)

The meadow's cast grows from three animals to eight and the six scenes are recast around them
(§5.4, §6.4). Five new rigs shipped — deer, kitten, frog, ladybug, bird — and two more were
built, reviewed and then **held** by the user (§14).

### The cast, and where each one stands

A scene casts two near animals and, in five of the six, a distant visitor on the plateau. Phones drop slot B
(§5.7), so slot A is always a mid or large animal — that constraint decides which way round
each pair is cast, and `test/themes/heart.ts` pins it.

| Scene | Slot A (near) | Slot B (near, desktop only) | Plateau                     |
| ----- | ------------- | --------------------------- | --------------------------- |
| 0     | horse         | bunny                       | deer                        |
| 1     | deer          | frog                        | puppy                       |
| 2     | kitten        | ladybug                     | horse                       |
| 3     | puppy         | frog                        | bunny                       |
| 4     | kitten        | bird                        | _(none — the sparse scene)_ |
| 5     | bunny         | horse                       | kitten                      |

A near slot takes the animal's own token; the plateau takes `calc(0.7 * var(--heart-X-h))`,
written as the calc it always was rather than as a fifth literal per scene.

| Animal  | `--heart-<animal>-h` | box (`viewBox.h`) | stage (rig units) | crossing (strips) | cast in           |
| ------- | -------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| horse   | 0.7176               | 187               | 2752              | 10.6              | 0, 5, 2 (plateau) |
| deer    | 0.5781               | 206               | 3136              | 8.8               | 1, 0 (plateau)    |
| puppy   | 0.6172               | 115               | 1962              | 10.5              | 3, 1 (plateau)    |
| bunny   | 0.6026               | 126               | 2208              | 10.6              | 0, 5, 3 (plateau) |
| kitten  | 0.44                 | 91                | 2184              | 10.6              | 2, 4, 5 (plateau) |
| frog    | 0.3                  | 74                | 1776              | 7.2               | 1, 3              |
| ladybug | 0.19                 | 65                | 1170              | 3.4               | 2                 |
| bird    | 1.2                  | 800               | 8800              | 13.2              | 4                 |

The token sizes the animal's **box**, not the animal: the bird's box is 800 units tall for 76
units of bird. The four numbers in a row are one relationship — grow a box and the token, the
plateau's share and `stage.aspect` all move — and it was hand-maintained until this plan's last
task, which moved it into each rig's `theme` block with `test/themes/heart.ts` holding the
stylesheet to it (below).

### Deviations from §6.4, and why

- **The teddy bear and the dolphin are held** (§14, 2026-09-12): both were built and reviewed,
  and the user's call — "it can't move" — stands against a stuffed toy that walks itself. The
  rigs stay under `tools/heart/rigs/`, `HELD` in `tools/heart/generate.mjs` says why, no files
  are generated, and `test/tools/heart/files.ts` asserts their files are **absent**, since
  `client/themes/heart/` ships whole to every deploy.
- **The ladybug was redrawn as a beetle.** The first draft's smooth dome with two half-ellipse
  wings read as a _rabbit_ at meadow size — and worse in the far tint, where near and far parts
  are one colour and only shape tells them apart. The redraw gives it a head, a pronotum and a
  visible elytra split, and is judged with `pose-sheet --flat`, which paints every layer one
  colour precisely because that is the read that failed.
- **The bird needed no theme change beyond its token.** §5.4 imagined "the only slot with a
  high route"; none exists. A viewBox 800 units tall for 76 units of bird puts the sky _inside
  the animal's own box_, so the file flies the bird itself and the theme still places one
  ordinary slot. The token is 1.2 strips of box for a 21 px bird.
- **Four tokens were not picked by the aspect rule** (deer, frog, ladybug, bird), which would
  have made a deer as tall as a horse and a ladybug larger than a frog; they were chosen off a
  line-up of all eight stills over the theme's own sky and ground.
- **Scene 4 casts the kitten near and the bird in slot B**, not the other way round: phones drop
  slot B, and a phone showing a single 21 px bird in an empty sky is not a scene.

### The two invariants that were added after they had already shipped broken

Both were known before they broke, and neither was written down anywhere a machine could read.
That is the reusable part.

1. **The clip chain's period must equal the travel's period.** A file's shape and its position
   run on two clocks — the outline morphs are a syncbase chain (`begin="s3.end"`), the travel,
   flip and fade are `animateTransform`s with `dur` = the loop period — and nothing
   re-synchronises them, so a difference is not an error, it is an error _added every loop_.
   The restart offset was `gap` (`period − first − onStage`) where it had to be
   `period − onStage`, so every loop restarted the shape `first` seconds early: 2 s a loop for
   the horse, 14 s for the puppy. Within minutes the animals were sliding around the meadow in
   frozen poses, which is how the user found it.
   **Why nothing caught it:** the audit compared the chain against `onStage` — correct, and a
   different quantity; the contact sheet photographs _one_ visit, so a defect that needs several
   loops to appear cannot appear in it; and an earlier note in `tools/heart/README.md` had
   dismissed the whole class as "about three seconds a week, not worth twelve churned files".
   Now: the offset is computed from the durations _as they are written_ (every `dur` goes
   through `fmt`), the audit refuses a file whose two periods differ by more than half a
   millisecond, and `test/tools/heart/files.ts` asserts it over the committed SVGs.

2. **Nothing may be drawn outside its own viewBox.** An outer `<svg>` clips to its viewBox, so
   an outline that leaves the box is silently cut — and the box is also what the fade-out is
   keyed to. Four of the first five rigs shipped with it: the bunny lost 17 units of ear
   _through the sit-up that is the whole point of the animal_, the deer 16 units of muzzle
   through the graze, the horse its ear tips, a hoof and the muzzle at full stretch, the puppy
   3 units at the left and below.
   **Why nothing caught it:** the idle pose fits comfortably, so a still tells you nothing; only
   the extremes of a pose leave the box. One rig author did check it by hand and wrote the
   result in his report — "nothing leaves the viewBox, tightest margin 7.2 units" — which is the
   whole lesson: the knowledge existed, in prose, in a file nothing reads.
   Now: `boxOverflow` (`tools/heart/lib/build.mjs`) takes every point of every layer of every
   stored frame, the still and the puppy's hearts, allows 1 rig unit for the resampled polygon's
   own slop, and names the frame and the three-number fix when it refuses.

3. **And, before it could produce a third bug: the rig-to-CSS size coupling.** The two numbers
   in the rig (`viewBox.h`, `stage.aspect`) and the two in the stylesheet (the height token, the
   plateau's share) have to move together, and the audit can only see the rig's half. Each cast
   rig now carries `theme: {height, box, stageWidth}` — the token the stylesheet must use, the
   box it was picked against, and the stage width a box change must preserve — and
   `test/themes/heart.ts` derives what `heart.css` must say from it. Grow a box and forget the
   theme and the failure reads: _"kitten's box is 100 but --heart-kitten-h (0.44) was picked
   against 91: scale the token by 100/91 to 0.4835, scale stage.aspect by 91/100, and set
   theme.box to 100"_.

### The tools that now exist

| Tool                            | Costs                            | What it is for                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/heart/pose-sheet.mjs`    | under a second, no browser       | The rig's own outline pipeline straight into a PNG grid: every named pose, n phases of a gait, sequence times, or `self` to check the rasteriser against the shipped still. `--view=x,y,w,h` crops a box that is mostly empty, `--flat` paints every layer one colour — the far tint's read, which is where the ladybug failed. **Tune here.** |
| `tools/heart/gait-probe.mjs`    | a second, no browser             | The two numbers a still cannot show: how far each foot lifts through a cycle (a swing that clears the 6-unit stance threshold by nothing reads as planted, and the animal drags) and the ground speed frame by frame, _applied beside raw_, so a cycle-seam lurch that a pinned speed hides is still visible. The deer needed it twice.        |
| `tools/heart/contact-sheet.mjs` | one visit, ~40 s, a real browser | The **shipped file** as a viewer sees it: twelve cells across the window the animal is visible, tracked so it is centred in each, over the theme's sky and ground at the animal's own slot token. `--all` shoots the whole cast, one row each, in about four minutes. **Confirm here.**                                                        |

`tools/scenarios/theme-heart.mjs` is the fourth: the theme inside the real app, in a real
browser, including what the page fetches (below).

### Budget, and the claim it rests on

`client/themes/heart/` is **2.13 MB** — 32 SVGs (2.03 MB) and three variable fonts (111 KB) —
against the 2.8 MB cap. Each animated file is inside its rig's own budget, which the audit
refuses to write over and `test/tools/heart/files.ts` holds the committed files to:

| Animal  | Each animated file | Budget | Near ≤ 5 % | Far ≤ 10 % | Frames | Visit / loop |
| ------- | ------------------ | ------ | ---------- | ---------- | ------ | ------------ |
| horse   | 191.5 KB           | 200 KB | 0.84 %     | 0.47 %     | 86     | 19.7 / 60 s  |
| puppy   | 147.9 KB           | 160 KB | 2.62 %     | 6.96 %     | 120    | 26.9 / 75 s  |
| bunny   | 110.9 KB           | 160 KB | 4.18 %     | 2.47 %     | 76     | 17.8 / 50 s  |
| deer    | 141.5 KB           | 150 KB | 1.84 %     | 0.31 %     | 98     | 34.3 / 66 s  |
| kitten  | 144.9 KB           | 150 KB | 4.68 %     | 2.32 %     | 115    | 46.0 / 72 s  |
| frog    | 97.8 KB            | 100 KB | 3.79 %     | 5.93 %     | 111    | 17.9 / 58 s  |
| ladybug | 94.8 KB            | 100 KB | 3.58 %     | 3.35 %     | 109    | 27.9 / 44 s  |
| bird    | 94.3 KB            | 120 KB | 3.34 %     | 1.14 %     | 162    | 13.8 / 36 s  |

**The headroom that matters to the next rig author** is in the two percentage columns: the
outline-length rule is the one that decides how a beat can be written, and the cast is at
0.84–4.68 % of a 5 % limit near (kitten worst, then bunny) and 0.31–6.96 % of a 10 % limit far
(puppy worst — the puppy's far legs). Under 1 % (horse) means a rig with room to spare; 4.7 %
means a rig whose next retouch has to be measured, not guessed. Sizes have less drama in them:
every animal is inside its budget, the tightest being the frog (97.8 of 100 KB) and the kitten
(144.9 of 150), the loosest the bunny (110.9 of 160). On the wire it is gzip that decides —
the horse's 191.5 KB file is 28.3 KB gzipped, about 15 %.

**A page never fetches the directory.** A scene casts three animals, and a `url()` sitting in a
CSS custom property that no resolved `background-image` substitutes is _never requested_ — that
is what makes a 2.13 MB directory a three-file download and the whole budget argument rests on
it. It is now a check rather than a memory: `tools/scenarios/theme-heart.mjs` reads the scene's
cast off the computed `--heart-slot-a/-b/-f`, reads what the browser actually asked for out of
Resource Timing, and asserts the two are equal.

Measured, 2026-09-12, in Chromium against the built `public/`:

- on `#seance` (scene 3): **3 of the theme's 32 animal files fetched** — `puppy.svg`,
  `frog.svg`, `bunny-far.svg` — and the other 29, the horse among them, never requested;
- after opening `#kittens` (scene 4) as well: **5**, the union of the two casts;
- **falsified**: with one rule added to the built stylesheet so a real `background-image`
  substitutes `var(--heart-horse)`, the same run reports _"4 … also horse.svg"_ and fails. The
  check has teeth, and the mechanism is exactly the one claimed: substituted, the file is
  fetched; unsubstituted, it is not.

## 1. What it is

A seventh theme for Seance, display name `ps <3`, file `client/themes/heart.css` (a `<` cannot be in a stylesheet URL). Vivid, highly animated, romantic pastels on a blue sky, dark blue text in a charming, highly legible font. Messages fade in, glitter bursts on send and reactions, the chrome rises into place, and behind the chat a meadow lives that belongs to the channel: pale far hills, nearer hills, a ground line, drifting clouds, and silhouette animals that walk, run, play and turn back.

The theme is **one stylesheet plus static assets** (fonts, animated SVG characters). No script ships with the theme. Two small app changes make it possible (§7).

## 2. Decisions already made, in the user's words

| Topic            | Decision                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism        | CSS only (no theme script). Mouse-tracking glitter dropped.                                                                                                                                                                                                                                                                                                                      |
| Fonts            | Nunito for text at **weight 600** (the mockup's weight; a round at 400 while the fonts were suspected of not loading was reversed on 2026-09-11), Baloo 2 (700) for channel/network names and nicks. Bundled, OFL.                                                                                                                                                               |
| Message entrance | **Fade in**, 340 ms ease-out (chosen over pop and rise).                                                                                                                                                                                                                                                                                                                         |
| Glitter          | On send, on hovering a message row, on reactions. **Four different bursts**, cycled so consecutive sends differ: sparks, hearts rising, four-point stars twinkling, confetti with stars.                                                                                                                                                                                         |
| Scene            | Not a parade of floating images. A **meadow behind the whole chat**: sky fills the message area, hills and animals at the foot at a fixed scale; **animals are lightened (opaque) under text**; text gets a faint sky halo.                                                                                                                                                      |
| Per channel      | The meadow is **seeded by the lower-cased channel name** (hills, tint, clouds, who visits and when). Same name, same meadow, on any network.                                                                                                                                                                                                                                     |
| Depth            | Pale far hills → a level far plateau → mid hills → near ground; distant visitors smaller and paler, walking on the plateau **behind** the mid hills; the far legs of an animal in a lighter tint of its own colour.                                                                                                                                                              |
| Colour           | **Each animal has its own pastel** (horse rose, puppy apricot, bunny lavender, deer lilac, kitten teal, teddy bear caramel, bird turquoise, dolphin sky, frog mint, ladybug coral); never the ink. **Silhouettes are opaque**: under text they are lightened by mixing the colour about 35 % toward the sky, never made translucent — the hills must not show through an animal. |
| Characters       | Silhouettes with real, non-repetitive behaviour (gallop/prance, bound-skid-sit-look-shake, hop/sit-up/twitch), rounded and smooth, no seams, no pointy detail. Cast: horse, puppy, bunny (done to standard), deer, kitten, teddy bear, bird, dolphin, frog, ladybug (to do).                                                                                                     |
| Idle             | The meadow pauses while the composer has focus. Everything stands down under `prefers-reduced-motion`.                                                                                                                                                                                                                                                                           |

## 3. Visual system

### 3.1 Tokens (`:root` in `heart.css`)

```
--sky        #dbeeff   chat surface, also the meadow's upper sky
--sky-deep   #c6dffa   lower sky
--paper      #f4f9ff   header, composer, menus, code
--ink        #1e3a6e   text            (on --sky ≈ 9:1)
--ink-muted  #536a8e   timestamps, topic, placeholders (on --sky 4.6:1; #5a7399 measured 4.07 and was darkened)
--ink-faint  #8fa3c2   counts, disabled (icons only, ≥ 3:1)
--rule       #c5dcf5   hairlines
--rose       #d9457f   the one accent as a fill: caret, send, badges, focus edge
--rose-text  #b9376b   rose wherever it is text (links, actions, code keywords): 4.6:1 on --sky
--rose-soft  #f08fb4
--blush      #ffd6e6   highlight rows, selection, own reactions
--lilac      #e6d9ff   sidebar top
--peach      #ffe3d1   sidebar bottom
--mint       #1f7354   joins (text, so 4.5:1 on --sky; the lighter #2f8f6b measured 3.4)
--hill-far   #dbeee1  --hill-mid #cbe6d3  --ground #b7dcc2   (base; tinted per channel, §5 —
  in the shipped CSS these three are computed at runtime from the seeded hue on #chat-container,
  hsl(var(--heart-hill-hue) ...); the hexes here are the fallback that applies only outside
  #chat-container, where var(--channel-seed) never resolves)
--horse #d97a9c / far #ecbccb   --puppy #e39a5a / #f1cba6   --bunny #9b82dc / #cbbfee
--deer #b48ad6  --kitten #5aa9b8  --teddy #c98a6a  --bird #52b3b3  --dolphin #6f9fe0  --frog #6fbf8a  --ladybug #e0524f
(each animal's far legs and its distant appearances use the "far" tint: the colour mixed ~55 % toward --sky)
```

`color-scheme: light`. TheLounge's variables (`--body-color`, `--window-bg-color`, `--link-color`, `--highlight-bg-color`, the `--tok-*` code colours, …) are mapped onto these at the end of `:root`, the way `coffee.css` does, so the parts of `style.css` that read variables follow along. The theme then restates the selectors that still carry literal colours (sidebar rows and badges, header icons, input, context menu, message-type icons, mIRC colour table) — the same list `coffee.css` covers.

The **32 nick colours** (`.user.color-1`…`-32`) are generated the way the handoff themes do it: hues swept round the wheel at one oklch lightness, chroma ≈ 0.115, every slot ≥ 4.5:1 on `--sky` and on `--blush`, biased toward the pastel-romantic range (rose, lilac, teal, gold, sky, coral) rather than a uniform sweep. Generated by a small script, checked in as values.

Sidebar: a lilac→peach vertical gradient on `#sidebar` and `body` (so the gutter continues the rail, as `themes.md` describes). Active row: white at 70 %. Unread badge: rose.

### 3.2 Type

- `@font-face` for Nunito (variable, 400–800 and an italic 400–700) and Baloo 2 (variable, 400–800), woff2 files under `client/themes/heart/` referenced relative to the stylesheet. webpack's `client/themes/*` copy pattern is extended to copy the subdirectory (`client/themes/**/*` → `themes/`), keeping the theme self-contained and offline.
- Body text `font-weight: 600`. Nicks, channel and network names, headings in the settings: Baloo 2 700. Timestamps stay Nunito 600 at the muted tone with `font-variant-numeric: tabular-nums`.
- Sizes are untouched: the theme is colour, type and motion; layout stays `style.css`'s rem system.

## 4. Motion

All motion is CSS animations/transitions on elements the app already renders, keyed to classes it already sets. No script.

| Moment             | Hook                                                                                                                                                                                                  | Motion                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A message appears  | any `#chat .msg` inserted into the DOM (history loads and channel opens included: everything animates into place)                                                                                     | `fade` 340 ms ease-out, opacity 0 → 1.                                         |
| A mention          | `.msg.highlight`                                                                                                                                                                                      | blush background plus a `glow` (inset rose shadow, 1.8 s, twice) on insertion. |
| Own message sent   | `.msg.self:last-child` (the pending copy, then the echo that replaces it; an own message loaded as history only when it is the last one, on opening the channel)                                      | two star bursts on `::before`/`::after` (see below), 0.9–1.4 s, once.          |
| A reaction         | `.reaction-enter-active` (Vue transition group on `.msg-reactions-list`; a chip's arrival only — not `.msg-reaction.self` on its own, a persistent class that would burst on every redraw of the row) | hearts rising + stars, 1.2 s.                                                  |
| The chrome on load | `#sidebar .channel-list-item` (staggered by `nth-child`, 45 ms steps), `#chat .header`, `#form`                                                                                                       | `rise` 450–500 ms: opacity 0 → 1, translateY 8px → 0.                          |
| Composer focus     | `#form:focus-within`                                                                                                                                                                                  | rose top edge (the existing focus-ring convention) and rose caret.             |

**Glitter bursts** are backgrounds on pseudo-elements: layered `radial-gradient` sparks, `linear-gradient` confetti strips, and data-URI SVG hearts and four-point stars in rose, yellow, sky and lilac. Four bursts (`--burst-1..4`) and four keyframe sets (`sparkle`, `sparkle-rise`, `sparkle-pop`, `sparkle-twinkle`). The send burst is chosen by `.msg.self:last-child:nth-child(4n+1)`…`(4n+4)` so consecutive sends differ. Reactions use a fixed pairing (hearts + stars).

`@media (prefers-reduced-motion: reduce)`: every animation and transition off, the meadow shows a still (§5.6), bursts do not appear.

## 5. The meadow

### 5.1 Placement and layers

The meadow is painted behind the message list, inside `#chat .chat-content` / `.messages` (whichever is the scroll container's positioned parent), from the header to the composer. Nothing moves in the layout: the theme adds no elements, so the chat keeps its full height and text flows over the sky. Layers, back to front, all CSS on existing elements and their pseudo-elements:

1. Sky: `linear-gradient(--sky → --sky-deep)` on the message area's background.
2. Far hills, a level far plateau (a full-width band with softly rounded corners at 31 % of the strip, in the far green), one or two mid-hill bumps in front of it, and the ground band: background layers positioned at the bottom, sized from a fixed strip height `--strip: 8.75rem` (never from the area's height). Stacking: far hills and plateau, then distant visitors, then mid hills, then ground, then near visitors, so a nearer hill passes in front of a distant animal's feet.
3. Clouds: a pseudo-element with white rounded blobs (`radial-gradient`s) whose `background-position` drifts across the width on a 60–120 s loop.
4. Animals: pseudo-element slots (§5.4), each in its animal's pastel **mixed about 35 % toward the sky** (baked into the SVG's fills: the under-text tint is a colour, never `opacity`, so the hills never show through a silhouette). Distant visitors stand on the plateau (`bottom` about 29.5 % of the strip), at 70 % size and in the far tint (about 55 % toward the sky).
5. The messages themselves, with `text-shadow: 0 0 6px var(--sky), 0 0 2px var(--sky)` on `.msg` so ink stays clean over hills and silhouettes; `.msg.highlight` keeps a blush at 85 % so the mention row still reads as a row.

The chat's `.messages` gets `position: relative` and a stacking context so the pseudo-elements sit behind its children. The user list, search results, and the lobby (`data-type="lobby"`) show no meadow: the sky only, no hills, no animals. Queries (`data-type="query"`) get a meadow like a channel's, seeded by the nick.

### 5.2 The seed

The app publishes two attributes on `#chat-container` next to the existing `data-current-channel`:

- `data-scene="0".."5"`: a bucket of the hash, for selecting discrete variants with attribute selectors.
- `style="--channel-seed: 0.xxx"`: the hash as a unit float, for `calc()`-driven continuous variation (delays, positions, hue).

Both come from `helpers/channelSeed.ts`: FNV-1a over the lower-cased name of the conversation, the channel's name for a channel and the other person's nick for a query (network-independent by the user's choice), pure and unit-tested (`test/helpers/channelSeed.ts`). The lobby gets no scene. ≈ 15 lines in `Chat.vue` and the helper.

### 5.3 What the seed decides (CSS only)

- Hill tint: `filter: hue-rotate(calc((var(--channel-seed) - 0.5) * 60deg))` on the hill layers.
- Hill layout: six layouts keyed by `data-scene` (which hills, their widths and heights).
- Clouds: `animation-delay: calc(var(--channel-seed) * -80s)` and a per-scene count.
- Cast and timing: per `data-scene`, which animal each slot shows and its route's `animation-delay` offset (`calc(var(--channel-seed) * -40s)`), so two channels with the same layout still differ in who is where.
- A rainbow (a pseudo-element arc of the pastel palette that fades in for a minute every few minutes) in two of the six scenes — placed in **plan 2**, with the animal slots: it needs a pseudo-element, which plan 1 does not add.

### 5.4 Animals

**Implemented, plan 2 (landed 2026-09-11), with decisions 1–4 and 7–10 above** — animals are layers on `#chat .chat`, not pseudo-elements, and their routes live inside the SVG rather than as CSS keyframes; the rest of this section describes the spec's original approach, superseded by those decisions.

Each animal is a **self-animating SVG file** (`client/themes/heart/<animal>.svg`): the near silhouette and the far legs as two paths in the animal's own pastel and its far tint (baked as colours; the SVG is an image; a distant-visitor variant `<animal>-far.svg` carries the far tint on both), animated with SMIL `<animate attributeName="d">` between resampled outlines (§6). The file plays its behaviour sequence on a loop (walk, run, stop, sit, look, turn) and carries its own idle pose.

The theme places animals with pseudo-elements on existing elements (`.messages::before/::after`, `#chat .chat-view::before/::after`, `#chat-container::before/::after`, `#chat::before/::after`): up to eight slots. A slot is `position: absolute; bottom: <ground>; height: calc(var(--strip) * ratio); background: url(heart/horse.svg) no-repeat / contain`, and moves along a **route** — CSS keyframes on `transform` (translateX across the width, `scaleX(-1)` to face the other way) whose timing matches the SVG's own sequence (the generator writes both, §6). A far visitor is smaller, paler (`filter: brightness(1.35) saturate(0.7)`) and higher up. Slots run on 90–140 s loops with long gaps, so at most one or two visitors are on screen and the meadow is often empty, which is what makes an arrival an event.

Direction changes: the route flips `scaleX` while the character is stopped (sitting, looking), never mid-stride.

### 5.5 Idle

**Dropped, plan 2 (landed 2026-09-11), decision 6 above** — the user's call on 2026-09-11: don't freeze the meadow while the composer has focus. Nothing below is implemented.

`#chat-container:has(#input:focus) .chat` pauses every route (`animation-play-state: paused`) and swaps each slot's image for the animal's still (`<animal>-still.svg`, one frame, generated too) so a paused horse does not gallop in place. Focus leaves, the meadow resumes.

### 5.6 Reduced motion

**Implemented, plan 2 (landed 2026-09-11), decision 7 above** (two still files per animal, near and far tint).

Under `prefers-reduced-motion: reduce` the meadow shows sky, hills, and the cast's stills (up to three on desktop, two on phones — the same slots the scene casts, now motionless), nothing moves.

### 5.7 Budget

**Implemented, plan 2 (landed 2026-09-11)**; the real budgets are in `tools/heart/README.md` § The audit, and measured sizes print in the generator's own audit output.

- Only `transform`, `opacity` and `background-position` animate. No layout, no filters animating.
- ~~Each SVG ≤ 120 KB uncompressed (§6.4), stills ≤ 6 KB~~ — shipped higher: `horse.svg` ≤ 200 KB, `puppy.svg`/`bunny.svg` ≤ 160 KB, stills ≤ 8 KB (`tools/heart/README.md` § The audit); total assets for the theme ≤ 1 MB (fonts ≈ 150 KB, animals ≈ 800 KB, gzip ≈ ¼ of that on the wire).
- Phones keep the meadow, reduced: under `max-width: 600px` the strip height drops to 6.5rem and only two animal slots stay active (the rest are hidden).

## 6. Characters: the pipeline

**Implemented, plan 2 (landed 2026-09-11), for horse, puppy and bunny** (§6.4); the remaining seven animals are plan 3.

Everything under `tools/heart/` (Node, ESM), run by hand and checked-in outputs, the way `tools/generate-emoji-catalog.mjs` works.

### 6.1 Rigs

`tools/heart/rigs/<animal>.mjs` exports a rig: parts (paths, circles, ellipses in local coordinates), a tree of pivots (`pivot`, `rot` channel, `ty`/`scale` channels), the layer (`near`/`far`), markers (muzzle tip, toes) for outline anchoring, and gaits/sequences as pose tables and cyclic keys — exactly the data shapes proven in the mockups (`heart-core.js`). The rules that emerged from review are constraints the generator checks:

- every joint cap is larger than the piece it caps (coincident vertices break unions);
- every leg's top extends inside the body at every pose (no piece detaches);
- tail roots, far hips and skull sit inside the body; the neck's base is a chord of a disc buried in the shoulder; the tail hangs from a disc buried in the rump;
- far legs are 5 % shorter, slightly raised, barely set back, never below a near foot;
- folded limbs do not touch the belly or each other (an enclosed pocket changes the outline's topology).

### 6.2 Outlines

**Implemented, plan 2 (landed 2026-09-11)**, with the generator built on plain `paper` (no canvas, no `paper-jsdom`) and the audit's thresholds shipped higher than drafted below.

Per frame: pose → union of the near parts into one closed path (paper.js in Node, no canvas), each far leg into its own; a union that comes back larger than its parts is retried with a nudged pose; the outline is resampled to N points starting at the rig's marker, aligned to the previous frame, and run through the concave-only fillet (rounds ~14, strength 0.5). Audit: max frame-to-frame outline-length change (≤ 5 % body, ≤ 10 % far legs) and no union failures; the generator refuses to emit a clip that fails.

### 6.3 Output

**Implemented, plan 2 (landed 2026-09-11), decisions 1 and 4 above** — differs from the draft below: coordinates are integers written as relative deltas, not rounded decimals, and there is no `routes.css` fragment (decision 1).

`client/themes/heart/<animal>.svg`: viewBox, two (or three) `<path>`s (far legs first, the near outline last so it paints on top), each morphing through the sequence's clips with `<animate attributeName="d" calcMode="linear">`; clips are chained with syncbase timing — one `<animate>` per clip, each beginning on the previous clip's `.end` — and a gait clip stores one cycle and repeats it with its own `repeatCount`, never `indefinite` on the whole path. Frames at 15–24 fps for sequences, 30 fps for gaits; coordinates are integers, written as relative deltas along the outline (`encodePath`, `tools/heart/lib/svg.mjs`). `<animal>-still.svg`: the idle pose. There is no `routes.css` fragment: routes live inside the SVG (decision 1), not as CSS keyframes matched against the sequence's stops and turns.

### 6.4 Cast and behaviours

**Implemented, plan 3 (landed 2026-09-12)**, with two rows held: the **teddy bear** and the
**dolphin** were built, reviewed and set aside by the user (§14), so their rigs stay and their
files are deliberately absent. The other eight ship; the plan-3 block above has the scene table,
the tokens and the deviations. Two behaviours were added to the drafted list: the puppy's hearts
rise from its sit (they had never been visible until its box grew for them), and the ladybug was
redrawn as a beetle after the first draft read as a rabbit.

| Animal     | Sequence (loop)                                                                               | Notes                                                       |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Horse      | gallop across · slow to a prance · prance in place · gallop off; a second clip: prance across | done to standard in the mockup                              |
| Puppy      | bound ×3 · skid · sit, look around, wag (hearts) · shake · stand · bound back the other way   | done                                                        |
| Bunny      | hop ×3 · sit up, nose twitch, ears · hop ×3                                                   | done                                                        |
| Deer       | walk · pause and graze (head down) · look up, ear flick · bound off                           | horse rig with slimmer body, longer neck, short tail        |
| Kitten     | trot · pounce (crouch, wiggle, leap) · sit and wash (paw over ear) · trot on                  | puppy rig with pointed ears, long tail with its own channel |
| Teddy bear | waddle · sit down · wave · stand · waddle                                                     | upright biped, two arms, round ears                         |
| Bird       | flap across the sky · glide · land on the ground line · hop twice · take off                  | flies in the sky band, the only slot with a high route      |
| Dolphin    | leaps in an arc from the far hill's edge (a "pond" is a lighter ellipse in two scenes)        | appears only in scenes with the pond                        |
| Frog       | sit · big hop · sit · tongue flick · hop                                                      | low route, small                                            |
| Ladybug    | walks along the ground line · opens its wings and flies a short arc · lands                   | tiny; wings are two half-ellipses on their own channels     |

Hearts from the puppy are part of its SVG (a small heart path with its own animate on opacity/translate), so no extra element is needed.

## 7. App changes

1. `helpers/channelSeed.ts` + `Chat.vue`: publish `data-scene` and `--channel-seed` (§5.2). Test in `test/helpers/channelSeed.ts`.
2. `configuration.ts`: `{name: "heart", displayName: "ps <3", themeColor: "#f4f9ff"}`; `test/tests/build.ts`: add `heart` to the list of theme files expected in `public/themes/`, and expect `themes/heart/nunito-variable.woff2` and `themes/heart/horse.svg`.
3. `webpack.config.ts`: the themes copy pattern includes subdirectories.
4. `docs/resources/themes.md`: the `heart` row and a section on the meadow and the generator; `CLAUDE.md` gets one paragraph pointing there; `docs/projects/heart-theme.md` carries this spec once the work lands (per the repo's `docs/superpowers/` convention).

Nothing else in the app changes. The theme must degrade gracefully on a deploy that lacks the seed attributes: no `data-scene` means scene 0.

## 8. Verification

- `yarn test`: the build test above; the seed helper's unit tests; generator tests under `test/tools/heart/` (a rig round-trips through union → resample → fillet; the audit rejects a rig with a detached piece; the emitted SVG parses and has equal `values` counts across paths).
- Browser: `tools/scenarios/theme-heart.mjs` on the dev ircd: pick the theme in Appearance, assert the stylesheet link, the seed attributes for a channel, that `.messages` carries the meadow background, that a `.msg` inserted after connect runs the fade (computed animation name), that a pending own message has the burst pseudo-element, contrast of ink/muted/nick-on-blush ≥ 4.5:1 as `themes.mjs` measures, and a screenshot in each of two channels showing different meadows. Also `--mobile`.
- A spike, first in the plan: **SMIL animation inside an SVG used as a CSS background image** in Chromium, Firefox and WebKit. If any engine does not animate background SVGs, the fallback is CSS animations inside the SVG (`<style>` in the file); if that also fails somewhere, that engine gets the stills. The generator can emit either form.

## 9. Out of scope

- The parade of Twemoji images (superseded), mouse-tracking glitter (needs script), sound.
- A dark variant of `<3` (a night meadow) — a natural follow-up, not in this branch.
- Reworking layout, spacing or type sizes; the theme is colour, type and motion only.
- Making the meadow reflect activity (a visitor when someone joins) — would need app hooks beyond the seed; noted as a later idea.

## 10. Questions resolved with the user (2026-09-10)

1. Sidebar gradient: **lilac → peach**, as mocked.
2. Queries: **get a meadow**, seeded by the other person's nick.
3. Phones: **keep a reduced meadow** (6.5rem strip, two visitor slots), never hidden.

## 11. Day, night and weather (decided 2026-09-12, plan 4)

Chosen by the user against a live mockup of the alternatives
(https://claude.ai/code/artifact/6cf06f97-09c1-492d-9575-4b650c7c084a). The mockup's day and
night looks were approved as drawn — "I like what you created for the new day look and night
look, very good" — so the palette keys in it are the starting point, not a fresh design.

### 11.1 The cycle follows the viewer's own clock

**The scene's time of day is the local time, and the app supplies it.** The user's call, after
first choosing a six-hour CSS loop and then reversing it the same day: _"I changed my mind, I
want the scene time to be taken from the local clock, even if that is a javascript hook."_

This is the point where the theme stops being CSS-only. That rule (§2, decision 1) held for
everything before it and is now deliberately spent, once, on this. The reasoning that won: a
meadow that is dark when it is actually dark outside reads as a place, while any loop reads as a
screensaver and never matches the world the reader is in.

**Shape of the hook.** It is the same shape as the channel seed, which is the precedent to
follow: `Chat.vue` already publishes `data-scene` and `--channel-seed` on `#chat-container` from
`client/js/helpers/channelSeed.ts`, and every theme but this one ignores them. So a small
Vue-free helper publishes the time of day the same way — a number for where we are in the day,
and a coarse phase name — and only this theme reads it. Refresh on a timer of about a minute and
on `visibilitychange`, so a laptop that slept wakes up showing the right sky.

Three mechanisms for turning that number into a palette, to be settled in the plan:

- `@property`-registered colour tokens, which makes them interpolable, and let CSS transition
  between phases;
- `color-mix()` between the two neighbouring phase palettes, with the hook publishing the
  fraction between them — colour logic stays in CSS, the hook supplies only numbers;
- the hook computing the interpolated colours itself and setting the tokens directly, which is
  simplest and least declarative.

Prefer the middle one unless it measures badly: it keeps the palette in the stylesheet where the
rest of the theme's design lives, and keeps the hook to arithmetic.

**The sun and moon position** needs no colour interpolation at all — a `calc()` off the
published number places them on their arc, in pure CSS.

Consequences to keep in mind:

- Two people in different time zones see different skies. That is the entire point.
- `prefers-reduced-motion` still stands down the moving parts (fireflies, smoke, drifting
  clouds). The sun itself moves imperceptibly at real-time rates, so the cycle need not be
  frozen — but the palette must still be correct rather than defaulting to day.
- A theme that reads an app-published value must degrade sanely when it is absent: with no hook
  (an older build, a page that has not booted the helper) the meadow falls back to the daytime
  palette rather than to an unstyled or midnight one.

### 11.2 The sun and the moon

One arc across the sky: sunrise at the meadow's left edge, overhead at midday, sunset at the
right, and the moon rides the same arc through the night. Stars fade up through dusk and out
through dawn. Sky, far hills, mid hills and ground all warm and cool together — the mockup
interpolates ten palette keys across the cycle (night, first light, sunrise, morning, midday,
afternoon, golden hour, sunset, dusk, night) and those are the values to port.

### 11.2b The moon shows its real phase

Approved 2026-09-12 against a live calculation in the mockup. The user asked whether accurate
phases were possible; they are, and the local-clock hook (§11.1) already knows the date, so
there is no new mechanism to build.

**Use the true elongation, not the mean month.** Counting days since a known new moon and
dividing by the mean synodic month of 29.530589 days is three lines, but a real lunation runs
from about 29.27 to 29.83 days. Measured over the four years from 2026-09-12, that model drifts
by up to **0.98 days of age and 10.2 points of illumination** — the difference between a fat
crescent and a quarter, and wrong in a way anyone who looks out of a window can catch.

The honest version is the moon's ecliptic longitude minus the sun's, with the six largest
periodic terms in longitude (`6.2886 sin M′`, `1.2740 sin(2D − M′)`, `0.6583 sin 2D`,
`0.2136 sin 2M′`, `−0.1851 sin M`, `−0.1143 sin 2F`). About twenty lines, no data to fetch, no
network, accurate to minutes. Illuminated fraction is `(1 − cos D) / 2`.

**Drawing a phase without arc-flag guesswork:** a dark disc, the near half filled light, then one
ellipse of horizontal radius `R · |cos D|` — filled dark for a crescent, light for a gibbous —
and the whole thing mirrored horizontally when waning. Exact at every phase, three shapes.

**A new moon means no moon.** It is not a dark disc in the sky, it is an absent one, so those
nights get a darker, starrier meadow with nothing on the arc. This falls out of the same number
for free and is the nicest detail in the feature.

Northern-hemisphere orientation is assumed (lit on the right while waxing). The moon keeps to
the same night arc as the sun rather than its true rising time — being right about the phase is
what a viewer can check; being right about moonrise is a rabbit hole with no visible payoff.

### 11.3 Night

**A quieter meadow, with night creatures, and some creatures in both.** The user's call:
_"i like a quieter meadow at night, with night creatures; some creatures can be both."_

So night is not the day cast retinted wholesale, and not a wholly separate cast either:

- fewer animals are cast after dark than by day, and they move less;
- some of the existing ten appear in both — the deer and the bunny read naturally at night, the
  horse and the puppy do not;
- genuinely nocturnal animals join them: **owl, fox, hedgehog** are on the wish list (§11.6),
  and the night scene table is built so they slot in without being redone;
- fireflies drift over the grass;
- everything cast at night takes the cooler, dimmer moonlit tint.

### 11.4 Clouds and weather

**A seeded cloud field, plus weather.** The user's call: _"I'd like a field plus weather."_

The complaint that prompted it was exact: _"the clouds don't have enough variation. its always
the same 2 small clouds"_ — and it is worse than two. There are two, and scenes 1 and 4 set
`--heart-cloud-2` to transparent, so those channels cross an empty sky behind a single cloud.

Replace them with six clouds at three sizes, three heights and three drift speeds, arranged
from the channel's own seed the way the hills already are, plus a weather axis on that seed so a
channel can be overcast, clear, or carry one fat low cloud. Rarely, a drifting flock of birds.

### 11.5 The camp

**All four tents ship, one per scene, chosen by the channel's seed, tucked against a hill, and
desaturated.** The user's calls: _"I'd like a fancy tent or yurt added to the field, smoke from a
fire comes out at night and it glows"_, then, against the mockup
(https://claude.ai/code/artifact/74c31318-0bc8-4f07-b372-83d28bb3ca7d): _"I like all variations
of this tent. Let's set a scene from a seed on each channel; use one of these 4 tents, on every
scene 1 variation of the tent, tucked against a hill (but it cannot have too much color
saturation because it will be hard to read text over it)."_

- **The four shapes** are the mockup's: yurt, bell tent, striped pavilion, tipi. **No flags or
  pennants** — the user rejected them, and they were also the most saturated marks on the
  drawings, so removing them serves the legibility rule below as well.
- **The fire is inside the tent.** The user's correction: _"I imagined the smoke would be coming
  out of the tent top (implying a fire inside) and the inside of the tent would glow because of
  the fire at night."_ So there is no campfire beside the tent. Smoke leaves by a vent at the
  top — the yurt's open crown ring, the bell tent's stove pipe, the tipi's smoke flap, a vent at
  the pavilion's left peak — and after dark the fabric blooms from within, brightest at the
  doorway, with a soft spill onto the ground. Each shape must therefore have a believable vent
  drawn at its apex; that is a requirement of the drawing, not a detail.
- **One per scene, every scene.** The tent token is cast per scene exactly as the animal slots
  are — `--heart-tent: var(--heart-tent-yurt)` and so on — so a channel always has a camp and
  which camp it is comes from its seed. All six scenes carry one.
- **Tucked against a hill**, at the foot of a mid hill rather than out on the open grass. The
  mid hills already move per scene (`--heart-hill-1-x`, `-2-x`), so the tent's position is
  derived from the hill it leans on, not set independently.
- **The fire smokes all day; the doorway and the ground glow come up after dark**, driven by the
  same local-clock hook as everything else (§11.1).

**The saturation ceiling is a requirement, not a preference.** The tent sits behind message
text, and this theme already has a discipline for that: silhouettes are opaque and lightened by
mixing about 35 % toward the sky, never made translucent, and `.msg` carries a sky halo (§3, §5).
The tent follows the same rule and one more of its own — no part of it may be more saturated
than `--heart-hill-mid`, the most saturated thing already allowed to sit under text. In practice
that means a fabric palette of low-chroma creams and warm greys, and the mockup's rose band and
blue pennant desaturated well below what they are there. The scenario's existing contrast
assertions (ink and nick colours ≥ 4.5:1 on `--sky`) are the check that this held.

The fire's glow at night is the exception that needs watching: a warm glow is saturated light by
nature. Keep it low in the frame, behind the hill line, and let it bloom on the ground rather
than up into the text.

**Layer cost, to go in with eyes open.** The tent is one more background layer, taking §5's list
from fourteen entries to fifteen — and fourteen is asserted in eight separate lists plus
`test/themes/heart.ts`. That is a bounded, known chunk of work, and it is the price of the
feature; it is not a reason to fake the tent into an existing layer.

### 11.6 Wish list

Deliberately not in plan 4, kept so they are not lost:

- **owl, fox, hedgehog** — the nocturnal animals, three new rigs by the pipeline in §6;
- a drifting flock of birds as a rare weather state.

## 12. At night the whole theme goes dark (decided 2026-09-12)

The user's call: _"yes go dark at night."_

This was the one question night could not be built without. Everything about this theme's
legibility is measured against a **light** sky: `--ink` clears 4.5:1 on `--sky`, `--ink-faint`
clears 3:1, the 32 nick colours were generated at one oklch lightness specifically to clear
4.5:1 on `--sky` and on `--blush`, and `tools/scenarios/theme-heart.mjs` asserts those ratios in
a real browser. The sky is not a strip at the foot of the chat — §5 puts it behind the whole
message area. A night sky of the kind the mockup draws would therefore put dark blue ink on a
near-black ground and fail every one of those measurements at exactly the moment the meadow looks
its best.

So the app quietly turns into a dark theme while it is dark outside, and back at dawn.

### What this commits us to

- **A second full palette**, not a tint pass. Ink, faint ink, the chrome, the borders, the blush,
  the composer, the sidebar — everything `--heart-sky` is currently measured against.
- **The nick sweep regenerated for a dark ground.** The 32 colours are a generated set at one
  oklch lightness chosen to clear 4.5:1 on a light sky; that lightness is wrong on a dark one.
  Generate a second sweep and switch between them, checked in as values the way the first is.
- **The contrast floors hold at night exactly as they do by day** — ink ≥ 4.5:1, faint ink ≥ 3:1,
  nicks ≥ 4.5:1 on their ground. This theme has been careful about ratios since plan 1 and night
  is not where that lapses. The scenario must measure them in _both_ states, not just one.
- **The crossover is gradual, and text must clear its floor at every step of it.** Dusk is the
  dangerous moment: a palette that is legible at midday and legible at midnight can still pass
  through an unreadable middle. Check the worst intermediate, not just the two ends.
- **Reduced motion still gets a correct palette**, not a frozen daytime one — the meadow may stop
  moving, but a user reading at midnight should not be handed the day's colours.

### What it does not commit us to

The user's own theme choice is untouched: this is the `<3` theme following the sun, not the app
gaining a dark mode. Someone who wants a light interface at midnight picks another theme.

## 13. Private messages get no meadow

The user's call: _"this decoration of the background shouldn't exist for private messages (I
will need some alternative idea of a much plainer and less animated background for private
messages)."_

Today a query gets the same treatment as a channel — §5's meadow is painted on
`#chat .chat-view[data-type="channel"] .chat` **and its query twin**. That twin comes out.

What replaces it is not yet decided; the shape of the answer is that a private message should be
calmer and quieter than a channel, and should still belong to the theme rather than falling back
to bare `coffee`. Candidates to put to the user:

- **The sky alone.** The same time-of-day gradient the meadow uses, and nothing else: no hills,
  no animals, no clouds, no camp, no motion at all. A query still sits in the same world and
  under the same sun, but the world is empty and still. Cheapest, and the strongest contrast
  with a channel.
- **A blush wash.** Not the sky at all but the theme's `--blush`, very softly graded — private
  conversations get their own colour, which doubles as a signal that you are somewhere different.
- **The sky with one distant hill.** A single static silhouette on the horizon, no motion. Keeps
  a hint of place without anything moving behind the text.

Whichever is chosen, three rules hold: nothing animates, nothing is cast from the seed, and the
contrast floors in §3 apply unchanged.

This also removes a cost. Every animal file a query would have fetched is no longer fetched
there, and the fourteen-layer list (fifteen with the camp) does not have to hold for a surface
that is not painting it.

## 14. The teddy bear and the dolphin are held (2026-09-12)

The user's call: _"let's put a hold on the teddy bear as an animal, since it can't move. and also
put a hold on the dolphin. but birds are necessary."_

The teddy's reason is a taste judgement worth writing down because it is not about the drawing:
**a stuffed toy that walks itself reads wrong however well it is drawn.** That is a category
problem, and it explains why the shipped bear never quite worked. It was already being redrawn
side-on when this landed — two reviews had found it read as a front-facing icon gliding sideways
— and that redraw was stopped mid-flight. Its unfinished rig is parked as a patch outside the
repo; the committed rig is untouched.

The dolphin is held on the same message, with no reason given. Its work stands: a clean audit at
1.39 % near outline change, its own pond as `decor`, and a `stillDecor` mechanism it added to the
generator that survives it.

**The bird stays** — "birds are necessary" — which is fortunate, since it is the best animal in
the cast.

### What "held" means here

- The **rigs stay** in `tools/heart/rigs/`, reviewed and buildable.
  `node tools/heart/generate.mjs teddy` still works.
- The **generated files are removed and are not regenerated**. `client/themes/heart/` is copied
  into `public/` whole, so a file no scene casts is dead weight in every deploy — about 470 KB
  between the two. `HELD` in `tools/heart/generate.mjs` lists them and says why; a full
  regenerate prints the list and skips them.
- `test/tools/heart/files.ts` marks both rows `held` and **asserts their files are absent**,
  rather than skipping. Skipping would let a stray regenerate quietly put those bytes back into
  every deploy.
- To bring one back: add it to `ALL`, regenerate, cast it in a scene, and drop the `held` flag.

### The cast is now eight

horse, puppy, bunny, deer, kitten, frog, ladybug, bird. §6.4's table of ten stands as the
design; two of its rows are simply not cast today.

The ladybug was **redrawn** on 2026-09-12, because the first one read as a rabbit and the cast
already has one. What carries a beetle in a side-on silhouette, in the order the rounds found
them: a body that is wide and low with its crest forward and a blunt rear near the ground
(36 units tall on 86 long, where the old dome was 51 on 62); three descending lobes — elytra,
pronotum, head — each stepping off the last one's cliff; legs that zigzag, the femur near
vertical and the shin taking the angle, because a mammal's leg is a column; and wings that
open _rearward_, 22.7 units past the back of the body, never upright. The rig's header
(`tools/heart/rigs/ladybug.mjs`) carries the geometry and the constraints that fix it.
