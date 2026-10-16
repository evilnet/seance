/**
 * What the ps scene publishes each minute beyond its own custom properties
 * (docs/projects/ps-theme.md §3, §6): the moon's lit shape, the day's weather
 * and season on the scene's root, the four values the chrome reads on
 * <html>, the day glass's four tints (glass.ts; none at night), and the
 * hour's sky as the browser's `theme-color`; and taking it all down again.
 * Moved out of scene.ts so a renderer other than classic's can publish the
 * same without importing scene.ts (and with it the stepper and the gates).
 */
import type {Moment} from "./engine";
import {GLASS_TINT_VARS, glassVars} from "./glass";
import {publishedFor, themeColorFor} from "./grounds";
import {moonShape} from "./markup";
import type {Palette} from "./palette";

/** Publishes the moment; returns the theme colour it wrote into `meta`, or null with no meta. */
export function publishMoment(
	root: HTMLElement,
	html: HTMLElement,
	meta: HTMLMetaElement | null,
	m: Moment,
	p: Palette
): string | null {
	const ellipse = root.querySelector(".ps-m-ell") as SVGEllipseElement;
	const shape = root.querySelector(".ps-m-shape") as SVGGElement;
	const lit = moonShape(m.phase);
	ellipse.setAttribute("rx", lit.rx.toFixed(2));
	ellipse.setAttribute("fill", lit.fill);
	shape.setAttribute("transform", lit.mirror ? "scale(-1,1)" : "");
	root.dataset.weather = m.weather;
	root.dataset.season = m.season.main;
	const out = publishedFor(p, m);
	html.dataset.psLight = out.light;
	html.dataset.psText = out.text;
	html.style.setProperty("--ps-halo", out.halo);
	html.style.setProperty("--canvas-bg-color", out.canvas);

	// The luminous day glass's tints, one per surface (glass.ts); none at night.
	for (const [name, value] of Object.entries(glassVars(m, out.light))) {
		if (value === null) {
			html.style.removeProperty(name);
		} else {
			html.style.setProperty(name, value);
		}
	}

	if (!meta) {
		return null;
	}

	const wrote = themeColorFor(out);
	meta.content = wrote;
	return wrote;
}

/**
 * Takes down what publishMoment wrote on <html>, and hands the theme's own
 * theme-color back unless something else has written the tag since the
 * scene's last colour (`wrote`): the next theme's colour, the deploy's.
 */
export function unpublish(
	html: HTMLElement,
	meta: HTMLMetaElement | null,
	themeColor: string | null,
	wrote: string | null
): void {
	delete html.dataset.psLight;
	delete html.dataset.psText;
	html.style.removeProperty("--ps-halo");
	html.style.removeProperty("--canvas-bg-color");

	for (const name of GLASS_TINT_VARS) {
		html.style.removeProperty(name);
	}

	if (meta && themeColor !== null && meta.content === wrote) {
		meta.content = themeColor;
	}
}
