// How far the <3 theme's animals move (tools/heart/README.md): the foot that
// is planted slides backward by exactly what the body moves forward, so
// integrating the lowest planted foot's velocity gives a travel that never
// slips, and a sit — feet planted, not moving — never drifts. None of these
// animals ever walks backward on purpose, so a planted foot that swings
// forward relative to the body (a foot touching down mid-swing, common
// across a gait blend) reads as a negative velocity and is clamped to 0
// rather than taken as the body moving backward.

/**
 * frames: [{t, feet: [{layer, x, y}]}], the feet in the same order every
 * frame, y down, `ground` the rig's ground line. A foot within `tol` of the
 * ground is planted. Between two frames the lowest foot planted in both
 * sets the velocity (negated: the body moves the other way; clamped at 0,
 * since a planted foot swinging forward is a touch-down mid-stride, never
 * the body moving backward); with nothing planted the last velocity holds
 * through a stride's flight, and drops to 0 after `flight` seconds in the
 * air, since that is no stride.
 * Returns {x, v}: position and velocity per frame, x[0] = 0.
 */
export function stanceTravel(frames, ground, {tol = 6, flight = 0.3} = {}) {
	const n = frames.length;
	const v = new Array(n).fill(0);
	const x = new Array(n).fill(0);
	let last = 0;
	let airborne = 0;
	for (let i = 1; i < n; i++) {
		const a = frames[i - 1];
		const b = frames[i];
		const dt = b.t - a.t;
		let best = null;
		for (let k = 0; k < b.feet.length && k < a.feet.length; k++) {
			const fa = a.feet[k];
			const fb = b.feet[k];
			if (fa.y < ground - tol || fb.y < ground - tol) continue;
			if (!best || fb.y > best.y) best = {y: fb.y, dx: fb.x - fa.x};
		}
		if (best) {
			airborne = 0;
			if (dt > 0) last = Math.max(0, -best.dx / dt);
		} else {
			airborne += dt;
			if (airborne > flight) last = 0;
		}
		v[i] = last;
		x[i] = x[i - 1] + v[i] * dt;
	}
	return {x, v};
}
