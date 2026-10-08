# Spike: SVG animation inside CSS background images

Plan 2 of the <3 theme places each animal as `background-image: url(heart/<animal>.svg)`
on a pseudo-element. That only works if the engine runs the SVG's own animation in that
context. Open index.html; a box whose shape moves is a yes.

| Engine                         | SMIL attribute | CSS animation in the SVG | SMIL path morph | Notes                                                                                               |
| ------------------------------ | -------------- | ------------------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| Chromium (headless 1234, here) | yes            | yes                      | yes             | All three boxes moved between screenshots at 1000ms and 1700ms of virtual time. See fix note below. |
| Firefox                        | ?              | ?                        | ?               |                                                                                                     |
| Safari macOS                   | ?              | ?                        | ?               |                                                                                                     |
| Safari iOS                     | ?              | ?                        | ?               |                                                                                                     |

Decision rule (spec §8): SMIL where it runs; else CSS-in-SVG; else stills for that engine.

Plan 2 also relies on syncbase timing (`begin="s1.end"`), `additive="sum"` transforms, a discrete scale flip and relative-coordinate path morphs inside a background image — all verified in Chromium 151 (headless screenshots, 2026-09-11); Firefox and Safari still to be checked with a real animal file.

**Fix applied to this copy of index.html**: the `#cssin` SVG embeds its own
`<style>@keyframes …</style>` element. Written literally inside the outer page's
`<style>` block (as a `data:` URI value), the literal characters `</style>` end the
_outer_ `<style>` element the instant the HTML parser sees them — `<style>` is a raw-text
element, so the tokenizer looks only for that byte sequence and does not know it is
inside a quoted CSS string three levels down. This is standard HTML parsing behaviour in
every engine, not a Chromium quirk, so an unmodified copy of this file will show the same
corruption in Firefox and Safari: the rest of the stylesheet (the `#cssin` and `#morph`
rules) leaks into the page body as literal text, both boxes render with no background
image at all, and a stray triangle (the leaked `#morph` SVG, now a real inline element)
appears floating above the boxes — it visibly morphs there, which is a red herring: that
is inline SVG content, not a background-image, so it proves nothing about the question
this spike asks.

The fix is two characters percent-encoded in the `#cssin` data URI only: the nested
`<style>` and `</style>` tags are written as `%3Cstyle%3E` and `%3C/style%3E` (the SVG
parser percent-decodes them back to real tags, same as the existing `%23` for `#`). The
`#smil` and `#morph` rules, and the `<img>` control, are untouched. If you diff this file
against an older copy and see only that change, that's why.

**Request for the user**: Firefox and WebKit are not installed on this machine (only
Playwright's Chromium is). Please open `tools/heart/spike-svg-background/index.html` in
Firefox and Safari (desktop and iOS) and note which of the three boxes move, then fill
in the remaining rows above.
