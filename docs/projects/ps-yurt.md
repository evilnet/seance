# Inside the yurt: the `ps` theme's private conversations

**Status: plan 1 (the still room) built, 2026-11-15** (`docs/projects/ps-yurt-plan-1.md`, on `ps-theme-clean`); plan 2 (the room's motion, §13) not started. The approved mockup is `docs/resources/themes/ps-yurt/mockup.html` (its README says what in it is the design); where the two disagree, this document wins. It supersedes `docs/projects/ps-theme.md` §5.7 (the frosted plains).

## 1. Intent

In a private conversation the `ps` scene stops showing the plains and shows the **inside of the yurt**, so that a user knows at a glance they are inside, in a private place, rather than out on the plains with a channel. The room is a lived-in tiny house: the round felt walls on their lattice, the roof poles running up to the crown, the two painted posts, the stove in the middle with its pipe through the crown, a wide back window onto the mountains and the day's weather, and the furniture of a home along the round wall.

It replaces the frosted, still plains that private conversations show today (ps-theme.md §5.7, decided 2026-09-24: "I love the frosted glass look", "it can stay still").

## 2. Decisions, in the user's words

| Date       | Decision                                         | The user                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-13 | A private conversation is inside the yurt        | "when in private messages the setting is the inside of the yurt, with a back window depicting the mountains (and weather) in the background, but clearly inside the yurt. Inside it has warm rugs, and the stove in the middle, a computer, a bed, dining table, cabinets, closet, etc" |
| 2026-11-13 | The stove is what the eye finds first            | "the stove would be the most eye catching thing. it warms the room, it cooks the food, it's in the center"                                                                                                                                                                              |
| 2026-11-13 | The furniture follows the round wall             | "the room is round so there are no corners; furniture on the outside of the room should have a projective effect in it's orientation"                                                                                                                                                   |
| 2026-11-13 | Real perspective                                 | "there doesn't appear to be enough perspective in the scene" → the whole room drawn in 3D from one eye inside the door; "ok the perspectives are nice now"                                                                                                                              |
| 2026-11-14 | Dining table, rugs, walls, windows, stove        | the table taller and "completely under the dining table or not, but not partially" on the rug; one rug ("the big one in the center is great"); wall rugs below the roof; "a bigger window (or 2 more side windows)"; "I'd like the stove to be rounder"                                 |
| 2026-11-14 | The bed                                          | "the bed could stand to be fancier and nicer looking", then "visually incoherent", then "the 4-post bed style only has 2 posts. but it does look a lot nicer now"                                                                                                                       |
| 2026-11-14 | Approved; the back window as large as it can be  | "The interior looks great. I don't know if the center window can be enlarged. This is otherwise ready to start integrating" → enlarged to 3.1 × 1.45 m (mockup version 8)                                                                                                               |
| 2026-11-14 | Motion and cost follow the plains                | "Use the same rules for when to animate and how. Make use of similar optimizations."                                                                                                                                                                                                    |
| 2026-11-14 | One weather, inside and out                      | "The weather should be the same seed so outside and inside views are in the same weather conditions (outside)"                                                                                                                                                                          |
| 2026-11-14 | Private conversations drop the always-Glass rule | asked after the builder check, the user chose "Different treatment" over keeping the glass or lightening it at night: a private conversation follows the user's own "Words over the plains" setting, as a channel does (the option's own example)                                       |
| 2026-11-14 | Contrast: the room's darkest colours lighten     | "Lighten the darkest room colours": the iron greyer, the dark wood and the rug's blue lighter, until every floor holds at today's caps; a small departure from the approved mockup, accepted                                                                                            |
| 2026-11-14 | The room moves like the plains                   | "Moves like the plains": the same tiers, freezing and reduced-motion rules as a channel; a query no longer forces still                                                                                                                                                                 |
| 2026-11-14 | The stove in the middle                          | "In the middle": the stove centred under the crown                                                                                                                                                                                                                                      |

## 3. Goals, non-goals, anti-goals

**Goals.** The approved room, in the app, behind every private conversation in the `ps` theme. It follows the viewer's local clock minute by minute and the day's weather exactly as the plains do. It moves under the plains' rules and costs no more than the plains at the same tier. Every text floor holds over it. It works at every window the app supports: desktop, tablet, phone portrait and landscape, ultrawide.

**Non-goals.** No new setting, and no change to channels, the lobby or any other view. Nothing in the room is interactive. There is one room for every private conversation, not one per person.

