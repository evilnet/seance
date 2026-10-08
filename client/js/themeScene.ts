/**
 * The theme-scene hook (docs/projects/ps-theme.md §3): the one place the app
 * lets a theme bring page elements of its own. A theme listed in SCENES has its
 * scene module mounted into #theme-scene (client/index.html) when it is applied,
 * and destroyed when another theme is; every other theme loads nothing. The
 * hook tells a scene only what any theme could want: whether the page is
 * visible, whether anyone is attending to it (createAttention), and what kind
 * of conversation is open. It never reads a colour or a
 * time. It touches the document only inside functions, so mocha loads it.
 */

export type SceneView = "channel" | "query" | "other";

/**
 * How much a scene moves (the ps theme's Scene animation setting): not at
 * all, once every five minutes and on coming back, once a second, 24 frames a
 * second, or the browser's own rate.
 */
export type SceneMotion = "off" | "sparse" | "1s" | "24" | "60";

export const SCENE_MOTIONS: readonly SceneMotion[] = ["off", "sparse", "1s", "24", "60"];

/** A stored value the list does not hold is the default. */
export function normalizeSceneMotion(value: unknown): SceneMotion {
	return SCENE_MOTIONS.includes(value as SceneMotion) ? (value as SceneMotion) : "24";
}

export interface SceneHostState {
	visible: boolean;
	/**
	 * Someone is attending to the page: it has the focus or was used lately
	 * (createAttention). A visible page nobody attends to is a desktop window
	 * left behind others or on a second screen, which no `visibilitychange`
	 * reports; a scene keeps it still.
	 */
	attended: boolean;
	view: SceneView;
	motion: SceneMotion;
}

export interface SceneHandle {
	update(state: SceneHostState): void;
	destroy(): void;
}

export interface SceneModule {
	mount(root: HTMLElement, state: SceneHostState): SceneHandle;
}

export type SceneLoader = () => Promise<SceneModule>;

/** The themes that have a scene, by theme name: each is its own chunk, loaded only for that theme. */
export const SCENES: Readonly<Record<string, SceneLoader>> = {
	ps: () => import(/* webpackChunkName: "scene-ps" */ "./scenes/ps/scene"),
};

export interface SceneHost {
	setTheme(name: string): Promise<void>;
	setVisible(visible: boolean): void;
	setAttended(attended: boolean): void;
	/** Whether a page nobody attends to rests its scene (default yes); no, and it counts as attended. */
	setPauseWhenAway(pause: boolean): void;
	setMotion(motion: SceneMotion): void;
	setView(view: SceneView): void;
	/**
	 * Re-attempts the load of the currently-asked theme's scene, if its last
	 * load failed and nothing has replaced it since. A no-op otherwise (nothing
	 * failed, or a later `setTheme` moved on). Callers that do not need to wait
	 * for it just call it and let the promise settle on its own.
	 */
	retry(): Promise<void>;
	readonly mounted: string | null;
}

export function createSceneHost(opts: {
	root: () => HTMLElement | null;
	loaders: Readonly<Record<string, SceneLoader>>;
	state: SceneHostState;
	warn?: (message: string, error: unknown) => void;
}): SceneHost {
	const state: SceneHostState = {...opts.state};
	// What attention says, and whether the scene listens to it: state.attended
	// is the one the scene is given.
	let attention = state.attended;
	let pauseWhenAway = true;
	let asked: string | null = null;
	let mounted: string | null = null;
	let handle: SceneHandle | null = null;
	let ticket = 0;
	// The asked-for theme whose scene last failed to load, while nothing since
	// has superseded that attempt. Cleared by any `setTheme` (win or lose) and
	// by a successful mount; `retry()` reads it and nothing else sets it.
	let failed: string | null = null;

	const unmount = () => {
		handle?.destroy();
		handle = null;
		mounted = null;
	};

	// Shared by setTheme and retry(): load `name`'s module and mount it, unless
	// `mine` has been superseded by a later ticket by the time either the import
	// or the mount would land.
	const attempt = async (name: string, mine: number): Promise<void> => {
		// Object.hasOwn: a stored theme name of "toString" or the like must not
		// resolve to an inherited Object.prototype member.
		const load = Object.hasOwn(opts.loaders, name) ? opts.loaders[name] : undefined;

		if (!load) {
			return;
		}

		let mod: SceneModule;

		try {
			mod = await load();
		} catch (error) {
			if (mine === ticket) {
				// A retry that fails again is still the same failure: warn once for
				// it, not once per retry.
				if (failed !== name) {
					failed = name;
					opts.warn?.(
						`The ${name} theme's scene did not load; its daylight fallback stays.`,
						error
					);
				}
			}

			return;
		}

		// Another theme was applied (or a retry re-raced this one) while this
		// one loaded: it wins.
		const root = opts.root();

		if (mine !== ticket || !root) {
			return;
		}

		failed = null;

		// A scene's mount can throw synchronously (bad markup, a bad measurement);
		// caught here so it never becomes an unhandled rejection through the
		// `void` call in settings.ts, and never leaves a half-built scene.
		try {
			handle = mod.mount(root, {...state});
			mounted = name;
		} catch (error) {
			opts.warn?.(
				`The ${name} theme's scene failed to mount; its daylight fallback stays.`,
				error
			);
			root.replaceChildren();
		}
	};

	const setAttended = (attended: boolean): void => {
		attention = attended;
		const given = attention || !pauseWhenAway;

		if (state.attended !== given) {
			state.attended = given;
			handle?.update({...state});
		}
	};

	const retry = (): Promise<void> => {
		if (!failed) {
			return Promise.resolve();
		}

		const name = failed;
		const mine = ++ticket;

		return attempt(name, mine);
	};

	return {
		get mounted() {
			return mounted;
		},

		async setTheme(name: string): Promise<void> {
			if (name === asked) {
				return;
			}

			asked = name;
			failed = null;
			const mine = ++ticket;
			unmount();
			await attempt(name, mine);
		},

		setVisible(visible: boolean): void {
			if (state.visible !== visible) {
				state.visible = visible;
				handle?.update({...state});
			}

			if (visible) {
				void retry();
			}
		},

		setAttended,

		setPauseWhenAway(pause: boolean): void {
			pauseWhenAway = pause;
			setAttended(attention);
		},

		setMotion(motion: SceneMotion): void {
			if (state.motion !== motion) {
				state.motion = motion;
				handle?.update({...state});
			}
		},

		setView(view: SceneView): void {
			if (state.view === view) {
				return;
			}

			state.view = view;
			handle?.update({...state});
		},

		retry,
	};
}

