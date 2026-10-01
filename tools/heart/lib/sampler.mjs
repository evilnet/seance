// Timing for the <3 theme's animals (tools/heart/README.md): pose tables and
// cyclic keys sampled into frames. Ported verbatim from the mockup the user
// approved; only the module shape is new.

export const E = {
	linear: (u) => u,
	inout: (u) => u * u * (3 - 2 * u),
	out: (u) => 1 - (1 - u) * (1 - u),
	in: (u) => u * u,
};

/**
 * A cyclic key list [[percent, value, easing?], …] sampled at cycle phase t
 * (in cycles; fractional) shifted by `phase`. Easing names index E and
 * default to smoothstep.
 */
export function cyc(keys, t, phase = 0) {
	const p = ((((t - phase) % 1) + 1) % 1) * 100;
	for (let i = 0; i < keys.length - 1; i++) {
		const [p0, v0, e = "inout"] = keys[i];
		const [p1, v1] = keys[i + 1];
		if (p >= p0 && p <= p1) {
			const w = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
			return v0 + (v1 - v0) * E[e](w);
		}
	}
	return keys[keys.length - 1][1];
}

/** `cycles` cycles of a gait at `fps`, appended to `out` from t0; returns the end time. */
export function sampleGait(gait, channels, cycles, fps, out, t0) {
	const n = Math.round(gait.dur * cycles * fps);
	for (let i = 0; i < n; i++) {
		const t = i / fps / gait.dur;
		const v = {};
		for (const ch of channels) {
			const k = gait.ch[ch.key];
			v[ch.name] = k ? cyc(k, t, ch.phase ?? 0) : ch.rest ?? 0;
		}
		out.push({t: t0 + i / fps, v});
	}
	return t0 + n / fps;
}

/** A blend of `blend` seconds from the last frame in `out` into `pose`, then `hold` seconds of it. */
export function samplePose(pose, channels, hold, blend, fps, out, t0) {
	const prev = out[out.length - 1]?.v ?? {};
	const nb = Math.round(blend * fps);
	const nh = Math.round(hold * fps);
	for (let i = 0; i < nb + nh; i++) {
		const w = i < nb ? E.inout(i / nb) : 1;
		const v = {};
		for (const ch of channels) {
			const to = pose[ch.name] ?? pose[ch.key] ?? ch.rest ?? 0;
			const from = prev[ch.name] ?? ch.rest ?? 0;
			v[ch.name] = from + (to - from) * w;
		}
		out.push({t: t0 + i / fps, v});
	}
	return t0 + (nb + nh) / fps;
}

/**
 * `secs` of `pose` with the channels in `wob` swinging: wob[name] =
 * [centre, amplitude, hz]. The first 0.2 s ease in from the last frame.
 */
export function sampleWobble(pose, wob, channels, secs, fps, out, t0) {
	const n = Math.round(secs * fps);
	const prev = out[out.length - 1]?.v ?? {};
	for (let i = 0; i < n; i++) {
		const tt = i / fps;
		const w = E.inout(Math.min(1, tt / 0.2));
		const v = {};
		for (const ch of channels) {
			let to = pose[ch.name] ?? ch.rest ?? 0;
			if (wob[ch.name]) {
				const [c, a, hz] = wob[ch.name];
				to = c + a * Math.sin(tt * hz * Math.PI * 2);
			}
			const from = prev[ch.name] ?? ch.rest ?? 0;
			v[ch.name] = from + (to - from) * w;
		}
		out.push({t: t0 + tt, v});
	}
	return t0 + n / fps;
}