**Anti-goals** (failure even if it works):

- The room so hidden that a user cannot tell they are inside. That is the whole point.
- Text below its contrast floor.
- A private conversation that costs a phone noticeably more than a channel does.
- Animation inside an `<svg>`, or SMIL.
- A window that shows weather the plains outside are not having.

## 4. What the user settled after the builder check

- **The words follow the setting.** A private conversation uses the user's own "Words over the plains" treatment (bubbles, glass, scrim, outline, rim or glow), as a channel does. The always-Glass rule from 2026-10-28 is withdrawn (§15). Glass at night on the desktop had hidden almost all of the room; the other treatments leave more of it in sight, and the user who wants Glass can still choose it.
- **The room moves under the plains' tiers.** `tierFor` stops returning `still` for a query (`psng/tiers.ts`). A private conversation goes from the app's cheapest state (ps-theme.md §10.1 measured 3.8 % busy on the phone at 4× in a query at dusk) to what a channel costs at the same tier.
- **The stove stands in the middle of the frame,** centred under the crown. The far-end composition (the same camera turned left until the stove stands 22 % in from the column's far end) is not built.
- **Contrast is met by lightening the room's darkest colours** (§9), not by thicker glass or a separate colour set.

## 5. The room

**The geometry is the mockup's.** Metres throughout:

- x runs to the right, y up from the floor and z away from the door, with the yurt's middle at the origin.
- The yurt has a radius of 4 m and a 2.0 m lattice wall. The crown ring sits at 3.2 m with a radius of 0.75 m, and the roof poles run every 5°.
- The eye stands at (0, 1.55, −3.0), 1 m inside the door, pitched 0.7° up, with a focal length of 507 px on an 800 px frame.

The pieces stand by angle along the wall, measured from the back (0°), positive to the right:

| Piece                                           | Angle |
| ----------------------------------------------- | ----- |
| Robe on hooks                                   | −120° |
| Washstand and mirror                            | −102° |
| Wardrobe                                        | −82°  |
| Desk, computer and chair, under the left window | −60°  |
| Painted chests with the lamp and a framed photo | −38°  |
| Four-poster bed, with the wall rug above it     | 45°   |
| Kitchen (cupboard, counter, open shelves)       | 86°   |

Everything else:

- **Windows:** the back window is 3.1 m wide, from 0.45 m to 1.90 m, with curtains, a sill, a plant and a jug. The side windows are at −60° and 69°, from 1.0 m to 1.85 m.
- **Stove:** round, 0.38 m in radius, with brass bands, an arched fire door and a round top plate holding a kettle and a pot. Its pipe rises through the crown.
- **Posts:** at x = ±0.63.
- **Rug and table:** the rug is 2.5 m in radius. The dining table, 0.75 m high on a pedestal, stands with two chairs at (−1.35, −0.55), all on the rug. The wood basket is at (−0.75, 0.35).

**Fitting every screen** (my call: one picture anchored in CSS, as the outside yurt is):

- **The picture:** the room is projected once into a fixed design frame and drawn as one SVG, wider than 1280 so the widest supported aspect never runs out.
- **The ultrawide end:** 21:9 needs about a 2.4 : 1 frame. Draw that much of the room; the camera already sees ±58° across.
- **Placing it:** `#theme-scene` places the picture with CSS alone: covering in height, its horizontal anchor on the stove, centred. A resize, the sidebar or the user list never moves it by script.
- **Portrait phone:** shows a crop around the stove, as in the mockup. A 932 × 430 landscape phone shows a wider, shorter slice.
- **Right-to-left:** the room is not mirrored; it is a picture, and with the stove centred nothing depends on the side.

The geometry module is Vue-free and DOM-free: `client/js/scenes/ps/yurt.ts` (projection, near-plane clipping, the pieces), like `plains.ts`, so mocha runs it. The mockup's drawing code is the reference implementation of every piece.

## 6. Colour and light, minute by minute

**The windows and the crown are the plains' own sky and land.** They read the custom properties the minute tick already writes on the scene root (`markup.ts` `sceneVars`: `--ps-sky-top/-mid/-hor`, `--ps-mount`, `--ps-far`, `--ps-hill2`, `--ps-cloud`, …), from the same `momentAt(now)`. The season and the hour's colours are therefore the plains', and the mockup's three-hour `skyFor` table is not carried over.

**The moon keeps its true phase.** The back window shows it while it is up, drawn from `moonShape`, and a new moon is no moon (the binding rule, ps-theme.md §2). The sun's disc shows in the back window only low in the sky near rising and setting, in clear weather, as the mockup's golden hour does. By day its light falls through the crown as the beam and its pool on the floor.

**The room's light is a set of levels computed every minute,** in `palette.ts`, beside the plains' levels:

- **Shade:** 0 by day, about 0.74 at night, from the table's existing `dark` column.
- **Golden warmth.**
- **Fire:** the stove's glow, strong at night.
- **Lamp:** on at night, in a storm, and in an overcast golden hour.
- **Beam:** clear, wind or heat around midday.

The levels change continuously and stay in step with `data-ps-light`. The mockup's three states are only samples of them.

**The night shading method is the builder's, chosen by measurement** (`perf-measure`). The mockup shades with SVG masks that hold a white copy of everything standing in front of a window, plus blend modes and a brightness filter. That is unmeasured cost and should not be assumed. Candidates:

- Every fill a class whose colour `ps.css` mixes toward its night value by the shade level (no masks).
- One static overlay with the window panes and the light pools cut out.

The result must match the mockup at noon, 18:00 and night:

- the windows and the crown's sky are never darkened;
- whatever stands in front of a window is;
- the stove's iron stays dark against its own glow.

## 7. The day's weather: one seed, inside and out

The room uses the same `Moment` as the plains: `momentAt(now)`, whose weather is `weatherFor(localDayNumber, season)`, seeded per local date. The windows therefore always show the weather the plains outside are having, and it is rebuilt on the same `weatherChanged` trigger (local midnight with the page open, or waking into another day). `momentAt(date, weather)` forcing a weather forces both. All six weathers map:

| Weather | Through the windows                                      | In the room               |
| ------- | -------------------------------------------------------- | ------------------------- |
| clear   | clouds by day; stars and the moon at night               | the beam at midday        |
| wind    | more clouds, drifting faster                             | as clear                  |
| heat    | clear and bright                                         | warmer light on the floor |
| rain    | the overcast deck, streaks, drops on the panes           | dimmer by day; no beam    |
| storm   | a darker deck, heavier streaks, lightning in the windows | dim; the lamp lit         |
| snow    | white land, flakes, a drift on the sills                 | a cool, bright window     |

The mockup draws four of the six weathers; wind and heat are new.

## 8. Motion: the plains' rules, the plains' means

**The rules are ps-ng.md's, unchanged:**

- only `transform` and `opacity` animate;
- nothing animates inside an `<svg>`, and there is no SMIL;
- nothing is written per frame;
- no moving box is larger than the viewport;
- pose swaps go by opacity at 0.999/0.001;
- every delay is offset by `--psng-t`;
- the tiers are full, calm and still;
- a rest that ends on its own (a hidden or unattended page) freezes;
- reduced motion, Still and the open drawer snap.

A query is now just another view to `tierFor`.

**What moves is HTML over a static picture.** The room is one SVG that paints once per rebuild. What moves are HTML boxes laid over it in the same frame and clipped to their windows where needed. They join the group mechanism (`psng/groups.ts`, `psng-m-<group>`):

| Group     | What moves                                                                                                              | Status   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| `hearth`  | the stove's flames, as pose swaps (or the sun's canvas fire, `flame.ts`, if it measures better), and the lamp's flicker | new      |
| `steam`   | puffs from the pot, on the smoke group's keyframes                                                                      | new      |
| `clouds`  | clouds drifting across each window                                                                                      | existing |
| `weather` | rain sheets from `rain.ts` clipped to the panes, snow, the lightning flash                                              | existing |
| `stars`   | twinkling in the windows and the crown                                                                                  | existing |

