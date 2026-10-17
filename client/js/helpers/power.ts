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
