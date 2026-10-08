/**
 * sRGB ↔ OKLCH (Björn Ottosson's OKLab), for solving a colour's lightness at
 * a fixed hue. The maths lives in client/js/scenes/ps/colour.ts, shared with
 * mixOklab (the scene's `color-mix(in oklab, …)` recipes, plan 3); this file
 * re-exports it so tools/ps/* have one implementation to import.
 */
export {hexToOklch, oklchToHex} from "../../client/js/scenes/ps/colour";