- **Calm:** `hearth` and `clouds`.
- **Phone:** halves the particles, as outside.
- **Moving between plains and room is a cut,** as NG's `transition: none` already makes the frost.
- **Only one picture is in the render tree.** While the room shows, the plains' layers leave it (`.ps-off`); while the plains show, the room does.
- **The room's markup is built on the first query,** so a user who never opens one pays nothing. It is kept until the theme unmounts, and rebuilt only for a new day's weather.

**Plan 1 ships the room still** (§13). Under today's rule a query is still anyway, and the still room is needed regardless for reduced motion and hidden pages.

## 9. Legibility

The floors do not change: 4.6 : 1 for text and 3 : 1 for marks (ps-theme.md §11). They must hold through whichever of the six words treatments the user has chosen, and through the header, composer, sidebar and chips, over the room's grounds, at every minute and in every weather:

- the window panes, which are the plains' own sky and land;
- the fire and the lamp;
- the iron, the orange paint, the cream wall, the roof and the poles;
- the night shade.

These grounds are in no ground list today. `grounds.ts` gains an indoor list, sampled from the picture's colours and the light levels, and `tools/ps/legibility.ts` sweeps it.

The glass tints are solved over the plains' grounds and published regardless of the view, and `theme-ps.mjs` asserts that a query publishes exactly what a channel does. The sidebar's tint is shared across views. The builder decides by measurement between:

