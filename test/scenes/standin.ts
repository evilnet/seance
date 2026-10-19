import {expect} from "chai";

/*
 * A ps scene's mount() under mocha, which has no DOM: a stand-in for what
 * mount and its watchers touch (the root and <html>, the message column,
 * matchMedia, ResizeObserver, frames, the window's listeners), every
 * observer, listener and frame recorded so a test can fire them and see what
 * is left behind. Timers are sinon's clock, so the scene's minute tick runs
 * on it. The globals are installed and removed inside each test body (mocha's
 * check-leaks runs at every hook's end too).
 */

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export class FakeStyle {
	props = new Map<string, string>();
	priorities = new Map<string, string>();

	setProperty(name: string, value: string, priority = "") {
		this.props.set(name, value);
		this.priorities.set(name, priority);
	}

	removeProperty(name: string) {
		this.props.delete(name);
		this.priorities.delete(name);
		return "";
	}

	getPropertyValue(name: string) {
		return this.props.get(name) ?? "";
	}

	getPropertyPriority(name: string) {
		return this.priorities.get(name) ?? "";
	}
}

export class FakeClassList {
	names = new Set<string>();

	contains(name: string) {
		return this.names.has(name);
	}

	add(...names: string[]) {
		names.forEach((n) => this.names.add(n));
	}

	remove(...names: string[]) {
		names.forEach((n) => this.names.delete(n));
	}

	toggle(name: string, force?: boolean) {
		const on = force ?? !this.names.has(name);

		if (on) {
			this.names.add(name);
		} else {
			this.names.delete(name);
		}

		return on;
	}
}

export type Listener = (event?: unknown) => void;

export class Listeners {
	all: Array<[string, Listener]> = [];

	addEventListener(type: string, fn: Listener) {
		this.all.push([type, fn]);
	}

	removeEventListener(type: string, fn: Listener) {
		this.all = this.all.filter(([t, f]) => t !== type || f !== fn);
	}
}

export class FakeElement extends Listeners {
	/** What getAnimations({subtree}) hands the stepper: none unless a test plants some. */
	animations: Array<{
		animationName?: string;
		playState: string;
		currentTime: number | null;
		pause(): void;
		play(): void;
		cancel?(): void;
		addEventListener?(type: "cancel", listener: () => void): void;
		/** What a freeze reads: the element it moves and the properties its keyframes touch. */
		effect?: {
			target: {style: FakeStyle};
			pseudoElement: string | null;
			getKeyframes(): object[];
		};
	}> = [];
	dataset: Record<string, string> = {};
	style = new FakeStyle();
	classList = new FakeClassList();
	attrs = new Map<string, string>();
	box: Box = {left: 0, top: 0, width: 0, height: 0};
	/** Its own width, as its computed style has it, where that differs from its box (a transform on the way up). */
	layoutWidth: number | null = null;
	isConnected = true;
	markup = "";
	/** What querySelector has handed out since the markup was last set, by selector. */
	found = new Map<string, FakeElement>();
	/** What querySelector hands out whatever the markup: an element a test prepared. */
	planted = new Map<string, FakeElement>();
	/** Thrown from setAttribute while set: an apply that fails. */
	failing: Error | null = null;

	constructor(public name = "") {
		super();
	}

	getAnimations() {
		return this.animations;
	}

	set innerHTML(value: string) {
		this.markup = value;
		this.found.clear();
	}

	get innerHTML() {
		return this.markup;
	}

	querySelector(selector: string): FakeElement {
		let el = this.planted.get(selector) ?? this.found.get(selector);

		if (!el) {
			el = new FakeElement(selector);
			this.found.set(selector, el);
		}

		return el;
	}

	/** What querySelectorAll finds, by selector: nothing unless a test says (no svg for syncSvgs). */
	lists = new Map<string, () => FakeElement[]>();

	querySelectorAll(selector: string): FakeElement[] {
		return this.lists.get(selector)?.() ?? [];
	}

	setAttribute(name: string, value: string) {
		if (this.failing) {
			throw this.failing;
		}

		this.attrs.set(name, String(value));
	}

	toggleAttribute(name: string, force?: boolean) {
		const on = force ?? !this.attrs.has(name);

		if (on) {
			this.attrs.set(name, "");
		} else {
			this.attrs.delete(name);
		}

		return on;
	}

	removeAttribute(name: string) {
		this.attrs.delete(name);

		if (name === "style") {
			this.style = new FakeStyle();
		}
	}

	/** Its element children: only what was put there with prepend or replaceChildren (markup is not parsed). */
	children = new Array<FakeElement>();
	parent = null as FakeElement | null;

