# Inside the yurt, plan 1: the still room — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the `ps` theme, a private conversation shows the approved yurt interior, still, coloured by the minute and showing the day's weather in its windows. Every text floor holds over it. Channels are unchanged.

**Architecture:**

- **Two new Vue-free, DOM-free modules** build one static SVG of the room in a fixed design frame (`-320 0 1920 800`, the stove at x 640), placed in CSS alone with `xMidYMid slice`. `ps/yurt.ts` holds the projection; `ps/room.ts` holds the pieces and the markup.
- **A third module, `ps/indoor.ts`, decides colour and light.** The room is painted through classes whose colours `roomCss()` mixes toward night by custom properties the existing minute tick writes, so there are no masks. Windows and the crown read the plains' own sky and land variables. The windows' weather is a sub-layer rebuilt on the plains' `weatherChanged` trigger.
- **The NG scene owns the room.** `psng/scene.ts` builds the room on the first query and shows it under `ps-private` instead of the plains.
- **A query publishes its own glass tints and canvas.** In a query `publish.ts` publishes tints solved over the room's grounds (`glass.ts` `indoorTints`) and the roof's colour as the canvas.

**Tech Stack:** TypeScript (strict), Vue 3 app shell untouched, mocha + chai + sinon on the stand-in page (`test/scenes/standin.ts`), `tools/browser-drive.mjs` scenarios in headless Chromium, pnpm.

**Spec:** `docs/projects/ps-yurt.md` (approved 2026-11-14). The approved mockup, `docs/resources/themes/ps-yurt/mockup.html`, is the reference implementation of every piece. Read both before Task 2.

## Global Constraints

- **Purity:** modules under `client/js/scenes/ps/` stay Vue-free and DOM-free (mocha loads them directly). There are no Node built-ins in `client/`, and new code has explicit types (`strict: true`).
- **Motion:** nothing animates inside an `<svg>`, and there is no SMIL. Plan 1 adds no animation at all. A query stays still: `psng/tiers.ts` is not touched.
- **Colours:** every room colour reaches the page through a class or a custom property; a literal `fill="#…"` appears only on the never-shaded lit parts (`ROOM_LIT`). In CSS, `color-mix(in oklab, A, B p%)` equals `colour.ts` `mixOklab(A, B, 1 - p)`. `mixOklab`'s third argument is the weight of its _first_ colour.
- **Ids:** every id in the room's markup starts with `ps-yt-`. No room class reuses a plains class (`ps-moon`, `ps-sun`, `ps-stars`, `ps-weather`, the `GATES` selectors in `ps/layers.ts`), with one exception: the window moon carries `ps-m-ell` and `ps-m-shape` on purpose (Task 6).
- **Channels are unchanged:** their published values, tints and generated colour blocks do not move. `tools/ps/palette-blocks.ts --write` must stay a no-op.
- **Floors (ps-theme.md §11):**
  - text holds 4.5 : 1, and the solved soft ink 4.6 (`glass.ts` `TEXT_SOLVE`);
  - marks hold 3 : 1 (3.1 solved, `MARK_SOLVE`);
  - faint card ink holds 3 (`FAINT_SOLVE`);
  - query tints stay within `TINT_FLOOR` 0.40 to `TINT_CAP` 0.78.
