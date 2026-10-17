/**
 * NG's rain (ps NG plan 2, Task 4): classic's drops (plains.ts `rain`, the
 * same rng 1301 stream in the same order) on three sheets by speed,
 * perf-band's. A sheet is two tiles of exactly the scene's size, each its own
 * animated element falling one tile height (styles.ts `psng-rain-fall`), the
 * twin one tile up, so the loop is seamless and nothing that moves is larger
 * than the viewport (spec §3 rule 2). Sizes are percentages of the scene, so
 * a resize can never outgrow the viewport or open a gap; `viewport` is the box
 * they must fit, which only the tests read. A tile moves only in Y; classic's
 * slant is in each drop's drawing (styles.ts skews it). DOM-free.
 */
import {rng} from "../ps/engine";

/**
 * Each sheet's loop: perf-band's periods (0.61, 0.73, 0.84 s for a 118cqh fall) scaled to one tile
 * height (×100/118), so a one-viewport tile falls at classic's speed.
 */
export const RAIN_TILE_SECONDS = [0.52, 0.62, 0.71];

export function rainTiles(count: number, viewport: {width: number; height: number}): string {
	const r = rng(1301);
	const sheets = RAIN_TILE_SECONDS.map(() => "");

	for (let i = 0; i < count; i++) {
		// Classic's four draws, in its order: place, duration, delay, opacity.
		const left = (r() * 110).toFixed(1);
		const d = 0.55 + r() * 0.35;
		const phase = ((r() * 1.2) / d) % 1;
		const opacity = (0.4 + r() * 0.6).toFixed(2);
		const sheet = Math.min(2, Math.floor(((d - 0.55) / 0.35) * 3));
		// Where its own clock had it at time 0, kept whole inside the tile so no tail crosses the seam.
		const top = `calc(${(phase * 100).toFixed(1)}% - ${(phase * 1.25).toFixed(3)}rem)`;
		sheets[sheet] += `<i style="left:${left}%;top:${top};opacity:${opacity}"></i>`;
	}

	const tile = (top: string, drops: string) =>
		`<div class="psng-rain-tile" style="top:${top};left:0;width:100%;height:100%">${drops}</div>`;
	const out = sheets.map(
		(drops, i) =>
			`<div class="psng-rain-sheet" style="--rd:${RAIN_TILE_SECONDS[i]}s">` +
			tile("0", drops) +
			tile("-100%", drops) +
			`</div>`
	);
	return `<div class="ps-rain">${out.join("")}</div>`;
}