- **one set of tints solved over both lists:** they stay independent of the view, but every channel's glass rises;
- **tints that depend on the view:** that assertion then changes. This is the one taken (below).

On the phone the message column reads the card tint the scene publishes (`--ps-g-tint-card`, `ps.css` near line 3472; about 0.44 at a clear June noon), capped at 0.66. The chrome reads the flat 0.78. Both must hold over the room as well.

**The builder check measured where the floors fail over the room at today's caps** (2026-11-14, the mockup's colours through `glass.ts`'s own compositing; throwaway scripts, nothing in the repo changed):

- **Desktop reaction chips:** over the stove's darkest iron (`#1c1d22`: its edges, legs and the door's frame), the soft ink reads 4.42 : 1 through the luminous glass at its 0.78 cap.
- **Phone reaction chips:** on the flat 0.78 glass, the soft ink reads 4.33 and the green marks 2.99.
- **Phone message column:** at the card's 0.66 cap under a mention's highlight, text reads 4.22 and faint ink 2.76. Over the rug the card needs 0.60, and over the iron 0.70.
- **Dusk:** shaded 0.37 toward night, just before the glass flips to night, the dark wood (`#5a341c`) and the rug's blue (`#24466e`) fail as well.

**The resolution (the user's choice):** the room's darkest colours lighten until every floor holds at today's caps. The stove's iron goes greyer; the dark wood (`#5a341c`) and the rug's blue (`#24466e`) go lighter; so does anything else the sweep finds. They move only as far as the floors need, so the room stays the approved room. In a query the scene publishes tints solved over the room's grounds, within the caps `glass.ts` already applies (`TINT_FLOOR` 0.40 to `TINT_CAP` 0.78), and a channel keeps its own, so channels are unchanged. (Corrected while planning, 2026-11-14: one set solved over both lists would raise every channel's glass, which "no change to channels" rules out.) If a ground still fails, its colour lightens further; the tints and caps do not move.

**What moved (plan 1 task 8, 2026-11-14).** Over the sparse sweep, all six weathers, at the caps: six colours, OKLCH lightness alone, each to the smallest value at which every held floor passes (`indoor.ts` `ROOM_COLOURS`). The worst moment was a storm just before the glass turns to night, when the room is shaded 0.36 toward night.

| Colour                                  | Was       | Now       | ΔL    | What it failed                                 |
| --------------------------------------- | --------- | --------- | ----- | ---------------------------------------------- |
| `ironShadow` (the stove's darkest stop) | `#18191d` | `#3d3e42` | +0.15 | the luminous glass's soft ink, 4.58 at the cap |
| `ironD` (the stove's door, legs, slot)  | `#1c1d22` | `#3c3d43` | +0.13 | the same                                       |
| `monitor`                               | `#1d212b` | `#383c47` | +0.11 | the phone's flat glass, soft ink 4.48          |
| `ironMid`                               | `#34363d` | `#3c3e45` | +0.03 | the same                                       |
| `pipe`                                  | `#383a41` | `#3b3d44` | +0.01 | the same                                       |
| `woodD`                                 | `#5a341c` | `#5d371f` | +0.01 | the same, 4.50                                 |

The rug's blue held without moving. Every held floor then holds over the room: the luminous glass at the query's tints, the phone's flat glass, the declared day and night glass, the day surface palette on the card and the glass column (and under a mention's wash), the night surface palette and its wash, and every light-treatment colour through the outline (`test/scenes/ps/legibility.ts`, "inside the yurt").

**What stays pinned, and one figure for the user.** The rim's and the glow's worst figures over the room equal the plains' pinned ones exactly (white 2.35 and 1.37; both set by the white cloud in a window, the same ground as outside). The scrim's far edge over the room is 2.04 at night (the plains' pin is 1.42), but **2.01 by day, 0.11 under the plains' 2.12** (the monitor under a mention, in a storm). It is pinned at 2.01 in the test, not held, as the plains' figure is; whether to lighten the monitor further for it is the user's call before this ships.

**The shadow family** (outline, rim, glow: white words with no surface) meets the room's brightest grounds instead: the cream wall, the roof and the window panes by day. These are the same kind as the plains' white clouds. The sweep pins their indoor worst figures beside the plains' accepted ones (`test/scenes/ps/legibility.ts`: under the rim and the glow, white over a white cloud reads 2.35 and 1.37). A worse indoor figure is the user's call before it ships.

## 10. What the scene publishes

`data-ps-light`, `data-ps-text`, `--ps-halo`, `--ps-rim` and the glass tints are unchanged, subject to §9.

**My call:** in a query the top of the screen is the roof, not the sky. `--canvas-bg-color`, the `theme-color` meta and so the iOS status bar take the roof's colour at that minute, which makes `publishMoment` aware of the view. The iPhone status-bar check (ps-theme.md §12) is the user's to do on a device.

## 11. Cost

**The gate (my call, after the builder check):** the room may cost no more than the plains at the same tier, measured on the iPhone (`perf-measure`, ps-ng.md §11.5's method). Still stays absolute at 3 % or less. ps-ng.md's 30 % and 24 % ceilings are not the gate, because the plains themselves read 62–84 % at full on the iPhone. ps-theme.md §10.1's headless measure, where a channel at dusk is already 99 % busy, is for comparing two ways of doing one thing, not for passing.

- **Plan 1** picks the night shading method by measuring in Chrome on this machine.
- **The iPhone sitting is the user's,** with the room still, calm and full at noon, dusk, night and in a storm, as with ps-theme.md §12's status-bar check.
- **If calm reads over the plains' calm,** the window clouds leave calm before the stove's fire does, because the fire is what the eye finds first.

The static SVG paints once per rebuild; the minute tick writes custom properties only. The room's markup is heavy (the lattice, 72 poles, the furniture faces), so it is kept out of the render tree whenever the plains show.

### 11.1 The still room, measured (plan 1 task 10, 2026-11-15)

Headless Chromium 156 on this machine (56 cores; the 1-minute load 5–13 through the sitting, recorded per run), production builds served side by side: the room (this branch at plan 1 task 9) against the frosted plains (`6fa941e`, the commit before task 6). Each run is a first visit under ps on a pinned clock (2 January 2026, GMT, clear), `/join` a channel, then `/query`; it reads the long animation frames from the query's open, then 10 s of main-thread task time (`scene-rest.mjs`'s `taskLoad`: CDP `TaskDuration` per second of wall clock) and the scene's animations. Three rounds, the four slots rotated by one each round, at 1280 × 800 and on the phone profile (390 × 844 `--mobile`, CPU throttled 4×); one frost/21:00/phone run timed out, so that slot has two readings. Script: `tmp/yurt-check/perf.mjs` (scratch).

| Query, still, 10 s                            | Room        | Frosted plains |
| --------------------------------------------- | ----------- | -------------- |
| Desktop, 12:00                                | 0.07–0.08 % | 0.08–0.10 %    |
| Desktop, 21:00                                | 0.07–0.08 % | 0.07 %         |
| Phone 4×, 12:00                               | 0.29–0.35 % | 0.34–0.53 %    |
| Phone 4×, 21:00                               | 0.29–0.48 % | 0.37–0.39 %    |
| Style recalculations a second, CSS animations | 0, 0        | 0, 0           |

**The still room costs what the frosted plains cost, within noise,** far under the 3 % still gate, and no CSS animation runs in either.

**The first open costs more, once a page load.** The room is built on the first query and kept (task 6), so that query's open is one long frame: on the desktop about 104 ms (100–145) against the frost's 66 ms (57–108), and on the phone profile 492–593 ms against 180–364 ms. A CPU profile at 50 µs (three runs each, the frames mapped through the build's source map) puts `buildRoom` (`psng/scene.ts`) at 37–39 ms on the desktop and 188–203 ms on the phone profile, of which `roomMarkup()` generating the picture is 28–31 ms and 146–159 ms, the HTML parse (`insertAdjacentHTML`; the scene then holds 2 981 elements against 1 974 without the room) 6–7 ms and 29–30 ms, and the stylesheet 1 ms and 3 ms. The rest of the phone's difference is the first style, layout and paint of the room. The cause is generating the markup at run time; generating it once at build time, or before the first query while the page is idle, would take most of it away. Plan 1 does not tune it (the user's call).

**The shading method (§6) costs nothing at rest and one restyle when the light moves.** The room is coloured by classes whose `color-mix` reads the minute's levels (`indoor.ts` `roomCss`); at noon and at night the levels hold still, and none of the 24 windows above restyled anything. A change of `--ps-in-shade` and `--ps-in-warm` (five changes, two runs each) costs 30–36 ms of task time on the desktop (26–32 ms of it style recalculation, no layout) and 130–188 ms on the phone profile (117–157 ms style): once a minute while the light moves, at dawn and dusk. No other method was built to compare (the plan fixed this one); an overlay that shades the whole picture in one layer would trade that restyle for a blend over the screen, and would be measured against this if the restyle shows on the iPhone.

The iPhone sitting (§11's gate) is the user's.

### 11.2 The moving room, measured (plan 2 task 6, 2026-11-15)

Headless Chromium 156 on this machine, the production build of plan 2 task 5. Each run is a first visit under ps on a pinned clock (GMT), `/join` a channel and 10 s of its main-thread task time (`scene-rest.mjs`'s `taskLoad`), then `/query`: the long animation frames of the room's first open and 10 s of the query's task time, the scene's animations counted in both. The motion setting (`psAnimation`) is full or calm; still is reduced motion emulated. Profiles: 1280 × 800, and the phone profile (390 × 844 `--mobile`, CPU throttled 4×). Three rounds of seven slots, rotated by two each round. The 1-minute load ran 8–40 through the sitting (other sessions on the machine), recorded per run. These are Chrome figures, which rank only. Script: `tmp/yurt-check/perf2.mjs` (scratch).

Each figure is the median of three, with its range:

| Slot                               | Desktop: channel → query           | Phone 4×: channel → query               |
| ---------------------------------- | ---------------------------------- | --------------------------------------- |
| Full, clear noon                   | 9.1 % (8.2–14.9) → 2.4 % (2.3–2.5) | 34.1 % (32.7–35.4) → 23.5 % (21.2–26.4) |
| Full, rainy noon                   | 11.6 (10.6–18.9) → 3.0 (2.7–3.2)   | 44.7 (43.1–46.8) → 33.1 (32.3–33.3)     |
| Full, clear 21:00                  | 6.4 (6.4–7.0) → 3.5 (3.4–3.6)      | 30.1 (29.9–61.7) → 36.1 (33.1–70.9)     |
| Calm, clear noon, clouds moving    | 1.9 (1.6–2.3) → 2.0 (1.9–2.2)      | 4.5 (4.3–6.3) → 20.4 (18.2–42.0)        |
| Calm, clear 21:00, clouds moving   | 2.0 (2.0–5.4) → 2.0 (2.0–2.1)      | 14.6 (3.9–14.8) → 20.5 (20.3–44.0)      |
| Calm, rainy noon                   | 1.9 (1.5–2.6) → 0.16 (0.15–0.24)   | 17.3 (4.2–18.0) → 2.0 (1.1–2.3)         |
| Calm, clear noon, clouds resting   | 2.2 (2.2–2.9) → 0.18 (0.17–0.33)   | 6.4 (4.2–18.5) → 1.1 (1.0–1.4)          |
| Calm, clear 21:00, clouds resting  | 2.9 (2.0–5.1) → 0.23 (0.16–0.30)   | 4.9 (4.7–17.6) → 1.1 (1.1–2.2)          |
| Still (reduced motion), clear noon | — → 0.08 % (0.08–0.13)             | — → 0.45 % (0.32–0.52)                  |

**Still stays far under 3 %. At full the query costs less than the channel in every slot but one.** On the phone profile at a clear 21:00 it read 36.1 % against 30.1 %; leaving out the one run of each at a load of 34, 33.1–36.1 against 29.9–30.1. Single runs with one group off, at a load of 33–40 (rank only), point at what the room adds at night:

- the windows' twinkling stars: the query fell from 70.6 to 53.0 without them;
- then the window clouds, 61.3, and the steam, 61.4;
- then the hearth, 65.2;
- the glow's flicker alone, 67.5, so it is not what crosses.

Plan 2 does not tune this (the user's call). The candidates are fewer twinkling stars in the windows, or window clouds drawn as the plains' HTML clouds rather than an svg each.

**Calm read over the plains' calm with the window clouds moving, so they leave calm (spec §11).** On the phone profile a calm query read 20 % against the channel's 4.5 % at noon, while the hearth's flickers alone (a rainy noon) cost it 2 %. `room-motion.ts` now rests the window clouds under `psng-calm` and shows their still drawing, and calm in a query then costs about a tenth of calm in a channel.

NG's cloud drift recalculates style each frame in both views: about 47 a second in a calm channel on the phone profile, and 55–60 in a query with its window clouds moving. Neither taking the panes' clip, container or overflow away nor `will-change: transform` changed that. The room's clouds, an svg each, cost more per frame than the plains' blob clouds.

**The first open is what it was in §11.1.** Its long frame was about 110–120 ms on the desktop (§11.1: 104) and about 477 ms on the phone profile (§11.1: 492–593). A 50 µs CPU profile puts `buildRoom` at 35–38 ms on the desktop and 148–210 ms on the phone profile:

- `roomMarkup()`: 27–29 ms and 112–167 ms;
- the HTML parse: 5.5 ms and 23–28 ms;
- the stylesheet, now with the motion's: 1 ms and 4–5 ms.

The iPhone sitting is the user's.

## 12. Tests and checks

**Mocha:**

- `test/scenes/ps/yurt.ts`: the projection, near-plane clipping, every piece's faces, and a markup census (no SMIL, unique ids, colours through classes or custom properties).
- The weather mapping for all six weathers.
- `tiers.ts`'s truth table: a query no longer forces still.
- `test/helpers/psWords.ts` loses the `wordsFor` test with the withdrawn rule (§15).
- `mount.ts`: a query shows the room and drops the plains; a query freezes and thaws as a channel does; destroy after a query leaves nothing.
- The legibility sweep over the indoor grounds.

**Browser:** a new `tools/scenarios/ps-yurt.mjs` covering:

- a query shows the room;
- every forced weather shows indoors and matches the plains outside (the same `data-weather`);
- the colours follow the hour across a pinned clock;
- the animation census in a query (known groups only, `transform`/`opacity` only, nothing animating inside an `<svg>`);
- the freeze on a hidden or unattended page, and reduced motion's snap;
- 390 × 844, 932 × 430 and an ultrawide window;
- screenshots at pinned moments.

**Changed on purpose:**

- `theme-ps.mjs` `checkFrosted` becomes a room check, and its `FROST_STATE` stops reading `.ps-sun`.
- `ps-ng.mjs` `frozenCensus` in a query becomes "a query runs as a channel does".
- `ps-scene-settings.mjs` loses its query checks with the withdrawn rule.

**Docs:**

- ps-theme.md §5.7 points here.
- `docs/resources/ps-theme-map.md` describes the room.
- The stale frost notes the research found (the frost "eases over `--ps-flip`" in ps.css and §5.7; §5.7's classic-renderer "Still" bullet) go with it.

## 13. Plans

1. **The still room.**

   - `yurt.ts` and the markup.
   - Colours by the minute and the light levels.
   - All six weathers from the engine.
   - The room in a query with the plains out of the render tree.
   - The legibility sweep and whatever it decides about tints.
   - Publishing.
   - The tests.

   A query stays still in this plan.

2. **Motion.** The indoor groups (`hearth`, `steam`, and the window `clouds`, `weather` and `stars`), the tier change (a query no longer forces still), freeze and thaw in a query, and the budget measured.

## 14. Left to the builder

- Small moves of a piece so the projection sits well on real screens.
- The night shading method (§6).
- HTML poses or the canvas for the fire.
- How the window sun and moon are placed.
- Pose and particle counts within the budget.
- How the SVG is anchored in CSS.
- Whether the room is built from strings, as `plains.ts` is.

## 15. Before any code

The uncommitted change on this branch that made a private conversation always Glass (2026-10-28: `helpers/psWords.ts` `wordsFor`, `settings.ts` `applyPsWords`, the watch in `App.vue`, its test, its scenario checks and its notes in `docs/projects/ps-words.md` and `docs/resources/ps-theme-map.md`) is withdrawn by the user's answer in §4. It is not committed. Plan 1 begins by backing it out, with the patch kept so it can be recovered.
