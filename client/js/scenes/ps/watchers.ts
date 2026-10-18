/**
 * What the ps scene watches on the page around it (docs/projects/ps-theme.md
 * §5.5): the composer standing above the near grass, the land's stretch, and
 * the day's own clouds in the overcast. The yurt's place is CSS alone (ps.css).
 */
import {composerAboveGrass} from "./glass";
import type {Weather} from "./engine";
import {weatherClouds} from "./plains";

/**
 * The land is drawn on a 1200 × 400 box stretched to the window
 * (preserveAspectRatio="none"): the hills take the stretch, and the round
 * things on them are widened back by how much narrower than tall it made them.
 * Writes `--ps-land-unsquash` (the vertical scale over the horizontal) on the
 * scene's root whenever the land's box changes, and the two factors that undo
 * it with each shape's area kept (`--ps-land-round-x`, `-y`, its square root
 * each way: kept at full height on a phone they crowded the plain); ps.css
 * scales the shrubs, stones and groves by them.
 */
export function watchLand(root: HTMLElement): {destroy(): void} {
	const land = root.querySelector(".ps-land");

	if (!land) {
		return {destroy() {}};
	}

	const observer = new ResizeObserver(() => {
		const box = land.getBoundingClientRect();

		if (box.width > 0 && box.height > 0) {
			// The stretch makes them `squash` times taller than wide; undone
			// with their area kept, half the correction on each axis.
			const squash = box.height / 400 / (box.width / 1200);
			const k = Math.sqrt(squash);
			root.style.setProperty("--ps-land-unsquash", squash.toFixed(3));
			root.style.setProperty("--ps-land-round-x", k.toFixed(3));
			root.style.setProperty("--ps-land-round-y", (1 / k).toFixed(3));
		}
	});

	observer.observe(land);
	return {destroy: () => observer.disconnect()};
}

/**
 * Marks <html> `ps-form-tall` while the composer's top edge stands above the
 * near grass (glass.ts composerAboveGrass), so ps.css gives it the float tint
 * (the controller's ruling, task 7b fix round 1). One ResizeObserver
 * watches #form (a reply bar, a longer draft, a font step), #viewport (a
 * touch keyboard: #viewport follows --viewport-height while the scene stays
 * on the layout viewport) and the scene itself: the theme switch mounts the
 * scene before ps.css applies (settings.ts calls setTheme before it swaps the
 * link), while #theme-scene is still display: none and measures 0 × 0, and
 * its display then fires an observation. A new #form also rises into place
 * (ps.css ps-rise: 8 px, a transform no observer sees), so the end of its
 * own animation checks again. Each check reads both boxes afresh, as
 * the window's resize checks too. #form is looked
 * for again on every host update and whenever the one observed leaves the
 * page; with none on the page (the connect form) there is no class.
 */
export function watchComposer(
	root: HTMLElement,
	html: HTMLElement
): {refind(): void; destroy(): void} {
	let form: Element | null = null;
	let viewport: Element | null = null;
	let frame: number | undefined;

	const check = () => {
		html.classList.toggle(
			"ps-form-tall",
			!!form?.isConnected &&
				composerAboveGrass(form.getBoundingClientRect(), root.getBoundingClientRect())
		);
	};

	const observer = new ResizeObserver(() => {
		if (form?.isConnected) {
			check();
		} else {
			findSoon(); // it left the page; its replacement, if any, is there by the next frame
		}
	});

	observer.observe(root);
	const onResize = () => check();

	// Its own entrance only: animations inside it bubble here too.
	const onSettled = (event: Event) => {
		if (event.target === form) {
			check();
		}
	};

	const listen = (el: Element, on: boolean) => {
		for (const type of ["animationend", "animationcancel"]) {
			if (on) {
				el.addEventListener(type, onSettled);
			} else {
				el.removeEventListener(type, onSettled);
			}
		}
	};

	function find() {
		const nextForm = document.getElementById("form");
		const nextViewport = document.getElementById("viewport");

		if (nextForm !== form) {
			if (form) {
				observer.unobserve(form);
				listen(form, false);
			}

			form = nextForm;

			if (form) {
				observer.observe(form); // its first observation checks it
				listen(form, true);
			} else {
				html.classList.remove("ps-form-tall");
			}
		}

		if (nextViewport !== viewport) {
			if (viewport) {
				observer.unobserve(viewport);
			}

			viewport = nextViewport;

			if (viewport) {
				observer.observe(viewport);
			}
		}
	}

	// Also on the next frame: the host's update comes before Vue has patched the page.
	function findSoon() {
		if (frame === undefined) {
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				find();
			});
		}
	}

	window.addEventListener("resize", onResize);

	return {
		refind() {
			find();
			findSoon();
		},
		destroy() {
			observer.disconnect();
			window.removeEventListener("resize", onResize);

			if (form) {
				listen(form, false);
			}

			if (frame !== undefined) {
				window.cancelAnimationFrame(frame);
				frame = undefined;
			}

			html.classList.remove("ps-form-tall");
		},
	};
}

/**
 * The day's own clouds (plains.ts `weatherClouds`) are one set in the
 * overcast, `.ps-overcast-set`; a new day's replaces the old at once.
 */
export function overcastBuilder(overcast: HTMLElement): {build(weather: Weather): void} {
	const build = (weather: Weather) => {
		const markup = weatherClouds(weather);
		const set = markup ? document.createElement("div") : null;

		if (set) {
			set.className = "ps-overcast-set";
			set.innerHTML = markup;
		}

		overcast.replaceChildren(...(set ? [set] : []));
	};

	return {build};
}