- **No UI strings are added** (so there's no `t()` and no pot change). New CSS uses logical properties, and anything sized in the UI uses `rem` (the room's geometry is the SVG's own units).
- **Browser checks need the dev ircd** (`tools/nefarious-dev/run.sh`, Docker; `ws://127.0.0.1:8067`). This machine has no Docker. If the ircd cannot run, say so in the task's report and leave the browser task's checkboxes open; do not skip silently.
- **Rebuild before every browser check:** `NODE_ENV=production pnpm build`.
- **Commits and pushes:** commit at each task's last step, and never push (the user pushes). Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015jhDUVJ6qwTT9z9pySq67a
  ```
- **Before each commit:** `pnpm lint` and `pnpm typecheck` are clean. `pnpm test:mocha` passes at the end of every task.

## Review Focus

1. **Mounting straight into a query** (a reload on a private conversation): the room is built and coloured in the same synchronous first tick, with no frame of plains or uncoloured room. Test in Task 6.
2. **A new day's weather while a query is open:** the windows' weather is rebuilt with the plains', from the same `Moment`. Test in Task 6 (21 June 2026 is clear, 22 June is heat).
3. **Going in and out of private conversations many times:** there is exactly one `.ps-indoor` and one room stylesheet, however often the view changes, and a view change republishes at once, not at the next minute. Tests in Tasks 6 and 7.
4. **Windows far from 1280 × 800:** a 21:9 desktop, a 390 × 844 phone and a 932 × 430 landscape phone all show the room covering the scene, with no empty band and the stove in the middle. Unit test on the viewBox and `preserveAspectRatio` (Task 4), and the browser check (Task 9).
5. **No moon:** with a new moon, or the moon not up, the window shows no moon, because it reads `--ps-moon-op`, which is 0 then. Test in Task 6.

## File Structure

| File                                                                                                              | Responsibility                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `client/js/scenes/ps/yurt.ts` (new)                                                                               | The camera and projection, near-plane clipping, frames, painters, boxes, cylinders and sprites. Numbers in, SVG strings out. |
| `client/js/scenes/ps/room.ts` (new)                                                                               | The pieces (ported from the mockup), `roomMarkup()` and `windowWeather()`.                                                   |
| `client/js/scenes/ps/indoor.ts` (new)                                                                             | `ROOM_COLOURS`, the light levels, `indoorVars`, `roomCss`, `roofColourAt`, `indoorGrounds`.                                  |
| `client/js/scenes/ps/glass.ts`                                                                                    | Adds `isBehindIndoor`, `indoorTints` and a `behind` parameter on `tintsOver`. `glassVars` gains `view`.                      |
| `client/js/scenes/ps/grounds.ts`                                                                                  | `publishedFor` gains `view`. `SceneGround` gains an optional `zone`.                                                         |
| `client/js/scenes/ps/publish.ts`                                                                                  | `publishMoment` gains `view`. The moon goes on every `.ps-m-ell`.                                                            |
| `client/js/scenes/psng/scene.ts`                                                                                  | Builds, colours, re-weathers and destroys the room, and republishes on a view change.                                        |
| `client/themes/ps.css`                                                                                            | Deletes the frost and adds the room's box and the plains/room switch.                                                        |
| `tools/ps/legibility.ts`                                                                                          | A `view` parameter on the ground and sweep functions.                                                                        |
| `test/scenes/ps/yurt.ts`, `test/scenes/ps/room.ts`, `test/scenes/ps/indoor.ts` (new)                              | Unit tests for the three new modules.                                                                                        |
| `test/scenes/psng/mount.ts`, `test/scenes/ps/glass.ts`, `test/scenes/ps/legibility.ts`, `test/scenes/ps/scene.ts` | The room in the scene, the query tints, the floors over the room, and the frost wrapper test reworded.                       |
| `tools/scenarios/ps-yurt.mjs` (new), `tools/scenarios/theme-ps.mjs`, `tools/scenarios/ps-ng.mjs`                  | The browser checks.                                                                                                          |
| `docs/projects/ps-yurt.md`, `docs/projects/ps-theme.md`, `docs/resources/ps-theme-map.md`                         | What was built, the colour moves and the cost.                                                                               |

---

### Task 1: Back out the withdrawn always-Glass change, and commit the design

**Files:**

- Restore to `HEAD`: `client/components/App.vue`, `client/js/helpers/psWords.ts`, `client/js/settings.ts`, `docs/projects/ps-words.md`, `docs/resources/ps-theme-map.md`, `test/helpers/psWords.ts`, `tools/scenarios/ps-scene-settings.mjs`.
- Commit: `docs/projects/ps-yurt.md`, `docs/projects/ps-yurt-plan-1.md`, `docs/resources/themes/ps-yurt/mockup.html`, `docs/resources/themes/ps-yurt/README.md`, `.prettierignore`.

- [ ] **Step 1: Keep the withdrawn change as a patch.** Run `git diff -- client/components/App.vue client/js/helpers/psWords.ts client/js/settings.ts docs/projects/ps-words.md docs/resources/ps-theme-map.md test/helpers/psWords.ts tools/scenarios/ps-scene-settings.mjs > tmp/ps-always-glass.patch`. `tmp/` is git-ignored. Expected: the patch is non-empty and contains `wordsFor`.
- [ ] **Step 2: Restore those seven files** with `git checkout -- <the seven paths>`. Expected: `git status --short` lists only `.prettierignore`, `docs/projects/ps-yurt.md`, `docs/projects/ps-yurt-plan-1.md` and `docs/resources/themes/ps-yurt/`.
- [ ] **Step 3: Verify.** Run `pnpm typecheck && NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/helpers/psWords.ts`. Expected: no type errors, and the psWords tests pass (the `wordsFor` test is gone with the change).
- [ ] **Step 4: Commit** with the message `ps: inside the yurt — the approved design, its mockup and plan 1; the always-Glass rule withdrawn` plus the attribution lines.

### Task 2: The room's geometry (`ps/yurt.ts`)

**Files:**

- Create: `client/js/scenes/ps/yurt.ts`
- Test: `test/scenes/ps/yurt.ts`

**Interfaces:**

- Produces, for later tasks:

```ts
export type P3 = readonly [number, number, number];
export type Face = "front" | "left" | "right" | "top" | "bottom";
export const ROOM_GEOMETRY: {
  radius: 4;
  wallHeight: 2.0;
  crownHeight: 3.2;
  crownRadius: 0.75;
  eye: P3 /* [0, 1.55, -3.0] */;
  focal: 507;
  pitchDeg: 0.7;
  near: 0.12;
};
export const DESIGN_FRAME: {x: -320; y: 0; width: 1920; height: 800}; // the stove's x is 640
export function project(q: P3): [x: number, y: number, depth: number];
export function depthOf(q: P3): number;
export function clipPolygon(l: readonly P3[]): P3[]; // cut where depth < near
export interface Frame {
  u: P3;
  n: P3;
  pt(a: number, b: number, c: number): P3;
  th?: number;
}
export function wallFrame(thDeg: number): Frame; // backed on the wall, facing the middle
export function freeFrame(x: number, z: number, nx: number, nz: number): Frame;
export interface Painter {
  px(s: number, t: number): number;
  poly(l: ReadonlyArray<readonly [number, number]>, attrs: string): string;
  rect(s0: number, t0: number, s1: number, t1: number, attrs: string, k?: number): string;
  ellipse(s: number, t: number, rs: number, rt: number, attrs: string, k?: number): string;
  circle(s: number, t: number, r: number, attrs: string): string;
  diamond(s: number, t: number, w: number, h: number, attrs: string): string;
  arched(s0: number, s1: number, t0: number, t1: number, rise: number, attrs: string): string;
  line(l: ReadonlyArray<readonly [number, number]>, attrs: string): string;
}
export function surface(map: (s: number, t: number) => P3): Painter;
export function fill(colour: string, face?: Face): string; // `class="ps-yt-c-<colour>[ ps-yt-f-<face>]"`
export function box(
  fr: Frame,
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  colour: string,
  deco?: Partial<Record<Face, (S: Painter) => string>>
): string;
export function abox(
  x: readonly [number, number],
  y: readonly [number, number],
  z: readonly [number, number],
  colour: string,
  deco?: Partial<Record<Face, (S: Painter) => string>>
): string;
export function cylinderSide(
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
  attrs: string
): string;
export function sprite(q: P3, body: string, unit?: number): string; // "" behind the eye
```

The mockup's `camera`/`toCam`/`proj`/`clipPoly3`/`surf`/`faces`/`abox`/`box`/`cylSide`/`sprite` are the reference. The eye is fixed, so there is no `cam` argument and no yaw. The one change is that faces name colours through `fill()` classes; the mockup computed literal side, top and bottom shades instead.

- [ ] **Step 1: Write the failing tests** in `test/scenes/ps/yurt.ts`:

```ts
it("projects the mockup's anchors in the design frame", function () {
  const near = (got: number[], want: number[]) =>
    want.forEach((w, i) => expect(got[i]).to.be.closeTo(w, 0.01));
  near(project([0, 0, 0]), [640, 669.85, 2.98]); // the stove's base
  near(project([0, 3.2, 0]), [640, 129.16]); // the crown's middle
  near(project([0, 0, 4]), [640, 518.78]); // the back wall's foot
  near(project([0.63, 0, 0]), [747.15, 669.85]); // the right post's base
});
it("cuts a polygon where it passes behind the eye", function () {
  const cut = clipPolygon([
    [-1, 0, -3.5],
    [1, 0, -3.5],
    [1, 0, 0],
    [-1, 0, 0],
  ]);
  expect(cut).to.have.length(4);
  cut.forEach((q) => expect(depthOf(q)).to.be.at.least(ROOM_GEOMETRY.near - 1e-9));
  expect(
    clipPolygon([
      [-1, 0, -3.5],
      [1, 0, -3.5],
      [0, 0, -3.4],
    ])
  ).to.deep.equal([]);
});
it("draws only the faces turned to the eye", function () {
  const count = (s: string) => (s.match(/<polygon /g) ?? []).length;
  expect(count(box(wallFrame(0), [-0.5, 0.5], [0, 0.5], [0, 0.6], "furn"))).to.equal(2); // front, top
  const desk = box(wallFrame(-60), [-0.65, 0.65], [0, 0.62], [0.71, 0.75], "wood");
  expect(count(desk)).to.equal(3); // left, top, front
  expect(desk)
    .to.contain("ps-yt-f-left")
    .and.contain("ps-yt-f-top")
    .and.not.contain("ps-yt-f-right");
  expect(count(box(wallFrame(-82), [-0.45, 0.45], [0, 0.58], [0.08, 1.82], "furn"))).to.equal(2); // left, front
});
it("names colours by class, never by literal", function () {
  expect(box(wallFrame(0), [-0.5, 0.5], [0, 0.5], [0, 0.6], "furn")).to.not.match(/fill="#/);
  expect(fill("furn")).to.equal('class="ps-yt-c-furn"');
  expect(fill("furn", "top")).to.equal('class="ps-yt-c-furn ps-yt-f-top"');
});
it("leaves out a sprite behind the eye", function () {
  expect(sprite([0, 1, -3.2], "<i/>")).to.equal("");
});
```

- [ ] **Step 2: Run them to see them fail.** Run `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/yurt.ts`. Expected: FAIL (cannot find module `ps/yurt`).
- [ ] **Step 3: Implement `yurt.ts`** with the interfaces above, porting the mockup's maths unchanged: `toCam` pitch 0.7°, `cy` 400, `cx` 640, and `widthAt` clamped to 0.8–18 px. `fill(colour, "front")` gives no face class.
- [ ] **Step 4: Run the tests until they pass.**
- [ ] **Step 5: Commit** with the message `ps: the yurt's geometry — one eye inside the door, projected into the design frame`.

### Task 3: Colour and light by the minute (`ps/indoor.ts`)

**Files:**

- Create: `client/js/scenes/ps/indoor.ts`
- Test: `test/scenes/ps/indoor.ts`

**Interfaces:**

- Consumes: `Moment` (engine), `Palette` and `WEATHER` (palette), `mixOklab` (colour), `type SceneGround` (grounds).
- Produces:

```ts
export const ROOM_COLOURS: Readonly<Record<RoomColour, string>>; // the mockup's C table and the literals its pieces paint, each named
export type RoomColour = keyof typeof ROOM_COLOURS;
export const ROOM_LIT: readonly string[]; // never shaded: the fire's stops, the flames, the lamp flame, the night screen
export const ROOM_NIGHT = "#0b0f24";
export const ROOM_WARM = "#ff9a50";
export interface IndoorLevels {
  shade: number;
  warm: number;
  fire: number;
  lamp: number;
  beam: number;
  sun: number;
  screen: number;
}
export function indoorLevels(m: Moment, p: Palette): IndoorLevels;
export function shadeRoom(hex: string, l: Pick<IndoorLevels, "shade" | "warm">): string;
export function indoorVars(m: Moment, p: Palette): Record<string, string>; // --ps-in-shade, -warm, -fire, -lamp, -beam, -sun, -screen
export function roomCss(): string;
export function roofColourAt(m: Moment, p: Palette): string;
export const ROOM_GROUNDS: readonly RoomColour[];
export function indoorGrounds(m: Moment, p: Palette): SceneGround[];
```

**The levels.** Let `wx = WEATHER[m.weather]` and `clamp01` be the usual clamp.

| Level    | Formula                                                                                    |
| -------- | ------------------------------------------------------------------------------------------ |
| `shade`  | `0.74 * p.dark + 0.55 * wx.dim * (1 - p.dark)`                                             |
| `warm`   | `0.2 * p.glowOpacity * (1 - p.dark)`                                                       |
| `fire`   | `min(1, 0.32 + 0.48 * p.dark + 0.18 * wx.storm)`                                           |
| `lamp`   | `max(clamp01((p.dark - 0.3) / 0.3), wx.storm, wx.hide > 0 && p.glowOpacity > 0.5 ? 1 : 0)` |
| `beam`   | `wx.hide === 0 && m.sun.up ? clamp01(m.sun.alt * 1.6) : 0`                                 |
| `sun`    | `wx.hide === 0 && m.sun.up && m.sun.alt < 0.2 ? 1 - m.sun.alt / 0.2 : 0`                   |
| `screen` | `p.dark`                                                                                   |

**The colour rule.** `shadeRoom(hex, l)` is `mixOklab(mixOklab(hex, ROOM_WARM, 1 - l.warm), ROOM_NIGHT, 1 - l.shade)`. `roomCss()` gives:

- every key `k` the rule `.ps-yt-c-k { --c: color-mix(in oklab, color-mix(in oklab, <hex>, #ff9a50 calc(var(--ps-in-warm) * 100%)), #0b0f24 calc(var(--ps-in-shade) * 100%)); fill: var(--c); }`, and a stroke twin `.ps-yt-s-k { stroke: … }`;
- the face rules `.ps-yt-f-side`, `-left` and `-right` (`fill: color-mix(in oklab, var(--c), #000 16%)`), `-top` (`#fff 14%`) and `-bottom` (`#000 28%`);
- the light rules: `opacity: var(--ps-in-beam)` on `.ps-yt-beam` and `.ps-yt-pool-sun`, `var(--ps-in-warm)` on `.ps-yt-golden`, `var(--ps-in-fire)`, `var(--ps-in-lamp)` and `var(--ps-in-screen)` on the three glows, `var(--ps-in-sun)` on `.ps-yt-window-sun`, `var(--ps-stars)` on `.ps-yt-star`, and `var(--ps-moon-op)` on `.ps-yt-moon`.

`roofColourAt` is `shadeRoom(ROOM_COLOURS.roofA, indoorLevels(m, p))`.

**The grounds** (spec §9), following the plains' rule (`grounds.ts`' comment): a fill large enough to stand behind a line of text is a ground; lines and small marks are not.

- `ROOM_GROUNDS`: the wall's two stops; the roof's two; the floor's two; the rug, its border and its pattern; the hearth's two; the iron's four gradient stops and the stove's top; the door and pipe; the posts; `furn`, `furnL`, `furnD`, `blue`, `cream`, `gold`, `wood`, `woodL`, `woodD`; the curtains, the band and the skirt; the mattress, pillows, quilt and quilt top; the monitor.
- **Marks, not grounds:** the lattice, poles, ribs, boards, knobs, finials, brass bands, small ornaments and every sprite.
- **What `indoorGrounds` returns for each key:** `{area: "room <key>", name, hex: shadeRoom(ROOM_COLOURS[key], l), body: "land", below: false, zone}`, with `zone: "top"` for the roof's stops, the crown and the crown's sky, and `"middle"` otherwise.
- **Extra grounds:**
  - the window panes, at the plains' own `p.skyTop`, `p.skyMid`, `p.skyHorizon`, `p.mount2`, `p.mount`, `p.far`, `p.hill2` and `p.cloud`, unshaded;
  - the crown's sky, `mixOklab(p.skyTop, p.skyMid, 0.65)`;
  - while `fire > 0`, the wall, floor, rug and posts under the fire's glow;
  - while `lamp > 0`, the wall under the lamp.
- **The glow model:** a screen blend of the shaded colour with `#ffa040` at `0.85 * fire` (the lamp: `#ffd08a` at `0.8 * lamp`). The blend is per sRGB channel: `1 - (1 - a)(1 - α·b)`.

- [ ] **Step 1: Write the failing tests** in `test/scenes/ps/indoor.ts`:

```ts
const at = (d: Date, w?: Weather) => {
  const m = momentAt(d, w);
  return {m, p: paletteAt(m)};
};
it("is lit by day and shaded at night", function () {
  const noon = at(new Date(2026, 5, 21, 12, 30), "clear"),
    night = at(new Date(2026, 5, 21, 23, 0), "clear");
  expect(indoorLevels(noon.m, noon.p))
    .to.include({shade: 0, lamp: 0})
    .and.have.property("beam")
    .above(0.9);
  const n = indoorLevels(night.m, night.p);
  expect(n.shade).to.be.closeTo(0.74, 0.001);
  expect(n.lamp).to.equal(1);
  expect(n.fire).to.be.closeTo(0.8, 0.001);
  expect(n.beam).to.equal(0);
});
it("dims and lights the lamp in a storm, and has no beam under cloud", function () {
  const {m, p} = at(new Date(2026, 5, 21, 12, 30), "storm");
  const l = indoorLevels(m, p);
  expect(l.lamp).to.equal(1);
  expect(l.beam).to.equal(0);
  expect(l.shade).to.be.closeTo(0.55 * 0.46, 1e-9);
});
it("writes exactly the seven levels", function () {
  const {m, p} = at(new Date(2026, 5, 21, 18, 30), "clear");
  expect(Object.keys(indoorVars(m, p)).sort()).to.deep.equal([
    "--ps-in-beam",
    "--ps-in-fire",
    "--ps-in-lamp",
    "--ps-in-screen",
    "--ps-in-shade",
    "--ps-in-sun",
    "--ps-in-warm",
  ]);
});
it("mixes every colour the way the page does", function () {
  expect(shadeRoom("#c8602f", {shade: 0, warm: 0})).to.equal("#c8602f");
  expect(shadeRoom("#c8602f", {shade: 1, warm: 0})).to.equal(ROOM_NIGHT);
  const css = roomCss();
  for (const k of Object.keys(ROOM_COLOURS)) expect(css, k).to.contain(`.ps-yt-c-${k} {`);
  expect(css).to.contain("calc(var(--ps-in-shade) * 100%)").and.contain("var(--ps-moon-op)");
});
it("lists the room's grounds: every ground key, the panes in the plains' own colours, nothing from ROOM_LIT", function () {
  const {m, p} = at(new Date(2026, 5, 21, 12, 30), "clear");
  const g = indoorGrounds(m, p);
  ROOM_GROUNDS.forEach((k) => expect(g.map((x) => x.area)).to.include(`room ${k}`));
  expect(g.map((x) => x.hex))
    .to.include(p.skyTop)
    .and.include(p.mount);
  ROOM_LIT.forEach((hex) => expect(g.map((x) => x.hex)).to.not.include(hex));
  expect(g.filter((x) => x.zone === "top").map((x) => x.area)).to.include("room roofA");
});
it("gives the canvas the roof's colour", function () {
  const {m, p} = at(new Date(2026, 5, 21, 23, 0), "clear");
  expect(roofColourAt(m, p)).to.equal(shadeRoom(ROOM_COLOURS.roofA, indoorLevels(m, p)));
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement `indoor.ts`.** Add `zone?: "top" | "middle"` to `SceneGround` in `grounds.ts`; the plains' grounds leave it unset. Start `ROOM_COLOURS` from the mockup's values (its `C` table and the literals in its pieces); Task 8 may lighten some. `room.ts` (Task 4) uses these keys as its colour names.
- [ ] **Step 4: Run until it passes.** Also run `test/scenes/ps/grounds.ts`. Expected: still green.
- [ ] **Step 5: Commit** with the message `ps: the yurt's colour and light by the minute — classes mixed toward night, the room's grounds`.

### Task 4: The room's markup (`ps/room.ts`)

**Files:**

- Create: `client/js/scenes/ps/room.ts`
- Test: `test/scenes/ps/room.ts`

**Interfaces:**

- Consumes: everything in Task 2's Produces block; `RoomColour`, `ROOM_LIT` and `roomCss` from Task 3.
- Produces:
  - `roomMarkup(): string`, which returns `<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">…</svg></div>`.
  - `export const ROOM_PIECES: readonly string[]`, the piece classes `ps-yt-p-<name>`.
  - `export const WINDOW_CLIPS = ["ps-yt-win-back", "ps-yt-win-left", "ps-yt-win-right"] as const`, and the crown's clip id `ps-yt-crown`.
  - An empty `<g class="ps-yt-weather" data-weather="">` slot that Task 5 fills.
  - The light elements Task 3's CSS drives: `.ps-yt-beam`, `.ps-yt-pool-sun`, `.ps-yt-golden`, `.ps-yt-glow-fire`, `.ps-yt-glow-lamp`, `.ps-yt-glow-screen`, `.ps-yt-window-sun`, `.ps-yt-star`, and `.ps-yt-moon` (containing `.ps-m-ell` and `.ps-m-shape`).

**Content:** port, in the mockup's draw order, everything in its `interior()`:

- the floor and its boards;
- the roof, the poles and the crown, with its ribs and the sky through it;
- the wall, the lattice, the band and the skirt;
- the three windows' frames, mullions, sills, the plant, the jug, the back window's curtains and rod, and the side windows' valances;
- the rug and the hearth;
- the pieces `ROOM` lists, at the mockup's angles: hooks −120, washstand −102, closet −82, desk −60, chests −38, bed 45, kitchen 86;
- the two posts at x ±0.63, the round stove and its pipe, the table and its two chairs at (−1.35, −0.55), and the basket at (−0.75, 0.35);
- every standing thing sorted far to near by `depthOf` of its reference point, as the mockup does.

**What is left out:**

- **The night shading:** the mockup's `mDark`/`mView` masks, the `.mw` copies, the `filter:brightness` stove copy and the blend-mode rects. Task 4's classes replace them.
- **The window views' colours:** the views read the plains' variables. The sky is `<linearGradient id="ps-yt-sky">` with stops `style="stop-color: var(--ps-sky-top|mid|hor)"`, the mountains are `fill: var(--ps-mount2)`/`var(--ps-mount)`, the far plain `var(--ps-far)`, the hills `var(--ps-hill2)`, the clouds `var(--ps-cloud)`, and the crown's sky is `color-mix(in oklab, var(--ps-sky-top), var(--ps-sky-mid) 35%)`.
- **The bright parts:** the fire window, the flames, the lamp's flame and the night screen are drawn last as literal fills (`ROOM_LIT`), each with a `ps-yt-lit` class.

- [ ] **Step 1: Write the failing tests** in `test/scenes/ps/room.ts`:

```ts
const markup = roomMarkup();
it("is one static svg in the design frame, covering the scene around the stove", function () {
  expect(
    markup.startsWith(
      '<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice"'
    )
  ).to.equal(true);
  expect(roomMarkup()).to.equal(markup); // deterministic
});
it("has no SMIL, prefixes every id, and defines every clip it uses", function () {
  expect(markup).to.not.match(/<(animate|animateMotion|animateTransform|set)\b/);
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).to.equal(ids.length);
  ids.forEach((id) => expect(id).to.match(/^ps-yt-/));
  for (const ref of markup.matchAll(/url\(#([^)]+)\)/g)) expect(ids).to.include(ref[1]);
  [...WINDOW_CLIPS, "ps-yt-crown"].forEach((id) => expect(ids).to.include(id));
});
it("draws every piece, and colours the room by class or variable only", function () {
  ROOM_PIECES.forEach((p) => expect(markup, p).to.contain(p));
  const literal = [...markup.matchAll(/<[^>]*fill="#[^"]+"[^>]*>/g)].map((m) => m[0]);
  literal.forEach((tag) => expect(tag, tag).to.contain("ps-yt-lit"));
});
it("keeps the plains' classes out of the room", function () {
  expect(markup).to.not.match(/class="[^"]*\bps-(moon|sun|stars|weather|frost)\b/);
  expect(markup).to.contain("ps-m-ell").and.contain("ps-m-shape");
});
it("stays a reasonable size", function () {
  expect(markup.length).to.be.below(350_000);
});
```

`ROOM_PIECES` covers: closet, desk, chests, bed, kitchen, washstand, hooks, stove, post, table, chair, rug, crown, window-back, window-left, window-right, curtains.

- [ ] **Step 2: Run to fail.** Expected: FAIL (no module `ps/room`).
- [ ] **Step 3: Implement `room.ts`.** Each piece wraps its markup in `<g class="ps-yt-p-<name>">`. Colour names are `ROOM_COLOURS`' keys (`RoomColour`, Task 3).
- [ ] **Step 4: Run until it passes.** Then render the markup once in a browser to compare it with the mockup at noon: write `roomMarkup()` into a scratch HTML under `tmp/` with Task 3's `roomCss()` and fixed `--ps-*` values from `sceneVars(momentAt(new Date(2026,5,21,12)), …)`. Expected: the room matches the mockup's "Stove in the middle", "Hide chat", noon render, piece for piece.
- [ ] **Step 5: Commit** with the message `ps: the yurt's room as one static svg — every piece from the approved mockup, coloured by class`.

### Task 5: The windows' weather

**Files:**

- Modify: `client/js/scenes/ps/room.ts`
- Test: `test/scenes/ps/room.ts`

**Interfaces:**

- Produces `windowWeather(weather: Weather, phone: boolean): string`, the contents of `.ps-yt-weather`, clipped per window by `WINDOW_CLIPS`. Its outer `<g>` carries `data-weather="<weather>"`.

**The six weathers** (spec §7), still. The counts are for the back window, scaled by each window's width and halved on a phone; fixed `rng` seeds keep them the same on every device:

| Weather | What the windows show                                                              |
| ------- | ---------------------------------------------------------------------------------- |
| clear   | 2 clouds (`ps-yt-cloud`)                                                           |
| wind    | 4 clouds                                                                           |
| heat    | 1 cloud                                                                            |
| rain    | `ps-yt-deck`, 34 streaks (`ps-yt-rain`), 14 drops on the panes (`ps-yt-drop`)      |
| storm   | `ps-yt-deck` darker, 60 streaks, 14 drops; no lightning (plan 2)                   |
| snow    | `ps-yt-deck` pale, 44 flakes (`ps-yt-flake`), a drift on each sill (`ps-yt-drift`) |

The streak, drop and flake colours are literals with a `ps-yt-lit` class (they are weather, not room). Clouds use `var(--ps-cloud)`.

- [ ] **Step 1: Write the failing tests:**

```ts
for (const w of WEATHERS)
  it(`shows ${w} in the windows, the same on every call`, function () {
    const s = windowWeather(w, false);
    expect(s).to.contain(`data-weather="${w}"`);
    expect(windowWeather(w, false)).to.equal(s);
    expect(s).to.not.match(/<(animate|set)\b/);
  });
it("draws each weather's own marks", function () {
  const count = (s: string, c: string) =>
    (s.match(new RegExp(`class="[^"]*\\b${c}\\b`, "g")) ?? []).length;
  expect(count(windowWeather("clear", false), "ps-yt-cloud")).to.be.at.least(2);
  expect(count(windowWeather("rain", false), "ps-yt-rain")).to.be.greaterThan(
    count(windowWeather("rain", true), "ps-yt-rain")
  );
  expect(count(windowWeather("snow", false), "ps-yt-drift")).to.equal(3);
  expect(count(windowWeather("storm", false), "ps-yt-rain")).to.be.greaterThan(
    count(windowWeather("rain", false), "ps-yt-rain")
  );
  expect(windowWeather("heat", false)).to.not.contain("ps-yt-deck");
});
it("clips only to windows the room defines", function () {
  for (const ref of windowWeather("storm", false).matchAll(/url\(#([^)]+)\)/g))
    expect(WINDOW_CLIPS as readonly string[]).to.include(ref[1]);
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement**, porting the mockup's `windowView` weather branches (streaks, drops, flakes, drift, deck) and adding wind and heat as the table says.
- [ ] **Step 4: Run until it passes.**
- [ ] **Step 5: Commit** with the message `ps: the yurt's windows show the day's weather, all six`.

### Task 6: The room in the scene

**Files:**

- Modify: `client/js/scenes/psng/scene.ts`, `client/js/scenes/ps/publish.ts` (the moon on every ellipse only), `client/themes/ps.css`
- Test: `test/scenes/psng/mount.ts`, `test/scenes/ps/scene.ts`

**Interfaces:**

- Consumes `roomMarkup` and `windowWeather` (room.ts, Tasks 4 and 5), `indoorVars` and `roomCss` (indoor.ts, Task 3), and `weatherChanged` (markup.ts).
- Produces the following behaviour, which Tasks 7 and 9 rely on:
  - The root holds `.ps-frost` (the plains) and, after the first query, one `.ps-indoor`.
  - `--ps-in-*` are written on the root on every `apply`.
  - `.ps-yt-weather[data-weather]` equals the root's `data-weather` after every `apply`.
  - Any `update()` that changes the view, while visible, runs `apply(new Date())` at once.

**Changes:**

- **`scene.ts`:**
  - Add `room: HTMLElement | null`, `roomSheet: CSSStyleSheet | null` and `roomBuilt: Weather | null`.
  - `buildRoom()` runs inside `update` the first time `state.view === "query"` (and at mount if the initial view is a query, before the first tick). It parses `roomMarkup()` into one element appended to `root`, and adopts a `CSSStyleSheet` of `roomCss()`.
  - In `apply`: write `indoorVars(m, p)` on `root.style` beside `sceneVars`. If `room` exists and `weatherChanged(roomBuilt, m.weather)`, set the weather slot's `innerHTML` to `windowWeather(m.weather, isPhoneLayout())`, its `data-weather` to `m.weather`, and `roomBuilt = m.weather`.
  - `update` remembers the last view; on a change while visible it calls `apply(new Date())`.
  - `destroy` drops `roomSheet` from `document.adoptedStyleSheets` and resets the three fields.
- **`publish.ts`:** set `rx`, `fill` and `transform` on every `.ps-m-ell` and `.ps-m-shape` (`querySelectorAll`), not just the first.
- **`ps.css`:** delete the private-view frost rule (`#theme-scene.ps-private .ps-frost { filter…; transform… }`) and its comment, and add, with logical properties:

```css
#theme-scene.ps-private > .ps-frost,
#theme-scene:not(.ps-private) > .ps-indoor {
  display: none;
}
#theme-scene .ps-indoor {
  position: absolute;
  inset: 0;
}
#theme-scene .ps-indoor > svg {
  display: block;
  inline-size: 100%;
  block-size: 100%;
}
```

Rewrite `.ps-frost`'s comment: it is the plains' one wrapper, out of the render tree in a query.

- [ ] **Step 1: Write the failing tests** in `test/scenes/psng/mount.ts`, using the file's `withPage`, `mountOn` and `state`:

```ts
it("a query builds the room once and shows it instead of the plains; back and forth leaves one room and one sheet", function () {
  withPage(new Date(2026, 5, 21, 12, 0), (page) => {
    const scene = mountOn(page);
    expect(page.root.markup).to.not.contain("ps-indoor");
    const sheets = page.doc.adoptedStyleSheets.length;
    for (let i = 0; i < 5; i++) {
      scene.update(state({view: "query"}));
      scene.update(state());
    }
    scene.update(state({view: "query"}));
    expect((page.root.markup.match(/class="ps-indoor"/g) ?? []).length).to.equal(1);
    expect(page.doc.adoptedStyleSheets.length).to.equal(sheets + 1);
    expect(page.root.classList.contains("ps-private")).to.equal(true);
    scene.destroy();
  });
});
it("mounting straight into a query builds and colours the room in the first tick", function () {
  withPage(new Date(2026, 5, 21, 23, 0), (page) => {
    const scene = mountOn(page, {view: "query"});
    expect(page.root.markup).to.contain('class="ps-indoor"');
    expect(Number(page.root.style.props.get("--ps-in-shade"))).to.be.closeTo(0.74, 0.001);
    scene.destroy();
  });
});
it("a new day's weather rebuilds the windows' weather with the plains'", function () {
  withPage(new Date(2026, 5, 21, 23, 59, 30), (page, clock) => {
    // 21 June 2026 clear, 22 June heat
    const scene = mountOn(page, {view: "query"});
    expect(page.root.markup).to.contain('data-weather="clear"');
    clock.tick(60_000);
    expect(page.root.dataset.weather).to.equal("heat");
    expect(page.root.markup).to.contain('data-weather="heat"');
    scene.destroy();
  });
});
it("a window shows no moon while the moon's opacity is 0", function () {
  withPage(new Date(2026, 5, 21, 12, 0), (page) => {
    const scene = mountOn(page, {view: "query"});
    expect(Number(page.root.style.props.get("--ps-moon-op"))).to.equal(0); // .ps-yt-moon reads it (Task 3)
    scene.destroy();
  });
});
```

Extend the existing "destroy leaves nothing" test, which already mounts in a query: the adopted sheets are `[]`, the root's markup is `""`, and no `--ps-in-*` is left on the root. In `test/scenes/ps/scene.ts`, keep the one-wrapper assertion and reword its title: the wrapper is the plains' one layer, which the room replaces in a query.

The stand-in's `FakeElement` may need `append` of a parsed child and `innerHTML` on a created element. Extend `test/scenes/standin.ts` only as far as these tests need.

- [ ] **Step 2: Run to fail.** Run `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/psng/mount.ts test/scenes/ps/scene.ts`.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run until it passes, then run `pnpm test:mocha`.** Expected: all green, including the existing query tests ("a query sets ps-private"; the query freezes with its classes).
- [ ] **Step 5: Commit** with the message `ps: the yurt in a private conversation — built on the first query, coloured by the minute, its windows in the day's weather`.

### Task 7: What a query publishes

**Files:**

- Modify: `client/js/scenes/ps/glass.ts`, `client/js/scenes/ps/grounds.ts`, `client/js/scenes/ps/publish.ts`, `client/js/scenes/psng/scene.ts` (passes the view)
- Test: `test/scenes/ps/glass.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- `isBehindIndoor(surface: GlassSurface, g: SceneGround): boolean`: the header sees `zone === "top"`; the composer sees `zone !== "top"`; side, float and card see every room ground.
- `tintsOver(grounds, behind: (s: GlassSurface, g: SceneGround) => boolean = isBehind)`.
- `indoorTints(m: Pick<Moment, "doy" | "minute" | "weather">): Record<GlassSurface, number>`: `dayTints`' step, window and cache shape (its own cache), over `indoorGrounds` with `isBehindIndoor`.
- `glassVars(m, light, view: SceneView = "channel")`: in a query by day, `indoorTints`; at night, null, as now.
- `publishedFor(p, m, view: SceneView = "channel")`: in a query `text: "light"` and `canvas: roofColourAt(m, p)`; otherwise exactly as now.
- `publishMoment(root, html, meta, m, p, view: SceneView = "channel")`. `scene.ts` passes `latest.view`.
- `SceneView` is imported as a type from `client/js/themeScene.ts`.

**Why the query words are always light:** the room always has the stove's dark iron behind the column, where dark ink cannot hold.

- [ ] **Step 1: Write the failing tests.** In `test/scenes/ps/glass.ts`:

```ts
it("solves a query's tints over the room, within the caps, cached per step", function () {
  for (const minute of [600, 750, 1080])
    for (const weather of ["clear", "rain", "snow"] as const) {
      const t = indoorTints({doy: 172, minute, weather});
      for (const s of GLASS_SURFACES) expect(t[s]).to.be.within(TINT_FLOOR, TINT_CAP);
      expect(indoorTints({doy: 172, minute: minute + 1, weather})).to.equal(t);
    }
});
it("keeps a channel's tints as they were", function () {
  const at = {doy: 172, minute: 750, weather: "clear" as const};
  const m = momentFor({...at, dayNumber: 172, epochDays: 0});
  const grounds = sceneGrounds(m, paletteAt(m));
  expect(tintsOver(grounds)).to.deep.equal(tintsOver(grounds, isBehind));
  expect(glassVars(at, "day")).to.deep.equal(glassVars(at, "day", "channel"));
});
```

In `test/scenes/psng/mount.ts`:

```ts
it("a query publishes the roof as the canvas, light words and the room's tints; a channel publishes as before, at once both ways", function () {
  withPage(new Date(2026, 5, 21, 12, 30), (page) => {
    const meta = page.plantMeta(THEME_COLOR);
    const scene = mountOn(page);
    const channel = published(page, meta);
    scene.update(state({view: "query"}));
    const m = momentAt(new Date(2026, 5, 21, 12, 30)),
      p = paletteAt(m);
    expect(page.html.style.props.get("--canvas-bg-color")).to.equal(roofColourAt(m, p));
    expect(meta.content).to.equal(roofColourAt(m, p));
    expect(page.html.dataset.psText).to.equal("light");
    expect(page.html.style.props.get("--ps-g-tint-float")).to.equal(
      indoorTints(m).float.toFixed(2)
    );
    scene.update(state());
    expect(published(page, meta)).to.deep.equal(channel);
    scene.destroy();
  });
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.** Existing callers of `tintsOver`, `publishedFor` and `publishMoment` keep their behaviour through the defaults.
- [ ] **Step 4: Run until it passes, then run `pnpm test:mocha`.** Expected: all green.
- [ ] **Step 5: Commit** with the message `ps: a private conversation publishes the room's tints and the roof as the canvas; channels as before`.

### Task 8: Every floor over the room; the room's darkest colours lightened

**Files:**

- Modify: `tools/ps/legibility.ts`, `client/js/scenes/ps/indoor.ts` (`ROOM_COLOURS` only), `docs/projects/ps-yurt.md` §9
- Test: `test/scenes/ps/legibility.ts`

**Interfaces:**

- The query variants take `view: SceneView = "channel"` as their last parameter: `groundsAt(m, p, where, view)`, `checkedGrounds(days, view)` (cache keyed by days and view), `dayGlassGrounds(days, pinned, surfaces, view)` and `shadowGrounds(words, text, days, view)`.
- In a query they use `indoorGrounds`, `isBehindIndoor` and the tints `tintsOver(grounds, isBehindIndoor)` gives, and treat the words as `light`.

- [ ] **Step 1: Write the failing tests.** Add `describe("ps: the words and the chrome keep their floors inside the yurt (docs/projects/ps-yurt.md §9): the sparse sweep, all six weathers", …)` to `test/scenes/ps/legibility.ts`, reusing that file's helpers (`glassDeclared`, `surfaceHeld`, `worst`, `worstSurface`, `underGlass`, `underSurface`, `mentionWashes`, `surfaceWashes`). Its tests:
  1. **"holds the luminous day glass over the room at the query's tints"**: like the existing day-glass test, with `dayGlassGrounds("sparse", "", CHROME_SURFACES, "query")`. Ink, the accent and every nick hold 4.5; `--ps-g-soft` holds 4.6.
  2. **"holds the join green's marks at 3 and the soft ink at 4.5 on the phone's flat day glass (0.78, unfiltered) over the room"**, using `glassGround`/`throughCard` at `TINT_CAP`.
  3. **"holds the night glass at its declared opacity over the room at night"**: as the existing night test, over `checkedGrounds("sparse", "query").glass.night`.
  4. **"holds the day surface palette over the room at the query's card tint (flat) and on the glass column at the float tint through the lift; and on a mentioned row under the washes"**, for day and night.
  5. **"pins the light words' worst figures over the room under the outline, the rim and the glow: none worse than the plains' pinned figure"**: the room's worst is at least the plains' figure for the same treatment and colour. The plains' figures are in the existing test's `PINNED` and in the shadow-family test at line ~1139.
- [ ] **Step 2: Run to see which floors fail.** Run `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/legibility.ts`. Expected: some failures over `room iron*`, `room woodD` and `room rugP` (the builder check measured 4.42, 4.33/2.99 and 4.22/2.76 at the caps).
- [ ] **Step 3: Lighten the failing colours.** For each key the failures name, raise only its OKLCH lightness, in steps of 0.01 (`colour.ts` `hexToOklch`/`oklchToHex`, keeping C and h), to the smallest value at which every test passes. Change nothing else, and never a tint or cap. Record each move as old hex → new hex, ΔL, and the figure it now holds, in a table in `ps-yurt.md` §9 and in a comment above `ROOM_COLOURS`.
- [ ] **Step 4: Confirm channels did not move.** Run `npx tsx tools/ps/palette-blocks.ts --write` (about five minutes) and then `git diff --exit-code client/themes/ps.css`. Expected: no diff. Then run `pnpm test:mocha`. Expected: all green.
- [ ] **Step 5: Commit** with the message `ps: every floor holds over the yurt — the iron, the dark wood and the rug's blue lightened only as far as they need`.

### Task 9: The browser checks

**Files:**

- Create: `tools/scenarios/ps-yurt.mjs`
- Modify: `tools/scenarios/theme-ps.mjs` (`checkFrosted`, `FROST_STATE`, the query publish check), `tools/scenarios/ps-ng.mjs` (`frozenCensus` in a query)

**Prerequisites:** the dev ircd running (`tools/nefarious-dev/run.sh`), a production build, and `python3 -m http.server -d public 8000`. Headless Chromium is at `CHROME_BIN=/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` on this machine.

**`ps-yurt.mjs` opens a query as `ps-scene-settings.mjs` does** (a peer sends a PRIVMSG; click the query's row), with the ps theme set. Its header lists the checks:

1. In the channel `.ps-indoor` is absent or `display: none`. In the query it is `display: block` and `.ps-frost` is `display: none`, and the room's `svg` rect covers `#theme-scene`'s rect.
2. For one pinned date per weather (find them with `weatherFor`; for example 21 June 2026 clear and 22 June heat), using `theme-ps.mjs`'s `Date` shim: `.ps-yt-weather`'s `data-weather` equals `#theme-scene`'s `data-weather`.
3. At 12:00 and 21:00: `--ps-in-shade` is 0 and at least 0.7, and the computed fill of a `.ps-yt-c-wallA` element differs between the two.
4. In the query, `#theme-scene.getAnimations({subtree: true}).length === 0`.
5. In the query `--canvas-bg-color` equals the roof's colour and differs from the channel's, `data-ps-text` is `light`, and the five `--ps-g-tint-*` are set by day.
6. At 1280 × 800, 390 × 844 `--mobile`, 932 × 430 `--mobile` and 2560 × 1080: the svg covers the scene, and the stove's door (`.ps-yt-p-stove`) is centred within 2 % of the scene's width.
7. Screenshots: noon, 18:00 and 21:00 in clear, rain and snow at 1280 × 800, and noon on the phone.

**Edits to the existing scenarios:**

- `theme-ps.mjs`: replace `checkFrosted` with a room check (no filter on `.ps-frost`, the root or `#status-bar-tint`; `.ps-frost` hidden; `.ps-indoor` shown). Stop `FROST_STATE` reading `.ps-sun`. Change "a query publishes exactly what `#seance` did" to check 5's values.
- `ps-ng.mjs`: in a query, `frozenCensus` no longer requires a displayed in-flight layer; it requires the plains out of the render tree, the room shown, `psng-frozen` on the root and zero animations. Back in the channel it moves again, as now.

- [ ] **Step 1:** Write `ps-yurt.mjs` and make the two edits.
- [ ] **Step 2:** Run `node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs`, then `theme-ps.mjs`, then `ps-ng.mjs` (also with `--mobile --width=390 --height=844`). Expected: every check ok. Look at the screenshots against the mockup's renders.
- [ ] **Step 3: Commit** with the message `ps: browser checks for the yurt — the room in a query, the weather inside and out, every screen`.

### Task 10: The cost of the still room

**Files:**

- Modify: `docs/projects/ps-yurt.md` §11

- [ ] **Step 1: Measure.** Use the `perf-measure` skill, in Chrome on this machine (spec §11). Measure the scene's main-thread task load (the method of `scene-rest.mjs`'s `taskLoad`) for 10 s in a query with the room, and for 10 s in a query on the commit before Task 6 (the frosted plains), each at noon and at 21:00. Measure on the phone profile at 4× as well.
- [ ] **Step 2: Record and confirm.** Write the four figures, and the room's first-build time (the `buildRoom` span in a performance trace), in §11. Expected: the room still costs no more than the frosted plains still, within noise, and no CSS animation runs. If it costs more, report the figure and the cause; do not tune silently.
- [ ] **Step 3: Commit** with the message `ps: the still yurt's cost, measured`.

### Task 11: The docs

**Files:**

- Modify: `docs/projects/ps-theme.md` §5.7, `docs/resources/ps-theme-map.md`, `docs/projects/ps-yurt.md` (status line), and the stale frost notes the research found.

- [ ] **Step 1: Update the docs:**
  - **ps-theme.md §5.7:** a first line saying it is superseded by `docs/projects/ps-yurt.md` (plan 1, the still room, built on the date). Correct its stale notes: the frost "eases over `--ps-flip`", and the classic renderer's "Still" bullet.
  - **ps-theme-map.md:** replace "in a query it stands behind frosted glass…" with a sentence on the room: `ps/yurt.ts`, `ps/room.ts`, `ps/indoor.ts`, built on the first query, the plains out of the render tree, `--ps-in-*` by the minute, the windows in the day's weather, a query's own tints and the roof as the canvas, `tools/scenarios/ps-yurt.mjs`.
  - **ps-yurt.md:** status "plan 1 (the still room) built, <date>".
- [ ] **Step 2: Verify.** Run `pnpm lint`. Expected: clean.
- [ ] **Step 3: Commit** with the message `ps: docs — the yurt replaces the frosted plains in a private conversation`.
