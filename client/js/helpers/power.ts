// Low power: the battery discharging below 20 %, or the system's battery
// saver. Vue-free and DOM-free; themeScene.ts feeds it.

export interface PowerReadings {
	battery: {charging: boolean; level: number} | null;
	saver: boolean | null;
}

export function lowPowerFrom(r: PowerReadings): boolean {
	return r.saver === true || (r.battery !== null && !r.battery.charging && r.battery.level < 0.2);
}

export function createPowerMerge(set: (low: boolean) => void): {
	update(part: Partial<PowerReadings>): void;
} {
	const readings: PowerReadings = {battery: null, saver: null};
	let last: boolean | null = null;

	return {
		update(part) {
			Object.assign(readings, part);
			const low = lowPowerFrom(readings);

			if (low !== last) {
				last = low;
				set(low);
			}
		},
	};
}

/**
 * Safari on iOS holds a page to 30 frames a second in Low Power Mode (a
 * median 33 ms against 17 off, iPhone 16, 2026-10-17) and has no other tell;
 * the shell's web view is not held, and reports it natively instead.
 */
export function framesSayLowPower(median: number): boolean {
	return median >= 28;
}