	set className(value: string) {
		this.classList.names = new Set(value.split(/\s+/).filter(Boolean));
	}

	get className() {
		return [...this.classList.names].join(" ");
	}

	prepend(...nodes: FakeElement[]) {
		nodes.forEach((node) => node.remove());
		nodes.forEach((node) => (node.parent = this));
		this.children.unshift(...nodes);
	}

	append(...nodes: FakeElement[]) {
		nodes.forEach((node) => node.remove());
		nodes.forEach((node) => (node.parent = this));
		this.children.push(...nodes);
	}

	/** Its place in its parent's children to `node` (a no-op without a parent, as in the DOM). */
	replaceWith(node: FakeElement) {
		const parent = this.parent;

		if (parent) {
			node.remove();
			parent.children[parent.children.indexOf(this)] = node;
			node.parent = parent;
			this.parent = null;
		}
	}

	remove() {
		if (this.parent) {
			this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = null;
		}
	}

	replaceChildren(...nodes: FakeElement[]) {
		this.markup = "";
		this.found.clear();
		this.children.forEach((c) => (c.parent = null));
		this.children = [];
		nodes.forEach((node) => node.remove());
		nodes.forEach((node) => (node.parent = this));
		this.children.push(...nodes);
	}

	getBoundingClientRect() {
		const {left, top, width, height} = this.box;
		return {
			left,
			top,
			width,
			height,
			right: left + width,
			bottom: top + height,
			x: left,
			y: top,
		};
	}
}

export interface Observer {
	callback: () => void;
	targets: Set<unknown>;
	disconnected: boolean;
}

/** NG's watch on #viewport's classes (psng/scene.ts): `notify()` stands in for a class change. */
export class FakeMutationObserver {
	static all: Array<{disconnected: boolean; callback: () => void}> = [];
	disconnected = false;

	constructor(public callback: () => void) {
		FakeMutationObserver.all.push(this);
	}

	observe() {}

	disconnect() {
		this.disconnected = true;
	}

	static notify() {
		FakeMutationObserver.all.filter((o) => !o.disconnected).forEach((o) => o.callback());
	}
}

export class FakeResizeObserver implements Observer {
	static all: Observer[] = [];
	targets = new Set<unknown>();
	disconnected = false;

	constructor(public callback: () => void) {
		FakeResizeObserver.all.push(this);
	}

	observe(target: unknown) {
		this.targets.add(target);
	}

	unobserve(target: unknown) {
		this.targets.delete(target);
	}

	disconnect() {
		this.targets.clear();
		this.disconnected = true;
	}
}

export class FakeMediaQueryList extends Listeners {
	constructor(public media: string, public matches = false) {
		super();
	}

	/** The system's setting changing: `matches` becomes `on` and the change listeners hear of it. */
	set(on: boolean) {
		this.matches = on;
		this.all.filter(([type]) => type === "change").forEach(([, fn]) => fn());
	}
}

/** One of the scene's <svg>s, for syncSvgs: its SMIL clock, in no layer that is out. */
export class FakeSvg {
	classList = new FakeClassList();
	paused = false;
	/** Its clock, in seconds: the stepper advances it while the scene runs. */
	time = 0;

	getCurrentTime() {
		return this.time;
	}

	setCurrentTime(seconds: number) {
		this.time = seconds;
	}

	closest() {
		return null;
	}

	animationsPaused() {
		return this.paused;
	}

	pauseAnimations() {
		this.paused = true;
	}

	unpauseAnimations() {
		this.paused = false;
	}
}

/** The theme-color meta, as `instanceof HTMLMetaElement` (the stand-in's) sees it. */
export class FakeMeta {
	content = "";
}

/** A constructed stylesheet: what replaceSync was given. */
export class FakeSheet {
	text = "";

	replaceSync(text: string) {
		this.text = text;
	}
}

/**
 * The system's reduced-motion setting, for systemAccessibility(): it follows
 * the first window it sees for good, so every page's matchMedia answers from
 * here (routeReducedMotion) and setReducedMotion fires the change.
 */
const reducedMotion = {on: false, listeners: [] as Listener[]};

export function routeReducedMotion(page: {globals: Record<string, unknown>}) {
	(page.globals.window as {matchMedia: unknown}).matchMedia = (query: string) => ({
		matches: query.includes("reduced-motion") && reducedMotion.on,
		addEventListener: (_type: string, fn: Listener) => reducedMotion.listeners.push(fn),
	});
}

export function setReducedMotion(on: boolean) {
	reducedMotion.on = on;
	reducedMotion.listeners.forEach((fn) => fn());
}