/** The app's host. */
export const themeScene: SceneHost = createSceneHost({
	root: () => document.getElementById("theme-scene"),
	loaders: SCENES,
	state: {visible: true, attended: true, view: "other", motion: "24"},
	warn: (message, error) => console.warn(message, error), // eslint-disable-line no-console
});

/** A window without the focus rests its scene after this long (a visible window behind others, on another screen). */
export const UNFOCUSED_REST_MS = 15_000;

/** A focused window with no input (pointer, key, wheel, touch) rests its scene after this long. */
export const IDLE_REST_MS = 120_000;

export interface Attention {
	/** The window took the focus: attended at once. */
	focus(): void;
	/** The window lost the focus: unattended after UNFOCUSED_REST_MS without input. */
	blur(): void;
	/** Any input: attended at once, and the rest is counted from now. */
	input(): void;
	stop(): void;
}

/**
 * Whether anyone is attending to a visible page, for the scene's sake (not the
 * IRC presence's, whose own timing is about `AWAY *` flapping). Attended while
 * the last input — or the focus changing — is newer than the rest delay: two
 * minutes with the focus, fifteen seconds without. Input over a window without
 * the focus counts too: a pointer over it is someone looking at it. One timer,
 * re-armed by its own expiry rather than by every pointer move. `now` must be
 * monotonic (performance.now), not the wall clock a scene may be shown.
 */
export function createAttention(opts: {
	focused: boolean;
	set(attended: boolean): void;
	now(): number;
	after(ms: number, fn: () => void): () => void;
}): Attention {
	let focused = opts.focused;
	let last = opts.now();
	let attended = true;
	let cancel: (() => void) | undefined;

	const delay = () => (focused ? IDLE_REST_MS : UNFOCUSED_REST_MS);

	// The one timer, at the moment the rest is due; it re-arms itself while
	// input has moved that moment on.
	const arm = (): void => {
		cancel?.();
		cancel = opts.after(Math.max(0, last + delay() - opts.now()), () => {
			cancel = undefined;

			if (last + delay() > opts.now()) {
				arm();
			} else if (attended) {
				attended = false;
				opts.set(false);
			}
		});
	};

	const touch = () => {
		last = opts.now();

		if (!attended) {
			attended = true;
			opts.set(true);
		}
	};

	arm();

	return {
		focus() {
			focused = true;
			touch();
			arm();
		},
		blur() {
			focused = false;
			last = opts.now();
			arm(); // the shorter delay, counted from the blur
		},
		input() {
			touch();

			if (!cancel) {
				arm();
			}
		},
		stop() {
			cancel?.();
			cancel = undefined;
		},
	};
}

/**
 * Follow the page's visibility and connectivity: a hidden page's scene stops
 * and catches up on return (also on a bfcache restore, which fires no
 * `visibilitychange`), and a scene that failed to load — offline, a failed
 * chunk — is retried once the network is back, so it does not wait for a
 * reload. A visible page nobody attends to (createAttention) rests its scene
 * too: a desktop window behind others or on another screen stays visible to
 * the browser and would animate, and repaint the glass over it, all day.
 */
export function installThemeSceneHooks(): void {
	const attention = createAttention({
		focused: document.hasFocus(),
		set: (attended) => themeScene.setAttended(attended),
		now: () => performance.now(),
		after(ms, fn) {
			const id = window.setTimeout(fn, ms);
			return () => window.clearTimeout(id);
		},
	});
	const onInput = () => attention.input();
	window.addEventListener("focus", () => attention.focus());
	window.addEventListener("blur", () => attention.blur());

	for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
		window.addEventListener(type, onInput, {capture: true, passive: true});
	}

	const sync = () => {
		const visible = document.visibilityState !== "hidden";

		// Back on its tab: someone is looking. A tab switch inside a window
		// fires no focus, so without this a scene that rested while hidden
		// would stay still until the pointer moved.
		if (visible) {
			attention.input();
		}

		themeScene.setVisible(visible);
	};

	document.addEventListener("visibilitychange", sync);
	window.addEventListener("online", () => void themeScene.retry());
	window.addEventListener("pageshow", (event: PageTransitionEvent) => {
		if (event.persisted) {
			attention.input();
			themeScene.setVisible(true);
		}
	});
	sync();
}