/** The page mount() runs in, and the handles a test needs on it. */
export function fakePage() {
	const root = new FakeElement("#theme-scene");
	const html = new FakeElement("html");
	const column = new FakeElement("#chat .chat");
	column.box = {left: 250, top: 0, width: 850, height: 800};
	const win = new Listeners();
	const media: FakeMediaQueryList[] = [];
	let frames = new Map<number, () => void>();
	let nextFrame = 1;
	let columnShown = true;
	/** Thrown from the column's lookup while set: a failing measurement. */
	let columnFails: Error | null = null;
	/** The theme-color meta: none unless a test plants it (plantMeta). */
	let meta: FakeMeta | null = null;
	const doc = {
		documentElement: html,
		adoptedStyleSheets: [] as FakeSheet[],
		querySelector(selector: string) {
			if (selector === 'meta[name="theme-color"]') {
				return meta;
			}

			if (selector !== "#chat .chat") {
				return null;
			}

			if (columnFails) {
				throw columnFails;
			}

			return columnShown ? column : null;
		},
		getElementById: () => null,
		createElement: (tag: string) => new FakeElement(tag),
	};
	/** Each style computation asked for: the element, and its classes at that moment. */
	const computed: Array<{el: FakeElement; classes: string}> = [];
	FakeResizeObserver.all = [];
	FakeMutationObserver.all = [];

	const globals: Record<string, unknown> = {
		window: Object.assign(win, {
			matchMedia(query: string) {
				const list = new FakeMediaQueryList(query);
				media.push(list);
				return list;
			},
			setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
			clearTimeout: (id: number) => globalThis.clearTimeout(id),
			requestAnimationFrame(fn: () => void) {
				frames.set(nextFrame, fn);
				return nextFrame++;
			},
			cancelAnimationFrame(id: number) {
				frames.delete(id);
			},
		}),
		document: doc,
		ResizeObserver: FakeResizeObserver,
		MutationObserver: FakeMutationObserver,
		HTMLMetaElement: FakeMeta,
		CSSStyleSheet: FakeSheet,
		getComputedStyle(el: FakeElement) {
			computed.push({el, classes: el.className});
			return {
				opacity: "1",
				fontSize: "20px",
				width: `${el.layoutWidth ?? el.box.width}px`,
			};
		},
	};

	return {
		root,
		html,
		column,
		win,
		media,
		globals,
		computed,
		doc,
		/** A theme-color meta holding `content`, for the scene to write and hand back. */
		plantMeta(content: string) {
			meta = new FakeMeta();
			meta.content = content;
			return meta;
		},
		/** The scene laid out (ps.css applied): the root's box and the yurt's. */
		layOut(width: number) {
			root.box = {left: 0, top: 0, width, height: 900};
			root.querySelector(".ps-yurt").box = {left: 0, top: 0, width: 267, height: 189};
		},
		hideColumn() {
			columnShown = false;
			column.isConnected = false;
		},
		failColumnLookup(error: Error | null) {
			columnFails = error;
		},
		/** What the browser does when `target` changes size: each observer watching it is called once. */
		resize(target: unknown) {
			for (const ro of FakeResizeObserver.all) {
				if (ro.targets.has(target)) {
					ro.callback();
				}
			}
		},
		/** Run the frame callbacks queued so far. */
		frame() {
			const due = frames;
			frames = new Map();
			due.forEach((fn) => fn());
		},
		pendingFrames: () => frames.size,
		observers: () => FakeResizeObserver.all,
		/** The prefers-reduced-motion list the scene asked for. */
		reducedMotion: () => media.find((m) => m.media === "(prefers-reduced-motion: reduce)")!,
		/** An <svg> in the scene, for syncSvgs to pause and run. */
		plantSvg() {
			const svg = new FakeSvg();
			root.lists.set("svg", () => [svg as unknown as FakeElement]);
			return svg;
		},
	};
}

export type Page = ReturnType<typeof fakePage>;

/**
 * A stand-in page with its globals installed (each must not be a global
 * already); `restore()` removes them. Call it inside a test body, never at a
 * hook's or the file's top level: mocha's check-leaks runs at every hook's end.
 */
export function installPage(): Page & {restore(): void} {
	const page = fakePage();
	const g = globalThis as Record<string, unknown>;
	const names = Object.keys(page.globals);

	for (const name of names) {
		expect(name in g, `${name} is not a global already`).to.equal(false);
		g[name] = page.globals[name];
	}

	return {
		...page,
		restore() {
			for (const name of names) {
				delete g[name];
			}
		},
	};
}
